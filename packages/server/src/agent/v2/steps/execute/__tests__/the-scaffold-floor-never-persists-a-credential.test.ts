// ════════════════════════════════════════════════════════════════════════════════════════
// t118 — THE ENGINE FLOOR STOPS PUTTING A HANDED CREDENTIAL AT REST IN THE WORK SPINE.
//
// THE DEFECT, AS A RANDOM DRAW FOUND IT. A turn handed the agent a credential, then made
// enough untracked work calls to cross `TRACKER_AUTO_SCAFFOLD_AT` (6). The floor captured
// `state.lastUserMessageContent` RAW and derived four surfaces from it — the row's
// `description` (a `.slice(0, 2000)` persisted in an unencrypted column), the row's `title`
// (broadcast to the dashboard and handed to the PM), the engine note, and the PM rename
// handoff (which ships the prompt across a model boundary). The sweep found the owner's
// credential in plaintext in `work.description`, while every credential subsystem behaved
// exactly as designed: zero plaintext `agent_credentials` rows, zero `vault_entries`, no
// message carrying it. The leak was into the WORK SPINE.
//
// WHY THIS CLAUSE DRIVES THE FLOOR AND NOT `openTrackerTask`. `redactHandedCredentials` has
// sat ONE IMPORT AWAY from the leaking line since 2026-05-08 — five months — and nothing
// noticed, because nothing ever drove the floor with a registered credential in the
// triggering message. A clause that called `openTrackerTask` directly with a pre-redacted
// string would have passed on the defect every day of those five months. So this file builds
// a real turn, lets `countTrackerWorkThisIteration` count six real work calls, and lets
// `runTrackerFloors` decide to scaffold on its own. The floor's own branch is the thing under
// test; the row is read back out of the database afterwards.
//
// FIXTURE DISCIPLINE (G1). Every credential below is a FICTIONAL credential-shaped string
// invented for this file. The pinned scenario's real value is NOT reproduced here, in any
// form — the pin stays in the kit and is replayed there.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import { v4 as uuidv4 } from 'uuid';

const mockDb: { current: Database.Database | null } = { current: null };

vi.mock('../../../../../db/connection.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-t118-scaffold-test', 'dojo.db'),
  };
});

// The broadcast is a SURFACE under test, not a stub to be ignored: the floor's title and the
// PM rename request both go out on it, so every payload is captured and swept below.
const broadcasts: unknown[] = [];
vi.mock('../../../../../gateway/ws.js', () => ({
  broadcast: (e: unknown) => { broadcasts.push(e); },
}));

// The PM rename handoff USED TO wake a real runtime with the raw prompt (one of the four
// surfaces this file covered). t139 deleted it; the wake stays stubbed and CAPTURED so a revived
// handoff is caught here (`pmWakes` must stay empty) instead of reaching a real runtime.
const pmWakes: string[] = [];
vi.mock('../../../../runtime.js', () => ({
  getAgentRuntime: () => ({
    handleMessage: async (_id: string, text: string) => { pmWakes.push(text); },
  }),
}));

import { runMigrations } from '../../../../../db/migrations.js';
import { openTurnContext, endTurnContext, type TurnContext } from '../../../../turn-context.js';
import { untrackedWorkAcrossTurns } from '../../../../turn-state.js';
import {
  noteHandedCredentialValues, forgetHandedCredentialValues,
} from '../../../../../credentials/secret-values.js';
import { initState, type AgentTurnState } from '../../../state.js';
import { nextSteer } from '../../../steer-queue.js';
import type { TurnCounterparty } from '../../../counterparty.js';
import { countTrackerWorkThisIteration } from '../tracker-counting.js';
import { runTrackerFloors, SCAFFOLD_TITLE } from '../tracker-floors.js';
import type { ExecuteContext } from '../index.js';

const AGENT = 'agent-t118';
const CONV = 'human:owner';
const CONVERSATION_ID = 'conv-t118-0001';

