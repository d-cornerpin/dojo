// ════════════════════════════════════════════════════════════════════════════════════════
// S2 — ONE DECLARATION FOR THE 17 PROPERTIES `work_open` AND `work_update` BOTH DESCRIBE.
// PHASE-3 T3, §T0-E candidate S2. PROTECTED-SAFE: trims nothing, removes nothing, and
// changes not one byte of what the model reads.
// ════════════════════════════════════════════════════════════════════════════════════════
//
// ── WHAT WAS MEASURED, AND A CORRECTION TO §T0-E ────────────────────────────────────────
// §T0-E measured 17 shared property names, "449 chars byte-identical once descriptions are
// removed", and wrote the step as "one shared property module, both verbs referencing it,
// keeping the UNION of the two descriptions … (saving ≈ 449 chars, ~0.6% of the prefix)".
//
// T3 re-derived all of it at `8f36cdb` before implementing (#14) and TWO of those figures
// do not survive contact:
//
//   • THE 17 AND THE 449 ARE EXACT. 17 shared names; 16 of the 17 are byte-identical once
//     descriptions are removed; those 16 structures total 449 chars.
//   • THE 449 IS A **SOURCE** SAVING, NOT A PREFIX SAVING. Each tool serialises its own
//     `input_schema` into the request, so a property declared once in TypeScript is still
//     emitted twice on the wire. Single-sourcing removes duplicated SOURCE and exactly zero
//     wire bytes. `0.6% of the prefix` is not available from this change at all.
//   • "BOTH VERBS CARRY THE UNION" WOULD **GROW** THE PREFIX BY 4,434 CHARS — measured,
//     property by property (today: 2,328 + 2,072 = 4,400 description chars; with each verb
//     carrying the union of the pair: 8,834). That is 59% of the entire +7,559-char growth
//     the owner accepted on 2026-07-30, spent inside the phase whose subject is prefix cost,
//     to say each field's meaning twice to each verb.
//
// So this module implements the STRUCTURAL half exactly as the plan step names it — one
// shared declaration of the 17 property SCHEMAS (type, enum, items: the 449 chars) — and
// each verb keeps its OWN description verbatim. Nothing is trimmed, nothing is merged,
// nothing is lost, and the emitted bytes are IDENTICAL to before, which
// `work-verb-schema.test.ts` proves rather than claims.
//
// N1 (collapse the two paraphrases into ONE canonical wording, the only variant that
// actually saves wire bytes — §T0-E estimates 2,000–2,900) was NEEDS-OWNER and is now
// DECIDED: see `WORK_FIELD_TEXT` below.
//
// ── THE ONE STRUCTURAL DIVERGENCE, NAMED RATHER THAN HARMONISED ─────────────────────────
// `priority` is the 17th, and the two verbs declare it differently: `work_open` carries
// `enum: ['high','normal','low']`, `work_update` carries none. Harmonising it would ADD a
// constraint to `work_update` that the wire does not carry today, which is a behaviour
// change (a provider that enforces enums would begin refusing a value the tool accepts
// now) and is outside "structural single-sourcing". The shared entry therefore holds only
// what both agree on, the enum is applied at `work_open`'s site, and the divergence is
// recorded here for a phase that owns tool semantics — not silently closed by this one.
// ════════════════════════════════════════════════════════════════════════════════════════

/** The values `work_open` constrains `priority` to. `work_update` does not — see above. */
export const WORK_PRIORITY_ENUM = ['high', 'normal', 'low'] as const;

/** The repeat units both verbs accept. Declared once; identical bytes in both. */
export const WORK_REPEAT_UNIT_ENUM = [
  'minutes', 'hours', 'days', 'weekdays', 'specific_days', 'weeks', 'months', 'years',
] as const;

/** How a recurrence ends. Declared once; identical bytes in both. */
export const WORK_REPEAT_END_TYPE_ENUM = ['never', 'after_count', 'on_date'] as const;

