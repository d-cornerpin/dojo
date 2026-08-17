// ════════════════════════════════════════════════════════════════════════════════════════
// S2 (PHASE-3 T3) — one declaration for the 17 shared work-verb properties, and PROOF that
// the model reads exactly the same bytes it read before.
//
// The tools array is the head of the cached prefix. A refactor that changes one byte of it
// invalidates ~24.7K tokens for every agent on its next call — so "this change is
// structural only" is a claim that has to be measured, not asserted. The baseline below was
// captured from `8f36cdb` (before the rewire) by serialising both verbs' `input_schema`.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  WORK_SHARED_PROPERTIES,
  WORK_PRIORITY_ENUM,
  WORK_FIELD_TEXT,
  WORK_EDITABLE_TASK_FIELDS,
  workProp,
} from '../work-verb-schema.js';

// PHASE-5 T4: the wire array moved to `agent/tools/definitions.ts` byte-identical.
// This walk reads the SOURCE TEXT, so the path follows the code — that is the point
// of a source walk, and a stale path here would have failed loudly (it did).
const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'definitions.ts');

/**
 * Read the two verbs' schemas out of the source rather than importing the module, whose
 * module graph pulls in the whole server. The literals are pure data — the same
 * brace-match-then-evaluate method §T0-E used, and it cross-checked to 1.5% against an
 * independent path.
 */
function schemaOf(name: string): Record<string, unknown> {
  const src = fs.readFileSync(SRC, 'utf8');
  const i = src.indexOf(`name: '${name}'`);
  if (i < 0) throw new Error(`tool not found: ${name}`);
  const j = src.indexOf('input_schema:', i);
  const k = src.indexOf('{', j);
  let depth = 0;
  let e = k;
  for (; e < src.length; e++) {
    const c = src[e];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { e++; break; } }
  }
  const body = src.slice(k, e)
    // The rewired sites call workProp(...); evaluate them against the real module.
    .replace(/\bworkProp\(/g, '__workProp(')
    .replace(/\bWORK_PRIORITY_ENUM\b/g, '__PRIORITY_ENUM')
    // N1: the seven collapsed fields interpolate the canonical wording from the module.
    .replace(/\bWORK_FIELD_TEXT\b/g, '__FIELD_TEXT');
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const fn = new Function('__workProp', '__PRIORITY_ENUM', '__FIELD_TEXT', `return (${body});`);
  return fn(workProp, WORK_PRIORITY_ENUM, WORK_FIELD_TEXT) as Record<string, unknown>;
}

// Captured at `8f36cdb`, BEFORE the S2 rewire, by serialising both verbs' input_schema.
// S2 left these UNCHANGED (its whole claim). N1 (post-exit, owner-approved 2026-08-01)
// moved them ON PURPOSE — it is the wording collapse — and these are the measured
// post-collapse counts at `9a995ca`+N1:
//   work_open  5,623 → 5,628  (+5: "UTC", the one clause only work_update carried,
//                              survives in the canonical)
//   work_update 7,008 → 6,310 (−698: seven paraphrases replaced by routing + a pointer)
// Net −693 wire chars on the two verbs' input_schema, on every turn, forever.
const S2_BASELINE_CHARS = { work_open: 5623, work_update: 7008 };
const N1_BASELINE_CHARS = { work_open: 5628, work_update: 6310 };

