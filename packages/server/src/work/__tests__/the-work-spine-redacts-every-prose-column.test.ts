// ════════════════════════════════════════════════════════════════════════════════════════
// t118 — THE WORK SPINE'S PROSE COLUMNS, AND THE CENSUS THAT KEEPS THEM COVERED.
//
// WHY A CENSUS AND NOT JUST THE TWO FIXES. The tracker-scaffold leak was found by accident:
// a random draw happened to cross a floor of six untracked work calls while holding a
// credential. `redactHandedCredentials` had been ONE IMPORT AWAY from the leaking line since
// 2026-05-08. The triage's own conclusion is the sentence this file exists to answer —
// "without a census this returns".
//
// So the census below asks the two questions a per-call-site fix can never answer:
//
//   §1  DOES THE DOOR ACTUALLY REDACT? Driven, not scanned: the tool-door create path, the
//       A2A ASSIGN auto-create, an attribute patch, a note append, and a commitment — each
//       with a registered fictional credential in the text a model or a person authored, each
//       read back out of the database.
//
//   §2  IS EVERY PROSE COLUMN CLASSIFIED? `CREDENTIAL_BEARING_WORK_TEXT` is checked against
//       `TrackerAttr` itself, so a NEW text column added to the spine's attribute union and
//       not classified fails here instead of passing silently. (Direction one.)
//
//   §3  DOES EVERY WRITER GO THROUGH A DOOR? Every production file that writes `work` with
//       raw SQL is held to a reviewed allow-list with a VERDICT per writer. A new raw writer
//       that binds prose fails here. (Direction two.)
//
// FIXTURE DISCIPLINE (G1): fictional credential-shaped strings, invented in this file.
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
vi.mock('../../tracker/pm-agent.js', () => ({
  ensurePMAgentRunning: () => { /* no-op */ },
}));
vi.mock('../../tracker/notify.js', () => ({
  injectTaskAssignmentNotification: () => { /* no-op */ },
}));

import { createTask, createProject, autoCreateAssignTask } from '../../tracker/schema.js';
import { patchWork } from '../tracker-store.js';
import { createWorkTable } from './work-fixture.js';
import {
  noteHandedCredentialValues, forgetHandedCredentialValues, redactedPlaceholderFor,
} from '../../credentials/secret-values.js';

const AGENT = 'agent-spine';
const OTHER = 'agent-receiver';

// ── THE FICTIONAL CREDENTIALS (G1) ──
const FAKE_A = 'key-t118-Dq7Wm2Zx9Yc4Vb6Nt';
const FAKE_B = 'tok-t118-Jh5Gf8Ds3Ap1Ol0Ik';

const db = (): Database.Database => mockDb.current!;

const ORIGIN = { kind: null, sourceMessageId: null, turn: null, convKey: null };