// ════════════════════════════════════════════════════════════════════════════════════════
// PHASE-6 T0A — THE EDITABLE-FIELD LIST, DECLARED ONCE SO THE TWO LISTS CANNOT DISAGREE.
// ════════════════════════════════════════════════════════════════════════════════════════
//
// The defect this closes, reported from the owner's own preflight box on 2026-08-03: the
// `work_update(action="edit")` refusal text ADVERTISED fifteen editable fields, and the
// agent-facing door's forward list carried thirteen of them. `anchor_time` was declared on
// the tool, described by the tool, read and applied by `trackerEditTask`, named in the
// refusal's own `Editable:` list — and dropped at the door, so an agent that obeyed the
// error message got the error message again. Two lists, one question, two answers.
//
// There is ONE list now. `tracker/tools.ts` renders the refusal from it and
// `agent/tools/cat/tracker.ts` forwards from it, so a field can no longer be advertised
// without being forwarded — not by discipline, by construction. `tracker-door-census.test.ts`
// holds the remaining direction (every DECLARED parameter is forwarded or carries a reason).
//
// ORDER IS THE ADVERTISEMENT. The sequence below is the exact sequence the refusal string
// has always printed; `work-verb-schema.test.ts` pins the rendered bytes so this stays a
// single-sourcing and never becomes a rewording.
export const WORK_EDITABLE_TASK_FIELDS = [
  'title', 'description', 'goal', 'depends_on', 'step_number', 'phase',
  'scheduled_start', 'repeat_interval', 'repeat_unit',
  'repeat_end_type', 'repeat_end_value', 'repeat_days_of_week', 'anchor_time',
  'priority', 'notes',
] as const;

type PropSchema = Record<string, unknown>;

/**
 * The 17 shared property SCHEMAS — every field of each one except its description.
 *
 * KEY ORDER IS LOAD-BEARING. `JSON.stringify` emits keys in insertion order and the tools
 * array is the head of the cached prefix, so `{ ...schema, description }` must reproduce
 * the exact key sequence each verb emitted before (`type` → `enum`/`items` → `description`).
 * The byte-equality test is what keeps that true.
 */
export const WORK_SHARED_PROPERTIES: Record<string, PropSchema> = {
  title: { type: 'string' },
  description: { type: 'string' },
  project_id: { type: 'string' },
  assigned_to: { type: 'string' },
  assigned_to_group: { type: 'string' },
  priority: { type: 'string' },
  step_number: { type: 'number' },
  depends_on: { type: 'array', items: { type: 'string' } },
  phase: { type: 'number' },
  goal: { type: 'string' },
  scheduled_start: { type: 'string' },
  repeat_interval: { type: 'number' },
  repeat_unit: { type: 'string', enum: WORK_REPEAT_UNIT_ENUM as unknown as string[] },
  repeat_days_of_week: { type: 'array', items: { type: 'string' } },
  repeat_end_type: { type: 'string', enum: WORK_REPEAT_END_TYPE_ENUM as unknown as string[] },
  repeat_end_value: { type: 'string' },
  anchor_time: { type: 'string' },
};

/**
 * One shared property, with THIS verb's own description. `extra` carries anything only one
 * verb declares (today: `work_open`'s `priority` enum) and is inserted before the
 * description so the key order matches what the wire has always carried.
 */
export function workProp(name: keyof typeof WORK_SHARED_PROPERTIES | string, description: string, extra?: PropSchema): PropSchema {
  const shared = WORK_SHARED_PROPERTIES[name as string];
  if (!shared) throw new Error(`work verb property not declared: ${String(name)}`);
  return { ...shared, ...(extra ?? {}), description };
}

// ════════════════════════════════════════════════════════════════════════════════════════
// N1 — THE WORDING COLLAPSE. Owner-approved 2026-08-01, post-exit.
// ════════════════════════════════════════════════════════════════════════════════════════
//
// The two verbs described the same 17 fields in two paraphrases: 2,328 + 2,072 = 4,400
// chars of prose on the wire, every turn, forever (re-measured at `9a995ca` — the exit
// figure, reproduced). The owner's ruling: say each field's meaning ONCE. Every lesson is
// KEPT; only the SECOND STATEMENT of it is deleted. The END-OF-TURN DECISION MATRIX and
// every other coaching block are untouched (N3 unasked), as is `work_close_request` (N2).
//
// ── THE OBVIOUS SHAPE GROWS THE WIRE, MEASURED (#14) ─────────────────────────────────────
// "One canonical wording, BOTH verbs emit it" costs more than today, for the reason T3
// recorded above: each tool serialises its own `input_schema`, so a string shared in
// TypeScript is still emitted twice. Lower bound at `9a995ca`: the LARGER of each pair sums
// to 2,693, and a union is never shorter than the larger of two, so that shape costs AT
// LEAST 2 × 2,693 = 5,386 against 4,400 — **≥986 chars of GROWTH** before one clause is
// merged. (§T0-E's naive form of it measured 8,834.) The wire only shrinks if text stops
// being emitted twice, so:
//   • `canonical` — the full best-of-both wording, emitted by the verb that OWNS the
//     field's mechanics. For all seven that is `work_open`: it introduces the field, and
//     the tracker uptake this coaching protects happens at OPEN time.
//   • `onUpdate`  — `work_update`'s own line: its `action=` routing (which of that verb's
//     seven actions consumes the field — that exists nowhere else, so it is never
//     duplication), its genuinely edit-side clauses (clear/replace), and a POINTER to the
//     canonical rather than a restatement. Both verbs are always-loaded and adjacent in the
//     declared array (S1), so the pointer resolves to text already in the prompt.
//
// ── WHY SEVEN AND NOT SEVENTEEN ──────────────────────────────────────────────────────────
// The other ten pairs are not paraphrases and are left exactly as they were; sharing them
// would grow the wire and blur two different meanings. `title`/`description`/`project_id`/
// `assigned_to`/`step_number`/`depends_on`/`phase`/`goal`: `work_open` says what the field
// MEANS, `work_update` says the edit operation (replace, clear, the goalpost-moving
// caution, UUID-prefix resolution) — different content, both short, under ~25 chars of
// overlap. `priority`: `work_update` lists the three values because it deliberately carries
// NO enum (the divergence named above), so that listing compensates for a missing schema
// constraint rather than restating prose. `repeat_end_type`: `work_update`'s line is
// already routing-only (39 chars).
//
// The realised saving is in `.superpowers/sdd/PHASE-3/task-N1-report.md`, measured with the
// transport's own expression, and stated beside the exit summary's 500–725-token estimate —
// which was "4,400 minus one copy" and so carries the same source-vs-wire error T3
// corrected in the 449. `work-verb-schema.test.ts` pins the post-collapse byte counts.
// ════════════════════════════════════════════════════════════════════════════════════════

