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
const BASELINE_CHARS = { work_open: 5628, work_update: 6310 };

describe('S2 + N1 — the shared declaration, and the wording said once', () => {
  const open = schemaOf('work_open');
  const upd = schemaOf('work_update');

  it('serialises to exactly the measured byte count — the tools array is cached-prefix bytes', () => {
    expect(JSON.stringify(open).length).toBe(BASELINE_CHARS.work_open);
    expect(JSON.stringify(upd).length).toBe(BASELINE_CHARS.work_update);
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
    expect(S2_BASELINE_CHARS.work_open + S2_BASELINE_CHARS.work_update
      - (BASELINE_CHARS.work_open + BASELINE_CHARS.work_update)).toBe(693);
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