// ── THE FICTIONAL CREDENTIALS (G1) ──
// Credential-SHAPED so the redactor's length gate (>= 6 chars) is cleared and so a reader can
// see what class of string this stands for. Invented here; they exist nowhere else.
const FAKE_KEY = 'sk-live-t118-ZqPr4m8VdK2hLw9BxT6n';
const FAKE_SECOND = 'whsec-t118-7Yh3Nf0QaE5sJu1Rm';

const db = (): Database.Database => mockDb.current!;

const USER: TurnCounterparty = {
  kind: 'user', name: 'Owner', relation: 'owner', channel: 'dashboard',
  senderId: 'owner', threadId: null, senderIsAgent: false,
};

/** A model response carrying `n` REAL (non-tracker, non-trivial) work calls. */
const workCalls = (n: number): { toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> } => ({
  toolCalls: Array.from({ length: n }, (_, i) => ({
    id: `tc-${uuidv4()}`, name: 'write_file', arguments: { path: `/tmp/f${i}.txt`, content: 'x' },
  })),
});

function freshState(turnNumber: number, prompt: string | null): AgentTurnState {
  return initState({
    agentId: AGENT, contextWindow: 100_000, isAutoRouted: false,
    configuredModelId: 'floor-model', turnNumber, triggeredByIMessage: false,
    triggeredByA2AReplyIntent: null, lastUserMessageContent: prompt,
    lastUserMessageId: prompt ? `msg-${turnNumber}` : null,
    inboundChannel: 'dashboard', inboundContext: null, pendingTechniqueAck: null,
  });
}

function executeCtx(
  turnCtx: TurnContext, turnNumber: number, result: ReturnType<typeof workCalls>,
): ExecuteContext {
  return {
    agentId: AGENT, turnCtx, turnNumber, db: db(),
    agent: { name: 'Agent' }, counterparty: USER, counterpartyIsAgentSender: false,
    chosenConvKey: turnCtx.convKey ?? null, hasUnansweredUser: false,
    triggerRow: null, triggerWorkId: null, triggerConversationId: CONVERSATION_ID,
    turnStartedAt: new Date().toISOString(), persistRoutingMarker: () => undefined,
    engineStartAckDeliveredThisTurn: false, deferredDeliveredByAck: false,
    identicalCallState: {} as ExecuteContext['identicalCallState'],
    reminderLaneRefusedSigs: new Set<string>(),
    startAckArmed: false, startAckArmedAtMs: 0,
    fireStartAckIfOwed: async () => undefined,
    result: result as unknown as ExecuteContext['result'],
    messageId: `resp-${turnNumber}`, persistedContent: null, interAgentTurn: false,
    hasXmlFallbackTools: false, effectiveModelIdForPersist: 'floor-model',
    staleTaskWindowMinutes: 45, maxToolLoops: 40, engineBlockEscapeHatch: '',
    engineStartAckAfterMs: 30_000,
  } as unknown as ExecuteContext;
}

function seedTurnRow(turnNumber: number): void {
  db().prepare(
    `INSERT OR IGNORE INTO turns (agent_id, turn_number, started_at, conv_key, answered)
     VALUES (?, ?, datetime('now'), ?, 0)`,
  ).run(AGENT, turnNumber, CONV);
}

/** ONE REAL TURN THAT CROSSES THE FLOOR. `calls` real work calls are counted by the engine's
 *  own counter and the floor decides for itself whether to scaffold. */
async function runFloorTurn(
  turnNumber: number, opts: { calls: number; prompt: string },
): Promise<{ steer: string | null }> {
  const turnCtx = openTurnContext(AGENT);
  turnCtx.convKey = CONV;
  turnCtx.conversationId = CONVERSATION_ID;
  turnCtx.turnNumber = turnNumber;
  seedTurnRow(turnNumber);

  let state = freshState(turnNumber, opts.prompt);
  const ectx = executeCtx(turnCtx, turnNumber, workCalls(opts.calls));
  state = countTrackerWorkThisIteration(state, ectx);
  state = await runTrackerFloors(state, ectx);
  endTurnContext(AGENT);
  return { steer: nextSteer(state.steerQueue)?.content ?? null };
}

type ScaffoldRow = {
  id: string; title: string; description: string | null;
  original_description: string | null; goal: string | null; source_message_id: string | null;
};

