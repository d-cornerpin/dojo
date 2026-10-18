// ════════════════════════════════════════════════════════════════════════════════════════
// t194 (v3.4 D1) — THE GAUGE MEASURES THE VIEW, AND A SMALL WINDOW CONDENSES AND PROCEEDS.
//
// THE WITNESS (a worker agent on a 65K window, the owner's box): "Compressible context impossibly
// full at 99–103%. Surrendering turn", three times in a day, plus an emergency compaction, and the
// "memory is getting full" toast every few minutes. The gate measured a number the model is never
// sent: summaries counted up to 70% of the room (the real summaries lane is capped far lower), and
// the live tail read BEFORE the assembler's token trim. And the protected recent part was 40 ROWS,
// so forty large tool results were more than the window and nothing inside them could be folded:
// the pressure pass found "nothing outside the floor", the brake armed, the next gate blocked again.
//
// OWNER DECISION 7 (2026-10-17): (a) the gauge measures exactly what the agent sees; (b) the
// protected recent part is sized by tokens, not 40 rows; (c) the stale warning goes.
//
// THE DOOR: `runPreCallGates`, exactly as the driver calls it, on a REAL migrated database with the
// real assembler, the real tail horizon and the real leaf compaction. Mocked: the summariser's model
// call, the vault archive (a file write), the websocket, and the tools payload size.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WsEvent } from '@dojo/shared';

const mockDb: { current: Database.Database | null } = { current: null };

vi.mock('../../../../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
  getDbPath: () => ':memory:',
}));

const wsEvents: WsEvent[] = [];
vi.mock('../../../../../gateway/ws.js', () => ({
  broadcast: (e: WsEvent) => { wsEvents.push(e); },
  stampPersistedRow: (e: unknown) => e,
}));

vi.mock('../../../../../tools/tool-docs.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  measureAgentToolPayloadTokens: async () => 8_000,
}));

const generateSummarySpy = vi.fn();
vi.mock('../../../../../memory/summarize.js', () => ({
  generateSummary: (...args: unknown[]) => generateSummarySpy(...args),
}));

vi.mock('../../../../../vault/archive.js', () => ({
  archiveMessagesBeforeCompaction: vi.fn(() => 'archive-1'),
  isDreamerIgnored: vi.fn(() => false),
  getArchiveHighWaterMark: vi.fn(() => null),
}));

vi.mock('../../../../../config/platform.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isSystemServiceAgent: vi.fn(() => false),
}));

import { runMigrations } from '../../../../../db/migrations.js';
import { insertMessage } from '../../../../../memory/message-store.js';
import { assembleContext } from '../../../../../memory/assembler.js';
import { assembleWithNothingOutOfViewUnsummarised } from '../../../../../memory/out-of-view-fold.js';
import { estimateAssembledTokens, checkAndCompact } from '../../../../../memory/compaction.js';
import { backgroundDrains, pendingWakeups, stoppedAgents, turnContinuationCounts } from '../../../../shared-state.js';
import { __resetBrakesForTests } from '../../../../../memory/compaction-brakes.js';
import { __resetEstimateCacheForTests } from '../../../../../memory/assembled-estimate-cache.js';
import { advance, initState, type AgentTurnState } from '../../../state.js';
import { runPreCallGates, PRE_CALL_GATES_PHASE, type PreCallGatesContext } from '../index.js';
import type { TurnCounterparty } from '../../../counterparty.js';

const AGENT = 'agent-t194-small-window';
const MODEL = 'm-t194-65k';
const WINDOW = 65_536;

const db = (): Database.Database => mockDb.current!;

function seedAgent(): void {
  db().prepare(`INSERT INTO providers (id, name, type, auth_type) VALUES ('p-t194', 'P', 'openai-compatible', 'api_key')`).run();
  db().prepare(
    `INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, is_enabled)
     VALUES (?, 'p-t194', 'Small', 'small', '["text","tools"]', ?, 4096, 1)`,
  ).run(MODEL, WINDOW);
  db().prepare(
    `INSERT INTO agents (id, name, model_id, status, config, created_at) VALUES (?, 'Worker Desk', ?, 'idle', '{}', datetime('now'))`,
  ).run(AGENT, MODEL);
}

/** A long, varied tool result: about 16K tokens stored, which the view caps near 15K. */
function bigResult(i: number): string {
  const line = (n: number) => `line ${n} of report ${i}: figures ${n * 7} and ${n * 13}, status nominal, notes follow.\n`;
  let s = '';
  for (let n = 0; s.length < 64_000; n++) s += line(n);
  return s;
}

