// Two-key door-lock conformance guard (demolition Phase 1, RC-19 source-scan style).
//
// The two-key tracker contract: a task's completion requires the AGENT to REQUEST
// it (tracker_update_status, landing complete_validated=0) and the PM to VALIDATE
// it against the goal (tracker_validate, flipping complete_validated=1). No engine
// path may close-and-stamp on the model's behalf. The forgery this restores from
// was engineCloseDeliveredTask, which wrote status='complete' AND
// complete_validated=1 in one motion so the PM's key could never turn.
//
// This test source-scans the tracker/scheduler/agent subsystems for the two keys
// and holds each to a reviewed allow-list of WRITER DEFINITION SITES:
//
//   KEY 1  writers of a TASK's status='complete'. Allowed: the agent-request
//          close-outs that funnel through trackerUpdateStatus / tracker_complete_step
//          / tracker_pause_schedule (all land complete_validated=0), the
//          occurrence-gated recurring advance (onTaskRunComplete), the scheduler's
//          recurring-terminal janitorial writers (force-reset / recover-missing-run),
//          and the group-delete auto-complete. tracker_override / apply_user_verdict
//          reach 'complete' through the generic updateTask param path (status = ?),
//          which is invisible to this literal scan and gated by the helper. The
//          demolished engineCloseDeliveredTask / markDeliverableShown must NOT
//          appear (it no longer writes status).
//
//   KEY 2  writers of complete_validated (allowed ONLY tracker_validate,
//          tracker_override, apply_user_verdict) and pause_validated (allowed ONLY
//          the PM/user verdict paths). alertMissedRuns' pause_validated=1
//          pre-blessing was REMOVED so the missed-runs pause lands unvalidated and
//          the PM sweep adjudicates it.
//
// WHY WRITER DEFINITION SITES, NOT CALL SITES: at the time this test lands, loop.ts
// still CALLS engineCloseDeliveredTask (the alias) at a few sites; the loop.ts-owning
// demolition pass renames those later. Scanning by the SQL/update writer that
// actually mutates the row (not by who calls a helper) keeps this test green after
// the tracker/scheduler/agent changes ALONE. Only a rogue NEW writer (a fresh
// UPDATE that closes or stamps outside the reviewed set) trips it.
//
// SCOPING NOTE (pause_validated, KEY 2): the scan now covers tracker/ +
// scheduler/ + agent/ (including agent/v2/loop.ts). Phase 1.4 removed the two
// engine pre-blessing writers that used to live in agent/ (spawner.ts's
// terminate-time pause and loop.ts's pre-turn close-out gate), so those pauses
// now land UNVALIDATED and the PM sweep adjudicates them. With those gone, the
// only surviving pause_validated=1 writers anywhere are the PM/user verdict
// paths (tracker_validate / tracker_override / apply_user_verdict). A new
// engine pre-blessing in ANY of the three subsystems now trips this scan.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function readRel(rel: string): string[] {
  return fs.readFileSync(path.join(SERVER_SRC, rel), 'utf8').split('\n');
}

function isCommentLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

// Drop full comment lines from a source slice so a negative assertion cannot trip
// on an explanatory comment (e.g. "no complete_validated" / "used to stamp
// pause_validated=1").
function codeOnly(text: string): string {
  return text.split('\n').filter((l) => !isCommentLine(l)).join('\n');
}

// Non-recursive .ts listing for a subsystem dir (skips .d.ts and *.test.ts and the
// __tests__ subdir, which readdir does not descend into anyway).
function subsystemFiles(dir: string): string[] {
  const abs = path.join(SERVER_SRC, dir);
  return fs
    .readdirSync(abs)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts') && !f.endsWith('.test.ts'))
    .map((f) => `${dir}/${f}`);
}

// ────────────────────────────────────────────────────────────────────────────
// KEY 1 : writers of a TASK's status='complete'
// ────────────────────────────────────────────────────────────────────────────

