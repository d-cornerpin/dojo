// The provider-balance check: one background check, kicked by the scheduler (scheduler/background-checks.ts) and
// run at most once per `BALANCE_CHECK_EVERY_MS`. The Ledger routes read balances through the readers below and
// decide nothing. This module is the only writer of the `openrouter_threshold_alerted` and
// `deepseek_threshold_alerted` latches. Once per real crossing: at or below the threshold and not latched, latch
// then tell the owner once; back above it while latched, re-arm silently. The latch is a config row, so a restart
// never re-alerts; a failed provider call changes nothing; no provider or key clears the latch, so a key added
// later on a low account is told once.

import { getDb } from '../db/connection.js';
import { setConfigValue } from '../config/config-value.js';
import { createLogger } from '../logger.js';
import { getProviderCredential } from '../config/loader.js';
import { sendAlert } from '../services/imessage-bridge.js';
import { ownerConditionCleared, tellOwner } from '../healer/owner-notices.js';

const logger = createLogger('provider-balance');

/** How often a provider's balance API is asked: the first scheduler tick at or after each ten-minute mark.
 *  A balance drains over hours, and the Ledger page still reads live whenever it is open. */
export const BALANCE_CHECK_EVERY_MS = 10 * 60_000;

/** The threshold a box gets before the owner sets one: the same $5 the Ledger page shows. */
const DEFAULT_THRESHOLD_USD = 5;

const FETCH_TIMEOUT_MS = 10_000;

type Read<T> = { ok: true; data: T } | { ok: false; error: string };

export interface OpenRouterCredits { total_credits: number; total_usage: number; balance: number }
export interface DeepSeekBalance {
  currency: string; balance: number; granted_balance: number; topped_up_balance: number; is_available: boolean;
}

/** The OpenRouter account, if one is configured: an openai-compatible provider on its URL. */
export function findOpenRouterProvider(): { id: string } | undefined {
  return getDb().prepare(
    "SELECT id FROM providers WHERE type = 'openai-compatible' AND base_url LIKE '%openrouter%'",
  ).get() as { id: string } | undefined;
}

/** The DeepSeek account, if one is configured. */
export function findDeepSeekProvider(): { id: string } | undefined {
  return getDb().prepare(
    "SELECT id FROM providers WHERE type = 'openai-compatible' AND base_url LIKE '%deepseek.com%'",
  ).get() as { id: string } | undefined;
}

