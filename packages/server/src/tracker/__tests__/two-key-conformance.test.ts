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
// WHY WRITER DEFINITION SITES, NOT CALL SITES: scanning by the SQL/update writer
// that actually mutates the row (not by who calls a helper) keeps this test green
// across caller renames (the engineCloseDeliveredTask alias was removed 2026-07-21
// once every call site referenced markDeliverableShown). Only a rogue NEW writer
// (a fresh UPDATE that closes or stamps outside the reviewed set) trips it.
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
// PHASE-2 T8b: the mechanism moved and this scan moved with it. A KEY-1 close is no longer
// a literal `status = 'complete'` UPDATE — `transition()` is the only writer of state, so a
// close is a `setTrackerStatus(<id>, 'complete', …)` (or `setTaskStatus`) call. The scan
// looks for THAT, plus the old SQL form, which must now find nothing anywhere: an UPDATE
// that sets the state directly is the exact forgery this file exists to refuse, and the
// single-writer walk refuses it a second time from the other side.
const STATUS_COMPLETE_SQL = /state\s*=\s*'done'/;
const STATUS_COMPLETE_OBJ = /set(?:Tracker|Task)Status(?:Result)?\([^)]*,\s*'complete'/;
// A tasks-table UPDATE header (\b after `tasks` excludes `task_runs`; `projects` is a
// different word entirely). Used to confirm a literal SQL match targets `tasks`.
const UPDATE_TASKS = /\bUPDATE\s+work\b/;   // PHASE-2 T2 renamed the table; T8b moved the rows onto it