/** The owner's ask, then `groups` file reads, each a tool call and its large result. */
function seedLargeToolWork(groups: number): void {
  insertMessage({ agentId: AGENT, role: 'user', lane: 'owner', senderId: 'owner', content: 'Read every report and summarise the totals.', turnNumber: 1 });
  for (let i = 0; i < groups; i++) {
    insertMessage({
      agentId: AGENT, role: 'assistant', lane: 'owner', turnNumber: 1,
      content: JSON.stringify([{ type: 'tool_use', id: `call-${i}`, name: 'file_read', input: { path: `report-${i}.txt` } }]),
    });
    insertMessage({
      agentId: AGENT, role: 'tool', lane: 'owner', turnNumber: 1,
      content: JSON.stringify([{ type: 'tool_result', tool_use_id: `call-${i}`, content: bigResult(i) }]),
    });
  }
}

/** Summaries already standing for older history: `n` of them, `tokens` each. */
function seedSummaries(n: number, tokens: number): void {
  for (let i = 0; i < n; i++) {
    db().prepare(
      `INSERT INTO summaries (id, agent_id, depth, kind, content, token_count, descendant_count, earliest_at, latest_at, created_at)
       VALUES (?, ?, 0, 'leaf', ?, ?, 1, '2026-10-01 09:00:00', '2026-10-01 10:00:00', '2026-10-01 10:00:00')`,
    ).run(`sum-${i}`, AGENT, `Summary ${i}: ` + 'earlier work recorded. '.repeat(Math.floor(tokens / 5)), tokens);
    db().prepare(`INSERT INTO context_items (agent_id, item_type, item_id, ordinal) VALUES (?, 'summary', ?, ?)`).run(AGENT, `sum-${i}`, i);
  }
}

const OWNER: TurnCounterparty = { kind: 'user', displayName: 'TestUser', id: 'owner' } as TurnCounterparty;

function freshState(): AgentTurnState {
  const s = initState({
    agentId: AGENT, contextWindow: WINDOW, isAutoRouted: false, configuredModelId: MODEL,
    turnNumber: 7, triggeredByIMessage: false, triggeredByA2AReplyIntent: null,
    lastUserMessageContent: 'Read every report and summarise the totals.', lastUserMessageId: null,
    inboundChannel: 'dashboard', inboundContext: null, pendingTechniqueAck: null,
  });
  return advance(s, { phase: PRE_CALL_GATES_PHASE, loopCount: 2 });
}

function makeCtx(events: WsEvent[]): PreCallGatesContext {
  return {
    agentId: AGENT, turnNumber: 7, contextWindow: WINDOW, contextModelId: MODEL,
    configuredModelId: MODEL, isAutoRouted: false, counterparty: OWNER,
    // A realistic overhead from the last assembly: the system prompt plus the tools/output reserve.
    engineBlockEscapeHatch: '[escape hatch]',
    broadcast: (event: WsEvent) => { events.push(event); },
    stashContinuationIfHuman: vi.fn(),
    detectTaskThrashing: vi.fn(() => ({ thrashing: false })),
  } as unknown as PreCallGatesContext;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 400; i++) {
    await new Promise((r) => setTimeout(r, 5));
    if (!backgroundDrains.has(AGENT)) return;
  }
  throw new Error('a background condense never settled');
}

function summarisedSeqs(): number[] {
  return (db().prepare(
    `SELECT m.seq AS seq FROM messages m JOIN summary_messages sm ON sm.message_id = m.id WHERE m.agent_id = ? ORDER BY m.seq`,
  ).all(AGENT) as Array<{ seq: number }>).map((r) => r.seq);
}
function allSeqs(): number[] {
  return (db().prepare('SELECT seq FROM messages WHERE agent_id = ? ORDER BY seq').all(AGENT) as Array<{ seq: number }>).map((r) => r.seq);
}

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  backgroundDrains.clear(); pendingWakeups.clear(); stoppedAgents.clear(); turnContinuationCounts.clear();
  __resetBrakesForTests();
  __resetEstimateCacheForTests();
  wsEvents.length = 0;
  generateSummarySpy.mockReset();
  generateSummarySpy.mockImplementation(async () => ({ ok: true, text: 'Earlier reports read; totals noted.', tokenCount: 12 }));
  seedAgent();
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

