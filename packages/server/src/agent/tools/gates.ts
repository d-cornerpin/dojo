// ════════════════════════════════════════════════════════════════════════════
// THE GATES, DECLARED (PHASE-5 T2 Step 3) — what replaced the 15-branch ladder.
//
// `executeToolInner` carried a run of fifteen `if (name === …)` branches of FOUR
// different kinds between the FU-4 deny gate and the dispatch switch. Only six
// of them called `checkPermission` at all (§T0-PINS P1 measured it); the rest
// were identity tests, `created_by` lookups and manifest reads written in place.
// Fifteen branches is fifteen places to forget one, and the survey found exactly
// that: `web_browse` holds TWO gates in one branch and `web_search`'s gate has
// no argument to key on, so both are invisible to any "scan the args" approach.
//
// This module is the DECLARATION of what each of those branches required.
// `gatesForCall(name, args)` answers with a list; `evaluateGate` answers each
// one; `executeToolInner` runs ONE loop. The requirement is now a value you can
// print, diff and test, instead of control flow you have to read.
//
// ── THE RESOURCE GATES COME FROM THE REGISTRY, NOT FROM THIS FILE ──
// A gate of kind `fs`/`shell`/`net` names only the EFFECT KIND. Where the
// resource comes from is read off the tool's own declared `effects[]` (T1), so
// renaming `args.path` breaks the declaration — which the conformance walk
// already fails on — rather than silently un-gating the tool. That is the whole
// reason T1 landed before T2.
//
// ── RULING P5-R5: PARITY, AND WHAT THAT FORBIDS ──
// The table below has exactly the fifteen ladder rows in it and nothing else.
// 104 definitions declare an effect; the ladder gated 15 branches. Wiring
// "declared effect ⇒ requires a grant" would refuse things the owner's agents do
// today — `image_create` writing into its own uploads directory, `plaud_*`
// running `npx`, `calendar_create` sending — and that is an OWNER decision, not
// a worker's. Declared-but-ungated effects are RECORDED (`ungatedEffects()`
// below, which is what the telemetry line names) and refused by nothing.
// ════════════════════════════════════════════════════════════════════════════

import { PM_ONLY_WORK_OPS } from '../../tracker/pm-agent.js';
import { workOperation } from '../../tools/work-verbs.js';
import { effectsFor } from './registry.js';
import type { EffectKind } from './types.js';

/**
 * OWNER-FACING PLATFORM / SESSION / GROUP CONTROLS.
 *
 * Moved here from `agent/tools.ts` in the same change that deleted the ladder,
 * because the set and the gate that enforces it belong together — this is the
 * SAME constant `getFilteredTools` uses to strip the advertised surface, and the
 * two must never become two lists. `agent/tools.ts` imports it back.
 *
 * (`reset_session` is intentionally absent: the Healer legitimately executes it
 * to clear a wedged agent, so it gets its own primary-OR-Healer gate below and
 * stays surface-stripped rather than set-listed.)
 */
export const PRIMARY_ONLY_TOOLS = new Set<string>([
  // Platform / update control
  'apply_update', 'check_for_update',
  // Capability, channel, voice, and presence configuration
  'set_capability_model', 'set_channel', 'set_voice', 'set_user_presence',
  // Dashboard drive
  'open_settings', 'dashboard_navigate',
  // Agent identity + group management
  'update_agent', 'get_agent_profile',
  'create_agent_group', 'update_group', 'assign_to_group', 'delete_group',
]);