// ── PHASE-6 T0C-W — THE PIN MOVES, AND IT MOVES UPWARD ON PURPOSE ───────────────────────
// The owner decided to wire the census seeds through the agent door ("Yes, wire both"),
// on the trade-off stated: `work_open` gains `local_time` + `local_timezone`, `work_update`
// gains those two plus `revert_to_original`, and each is cached-prefix bytes on every turn
// forever. Measured, not estimated:
//   work_open   5,628 → 6,327  (+699)
//   work_update 6,310 → 7,058  (+748)
//   ── total                    +1,447 chars on the two verbs' input_schema
// That is the whole diff. It bought three things that were ADVERTISED AND UNREACHABLE:
// the wall-clock schedule input the tool's own success echo told the model to use, the
// same on reminders, and the escape hatch the exact-revert refusal named. `tz` was NOT
// declared — a second spelling of `local_timezone` would have cost more bytes for no new
// capability, so its declaration is retired and its read kept (the ruling lives in
// `agent/tools/__tests__/effects-conformance.test.ts`).
// This is the change the golden re-bless of `checks/golden/cache-prefix.kevin.txt`
// records, and the numbers here are the same ones the prefix differ counts.
const T0CW_BASELINE_CHARS = { work_open: 6327, work_update: 7058 };

// ── UX-REPAIR T5 — ONE PROPERTY GAINS AN EXISTENCE CONTRACT, AND IT COSTS 253 CHARS ─────
// On the PREFIX RE-BLESSING REGISTER for this phase, so it is a reviewed re-blessing rather
// than a silent creep. Measured, not estimated:
//   work_open   6,327 → 6,327  (+0 — untouched; this edit is `work_update` only)
//   work_update 7,058 → 7,311  (+253)
// WHAT THE 253 BUY. `work_update.task_id` demanded an id and said nothing about where one
// comes from, and the description it sits inside is an END-OF-TURN DECISION MATRIX that
// pushes status transitions hard. In S1 of the 2026-08-09 UX review a ronin agent called
// `action="list"`, was told "No active tasks", and then called this tool with
// `task_id:"placeholder"` — it invented an id against evidence in its own context. The
// declaration now names the only two sources of a real id (`work_open`'s return value, or a
// row from `action="list"`) and refuses invention in as many words.
// THIS IS A DECLARATION FIX, NOT COACHING CREEP — the guard below still holds: the property
// count is unchanged, so no new capability was smuggled in with the bytes, and the second
// half of T5's solve (`work_open` onto `SUB_AGENT_ALWAYS_LOADED`) is what makes the contract
// followable by the agent that broke it, since it could not reach `work_open` in one call.
const T5_BASELINE_CHARS = { work_open: 6327, work_update: 7311 };

// ── UX-REPAIR ROUND 3 T18 — THE TWO TERMINAL OUTCOMES READ AS TWO, AND IT COSTS 295 CHARS ─
// On this sitting's PREFIX RE-BLESSING REGISTER (the tool-doc status vocabulary), so it is a
// reviewed re-blessing rather than silent creep. Measured, not estimated:
//   work_open   6,327 → 6,327  (+0 — untouched; this edit is `work_update.status` only)
//   work_update 7,311 → 7,606  (+295)
// WHAT THE 295 BUY, and why they are a DECLARATION FIX rather than coaching. `cancelled` was
// ALREADY in this enum and already schema-legal for action="status" — the tool accepted it
// and then silently rewrote it to `fallen`, the failure word, so the user's own cancellation
// came back to them as "Fallen"/"Failed" in coral and the agent got nudged that the project
// "ended with failed pieces". Meanwhile the description said `"fallen" = abandoned/dropped`
// while `templates/PM-SOUL.md:25` said "Fatally failed, not recoverable" — one word carrying
// two meanings, never reconciled. The value now lands on the spine's `abandoned` terminal, so
// the description states which outcome is which and when to reach for each.
// THE GUARD BELOW STILL HOLDS: the property count is unchanged and the ENUM is unchanged —
// not one new value, not one new property. The bytes are the meaning of values that were
// already declared.
const T18_BASELINE_CHARS = { work_open: 6327, work_update: 7606 };

