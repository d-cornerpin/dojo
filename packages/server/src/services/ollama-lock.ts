// ════════════════════════════════════════
// Ollama Concurrency Manager
// ════════════════════════════════════════
// Prevents RAM thrashing on memory-constrained machines by ensuring
// only N Ollama models are loaded simultaneously (default: 1 for 16GB).
// Multiple agents using the SAME model can run concurrently.
// Agents needing a DIFFERENT model queue until the current one drains.

import { createLogger } from '../logger.js';
import { broadcast } from '../gateway/ws.js';
import { getDb } from '../db/connection.js';

const logger = createLogger('ollama-lock');

const QUEUE_TIMEOUT_MS = 60000; // 60 seconds

interface QueuedRequest {
  modelName: string;
  resolve: () => void;
  reject: (err: Error) => void;
  queuedAt: number;
  timer: ReturnType<typeof setTimeout>;
}

interface ModelSlot {
  modelName: string;
  activeRequests: number;
}

class OllamaModelLock {
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

  /** Acquire a slot for the given model. Resolves when the caller may proceed. */
  async acquire(modelName: string): Promise<void> {
    // Re-read config on each acquire (single DB read, ~0.1ms)
    this.loadConfig();

    // Check if this model already has an active slot
    const existingSlot = this.slots.find(s => s.modelName === modelName);
    if (existingSlot) {
      existingSlot.activeRequests++;
      logger.debug('Ollama lock acquired (existing slot)', { modelName, activeRequests: existingSlot.activeRequests });
      this.broadcastStatus();
      return;
    }

    // Check if we have room for a new model
    if (this.slots.length < this.maxConcurrentModels) {
      this.slots.push({ modelName, activeRequests: 1 });
      logger.info('Ollama lock acquired (new slot)', { modelName, slotsUsed: this.slots.length, maxSlots: this.maxConcurrentModels });
      this.broadcastStatus();
      return;
    }

    // Check if any slot is idle (activeRequests === 0) — we can swap it
    const idleSlot = this.slots.find(s => s.activeRequests === 0);
    if (idleSlot) {
      logger.info('Ollama model swap', { from: idleSlot.modelName, to: modelName });
      idleSlot.modelName = modelName;
      idleSlot.activeRequests = 1;
      this.broadcastStatus();
      return;
    }

    // All slots are busy with different models — queue the request
    const queueLength = this.queue.filter(q => q.modelName === modelName).length + 1;
    const currentModels = this.slots.map(s => s.modelName).join(', ');
    logger.info(`Waiting for Ollama model swap: [${currentModels}] → ${modelName} (${queueLength} requests queued)`, {
      modelName,
      currentModels: this.slots.map(s => s.modelName),
      queueLength,
    });

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        // Remove from queue
        const idx = this.queue.findIndex(q => q.resolve === resolve);
        if (idx !== -1) this.queue.splice(idx, 1);
        this.broadcastStatus();
        reject(new Error(
          `Ollama model swap timed out — other model(s) (${currentModels}) still in use. ` +
          `Try again or switch this agent to the same model.`
        ));
      }, QUEUE_TIMEOUT_MS);

      this.queue.push({ modelName, resolve, reject, queuedAt: Date.now(), timer });
      this.broadcastStatus();
    });
  }

  /** Release a slot after an Ollama call completes (success or error). */
  release(modelName: string): void {
    const slot = this.slots.find(s => s.modelName === modelName);
    if (!slot) {
      logger.warn('Ollama lock release: no slot found', { modelName });
      return;
    }

    slot.activeRequests = Math.max(0, slot.activeRequests - 1);
    logger.debug('Ollama lock released', { modelName, activeRequests: slot.activeRequests });

    // If this slot is now idle, check if queued requests can proceed
    if (slot.activeRequests === 0) {
      this.processQueue();
    }

    this.broadcastStatus();
  }

  /** Process queued requests after a slot becomes idle. */
  private processQueue(): void {
    if (this.queue.length === 0) return;

    // Find an idle slot
    const idleSlot = this.slots.find(s => s.activeRequests === 0);
    if (!idleSlot) return;

    // Find the first queued model name
    const nextModelName = this.queue[0].modelName;

    // Swap the idle slot to the new model
    logger.info('Ollama model swap (from queue)', { from: idleSlot.modelName, to: nextModelName });
    idleSlot.modelName = nextModelName;

    // Release ALL queued requests for this model (they can run concurrently)
    const toRelease = this.queue.filter(q => q.modelName === nextModelName);
    this.queue = this.queue.filter(q => q.modelName !== nextModelName);

    idleSlot.activeRequests = toRelease.length;

    for (const req of toRelease) {
      clearTimeout(req.timer);
      req.resolve();
    }

    logger.info('Dequeued Ollama requests', { modelName: nextModelName, count: toRelease.length, remainingQueue: this.queue.length });
  }

  /** Get current status for the Health page / API. */
  getStatus(): {
    maxConcurrentModels: number;
    slots: Array<{ modelName: string; activeRequests: number }>;
    queuedRequests: number;
    queuedModels: string[];
  } {
    return {
      maxConcurrentModels: this.maxConcurrentModels,
      slots: this.slots.map(s => ({ modelName: s.modelName, activeRequests: s.activeRequests })),
      queuedRequests: this.queue.length,
      queuedModels: [...new Set(this.queue.map(q => q.modelName))],
    };
  }

  private lastWarningModelCount = 0;

  private broadcastStatus(): void {
    const status = this.getStatus();

    // Log warning when requests are actively queuing
    if (this.queue.length > 0) {
      logger.warn(`Ollama requests queuing: ${this.queue.length} waiting for model swap`, {
        queuedRequests: this.queue.length,
        queuedModels: [...new Set(this.queue.map(q => q.modelName))],
        currentSlots: this.slots.map(s => `${s.modelName}(${s.activeRequests})`),
      });
    }

    // Log warning when distinct active agent models exceed limit (once per change)
    const active = getActiveOllamaModelCount();
    if (active.count > this.maxConcurrentModels && active.count !== this.lastWarningModelCount) {
      logger.warn(`${active.count} different Ollama models assigned across active agents (limit: ${this.maxConcurrentModels}). Agents may experience delays waiting for model swaps.`, {
        ollamaModels: active.models,
        maxConcurrentModels: this.maxConcurrentModels,
      });
      this.lastWarningModelCount = active.count;
    } else if (active.count <= this.maxConcurrentModels) {
      this.lastWarningModelCount = 0;
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

/** Check how many distinct Ollama models are assigned to active agents. */
export function getActiveOllamaModelCount(): { count: number; models: string[] } {
  try {
    const db = getDb();
    const rows = db.prepare(`
      SELECT DISTINCT m.api_model_id
      FROM agents a
      JOIN models m ON m.id = a.model_id
      JOIN providers p ON p.id = m.provider_id
      WHERE a.status != 'terminated'
        AND p.type = 'ollama'
    `).all() as Array<{ api_model_id: string }>;

    return {
      count: rows.length,
      models: rows.map(r => r.api_model_id),
    };
  } catch {
    return { count: 0, models: [] };
  }
}

/** Get the max concurrent models setting. */
export function getOllamaMaxConcurrent(): number {
  return ollamaLock.getStatus().maxConcurrentModels;
}
