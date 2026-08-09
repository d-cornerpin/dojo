// PHASE-6 T10 Step 1d — "WHAT IS COUNTED", ANSWERED ONCE.
//
// ── THE DEFECT, AND IT IS A UNIT MISMATCH, NOT AN UNDER-COUNT ──
//
// The unserved-wake drain logs a field called `humanAsksOpen` on three lines. The value it
// logged was `getWaitingHumanConversations(agentId).length` — CONVERSATIONS, deduped by
// `conversationKey(...)`. Fifteen open asks in one thread are `1`. The field name says asks;
// the value counted conversations.
//
// This is the first thing the `calm` property has ever measured. Every phase before PHASE-5
// recorded `calm = n/a`; PHASE-5's exit battery evaluated it for the first time and it FAILED
// — a drain cycle stamped `humanAsksOpen=0` while the spine held 15 open asks. Three
// disagreeing samples are on the record (0 vs 15, and an earlier 0 vs 11).
//
// ── AND THE SPINE-TRUE COUNT ALREADY EXISTED, UNWIRED ──
//
// `work/work-reaper.ts:humanAsksOpen(agentId)` — `SELECT count(*) FROM work WHERE kind='ask'
// AND state='open' AND agent_id=?`. No session bound, no join to `messages`, no lane filter,
// no JS authorization gate. Its own header says it "deliberately over-counts relative to
// `getWaitingHumanConversations`", and that over-counting is the ONLY direction of error the
// storm law is allowed to have: over-counting stands the self-wake DOWN more often, and the
// 2026-07-23 storm is what the other direction costs. It had ZERO non-test callers.
//
// ── THE DECISION, TAKEN ONCE (PHASE-6.md Step 1d: they are ONE decision, not three) ──
//
// **The SPINE is the authority.** `selfWakeStandDown(agentId)` — which returns the verdict
// AND the number it ruled on — is what the drain consults, and the number it returns is what
// rides the log lines. Two consequences, both deliberate:
//
//   1. The number stops disagreeing with its own field name. `humanAsksOpen` counts open
//      asks. That is what makes the you-come-first law measurable at all: a drain that
//      reports "0 people waiting" while fifteen wait cannot be judged by any battery.
//   2. The stand-down gets STRICTER, in the only direction the law allows. It now also
//      stands down when the spine is UNREADABLE (`-1`), which the conversation count could
//      not express — an unreadable spine used to read as "nobody is waiting, go ahead".
//
// ── AND `getWaitingHumanConversations` IS NOT RETIRED. POSITIVE EVIDENCE, NOT ABSENCE (#15) ──
//
// It answers a DIFFERENT question — WHICH conversations, with their keys and their oldest
// waiting message — and the tree needs that answer in five other places, enumerated by
// command below. A row count cannot serve a conversation. Retiring it would have been
// inferring death from a name collision.
//
// ── WHAT IS REFUSED IN ADVANCE, AND WAS NOT DONE ──
//
// Renaming the log field to match the wrong number, and changing any cap to make a scenario
// green. Neither happened: the field keeps its name, every bound in the drain is untouched,
// and `MAX_DRAIN_STUCK`/the wake ladder are not in this diff.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
// PHASE-6 GUARD-AUDIT: the engine corpus is derived ONCE, never by path.
import { engineText } from '../v2/__tests__/engine-sources.js';

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
    getDbPath: () => p.join(os.tmpdir(), 'dojo-what-is-counted-test', 'dojo.db'),
  };
});

import { runMigrations } from '../../db/migrations.js';
import { insertMessage } from '../../memory/message-store.js';
import { getWaitingHumanConversations } from '../v2/counterparty.js';
import { humanAsksOpen, selfWakeStandDown } from '../../work/work-reaper.js';

const AGENT = 'kevin';
const SRC = path.join(__dirname, '..', '..');
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), 'utf8');

/** A real person's message, as every channel producer hands it to the single writer. */
const ownerInbound = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  agentId: AGENT, role: 'user', content: 'can you check the roof quote?',
  lane: 'owner', channel: 'dashboard', senderId: 'owner', authorized: true,
  conversationId: 'conv-1',
  inboundMeta: JSON.stringify({ channel: 'dashboard', relation: 'owner' }),
  ...over,
});

beforeEach(() => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  mockDb.current = db;
  runMigrations();
  db.pragma('foreign_keys = ON');
  db.prepare(
    `INSERT INTO agents (id, name, status, session_started_at) VALUES (?, 'Kevin', 'idle', '1970-01-01')`,
  ).run(AGENT);
  db.prepare(
    `INSERT INTO conversations (id, agent_id, channel, counterparty_id)
     VALUES ('conv-1', ?, 'dashboard', 'owner'), ('conv-2', ?, 'imessage', '+15550000')`,
  ).run(AGENT, AGENT);
});