// The reviewed writer definition sites. A KEY-1 writer line is compliant iff, for its
// file, one of these substrings is present in the line (or, for scheduler/runner.ts
// multi-line writers, the bare `status = 'complete',` clause). Anything else is a
// rogue close and fails.
const KEY1_ALLOW: Record<string, string[]> = {
  // Agent-request close-outs. Every one lands with NO upheld adjudication, which is what
  // `complete_validated = 0` meant: the PM's key still turns.
  'tracker/tools.ts': [
    "reason: 'agent asserts every run is done; the schedule stops here'",   // complete_all_runs
    "reason: 'schedule stopped and the work marked complete'",              // work_schedule(action="pause", mark_complete)
    // PHASE-2 T8V: these two reasons name the verb that wrote them, and the verb
    // was renamed. Same two definition sites, same two writes, same review — only
    // the literal the scan matches moved, in the same change as the product.
    "reason: 'work_update(action=\"complete_step\"): the step is finished'",
    "reason: `work_update(action=\"status\") -> ${String(statusUpdate)}`",
    // Narrow carve-out (demolition Phase 1.7 #2): closeEngineScaffoldSameTurn. The ONLY
    // engine close of its OWN same-turn scaffold, and it now has to POINT AT the delivery
    // (G6+G7) rather than assert it.
    "reason: 'engine closed its own same-turn scaffold against the delivered reply (unvalidated; the PM sweep validates)'",
    // Owner ruling 2026-07-19: Key-1 filed from the assignment-thread deliverable receipt.
    "reason: 'the assignee returned a terminal deliverable on its ASSIGN thread; Key 1 filed from that receipt'",
    // The project umbrella, closed against its last finished child's real delivery.
    "reason: 'every task on this project is complete'",
    "reason: `bulk-closed with its project: ${reason}`",
  ],
  // Scheduler recurring advance + recurring-terminal janitorial writers.
  'scheduler/runner.ts': [
    "reason: 'the schedule ran out of occurrences and the last run succeeded'",
    "reason: 'a recurring task with no recoverable next run is finished'",
    "reason: 'stuck recurring task has no future runs left'",
  ],
  // Group-delete auto-complete (janitorial).
  'agent/tools.ts': [
    "reason: 'the group this task belonged to was deleted and its members terminated'",
  ],
  // Delivery-receipt close, strike 2 of the drive backup lane (2026-07-22 production
  // incident). The engine closes ONLY on records it can point at, and G6 now enforces that
  // rather than a comment.
  'tracker/pm-agent.ts': [
    'evidenceRef: strike2Delivery, resultDeliveryId: strike2Delivery,',
  ],
  // Strike-0 receipt close at the turn boundary: the SAME-TURN form of strike 2.
  'agent/v2/loop.ts': [
    'evidenceRef: strike0Delivery,',
  ],
  // The apprentice's own complete_task, and its lineage-scoped dangler sweep.
  'agent/spawner.ts': [
    'reason: `apprentice "${agent.name}" called complete_task(status="${status}")`',
    "reason: sameWork",
  ],
  // The healer's all-children-complete project rollup.
  'healer/auto-fix.ts': [
    "reason: 'every task on this project is complete; closing the project to match'",
  ],
  // The dashboard: the owner IS the authority (Q5), and says so with claim: 'authoritative'.
  'gateway/routes/tracker.ts': [
    "claim: 'authoritative',",
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
    // The reviewed reason rides the call's ARGUMENT OBJECT, so the window is the call, not
    // the line: a close that states no reviewed reason is what this scan is for.
    const block = lines.slice(i, i + 9).join('\n');
    if (allow.some((s) => block.includes(s))) return;
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

// PHASE-2 T8b: KEY 2 is an ADJUDICATION ROW now, not a flag column (research 19 §1c). The
// scan therefore locks the two ways an uphold can be written — the explicit `upholdClaim`
// call, and `transition()`'s own `claim: 'authoritative'` — instead of a column assignment.
// The refusal is the same one: nobody may turn the PM's key except a verdict path.
const COMPLETE_VALIDATED_ALLOW: string[] = [
  "upholdClaim(taskId, 'done', 'pm', pmAgentId,",        // tracker_validate (terminal + recurring terminal)
  "upholdClaim(taskId, statusToState(task.status), 'owner', 'user',", // apply_user_validation
  "upholdClaim(resolved.id, statusToState(task.status), 'owner', 'user',", // the dashboard's user-validate route
];

const PAUSE_VALIDATED_ALLOW: string[] = [
  "upholdClaim(taskId, 'paused', 'pm', pmAgentId,",       // tracker_validate(kind=pause)
  "upholdClaim(taskId, statusToState(task.status), 'owner', 'user',",
  "upholdClaim(resolved.id, statusToState(task.status), 'owner', 'user',",
];

/** An uphold of the claim `flag` names: `upholdClaim(<id>, '<state>' | statusToState(...), …)`.
 *  Keyed on the STATE the flag was about, which is the same fact under its spine name. */
function isUpholdWrite(line: string, flag: string): boolean {
  if (!/upholdClaim\s*\(/.test(line)) return false;
  const state = flag === 'complete_validated' ? 'done' : flag === 'pause_validated' ? 'paused' : 'blocked';
  return line.includes(`'${state}'`) || line.includes('statusToState(');
}

function scanFlagWriters(rel: string, lines: string[], flag: string, allow: string[]): string[] {
  const found: string[] = [];
  lines.forEach((line, i) => {
    if (isCommentLine(line)) return;
    if (!isUpholdWrite(line, flag)) return;
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
  'agent/v2/loop.ts', // the markDeliverableShown CALL sites live here; prove it holds NO writer
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

  // ── PHASE-2 T8c item 2 — DELIBERATE DISPOSITION, NAMED (T0 concern adjudication 1).
  // The second of the two clauses PINNED §12 flags as dying with the column. VERDICT: IT
  // DOES NOT DIE HERE EITHER, AND IT IS KEPT. It asserts a live, checkable property — no
  // code anywhere writes the column — and that property is exactly what makes the column
  // safe to drop. Retiring it in the same change that strips the PM's reads would remove
  // the guarantee one step BEFORE the step that depends on it. T10 retires it in the same
  // change that drops the column, which is what the adjudication actually said; T8c's job
  // was to land the backstop's own test first, and that is
  // `retask-delivered-work-backstop.test.ts`.
  it('the hidden-status stamp is fully demolished: no writer of deliverable_shown exists (P2 drive boundary)', () => {
    // Owner status-truth invariant (2026-07-21): a flag that contradicts the
    // visible status is banned. markDeliverableShown (the last writer) was
    // deleted; the column remains as read-only legacy data. A NEW writer
    // anywhere in the scanned surface is a contract breach.
    const files = [...KEY1_FILES];
    for (const rel of files) {
      const code = codeOnly(readRel(rel).join('\n'));
      expect(code, `${rel} writes deliverable_shown (banned hidden status)`).not.toMatch(/UPDATE[^;]{0,300}SET[^;]{0,200}deliverable_shown\s*=\s*1/i);
      expect(code, `${rel} writes deliverable_shown via object param`).not.toMatch(/deliverable_shown:\s*1/);
    }
    const tools = readRel('tracker/tools.ts').join('\n');
    expect(tools).not.toMatch(/export async function markDeliverableShown/);
  });

  it('positive control: a synthetic rogue engine close is caught', () => {
    const rogue = [
      'function rogueEngineClose(taskId: string) {',
      "  db.prepare(\"UPDATE work SET state = 'done' WHERE id = ?\").run(taskId);",
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
        .filter(({ line }) => !isCommentLine(line) && isUpholdWrite(line, 'complete_validated'))
        .map(({ i }) => `${rel}:${i + 1}`),
    );
    // 2 in tracker_validate + the two owner-verdict paths.
    expect(hits.length).toBeGreaterThanOrEqual(3);
  });

  it('positive control: a synthetic complete_validated=1 forgery is caught', () => {
    const rogue = ["  upholdClaim(id, 'done', 'engine', 'engine', 'I say it is fine');"];
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
        .filter(({ line }) => !isCommentLine(line) && isUpholdWrite(line, 'pause_validated'))
        .map(({ i }) => `${rel}:${i + 1}`),
    );
    // PHASE-2 T8b: validate_pause's uphold + apply_user_validation's = 2 in the scanned
    // subsystems (the dashboard's owner-validate route is under gateway/, outside this file
    // set, and is covered by the KEY-1 allowlist there).
    expect(hits.length).toBeGreaterThanOrEqual(2);
  });

  it("scheduler alertMissedRuns no longer stamps pause_validated=1 (Phase 1.6)", () => {
    const runner = readRel('scheduler/runner.ts').join('\n');
    // The missed-runs pause UPDATE sets is_paused/status/missed_runs_paused_at but
    // NOT pause_validated. Assert the removed clause is gone from the CODE of that
    // function (comments explaining the removal are stripped first).
    const fnStart = runner.indexOf('function alertMissedRuns');
    const fnEnd = runner.indexOf('function pickAvailableAgentFromGroup');
    const fnBody = codeOnly(runner.slice(fnStart, fnEnd > fnStart ? fnEnd : undefined));
    expect(fnBody).toMatch(/missed_runs_paused_at: Date\.now\(\)/);
    expect(fnBody).not.toMatch(/pause_validated\s*=\s*1/);
  });

  it('positive control: a synthetic pause pre-blessing is caught', () => {
    const rogue = ["  upholdClaim(id, 'paused', 'engine', 'engine', 'pre-blessing my own pause');"];
    const violations = scanFlagWriters('scheduler/rogue-synthetic.ts', rogue, 'pause_validated', PAUSE_VALIDATED_ALLOW);
    expect(violations.length).toBe(1);
  });
});


// ── Ticket-stamp write locks (DOJO-TICKET-STAMPS-PLAN §5, 2026-07-22) ──
// The stamp writer updates engine-observed state columns on tasks. Two hard
// rules, each a build-failing scan with a positive control:
//   1. A stamp UPDATE never touches updated_at: the drive ladder's idle clock
//      (pm-agent idleSeconds) and both close-out windows read it; touching it
//      would mark stalled work "fresh" forever and silence every poke.
//   2. A stamp UPDATE never touches status or any *_validated column: stamps
//      inform, they never turn either key.
describe('ticket stamps: stamp writers are updated_at-free and status-free', () => {
  const STAMP_COLS = /last_activity_|last_answered_|last_delivery_/;
  const FORBIDDEN = [/\bupdated_at\b/, /\bstatus\s*=/, /complete_validated/, /pause_validated/, /blocked_validated/];

  function stampUpdateBlocks(text: string): string[] {
    const blocks: string[] = [];
    const re = /UPDATE\s+work\s+SET[\s\S]{0,600}?(?:WHERE[^\n]*)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      if (STAMP_COLS.test(m[0])) blocks.push(m[0]);
    }
    return blocks;
  }

  it('every stamp UPDATE in the tree obeys both rules', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const srcRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    const files: string[] = [];
    (function walk(d: string) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const fp = path.join(d, e.name);
        if (e.isDirectory()) { if (!fp.includes('__tests__') && !fp.includes('node_modules')) walk(fp); }
        else if (e.name.endsWith('.ts')) files.push(fp);
      }
    })(srcRoot);
    const violations: string[] = [];
    let found = 0;
    for (const f of files) {
      const text = fs.readFileSync(f, 'utf8');
      for (const block of stampUpdateBlocks(text)) {
        found++;
        for (const bad of FORBIDDEN) {
          if (bad.test(block)) violations.push(`${path.relative(srcRoot, f)}: stamp UPDATE touches forbidden pattern ${bad}: ${block.slice(0, 140)}`);
        }
      }
    }
    // ── PHASE-2 T8c item 2 — THE SUBJECT OF THIS GUARD MOVED, SO THE GUARD MOVED WITH IT.
    // The requirement is unchanged and is the P2 one: a ticket stamp must never touch the
    // drive ladder's idle clock or any status/validation column. It used to be a promise
    // about a SET list, which is why it needed policing. The six stamp columns are now
    // `work_events` rows of kind `activity` (`work/tracker-store.ts:stampTicket` ->
    // `appendWorkEvent`), so the property holds BY CONSTRUCTION: an append to an event log
    // has no `updated_at` in reach.
    //
    // The old non-vacuity assertion was `found >= 1` — "there is at least one stamp UPDATE
    // to police". Keeping it would demand the very statement this task deleted. It is
    // replaced by the STRONGER assertion in the same breath: there must be NO stamp UPDATE
    // anywhere, and the violation scan below still runs so a re-introduced one is caught by
    // BOTH clauses. The positive control underneath is untouched and still proves the
    // scanner sees a forged UPDATE.
    expect(found, `a stamp UPDATE re-appeared in the tree; ticket stamps are work_events rows now (T8c item 2). Found: ${found}`).toBe(0);
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('the stamp writer is an EVENT APPEND, and it is the only one', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const srcRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    const store = fs.readFileSync(path.join(srcRoot, 'work/tracker-store.ts'), 'utf8');
    const fn = store.slice(store.indexOf('export function stampTicket'));
    const body = fn.slice(0, fn.indexOf('\n}\n') + 2);
    // It appends the activity event...
    expect(body).toMatch(/appendWorkEvent\(workId, WORK_EVENT\.activity/);
    // ...and it does not reach for the drive clock or a state column on the way.
    expect(body).not.toMatch(/updated_at/);
    expect(body).not.toMatch(/UPDATE\s+work/);
  });

  it('positive control: a forged stamp UPDATE touching updated_at is caught', () => {
    const forged = "UPDATE work SET last_activity_turn = ?, updated_at = ? WHERE id = ?";
    const blocks = stampUpdateBlocks(forged);
    expect(blocks.length).toBe(1);
    expect(FORBIDDEN.some((bad) => bad.test(blocks[0]))).toBe(true);
  });
});
