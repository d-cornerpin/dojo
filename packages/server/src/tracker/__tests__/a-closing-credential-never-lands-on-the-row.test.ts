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
      id TEXT PRIMARY KEY, agent_id TEXT, outcome TEXT, tool TEXT, created_at INTEGER
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
