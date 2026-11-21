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
vi.mock('../../agent/agent-notice.js', () => ({ postAgentNotice: () => { /* no-op */ } }));
vi.mock('../../memory/message-store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../memory/message-store.js')>()),
  insertEngineEventIfAbsent: () => null,
}));
vi.mock('../pm-agent.js', () => ({
  ensurePMAgentRunning: () => { /* no-op */ },
}));
vi.mock('../notify.js', () => ({
  injectTaskAssignmentNotification: () => { /* no-op */ },
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

// `deliveries.created_at` is declared TEXT on purpose: readers take it through `strftime`.
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
      recipient_id TEXT, recipient_display TEXT, receipt_id TEXT, detail TEXT,
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


  it('the value is nowhere in the DATABASE after the close', () => {
    seedTrackerTask(mockDb.current!, { id: TASK, title: 'Connect the provider', status: 'in_progress', agentId: AGENT });
    noteHandedCredentialValues(AGENT, [FAKE_TOKEN, FAKE_PW]);

    trackerUpdateStatus(AGENT, {
      taskId: TASK, status: 'complete',
      result: `Rotated to ${FAKE_PW}; old token ${FAKE_TOKEN} revoked.`,
      evidence: [{ kind: 'claim', claim: `new value ${FAKE_PW} accepted`, pointer: '/tmp/rotate/p1.log' }],
    });

    expect(sweepForValue(FAKE_TOKEN)).toEqual([]);
    expect(sweepForValue(FAKE_PW)).toEqual([]);
  });
});
