// ════════════════════════════════════════════════════════════════════════════════════════
// PREFILL SELF-CALIBRATION — THE COST LEDGER IS A SPEEDOMETER.
//
// OWNER DESIGN RULING, 2026-09-22: "never ask the user for a number the platform can observe."
//
// ── WHAT THIS FILE PINS ──
//  1. THE ARITHMETIC IS THE INCIDENT'S OWN. The round-5 forensics row off the dev box —
//     35,237 uncached input tokens in 194.6 seconds — reproduces ~181 tok/s through the real
//     estimator, from fixture rows, not from a number written down in a comment.
//  2. MAX, NOT MEAN, NOT LAST. Each row's quotient is a LOWER bound on the box's prefill rate
//     (latency contains the prefill and then some), so the tightest thing the ledger can say
//     is the LARGEST of them. A loose bound beside a tight one must lose.
//  3. THE FLOOR IS LOAD-BEARING, AND THE COUNTERFACTUAL IS IN HERE. Prefill is batched, so a
//     short chatty call answers in roughly the time a one-token call would and its quotient
//     reads as a speed the box could not hold for a second. Drop the floor and that one row
//     takes the max. This file runs the identical fixture through a floor-free estimator and
//     shows the corruption, the same way `migration-155`'s BODY D runs its adversarial body
//     through a guard-free migration.
//  4. THE WINDOW IS REAL. A fast row older than the rolling window stops counting, and the
//     stored reading falls to what the window still supports — driven against a real DB and
//     the real migration chain, not asserted about the SQL.
//  5. DECLARED IS NOT TOUCHED. Self-calibration writes `measured_prefill_tokens_per_sec` and
//     nothing else; `prefill_tokens_per_sec` is a person's claim and no measurement may edit it.
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

vi.mock('../../home.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  const dir = p.join(o.tmpdir(), 'dojo-prefill-calibration');
  return {
    homeDir: (): string => dir,
    dojoDir: (...segs: string[]): string => p.join(dir, '.dojo', ...segs),
    isTestRun: (): boolean => true,
  };
});

const mockDb: { current: Database.Database | null } = { current: null };

vi.mock('../../db/connection.js', async () => {
  const os = await import('node:os');
  const p = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => p.join(os.tmpdir(), 'dojo-prefill-calibration', 'dojo.db'),
  };
});
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../db/migrations.js';
import {
  estimatePrefillTokensPerSec,
  prefillRateFrom,
  recalibrateFromSample,
  PREFILL_SAMPLE_MIN_INPUT_TOKENS,
  PREFILL_SAMPLE_WINDOW_DAYS,
  type PrefillSample,
} from '../prefill-calibration.js';

// ════════════════════════════════════════════════════════════════════════════════════════
// THE FIXTURE — round-5 forensics, transcribed.
//
// The dev box's `local-deepseek` row, as measured: 35,237 uncached input tokens against a
// 194.6-second call. These are TEST VALUES, never code constants — the estimator knows nothing
// about this box, and a change to it must move this file, not the module.
// ════════════════════════════════════════════════════════════════════════════════════════
const ROUND_5_INPUT_TOKENS = 35_237;
const ROUND_5_LATENCY_MS = 194_600;
const ROUND_5_EXPECTED_TOK_PER_SEC = ROUND_5_INPUT_TOKENS / (ROUND_5_LATENCY_MS / 1000); // 181.07…

describe('the arithmetic: one big call is a speedometer reading', () => {
  it('reproduces the round-5 measurement — ~181 tokens/sec, to the digit the forensics report', () => {
    const rate = prefillRateFrom({ inputTokens: ROUND_5_INPUT_TOKENS, latencyMs: ROUND_5_LATENCY_MS });
    expect(rate).not.toBeNull();
    // The forensics wrote "35,237 tokens / 194.6s = 181". Both halves are asserted: the whole
    // number a human would read off it, and the quotient to two places so a silently-changed
    // divisor (milliseconds vs seconds, a stray /1000) cannot pass this clause.
    expect(Math.floor(rate as number)).toBe(181);
    expect(rate as number).toBeCloseTo(181.07, 2);
  });

  it('is a LOWER bound: the same tokens answered faster reads as faster, never the reverse', () => {
    const slower = prefillRateFrom({ inputTokens: ROUND_5_INPUT_TOKENS, latencyMs: ROUND_5_LATENCY_MS * 2 });
    expect(slower as number).toBeLessThan(ROUND_5_EXPECTED_TOK_PER_SEC);
  });
});