/** Ask OpenRouter for the account's credits. Throws only if the request itself fails. */
export async function readOpenRouterCredits(credential: string): Promise<Read<OpenRouterCredits>> {
  const resp = await fetch('https://openrouter.ai/api/v1/credits', {
    headers: { Authorization: `Bearer ${credential}` },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!resp.ok) return { ok: false, error: `OpenRouter returned ${resp.status}` };

  const raw = await resp.json() as Record<string, unknown>;
  logger.debug('OpenRouter credits raw response', { raw: JSON.stringify(raw) });
  // Normalize: the response may be { data: { ... } } or flat, with varying field names.
  const src = (raw.data ?? raw) as Record<string, unknown>;
  // A 200 holding no figure at all (empty body, another wrapper, an error sent with status 200) is not a $0.00
  // balance: knowing nothing must not latch the alert. The DeepSeek reader refuses its no-info case the same way.
  const hasFigure = [src.balance, src.remaining, src.total_credits, src.totalCredits].some((v) => typeof v === 'number');
  if (!hasFigure) return { ok: false, error: 'OpenRouter returned no credit figures' };
  const totalCredits = (src.total_credits ?? src.totalCredits ?? src.limit ?? 0) as number;
  const totalUsage = (src.total_usage ?? src.totalUsage ?? src.usage ?? 0) as number;
  const balance = (src.balance ?? src.remaining ?? (totalCredits - totalUsage)) as number;
  if (!Number.isFinite(balance)) return { ok: false, error: 'OpenRouter returned no credit figures' };
  return { ok: true, data: { total_credits: totalCredits, total_usage: totalUsage, balance } };
}

/** Ask DeepSeek for the account's balance (the USD row, else the first). Throws only if the request fails. */
export async function readDeepSeekBalance(credential: string): Promise<Read<DeepSeekBalance>> {
  const resp = await fetch('https://api.deepseek.com/user/balance', {
    headers: { Authorization: `Bearer ${credential}` },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!resp.ok) return { ok: false, error: `DeepSeek returned ${resp.status}` };

  const raw = await resp.json() as {
    is_available?: boolean;
    balance_infos?: Array<{ currency: string; total_balance: string; granted_balance?: string; topped_up_balance?: string }>;
  };
  logger.debug('DeepSeek balance raw response', { raw: JSON.stringify(raw) });
  const usd = raw.balance_infos?.find(b => b.currency === 'USD') ?? raw.balance_infos?.[0];
  if (!usd) return { ok: false, error: 'DeepSeek returned no balance info' };
  return {
    ok: true,
    data: {
      currency: usd.currency,
      balance: parseFloat(usd.total_balance),
      granted_balance: usd.granted_balance ? parseFloat(usd.granted_balance) : 0,
      topped_up_balance: usd.topped_up_balance ? parseFloat(usd.topped_up_balance) : 0,
      is_available: raw.is_available ?? true,
    },
  };
}

interface Watched {
  /** The owner's line and the once-per-crossing latch; both are read in `readKeys`, spelled out in full so
   *  the shipped-config-keys census sees the read. */
  thresholdKey: string;
  latchKey: string;
  label: string;
  topUpAt: string;
  find: () => { id: string } | undefined;
  balance: (credential: string) => Promise<number | null>;
}

const WATCHED: readonly Watched[] = [
  {
    thresholdKey: 'openrouter_warning_threshold', latchKey: 'openrouter_threshold_alerted',
    label: 'OpenRouter', topUpAt: 'openrouter.ai',
    find: findOpenRouterProvider,
    balance: async (cred) => { const r = await readOpenRouterCredits(cred); return r.ok ? r.data.balance : null; },
  },
  {
    thresholdKey: 'deepseek_warning_threshold', latchKey: 'deepseek_threshold_alerted',
    label: 'DeepSeek', topUpAt: 'platform.deepseek.com',
    find: findDeepSeekProvider,
    balance: async (cred) => { const r = await readDeepSeekBalance(cred); return r.ok ? r.data.balance : null; },
  },
];

const usd = (n: number): string => (Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`);

/** Every key the check reads, in one batched read. */
function readKeys(): Map<string, string> {
  const rows = getDb().prepare(`SELECT key, value FROM config WHERE key IN (
    'openrouter_warning_threshold', 'openrouter_threshold_alerted',
    'deepseek_warning_threshold', 'deepseek_threshold_alerted')`).all() as Array<{ key: string; value: string }>;
  return new Map(rows.map((r) => [r.key, r.value]));
}

function thresholdOf(raw: string | undefined): number | null {
  const value = raw === undefined ? DEFAULT_THRESHOLD_USD : parseFloat(raw);
  return Number.isFinite(value) ? value : null;
}

/** The latch is the crossing told (its card `balance:<latch>` stands while it does); a top-up or no key ends both. */
function setLatch(latchKey: string, words: string | null): void {
  const db = getDb();
  if (words === null) {
    db.prepare('DELETE FROM config WHERE key = ?').run(latchKey);
    ownerConditionCleared(`balance:${latchKey}`);
    return;
  }
  setConfigValue(latchKey, JSON.stringify({ at: Date.now() }));
  tellOwner(`balance:${latchKey}`, words);
}

async function checkOne(w: Watched): Promise<void> {
  const { latchKey } = w;
  const keys = readKeys();
  const latched = keys.has(latchKey);

  const provider = w.find();
  const credential = provider ? getProviderCredential(provider.id) : null;
  if (!credential) {
    if (latched) setLatch(latchKey, null);
    return;
  }

  let balance: number | null;
  try {
    balance = await w.balance(credential);
  } catch (err) {
    logger.info(`${w.label} balance check could not reach the provider`, { error: err instanceof Error ? err.message : String(err) });
    return;
  }
  const threshold = thresholdOf(keys.get(w.thresholdKey));
  if (balance === null || !Number.isFinite(balance) || threshold === null) return;

  if (!latched && balance <= threshold) {
    const words = `${w.label} balance is $${balance.toFixed(2)}, at or below your ${usd(threshold)} warning threshold. Add credits at ${w.topUpAt}.`;
    setLatch(latchKey, words);
    logger.warn(`${w.label} balance at or below its warning threshold`, { balance, threshold });
    void sendAlert(words, 'notice', { kind: 'budget' });
  } else if (latched && balance > threshold) {
    setLatch(latchKey, null);
    logger.info(`${w.label} balance back above its warning threshold, re-armed`, { balance, threshold });
  }
}

/** Check every watched provider now. Never throws: one provider's failure is not another's. */
export async function checkProviderBalances(): Promise<void> {
  for (const w of WATCHED) {
    try {
      await checkOne(w);
    } catch (err) {
      logger.error(`${w.label} balance check failed`, { error: err instanceof Error ? err.message : String(err) });
    }
  }
}

let lastStartedAt = Number.NEGATIVE_INFINITY;
let inFlight: Promise<void> | null = null;

/** The scheduler's entry: run the check if it is due and not already running. Returns the running check
 *  (a caller MAY wait for it), or `null` when it was not due. */
export function maybeCheckProviderBalances(now: number = Date.now()): Promise<void> | null {
  if (inFlight) return null;
  if (now - lastStartedAt < BALANCE_CHECK_EVERY_MS) return null;
  lastStartedAt = now;
  inFlight = checkProviderBalances().finally(() => { inFlight = null; });
  return inFlight;
}
