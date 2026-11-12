// THE ONE SCHEMA-VALIDATION BOUNDARY: required + type + non-empty come from each tool's own
// input_schema, never a hand-maintained copy: a second copy drifts and kills live tools. Nothing
// goes INSIDE input_schema (it ships to the provider), so the exceptions are `fields` siblings.
import type { ToolDefinition } from './types.js';

/** SCOPE IS THIS LIST, never logic: names, types and emptiness come from each tool's schema; the test pins
 * each name to a real definition. Work verbs validate per operation elsewhere; a new entry is a refusal. */
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

/** Null = the call may proceed; else ONE message, byte-identical to what the floor model keys its
 * retries on. Required + type + non-empty only; enums and nested shapes stay with the handler. */
export function validateToolArgs(
  def: ToolDefinition | undefined,
  args: Record<string, unknown>,
): string | null {
  const schema = def?.input_schema;
  if (!schema || !Array.isArray(schema.required) || schema.required.length === 0) return null;

  for (const field of schema.required) {
    const decl = def?.fields?.[field];
    // Guidance-only required field; enforcing it here would be a new refusal. Reason at the declaration.
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