export const WORK_FIELD_TEXT: Record<string, { canonical: string; onUpdate: string }> = {
  assigned_to_group: {
    canonical: 'Assign to a group instead of a specific agent. The PM picks an available agent at run time.',
    onUpdate: 'action="reassign": group ID to assign to (see work_open).',
  },
  scheduled_start: {
    // "UTC" is the one clause only `work_update` carried; it survives here, in the canonical.
    canonical: 'When to run this task. Use ISO 8601 UTC format like "2026-03-20T22:35:00Z". Call get_current_time first to get the current time, then calculate your target time. If omitted, task runs immediately.',
    onUpdate: 'action="edit": new scheduled start (see work_open). Pass null or empty string to clear and run immediately.',
  },
  repeat_interval: {
    canonical: 'How often to repeat. e.g., 2 means every 2 of the repeat_unit. Requires repeat_unit.',
    onUpdate: 'action="edit": repeat interval value (see work_open).',
  },
  repeat_unit: {
    // `work_open` already carried the superset: the "every weekday except Friday" example
    // is here and was absent from `work_update`'s paraphrase.
    canonical: 'Unit for repeat interval. "weekdays" = Mon–Fri only (skips weekends). "specific_days" = an explicit set of weekdays you provide via repeat_days_of_week (e.g. "every Monday and Wednesday" or "every weekday except Friday"). For specific_days, repeat_interval is ignored, the task fires on each listed day every week.',
    onUpdate: 'action="edit": repeat unit (see work_open for what each unit means).',
  },
  repeat_days_of_week: {
    canonical: 'Required when repeat_unit="specific_days". List of weekday names: ["mon","wed"] for Mondays and Wednesdays, ["mon","tue","wed","thu"] for weekdays except Friday. Accepted names: sun/mon/tue/wed/thu/fri/sat (case-insensitive). Integers 0-6 (0=Sun..6=Sat) also accepted.',
    onUpdate: 'action="edit": the weekday list (same format as work_open). Pass [] to clear.',
  },
  repeat_end_value: {
    canonical: 'For after_count: the number of runs (e.g., "5"). For on_date: an ISO8601 date (e.g., "2026-04-01"). Required when repeat_end_type is not "never".',
    onUpdate: 'action="edit": value for repeat_end_type (see work_open).',
  },
  anchor_time: {
    canonical: 'For recurring work: ISO 8601 timestamp that anchors all future runs (only the time-of-day matters, date components reflect when the anchor was set). DEFAULTS to scheduled_start (or `when` for a reminder); pass explicitly only if you want a different wall-clock time. Use this when it should ALWAYS fire at a specific time-of-day regardless of how long each run takes, e.g. "every Monday at 06:00", not "every Monday whenever the previous run happened to finish." Without this, a 5-minute completion drifts the schedule by 5 minutes every cycle.',
    onUpdate: 'action="edit": the anchor timestamp (see work_open); use it to change WHEN a recurring task fires without recreating it, e.g. 06:00 instead of 06:05. Pass null or empty string to clear.',
  },
};
