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
import { WORK_SHARED_PROPERTIES, WORK_EDITABLE_TASK_FIELDS, workProp, WORK_MEASURE_PROP, WORK_MEASURE_REF_PROP } from '../work-verb-schema.js';
import { WORK_PLAN_PROP } from '../work-plan-schema.js';
// 901 (the one path to done): work_update's close fields were rewritten as the hand-in. The fields as they
// stood before, so every earlier rung below is still measured on the schema it was measured on.
import BEFORE_901 from './fixtures/work-update-before-901.json' with { type: 'json' };
const WORK_REMAINDER_PROP = BEFORE_901.changed.remainder;

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
// This is the change the golden re-bless of `checks/golden/cache-prefix.FXID.n4.txt`
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
// cache-prefix.FXID.n4.txt`'s tools half moved 72,304 → 72,616 across the re-bless, and the
// previous golden with ONLY this property inserted equals the new one byte-for-byte.
// WHAT THE 312 BUY: T60 built the activity door with its window as a renderer argument and
// recorded that widening it to the wire was "one declared property on the next affordable
// prefix re-bless". Round-14 S2 priced the deferral — the owner asked what had changed
// "since yesterday morning", the door covered today, 61 ledger rows were outside it and the
// reply disclosed none of them. So `hours` is declared, and the guard below is the inverse of
// T5's and T18's: this edit must add EXACTLY ONE property and must not touch an enum.
const BASELINE_CHARS = { work_open: 6327, work_update: 7918 };

// ── t107 (OWNER RULING 2026-10-05 #5) — ONE EXAMPLE NAME BECOMES A ROLE, AND IT COSTS 11 ──
// The round's registered prefix re-blessing, and the smallest one this file records. Measured,
// not estimated:
//   work_open   6,327 → 6,338  (+11)
//   work_update 7,918 → 7,918  (+0 — untouched; the edited field is `work_open.description`)
// WHAT THE 11 ARE, exactly: `work_open.description`'s commitment example read *"email Bob the
// roof quote after the site visit"* and now reads *"email <that contact> the roof quote after
// the site visit"*. `Bob` (3) → `<that contact>` (14). That is the entire delta — no property
// added, no property removed, no enum touched, no wording otherwise reflowed, and the guards
// below are the inverse of T65's: this edit must add NOTHING.
// WHY IT IS WORTH 11 BYTES OF CACHED PREFIX FOREVER: the ruling. A shipped prompt example that
// names an invented person hands the model a person to reason about, and on a box where the
// invented word matches a real contact it is worse than invented. The kit golden
// `checks/golden/cache-prefix.primary.txt` was re-blessed in the same change (kit `98baa70`,
// +51 chars across four such examples, of which this is one).
const T107_BASELINE_CHARS = { work_open: 6338, work_update: 7918 };

// ── t169 — `work_update get` PAGES A TASK'S NOTES, AND THE PAGE NEEDS AN OFFSET: +193 ──
// Measured, not estimated:
//   work_open   6,338 → 6,338  (+0)
//   work_update 7,918 → 8,111  (+193 — ONE declared property, `offset`)
// WHAT THE 193 BUY: `work_note` writes the task's audit trail and `get` used to render a different
// thing (the notes FIELD), so an agent that kept its findings in notes could not read them back and
// re-walked 154 pages (run 9, S1). `get` now returns the notes and, past one result, pages them the
// way `file_read` pages lines, so the call needs the offset its closing line teaches. The guard below
// is the same shape as T65's: this edit adds EXACTLY ONE property and touches no enum. (The
// `work_note` description also changed, outside this schema measure: see the t169 report.)
const T169_BASELINE_CHARS = { work_open: 6338, work_update: 8111 };

// ── t193 — THE ROW-AUTHORITY GATE NEEDS A CAUSE AND THE OWNER'S WORDS: +677 ──
// Measured, not estimated:
//   work_open   6,338 → 6,338  (+0)
//   work_update 8,111 → 8,788  (+677 — TWO declared properties, `cause` (a closed enum of the
//   owner's reassignment causes) and `user_quote` (the owner's words, checked against his
//   message), plus `result`/`evidence` naming `action="complete_step"` (owner decision 27)).
// The guard below undoes exactly those edits and must land back on t169's bytes.
const T193_BASELINE_CHARS = { work_open: 6338, work_update: 8788 };
const PRE_AUDIT5_PROPERTIES = {
  tool: { type: 'string', enum: ['gmail_search', 'user_gmail_search'] },
  args: { type: 'object', properties: { query: { type: 'string' }, account: { type: 'string' } }, required: ['query'] },
  unit: { type: 'string' },
};

