// Ollama concurrency manager, per provider: limits how many distinct models are loaded at once on EACH
// provider (`ollama_max_concurrent_models`, the same limit for every provider, each host counted alone).
// A second call for the SAME model queues behind the running one; a DIFFERENT model takes a free slot
// or queues until a slot idles.

import { createLogger } from '../logger.js';
import { getDb } from '../db/connection.js';
import { isLocalOllamaBaseUrl } from './num-ctx-calculator.js';

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
  // Requests for THIS SAME model queued behind the one already running; `release` lets at most one through.
  waiters: QueuedRequest[];
}

/**
 * How long a request may wait BEHIND a same-model call already running before giving up.
 *
 * `declaredFirstChunkMs` is the queuing caller's own first-chunk patience for the model it asks for. Both
 * callers ask for the same model on the same provider, so it is the bound the running call declared too.
 * Without it the flat `QUEUE_TIMEOUT_MS` would starve a request queued behind a legitimately long prefill.
 *
 * A floor, not a guarantee: it bounds the occupying call's prefill only. Once streaming, that call can hold
 * the slot far longer (its idle bound re-arms per chunk), so a waiter can still time out behind a slow but
 * healthy completion; the error names that cause.
 *
 * Deliberate tradeoff: under sustained same-model pressure a DIFFERENT model queued for a swap can starve,
 * because the slot never idles long enough for `processQueueForProvider` to run.
 */
function sameModelQueueTimeoutMs(declaredFirstChunkMs?: number): number {
  if (typeof declaredFirstChunkMs === 'number' && Number.isFinite(declaredFirstChunkMs) && declaredFirstChunkMs > 0) {
    return Math.max(QUEUE_TIMEOUT_MS, declaredFirstChunkMs);
  }
  return QUEUE_TIMEOUT_MS;
}

class OllamaModelLock {
  // Every slot carries its providerId; all search and accounting filter by it first.
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
    }
  }

  /** Reload config when settings change. */
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
   * `declaredFirstChunkMs` is the caller's declared first-chunk patience (`agent/model.ts` passes the same
   * lifted `bounds.firstChunkMs` its watchdog arms); it bounds the wait on BOTH queueing paths.
   */
  async acquire(providerId: string, modelName: string, declaredFirstChunkMs?: number, pinned = false): Promise<void> {
    // An ENGINE call on the Dojo's own resident pair (`pinned`, decided by the caller from the call and the
    // local provider's own row, never by tag) holds no slot: it never waits behind an agent's turn and the
    // lock never swaps the agent's model for it. It counts as unslotted local work; `release` mirrors this.
    if (pinned) { unslotted++; return; }
    this.loadConfig();   // re-read config on each acquire (single DB read, ~0.1ms)

    const existingSlot = this.slots.find(s => s.providerId === providerId && s.modelName === modelName);
    if (existingSlot) {
      if (existingSlot.activeRequests === 0) {
        // Slot exists from an earlier call with nothing running on it: take it.
        existingSlot.activeRequests = 1;
        logger.debug('Ollama lock acquired (existing idle slot)', { providerId, modelName });
        this.broadcastStatus();
        return;
      }

      // A call for this SAME model is already running: queue behind it instead of dialing alongside, so
      // concurrent long prefills never stack on one GPU. `release` lets at most one waiter through.
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

    const idleSlot = providerSlots.find(s => s.activeRequests === 0);
    if (idleSlot) {
      logger.info('Ollama model swap', { providerId, from: idleSlot.modelName, to: modelName });
      idleSlot.modelName = modelName;
      idleSlot.activeRequests = 1;
      idleSlot.waiters = []; // defensive: an idle slot (0 active) can never carry same-model waiters, see `release`
      this.broadcastStatus();
      return;
    }

    // Every slot on this provider is busy with a different model: queue.
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
          `Ollama model swap timed out after ${Math.round(sameModelQueueTimeoutMs(declaredFirstChunkMs) / 1000)}s ` +
          `on provider ${providerId} — other model(s) (${currentModels}) still in use. ` +
          `Try again, switch this agent to the same model, or raise this provider's declared patience.`
        ));
      }, sameModelQueueTimeoutMs(declaredFirstChunkMs));

      this.queue.push({ providerId, modelName, resolve, reject, queuedAt: Date.now(), timer });
      this.broadcastStatus();
    });
  }

  /** Release a slot after a call completes, success or error. */
  release(providerId: string, modelName: string, pinned = false): void {
    if (pinned) { unslotted = Math.max(0, unslotted - 1); return; }   // it took no slot (see `acquire`)
    const slot = this.slots.find(s => s.providerId === providerId && s.modelName === modelName);
    if (!slot) {
      logger.warn('Ollama lock release: no slot found', { providerId, modelName });
      return;
    }

    slot.activeRequests = Math.max(0, slot.activeRequests - 1);
    logger.debug('Ollama lock released', { providerId, modelName, activeRequests: slot.activeRequests });

    if (slot.activeRequests === 0) {
      // A caller queued behind this same model gets the slot next, ahead of any cross-model swap. Exactly
      // one waiter proceeds per release, keeping at most one active request per model.
      const nextWaiter = slot.waiters.shift();
      if (nextWaiter) {
        clearTimeout(nextWaiter.timer);
        slot.activeRequests = 1;
        logger.info('Ollama same-model queue: next waiter proceeding', {
          providerId, modelName, remainingWaiters: slot.waiters.length,
        });
        nextWaiter.resolve();
      } else {
        // Idle: a different model queued for this provider can swap in.
        this.processQueueForProvider(providerId);
      }
    }

    this.broadcastStatus();
  }

  /** How much is in flight on `providerId` now: its slots' requests plus the unslotted local work. */
  localBusy(providerId: string): number {
    return this.slotsForProvider(providerId).reduce((n, s) => n + s.activeRequests, 0) + unslotted;
  }

  /** Serve queued requests for one provider after a slot becomes idle. */
  private processQueueForProvider(providerId: string): void {
    if (this.queue.length === 0) return;

    const idleSlot = this.slots.find(s => s.providerId === providerId && s.activeRequests === 0);
    if (!idleSlot) return;

    const nextRequest = this.queue.find(q => q.providerId === providerId);
    if (!nextRequest) return;
    const nextModelName = nextRequest.modelName;

    logger.info('Ollama model swap (from queue)', {
      providerId, from: idleSlot.modelName, to: nextModelName,
    });
    idleSlot.modelName = nextModelName;

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
    // Same-model waiters are a different condition from `queuedRequests`: the GPU is asked for more of
    // one model than it can run at once, not two models contending for a slot. Reported separately.
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

  // Last-known offending providers, so the warning logs only when the set changes.
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
  }
}

let unslotted = 0;
const ollamaLock = new OllamaModelLock();

/** Work on this box's Ollama that takes no slot (decide(), the embedder, a pull) begins; the returned function
 *  ends it, once. A restart waits until nothing is in flight (`ollama-restart.ts whenQuiet`). */
export function localWorkBegins(baseUrl?: string): () => void {
  if (baseUrl !== undefined && !isLocalOllamaBaseUrl(baseUrl)) return () => {};
  unslotted++;
  let ended = false;
  return () => { if (!ended) { ended = true; unslotted--; } };
}

export function getOllamaLock(): OllamaModelLock {
  return ollamaLock;
}


export interface OllamaProviderActiveModels {
  providerId: string;
  providerName: string;
  count: number;
  models: string[];
}

/** One record per Ollama provider: how many distinct active-agent models are assigned to it. */
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

export function getOllamaMaxConcurrent(): number {
  return ollamaLock.getStatus().maxConcurrentModels;
}