describe('t194 D1 — a 65K worker whose newest 40 rows are large tool results', () => {
  it('RED on v3.3.3: the gate surrenders ("impossibly full"); now it proceeds, condenses what the view cannot hold, and shows no toast', async () => {
    seedLargeToolWork(20);   // 41 rows: the ask plus 20 call/result groups, about 300K tokens of results
    const events: WsEvent[] = [];
    const out = await runPreCallGates(freshState(), makeCtx(events));
    expect((out as { reason?: string }).reason, 'the turn is not surrendered').toBeUndefined();
    expect(out.directive).toBe('proceed');
    await settle();
    // The turn goes on to its assembly through the engine's door, which folds what the trim takes.
    const sent = await assembleWithNothingOutOfViewUnsummarised(AGENT, WINDOW, () => assembleContext(AGENT, MODEL));

    const seqs = allSeqs();
    const folded = summarisedSeqs();
    expect(folded.length, 'the rows the view cannot hold are condensed').toBeGreaterThan(0);
    // The newest call and its result are what the agent is reading now: never folded, and in view.
    expect(folded).not.toContain(seqs[seqs.length - 1]);
    expect(folded).not.toContain(seqs[seqs.length - 2]);
    expect(JSON.stringify(sent.messages)).toContain('call-19');
    expect(JSON.stringify(sent.messages)).toContain('report 19');
    const toasts = [...events, ...wsEvents].filter((e) => (e as { code?: string }).code === 'CONTEXT_HIGH');
    expect(toasts, 'a full view is routine: no "memory is getting full" toast').toEqual([]);
  });

  it('RED on v3.3.3: a forced pass folds outside a TOKEN floor (the newest 40 rows are no longer untouchable)', async () => {
    seedLargeToolWork(20);
    const result = await checkAndCompact(AGENT, MODEL, WINDOW, { force: true });
    expect(result.leafCreated, 'the pressure pass found rows it could fold').toBeGreaterThan(0);
    const seqs = allSeqs();
    const folded = summarisedSeqs();
    expect(folded).not.toContain(seqs[seqs.length - 1]);
    expect(folded).not.toContain(seqs[seqs.length - 2]);
  });
});

describe('t194 D1 — the gauge is the assembler\'s own fit, not a second model of it', () => {
  it('RED on v3.3.3: the summaries and the live tail it reports are exactly what a real assembly admits', async () => {
    seedSummaries(24, 1_600);   // about 38K tokens of summaries: far more than the summaries lane admits
    seedLargeToolWork(6);
    const gauge = await estimateAssembledTokens(AGENT, WINDOW, MODEL);
    const real = await assembleContext(AGENT, MODEL);

    const sent = JSON.stringify(real.messages);
    const admittedSummaries = (db().prepare('SELECT id, token_count AS t FROM summaries WHERE agent_id = ?').all(AGENT) as Array<{ id: string; t: number }>)
      .filter((s) => sent.includes(`Summary ${s.id.slice(4)}: `))
      .reduce((n, s) => n + s.t, 0);
    expect(gauge.summaryTokens, 'summaries counted are the summaries sent').toBe(admittedSummaries);

    const tailGrant = real.allocation?.grants.find((g) => g.id === 'lane.fresh-tail');
    expect(gauge.freshTailTokens, 'the live tail counted is the tail the trim kept').toBe(tailGrant?.granted);
  });
});

// ── THE CENSUS: the old mechanisms are gone, not bypassed ────────────────────────────────
describe('t194 D1 — census: one gauge, no surrender ladder, no stale warning, no row floor', () => {
  const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');   // packages/server/src
  const shipped = (): Array<{ file: string; text: string }> => {
    const out: Array<{ file: string; text: string }> = [];
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== '__tests__') walk(p); }
        // CODE only: a STRIP note naming what it deleted is the record, not the mechanism.
        else if (/\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name)) {
          out.push({ file: path.relative(SRC, p), text: fs.readFileSync(p, 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n') });
        }
      }
    };
    walk(SRC);
    return out;
  };

  it('the gate classifier and its 0.90 / 0.99 lines, the per-row gate cap and the private estimate model are deleted', () => {
    expect(fs.existsSync(path.join(SRC, 'agent/v2/classifiers/compaction.ts'))).toBe(false);
    const hits = shipped().filter((f) => /CONTEXT_WARN_THRESHOLD|CONTEXT_BLOCK_THRESHOLD|GATE_MESSAGE_CAP_TOKENS|gateMessageCap|liveViewIsFull|compactionGate\b|ceilingModelId/.test(f.text)).map((f) => f.file);
    expect(hits).toEqual([]);
  });

  it('no shipped line tells the owner the memory is "getting full", or calls a full view something that "should not happen"', () => {
    const hits = shipped().filter((f) => /Agent's memory is getting full|should not happen in normal/.test(f.text)).map((f) => f.file);
    expect(hits).toEqual([]);
  });

  it('the context gate never ends a turn', () => {
    const gate = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'context-gates.ts'), 'utf8');
    expect(gate).not.toMatch(/requestExit\(|parkAfterForcedPass|context-full|context-emergency-compact/);
  });

  it('compaction folds before the TOKEN floor: no production fold is bounded by the row ladder', () => {
    const compaction = fs.readFileSync(path.join(SRC, 'memory/compaction.ts'), 'utf8');
    expect(compaction).not.toMatch(/getMessagesOutsideFreshTail\(agentId, getFreshTailCount/);
    const calls = compaction.split('runLeafCompaction(agentId, writer').slice(1);
    expect(calls.length, 'non-vacuity: both production folds are found').toBe(2);
    for (const c of calls) expect(c.slice(0, 220)).toMatch(/floorRows/);
  });
});
