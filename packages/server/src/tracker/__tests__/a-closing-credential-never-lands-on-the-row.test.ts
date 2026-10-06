// ════════════════════════════════════════════════════════════════════════════════════════
// t118 — THE SECOND CARRIER: `work.result` AND `work.evidence_json` ON THE CLOSE.
//
// The draw that found the scaffold leak carried the credential in TWO columns on its first
// attempt and ONE on its second. The difference was not the engine: it was whether the model
// happened to QUOTE the key in the closing evidence it wrote. `trackerUpdateStatus` keeps
// agent-authored evidence VERBATIM by deliberate design — the coerce-not-reject rule says so
// in `tools.ts` in as many words ("the claim text is kept verbatim ... so nothing is hidden
// and PM still sees exactly what the agent meant") — so a model that quotes a credential it
// just handled writes that credential into two unencrypted columns, and the PM reads it back
// out of `evidence_json` on its next sweep.
//
// WHAT THESE CLAUSES DRIVE. The real tool entry point, `trackerUpdateStatus(agentId, args)`,
// with a real `work` row underneath it — not `patchWork`, and not the redactor. The tool is
// what the model calls, so the tool is what is put under test.
//
// FIXTURE DISCIPLINE (G1): fictional credential-shaped strings, invented here. The pinned
// scenario's real value is not reproduced in this tree.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };

vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => { /* no-op */ } }));
vi.mock('../../agent/runtime.js', () => ({
  getAgentRuntime: () => ({ handleMessage: async () => { /* no-op */ } }),
}));
vi.mock('../../agent/agent-bus.js', () => ({ sendAgentMessage: () => { /* no-op */ } }));
vi.mock('../../agent/agent-notice.js', () => ({ postAgentNotice: () => { /* no-op */ } }));
vi.mock('../../memory/message-store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../memory/message-store.js')>()),
  insertEngineEventIfAbsent: () => null,
}));
vi.mock('../pm-agent.js', () => ({
  ensurePMAgentRunning: () => { /* no-op */ },
  noteTransitionForReview: () => { /* no-op */ },
}));
vi.mock('../notify.js', () => ({
  injectTaskAssignmentNotification: () => { /* no-op */ },
  claimAssignmentNoticeForTerminalTask: () => false,
}));
vi.mock('../../config/platform.js', () => ({
  getPrimaryAgentId: () => 'primary',
  isPrimaryAgent: (id: string) => id === 'primary',
  getPMAgentId: () => 'pm',
  getPMAgentName: () => 'PM',
  getOwnerName: () => 'the owner',
  isPMAgent: (id: string) => id === 'pm',
}));

import { trackerUpdateStatus } from '../tools.js';
import { createWorkTable, seedTrackerTask } from '../../work/__tests__/work-fixture.js';
import {
  noteHandedCredentialValues, forgetHandedCredentialValues, redactedPlaceholderFor,
} from '../../credentials/secret-values.js';

const AGENT = 'a-t118';
const TASK = 'task-t118-0001';

// ── THE FICTIONAL CREDENTIALS (G1) ──
const FAKE_TOKEN = 'ghp-t118-4RtY7uIo2PaS9dFg6HjK';
const FAKE_PW = 'pw-t118-Xc3Vb8Nm1QwE5rTz';

