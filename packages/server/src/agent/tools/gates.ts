// THE GATES, DECLARED. `gatesForCall` returns the gates for a call; the
// dispatcher runs ONE loop in order and the FIRST failing message is what the
// agent sees (scenarios assert on it). Resources come from each tool's declared
// `effects[]`, so a renamed arg fails the conformance walk, never un-gates.

import { PM_ONLY_WORK_OPS } from '../../tracker/pm-agent.js';
import { workOperation } from '../../tools/work-verbs.js';
import { effectsFor } from './registry.js';
import { getSmsReachability, describeSmsRecipients } from '../../services/capability-registry.js';
import { toolCategoryLabels } from '../access/read.js';
import { EFFECT_FROM_ARGS, type ToolEffect } from './types.js';
import type { AccessChannel } from '@dojo/shared';

/** OWNER-FACING CONTROLS: the SAME set `getFilteredTools` strips the surface
 *  with (`agent/tools.ts` imports it back); never let the two become two
 *  lists. `reset_session` is absent on purpose: the Healer needs it. */
export const PRIMARY_ONLY_TOOLS = new Set<string>([
  'apply_update', 'check_for_update',
  'set_capability_model', 'set_channel', 'set_voice', 'set_user_presence',
  'open_settings', 'dashboard_navigate',
  'update_agent', 'get_agent_profile',
  'create_agent_group', 'update_group', 'assign_to_group', 'delete_group',
]);

/** Every gate kind; `row` names the old ladder row it carries. */
export type ToolGate =
  /** The declared file effects of one kind whose paths the caller names; each path is asked. */
  | { readonly kind: 'fs'; readonly effect: FsEffect; readonly effects: readonly ToolEffect[]; readonly row: string }
  /** Two doors, argv on `proc` and script on `shell`; `exec_allow` covers both unless withheld. */
  | { readonly kind: 'proc'; readonly row: string }
  | { readonly kind: 'shell'; readonly row: string }
  | { readonly kind: 'applescript'; readonly row: string }
  | { readonly kind: 'net'; readonly subAgentsOnly?: true; readonly row: string }
  | { readonly kind: 'spawn'; readonly row: string }
  | { readonly kind: 'primary_only'; readonly message: string; readonly row: string }
  /** Asks the CHANNEL for its grant, not a role; sentence byte-identical by design. */
  | { readonly kind: 'channel'; readonly channel: AccessChannel; readonly message: string; readonly row: string }
  /** `service: null` (credential_list) gates on holding ANY `secrets` grant. */
  | { readonly kind: 'credential'; readonly service: string | null; readonly row: string }
  /** The positive CATEGORY grant, checked LAST; proof: `the-category-gate.test.ts`. */
  | { readonly kind: 'category'; readonly row: string }
  | { readonly kind: 'primary_or_healer'; readonly row: string }
  | { readonly kind: 'inspect_grant'; readonly row: string }
  | { readonly kind: 'pm_only_operation'; readonly operation: string; readonly row: string }
  | { readonly kind: 'creator_only'; readonly entity: 'agent' | 'group'; readonly ref: string; readonly row: string }
  | { readonly kind: 'system_control'; readonly category: string; readonly row: string };

const SYSTEM_CONTROL_CATEGORY: Readonly<Record<string, string>> = {
  mouse_click: 'mouse',
  mouse_move: 'mouse',
  keyboard_type: 'keyboard',
  screen_screenshot: 'screen',
  applescript_run: 'applescript',
};

type FsEffect = 'fs_read' | 'fs_write';
const FS_ROWS: ReadonlyArray<readonly [FsEffect, string]> = [['fs_read', '1'], ['fs_write', '2']];
/** Ids the platform recorded name its own library or upload, not a folder the caller chose. */
const PLATFORM_RECORDS: ReadonlySet<string> = new Set(['technique_dir', 'attachment_row']);

/** The file effects the one file check asks, for every tool: each `args.` path the caller names. */
export function callerFileEffects(name: string, kind: FsEffect): ToolEffect[] {
  return (effectsFor(name) ?? []).filter((e) => e.kind === kind && e.from.startsWith(EFFECT_FROM_ARGS)
    && !(e.via && PLATFORM_RECORDS.has(e.via)));
}

