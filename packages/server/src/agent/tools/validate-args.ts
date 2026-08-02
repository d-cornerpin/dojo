// ════════════════════════════════════════════════════════════════════════════
// THE ONE SCHEMA-VALIDATION BOUNDARY (PHASE-5 T3 Step 3, RULING P5-R8)
//
// WHAT STOOD HERE BEFORE: two hand-rolled mechanisms doing one job.
//   1. 57 per-tool `checkRequired([{name, value, type, allowEmpty?}, …])`
//      arrays, one at the top of each dispatch case in `executeToolInner`,
//      every one of them re-typing field names and types that the tool's own
//      `input_schema` already declares three lines away in the same file.
//   2. 8 `validateAgainstSchema(name, def.input_schema, args)` calls, one at
//      the head of each provider dispatcher, which did the schema-driven thing
//      correctly but emitted a SECOND message family (`… is required for
//      <toolName>.`) that nothing else in the tree spoke.
//
// The duplication was not theoretical. Two hand-maintained copies of the same
// requiredness had already DRIFTED from the schema and killed live tools: the
// `writeReqs` map demanded a `content` field `drive_upload` does not have and
// an array `values` where `sheets_append` takes a comma-separated string, so
// every base Google-write call died at dispatch while the `user_` twins, which
// skipped that map, worked. The fix then was the same as the rule now: the
// schema is the single source of truth. This module is that rule, applied once
// instead of per tool.
//
// ── THE TWO THINGS A JSON SCHEMA CANNOT SAY, AND WHY THEY ARE SIBLINGS ──
// `input_schema` is passed to the model provider verbatim and the cache-prefix
// golden hashes exactly that projection, so nothing may be added INSIDE it
// (OR7 / roadmap #10). Both declarations therefore live on the `fields` sibling
// T1 built, next to `secret: true`:
//
//   `allowEmpty: true`   — required, but "" / [] is a legitimate value.
//                          `file_write({path, content: ""})` writes an empty
//                          file and always has; a validator compiled from the
//                          schema alone REFUSES it. No schema keyword says
//                          "required, but empty is fine".
//
//   `requiredNotEnforced` — this field is in `input_schema.required` as
//                          guidance to the model, but the runtime has never
//                          refused a call that omits it, so this boundary does
//                          not either. Each carries WHY at the declaration
//                          site: most are validated by the handler with a
//                          richer, tool-specific message (an intent
//                          enumeration, an evidence gate, a shape example) that
//                          the four generic messages would replace; two are arg
//                          ALIASES the schema cannot express
//                          (`broadcast_to_group` takes `payload` where the
//                          schema names `message`); one simply has a default.
//                          Compiling those would be a NEW REFUSAL — less
//                          capability — which this phase's posture and RULING
//                          P5-R8 both forbid.
//
// ── SCOPE, AND WHY IT IS A LIST (RULING P5-R8) ──
// This boundary owns exactly the tools whose hand-rolled validation it
// replaced: the 57 named below, plus every tool defined in the eight provider
// modules that ran `validateAgainstSchema`. Measured at `1dbb202`, 37 further
// definitions carry a non-empty `required` and have NEVER had a required-field
// check on any path. Enforcing those here would invent 37 tools' worth of new
// refusals as a side effect of a refactor. RULING P5-R5 already settled the
// shape of that question in T2 — "a declared effect with NO gate today gets NO
// new refusal; it is RECORDED so the enumeration exists when the owner or a
// later task decides" — and the same answer applies to a declared `required`
// with no check today. They are recorded in PHASE-5.md's T3 Step 3 AS-BUILT and
// are a later decision, not this one's.
//
// The list is scope, never logic: the field names, their types and their
// emptiness rules all come from each tool's own schema. A tool added to the
// list starts being validated from its schema with no further code.
// ════════════════════════════════════════════════════════════════════════════
import type { ToolDefinition } from './types.js';

