// ════════════════════════════════════════
// t204: the cost-measure report attributes a call's REAL input tokens to the lane that
// supplied them, using only what the platform already records (the context receipt and the
// cost row). This file pins the arithmetic of that attribution; the CLI is exercised by hand
// against a database and is not run here.
//
// RED on the base: the module (`scripts/cost-measure.mjs`) does not exist, so the import fails.
// ════════════════════════════════════════

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULE = path.resolve(HERE, '../../../../../../scripts/cost-measure.mjs');

// A dynamic import by variable path: the script is plain ESM with no type declarations.
type Mod = {
  attributeCall: (receipt: unknown, cost: unknown, opts?: unknown) => AttributedCall;
  matchReceiptsToCosts: (receipts: unknown[], costs: unknown[], opts?: unknown) => Array<{ receipt: any; cost: any }>;
  rollupByDay: (costs: unknown[]) => Array<{ day: string; calls: number; costUsd: number; hitRatio: number }>;
  summarizeLanes: (calls: AttributedCall[]) => Array<{ id: string; meanTokens: number; meanMissTokens: number; share: number }>;
};
type AttributedCall = {
  ok: boolean;
  reason?: string;
  totalTokens: number;
  missTokens: number;
  hitTokens: number;
  costUsd: number;
  lanes: Array<{ id: string; group: string; chars: number; tokens: number; missTokens: number; costUsd: number }>;
};
async function load(): Promise<Mod> {
  return (await import(/* @vite-ignore */ MODULE)) as Mod;
}

// 100,000 request chars at 4 chars/token = 25,000 real tokens.
const receipt = {
  at: '2026-10-01T10:00:00.000Z',
  turnNumber: 5,
  loopCount: 2,
  systemPrompt: {
    chars: 20_000,
    parts: [
      { entryId: 'sys.identity', chars: 5_000 },
      { entryId: 'sys.tools', chars: 15_000 },
    ],
  },
  assembly: {
    lanes: [
      { id: 'lane.vault', slot: 200, granted: 100, status: 'admitted' },
      { id: 'lane.summaries', slot: 300, granted: 300, status: 'admitted' },
      { id: 'lane.fresh-tail', slot: 1100, granted: 9_999, status: 'admitted' },
      { id: 'lane.active-tasks', slot: 1820, granted: 3_980, status: 'admitted' },
    ],
  },
  messages: {
    chars: 50_000,
    volatileFrom: 3,
    items: [
      { role: 'user', kind: 'text', entryId: 'lane.vault', chars: 4_000 },
      { role: 'assistant', kind: 'blocks', entryId: 'lane.scaffolding-ack', chars: 0, textChars: 100 },
      { role: 'user', kind: 'blocks', entryId: 'lane.fresh-tail', textChars: 500 },
      { role: 'user', kind: 'text', entryId: 'msg.active-tasks', chars: 1_000 },
      { role: 'user', kind: 'text', entryId: 'msg.current-time', chars: 400 },
    ],
  },
};
// tools + framing residual = 100,000 - 20,000 - 50,000 = 30,000 chars.
const cost = {
  created_at: '2026-10-01 10:00:03',
  latency_ms: 2_000,
  input_tokens: 5_000, // the uncached (miss) part
  cache_read_tokens: 20_000, // the cache-hit part
  output_tokens: 100,
  cost_usd: 0,
  estimated_input_tokens: 40_000,
  estimator_chars_per_token: 2.5, // 40,000 x 2.5 = 100,000 request chars
  model_id: 'm',
};
const opts = { pricePerMIn: 1, pricePerMOut: 2, hitPriceFactor: 0.1 };