const scaffoldRows = (): ScaffoldRow[] =>
  db().prepare(
    `SELECT id, title, description, original_description, goal, source_message_id FROM work
      WHERE root_kind = 'engine_scaffold' AND agent_id = ?`,
  ).all(AGENT) as ScaffoldRow[];

/** THE HANDOFF WAS FIRE-AND-FORGET, so its row would land on a later microtask than the
 *  floor's return. Polled, not assumed: since t139 the clauses assert it NEVER lands, and a
 *  poll is what makes "never" mean "not within the window a real one took". */
async function settledPmRename(): Promise<string | null> {
  for (let i = 0; i < 200; i++) {
    const r = pmRenameRequest();
    if (r !== null) return r;
    await new Promise((res) => setTimeout(res, 5));
  }
  return null;
}

const pmRenameRequest = (): string | null => {
  const r = db().prepare(
    `SELECT content FROM messages WHERE origin_intent = 'pm_rename' ORDER BY rowid DESC LIMIT 1`,
  ).get() as { content: string } | undefined;
  return r?.content ?? null;
};

const engineNote = (): string | null => {
  const r = db().prepare(
    `SELECT content FROM messages WHERE agent_id = ? AND role = 'system'
        AND content LIKE '[System] The engine opened tracker task%'
      ORDER BY rowid DESC LIMIT 1`,
  ).get(AGENT) as { content: string } | undefined;
  return r?.content ?? null;
};

/** EVERY TEXT CELL IN THE WHOLE DATABASE, which is how the ritual's own sweep found this —
 *  not by reading the column we already suspect. A fix that moved the leak one column over
 *  (into `original_description`, `goal`, `notes`, a `work_events` payload, a message row)
 *  fails here even though the clause below it would pass. */
function sweepForValue(needle: string): string[] {
  const hits: string[] = [];
  const tables = db().prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
  ).all() as Array<{ name: string }>;
  for (const { name } of tables) {
    let cols: Array<{ name: string; type: string }>;
    try {
      cols = db().prepare(`PRAGMA table_info(${name})`).all() as Array<{ name: string; type: string }>;
    } catch { continue; }
    for (const c of cols) {
      try {
        const rows = db().prepare(
          `SELECT COUNT(*) AS n FROM "${name}" WHERE CAST("${c.name}" AS TEXT) LIKE ?`,
        ).get(`%${needle}%`) as { n: number };
        if (rows.n > 0) hits.push(`${name}.${c.name} (${rows.n} row(s))`);
      } catch { /* a column SQLite will not cast is not a text carrier */ }
    }
  }
  return hits;
}

beforeEach(() => {
  mockDb.current?.close();
  mockDb.current = new Database(':memory:');
  runMigrations();
  for (const id of [AGENT, 'pm']) {
    db().prepare(
      `INSERT OR IGNORE INTO agents (id, name, status, session_started_at)
       VALUES (?, ?, 'idle', '1970-01-01')`,
    ).run(id, id);
  }
  untrackedWorkAcrossTurns.clear();
  forgetHandedCredentialValues();
  broadcasts.length = 0;
  pmWakes.length = 0;
});