/**
 * THE 57 TOOLS whose per-tool `checkRequired` array this boundary replaced,
 * transcribed from the dispatch cases they sat in at `1dbb202`. The
 * `validate-args` test pins every name to a real definition, so a rename or a
 * typo fails the build rather than silently dropping a tool's validation.
 *
 * NOT here, on purpose: the six work verbs. `work_open` / `work_update` /
 * `work_validate` / `work_schedule` / `work_close_request` dispatch into
 * per-OPERATION cases (`work_open:project`, `work_update:status`, …), each with
 * its own `checkRequired` for fields the verb-level schema union cannot express
 * — `work_open(kind="project")` needs a title, a complete needs result and
 * evidence, `close_project` needs a reason, and ONE `work_update` schema cannot
 * say that. Those 19 sites STAY. Folding them in would delete validation that
 * exists nowhere else (RULING P5-R8).
 */
export const PER_TOOL_VALIDATED_AT_BOUNDARY: readonly string[] = [
  'file_read', 'file_write', 'file_append', 'scratchpad_set',
  'file_patch', 'file_list', 'history_get', 'history_expand',
  'web_search', 'web_fetch', 'open_browser', 'kill_agent',
  'spawn_timeout_decision', 'send_to_agent', 'broadcast_to_group', 'complete_task',
  'work_note', 'healer_log_action', 'healer_propose', 'convert_time',
  'set_user_presence', 'update_agent', 'get_agent_profile', 'create_agent_group',
  'update_group', 'assign_to_group', 'get_group_detail', 'delete_group',
  'mouse_click', 'mouse_move', 'applescript_run', 'web_browse',
  'imessage_send', 'sms_send', 'voice_call', 'voice_call_end',
  'save_technique', 'use_technique', 'technique_read', 'publish_technique',
  'update_technique', 'submit_technique_for_review', 'delete_technique', 'technique_set_placeholder',
  'technique_finalize', 'technique_list_versions', 'vault_remember', 'vault_search',
  'vault_get', 'vault_forget', 'vault_update', 'contact_search',
  'contact_get', 'contact_update', 'contact_forget', 'set_capability_model',
  'set_channel',
] as const;

/**
 * VALIDATE ONE CALL against the tool's own declared schema.
 *
 * Returns `null` when the call may proceed, or ONE user-readable error string —
 * byte-identical to the four `checkRequired` messages, because the floor model
 * reads them and retries on them and behavioral scenarios key on them. The
 * order within a field (present → type → non-empty) and the first-failure-wins
 * behaviour are the helper's, preserved deliberately.
 *
 * Type and emptiness are only judged when the schema declares a type, which is
 * the same restraint `validateAgainstSchema` took: this checks required + type
 * + non-empty, and leaves enums, ranges and nested shapes to the handler that
 * owns them.
 */
export function validateToolArgs(
  def: ToolDefinition | undefined,
  args: Record<string, unknown>,
): string | null {
  const schema = def?.input_schema;
  if (!schema || !Array.isArray(schema.required) || schema.required.length === 0) return null;

  for (const field of schema.required) {
    const decl = def?.fields?.[field];
    // Declared as required to the model, not enforced here. The reason lives at
    // the declaration; see the header for the three classes.
    if (decl?.requiredNotEnforced !== undefined) continue;

    const value = args[field];
    if (value === undefined || value === null) {
      return `Error: \`${field}\` is required.`;
    }

    const expectedType = (schema.properties as Record<string, { type?: string } | undefined>)[field]?.type;
    if (!expectedType) continue;

    const actualType: string = Array.isArray(value) ? 'array' : typeof value;
    if (actualType !== expectedType) {
      return `Error: \`${field}\` must be a ${expectedType} (got ${actualType}).`;
    }

    if (decl?.allowEmpty) continue;
    if (expectedType === 'string' && !(value as string).trim()) {
      return `Error: \`${field}\` cannot be empty.`;
    }
    if (expectedType === 'array' && (value as unknown[]).length === 0) {
      return `Error: \`${field}\` cannot be empty (pass at least one item).`;
    }
  }
  return null;
}
