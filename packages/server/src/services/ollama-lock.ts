// ════════════════════════════════════════
// Ollama Concurrency Manager (per-provider)
// ════════════════════════════════════════
//
// Prevents RAM thrashing on memory-constrained Ollama hosts by limiting
// how many distinct models can be loaded simultaneously on EACH provider.
// Multiple agents using the SAME model can run concurrently; agents
// needing a DIFFERENT model on the same provider queue until the current
// one drains.
//
// Per-provider scoping is important once the user adds more than one
// Ollama provider (e.g. a 16 GB Mac Mini running the dojo itself, plus
// a 128 GB Mac Studio reached over the LAN). Each machine has its own
// RAM and its own KV-cache budget, so the 1-concurrent-model rule
// applies independently to each host. A model swap on the Mac Mini has
// no effect on the Mac Studio and vice-versa.
//
// The current implementation uses the same `ollama_max_concurrent_models`
// setting for every provider — if you later want distinct limits per
// machine that'd be a follow-up (add a column on `providers`).

import { createLogger } from '../logger.js';
import { broadcast } from '../gateway/ws.js';
import { getDb } from '../db/connection.js';

const logger = createLogger('ollama-lock');

const QUEUE_TIMEOUT_MS = 60000; // 60 seconds

interface QueuedRequest {
  providerId: string;
  modelName: string;
  resolve: () => void;
  reject: (err: Error) => void;
  queuedAt: number;
  timer: ReturnType<typeof setTimeout>;
}

interface ModelSlot {
  providerId: string;
  modelName: string;
  activeRequests: number;
  // T81c (NO-DOOMED-DIALS, census row 8) — GPU livelock incident, Leg B: requests for THIS
  // SAME model, queued behind the one already running. Before this, a second request just did
  // `activeRequests++` and dialed immediately alongside the first — the exact "N concurrent
  // 110K-token prefills stack on the same GPU" the census names. At most one waiter is ever
  // let through at a time (see `release`), so this can hold more than one entry when several
  // callers pile up behind a single slow prefill.
  waiters: QueuedRequest[];
}

/**
 * How long a request may wait BEHIND a same-model call already running before giving up.
 *
 * `declaredFirstChunkMs` is the QUEUING CALLER's own resolved first-chunk patience for the
 * model it is asking for — `agent/model.ts` already computes this via `resolveStreamPatience`
 * immediately before calling `acquire`, so passing it here costs nothing new, no second DB
 * read, no parallel derivation. It is NOT read off the request currently occupying the slot
 * (this lock tracks nothing about that call beyond a bare count, see `ModelSlot.activeRequests`)
 * — but since both callers are asking for the SAME model on the SAME provider, they resolve the
 * identical declared bound, so the number is correct in practice by construction, not by
 * inspecting the other request. Without it, the flat cross-model `QUEUE_TIMEOUT_MS` (60s) would
 * starve a request queued behind a legitimately long prefill: a provider declaring 600s of
 * patience is entitled to take up to 600s before its FIRST token, and a queued sibling call
 * must not be told to give up at 60s while that entirely healthy call is still inside its own
 * declared bound.
 *
 * THIS IS A FLOOR, NOT A GUARANTEE, documented rather than hidden: `declaredFirstChunkMs` bounds
 * the OCCUPYING call's PREFILL (time to first token) only. Once it starts streaming, that call
 * can legitimately hold the slot far longer (its OWN idle bound re-arms per chunk with no
 * overall completion cap) — the same open edge the model layer's own watchdog leaves. A queued
 * waiter can still time out behind a slow-but-healthy completion; when it does, the error names
 * the real cause so nobody mistakes it for a hung slot.
 *
 * Minor 2, named rather than fixed (no mechanism change): under SUSTAINED same-model pressure —
 * a steady stream of same-model requests each queuing behind the last — a DIFFERENT model
 * queued for a cross-model swap on this provider can starve indefinitely, because the slot
 * never goes idle long enough for `processQueueForProvider` to run. That is a real tradeoff of
 * "same-model requests always win the slot back first," not an oversight; the incident this
 * task closes is same-model stacking, and cross-model fairness under sustained same-model load
 * is a follow-up if it is ever observed in practice.
 */
function sameModelQueueTimeoutMs(declaredFirstChunkMs?: number): number {
  if (typeof declaredFirstChunkMs === 'number' && Number.isFinite(declaredFirstChunkMs) && declaredFirstChunkMs > 0) {
    return Math.max(QUEUE_TIMEOUT_MS, declaredFirstChunkMs);
  }
  return QUEUE_TIMEOUT_MS;
}

