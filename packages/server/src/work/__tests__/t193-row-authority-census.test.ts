// t193 — THE ROW-AUTHORITY CENSUS: proof, not a sentence, that no door bypasses the gate.
//
// `work/row-authority.ts` is the one rule for who may move, edit, cancel or close a task. A rule
// that one new door can step around is a comment, so this walk reads the source and holds three
// facts, each with a planted-fault proof that it bites:
//
//   PART A — every writer of the assignee columns (`agent_id`, `assignee_agent`,
//            `assigned_to_group`) on an existing row is the gate module, or a NAMED exception
//            with its reason. A new writer fails until somebody writes its sentence here.
//   PART B — every model-reachable tracker door (each dispatch key of the work verbs) either
//            calls into the gate or is classified, with its reason, as a door the gate does not
//            govern. A new door fails until it is classified.
//   PART C — the three structural seams stay wired: `setTrackerStatus` (the tracker's one
//            status writer) asks the takeover rule; `spawn_agent` plans and moves through the
//            gate; the owner's `updateTask(assignedTo)` door has no model-side caller.
//
// Births (INSERTs) are not moves and are not walked. The scanner reads source with
// fs.readFileSync and blanks comments first, so prose about a write is never counted as one.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { trackerHandlers } from '../../agent/tools/cat/tracker.js';

const SRC = path.join(__dirname, '..', '..');
const GATE = 'work/row-authority.ts';

function walk(dir: string, acc: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const fp = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === '__tests__' || e.name === 'migrations') continue;
      walk(fp, acc);
    } else if (e.name.endsWith('.ts')) acc.push(fp);
  }
  return acc;
}
const rel = (f: string): string => path.relative(SRC, f).split(path.sep).join('/');
const read = (r: string): string => fs.readFileSync(path.join(SRC, r), 'utf8');
const stripComments = (s: string): string => s
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1: string) => p1 + ' '.repeat(m.length - p1.length));

const ASSIGNEE_COL = String.raw`(?:agent_id|assignee_agent|assigned_to_group)`;

/** The text of a call's argument list, balanced on parentheses. */
function callArgs(src: string, openParen: number): string {
  let depth = 0;
  for (let i = openParen; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')' && --depth === 0) return src.slice(openParen + 1, i);
  }
  return src.slice(openParen + 1);
}