// `deliveries.created_at` is declared TEXT on purpose: `deliveryForAgentSince` reads it
// through `strftime('%s', created_at)`, and an INTEGER-affinity column handed a timestamp
// string would coerce it to the year. Declared wrong, the §3 close below would find no
// delivery on the ledger and would silently skip the very seam it exists to drive.
function applySchema(db: Database.Database): void {
  createWorkTable(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY, name TEXT, status TEXT, agent_type TEXT, model_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO agents (id, name, status) VALUES ('a-t118', 'Agent', 'idle');
    CREATE TABLE IF NOT EXISTS task_log (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, from_entity TEXT NOT NULL,
      entry_kind TEXT NOT NULL, from_status TEXT, to_status TEXT, reason TEXT,
      action_taken TEXT, note TEXT, evidence_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS deliveries (
      id TEXT PRIMARY KEY, agent_id TEXT, outcome TEXT, tool TEXT,
      conversation_id TEXT, message_id TEXT, channel TEXT, turn_number INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS turn_artifacts (
      id TEXT, agent_id TEXT, turn_number INTEGER, kind TEXT, path TEXT,
      payload_json TEXT, delivered_at TEXT
    );
    CREATE TABLE IF NOT EXISTS turns (
      agent_id TEXT NOT NULL, turn_number INTEGER NOT NULL, started_at TEXT,
      conv_key TEXT, answered INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS messages (
      seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, agent_id TEXT NOT NULL,
      conversation_id TEXT,
      lane TEXT NOT NULL DEFAULT 'owner' CHECK (lane IN ('owner','a2a','events')),
      origin_intent TEXT, role TEXT NOT NULL, content TEXT NOT NULL,
      display_kind TEXT NOT NULL DEFAULT 'unclassified',
      display_tier TEXT NOT NULL DEFAULT 'agent-only',
      turn_number INTEGER, task_id TEXT, run_id TEXT, conv_key TEXT DEFAULT NULL,
      provenance TEXT NOT NULL DEFAULT 'live',
      swept_at TEXT, served_by_turn INTEGER, answer_message_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

const rowOf = (id = TASK) =>
  mockDb.current!.prepare('SELECT title, description, result, evidence_json FROM work WHERE id = ?')
    .get(id) as {
      title: string; description: string | null;
      result: string | null; evidence_json: string | null;
    };

/** The whole database, swept for one value — the ritual's own method, not a read of the
 *  column we already suspect. A fix that moved the value into `notes` or a `work_events`
 *  payload would pass a column read and fail here. */
function sweepForValue(needle: string): string[] {
  const hits: string[] = [];
  const tables = mockDb.current!.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
  ).all() as Array<{ name: string }>;
  for (const { name } of tables) {
    let cols: Array<{ name: string }>;
    try {
      cols = mockDb.current!.prepare(`PRAGMA table_info(${name})`).all() as Array<{ name: string }>;
    } catch { continue; }
    for (const c of cols) {
      try {
        const r = mockDb.current!.prepare(
          `SELECT COUNT(*) AS n FROM "${name}" WHERE CAST("${c.name}" AS TEXT) LIKE ?`,
        ).get(`%${needle}%`) as { n: number };
        if (r.n > 0) hits.push(`${name}.${c.name} (${r.n} row(s))`);
      } catch { /* not a text carrier */ }
    }
  }
  return hits;
}

beforeEach(() => {
  const db = new Database(':memory:');
  applySchema(db);
  mockDb.current = db;
  forgetHandedCredentialValues();
});

afterEach(() => {
  forgetHandedCredentialValues();
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §1 — THE OBSERVED ATTEMPT-1 SHAPE: the model quotes the key in BOTH halves of its close.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§1 a close that quotes a handed credential stores the marker, not the value', () => {
  it('RED BEFORE THE FIX: `result` and `evidence_json` both carry the placeholder', () => {
    seedTrackerTask(mockDb.current!, { id: TASK, title: 'Connect the provider', status: 'in_progress' });
    noteHandedCredentialValues(AGENT, [FAKE_TOKEN]);

    trackerUpdateStatus(AGENT, {
      taskId: TASK, status: 'complete',
      result: `Connected and verified. Authenticated with ${FAKE_TOKEN} and pulled 14 invoices.`,
      evidence: [
        { kind: 'claim', claim: `the provider accepted the token ${FAKE_TOKEN} on the first call`, pointer: 'run-1' },
      ],
    });

    const row = rowOf();
    expect(row.result).not.toBeNull();
    expect(row.result!).not.toContain(FAKE_TOKEN);
    expect(row.result!).toContain(redactedPlaceholderFor(AGENT, FAKE_TOKEN));
    // The REST of the model's sentence survives — the PM still reads a usable receipt.
    expect(row.result!).toContain('pulled 14 invoices');

    expect(row.evidence_json).not.toBeNull();
    expect(row.evidence_json!).not.toContain(FAKE_TOKEN);
    expect(row.evidence_json!).toContain(redactedPlaceholderFor(AGENT, FAKE_TOKEN));
  });

  it('the evidence is still PARSEABLE JSON with its claim intact — the PM reader is not broken', () => {
    seedTrackerTask(mockDb.current!, { id: TASK, title: 'Connect the provider', status: 'in_progress' });
    noteHandedCredentialValues(AGENT, [FAKE_TOKEN]);

    trackerUpdateStatus(AGENT, {
      taskId: TASK, status: 'complete',
      result: 'Done.',
      evidence: [
        { kind: 'claim', claim: `used ${FAKE_TOKEN} to authenticate`, pointer: 'run-9' },
      ],
    });

    // `pm-agent.ts` JSON.parses this column and reads `{kind, claim, pointer}` off it. The
    // redaction runs over the SERIALIZED form, so this is the clause that proves the
    // placeholder cannot corrupt the structure the PM depends on.
    const parsed = JSON.parse(rowOf().evidence_json!) as Array<{ kind?: string; claim?: string; pointer?: string }>;
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThan(0);
    expect(parsed[0].kind).toBe('claim');
    expect(parsed[0].pointer).toBe('run-9');
    expect(parsed[0].claim).toContain('to authenticate');
    expect(parsed[0].claim).not.toContain(FAKE_TOKEN);
  });

  it('the value is nowhere in the DATABASE after the close', () => {
    seedTrackerTask(mockDb.current!, { id: TASK, title: 'Connect the provider', status: 'in_progress' });
    noteHandedCredentialValues(AGENT, [FAKE_TOKEN, FAKE_PW]);

    trackerUpdateStatus(AGENT, {
      taskId: TASK, status: 'complete',
      result: `Rotated to ${FAKE_PW}; old token ${FAKE_TOKEN} revoked.`,
      evidence: [{ kind: 'claim', claim: `new value ${FAKE_PW} accepted`, pointer: 'p1' }],
    });

    expect(sweepForValue(FAKE_TOKEN)).toEqual([]);
    expect(sweepForValue(FAKE_PW)).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §2 — WHAT THE FIX MAY NOT COST. An ordinary close is byte-identical.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§2 an ordinary close is unchanged', () => {
  it('an agent that handled no credential stores exactly what it wrote', () => {
    seedTrackerTask(mockDb.current!, { id: TASK, title: 'Tidy the inbox', status: 'in_progress' });

    const result = 'Filed 31 messages and drafted 4 replies for review.';
    trackerUpdateStatus(AGENT, {
      taskId: TASK, status: 'complete', result,
      evidence: [{ kind: 'claim', claim: 'four drafts saved', pointer: 'drafts/' }],
    });

    const row = rowOf();
    expect(row.result).toBe(result);
    const parsed = JSON.parse(row.evidence_json!) as Array<{ claim?: string }>;
    expect(parsed[0].claim).toBe('four drafts saved');
  });

  it('a credential handled by a DIFFERENT agent does not rewrite this close', () => {
    seedTrackerTask(mockDb.current!, { id: TASK, title: 'Tidy the inbox', status: 'in_progress' });
    noteHandedCredentialValues('someone-else', [FAKE_TOKEN]);

    const result = `A literal that happens to look like ${FAKE_TOKEN} but was never handed here.`;
    trackerUpdateStatus(AGENT, {
      taskId: TASK, status: 'complete', result,
      evidence: [{ kind: 'claim', claim: 'done', pointer: 'x' }],
    });

    // Keyed per agent, as the redactor is everywhere else in the tree. This clause exists so
    // a future "redact against every agent in the process" shortcut cannot land unnoticed.
    expect(rowOf().result).toBe(result);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §3 — THE THIRD SOURCE-REDACTED SEAM: `fileAssignDeliverableCloseRequest`.
//
// Added on review. This is the seam t118's own census NEWLY DISCOVERED leaking (census row 3)
// and it was the one of the three source-redacted seams with no clause of its own — the exact
// five-month mechanism the lane exists to end, left open on one line.
//
// ── AND THE MUTANT CORRECTED THE REASON IT IS REDACTED, so the record is honest ──
// The review's framing (and t118's own §2 note) said the doors "provably cannot cover" this
// seam. Measured, that is WRONG HERE, and the measurement is cheap to state: the function's
// own lookup pins `w.agent_id = ?` to `senderAgentId`
// (`tools.ts:333-338`), so on this path the ACTOR IS the row's agent and `patchWork`'s
// row-keyed redaction covers it too. Removing the seam's own redaction alone leaves these
// clauses GREEN (M4); removing the seam AND the door reds them (M5).
//
// The source redaction stays, and the argument is narrow rather than inflated: it is keyed to
// the AUTHOR explicitly instead of inheriting safety from a WHERE clause forty lines away, so
// it still holds if that lookup is ever widened (dropping the `agent_id` predicate to let a
// supervisor file a close, say). That is belt, and it is labelled as belt — not as the door's
// blind spot. The genuine blind spots are the floor's non-column surfaces (the PM rename row,
// the broadcast, the engine note) and `trackerUpdateStatus`, where an actor CAN write prose
// onto a row it does not own because task-id resolution is not agent-scoped
// (`schema.ts:757-777` scopes by KIND, only title resolution is scoped to the caller).
//
// Driven through the REAL exported function with a real claimed ASSIGN task and a real
// delivery on the ledger, because a source-shape assertion alone is what let this seam ship
// unpinned in the first place.
// ════════════════════════════════════════════════════════════════════════════════════════

import { fileAssignDeliverableCloseRequest } from '../tools.js';

const THREAD = 'thr-t118-assign-1';
const ASSIGN_TASK = 'task-t118-assign-1';

/** The delivery receipt the close is filed FROM. Must be newer than the task's `opened_at`
 *  (the fixture seeds 1700000000000) and carry a parseable text timestamp. */
function seedDelivery(agentId: string): void {
  mockDb.current!.prepare(
    `INSERT INTO deliveries (id, agent_id, outcome, tool, channel, conversation_id,
                             message_id, turn_number, created_at, updated_at)
     VALUES (?, ?, 'delivered', 'a2a_send', 'a2a', NULL, NULL, NULL,
             datetime('now'), datetime('now'))`,
  ).run(`del-${agentId}-1`, agentId);
}

describe('§3 an A2A deliverable that quotes a handed credential never lands in `result`', () => {
  it('RED BEFORE THE FIX: the assignee\'s deliverable text is redacted on the close bind', async () => {
    seedTrackerTask(mockDb.current!, {
      id: ASSIGN_TASK, title: 'Pull the ledger', status: 'in_progress',
      agentId: AGENT, a2a_thread_id: THREAD,
    });
    seedDelivery(AGENT);
    noteHandedCredentialValues(AGENT, [FAKE_TOKEN]);

    await fileAssignDeliverableCloseRequest(
      AGENT, THREAD,
      `Done — authenticated with ${FAKE_TOKEN} and reconciled 212 rows against the ledger.`,
    );

    const row = rowOf(ASSIGN_TASK);
    // The bind happens before the status transition, so the columns carry the redacted text
    // whether or not the close itself goes on to be accepted.
    expect(row.result, 'the close bind wrote `result`').not.toBeNull();
    expect(row.result!).not.toContain(FAKE_TOKEN);
    expect(row.result!).toContain(redactedPlaceholderFor(AGENT, FAKE_TOKEN));
    // The deliverable still reads as a deliverable.
    expect(row.result!).toContain('reconciled 212 rows');
    expect(sweepForValue(FAKE_TOKEN)).toEqual([]);
  });

  it('WHAT THE FIX MAY NOT COST: an ordinary deliverable is stored verbatim', async () => {
    seedTrackerTask(mockDb.current!, {
      id: ASSIGN_TASK, title: 'Pull the ledger', status: 'in_progress',
      agentId: AGENT, a2a_thread_id: THREAD,
    });
    seedDelivery(AGENT);

    await fileAssignDeliverableCloseRequest(
      AGENT, THREAD, 'Done — reconciled 212 rows against the ledger.',
    );

    expect(rowOf(ASSIGN_TASK).result).toBe('Done — reconciled 212 rows against the ledger.');
  });
});