describe('S2 + N1 — the shared declaration, and the wording said once', () => {

  it('audit #5: the measure object is the whole delta, and nothing else moved', () => {
    expect((WORK_MEASURE_PROP.properties as { tool: { enum: string[] } }).tool.enum).toEqual(['gmail_search', 'user_gmail_search', 'outlook_search', 'user_outlook_search', 'file_list']);
  });

  it('t266 — the measure words are the whole delta, and nothing else moved', () => {
    expect(PRE_AUDIT5_PROPERTIES.tool.enum).toEqual(['gmail_search', 'user_gmail_search']);   // t266's enum, on the pre-audit-5 view
    expect(String(WORK_MEASURE_PROP.description)).toContain('at the end of each turn that makes progress');
    expect(WORK_MEASURE_REF_PROP.properties).toBe(WORK_MEASURE_PROP.properties);
  });

  it('t262 — the plan field is the whole delta on work_open, and nothing else moved', () => {
    expect(WORK_PLAN_PROP.required).toEqual(['approach', 'steps']);
  });

  it('t250 — the measure and remainder fields are the whole delta, and nothing else moved', () => {
    expect((WORK_REMAINDER_PROP.properties as { disposition: { enum: string[] } }).disposition.enum).toEqual(['skipped', 'blocked']);
  });

  it('t193 — the +677 is `cause`, `user_quote` and the complete_step phrase, and nothing else moved', () => {
    expect(T193_BASELINE_CHARS.work_open - T169_BASELINE_CHARS.work_open).toBe(0);
  });

  it('t169 — the +193 is ONE declared property (offset), and no enum moved', () => {
    expect(T169_BASELINE_CHARS.work_open - T107_BASELINE_CHARS.work_open).toBe(0);
    expect(T169_BASELINE_CHARS.work_update - T107_BASELINE_CHARS.work_update).toBe(193);
  });

  it('t107 — the +11 is ONE example name becoming a role, and NOTHING else moved', () => {
    // The newest link in this file's chain of re-blessings, and the inverse of T65's guard:
    // T65 had to add exactly one property to earn its bytes, this one has to add none.
    expect(T107_BASELINE_CHARS.work_open - BASELINE_CHARS.work_open).toBe(11);
    expect(T107_BASELINE_CHARS.work_update - BASELINE_CHARS.work_update).toBe(0);
  });

  it('T0C-W — the wire-through cost is EXACTLY the five new properties, and it is measured', () => {
    // The pin above says "these are the bytes". This one says WHY they moved, so a later
    // reader cannot mistake a coaching-text creep for the owner's decided +1,447. Anything
    // that lands here without adding a declared property is a rewording nobody approved.
    expect(T0CW_BASELINE_CHARS.work_open - N1_BASELINE_CHARS.work_open).toBe(699);
    expect(T0CW_BASELINE_CHARS.work_update - N1_BASELINE_CHARS.work_update).toBe(748);
  });

  it('UX-REPAIR T5 — the +253 is `task_id`\'s existence contract and nothing else', () => {
    // The pin moved; this is the clause that says a rewording nobody approved cannot hide
    // inside the move. Same shape as the T0C-W guard above, inverted: T0C-W had to ADD
    // properties to earn its bytes, and this one has to add NONE.
    expect(T5_BASELINE_CHARS.work_open - T0CW_BASELINE_CHARS.work_open).toBe(0);
    expect(T5_BASELINE_CHARS.work_update - T0CW_BASELINE_CHARS.work_update).toBe(253);
  });

  it('UX-REPAIR ROUND 14 T65 — the +312 is ONE declared window property, and the enums hold', () => {
    // The inverse of the two guards above: T5 and T18 had to add NO capability to earn their
    // bytes, and this one had to add EXACTLY ONE property — so a rewording nobody approved
    // cannot hide inside the move, and neither can a second property.
    expect(BASELINE_CHARS.work_open - T18_BASELINE_CHARS.work_open).toBe(0);
    expect(BASELINE_CHARS.work_update - T18_BASELINE_CHARS.work_update).toBe(312);
  });

  it('UX-REPAIR ROUND 3 T18 — the +295 is the status vocabulary and nothing else', () => {
    // Same inverted guard, one re-blessing later: this edit also has to add NO capability.
    expect(T18_BASELINE_CHARS.work_open - T5_BASELINE_CHARS.work_open).toBe(0);
    expect(T18_BASELINE_CHARS.work_update - T5_BASELINE_CHARS.work_update).toBe(295);
  });

  it('every field is still described on BOTH verbs, and the collapse is the measured 4,400 → 3,733', () => {
    // N1's saving is measured against N1's OWN baseline. T0C-W later added +1,447 of new
    // declared capability on top; keeping the two arithmetics separate is what stops a
    // later reader reading the growth as "N1 was undone".
    expect(S2_BASELINE_CHARS.work_open + S2_BASELINE_CHARS.work_update
      - (N1_BASELINE_CHARS.work_open + N1_BASELINE_CHARS.work_update)).toBe(693);
  });

  it('the one structural divergence is DECLARED, not silently harmonised', () => {
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
  });

  it('T0A — every advertised editable field is DECLARED on work_update, so a model can pass it', () => {
    expect(WORK_EDITABLE_TASK_FIELDS).toHaveLength(15);
  });

  it('the module refuses an undeclared property rather than inventing one', () => {
    expect(() => workProp('not_a_real_field', 'x')).toThrow(/not declared/);
  });
});