describe('the estimator takes the MAXIMUM of the lower bounds', () => {
  // The same box, three calls. The round-5 row is the TIGHT bound (big prompt, and most of that
  // latency really was prefill). The other two are LOOSE — the same box, genuinely, but their
  // latency is mostly generation, so their quotients understate it badly. A mean or a
  // most-recent would answer with one of the loose ones; the max cannot.
  const loose: PrefillSample[] = [
    { inputTokens: 12_000, latencyMs: 300_000 },  //  40 tok/s — a long answer on a big prompt
    { inputTokens: 40_000, latencyMs: 900_000 },  //  44 tok/s — an even longer one
  ];

  it('picks the tight call, not the loose ones', () => {
    const rate = estimatePrefillTokensPerSec([
      ...loose,
      { inputTokens: ROUND_5_INPUT_TOKENS, latencyMs: ROUND_5_LATENCY_MS },
    ]);
    expect(Math.floor(rate as number)).toBe(181);
  });

  it('and the ORDER the rows arrive in cannot change the answer', () => {
    const forwards = estimatePrefillTokensPerSec([
      { inputTokens: ROUND_5_INPUT_TOKENS, latencyMs: ROUND_5_LATENCY_MS }, ...loose,
    ]);
    const backwards = estimatePrefillTokensPerSec([
      ...loose.slice().reverse(), { inputTokens: ROUND_5_INPUT_TOKENS, latencyMs: ROUND_5_LATENCY_MS },
    ]);
    expect(forwards).toBe(backwards);
  });

  it('answers null when not one row qualifies — there is nothing to say, so it says nothing', () => {
    expect(estimatePrefillTokensPerSec([])).toBeNull();
    expect(estimatePrefillTokensPerSec([{ inputTokens: 100, latencyMs: 20 }])).toBeNull();
  });

  it('never divides by a latency it does not have', () => {
    const junk: Array<[string, PrefillSample]> = [
      ['null latency', { inputTokens: 50_000, latencyMs: null }],
      ['undefined latency', { inputTokens: 50_000, latencyMs: undefined }],
      ['zero latency', { inputTokens: 50_000, latencyMs: 0 }],
      ['negative latency', { inputTokens: 50_000, latencyMs: -1 }],
      ['NaN latency', { inputTokens: 50_000, latencyMs: Number.NaN }],
      ['NaN tokens', { inputTokens: Number.NaN, latencyMs: 194_600 }],
    ];
    for (const [label, sample] of junk) {
      expect(prefillRateFrom(sample), label).toBeNull();
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// THE COUNTERFACTUAL — what the floor is actually holding back.
// ════════════════════════════════════════════════════════════════════════════════════════
describe('THE FLOOR: the one change to this module that could make the engine less safe', () => {
  // A perfectly ordinary chatty turn on the SAME box: a short prompt, a short answer, back in
  // twenty milliseconds. Its quotient is a TRUE statement about that call (prefill really did
  // finish inside 20 ms) and a wild lie about the sustained rate on a 110,000-token prompt —
  // prefill is batched, so 100 tokens cost about what 1 token costs.
  const CHATTY: PrefillSample = { inputTokens: 100, latencyMs: 20 };
  const CHATTY_APPARENT_TOK_PER_SEC = 5_000;

  const body: PrefillSample[] = [
    CHATTY,
    { inputTokens: ROUND_5_INPUT_TOKENS, latencyMs: ROUND_5_LATENCY_MS },
  ];

  it('the real estimator reads 181 from a body that CONTAINS the chatty call', () => {
    expect(Math.floor(estimatePrefillTokensPerSec(body) as number)).toBe(181);
  });

  it('⚠ WITHOUT the floor the identical body reads 5,000 — the corruption the floor exists for', () => {
    // The estimator a reasonable person writes first: every row is a valid lower bound, so take
    // the max of all of them. It is not wrong about any single row; it is wrong about which
    // rows are worth maximising over. This clause is why `PREFILL_SAMPLE_MIN_INPUT_TOKENS` is
    // in the module, and a reader who deletes it re-derives this number.
    const floorless = (samples: PrefillSample[]): number | null => {
      let best: number | null = null;
      for (const s of samples) {
        if (typeof s.latencyMs !== 'number' || s.latencyMs <= 0) continue;
        const rate = s.inputTokens / (s.latencyMs / 1000);
        if (best === null || rate > best) best = rate;
      }
      return best;
    };
    expect(floorless(body)).toBe(CHATTY_APPARENT_TOK_PER_SEC);
    // …and a box "measured" at 5,000 tok/s would be handed a doom ceiling ~27x the one the
    // truth supports, which is the pre-dial gate reporting that an un-finishable prompt is fine.
    expect(CHATTY_APPARENT_TOK_PER_SEC / (estimatePrefillTokensPerSec(body) as number)).toBeGreaterThan(20);
  });

  it('the boundary is the constant the module declares, and it is inclusive', () => {
    expect(PREFILL_SAMPLE_MIN_INPUT_TOKENS).toBe(4_000);
    // One token under the floor is not a sample; the floor itself is.
    expect(prefillRateFrom({ inputTokens: PREFILL_SAMPLE_MIN_INPUT_TOKENS - 1, latencyMs: 1_000 })).toBeNull();
    expect(prefillRateFrom({ inputTokens: PREFILL_SAMPLE_MIN_INPUT_TOKENS, latencyMs: 1_000 })).not.toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// THE LIVE PATH — against a real migrated body, not a description of one.
// ════════════════════════════════════════════════════════════════════════════════════════
const seedProvider = (declared: number | null = null): void => {
  mockDb.current!.prepare(`
    INSERT INTO providers (id, name, type, auth_type, prefill_tokens_per_sec, is_validated, created_at, updated_at)
    VALUES ('local', 'Local DS4', 'openai-compatible', 'none', ?, 1, datetime('now'), datetime('now'))
  `).run(declared);
};

/** One ledger row, `ageDays` old. `datetime('now', '-N days')` is SQLite's own clock, as stored. */
const seedCostRow = (id: string, inputTokens: number, latencyMs: number | null, ageDays = 0): void => {
  mockDb.current!.prepare(`
    INSERT INTO cost_records (id, agent_id, model_id, provider_id, input_tokens, output_tokens,
                              cost_usd, latency_ms, created_at)
    VALUES (?, 'kevin', 'm-local', 'local', ?, 10, 0, ?, datetime('now', ?))
  `).run(id, inputTokens, latencyMs, `-${ageDays} days`);
};

const reading = (): { rate: number | null; at: string | null } => {
  const row = mockDb.current!.prepare(
    'SELECT measured_prefill_tokens_per_sec AS rate, measured_prefill_at AS at FROM providers WHERE id = ?',
  ).get('local') as { rate: number | null; at: string | null };
  return row;
};

beforeEach(() => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  mockDb.current = db;
  runMigrations();
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

describe('recalibrateFromSample — the reading lands on the row', () => {
  it('a qualifying call establishes the reading, and it is the round-5 number', () => {
    seedProvider();
    expect(reading().rate).toBeNull();
    recalibrateFromSample('local', { inputTokens: ROUND_5_INPUT_TOKENS, latencyMs: ROUND_5_LATENCY_MS });
    expect(Math.floor(reading().rate as number)).toBe(181);
    expect(reading().at).not.toBeNull();
  });

  it('a call below the floor establishes NOTHING — the column stays null', () => {
    seedProvider();
    recalibrateFromSample('local', { inputTokens: 100, latencyMs: 20 });
    expect(reading().rate).toBeNull();
    expect(reading().at).toBeNull();
  });

  it('RATCHETS UP on a faster sample and refuses to be dragged down by a slower one', () => {
    seedProvider();
    recalibrateFromSample('local', { inputTokens: ROUND_5_INPUT_TOKENS, latencyMs: ROUND_5_LATENCY_MS });
    const established = reading().rate as number;
    // A loose bound off the same box. It is true and it is smaller; a max does not take it.
    recalibrateFromSample('local', { inputTokens: 10_000, latencyMs: 600_000 });
    expect(reading().rate).toBe(established);
    // A genuinely faster call does move it.
    recalibrateFromSample('local', { inputTokens: 100_000, latencyMs: 200_000 }); // 500 tok/s
    expect(reading().rate).toBe(500);
  });

  it('NEVER touches the declared column — a measurement may not edit a person\'s claim', () => {
    seedProvider(250);
    recalibrateFromSample('local', { inputTokens: ROUND_5_INPUT_TOKENS, latencyMs: ROUND_5_LATENCY_MS });
    const row = mockDb.current!.prepare(
      'SELECT prefill_tokens_per_sec AS declared, measured_prefill_tokens_per_sec AS measured FROM providers WHERE id = ?',
    ).get('local') as { declared: number | null; measured: number | null };
    expect(row.declared).toBe(250);
    expect(Math.floor(row.measured as number)).toBe(181);
  });

  it('a provider that does not exist is a no-op, never a throw — a cost row must still record', () => {
    expect(() => recalibrateFromSample('nobody', {
      inputTokens: ROUND_5_INPUT_TOKENS, latencyMs: ROUND_5_LATENCY_MS,
    })).not.toThrow();
  });
});

describe('THE WINDOW — a stale maximum falls back to what the ledger still supports', () => {
  it(`a fast row older than ${PREFILL_SAMPLE_WINDOW_DAYS} days stops counting on the next rescan`, () => {
    seedProvider();
    // The body: one very fast call from long ago (outside the window), and today's ordinary
    // round-5 call (inside it). The stored reading is deliberately set to the OLD, high number
    // with an OLD stamp — exactly the state a box is in the day its fast sample ages out.
    seedCostRow('old-fast', 200_000, 100_000, PREFILL_SAMPLE_WINDOW_DAYS + 5); // 2,000 tok/s, aged out
    seedCostRow('today', ROUND_5_INPUT_TOKENS, ROUND_5_LATENCY_MS, 0);
    mockDb.current!.prepare(`
      UPDATE providers SET measured_prefill_tokens_per_sec = 2000,
                           measured_prefill_at = datetime('now', '-30 days')
       WHERE id = 'local'
    `).run();

    // The next qualifying call finds the stamp stale and pays for the window rescan.
    recalibrateFromSample('local', { inputTokens: ROUND_5_INPUT_TOKENS, latencyMs: ROUND_5_LATENCY_MS });

    // It FELL — which is the whole reason the window and the stamp exist. A ratchet that could
    // only ever rise would carry a dead GPU's number forever.
    expect(Math.floor(reading().rate as number)).toBe(181);
  });

  it('a FRESH stamp defers the rescan, so the hot path costs one indexed row read', () => {
    seedProvider();
    seedCostRow('today', ROUND_5_INPUT_TOKENS, ROUND_5_LATENCY_MS, 0);
    // Reading established a moment ago and HIGHER than the window supports. Because the stamp
    // is fresh, this call must not rescan — it ratchets only, so the number does not move.
    mockDb.current!.prepare(`
      UPDATE providers SET measured_prefill_tokens_per_sec = 2000, measured_prefill_at = datetime('now')
       WHERE id = 'local'
    `).run();
    recalibrateFromSample('local', { inputTokens: ROUND_5_INPUT_TOKENS, latencyMs: ROUND_5_LATENCY_MS });
    expect(reading().rate).toBe(2000);
  });

  it('the rescan reads the ledger, not just the sample in hand', () => {
    seedProvider();
    // A fast call INSIDE the window that the caller is not holding. A rescan sees it; the
    // O(1) ratchet cannot. Stale stamp forces the rescan path.
    seedCostRow('fast-inside', 100_000, 200_000, 3); // 500 tok/s
    mockDb.current!.prepare(
      "UPDATE providers SET measured_prefill_at = datetime('now', '-30 days') WHERE id = 'local'",
    ).run();
    recalibrateFromSample('local', { inputTokens: ROUND_5_INPUT_TOKENS, latencyMs: ROUND_5_LATENCY_MS });
    expect(reading().rate).toBe(500);
  });

  it('a row with no latency is not a sample, however big its prompt', () => {
    seedProvider();
    seedCostRow('untimed', 500_000, null, 1);
    seedCostRow('timed', ROUND_5_INPUT_TOKENS, ROUND_5_LATENCY_MS, 1);
    mockDb.current!.prepare(
      "UPDATE providers SET measured_prefill_at = datetime('now', '-30 days') WHERE id = 'local'",
    ).run();
    recalibrateFromSample('local', { inputTokens: ROUND_5_INPUT_TOKENS, latencyMs: ROUND_5_LATENCY_MS });
    expect(Math.floor(reading().rate as number)).toBe(181);
  });
});