// A literal SQL assignment `status = 'complete'` (single or multi-line UPDATE) or an
// updateTask object-literal `{ status: 'complete'` / `, status: 'complete'`.
const STATUS_COMPLETE_SQL = /status\s*=\s*'complete'/;
const STATUS_COMPLETE_OBJ = /[,{]\s*status:\s*'complete'/;
// A tasks-table UPDATE header (\b after `tasks` excludes `task_runs`; `projects` is a
// different word entirely). Used to confirm a literal SQL match targets `tasks`.
const UPDATE_TASKS = /\bUPDATE\s+tasks\b/;

// The reviewed writer definition sites. A KEY-1 writer line is compliant iff, for its
// file, one of these substrings is present in the line (or, for scheduler/runner.ts
// multi-line writers, the bare `status = 'complete',` clause). Anything else is a
// rogue close and fails.
const KEY1_ALLOW: Record<string, string[]> = {
  // Agent-request close-outs (all land complete_validated=0 -> PM still validates).
  'tracker/tools.ts': [
    "SET status = 'complete', schedule_status = 'completed', is_paused = 1", // complete_all_runs (trackerUpdateStatus)
    "SET is_paused = 1, schedule_status = 'completed', status = 'complete'", // tracker_pause_schedule(mark_complete)
    "{ status: 'complete', notes:",                                          // tracker_complete_step (updateTask object)
    // Narrow carve-out (demolition Phase 1.7 #2): closeEngineScaffoldSameTurn.
    // The ONLY engine status='complete' writer, and it lands complete_validated=0
    // (UNVALIDATED, still gated by the PM sweep) ONLY on a task that carries the
    // ENGINE_AUTO_MARKER and was created this turn. It closes the engine's OWN
    // same-turn scaffold, never agent- or user-authored work, and never forges
    // the PM's key (the demolished engineCloseDeliveredTask stamped =1). The =0
    // on this same line keeps it out of the KEY-2 complete_validated=1 scan.
    "SET status = 'complete', complete_validated = 0",
  ],
  // Scheduler recurring advance + recurring-terminal janitorial writers.
  'scheduler/runner.ts': [
    "SET schedule_status = 'completed', status = 'complete', last_run_at",   // onTaskRunComplete terminal (occurrence-gated)
    "status = 'complete',",                                                  // multi-line force-reset / recover-missing-run terminal
  ],
  // Group-delete auto-complete (janitorial; lands complete_validated=0).
  'agent/tools.ts': [
    "schedule_status = CASE WHEN schedule_status = 'unscheduled'",
  ],
};

function scanKey1(rel: string, lines: string[]): string[] {
  const allow = KEY1_ALLOW[rel] ?? [];
  const found: string[] = [];
  lines.forEach((line, i) => {
    if (isCommentLine(line)) return;
    if (line.includes('task_runs') || line.includes('projects')) return; // sibling tables, not tasks
    const isObj = STATUS_COMPLETE_OBJ.test(line);
    let isSql = false;
    if (STATUS_COMPLETE_SQL.test(line)) {
      // Confirm this literal belongs to a `tasks` UPDATE: same line, or an UPDATE
      // header within the 8 lines above (multi-line statements). This also drops
      // prose false-positives like `tracker_update_status(status='complete')` in a
      // tool description, which have no UPDATE header nearby.
      if (UPDATE_TASKS.test(line)) {
        isSql = true;
      } else {
        const above = lines.slice(Math.max(0, i - 8), i).join('\n');
        if (UPDATE_TASKS.test(above)) isSql = true;
      }
    }
    if (!isSql && !isObj) return;
    if (allow.some((s) => line.includes(s))) return;
    found.push(`${rel}:${i + 1} | unreviewed TASK status='complete' writer: ${line.trim().slice(0, 120)}`);
  });
  return found;
}

// ────────────────────────────────────────────────────────────────────────────
// KEY 2 : writers of complete_validated / pause_validated
// ────────────────────────────────────────────────────────────────────────────

// Only a real SQL column assignment that SETs the flag to a truthy value (=1 or a
// CASE that can yield 1) is locked; resets to 0 (updateTask, retask), comparisons in
// WHERE/COUNT subqueries, and the flag name inside error-message string literals are
// NOT writes. A write is either a single-line `... SET ... <flag> = 1|CASE ...` or a
// multi-line SET column line whose trimmed text STARTS with `<flag> = 1|CASE`.
function isFlagWrite(line: string, flag: string): boolean {
  const trimmed = line.trim();
  const valRe = new RegExp(`${flag}\\s*=\\s*(1\\b|CASE)`);
  if (!valRe.test(line)) return false;
  if (/\bSET\b/.test(line)) return true; // single-line UPDATE ... SET ...
  if (new RegExp(`^${flag}\\s*=`).test(trimmed)) return true; // multi-line SET column
  return false; // string literal ("already complete_validated=1"), comparison, etc.
}

const COMPLETE_VALIDATED_ALLOW: string[] = [
  "complete_validated = 1, updated_at = datetime('now') WHERE id = ?",       // tracker_validate (terminal + recurring terminal)
  "complete_validated = CASE WHEN ? = 'complete' THEN 1 ELSE complete_validated END", // tracker_override / apply_user_verdict
];

const PAUSE_VALIDATED_ALLOW: string[] = [
  "pause_validated = 1, updated_at = datetime('now') WHERE id = ?",          // tracker_validate(kind=pause)
  "pause_validated = CASE WHEN ? = 'paused' THEN 1 ELSE pause_validated END", // tracker_override / apply_user_verdict
];

function scanFlagWriters(rel: string, lines: string[], flag: string, allow: string[]): string[] {
  const found: string[] = [];
  lines.forEach((line, i) => {
    if (isCommentLine(line)) return;
    if (!isFlagWrite(line, flag)) return;
    if (allow.some((s) => line.includes(s))) return;
    found.push(`${rel}:${i + 1} | unreviewed validated-flag writer: ${line.trim().slice(0, 120)}`);
  });
  return found;
}

// ────────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────────

const KEY1_FILES = [
  ...subsystemFiles('tracker'),
  ...subsystemFiles('scheduler'),
  ...subsystemFiles('agent'),
  'agent/v2/loop.ts', // the engineCloseDeliveredTask CALL sites live here; prove it holds NO writer
];

// complete_validated is scanned across all three subsystems; pause_validated only in
// tracker/ + scheduler/ (see the SCOPING NOTE in the header).
const KEY2_COMPLETE_FILES = [
  ...subsystemFiles('tracker'),
  ...subsystemFiles('scheduler'),
  ...subsystemFiles('agent'),
  'agent/v2/loop.ts',
];
const KEY2_PAUSE_FILES = [
  ...subsystemFiles('tracker'),
  ...subsystemFiles('scheduler'),
  ...subsystemFiles('agent'),
  'agent/v2/loop.ts', // Phase 1.4 removed the pre-turn gate's pause_validated=1 writer here
];

describe('two-key KEY 1: TASK status=complete writers limited to the reviewed set', () => {
  it('every literal status=complete task writer is a reviewed definition site', () => {
    const violations = KEY1_FILES.flatMap((rel) => scanKey1(rel, readRel(rel)));
    // If this fails: a new path writes status='complete' on a task outside the
    // reviewed set. Route close-outs through the agent-request tools (they land
    // complete_validated=0 so the PM still validates); the engine must not close.
    expect(violations).toEqual([]);
  });

  it('the scan actually finds the reviewed writers (guards against silently matching nothing)', () => {
    const hits = KEY1_FILES.flatMap((rel) =>
      readRel(rel)
        .map((line, i) => ({ line, i }))
        .filter(({ line }) => !isCommentLine(line) && !line.includes('task_runs') && !line.includes('projects'))
        .filter(({ line }) => STATUS_COMPLETE_SQL.test(line) || STATUS_COMPLETE_OBJ.test(line))
        .map(({ i }) => `${rel}:${i + 1}`),
    );
    // 3 in tracker/tools.ts + 3 in scheduler/runner.ts + 1 in agent/tools.ts.
    expect(hits.length).toBeGreaterThanOrEqual(6);
  });

  it('the demolished engine close primitive no longer writes status or complete_validated', () => {
    const src = readRel('tracker/tools.ts').join('\n');
    // markDeliverableShown exists and is the authority-free replacement.
    expect(src).toMatch(/export async function markDeliverableShown/);
    // Its CODE sets ONLY deliverable_shown, never status='complete' or
    // complete_validated (comments naming those are stripped before asserting).
    const fnStart = src.indexOf('export async function markDeliverableShown');
    const fnBody = codeOnly(src.slice(fnStart, src.indexOf('export const engineCloseDeliveredTask')));
    expect(fnBody).toMatch(/deliverable_shown = 1/);
    expect(fnBody).not.toMatch(/status\s*=\s*'complete'/);
    expect(fnBody).not.toMatch(/status:\s*'complete'/);
    expect(fnBody).not.toMatch(/complete_validated/);
  });

  it('positive control: a synthetic rogue engine close is caught', () => {
    const rogue = [
      'function rogueEngineClose(taskId: string) {',
      "  db.prepare(\"UPDATE tasks SET status = 'complete', complete_validated = 1 WHERE id = ?\").run(taskId);",
      '}',
    ];
    const violations = scanKey1('tracker/rogue-synthetic.ts', rogue);
    expect(violations.length).toBe(1);
  });
});

describe('two-key KEY 2: complete_validated writers limited to verdict paths', () => {
  it('every complete_validated=1 writer is tracker_validate / tracker_override / apply_user_verdict', () => {
    const violations = KEY2_COMPLETE_FILES.flatMap((rel) =>
      scanFlagWriters(rel, readRel(rel), 'complete_validated', COMPLETE_VALIDATED_ALLOW),
    );
    expect(violations).toEqual([]);
  });

  it('finds the reviewed complete_validated writer lines', () => {
    const hits = KEY2_COMPLETE_FILES.flatMap((rel) =>
      readRel(rel)
        .map((line, i) => ({ line, i }))
        .filter(({ line }) => !isCommentLine(line) && isFlagWrite(line, 'complete_validated'))
        .map(({ i }) => `${rel}:${i + 1}`),
    );
    // 2 in tracker_validate + 1 override CASE + 1 verdict CASE = 4 lines.
    expect(hits.length).toBeGreaterThanOrEqual(4);
  });

  it('positive control: a synthetic complete_validated=1 forgery is caught', () => {
    const rogue = ["  db.prepare(\"UPDATE tasks SET complete_validated = 1 WHERE id = ?\").run(id);"];
    const violations = scanFlagWriters('tracker/rogue-synthetic.ts', rogue, 'complete_validated', COMPLETE_VALIDATED_ALLOW);
    expect(violations.length).toBe(1);
  });
});

describe('two-key KEY 2: pause_validated writers limited to verdict paths (tracker/ + scheduler/ + agent/)', () => {
  it('every pause_validated=1 writer is a PM/user verdict path (no engine pre-blessing)', () => {
    const violations = KEY2_PAUSE_FILES.flatMap((rel) =>
      scanFlagWriters(rel, readRel(rel), 'pause_validated', PAUSE_VALIDATED_ALLOW),
    );
    // If this fails: an engine path in tracker/, scheduler/, or agent/ pre-blesses
    // a pause (pause_validated=1) again. The pause must land unvalidated so the PM
    // sweep adjudicates it. alertMissedRuns lost its pre-blessing in Phase 1.6;
    // spawner.ts's terminate-pause and loop.ts's pre-turn gate lost theirs in 1.4.
    expect(violations).toEqual([]);
  });

  it('finds the reviewed pause_validated writer lines', () => {
    const hits = KEY2_PAUSE_FILES.flatMap((rel) =>
      readRel(rel)
        .map((line, i) => ({ line, i }))
        .filter(({ line }) => !isCommentLine(line) && isFlagWrite(line, 'pause_validated'))
        .map(({ i }) => `${rel}:${i + 1}`),
    );
    // validate_pause + override CASE + verdict CASE = 3 lines.
    expect(hits.length).toBeGreaterThanOrEqual(3);
  });

  it("scheduler alertMissedRuns no longer stamps pause_validated=1 (Phase 1.6)", () => {
    const runner = readRel('scheduler/runner.ts').join('\n');
    // The missed-runs pause UPDATE sets is_paused/status/missed_runs_paused_at but
    // NOT pause_validated. Assert the removed clause is gone from the CODE of that
    // function (comments explaining the removal are stripped first).
    const fnStart = runner.indexOf('function alertMissedRuns');
    const fnEnd = runner.indexOf('function pickAvailableAgentFromGroup');
    const fnBody = codeOnly(runner.slice(fnStart, fnEnd > fnStart ? fnEnd : undefined));
    expect(fnBody).toMatch(/missed_runs_paused_at = datetime\('now'\)/);
    expect(fnBody).not.toMatch(/pause_validated\s*=\s*1/);
  });

  it('positive control: a synthetic pause pre-blessing is caught', () => {
    const rogue = ["  db.prepare(\"UPDATE tasks SET status='paused', pause_validated = 1 WHERE id=?\").run(id);"];
    const violations = scanFlagWriters('scheduler/rogue-synthetic.ts', rogue, 'pause_validated', PAUSE_VALIDATED_ALLOW);
    expect(violations.length).toBe(1);
  });
});