afterEach(() => {
  endTurnContext(AGENT);
  untrackedWorkAcrossTurns.clear();
  forgetHandedCredentialValues();
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §1 — THE DRAW'S OWN SHAPE: the credential sits PAST the title's ~50-char truncation, so
//      the row's DESCRIPTION is the carrier. This is the observed failure, reproduced.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§1 the floor fires with a credential in the triggering message (description carrier)', () => {
  // The credential begins around char 65 — past `deriveScaffoldTitle`'s ~50-char word-boundary
  // cut, which is why the observed draw's title looked clean while the description leaked.
  const PROMPT =
    `Connect the billing provider and verify a charge goes through, the key is ${FAKE_KEY} `
    + `and then use it to pull this month's invoices.`;

  it('RED BEFORE THE FIX: the scaffolded row exists, and NO column of it carries the value', async () => {
    noteHandedCredentialValues(AGENT, [FAKE_KEY]);

    const { steer } = await runFloorTurn(9001, { calls: 6, prompt: PROMPT });

    // THE FLOOR REALLY FIRED. Without this, every assertion below is vacuous — the exact
    // trap the triage named ("a pin replay that happens to use <=5 work calls would pass
    // without exercising the defect").
    const rows = scaffoldRows();
    expect(rows.length).toBe(1);
    expect(steer).toContain('The engine opened tracker task');

    const row = rows[0];
    // THE LEAK, CLOSED — t139 closed it by construction. `description` was a byte-for-byte
    // copy of the owner's message (t118 redacted it); since t139 the floor writes NO prose from
    // the message at all: the row is LINKED to the message it served, and the task list shows
    // that message's words through the link, so the work spine never holds a copy.
    expect(row.description).toBeNull();
    expect(row.source_message_id).toBe('msg-9001');

    // No sibling column took the value instead.
    expect(row.title).not.toContain(FAKE_KEY);
    expect(row.original_description ?? '').not.toContain(FAKE_KEY);
    expect(row.goal ?? '').not.toContain(FAKE_KEY);
  });

  it('the value is nowhere in the DATABASE — the ritual sweep that found this, as a clause', async () => {
    noteHandedCredentialValues(AGENT, [FAKE_KEY]);
    await runFloorTurn(9002, { calls: 6, prompt: PROMPT });

    expect(scaffoldRows().length).toBe(1);
    // Before the fix this reported `work.description (text): 1 row(s)` — the ritual's own
    // wording. Any column in any table is a failure now, named in the message.
    expect(sweepForValue(FAKE_KEY)).toEqual([]);
  });

  it('the MODEL-BOUNDARY surfaces are clean too: no PM rename handoff exists, and the engine note', async () => {
    noteHandedCredentialValues(AGENT, [FAKE_KEY]);
    await runFloorTurn(9003, { calls: 6, prompt: PROMPT });

    // The handoff embedded `originalPrompt.slice(0, 1500)` in a system-model prompt and woke
    // the PM with it. t139 deleted it (it asked a model to name work from whatever the turn
    // served — on a presence ping, nothing), so the boundary is clean by absence: no row and
    // no wake. Polled, so a handoff that still ran on a later microtask is caught.
    const rename = await settledPmRename();
    expect(rename, 'no PM rename handoff is dispatched any more').toBeNull();
    expect(pmWakes).toEqual([]);

    const note = engineNote();
    expect(note).not.toBeNull();
    expect(note!).not.toContain(FAKE_KEY);

    // THE DASHBOARD. Every broadcast payload this turn produced, swept whole.
    expect(JSON.stringify(broadcasts)).not.toContain(FAKE_KEY);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §2 — THE NEAR-MISS, MADE A REAL CASE: the credential in the first ~50 characters, where
//      `deriveScaffoldTitle` puts it in the TITLE — broadcast to the dashboard and handed to
//      the PM. The observed draw missed this by 17 characters; it is not a pass, it is luck.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§2 a credential early in the message cannot reach the row TITLE', () => {
  const PROMPT = `Use ${FAKE_SECOND} to connect the webhook endpoint and verify it fires, `
    + `then reconcile the last three events against the ledger.`;

  it('the TITLE carries the marker, never the value — and so does every other surface', async () => {
    noteHandedCredentialValues(AGENT, [FAKE_SECOND]);
    const { steer } = await runFloorTurn(9004, { calls: 6, prompt: PROMPT });

    const rows = scaffoldRows();
    expect(rows.length).toBe(1);
    const row = rows[0];

    // The title used to be derived from the first line within ~50 chars, so with the value at
    // char 4 the placeholder is what landed there. t139: the title is the floor's fixed label
    // and the description is empty — nothing from the message is written to the row at all.
    // t139 round 2 (I5): the title is built from engine facts (counted calls, the turn's start).
    expect(row.title.startsWith(SCAFFOLD_TITLE)).toBe(true);
    expect(row.title).not.toContain('webhook');
    expect(row.description).toBeNull();

    expect(steer).toContain('The engine opened tracker task');
    expect(sweepForValue(FAKE_SECOND)).toEqual([]);
    expect(JSON.stringify(broadcasts)).not.toContain(FAKE_SECOND);
    expect(await settledPmRename(), 'no PM rename handoff is dispatched any more').toBeNull();
  });

  it('TWO handled values in one message are both replaced (the longest-first ordering holds)', async () => {
    noteHandedCredentialValues(AGENT, [FAKE_KEY, FAKE_SECOND]);
    const prompt = `Rotate ${FAKE_SECOND} to ${FAKE_KEY} across the three providers and `
      + `confirm each one accepts the new value before you tell me it is done.`;
    await runFloorTurn(9005, { calls: 6, prompt });

    expect(scaffoldRows().length).toBe(1);
    expect(sweepForValue(FAKE_KEY)).toEqual([]);
    expect(sweepForValue(FAKE_SECOND)).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §3 — WHAT THE FIX MAY NOT COST. This section pinned the pre-redaction title/description so
//      t118's redactor could not move them on an ordinary turn. t139 removed the message from
//      the row altogether (see the clauses), so what it pins now is the row's new shape.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§3 the ordinary turn: the row is linked, never described from the message', () => {
  const ORDINARY = 'Go through my inbox and put together a list of everything that needs a reply today.';

  // t139 CHANGED THIS SECTION'S SUBJECT, deliberately. It pinned the pre-t118 title and
  // description ('Go through my inbox and put together a list of' / the message verbatim)
  // so a redaction could not move them. Since t139 the floor writes neither from the message:
  // the title is its fixed label, the description is empty, and the row is LINKED to the
  // message it served — the task list shows the words through that link.
  it('an ordinary turn\'s row carries the fixed label, no description, and the link to its message', async () => {
    await runFloorTurn(9006, { calls: 6, prompt: ORDINARY });

    const rows = scaffoldRows();
    expect(rows.length).toBe(1);
    // t139 round 2 (I5): engine facts only — the counted calls and the turn's recorded start.
    expect(rows[0].title).toMatch(/^Multi-step task — 6 calls/);   // written out: a change has to be looked at
    expect(rows[0].title).not.toMatch(/inbox/i);
    expect(rows[0].description).toBeNull();
    expect(rows[0].source_message_id).toBe('msg-9006');
  });

  it('a credential handled by a DIFFERENT agent changes nothing about the row', async () => {
    noteHandedCredentialValues('some-other-agent', [FAKE_KEY]);
    await runFloorTurn(9007, { calls: 6, prompt: ORDINARY });

    const rows = scaffoldRows();
    expect(rows.length).toBe(1);
    expect(rows[0].title.startsWith(SCAFFOLD_TITLE)).toBe(true);
    expect(rows[0].description).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §4 — THE FLOOR ITSELF IS STILL THE FLOOR. The weakest-model guarantee the floor exists for
//      (`tracker-floors.ts` header) is not allowed to become collateral of this fix, and a
//      clause that only ever drives 6 calls would not notice if the threshold moved.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§4 the threshold the clause drives is the threshold the engine gates on', () => {
  it('5 calls open NO row and 6 calls open one — so the clauses above really crossed the floor', async () => {
    noteHandedCredentialValues(AGENT, [FAKE_KEY]);
    const prompt = `Check the gateway with ${FAKE_KEY} and summarise what you find.`;

    await runFloorTurn(9008, { calls: 5, prompt });
    expect(scaffoldRows().length).toBe(0);

    untrackedWorkAcrossTurns.clear();
    await runFloorTurn(9009, { calls: 6, prompt });
    expect(scaffoldRows().length).toBe(1);
    expect(sweepForValue(FAKE_KEY)).toEqual([]);
  });

  it('the floor constant is 6 in the SOURCE, so `calls: 6` above is not a coincidence', () => {
    // Read rather than imported: the constant is module-local on purpose (the floor owns it),
    // and widening the product's API for a test's convenience is not a trade this clause is
    // willing to make. If someone moves the threshold, the pair of clauses above changes
    // meaning and this line says so in the failure.
    const src = fs.readFileSync(new URL('../tracker-floors.ts', import.meta.url), 'utf8');
    expect(src).toContain('const TRACKER_AUTO_SCAFFOLD_AT = 6;');
  });
});