function applySchema(d: Database.Database): void {
  createWorkTable(d);
  d.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY, name TEXT, status TEXT, agent_type TEXT, model_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT OR IGNORE INTO agents (id, name, status) VALUES ('agent-spine', 'Spine', 'idle');
    INSERT OR IGNORE INTO agents (id, name, status) VALUES ('agent-receiver', 'Receiver', 'idle');
  `);
}

type Row = {
  title: string; description: string | null; original_description: string | null;
  goal: string | null; notes: string | null; result: string | null;
  evidence_json: string | null; completion_summary: string | null;
};

const rowOf = (id: string): Row =>
  db().prepare(
    `SELECT title, description, original_description, goal, notes, result, evidence_json,
            completion_summary FROM work WHERE id = ?`,
  ).get(id) as Row;

/** Every prose cell of one row, concatenated — so a clause cannot pass by checking the one
 *  column we happened to think of. */
const proseOf = (id: string): string => {
  const r = rowOf(id);
  return [
    r.title, r.description, r.original_description, r.goal, r.notes, r.result,
    r.evidence_json, r.completion_summary,
  ].filter((v): v is string => typeof v === 'string').join('\n');
};

function sweepForValue(needle: string): string[] {
  const hits: string[] = [];
  const tables = db().prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
  ).all() as Array<{ name: string }>;
  for (const { name } of tables) {
    let cols: Array<{ name: string }>;
    try {
      cols = db().prepare(`PRAGMA table_info(${name})`).all() as Array<{ name: string }>;
    } catch { continue; }
    for (const c of cols) {
      try {
        const r = db().prepare(
          `SELECT COUNT(*) AS n FROM "${name}" WHERE CAST("${c.name}" AS TEXT) LIKE ?`,
        ).get(`%${needle}%`) as { n: number };
        if (r.n > 0) hits.push(`${name}.${c.name} (${r.n} row(s))`);
      } catch { /* not a text carrier */ }
    }
  }
  return hits;
}

beforeEach(() => {
  mockDb.current?.close();
  mockDb.current = new Database(':memory:');
  applySchema(db());
  forgetHandedCredentialValues();
});

afterEach(() => forgetHandedCredentialValues());

// ════════════════════════════════════════════════════════════════════════════════════════
// §1 — THE DOOR REDACTS, DRIVEN THROUGH THE REAL CREATION PATHS
//
// None of these call sites carries a redact call of its own, by design: the whole point of
// putting the redaction in `openTrackerTask`/`openTrackerProject`/`patchWork` is that a
// caller cannot forget it. These clauses are what make that a property rather than a claim.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§1 the tracker doors redact every prose column they bind', () => {
  it('the TOOL-DOOR create path: title, description, original_description and goal', () => {
    noteHandedCredentialValues(AGENT, [FAKE_A]);
    const id = createTask({
      title: `Rotate ${FAKE_A} everywhere`,
      description: `The current value is ${FAKE_A}; replace it on all three providers.`,
      goal: `every provider accepts a value other than ${FAKE_A}`,
      createdBy: AGENT, assignedTo: AGENT, origin: ORIGIN,
    });

    const r = rowOf(id);
    const marker = redactedPlaceholderFor(AGENT, FAKE_A);
    expect(r.title).not.toContain(FAKE_A);
    expect(r.title).toContain(marker);
    expect(r.description!).not.toContain(FAKE_A);
    expect(r.description!).toContain(marker);
    // `original_description` is the immutable copy — the column a sink-side fix on
    // `description` alone would have missed.
    expect(r.original_description!).not.toContain(FAKE_A);
    expect(r.goal!).not.toContain(FAKE_A);
    expect(sweepForValue(FAKE_A)).toEqual([]);
  });

  it('the PROJECT door: title and description', () => {
    noteHandedCredentialValues(AGENT, [FAKE_A]);
    const { projectId } = createProject({
      title: `Migrate off ${FAKE_A}`,
      description: `Old key ${FAKE_A} must stop working by Friday.`,
      level: 1, createdBy: AGENT, origin: ORIGIN,
    });
    expect(proseOf(projectId)).not.toContain(FAKE_A);
    expect(proseOf(projectId)).toContain(redactedPlaceholderFor(AGENT, FAKE_A));
  });

  it('the A2A ASSIGN auto-create: the SENDER\'s payload becomes title + description + goal', () => {
    // The sending agent is the one that handled the value and whose model wrote the payload;
    // the row is assigned to the RECEIVER. This is why the door keys on the union of the
    // row's agents rather than on one of them.
    noteHandedCredentialValues(AGENT, [FAKE_B]);
    const out = autoCreateAssignTask({
      payload: `Use ${FAKE_B} to pull the ledger and reconcile it against last month.`,
      senderId: AGENT, receiverId: OTHER, threadId: 'thr-t118-1', assignMessageId: null,
    });
    expect(out).not.toBeNull();

    const r = rowOf(out!.taskId);
    expect(r.title).not.toContain(FAKE_B);
    expect(r.description!).not.toContain(FAKE_B);
    expect(r.goal!).not.toContain(FAKE_B);
    expect(r.description!).toContain(redactedPlaceholderFor(AGENT, FAKE_B));
    expect(sweepForValue(FAKE_B)).toEqual([]);
  });

  it('the ATTRIBUTE door: a patch naming prose columns is scrubbed whichever caller named it', () => {
    noteHandedCredentialValues(AGENT, [FAKE_A]);
    const id = createTask({ title: 'Ordinary task', createdBy: AGENT, assignedTo: AGENT, origin: ORIGIN });

    patchWork(id, {
      notes: `agent note: the value I used was ${FAKE_A}`,
      result: `done with ${FAKE_A}`,
      evidence_json: JSON.stringify([{ kind: 'claim', claim: `used ${FAKE_A}`, pointer: 'p' }]),
    });

    expect(proseOf(id)).not.toContain(FAKE_A);
    expect(proseOf(id)).toContain(redactedPlaceholderFor(AGENT, FAKE_A));
    // Still JSON, still readable by the PM.
    expect(() => JSON.parse(rowOf(id).evidence_json!)).not.toThrow();
    expect(sweepForValue(FAKE_A)).toEqual([]);
  });

  it('WHAT THE FIX MAY NOT COST: with no handed credential every column is byte-identical', () => {
    const title = 'Put together the quarterly summary';
    const description = 'Pull the three reports and write one page on top of them.';
    const id = createTask({ title, description, createdBy: AGENT, assignedTo: AGENT, origin: ORIGIN });

    const r = rowOf(id);
    expect(r.title).toBe(title);
    expect(r.description).toBe(description);
    expect(r.original_description).toBe(description);
  });
});