class OllamaModelLock {
  // Every slot is tagged with the providerId it belongs to. All search
  // and accounting operations filter by providerId before anything else.
  private slots: ModelSlot[] = [];
  private queue: QueuedRequest[] = [];
  private maxConcurrentModels: number = 1;

  constructor() {
    this.loadConfig();
  }

  private loadConfig(): void {
    try {
      const db = getDb();
      const row = db.prepare("SELECT value FROM config WHERE key = 'ollama_max_concurrent_models'").get() as { value: string } | undefined;
      if (row) {
        const val = parseInt(row.value, 10);
        if (val > 0) this.maxConcurrentModels = val;
      }
    } catch {
      // Config not loaded yet at startup — use default
    }
  }

  /** Reload config (called when settings change) */
  reloadConfig(): void {
    this.loadConfig();
    logger.info('Ollama lock config reloaded', { maxConcurrentModels: this.maxConcurrentModels });
  }

  private slotsForProvider(providerId: string): ModelSlot[] {
    return this.slots.filter(s => s.providerId === providerId);
  }

  /**
   * Acquire a slot for the given provider+model. Resolves when the caller may proceed.
   *
   * `declaredFirstChunkMs`, T81c: the CALLER's own declared first-chunk patience for THIS
   * request (`agent/model.ts` already has `resolveStreamPatience(modelInfo).firstChunkMs` in
   * hand right before calling this) — used only to bound how long a request queued BEHIND a
   * same-model call may wait; see `sameModelQueueTimeoutMs`'s own doc.
   */
  async acquire(providerId: string, modelName: string, declaredFirstChunkMs?: number): Promise<void> {
    // Re-read config on each acquire (single DB read, ~0.1ms)
    this.loadConfig();

    // Is this model already loaded on this provider?
    const existingSlot = this.slots.find(s => s.providerId === providerId && s.modelName === modelName);
    if (existingSlot) {
      if (existingSlot.activeRequests === 0) {
        // Slot exists (from an earlier call) but nothing is running on it right now — take it.
        existingSlot.activeRequests = 1;
        logger.debug('Ollama lock acquired (existing idle slot)', { providerId, modelName });
        this.broadcastStatus();
        return;
      }

      // T81c (NO-DOOMED-DIALS, census row 8): a call for this SAME model is already running.
      // This used to be `activeRequests++` and dial immediately, sharing the slot unbounded —
      // the exact mechanism that let a fast cold-redial loop (Leg B) stack a fresh 110K-token
      // prefill on the GPU on top of one already in flight. Cap it: this caller queues, and at
      // most one waiter is ever let through per release (see `release`).
      logger.info('Ollama request queuing behind a same-model call already in flight', {
        providerId, modelName, activeRequests: existingSlot.activeRequests,
      });
      return new Promise<void>((resolve, reject) => {
        const timeoutMs = sameModelQueueTimeoutMs(declaredFirstChunkMs);
        const timer = setTimeout(() => {
          const idx = existingSlot.waiters.findIndex(w => w.resolve === resolve);
          if (idx !== -1) existingSlot.waiters.splice(idx, 1);
          this.broadcastStatus();
          reject(new Error(
            `Ollama request timed out after ${Math.round(timeoutMs / 1000)}s waiting behind a long ` +
            `prefill on the same model (${modelName}) on provider ${providerId} — the earlier ` +
            `request has not finished yet. Try again once it completes, or raise this provider's ` +
            `declared patience if this keeps happening.`
          ));
        }, timeoutMs);
        existingSlot.waiters.push({ providerId, modelName, resolve, reject, queuedAt: Date.now(), timer });
        this.broadcastStatus();
      });
    }

    // Room for a new model slot on this provider?
    const providerSlots = this.slotsForProvider(providerId);
    if (providerSlots.length < this.maxConcurrentModels) {
      this.slots.push({ providerId, modelName, activeRequests: 1, waiters: [] });
      logger.info('Ollama lock acquired (new slot)', {
        providerId, modelName,
        slotsUsedOnProvider: providerSlots.length + 1,
        maxSlots: this.maxConcurrentModels,
      });
      this.broadcastStatus();
      return;
    }

    // Any idle slot on this provider we can swap into?
    const idleSlot = providerSlots.find(s => s.activeRequests === 0);
    if (idleSlot) {
      logger.info('Ollama model swap', { providerId, from: idleSlot.modelName, to: modelName });
      idleSlot.modelName = modelName;
      idleSlot.activeRequests = 1;
      idleSlot.waiters = []; // defensive: an idle slot (0 active) can never carry same-model waiters, see `release`
      this.broadcastStatus();
      return;
    }

    // All this provider's slots are busy with different models — queue.
    const queueLength = this.queue.filter(q => q.providerId === providerId && q.modelName === modelName).length + 1;
    const currentModels = providerSlots.map(s => s.modelName).join(', ');
    logger.info(`Waiting for Ollama model swap on provider ${providerId}: [${currentModels}] → ${modelName} (${queueLength} requests queued)`, {
      providerId,
      modelName,
      currentModels: providerSlots.map(s => s.modelName),
      queueLength,
    });

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.queue.findIndex(q => q.resolve === resolve);
        if (idx !== -1) this.queue.splice(idx, 1);
        this.broadcastStatus();
        reject(new Error(
          `Ollama model swap timed out on provider ${providerId} — other model(s) (${currentModels}) still in use. ` +
          `Try again or switch this agent to the same model.`
        ));
      }, QUEUE_TIMEOUT_MS);

      this.queue.push({ providerId, modelName, resolve, reject, queuedAt: Date.now(), timer });
      this.broadcastStatus();
    });
  }

  /** Release a slot after an Ollama call completes (success or error). */
  release(providerId: string, modelName: string): void {
    const slot = this.slots.find(s => s.providerId === providerId && s.modelName === modelName);
    if (!slot) {
      logger.warn('Ollama lock release: no slot found', { providerId, modelName });
      return;
    }

    slot.activeRequests = Math.max(0, slot.activeRequests - 1);
    logger.debug('Ollama lock released', { providerId, modelName, activeRequests: slot.activeRequests });

    if (slot.activeRequests === 0) {
      // T81c: a caller QUEUED behind this same model (see `acquire`) gets the slot next,
      // ahead of any cross-model swap — from that model's perspective the slot never actually
      // went idle, a sibling request for the SAME model was simply waiting its turn. Exactly
      // one waiter proceeds per release, preserving the "at most one active request per model"
      // cap this task exists to add.
      const nextWaiter = slot.waiters.shift();
      if (nextWaiter) {
        clearTimeout(nextWaiter.timer);
        slot.activeRequests = 1;
        logger.info('Ollama same-model queue: next waiter proceeding', {
          providerId, modelName, remainingWaiters: slot.waiters.length,
        });
        nextWaiter.resolve();
      } else {
        // Genuinely idle — see if a DIFFERENT model queued for this provider can swap in.
        this.processQueueForProvider(providerId);
      }
    }

    this.broadcastStatus();
  }

  /** Process queued requests for one provider after a slot becomes idle. */
  private processQueueForProvider(providerId: string): void {
    if (this.queue.length === 0) return;

    const idleSlot = this.slots.find(s => s.providerId === providerId && s.activeRequests === 0);
    if (!idleSlot) return;

    // First queued request for this specific provider.
    const nextRequest = this.queue.find(q => q.providerId === providerId);
    if (!nextRequest) return;
    const nextModelName = nextRequest.modelName;

    logger.info('Ollama model swap (from queue)', {
      providerId, from: idleSlot.modelName, to: nextModelName,
    });
    idleSlot.modelName = nextModelName;

    // Release ALL queued requests for this provider+model combo (they share the slot).
    const toRelease = this.queue.filter(q => q.providerId === providerId && q.modelName === nextModelName);
    this.queue = this.queue.filter(q => !(q.providerId === providerId && q.modelName === nextModelName));

    idleSlot.activeRequests = toRelease.length;

    for (const req of toRelease) {
      clearTimeout(req.timer);
      req.resolve();
    }

    logger.info('Dequeued Ollama requests', {
      providerId, modelName: nextModelName,
      count: toRelease.length,
      remainingQueue: this.queue.length,
    });
  }

  /** Get current status for the Health page / API. */
  getStatus(): {
    maxConcurrentModels: number;
    slots: Array<{ providerId: string; modelName: string; activeRequests: number }>;
    queuedRequests: number;
    queuedModels: Array<{ providerId: string; modelName: string }>;
    // T81c Fix Round 1, Minor 1: the SAME-MODEL queue this task adds (`ModelSlot.waiters`) is a
    // DIFFERENT condition from `queuedRequests`/`queuedModels` above — those mean two DIFFERENT
    // models are contending for one provider slot; these mean the GPU is being asked for MORE
    // of the IDENTICAL model than it can run at once, which is exactly the contention this task
    // exists to govern. Surfaced separately so the Health page can tell the two apart rather
    // than folding a same-model pileup into a number that reads as a model-swap wait.
    sameModelWaiters: number;
    sameModelWaitingModels: Array<{ providerId: string; modelName: string; count: number }>;
  } {
    const sameModelWaitingModels = this.slots
      .filter(s => s.waiters.length > 0)
      .map(s => ({ providerId: s.providerId, modelName: s.modelName, count: s.waiters.length }));
    return {
      maxConcurrentModels: this.maxConcurrentModels,
      slots: this.slots.map(s => ({
        providerId: s.providerId,
        modelName: s.modelName,
        activeRequests: s.activeRequests,
      })),
      queuedRequests: this.queue.length,
      queuedModels: [
        ...new Map(this.queue.map(q => [`${q.providerId}:${q.modelName}`, { providerId: q.providerId, modelName: q.modelName }])).values(),
      ],
      sameModelWaiters: sameModelWaitingModels.reduce((sum, m) => sum + m.count, 0),
      sameModelWaitingModels,
    };
  }

  // Last-known "offending providers" set, used to dedupe warnings so we
  // log only when the set changes.
  private lastWarningKey = '';

  private broadcastStatus(): void {
    const status = this.getStatus();

    if (this.queue.length > 0) {
      logger.warn(`Ollama requests queuing: ${this.queue.length} waiting for model swap`, {
        queuedRequests: this.queue.length,
        queuedModels: status.queuedModels,
        currentSlots: status.slots.map(s => `${s.providerId}:${s.modelName}(${s.activeRequests})`),
      });
    }

    // T81c Fix Round 1, Minor 1: a DIFFERENT warning from the one above — this is same-model
    // pileup (the GPU-livelock incident's own shape), not a cross-model swap wait.
    if (status.sameModelWaiters > 0) {
      logger.warn(`Ollama requests queuing behind a same-model call: ${status.sameModelWaiters} waiting`, {
        sameModelWaiters: status.sameModelWaiters,
        sameModelWaitingModels: status.sameModelWaitingModels,
      });
    }

    // Warn when any provider has more distinct active agent models than
    // the limit. Computed per-provider from `getActiveOllamaModelsByProvider`.
    const byProvider = getActiveOllamaModelsByProvider();
    const offenders = byProvider.filter(p => p.count > this.maxConcurrentModels);
    const offenderKey = offenders
      .map(o => `${o.providerId}:${o.count}`)
      .sort()
      .join('|');
    if (offenderKey !== this.lastWarningKey) {
      if (offenders.length > 0) {
        for (const o of offenders) {
          logger.warn(
            `${o.count} different Ollama models assigned across active agents on provider "${o.providerName}" (limit: ${this.maxConcurrentModels}). Agents may experience delays waiting for model swaps.`,
            {
              providerId: o.providerId,
              providerName: o.providerName,
              count: o.count,
              models: o.models,
              maxConcurrentModels: this.maxConcurrentModels,
            },
          );
        }
      }
      this.lastWarningKey = offenderKey;
    }

    broadcast({
      type: 'ollama:status',
      data: status,
    });
  }
}

