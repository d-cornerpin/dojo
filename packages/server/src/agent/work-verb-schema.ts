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
// actually saves wire bytes — §T0-E estimates 2,000–2,900) remains NEEDS-OWNER. It is a
// coaching trim and no worker gets to make it.
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
