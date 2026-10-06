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
//       that binds prose — the next `tracker-floors.ts` — fails here. (Direction two.)
//
// FIXTURE DISCIPLINE (G1): fictional credential-shaped strings, invented in this file.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
  noteTransitionForReview: () => { /* no-op */ },
}));
vi.mock('../../tracker/notify.js', () => ({
  injectTaskAssignmentNotification: () => { /* no-op */ },
  claimAssignmentNoticeForTerminalTask: () => false,
}));

import { createTask, createProject, autoCreateAssignTask } from '../../tracker/schema.js';
// The engine's own corpus, derived ONCE (PHASE-6 GUARD-AUDIT). The floor's file is still
// moving between step packages cut by cut, so this clause finds it by its CONTENT rather than
// by a path that would go quiet — which is the exact failure that audit exists to prevent.
import { engineFileContaining } from '../../agent/v2/__tests__/engine-sources.js';
import { patchWork, appendWorkNotes, CREDENTIAL_BEARING_WORK_TEXT } from '../tracker-store.js';
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
      completion_summary: `finished using ${FAKE_A}`,
      result: `done with ${FAKE_A}`,
      evidence_json: JSON.stringify([{ kind: 'claim', claim: `used ${FAKE_A}`, pointer: 'p' }]),
    });

    expect(proseOf(id)).not.toContain(FAKE_A);
    expect(proseOf(id)).toContain(redactedPlaceholderFor(AGENT, FAKE_A));
    // Still JSON, still readable by the PM.
    expect(() => JSON.parse(rowOf(id).evidence_json!)).not.toThrow();
    expect(sweepForValue(FAKE_A)).toEqual([]);
  });

  it('the NOTE-APPEND door has its own redaction (its CASE-append cannot go through patchWork)', () => {
    noteHandedCredentialValues(AGENT, [FAKE_A]);
    const id = createTask({ title: 'Ordinary task', createdBy: AGENT, assignedTo: AGENT, origin: ORIGIN });

    appendWorkNotes(id, `2026-10-06: authenticated with ${FAKE_A}`);

    expect(rowOf(id).notes!).not.toContain(FAKE_A);
    expect(rowOf(id).notes!).toContain(redactedPlaceholderFor(AGENT, FAKE_A));
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

// ════════════════════════════════════════════════════════════════════════════════════════
// §2 — DIRECTION ONE: A NEW PROSE COLUMN MUST BE CLASSIFIED
// ════════════════════════════════════════════════════════════════════════════════════════

const SERVER_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const readRel = (rel: string): string => fs.readFileSync(path.join(SERVER_SRC, rel), 'utf8');

const isCommentLine = (line: string): boolean => {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
};
const codeOnly = (text: string): string =>
  text.split('\n').filter((l) => !isCommentLine(l)).join('\n');

/**
 * EVERY `TrackerAttr` THAT IS NOT PROSE, AND WHY.
 *
 * Reviewed once, here, so the census can subtract. A column in neither this list nor
 * `CREDENTIAL_BEARING_WORK_TEXT` is a column nobody has classified, and that is a RED: the
 * reviewer has to decide whether a credential can reach it, which is precisely the decision
 * that was never made for `description` between 2026-05-08 and 2026-10-06.
 */
const NON_PROSE_ATTRS: Record<string, string> = {
  parent_id: 'row id', agent_id: 'agent handle', assignee_agent: 'agent handle',
  requester_id: 'agent handle', conversation_id: 'row id',
  priority: 'enum', step_number: 'integer', total_steps: 'integer', phase: 'integer',
  depends_on: 'JSON array of work ids, no prose', assigned_to_group: 'group handle',
  task_kind: 'enum', level: 'integer', phase_count: 'integer', current_phase: 'integer',
  group_id: 'row id', source_message_id: 'row id', origin_turn: 'integer',
  origin_conv_key: 'derived conversation key', origin_kind: 'enum',
  a2a_thread_id: 'row id', last_smell_flag: 'enum',
  scheduled_start: 'timestamp', repeat_interval: 'integer', repeat_unit: 'enum',
  repeat_end_type: 'enum', repeat_end_value: 'integer/timestamp',
  repeat_days_of_week: 'bitmask/CSV of day numbers', schedule_status: 'enum',
  is_paused: 'boolean', paused_until: 'timestamp', status_before_pause: 'enum',
  last_run_at: 'timestamp', missed_runs_paused_at: 'timestamp',
  anchor_local: 'wall-clock string', attempts: 'integer', tz: 'IANA zone id',
};

describe('§2 every attribute column is classified as prose or not-prose', () => {
  it('the union and the two lists agree exactly — a NEW column fails until someone classifies it', () => {
    const src = codeOnly(readRel('work/tracker-store.ts'));
    const block = src.slice(src.indexOf('export type TrackerAttr'));
    const union = block.slice(0, block.indexOf(';'));
    const columns = [...union.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);

    expect(columns.length).toBeGreaterThan(30);

    const prose = new Set<string>(CREDENTIAL_BEARING_WORK_TEXT);
    const unclassified = columns.filter((c) => !prose.has(c) && !(c in NON_PROSE_ATTRS));
    expect(
      unclassified,
      'these `TrackerAttr` columns are classified neither as credential-bearing prose '
      + '(add them to CREDENTIAL_BEARING_WORK_TEXT in work/tracker-store.ts, and the door '
      + 'will redact them) nor as non-prose (add them to NON_PROSE_ATTRS here, with the '
      + 'reason). t118: an unclassified text column is how a credential reached '
      + '`work.description` in plaintext for five months.',
    ).toEqual([]);

    // And the other way: a column listed as prose that has left the union is dead weight.
    const stale = [...prose].filter((c) => !columns.includes(c));
    expect(stale, 'CREDENTIAL_BEARING_WORK_TEXT names columns no longer in TrackerAttr').toEqual([]);
  });

  it('the door still calls the one redactor on the path all three writers share', () => {
    const src = codeOnly(readRel('work/tracker-store.ts'));
    // The ONE redactor (its own doc: "it is the ONLY redactor"). A second, narrower scrub
    // appearing here would be the thing the corrected ruling 13 forbids.
    expect(src).toContain("import { redactHandedCredentials } from '../credentials/secret-values.js'");
    expect(src).toMatch(/function scrubText\(/);
    expect(src).toMatch(/patchAssignments\(scrubPatch\(id, patch\)\)/);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §3 — DIRECTION TWO: EVERY RAW `work` WRITER IS REVIEWED
//
// The leak was a caller holding owner text. The next one will be too. This scan finds every
// production file that writes the `work` table with its own SQL and holds it to a verdict.
// ════════════════════════════════════════════════════════════════════════════════════════

/** The reviewed raw-SQL writers of `work`, with the verdict that makes each one safe.
 *  A file that writes `work` and is not here fails the clause below. */
const REVIEWED_RAW_WRITERS: Record<string, string> = {
  'work/tracker-store.ts':
    'THE DOORS. openTrackerProject / openTrackerTask / patchWork / appendWorkNotes, each of '
    + 'which redacts the prose columns it binds (§1 drives all four).',
  'work/store.ts':
    'openAsk binds `title` from `askTitle`, which work/ask-title.ts REFUSES outright when the '
    + 'model copied a handed value into it (falling back to the ask id) — a refusal, not a '
    + 'redaction, and a deliberate one. openA2AThreadChildren and openCommitment bind '
    + 'agent-authored prose to `title` and redact it at the bind (t118). Every other '
    + 'statement in the file moves state, counters, ids and timestamps.',
  'work/occurrences.ts':
    'claimOccurrence binds the engine literal `occurrence #N` to `title`; its other '
    + 'statements move schedule state and agent handles. No caller text reaches a column.',
  'work/next-run.ts': 'the firing clock: timestamps and schedule enums only.',
  'work/effort-meter.ts': 'integer counters only.',
  'work/purge-sweep.ts': 'sets parent_id NULL.',
  'work/work-refs.ts': 'sets parent_id NULL.',
  'work/ask-remediation.ts': 'stamps result_delivery_id (a delivery row id).',
  'work/ask-settlement.ts': 'stamps result_delivery_id (a delivery row id).',
  'work/deliverable-declaration.ts': 'sets task_kind (an enum).',
  'work/engine-checkpoint-note.ts': 'touches updated_at.',
};

describe('§3 every production file that writes `work` with raw SQL has a verdict', () => {
  it('a NEW raw writer — the next tracker-floors.ts — fails until it is reviewed', () => {
    const files: string[] = [];
    const walk = (rel: string): void => {
      for (const e of fs.readdirSync(path.join(SERVER_SRC, rel), { withFileTypes: true })) {
        const child = `${rel}/${e.name}`;
        if (e.isDirectory()) {
          if (e.name === '__tests__' || e.name === 'node_modules') continue;
          walk(child);
        } else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts') && !e.name.endsWith('.test.ts')) {
          files.push(child.replace(/^\//, ''));
        }
      }
    };
    walk('');

    // The statements that write the `work` TABLE. `work_events`, `work_refs` and the like are
    // other tables and are excluded by the word boundary.
    const WRITES = /(INSERT\s+(OR\s+\w+\s+)?INTO\s+work\b(?!_)|UPDATE\s+work\b(?!_))/i;

    const writers = files.filter((f) => {
      const src = codeOnly(readRel(f));
      return WRITES.test(src);
    });

    expect(writers.length).toBeGreaterThan(5);

    const unreviewed = writers.filter((f) => !(f in REVIEWED_RAW_WRITERS));
    expect(
      unreviewed,
      'these files write the `work` table with their own SQL and carry no t118 verdict. '
      + 'If the statement binds owner- or model-authored prose to title / description / '
      + 'original_description / goal / notes / result / evidence_json / completion_summary, '
      + 'route it through the doors in work/tracker-store.ts (which redact) or redact at its '
      + 'source; then record the verdict in REVIEWED_RAW_WRITERS here. t118: the engine floor '
      + 'was exactly this — a writer nobody had looked at, one import from the redactor.',
    ).toEqual([]);

    // And a verdict for a file that no longer writes `work` is a verdict about nothing.
    const stale = Object.keys(REVIEWED_RAW_WRITERS).filter((f) => !writers.includes(f));
    expect(stale, 'REVIEWED_RAW_WRITERS names files that no longer write `work`').toEqual([]);
  });

  it('the two source-side seams t118 fixed still redact (the actor-keyed cases the doors cannot key)', () => {
    // These two are NOT covered by the doors, and the distinction is load-bearing: the doors
    // key on the agents the ROW belongs to, which is right for a creator writing its own row
    // and wrong when the ACTOR is someone else (a PM, or an agent closing a task assigned
    // elsewhere). Both seams below are actor-keyed, so they redact at the source.
    // Driven behaviourally next door, in `the-scaffold-floor-never-persists-a-credential`,
    // which crosses the real >=6 floor; this is the source half, so a removal is caught even
    // if someone deletes that file.
    const floorSeam = engineFileContaining(
      'redactHandedCredentials(agentId, state.lastUserMessageContent)',
    );
    expect(
      floorSeam,
      'the tracker auto-scaffold floor no longer redacts the raw user message before it '
      + 'derives the row title and description. That line IS t118: a handed credential in a '
      + 'message that crosses the >=6 untracked-call floor lands in `work.description` in '
      + 'plaintext, and in the title the dashboard broadcasts and the PM is handed.',
    ).not.toBeNull();

    const tools = codeOnly(readRel('tracker/tools.ts'));
    expect(tools).toContain('redactHandedCredentials(agentId, result)');
    expect(tools).toContain('redactHandedCredentials(agentId, JSON.stringify(evidenceOut))');
  });
});
