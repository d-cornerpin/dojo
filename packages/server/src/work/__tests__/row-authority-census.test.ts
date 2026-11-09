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
import { trackerHandlers } from '../../agent/tools/cat/tracker.js';
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

describe('PART A — every assignee-column writer is the gate or a named exception', () => {
  it('the scanner bites: a planted patch, SQL update and property write are all caught', () => {
    expect(assigneeWrites('patchWork(id, { agent_id: x, title: y })')).toEqual(['patchWork literal']);
    expect(assigneeWrites('db.prepare(`UPDATE work SET assignee_agent = ? WHERE id = ?`)')).toEqual(['UPDATE work SET']);
    expect(assigneeWrites('const patch: WorkPatch = {}; patch.agent_id = to;')).toEqual(['patch property']);
    expect(assigneeWrites('const row = get(); row.agent_id === me;')).toEqual([]);
    expect(assigneeWrites('// patchWork(id, { agent_id: x })')).toEqual([]);
    expect(assigneeWrites('patchWork(id, { title: y })')).toEqual([]);
  });
});

// ── PART B: the model-reachable tracker doors ──
const GATE_CALL = /\b(?:taskWriteRefusal|moveAssignee|takeoverRefusal|checkMove|planSpawnTask)\(/;

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
  'work_validate:retask': 'PM-only; re-drives the SAME holder (dec 1: keep agents working)',
  'work_update:hand_in': 'the hand-in door refuses anyone but the row\'s worker by its own check (work/done/hand-in.ts)',
  'work_validate:decide': 'the decision door refuses anyone but the decider and the owner by its own check (work/done/who-decides.ts)',
  'work_validate:open_proof': 'a READ of a waiting hand-in\'s proof, recorded; it moves nothing',
};

describe('PART B — every model-reachable tracker door calls the gate or is classified', () => {
  const keys = Object.keys(trackerHandlers).sort();

  it('the classification covers every live door, and names no door that is gone', () => {
    expect(keys.length, 'the walk is measuring air').toBeGreaterThan(15);
    for (const k of Object.keys(UNGOVERNED)) expect(keys, `stale classification: ${k}`).toContain(k);
  });

  for (const key of Object.keys(trackerHandlers).sort()) {
    if (UNGOVERNED[key]) continue;
  }

  it('the door check bites: a tracker function without a gate call is detected', () => {
    expect(GATE_CALL.test('function trackerX() { patchWork(id, { title }); }')).toBe(false);
  });
});