const OWNER_FACING_TOOLS = new Set(['dreamer_run_now', 'cost_summary']);
const IMESSAGE_PRIMARY_ONLY = new Set(['imessage_send', 'imessage_list_contacts']);
const CREDENTIAL_TOOLS = new Set(['credential_list', 'credential_get', 'credential_add', 'credential_update', 'credential_delete']);

export function gatesForCall(name: string, args: Record<string, unknown>): ToolGate[] {
  const gates: ToolGate[] = [];

  for (const [effect, row] of FS_ROWS) {
    const effects = callerFileEffects(name, effect);
    if (effects.length > 0) gates.push({ kind: 'fs', effect, effects, row });
  }
  if (name === 'exec') gates.push({ kind: 'proc', row: '3' });
  if (name === 'shell') gates.push({ kind: 'shell', row: '3s' });
  if (name === 'spawn_agent') gates.push({ kind: 'spawn', row: '4' });
  // web_search's net gate has no argument to key on: it is a fixed host.
  if (name === 'web_fetch' || name === 'web_search') gates.push({ kind: 'net', row: name === 'web_fetch' ? '5' : '6' });
  // Guidance only: when SMS is live the refusal names it, so escalation targets a door that can open.
  if (IMESSAGE_PRIMARY_ONLY.has(name)) {
    const sms = getSmsReachability();
    gates.push({
      kind: 'channel',
      channel: 'imessage',
      row: '7',
      message: `Permission denied: only the primary agent can call ${name}.`
        + (sms.live
          ? ` iMessage may not be the live channel here: SMS is enabled on this server`
            + ` (approved: ${describeSmsRecipients(sms)}) and sms_send is primary-only too.`
            + ' Escalate to the primary agent and name SMS as the channel.'
          : ' Escalate to the primary agent instead.'),
    });
  }
  // Keyed on the OPERATION: three actions on one verb, so name-keying locks nothing.
  const pmOnlyOp = workOperation(name, args);
  if (pmOnlyOp !== null && PM_ONLY_WORK_OPS.has(pmOnlyOp)) {
    gates.push({ kind: 'pm_only_operation', operation: pmOnlyOp, row: '8' });
  }
  if (PRIMARY_ONLY_TOOLS.has(name)) {
    gates.push({
      kind: 'primary_only',
      row: '9',
      message: `Permission denied: ${name} is an owner-facing control reserved for the primary agent. The request was not performed. Escalate to the primary agent if this needs to happen.`,
    });
  }
  if (name === 'reset_session') gates.push({ kind: 'primary_or_healer', row: '10' });
  if (name === 'dojo_inspect') gates.push({ kind: 'inspect_grant', row: '10i' });
  if (name === 'kill_agent') gates.push({ kind: 'creator_only', entity: 'agent', ref: String(args.agent_id ?? ''), row: '11' });
  if (name === 'delete_group') gates.push({ kind: 'creator_only', entity: 'group', ref: String(args.group_id ?? ''), row: '12' });
  if (OWNER_FACING_TOOLS.has(name)) {
    gates.push({
      kind: 'primary_only',
      row: '13',
      message: `Permission denied: only the primary agent can call ${name}.`,
    });
  }
  // Two gates on one tool: system_control always, plus net on the url for a sub-agent navigating.
  if (name === 'web_browse') {
    gates.push({ kind: 'system_control', category: 'web_browse', row: '14a' });
    if (args.action === 'navigate' && args.url) gates.push({ kind: 'net', subAgentsOnly: true, row: '14b' });
  }
  // applescript leaves this row to its own kind so the script text is audited.
  const controlCategory = SYSTEM_CONTROL_CATEGORY[name];
  if (controlCategory === 'applescript') gates.push({ kind: 'applescript', row: '15' });
  else if (controlCategory) gates.push({ kind: 'system_control', category: controlCategory, row: '15' });
  if (CREDENTIAL_TOOLS.has(name)) {
    const service = typeof args.service_name === 'string' ? args.service_name : null;
    gates.push({ kind: 'credential', service, row: '16' });
  }
  // LAST so earlier sentences win; a tool the index does not name mints nothing.
  if (name !== 'dojo_inspect' && toolCategoryLabels(name).length > 0) gates.push({ kind: 'category', row: '17' });

  return gates;
}
