// v3.5 C2/C3 fix round 1 — A SHADOW ASK IS INVISIBLE TO THE AGENT, AND ASKED ONCE PER SUBJECT.
//
//  1. A background (shadow) ask carries no agent into `decide()`, so an idle agent never looks live (no turn-scoped
//     abortable, `agentIsLive` false) and an urgent wake never "preempts" a call that is not its own.
//  2. One row per question per SUBJECT (the turn's trigger message, the inbound message, the vault entry's text…): an
//     assemble loop that re-asks the same subject adds no row and no request; a second look at it (a new context object,
//     a continuation) does the same, because the join key is the stable subject, never a random id.
//  3. A filler pass resolves its mode once, not per message, and a continuation never re-dials texts already asked.
// The decision model is never real: a provider row and a scripted fetch.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn(), stampPersistedRow: (e: unknown) => e }));
vi.mock('../decision-policy.js', async (orig) => {
  const actual = await orig<typeof import('../decision-policy.js')>();
  return { ...actual, modeFor: vi.fn(actual.modeFor) };
});

import { runMigrations } from '../../db/migrations.js';
import { decisionAsksSettled } from '../decision-ask.js';
import { modeFor } from '../decision-policy.js';
import { countAbortable } from '../shared-state.js';
import { agentIsLive } from '../../tracker/liveness.js';
import { courtesyJudged, isConversational, delegatesJudged, detectMultistepJudged, INBOUND_ROUTING_PURPOSE } from '../v2/classifiers/inbound-routing.js';
import { beginFillerPass, isFiller } from '../../vault/filler.js';
import { settleFiller, MEMORY_SHAPE_PURPOSE } from '../../memory/shape-judgment.js';
import { installDecisionModel, scriptDecisions, yes } from './decision-fake.js';

const db = (): Database.Database => mockDb.current!;
const rows = (purpose: string): Array<{ question: string; turn_id: string }> =>
  db().prepare('SELECT question, turn_id FROM decision_shadow WHERE purpose = ? ORDER BY id').all(purpose) as never;

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  installDecisionModel(db());
  vi.mocked(modeFor).mockClear();
});
afterEach(async () => { await decisionAsksSettled(); vi.unstubAllGlobals(); mockDb.current?.close(); mockDb.current = null; });

describe('1. a shadow ask leaves the asking agent exactly as idle as it was', () => {
  it('while the ask is in flight: no turn-scoped abortable, the agent is not live', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/api/ps')) return Response.json({ models: [] });
      await gate;
      return Response.json({ answers: { pleasantry: { noul: 0.9 } }, usage: { input_tokens: 10 } });
    }));
    const idle = 'idle-primary';
    try {
      expect(agentIsLive(idle)).toBe(false);
      const verdict = courtesyJudged(idle, 'msg-9', 'see you at the offsite');
      expect(await verdict).toBe(false);                                   // the rule's answer, at once
      await new Promise((r) => setTimeout(r, 80));                          // the background ask is now on the wire
      expect(vi.mocked(fetch).mock.calls.some(([u]) => String(u).endsWith('/v1/systemone'))).toBe(true);
      expect(countAbortable(idle, 'turn')).toBe(0);
      expect(countAbortable(idle)).toBe(0);
      expect(agentIsLive(idle)).toBe(false);
    } finally { release(); }
    await decisionAsksSettled();
    expect(countAbortable(idle)).toBe(0);
  });
});

describe('2. one row per question per subject, joined on the subject\'s own id', () => {
  const turn = (id: string) => ({ root: { kind: 'ask', id: `root-${id}`, sourceMessageId: id } });

  it('five assemble loops of one turn: one request, one row per question, keyed by the trigger message', async () => {
    const calls = scriptDecisions(() => yes(0.4));
    const ctx = turn('msg-77');
    for (let loop = 0; loop < 5; loop++) {
      await isConversational(ctx, 'a1', 'hey there');
      await delegatesJudged(ctx, 'a1', 'hey there', false);
      await detectMultistepJudged(ctx, 'what is the biggest file in my fixtures folder? just curious', 'a1');
    }
    await decisionAsksSettled();
    expect(calls).toHaveLength(1);
    const r = rows(INBOUND_ROUTING_PURPOSE);
    expect(r.map((x) => x.question).sort()).toEqual(['delegates', 'multi_step', 'simple_chat']);
    for (const x of r) expect(x.turn_id).toContain('msg-77');
  });

  it('the same subject seen again through a NEW context object (a retry, a continuation) adds no row and no request', async () => {
    const calls = scriptDecisions(() => yes(0.4));
    await isConversational(turn('msg-78'), 'a1', 'hey there');
    await decisionAsksSettled();
    await isConversational(turn('msg-78'), 'a1', 'hey there');
    await decisionAsksSettled();
    expect(calls).toHaveLength(1);
    expect(rows(INBOUND_ROUTING_PURPOSE)).toHaveLength(1);
    await isConversational(turn('msg-79'), 'a1', 'hey there');                 // a different subject is asked
    await decisionAsksSettled();
    expect(calls).toHaveLength(2);
  });
});

describe('3. the filler pass resolves its mode once and never re-dials a text it has asked', () => {
  const texts = Array.from({ length: 200 }, (_, i) => `note number ${i}`);
  const pass = async (): Promise<void> => { beginFillerPass(); for (const t of texts) isFiller(t); await settleFiller('dreamer'); await decisionAsksSettled(); };

  it('200 texts: the mode is looked up once, not 200 times; a second pass asks nothing and adds no row', async () => {
    const calls = scriptDecisions(() => yes(0.3));
    await pass();
    const fillerLookups = vi.mocked(modeFor).mock.calls.filter(([p, q]) => p === MEMORY_SHAPE_PURPOSE && q === 'filler').length;
    expect(fillerLookups).toBe(1);
    const asked = calls.length;
    expect(asked).toBeGreaterThan(0);
    expect(rows(MEMORY_SHAPE_PURPOSE)).toHaveLength(200);
    await pass();
    expect(calls).toHaveLength(asked);
    expect(rows(MEMORY_SHAPE_PURPOSE)).toHaveLength(200);
  });

  it('in rule mode (no decision model) the pass asks nothing and looks nothing up per message', async () => {
    db().prepare('DELETE FROM models').run();
    const calls = scriptDecisions(() => yes(0.3));
    await pass();
    expect(calls).toHaveLength(0);
  });
});
