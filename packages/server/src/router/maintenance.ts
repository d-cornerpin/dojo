// ════════════════════════════════════════
// Router Maintenance Loop
// Sparse, periodic self-training. NOT constant. The working assumption is the
// semantic router is already accurate, so this wakes up occasionally, retrains
// only when enough fresh labels have accumulated and enough time has passed,
// and otherwise does nothing. Fully gated on auto-router being in use.
// See SEMANTIC-ROUTER-PLAN (local doc).
// ════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { isAutoRouterInUse } from './gating.js';
import { countLabels } from './labels.js';
import { resetProbeBudget } from './probe.js';

const logger = createLogger('router-maintenance');

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;        // wake up every 6 hours
const MIN_TRAIN_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // retrain at most weekly
const MIN_NEW_LABELS = 100;                           // ...and only with fresh data

let timer: ReturnType<typeof setInterval> | null = null;

function getConfig(key: string): string | null {
  try {
    const row = getDb().prepare('SELECT value FROM config WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  } catch {
    return null;
  }
}

function setConfig(key: string, value: string): void {
  try {
    getDb().prepare(`
      INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
    `).run(key, value);
  } catch { /* best effort */ }
}

async function runCycle(): Promise<void> {
  try {
    // Each cycle refreshes the probe budget regardless of whether we train.
    resetProbeBudget();

    if (!isAutoRouterInUse()) return; // dormant when no agent is on auto-router

    const total = countLabels();
    const lastCount = Number(getConfig('router_last_train_count') ?? '0') || 0;
    const newLabels = total - lastCount;

    const lastAtStr = getConfig('router_last_train_at');
    const lastAt = lastAtStr ? Date.parse(lastAtStr) : 0;
    const sinceMs = Date.now() - (Number.isFinite(lastAt) ? lastAt : 0);

    if (lastAt && sinceMs < MIN_TRAIN_INTERVAL_MS) {
      return; // trained recently; stay quiet
    }
    if (newLabels < MIN_NEW_LABELS) {
      return; // not enough fresh signal to bother
    }

    logger.info('Router maintenance: training cycle', { totalLabels: total, newLabels });
    const { trainAndMaybePromote } = await import('./trainer.js');
    const result = trainAndMaybePromote();
    logger.info('Router maintenance: training result', {
      trained: result.trained,
      promoted: result.promoted,
      reason: result.reason,
      evalScore: result.evalScore,
      trainedOn: result.trainedOn,
    });

    setConfig('router_last_train_at', new Date().toISOString());
    setConfig('router_last_train_count', String(total));
  } catch (err) {
    logger.warn('Router maintenance cycle failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export function startRouterMaintenance(): void {
  if (timer) return;
  timer = setInterval(() => { void runCycle(); }, CHECK_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  // A delayed first tick so it never piles onto cold boot.
  const kickoff = setTimeout(() => { void runCycle(); }, 5 * 60 * 1000);
  if (typeof kickoff.unref === 'function') kickoff.unref();
  logger.info('Router maintenance loop started (sparse, gated)');
}

export function stopRouterMaintenance(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