/** Every assignee-column write in a source text, by shape. */
export function assigneeWrites(text: string): string[] {
  const src = stripComments(text);
  const hits: string[] = [];
  let m: RegExpExecArray | null;
  const patchCall = /\bpatchWork(?:Where)?\(/g;
  while ((m = patchCall.exec(src))) {
    if (new RegExp(String.raw`\b${ASSIGNEE_COL}\s*:`).test(callArgs(src, m.index + m[0].length - 1))) hits.push('patchWork literal');
  }
  const sql = /UPDATE\s+work\s+SET\b([\s\S]{0,400}?)(?=WHERE\s|`)/gi;
  while ((m = sql.exec(src))) {
    if (new RegExp(String.raw`\b${ASSIGNEE_COL}\s*=`).test(m[1]!)) hits.push('UPDATE work SET');
  }
  // A patch built up field by field before the call: any variable declared as a `WorkPatch`.
  for (const v of src.matchAll(/(?:const|let)\s+(\w+)\s*:\s*WorkPatch\b/g)) {
    const prop = new RegExp(String.raw`\b${v[1]}\.${ASSIGNEE_COL}\s*=(?!=)`, 'g');
    while ((m = prop.exec(src))) hits.push('patch property');
  }
  return hits;
}

// ── PART A's named exceptions. Each is {file: [shapes]} and a sentence. ──
const ASSIGNEE_WRITERS: Record<string, { shapes: string[]; why: string }> = {
  [GATE]: {
    shapes: ['UPDATE work SET', 'UPDATE work SET', 'UPDATE work SET'],
    why: 'THE writer: writeAssignee (clear / to an agent / to a group). Every move and the owner\'s dashboard door go through it.',
  },
  'tracker/tools.ts': {
    shapes: ['patchWork literal'],
    why: 'BIRTH: trackerCreateTask assigns a just-created task to the group its creator named. Nothing is taken from anybody.',
  },
  'work/occurrences.ts': {
    shapes: ['UPDATE work SET'],
    why: 'assignOccurrence records who RUNS one scheduled fire on the occurrence row (kind=occurrence, not a tracker task); the task\'s own holder does not change.',
  },
  'work/store.ts': {
    shapes: ['UPDATE work SET'],
    why: 'repointJoinPieceToHandOff moves an a2a join PIECE (outside taskScope) and refuses anyone but the piece\'s own assignee — the holder handing its own piece on.',
  },
  'agent/groups.ts': {
    shapes: ['patchWork literal'],
    why: 'deleteGroup clears a dangling group reference when the group itself is deleted; no task moves to anybody.',
  },
};

describe('PART A — every assignee-column writer is the gate or a named exception', () => {
  it('the scanner bites: a planted patch, SQL update and property write are all caught', () => {
    expect(assigneeWrites('patchWork(id, { agent_id: x, title: y })')).toEqual(['patchWork literal']);
    expect(assigneeWrites('db.prepare(`UPDATE work SET assignee_agent = ? WHERE id = ?`)')).toEqual(['UPDATE work SET']);
    expect(assigneeWrites('const patch: WorkPatch = {}; patch.agent_id = to;')).toEqual(['patch property']);
    expect(assigneeWrites('const row = get(); row.agent_id === me;')).toEqual([]);
    expect(assigneeWrites('// patchWork(id, { agent_id: x })')).toEqual([]);
    expect(assigneeWrites('patchWork(id, { title: y })')).toEqual([]);
  });

  it('the measured writers equal the declared list, in both directions', () => {
    const found: Record<string, string[]> = {};
    for (const f of walk(SRC).map(rel).sort()) {
      const hits = assigneeWrites(read(f));
      if (hits.length > 0) found[f] = hits;
    }
    const declared = Object.fromEntries(Object.entries(ASSIGNEE_WRITERS).map(([f, e]) => [f, e.shapes]));
    expect(found).toEqual(declared);
  });
});

// ── PART B: the model-reachable tracker doors ──
const GATE_CALL = /\b(?:taskWriteRefusal|moveAssignee|projectCloseRefusal|takeoverRefusal|checkMove|planSpawnTask)\(/;

/** Doors the gate deliberately does not govern, each with its reason. */
const UNGOVERNED: Record<string, string> = {
  'work_open:project': 'BIRTH: a new row; its creator is its holder',
  'work_open:task': 'BIRTH: a new row; the creator names its first assignee',
  'work_open:reminder': 'BIRTH: a reminder for the owner',
  'work_open:commitment': 'a commitment is the agent\'s own promise, not a tracker task',
  'work_close_request:commitment': 'closes the caller\'s own commitment, not a tracker task',
  'work_update:get': 'READ',
  'work_update:list': 'READ',
  'work_update:activity': 'READ',
  'work_note': 'an observation on the record, open to any agent that can read the task (tasks report item 4)',
  'work_validate:validate': 'PM-only (PM_ONLY_WORK_OPS); the PM is an editor (dec 3) and adjudicates, never moves',
  'work_validate:retask': 'PM-only; re-drives the SAME holder (dec 1: keep agents working)',
  'work_validate:override': 'PM-only; the request it resolves was filed through the gated override-request door',
  'work_validate:apply_user_verdict': 'PM-only; applies the owner\'s own verdict',
  'work_validate:apply_user_validation': 'primary-only; applies the owner\'s own reply',
  'work_close_request:user_verdict': 'refused to anyone but the assigned agent by its own check',
};

/** The tracker function a handler delegates to, read from the handler's own source. */
const HANDLER_SRC = stripComments(read('agent/tools/cat/tracker.ts'));
function handlerBody(key: string): string {
  const start = HANDLER_SRC.indexOf(`async "${key}"(`);
  const next = HANDLER_SRC.indexOf('\n  async "', start + 1);
  return HANDLER_SRC.slice(start, next < 0 ? undefined : next);
}
const TOOLS_SRC = stripComments(read('tracker/tools.ts'));
function functionBody(name: string): string {
  const m = new RegExp(String.raw`\nexport (?:async )?function ${name}\(`).exec(TOOLS_SRC);
  if (!m) return '';
  const rest = TOOLS_SRC.slice(m.index + 1);
  const end = rest.search(/\n(?:export )?(?:async )?function /);
  return end < 0 ? rest : rest.slice(0, end);
}

describe('PART B — every model-reachable tracker door calls the gate or is classified', () => {
  const keys = Object.keys(trackerHandlers).sort();

  it('the classification covers every live door, and names no door that is gone', () => {
    expect(keys.length, 'the walk is measuring air').toBeGreaterThan(20);
    for (const k of Object.keys(UNGOVERNED)) expect(keys, `stale classification: ${k}`).toContain(k);
  });

  for (const key of Object.keys(trackerHandlers).sort()) {
    if (UNGOVERNED[key]) continue;
    it(`${key} reaches the row-authority gate`, () => {
      const body = handlerBody(key);
      expect(body.length, `${key} has no handler body`).toBeGreaterThan(0);
      const inner = [...body.matchAll(/\b(tracker[A-Z]\w+)\(/g)].map((m) => m[1]!);
      const gated = GATE_CALL.test(body) || (inner.length > 0 && inner.every((fn) => GATE_CALL.test(functionBody(fn))));
      expect(gated, `${key} (→ ${inner.join(', ') || 'inline'}) writes a task row without asking the gate`).toBe(true);
    });
  }

  it('the door check bites: a tracker function without a gate call is detected', () => {
    expect(GATE_CALL.test('function trackerX() { patchWork(id, { title }); }')).toBe(false);
  });
});

// ── PART C: the structural seams ──
describe('PART C — the seams that make the gate unbypassable stay wired', () => {
  it('setTrackerStatus, the tracker\'s one status writer, asks the takeover rule', () => {
    const src = stripComments(read('work/tracker-store.ts'));
    const body = src.slice(src.indexOf('export function setTrackerStatus('));
    expect(body.slice(0, body.indexOf('withUnit('))).toMatch(/takeoverRefusal\(/);
  });

  it('spawn_agent plans before it spawns and moves through the gate', () => {
    const src = stripComments(read('agent/tools/cat/agents.ts'));
    const body = src.slice(src.indexOf('async "spawn_agent"('), src.indexOf('\n  async "', src.indexOf('async "spawn_agent"(') + 1));
    expect(body.indexOf('planSpawnTask(')).toBeGreaterThan(0);
    expect(body.indexOf('planSpawnTask(')).toBeLessThan(body.indexOf('spawnAgent('));
    expect(body).toMatch(/moveAssignee\(/);
    expect(body).not.toMatch(/keep_assignment/);
  });

  it('the owner\'s updateTask(assignedTo) door has no model-side caller', () => {
    const callers = walk(SRC).map(rel).filter((f) => /\bupdateTask\(/.test(stripComments(read(f))) && f !== 'tracker/schema.ts');
    expect(callers.sort()).toEqual(['gateway/routes/tracker.ts', 'tracker/tools.ts']);
    // tracker/tools.ts builds its updates without an assignee, in both of its callers.
    expect(TOOLS_SRC).not.toMatch(/updates\.assignedTo\s*=/);
    expect(functionBody('trackerUpdateStatus')).not.toMatch(/assignedTo:\s/);
  });
});