describe('T10 Step 1d — the two counters answer different questions, on real rows', () => {
  it('THE MISMATCH, reproduced: three open asks in ONE conversation are 3 asks and 1 conversation', () => {
    // This is the shape that produced `humanAsksOpen=0` against a spine holding fifteen: a
    // person sending three messages while the agent is busy. The battery's `calm` clause
    // reads the drain's number, and until this task the drain was reading the wrong one.
    for (const id of ['m-1', 'm-2', 'm-3']) insertMessage(ownerInbound({ id }) as never);
    expect(humanAsksOpen(AGENT), 'the spine holds three open asks').toBe(3);
    expect(getWaitingHumanConversations(AGENT).length, 'they are one conversation').toBe(1);
  });

  it('they agree when — and only when — each conversation holds exactly one ask', () => {
    // The agreement case is why the mismatch survived so long: on a quiet box the two
    // numbers are equal, and every sample anyone looked at was a quiet box.
    insertMessage(ownerInbound({ id: 'm-1' }) as never);
    insertMessage(ownerInbound({
      id: 'm-2', conversationId: 'conv-2', channel: 'imessage', senderId: '+15550000',
      inboundMeta: JSON.stringify({ channel: 'imessage', relation: 'owner' }),
    }) as never);
    expect(humanAsksOpen(AGENT)).toBe(2);
    expect(getWaitingHumanConversations(AGENT).length).toBe(2);
  });

  it('THE AUTHORITY over-counts, and that is the only direction of error the law allows', () => {
    for (const id of ['m-1', 'm-2', 'm-3']) insertMessage(ownerInbound({ id }) as never);
    const verdict = selfWakeStandDown(AGENT);
    expect(verdict.standDown).toBe(true);
    expect(verdict.humanAsksOpen).toBe(3);
    // Over-counting costs a delayed self-wake, which the periodic sweeps pick up.
    // Under-counting costs the 2026-07-23 storm.
    expect(verdict.humanAsksOpen).toBeGreaterThanOrEqual(getWaitingHumanConversations(AGENT).length);
  });

  it('an UNREADABLE spine stands the drain down — the conversation count could not say this', () => {
    mockDb.current!.exec('DROP TABLE work');
    const verdict = selfWakeStandDown(AGENT);
    // SWEEP CORE-2 item 5 added the tier breakdown to the verdict. It fails closed the same
    // way the number does — an unreadable spine invents no tier either.
    expect(verdict).toEqual({
      standDown: true, humanAsksOpen: -1,
      tiers: { mainUser: 0, safeSenders: 0, otherAgents: 0 },
    });
  });
});

describe('T10 Step 1d — the drain is wired to the authority', () => {
  const drain = (): string => read('agent/runtime.ts');

  it('the unserved-wake drain asks `selfWakeStandDown`, not the conversation count', () => {
    expect(drain()).toMatch(/const \{ standDown[^}]*\} = selfWakeStandDown\(agentId\)/);
    expect(drain()).toMatch(/from '\.\.\/work\/work-reaper\.js'/);
  });

  it('every one of the three log lines carries the SPINE number under its own name', () => {
    // The field name was never the defect; the value under it was. It keeps its name, and a
    // rename to match the wrong number is refused in advance by the plan.
    // The trailing comma used to separate the three LOG payloads from the one destructuring
    // (`{ standDown, humanAsksOpen: openAsks }`, which closed with `}`). SWEEP CORE-2 item 5
    // added `tiers` to the verdict, so the destructuring now ends in a comma too and is
    // excluded BY NAME instead — the discriminator stays exact rather than becoming a count
    // somebody has to remember to bump.
    const lines = drain().match(/humanAsksOpen: \w+,(?! tiers)/g) ?? [];
    expect(lines.length, 'three drain log lines carry the count').toBe(3);
    for (const l of lines) expect(l).toBe('humanAsksOpen: openAsks,');
  });

  it('the OLD wiring is gone from the drain — the conversation count no longer decides it', () => {
    const code = drain()
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
    expect(code).not.toMatch(/const waitingHumans = getWaitingHumanConversations\(agentId\)\.length/);
    // POSITIVE CONTROL: the stripper did not blank the drain.
    expect(code).toMatch(/unserved_wake/);
  });
});

describe('T10 Step 1d — `getWaitingHumanConversations` survives on POSITIVE evidence (#15)', () => {
  it('it has live production callers doing a job a row count cannot do', () => {
    // Command, unit CALL SITES:
    //   git grep -n "getWaitingHumanConversations(" HEAD -- packages/server/src | grep -v __tests__
    // Five production sites remain, and each needs the CONVERSATIONS — their keys, their
    // oldest waiting message, their order — not a number.
    const callers: Array<[string, RegExp]> = [
      ['agent/runtime.ts', /const waiting = getWaitingHumanConversations\(agentId\)/],
      ['index.ts', /getWaitingHumanConversations\(id\)\.length > 0/],
    ];
    for (const [file, re] of callers) {
      expect(read(file), `${file} no longer calls it`).toMatch(re);
    }
    // The engine's own caller (`steps/preflight/turn-trigger.ts`) is read through the SHARED
    // CORPUS, never by path — the guard-corpus census refused the by-path version and was
    // right: this phase is still moving code between the driver and the step packages, and a
    // clause naming one of them stops seeing its subject at the next cut.
    expect(engineText()).toMatch(/getWaitingHumanConversations\(agentId\)/);
  });

  it('the human-conversation drain still needs the HEAD, which a count cannot give it', () => {
    // The clinching piece of positive evidence: the other drain quarantines a poisoned
    // conversation BY KEY after MAX_DRAIN_STUCK failed serves. There is no key in a count.
    const rt = read('agent/runtime.ts');
    expect(rt).toMatch(/waiting\[0\]\.oldestWaitingRowid/);
    expect(rt).toMatch(/quarantineWaitingConversation\(agentId, poisoned\.key\)/);
  });
});