/** Every gate kind, and the ladder row each one carries. */
export type ToolGate =
  /** Branches 1, 2 — the fs broker on the declared `fs_read`/`fs_write` resource. */
  | { readonly kind: 'fs'; readonly effect: 'fs_read' | 'fs_write' | 'fs_delete'; readonly row: string }
  /**
   * Branch 3, now TWO DOORS (PHASE-5 T3 Step 1). Row 3 encoded one requirement
   * — *"exec allow/deny + sensitive-file command scan"* — and T3 splits the tool
   * it guarded into `exec({argv})` and `shell({script})`. Both carry row 3's
   * requirement; they differ in which grant answers it and in whether the
   * resource is a vector or a script.
   */
  | { readonly kind: 'proc'; readonly row: string }
  | { readonly kind: 'shell'; readonly row: string }
  /** T3 Step 2 — `applescript` as its own class, out of `system_control`. */
  | { readonly kind: 'applescript'; readonly row: string }
  /** Branches 5, 6, 14b — the net broker. `subAgentsOnly` is branch 14b exactly. */
  | { readonly kind: 'net'; readonly subAgentsOnly?: true; readonly row: string }
  /** Branch 4 — `can_spawn_agents`. */
  | { readonly kind: 'spawn'; readonly row: string }
  /** Branches 7, 9, 13 — the primary-only wall. */
  | { readonly kind: 'primary_only'; readonly message: string; readonly row: string }
  /** Branch 10 — primary OR the Healer. */
  | { readonly kind: 'primary_or_healer'; readonly row: string }
  /** Branch 8 — the PM allowlist, keyed on the OPERATION not the name. */
  | { readonly kind: 'pm_only_operation'; readonly operation: string; readonly row: string }
  /** Branches 11, 12 — only the creator dismisses. */
  | { readonly kind: 'creator_only'; readonly entity: 'agent' | 'group'; readonly ref: string; readonly row: string }
  /** Branches 14a, 15 — the manifest's `system_control`, category-derived. */
  | { readonly kind: 'system_control'; readonly category: string; readonly row: string };

/** Branch 15's category derivation, verbatim. T3 Step 2 decomposes the GRANT;
 *  the mapping from tool to category is already here and already honoured. */
const SYSTEM_CONTROL_CATEGORY: Readonly<Record<string, string>> = {
  mouse_click: 'mouse',
  mouse_move: 'mouse',
  keyboard_type: 'keyboard',
  screen_screenshot: 'screen',
  applescript_run: 'applescript',
};

const FS_READ_TOOLS = new Set(['file_read', 'file_list']);
const FS_WRITE_TOOLS = new Set(['file_write', 'file_append', 'file_patch']);
const OWNER_FACING_TOOLS = new Set(['dreamer_run_now', 'cost_summary']);
const IMESSAGE_PRIMARY_ONLY = new Set(['imessage_send', 'imessage_list_contacts']);

/**
 * THE FIFTEEN ROWS, as a list of gates for THIS call.
 *
 * Ordered exactly as the ladder was, because order is observable: an agent that
 * fails two gates has always seen the first one's message, and a scenario that
 * asserts on that message is asserting on the order.
 */