describe('t204 cost-measure: attributing one call', () => {
  it('splits the real total across the lanes with nothing lost and nothing invented', async () => {
    const { attributeCall } = await load();
    const a = attributeCall(receipt, cost, opts);
    expect(a.ok).toBe(true);
    expect(a.totalTokens).toBe(25_000);
    const sum = a.lanes.reduce((s, l) => s + l.tokens, 0);
    expect(Math.round(sum)).toBe(25_000);
    const byId = Object.fromEntries(a.lanes.map((l) => [l.id, l]));
    // 30,000 residual chars at 0.25 tokens/char.
    expect(Math.round(byId['tools'].tokens)).toBe(7_500);
    expect(Math.round(byId['sys.tools'].tokens)).toBe(3_750);
    // the tail is whatever the messages hold that no itemised lane accounts for
    // (50,000 - 4,000 - 100 - 500 - 1,000 - 400 = 44,000 chars).
    expect(Math.round(byId['lane.fresh-tail'].tokens)).toBe(11_000 + 125);
  });

  it('splits the merged vault+summaries message by what each lane was granted', async () => {
    const { attributeCall } = await load();
    const byId = Object.fromEntries(attributeCall(receipt, cost, opts).lanes.map((l) => [l.id, l]));
    expect(byId['lane.summaries'].chars).toBeCloseTo(3_000, 0);
    expect(byId['lane.vault'].chars).toBeCloseTo(1_000, 0);
  });

  it('bills the miss from the END of the request backwards: the suffix is what missed', async () => {
    const { attributeCall } = await load();
    const a = attributeCall(receipt, cost, opts);
    expect(a.missTokens).toBe(5_000);
    expect(a.hitTokens).toBe(20_000);
    const miss = a.lanes.reduce((s, l) => s + l.missTokens, 0);
    expect(Math.round(miss)).toBe(5_000);
    const byId = Object.fromEntries(a.lanes.map((l) => [l.id, l]));
    // the last lanes are fully missed; the system prefix and tool definitions are fully hit.
    expect(byId['msg.current-time'].missTokens).toBeCloseTo(byId['msg.current-time'].tokens, 5);
    expect(byId['msg.active-tasks'].missTokens).toBeCloseTo(byId['msg.active-tasks'].tokens, 5);
    expect(byId['tools'].missTokens).toBe(0);
    expect(byId['sys.identity'].missTokens).toBe(0);
  });

  it('prices hits at the cache factor and the sum of lane costs equals the call input cost', async () => {
    const { attributeCall } = await load();
    const a = attributeCall(receipt, cost, opts);
    const inputCost = (5_000 * 1 + 20_000 * 0.1) / 1e6;
    const laneCost = a.lanes.reduce((s, l) => s + l.costUsd, 0);
    expect(laneCost).toBeCloseTo(inputCost, 10);
    expect(a.costUsd).toBeCloseTo(inputCost + (100 * 2) / 1e6, 10);
  });

  it('refuses a pairing whose parts exceed the request instead of reporting a negative tool head', async () => {
    const { attributeCall } = await load();
    const a = attributeCall(receipt, { ...cost, estimated_input_tokens: 10_000 }, opts);
    expect(a.ok).toBe(false);
    expect(a.reason).toMatch(/exceed/);
  });
});

describe('t204 cost-measure: joining receipts to cost rows', () => {
  const mk = (at: string) => ({ at, turnNumber: 1, loopCount: 1 });
  it('pairs each receipt with the cost row that ended after it began, once each', async () => {
    const { matchReceiptsToCosts } = await load();
    const receipts = [mk('2026-10-01T10:00:00.000Z'), mk('2026-10-01T10:00:10.000Z')];
    const costs = [
      { created_at: '2026-10-01 10:00:03', latency_ms: 2_500 },
      { created_at: '2026-10-01 10:00:14', latency_ms: 3_500 },
      { created_at: '2026-10-01 10:05:00', latency_ms: 100 }, // belongs to no receipt
    ];
    const pairs = matchReceiptsToCosts(receipts, costs);
    expect(pairs).toHaveLength(2);
    expect(pairs[0].cost).toBe(costs[0]);
    expect(pairs[1].cost).toBe(costs[1]);
  });
});

describe('t204 cost-measure: the per-day roll-up', () => {
  it('counts calls, hit ratio and cost per UTC day', async () => {
    const { rollupByDay } = await load();
    const days = rollupByDay([
      { created_at: '2026-10-01 01:00:00', input_tokens: 100, cache_read_tokens: 300, cost_usd: 0.5, call_purpose: 'agent_turn' },
      { created_at: '2026-10-01 23:59:59', input_tokens: 100, cache_read_tokens: 100, cost_usd: 0.25, call_purpose: 'ask_title' },
      { created_at: '2026-10-02 00:00:00', input_tokens: 50, cache_read_tokens: 0, cost_usd: 1, call_purpose: 'agent_turn' },
    ]);
    expect(days).toHaveLength(2);
    expect(days[0]).toMatchObject({ day: '2026-10-01', calls: 2, costUsd: 0.75 });
    expect(days[0].hitRatio).toBeCloseTo(400 / 600, 6);
    expect(days[1]).toMatchObject({ day: '2026-10-02', calls: 1, costUsd: 1 });
  });
});
