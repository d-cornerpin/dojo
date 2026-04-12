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

  /** Acquire a slot for the given provider+model. Resolves when the caller may proceed. */
  async acquire(providerId: string, modelName: string): Promise<void> {
    // Re-read config on each acquire (single DB read, ~0.1ms)
    this.loadConfig();

    // Is this model already loaded on this provider? Share the slot.
    const existingSlot = this.slots.find(s => s.providerId === providerId && s.modelName === modelName);
    if (existingSlot) {
      existingSlot.activeRequests++;
      logger.debug('Ollama lock acquired (existing slot)', {
        providerId, modelName, activeRequests: existingSlot.activeRequests,
      });
      this.broadcastStatus();
      return;
    }

    // Room for a new model slot on this provider?
    const providerSlots = this.slotsForProvider(providerId);
    if (providerSlots.length < this.maxConcurrentModels) {
      this.slots.push({ providerId, modelName, activeRequests: 1 });
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

    // If this slot is now idle, see if queued requests on the SAME provider can proceed.
    if (slot.activeRequests === 0) {
      this.processQueueForProvider(providerId);
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
  } {
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