export function gatesForCall(name: string, args: Record<string, unknown>): ToolGate[] {
  const gates: ToolGate[] = [];

  // 1 — file_read / file_list
  if (FS_READ_TOOLS.has(name)) gates.push({ kind: 'fs', effect: 'fs_read', row: '1' });
  // 2 — file_write / file_append / file_patch
  if (FS_WRITE_TOOLS.has(name)) gates.push({ kind: 'fs', effect: 'fs_write', row: '2' });
  // 3 — the exec family, two doors since PHASE-5 T3. `3` is `exec({argv})`
  // against the `proc` grant; `3s` is `shell({script})` against the `shell`
  // grant. Both are ladder row 3's requirement; neither is a new refusal class
  // (an agent's `exec_allow` projects to both kinds unless its manifest
  // explicitly withholds the shell one — `brokers/grants.ts`).
  if (name === 'exec') gates.push({ kind: 'proc', row: '3' });
  if (name === 'shell') gates.push({ kind: 'shell', row: '3s' });
  // 4 — spawn_agent
  if (name === 'spawn_agent') gates.push({ kind: 'spawn', row: '4' });
  // 5 — web_fetch (hostname of args.url) · 6 — web_search (a FIXED host, no arg)
  if (name === 'web_fetch' || name === 'web_search') gates.push({ kind: 'net', row: name === 'web_fetch' ? '5' : '6' });
  // 7 — the iMessage primary-only wall
  if (IMESSAGE_PRIMARY_ONLY.has(name)) {
    gates.push({
      kind: 'primary_only',
      row: '7',
      message: `Permission denied: only the primary agent can call ${name}. Escalate to the primary agent instead.`,
    });
  }
  // 8 — PM_ONLY_WORK_OPS, keyed on the OPERATION (PHASE-2 T8V): after the verb
  // collapse these are three ACTIONS on one verb, so a name-keyed gate would
  // either lock nothing or start refusing the day a non-PM action is added.
  const pmOnlyOp = workOperation(name, args);
  if (pmOnlyOp !== null && PM_ONLY_WORK_OPS.has(pmOnlyOp)) {
    gates.push({ kind: 'pm_only_operation', operation: pmOnlyOp, row: '8' });
  }
  // 9 — PRIMARY_ONLY_TOOLS
  if (PRIMARY_ONLY_TOOLS.has(name)) {
    gates.push({
      kind: 'primary_only',
      row: '9',
      message: `Permission denied: ${name} is an owner-facing control reserved for the primary agent. The request was not performed. Escalate to the primary agent if this needs to happen.`,
    });
  }
  // 10 — reset_session: primary OR the Healer, and deliberately not in the set
  // above (the Healer legitimately calls it to clear a wedged agent).
  if (name === 'reset_session') gates.push({ kind: 'primary_or_healer', row: '10' });
  // 11, 12 — only the creator dismisses. An unresolved ref falls through to the
  // handler's friendlier not-found error, exactly as before.
  if (name === 'kill_agent') gates.push({ kind: 'creator_only', entity: 'agent', ref: String(args.agent_id ?? ''), row: '11' });
  if (name === 'delete_group') gates.push({ kind: 'creator_only', entity: 'group', ref: String(args.group_id ?? ''), row: '12' });
  // 13 — owner-facing
  if (OWNER_FACING_TOOLS.has(name)) {
    gates.push({
      kind: 'primary_only',
      row: '13',
      message: `Permission denied: only the primary agent can call ${name}.`,
    });
  }
  // 14 — web_browse holds TWO gates and one `authorize()` call cannot express
  // it: the manifest's `system_control`, AND — for a SUB-AGENT navigating to a
  // url — `network_domains` on that url. §T0-PINS P1 flags this as one of the
  // two easiest to lose; here it is two rows in a list rather than a nested if.
  if (name === 'web_browse') {
    gates.push({ kind: 'system_control', category: 'web_browse', row: '14a' });
    if (args.action === 'navigate' && args.url) gates.push({ kind: 'net', subAgentsOnly: true, row: '14b' });
  }
  // 15 — the HID / screen family, category-derived. PHASE-5 T3 Step 2 lifts
  // `applescript` OUT of this row into its own gate: osascript is a second
  // interpreter, and the thing that has to be authorized about it is the SCRIPT,
  // which `system_control`'s category compare never looked at. The grant
  // derivation is parity-preserving (a `'*'` manifest still covers it, a LIST
  // must name it — exactly what the category compare already required), so no
  // live manifest changes meaning; what is new is that the script text is now
  // audited, which is the `system_control:'*'` bypass closing.
  const controlCategory = SYSTEM_CONTROL_CATEGORY[name];
  if (controlCategory === 'applescript') gates.push({ kind: 'applescript', row: '15' });
  else if (controlCategory) gates.push({ kind: 'system_control', category: controlCategory, row: '15' });

  return gates;
}

/**
 * EFFECTS A TOOL DECLARES THAT NOTHING GATES, for this call.
 *
 * RULING P5-R5 says a declared-but-ungated effect gets NO new refusal and IS
 * recorded. This is the recording: the dispatcher logs it, nothing refuses on
 * it, and when the owner or a later task decides one of these should gate,
 * this list is the enumeration to decide FROM — derived from the registry at
 * the moment of the call rather than from anybody's memory of the toolbox.
 */
export function ungatedEffectKinds(name: string, gates: readonly ToolGate[]): EffectKind[] {
  const declared = effectsFor(name);
  if (!declared || declared.length === 0) return [];
  const gated = new Set<string>();
  for (const g of gates) {
    if (g.kind === 'fs') gated.add(g.effect);
    else if (g.kind === 'proc') gated.add('proc');
    else if (g.kind === 'shell') gated.add('shell');
    else if (g.kind === 'applescript') gated.add('applescript');
    else if (g.kind === 'net') gated.add('net');
    else if (g.kind === 'spawn') gated.add('spawn');
  }
  const out: EffectKind[] = [];
  for (const e of declared) if (!gated.has(e.kind) && !out.includes(e.kind)) out.push(e.kind);
  return out;
}