// Singleton
const ollamaLock = new OllamaModelLock();

export function getOllamaLock(): OllamaModelLock {
  return ollamaLock;
}

// ── Per-provider active model accounting ────────────────────────────

export interface OllamaProviderActiveModels {
  providerId: string;
  providerName: string;
  count: number;
  models: string[];
}

/**
 * Return one record per Ollama provider describing how many distinct
 * active-agent models are currently assigned to it. Used by the warning
 * banner to flag over-limit providers individually instead of lumping
 * every Ollama provider into one global count.
 */
export function getActiveOllamaModelsByProvider(): OllamaProviderActiveModels[] {
  try {
    const db = getDb();
    const rows = db.prepare(`
      SELECT
        p.id AS provider_id,
        p.name AS provider_name,
        m.api_model_id
      FROM agents a
      JOIN models m ON m.id = a.model_id
      JOIN providers p ON p.id = m.provider_id
      WHERE a.status != 'terminated'
        AND p.type = 'ollama'
    `).all() as Array<{
      provider_id: string;
      provider_name: string;
      api_model_id: string;
    }>;

    const byProvider = new Map<string, { providerName: string; models: Set<string> }>();
    for (const r of rows) {
      let entry = byProvider.get(r.provider_id);
      if (!entry) {
        entry = { providerName: r.provider_name, models: new Set<string>() };
        byProvider.set(r.provider_id, entry);
      }
      entry.models.add(r.api_model_id);
    }

    return Array.from(byProvider.entries()).map(([providerId, entry]) => ({
      providerId,
      providerName: entry.providerName,
      count: entry.models.size,
      models: Array.from(entry.models),
    }));
  } catch {
    return [];
  }
}

/** Get the max concurrent models setting. */
export function getOllamaMaxConcurrent(): number {
  return ollamaLock.getStatus().maxConcurrentModels;
}