// ── UX-REPAIR ROUND 14 T65 — THE ACTIVITY WINDOW, AND IT COSTS 312 CHARS ────────────────
// The round's ONE registered prefix re-blessing (OR7), and unlike T5 and T18 this one DOES
// add a capability, deliberately and by exactly one property. Measured, not estimated:
//   work_open   6,327 → 6,327  (+0 — untouched; this edit is `work_update` only)
//   work_update 7,606 → 7,918  (+312)
// The same 312 measured a second, independent way: `dojo-test-kit/checks/golden/
// cache-prefix.kevin.txt`'s tools half moved 72,304 → 72,616 across the re-bless, and the
// previous golden with ONLY this property inserted equals the new one byte-for-byte.
// WHAT THE 312 BUY: T60 built the activity door with its window as a renderer argument and
// recorded that widening it to the wire was "one declared property on the next affordable
// prefix re-bless". Round-14 S2 priced the deferral — the owner asked what had changed
// "since yesterday morning", the door covered today, 61 ledger rows were outside it and the
// reply disclosed none of them. So `hours` is declared, and the guard below is the inverse of
// T5's and T18's: this edit must add EXACTLY ONE property and must not touch an enum.
const BASELINE_CHARS = { work_open: 6327, work_update: 7918 };

describe('S2 + N1 — the shared declaration, and the wording said once', () => {
  const open = schemaOf('work_open');
  const upd = schemaOf('work_update');

  it('serialises to exactly the measured byte count — the tools array is cached-prefix bytes', () => {
    expect(JSON.stringify(open).length).toBe(BASELINE_CHARS.work_open);
    expect(JSON.stringify(upd).length).toBe(BASELINE_CHARS.work_update);
  });

  it('T0C-W — the wire-through cost is EXACTLY the five new properties, and it is measured', () => {
    // The pin above says "these are the bytes". This one says WHY they moved, so a later
    // reader cannot mistake a coaching-text creep for the owner's decided +1,447. Anything
    // that lands here without adding a declared property is a rewording nobody approved.
    expect(T0CW_BASELINE_CHARS.work_open - N1_BASELINE_CHARS.work_open).toBe(699);
    expect(T0CW_BASELINE_CHARS.work_update - N1_BASELINE_CHARS.work_update).toBe(748);
    const po = (open as { properties: Record<string, unknown> }).properties;
    const pu = (upd as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(po)).toContain('local_time');
    expect(Object.keys(po)).toContain('local_timezone');
    expect(Object.keys(pu)).toContain('local_time');
    expect(Object.keys(pu)).toContain('local_timezone');
    expect(Object.keys(pu)).toContain('revert_to_original');
    // The retirement, pinned on the wire side too: `tz` never reaches the tools array.
    expect(Object.keys(po), 'work_open declares the retired `tz` alias').not.toContain('tz');
    expect(Object.keys(pu), 'work_update declares the retired `tz` alias').not.toContain('tz');
  });

  it('UX-REPAIR T5 — the +253 is `task_id`\'s existence contract and nothing else', () => {
    // The pin moved; this is the clause that says a rewording nobody approved cannot hide
    // inside the move. Same shape as the T0C-W guard above, inverted: T0C-W had to ADD
    // properties to earn its bytes, and this one has to add NONE.
    expect(T5_BASELINE_CHARS.work_open - T0CW_BASELINE_CHARS.work_open).toBe(0);
    expect(T5_BASELINE_CHARS.work_update - T0CW_BASELINE_CHARS.work_update).toBe(253);
    const pu = (upd as { properties: Record<string, unknown> }).properties;
    // And the bytes landed where they were declared to land.
    const taskId = String((pu.task_id as { description?: string }).description ?? '');
    expect(taskId).toMatch(/ALREADY EXISTS/);
    expect(taskId).toMatch(/work_open/);
    expect(taskId).toMatch(/NEVER invent an id/);
  });

  it('UX-REPAIR ROUND 14 T65 — the +312 is ONE declared window property, and the enums hold', () => {
    // The inverse of the two guards above: T5 and T18 had to add NO capability to earn their
    // bytes, and this one had to add EXACTLY ONE property — so a rewording nobody approved
    // cannot hide inside the move, and neither can a second property.
    expect(BASELINE_CHARS.work_open - T18_BASELINE_CHARS.work_open).toBe(0);
    expect(BASELINE_CHARS.work_update - T18_BASELINE_CHARS.work_update).toBe(312);
    const pu = (upd as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(pu)).toHaveLength(33);
    expect(Object.keys(pu)).toContain('hours');
    const hours = pu.hours as { type: string; description: string };
    expect(hours.type).toBe('number');
    expect(hours.description).toMatch(/how many hours back the window covers/);
    expect(hours.description, 'the door states the window it measured, and the declaration says so')
      .toMatch(/states the window it actually measured/);
    // NO ENUM MOVED. `activity` stays advertised in the list door's own tool result, where T60
    // put it — declaring it here would have been a second delta on the same re-blessing.
    expect((pu.action as { enum: string[] }).enum).toEqual(
      ['status', 'edit', 'reassign', 'complete_step', 'close_project', 'list', 'get'],
    );
    expect((pu.status as { enum: string[] }).enum).toEqual(
      ['on_deck', 'in_progress', 'complete', 'blocked', 'fallen', 'paused', 'cancelled'],
    );
    // And `work_open` did not move at all: the whole delta is on this one verb.
    expect(JSON.stringify(open).length).toBe(T18_BASELINE_CHARS.work_open);
  });

  it('UX-REPAIR ROUND 3 T18 — the +295 is the status vocabulary and nothing else', () => {
    // Same inverted guard, one re-blessing later: this edit also has to add NO capability.
    expect(T18_BASELINE_CHARS.work_open - T5_BASELINE_CHARS.work_open).toBe(0);
    expect(T18_BASELINE_CHARS.work_update - T5_BASELINE_CHARS.work_update).toBe(295);
    const po = (open as { properties: Record<string, unknown> }).properties;
    const pu = (upd as { properties: Record<string, unknown> }).properties;
    // No capability rode in on T18's bytes: `work_open` is still exactly T0C-W's roster, and
    // `work_update`'s is T0C-W's plus T65's one declared window property, counted below.
    expect(Object.keys(po)).toHaveLength(25);
    expect(Object.keys(pu)).toHaveLength(33);
    // Nor did the ENUM move: `cancelled` was always advertised. What changed is that it now
    // MEANS something the tool honours.
    const status = pu.status as { enum: string[]; description: string };
    expect(status.enum).toEqual(
      ['on_deck', 'in_progress', 'complete', 'blocked', 'fallen', 'paused', 'cancelled'],
    );
    expect(status.description).toMatch(/two TERMINAL outcomes are different/);
    expect(status.description).toMatch(/"cancelled" = someone \(usually the user\) chose to call it off/);
    expect(status.description).toMatch(/NOT a failure/);
    // `work_open` is untouched — this edit is one verb and one property wide.
    expect(JSON.stringify(open).length).toBe(T0CW_BASELINE_CHARS.work_open);
  });

  it('preserves KEY ORDER on every shared property — stringify emits insertion order', () => {
    const po = (open as { properties: Record<string, Record<string, unknown>> }).properties;
    const pu = (upd as { properties: Record<string, Record<string, unknown>> }).properties;
    for (const name of Object.keys(WORK_SHARED_PROPERTIES)) {
      for (const [verb, props] of [['work_open', po], ['work_update', pu]] as const) {
        const keys = Object.keys(props[name]);
        expect(keys[0], `${verb}.${name} must start with type`).toBe('type');
        expect(keys[keys.length - 1], `${verb}.${name} must end with description`).toBe('description');
      }
    }
  });

  it('has 17 shared names and both verbs still declare every one of them', () => {
    const po = (open as { properties: Record<string, unknown> }).properties;
    const pu = (upd as { properties: Record<string, unknown> }).properties;
    const shared = Object.keys(WORK_SHARED_PROPERTIES);
    expect(shared).toHaveLength(17);
    for (const name of shared) {
      expect(name in po, `work_open lost ${name}`).toBe(true);
      expect(name in pu, `work_update lost ${name}`).toBe(true);
    }
  });

  it('every field is still described on BOTH verbs, and the collapse is the measured 4,400 → 3,733', () => {
    const po = (open as { properties: Record<string, { description?: string }> }).properties;
    const pu = (upd as { properties: Record<string, { description?: string }> }).properties;
    let differing = 0;
    let totalChars = 0;
    for (const name of Object.keys(WORK_SHARED_PROPERTIES)) {
      const a = po[name].description ?? '';
      const b = pu[name].description ?? '';
      expect(a.length, `work_open.${name} lost its description`).toBeGreaterThan(0);
      expect(b.length, `work_update.${name} lost its description`).toBeGreaterThan(0);
      totalChars += a.length + b.length;
      if (a !== b) differing++;
    }
    // Was 2,328 + 2,072 = 4,400 at `8f36cdb` and still 4,400 at the phase exit `9a995ca`.
    // N1 collapses the seven paraphrase pairs: 2,333 + 1,400 = 3,733, −667 chars of prose
    // (−693 once JSON escaping is counted, `BASELINE_CHARS` above).
    expect(totalChars).toBe(3733);
    // NOT one description was deleted, and no pair was harmonised into identical bytes:
    // every field still reads differently on the two verbs because each verb still says
    // its own thing about it.
    expect(differing).toBe(17);
    // N1's saving is measured against N1's OWN baseline. T0C-W later added +1,447 of new
    // declared capability on top; keeping the two arithmetics separate is what stops a
    // later reader reading the growth as "N1 was undone".
    expect(S2_BASELINE_CHARS.work_open + S2_BASELINE_CHARS.work_update
      - (N1_BASELINE_CHARS.work_open + N1_BASELINE_CHARS.work_update)).toBe(693);
  });

  it('N1 — the seven collapsed fields say their meaning ONCE across the two verbs', () => {
    const po = (open as { properties: Record<string, { description: string }> }).properties;
    const pu = (upd as { properties: Record<string, { description: string }> }).properties;
    const collapsed = Object.keys(WORK_FIELD_TEXT);
    expect(collapsed).toHaveLength(7);
    for (const name of collapsed) {
      const canonical = WORK_FIELD_TEXT[name].canonical;
      // work_open emits the canonical verbatim (with its own `Task only.` scope lead where
      // it has one) — the lesson is PRESENT, not deleted.
      expect(po[name].description, `work_open.${name} must carry the canonical wording`).toContain(canonical);
      // work_update emits its own routing line and does NOT restate the canonical. This is
      // the entire wire saving: said once, not twice.
      expect(pu[name].description, `work_update.${name} must be the module's onUpdate line`).toBe(WORK_FIELD_TEXT[name].onUpdate);
      expect(pu[name].description, `work_update.${name} is restating the canonical again`).not.toContain(canonical);
      // The pointer is what makes the deletion a collapse rather than a trim: it names the
      // verb whose description holds the wording. Both tools are always-loaded and adjacent
      // in the declared array (S1), so it resolves to text already in the prompt.
      expect(pu[name].description, `work_update.${name} must point at where the wording lives`).toContain('work_open');
    }
  });

  it('N1 — the ten pairs that are NOT paraphrases were left alone', () => {
    const po = (open as { properties: Record<string, { description: string }> }).properties;
    const pu = (upd as { properties: Record<string, { description: string }> }).properties;
    // Measured at `9a995ca` before the collapse and unchanged by it. A later "tidy-up" that
    // trims one of these is a coaching trim nobody approved, and this pins it.
    const UNTOUCHED: Record<string, [number, number]> = {
      title: [22, 25], description: [154, 75], project_id: [54, 115], assigned_to: [51, 83],
      priority: [32, 36], step_number: [34, 62], depends_on: [55, 98], phase: [34, 51],
      goal: [68, 212], repeat_end_type: [165, 39],
    };
    expect(Object.keys(UNTOUCHED)).toHaveLength(10);
    for (const [name, [o, u]] of Object.entries(UNTOUCHED)) {
      expect(name in WORK_FIELD_TEXT, `${name} is not a collapsed field`).toBe(false);
      expect(po[name].description.length, `work_open.${name} moved`).toBe(o);
      expect(pu[name].description.length, `work_update.${name} moved`).toBe(u);
    }
  });

  it('the one structural divergence is DECLARED, not silently harmonised', () => {
    const po = (open as { properties: Record<string, { enum?: string[] }> }).properties;
    const pu = (upd as { properties: Record<string, { enum?: string[] }> }).properties;
    expect(po.priority.enum).toEqual([...WORK_PRIORITY_ENUM]);
    // work_update has never carried this enum. Adding it would change what a strict
    // provider accepts — a behaviour change outside structural single-sourcing.
    expect(pu.priority.enum).toBeUndefined();
    expect(WORK_SHARED_PROPERTIES.priority).toEqual({ type: 'string' });
  });

  // ── PHASE-6 T0A — the editable-field advertisement, pinned to the byte ──────────────
  //
  // `WORK_EDITABLE_TASK_FIELDS` now renders the `work_update(action="edit")` refusal AND
  // drives the door's forward loop, which is what makes the two lists one. That is a
  // single-sourcing, so the sentence the model reads must not have moved by one character:
  // the literal below is the string as it stood at `d716172`, before the rewire.
  it('T0A — the Editable: advertisement is byte-identical to the hand-written one', () => {
    const rendered =
      'Error: at least one editable field must be provided. Editable: '
      + WORK_EDITABLE_TASK_FIELDS.join(', ')
      + '. (For status changes use work_update(action="status"); for assignee changes use '
      + 'work_update(action="reassign"); for pause/resume use work_schedule(action="pause").)';
    expect(rendered).toBe(
      'Error: at least one editable field must be provided. Editable: title, description, goal, '
      + 'depends_on, step_number, phase, scheduled_start, repeat_interval, repeat_unit, '
      + 'repeat_end_type, repeat_end_value, repeat_days_of_week, anchor_time, priority, notes. '
      + '(For status changes use work_update(action="status"); for assignee changes use '
      + 'work_update(action="reassign"); for pause/resume use work_schedule(action="pause").)',
    );
    expect(rendered).toHaveLength(417);
    // And the refusal renders from THIS list rather than from a second copy of it.
    const tools = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'tracker', 'tools.ts'), 'utf8');
    expect(tools).toContain('WORK_EDITABLE_TASK_FIELDS.join');
    expect(tools, 'the advertisement is spelled out again somewhere in tracker/tools.ts')
      .not.toContain('Editable: title, description, goal');
  });

  it('T0A — every advertised editable field is DECLARED on work_update, so a model can pass it', () => {
    const pu = (upd as { properties: Record<string, unknown> }).properties;
    const undeclared = WORK_EDITABLE_TASK_FIELDS.filter((f) => !(f in pu));
    expect(
      undeclared,
      `${undeclared.length} of ${WORK_EDITABLE_TASK_FIELDS.length} advertised editable field(s) are not `
      + 'declared on work_update — advertised and unreachable',
    ).toEqual([]);
    expect(WORK_EDITABLE_TASK_FIELDS).toHaveLength(15);
  });

  it('the module refuses an undeclared property rather than inventing one', () => {
    expect(() => workProp('not_a_real_field', 'x')).toThrow(/not declared/);
  });

  it('the 16 structurally-identical properties really are declared once', () => {
    const src = fs.readFileSync(SRC, 'utf8');
    // Both verbs' repeat_unit enums used to be two byte-identical literal arrays.
    const literalRepeatUnits = src.split("'minutes', 'hours', 'days', 'weekdays'").length - 1;
    expect(literalRepeatUnits, 'the repeat_unit enum is still duplicated in tools.ts').toBe(0);
  });
});
