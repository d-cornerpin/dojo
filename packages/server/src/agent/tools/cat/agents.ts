// MANAGING OTHER AGENTS: the spawn/terminate lifecycle, agent-to-agent traffic,
// destructive-action approval, identity/profile verbs, and squad verbs.
// Four load-bearing facts:
// 1. complete_task re-reads the agent row FRESH for agentCanSelfCompleteById;
//    the surface filter is only advice.
// 2. The send/broadcast `payload`/`message` aliases are required-not-enforced on
//    purpose; the handlers' own argument handling makes a `payload` broadcast work.
// 3. kill_agent and delete_group `created_by` gates are NOT here: they resolve their
//    target through these same resolvers but run in the executor ahead of dispatch.
// 4. resolveSpawnSquad moved with its only caller, spawn_agent; its whole content is
//    that every agent-spawned agent lands in a squad, fallback included.

import { getDb } from '../../../db/connection.js';
import { broadcast } from '../../../gateway/ws.js';
import { writeAgentStatus } from '../../agent-status.js';
import { isPrimaryAgent, isHealerAgent, isPMAgent } from '../../../config/platform.js';
import { readAgentPromptSurface, writeAgentPromptSurface } from '../../../prompt/agent-prompt-surface.js';
import { renameAgent } from '../../../prompt/agent-rename.js';
import { mismatchWarning } from '../assignment-capability.js';
import { coerceNumberArg } from '../pagination.js';
import { writeToolReceipt } from '../../../receipts/store.js';
import { askedAbout } from '../../../work/done/who-decides.js';
import { taskScope, projectScope } from '../../../work/tracker-view.js';
import { patchWork } from '../../../work/tracker-store.js';
import { engineHandIn, handInOnAssignReply } from '../../../work/done/hand-in.js';
import { noteUnsettled } from '../../../work/store.js';
import { spawnAgent, terminateAgent, completeAgent, applySpawnTimeoutDecision, jobBrief } from '../../spawner.js';
import { completeTaskHandIn } from './measure-door.js';
import { finalWordsBack } from '../../../work/done/effects.js';
import { resolveAgentTaskId } from '../../agent-task.js';
import { validateAlwaysLoadedTools } from '../../always-loaded-tools.js';
import { toolDefinitionsByName } from '../definitions.js';
import { createGroup, assignAgentToGroup } from '../../groups.js';
import { friendlyDbError, resolveAgentRef, resolveGroupRef, compactListTrailer, liveAgentsNamed, liveAgentNamesNear, sameNameNote, type LiveAgentByName } from '../../tool-helpers.js';

import { auditLog, agentCanSelfCompleteById, toolsLogger as logger } from '../util.js';
import { activeRuns } from '../../shared-state.js';
import { turnContext } from '../../turn-context.js';
import { decideApproval } from '../../approval-decision.js';
import { requestOnThreadForAnotherTurn } from '../../a2a-own-turn.js';
// Every send door goes through this ONE delivery-ledger writer, see the call sites below.
import { recordAtDoor } from '../../v2/outbound.js';
import { recordedId } from '../../v2/delivery-outcome.js';
import { getAgentPermissions } from '../../permissions.js';
import { validateManifest } from '../../scope.js';
import { isNoWakeIntent, deliverA2AMessage, deliverA2AMessage as deliverBc, type A2AIntent } from '../../a2a-transport.js';
import { onAgentRecovered } from '../../../healer/injury-recovery.js';
import { resolveTaskId, getTask, formatResolveError } from '../../../tracker/schema.js';
import { moveAssignee, ownerAskedInThisTurn, planSpawnTask, type SpawnTaskPlan } from '../../../work/row-authority.js';
import { setAgentModel } from '../../model-switch.js';
import { updateGroup as doUpdateGroup, SYSTEM_GROUP_ID as SYS_GROUP_U, getGroupDetail, getGroups as listAllGroups, deleteGroup as doDeleteGroup, SYSTEM_GROUP_ID as SYS_GROUP } from '../../groups.js';
import { writeTaskLog } from '../../../tracker/task-log.js';
// The capability clause derives from these two EXISTING authorities: the advertised
// per-agent tool grant (a leaf `cat/` may import `surface.ts`) and the declared tool names.
import { getFilteredTools } from '../surface.js';
import { TOOL_CATEGORIES } from '../../../tools/categories.js';
// The grant door: `authorize.ts` owns the schema, the no-escalation rule and the
// one write; this module owns the wording a model reads and the audit row.
import { resolveUpdateGrants, grantsDelta, GrantRefusedError } from '../../access/authorize.js';
import { inspectGainRefusal } from '../../../inspect/grant.js';
import { getAccessGrants, readStoredGrants, mayUseChannel, channelTierFor } from '../../access/read.js';
import { writeGrants } from '../../access/materialize.js';
import { ACCESS_CHANNELS, FINAL_REPLY_INTENTS, MOST_RESTRICTIVE_GRANTS, techniqueGrantOf } from '@dojo/shared';
import type { AccessChannel, AccessGrants } from '@dojo/shared';
import type { ToolHandlerMap } from '../handler.js';
import { refuseAgentModel } from '../../main-model-floor.js';
import { workingExpr } from '../../../work/terminal-states.js';

// Mandatory squad resolution for agent spawns: every agent-spawned agent lands in
// a squad so the owner sees which spawns belong to which work. Resolution order:
//   1. explicit group_id, must exist AND be creator-owned or project-stamped
//   2. the linked task's project already has a squad, reuse it
//   3. the project has no squad, auto-create one named after the project and stamp
//      projects.group_id so later spawns join
//   4. no project linkage, auto-create a squad named after the caller
// Returns the resolved group id + a squad name, or an error. Only the spawn_agent
// TOOL path calls this; internal engine spawns do not.
async function resolveSpawnSquad(opts: {
  callerAgentId: string;
  rawTaskId?: string;
  explicitGroupId?: string;
}): Promise<{ groupId: string; squadName: string; note: string } | { error: string }> {
  const db = getDb();

  if (opts.explicitGroupId) {
    const ref = resolveGroupRef(opts.explicitGroupId, 'spawn_agent');
    if (!ref.ok) return { error: ref.error };
    const grp = db.prepare('SELECT id, name, created_by FROM agent_groups WHERE id = ?').get(ref.id) as { id: string; name: string; created_by: string | null } | undefined;
    if (!grp) return { error: `Squad "${opts.explicitGroupId}" doesn't exist. Omit group_id to auto-create a squad, or pass one you created.` };
    const ownsIt = grp.created_by === opts.callerAgentId || isPrimaryAgent(opts.callerAgentId);
    const projectStamped = !!db.prepare(`SELECT 1 FROM work w WHERE ${projectScope('w')} AND w.group_id = ? LIMIT 1`).get(ref.id);
    if (!ownsIt && !projectStamped) {
      return { error: `You can only spawn into a squad you created or a project's squad. "${grp.name}" is neither. Omit group_id to auto-create your own squad.` };
    }
    return { groupId: grp.id, squadName: grp.name, note: '' };
  }

  if (opts.rawTaskId) {
    try {
      const rt = resolveTaskId(opts.rawTaskId);
      if (rt.ok) {
        const task = db.prepare('SELECT parent_id AS project_id FROM work WHERE id = ?').get(rt.id) as { project_id: string | null } | undefined;
        if (task?.project_id) {
          const proj = db.prepare(`SELECT w.id AS id, w.title AS title, w.group_id AS group_id FROM work w WHERE ${projectScope('w')} AND w.id = ?`).get(task.project_id) as { id: string; title: string; group_id: string | null } | undefined;
          if (proj) {
            if (proj.group_id) {
              const existing = db.prepare('SELECT id, name FROM agent_groups WHERE id = ?').get(proj.group_id) as { id: string; name: string } | undefined;
              if (existing) return { groupId: existing.id, squadName: existing.name, note: ' (project squad)' };
              // Stale stamp (group was deleted): fall through and re-create below.
            }
            const group = createGroup(proj.title, `Squad for project "${proj.title}".`, opts.callerAgentId);
            noteUnsettled(patchWork(proj.id, { group_id: group.id }), 'spawn_squad: project joined to the new group', { taskId: proj.id });
            return { groupId: group.id, squadName: group.name, note: ` (created for project "${proj.title}")` };
          }
        }
      }
    } catch (err) {
      logger.warn('resolveSpawnSquad: project squad resolution failed, falling back to caller squad', {
        callerAgentId: opts.callerAgentId, error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const caller = db.prepare('SELECT name FROM agents WHERE id = ?').get(opts.callerAgentId) as { name: string } | undefined;
  const callerName = caller?.name ?? 'Agent';
  const group = createGroup(`${callerName}'s squad`, `Ad-hoc squad for agents spawned by ${callerName}.`, opts.callerAgentId);
  return { groupId: group.id, squadName: group.name, note: '' };
}

// Capability truth at the delegation door. `list_agents` once answered names and
// status with nothing about what agents can DO, so work went to agents holding no
// tool for it, and silence read as capability. So the clause always states can and
// cannot, never neither.
// Both sources are existing authorities, nothing retyped here: `getFilteredTools` is
// the advertised per-agent surface (memoized per agent, so this door recomputes at
// most once per agent per policy change; `list_agents` is a rare call), and
// `TOOL_CATEGORIES` is the declared grouping that already backs the prompt's index.
// Only `messaging people` carries `channels`: the surface still advertises
// `imessage_send` to agents with no channel grant, because stripping it by grant
// would move ~110 agents' tool indexes, a prompt change this code must not cause.
// So the clause requires BOTH: an advertised tool AND the grant via `mayUseChannel`.
const DELEGABLE_CAPABILITIES: ReadonlyArray<{
  label: string;
  categories: readonly string[];
  channels?: readonly AccessChannel[];
}> = [
  { label: 'web research', categories: ['Web'] },
  { label: 'email', categories: ['Gmail', 'Outlook'] },
  { label: 'calendar', categories: ['Google Calendar', 'Microsoft Calendar'] },
  { label: 'files', categories: ['Google Drive / Docs / Sheets', 'OneDrive', 'SharePoint', 'Office Documents'] },
  {
    label: 'messaging people',
    categories: ['Communication', 'Twilio (SMS + Voice phone calls)', 'Microsoft Teams'],
    channels: ['imessage', 'sms', 'voice', 'teams'],
  },
];

/** Capability label -> the tool names that provide it, from the declared categories.
 *  A label that no longer exists resolves to NO tools, reading as "cannot" for every
 *  agent, so `__tests__/the-delegation-door-states-capability.test.ts` asserts each resolves. */
const capabilityToolSets = (): Map<string, Set<string>> => {
  const byLabel = new Map(TOOL_CATEGORIES.map((c) => [c.label, c.tools] as const));
  return new Map(DELEGABLE_CAPABILITIES.map((cap) => [
    cap.label,
    new Set(cap.categories.flatMap((label) => byLabel.get(label) ?? [])),
  ]));
};

/** ONE LINE of capability truth, both directions, always stated: silence cannot tell
 *  "this agent can" from "the platform did not say", so can and cannot are never both omitted. */
export function capabilityClause(agentId: string): string {
  let granted: Set<string>;
  try {
    granted = new Set(getFilteredTools(agentId).map((t) => t.name));
  } catch (err) {
    logger.warn('list_agents: capability read failed (non-fatal, clause omitted)', {
      agentId, error: err instanceof Error ? err.message : String(err),
    });
    return '';
  }
  const sets = capabilityToolSets();
  const can: string[] = [];
  const cannot: string[] = [];
  for (const { label, channels } of DELEGABLE_CAPABILITIES) {
    const tools = sets.get(label);
    const hasTool = [...(tools ?? [])].some((t) => granted.has(t));
    // A capability the door gates on a CHANNEL needs the grant as well as the tool.
    // `mayUseChannel` is the same predicate the wall enforces, so this cannot drift.
    const hasChannel = !channels || channels.some((c) => mayUseChannel(agentId, c));
    (hasTool && hasChannel ? can : cannot).push(label);
  }
  if (cannot.length === 0) return `can: ${can.join(', ')}`;
  if (can.length === 0) return `no: ${cannot.join(', ')}`;
  return `can: ${can.join(', ')}; no: ${cannot.join(', ')}`;
}

/** ONE LINE of access truth, rendered from the grants object (what an owner and a
 *  granting agent edit), not from the advertised surface. `spawn_agent` appends it so
 *  the most-restrictive default is visible at the moment it is applied. */
export function accessLine(agentId: string): string {
  let g: AccessGrants;
  try {
    g = getAccessGrants(agentId);
  } catch (err) {
    logger.warn('access line: grant read failed (non-fatal, line omitted)', {
      agentId, error: err instanceof Error ? err.message : String(err),
    });
    return '';
  }
  const parts: string[] = [];
  parts.push(`tools: ${g.tools.categories === '*' ? 'every category' : `${g.tools.categories.length} categor${g.tools.categories.length === 1 ? 'y' : 'ies'} (${g.tools.categories.join(', ')})`}`);
  const channels = ACCESS_CHANNELS.filter((c) => mayUseChannel(agentId, c));
  parts.push(`humans: ${g.channels.master === null
    ? 'through the main agent'
    : channels.length === 0 ? 'none' : channels.map((c) => `${c}:${channelTierFor(agentId, c)}`).join(', ')}`);
  const integrations: string[] = [];
  if (g.integrations.plaud) integrations.push('plaud');
  for (const which of ['google', 'microsoft'] as const) {
    const p = g.integrations[which];
    if (p.agent !== 'none' || p.user !== 'none') integrations.push(`${which} ${p.agent}/${p.user}`);
  }
  parts.push(`integrations: ${integrations.length ? integrations.join(', ') : 'none'}`);
  // The all/none words must match the pre-switch '*' / [] words so no live agent's line moves.
  parts.push(`credentials: ${g.integrations.credentials ? 'all' : 'none'}`);
  // Read via techniqueGrantOf so an older row still reads as the '*' it means, not empty.
  const techs = techniqueGrantOf(g);
  parts.push(`techniques: ${techs === '*' ? 'all' : techs.length === 0 ? 'none' : techs.join(', ')}`);
  return `\nAccess: ${parts.join(' | ')}`;
}

/** Which A2A drops are policy: this set files `suppressed`, everything else (including
 *  unknown or future reasons) files `failed`, mirroring `DROPS_THE_SENDER_IS_TOLD_ABOUT`
 *  in `a2a-transport.ts`. `SEMANTIC_DUPLICATE` is an explanation the sender already holds;
 *  `HOP_LIMIT_EXCEEDED` is the protocol's own bound.
 *  Keep this set and the handler's switch case in step, see `a2aDropOutcome` below. */
const A2A_DROPS_THAT_ARE_POLICY: ReadonlySet<string> = new Set(['SEMANTIC_DUPLICATE', 'HOP_LIMIT_EXCEEDED', 'REQUEST_ENDED']);

/** The honest ledger word for a refused A2A send. Unrecognised and absent reasons are `failed`. */
function a2aDropOutcome(reason: string | undefined): 'suppressed' | 'failed' {
  return reason !== undefined && A2A_DROPS_THAT_ARE_POLICY.has(reason) ? 'suppressed' : 'failed';
}

/** The one door out to another agent: target checks, delivery, the ledger rows and the result text. The
 *  `send_to_agent` handler passes only its declared arguments; `taskId` comes from engine state alone. */
export async function sendToAgent(agentId: string, input: {
  agent: string; intent: A2AIntent; payload: string; threadId?: string; requiresResponse: boolean;
  attachPaths?: string[]; handsOffThread?: string; taskId?: string | null;
}): Promise<{ content: string; isError: boolean }> {
  const { agent: agentRef, intent, payload, threadId, requiresResponse, attachPaths, handsOffThread, taskId } = input;
  let content = '';
  let isError = false;
  // An injured or paused target is refused, except to the main agent and the Healer.
  const sendDb = getDb();
  let targetCheck = sendDb.prepare('SELECT id, name, status, created_at FROM agents WHERE id = ?').get(agentRef) as { id: string; name: string; status: string; created_at: string } | undefined;
  let named: LiveAgentByName[] = [];   // names ignore case; the newest of several wins
  if (!targetCheck) { named = liveAgentsNamed(agentRef); targetCheck = named[0]; }
  if (targetCheck && (targetCheck.status === 'error' || targetCheck.status === 'paused')) {
    // Spawn-race auto-recover: a fresh sub-agent's first turn can fail (model not
    // ready, network blip) before the parent's first send lands, leaving it 'error'.
    // Error + created under 60 seconds = the race: heal to idle and deliver. An agent
    // that lived past 60s crashed after real work, so keep refusing and let parents heal.
    if (targetCheck.status === 'error') {
      const createdAtMs = new Date(
        targetCheck.created_at + (targetCheck.created_at.includes('Z') ? '' : 'Z'),
      ).getTime();
      const ageMs = Date.now() - createdAtMs;
      if (ageMs >= 0 && ageMs < 60_000) {
        try {
          writeAgentStatus(targetCheck.id, 'idle', { clearError: true });
          broadcast({ type: 'agent:status', agentId: targetCheck.id, status: 'idle' });
          onAgentRecovered(targetCheck.id);
          logger.warn('send_to_agent auto-healed newly-spawned error-state target', {
            callerAgentId: agentId, targetAgentId: targetCheck.id, name: targetCheck.name, ageMs,
          }, agentId);
          targetCheck = { ...targetCheck, status: 'idle' };
        } catch (recErr) {
          logger.warn('send_to_agent auto-heal failed', {
            callerAgentId: agentId, targetAgentId: targetCheck.id,
            error: recErr instanceof Error ? recErr.message : String(recErr),
          }, agentId);
        }
      }
    }
  }
  if (targetCheck && (targetCheck.status === 'error' || targetCheck.status === 'paused')
    && !isHealerAgent(agentId) && !isPrimaryAgent(agentId)) {
    const stateLabel = targetCheck.status === 'error' ? 'INJURED' : 'PAUSED';
    content = `Agent "${targetCheck.name}" is ${stateLabel}. Message NOT delivered. Only the main agent or the Healer can reach it now: tell the main agent, which can heal it with reset_session(agent_id="${targetCheck.id}"), or do the work another way.`;
    isError = true;
    return { content, isError };
  }

  // send_to_agent reaches OTHER agents; naming yourself stores and wakes your own inbox.
  if (targetCheck && targetCheck.id === agentId) {
    content = `Message not sent: "${targetCheck.name}" is you. send_to_agent reaches OTHER agents. If you need to remember something or plan your next step, do it in your own turn or with your own tools; to reach someone else, call list_agents and pick them.`;
    isError = true;
    return { content, isError };
  }

  const result = await deliverA2AMessage({
    intent,
    threadId: threadId ?? '',  // empty = auto-generate in transport
    requiresResponse,
    payload,
    toAgent: agentRef,
    fromAgent: agentId,
    attachPaths,
    handsOffThread,
    taskId,
  });

  if (result.delivered) {
    const effectiveIntent = result.autoPromotedFromFyi ? 'DELIVERABLE' : intent;
    auditLog(agentId, 'tool_call', 'send_to_agent', 'success',
      `to:${agentRef} intent:${effectiveIntent}${result.autoPromotedFromFyi ? '(promoted from FYI)' : ''} thread:${result.threadId.slice(0, 8)} requires_response:${requiresResponse}${result.autoCreatedTaskId ? ` task:${result.autoCreatedTaskId.slice(0, 8)}` : ''}`,
    );
    // A delivered send is a real delivery: the receipt grounds "I told <agent>"
    // across turns. skipAudit because the auditLog row above is the provenance row.
    const askedTask = isPMAgent(agentId) ? askedAbout(agentId, targetCheck?.id ?? agentRef, payload, result.threadId) : null;   // only the PM's questions hold a hand-in
    const sendReceiptId = writeToolReceipt({
      agentId, tool: 'send_to_agent', tier: 1, verified: true, basis: 'provider-id',
      providerId: result.threadId, threadId: result.threadId, recipient: agentRef, taskId: askedTask,
      sentText: payload, detail: { intent: effectiveIntent }, skipAudit: true,
    });
    // This door wrote only the audit row and receipt, never a
    // `deliveries` row. It is written THROUGH `recordAtDoor`, the one ledger
    // writer, so inside an outbound scope it folds into that scope's single row
    // instead of double-counting the piece delivery it supersedes. Channel `a2a`
    // mints no `conversations` row by construction: peer coordination is not a
    // human conversation; same shape as the other a2a producer, no new row class.
    const replyDeliveryId = recordedId(recordAtDoor({
      outcome: 'delivered', channel: 'a2a',
      agentId, tool: 'send_to_agent',
      recipientId: targetCheck?.id ?? agentRef,
      recipientDisplay: targetCheck?.name ?? agentRef,
      provider: result.threadId, threadRoot: result.threadId,
      messageId: result.messageId ?? null,
      receiptId: sendReceiptId,   // the receipt names the delivery, so the peer message is findable from the send
      detail: `A2A ${effectiveIntent}`,
    }), 'send_to_agent: hand-off to a peer', {
      from: agentId, to: targetCheck?.id ?? agentRef, thread: result.threadId,
    });
    // A final reply on an assign thread hands the assigned task in, on this delivery (or FAIL).
    if (!result.handOff?.applied) {
      try { handInOnAssignReply(result.threadId, agentId, effectiveIntent, replyDeliveryId); }
      catch (err) { logger.warn('assign-thread hand-in failed (non-fatal)', { thread: result.threadId.slice(0, 8), error: err instanceof Error ? err.message : String(err) }, agentId); }
    }
    content = `[A2A:${effectiveIntent}] Message delivered to "${agentRef}" on thread ${result.threadId.slice(0, 8)}${result.answeredRequestOnThread ? ' (you gave no thread_id, so it went on the request you were answering, your assignment)' : ''}.` +
      (requiresResponse || result.autoPromotedFromFyi
        ? ` Their reply is ASYNCHRONOUS, it arrives on a LATER turn, NOT now, and you do NOT have it yet. ` +
          `If someone is waiting on that answer (e.g. the owner asked you to find it out), tell them you have ASKED ` +
          `and will report back when "${agentRef}" replies, NEVER make up, guess, or relay a response you have not ` +
          `actually received. Do not message "${agentRef}" again about this (re-sending does not speed it up). ` +
          `End your turn now; you will be woken when they answer.`
        : ' No response expected (read-only context).');
    content += sameNameNote(agentRef, named);   // case-variant name collision note
    // The busy signal is informational: telling the sender prevents the
    // re-send/escalate reflex when a queued-behind-busy reply reads as ignored.
    try {
      if (targetCheck && activeRuns.has(targetCheck.id)) {
        const humanBusy = turnContext(targetCheck.id)?.kind === 'user';
        content += humanBusy
          ? ` NOTE: "${agentRef}" is currently in a live conversation with their user, so your message is queued and will be served when they are free. Expect a slower reply; do not re-send and do not escalate.`
          : ` NOTE: "${agentRef}" is currently mid-task, so your message is queued and will be served when they are free. Expect a slower reply; do not re-send.`;
      }
    } catch { /* best effort; the note is advisory */ }
    if (result.autoPromotedFromFyi) {
      content +=
        `\nNote: the engine auto-promoted your FYI to DELIVERABLE because the payload looked deliverable-shaped (URL or completion+artefact reference). Your receiver was woken. Use intent="DELIVERABLE" explicitly next time so the routing is unambiguous.`;
    }
    // An ASSIGN carries a board task; the sender is told which, and that the reply comes back.
    if (result.autoCreatedTaskId) {
      const taskShort = result.autoCreatedTaskId.slice(0, 8);
      content += result.autoTaskIsNew
        ? `\nTask ${taskShort} is the board task for this work, held by "${agentRef}". Their final reply on this thread is the answer, and it wakes you.`
        : `\nContinuing on existing task ${taskShort} (created by an earlier ASSIGN on this thread).`;
    }
    // The hand-off outcome is composed by the transport; only relayed here.
    if (result.handOff) content += `\n${result.handOff.message}`;
    else if (handsOffThread && !FINAL_REPLY_INTENTS.has(effectiveIntent)) content += `\n[Engine: hands_off_thread was not applied. A hand-off counts only on an ANSWER, DELIVERABLE, COMPLETE or FAIL reply; this message was sent as ${effectiveIntent}.]`;
  } else {
    // A protocol drop is expected behavior: log the reason, do not error.
    auditLog(agentId, 'tool_call', 'send_to_agent', 'success',
      `to:${agentRef} intent:${intent} reason:${result.reason}`,
    );
    // Refusals are recorded too: a ledger of only successes cannot answer "did
    // this hand-off happen?". WHICH word is `a2aDropOutcome`'s to decide, not this
    // call site's; readers of this table filter outcome='delivered' either way.
    recordedId(recordAtDoor({
      outcome: a2aDropOutcome(result.reason),
      channel: 'a2a',
      agentId, tool: 'send_to_agent',
      recipientId: targetCheck?.id ?? agentRef,
      recipientDisplay: targetCheck?.name ?? agentRef,
      provider: result.threadId, threadRoot: result.threadId,
      detail: `A2A ${intent} not delivered: ${result.reason ?? 'unknown'}`,
    }), 'send_to_agent: hand-off refused by the protocol', {
      from: agentId, to: agentRef, thread: result.threadId, reason: result.reason,
    });
    switch (result.reason) {
      case 'HOP_LIMIT_EXCEEDED':
        content = `Thread ${result.threadId.slice(0, 8)} has reached the maximum of 8 messages. This exchange has gone on long enough: stop, or bring it to the person you work for.`;
        break;
      case 'SEMANTIC_DUPLICATE':
        content = 'Message not sent, your last few messages on this thread are too similar to this one. The platform thinks you are repeating yourself. Options: (a) if you are reporting work completion, use intent="ANSWER" or intent="DELIVERABLE", those bypass dedup because completion notices need to land regardless of phrasing; (b) rephrase substantively (not just word swaps); (c) start a fresh thread by omitting thread_id.';
        break;
      case 'REQUEST_ENDED':
        content = `Not delivered: ${result.standing === 'called_off' ? 'the request this answered was called off by the owner' : 'the work this answered has ended'}, so nothing was passed on. Send nothing more about it.`;
        break;
      case 'AGENT_NOT_FOUND':
        content = `No agent found with ID or name "${agentRef}"; live agents: ${liveAgentNamesNear(String(agentRef)).join(', ') || '(none)'}.`;
        isError = true;
        break;
      default:
        content = `Message not delivered: ${result.reason}`;
        break;
    }
  }

  // Do NOT clear the pending iMessage-reply flag here: this delegates to ANOTHER
  // AGENT, it is never a reply to the user, and clearing it mid-turn silently wipes
  // the user's reply recipient. The only legitimate clear lives in imessage_send;
  // stale flags are swept at end-of-turn by the cleanup in loop.ts.
  return { content, isError };
}

export const agentsHandlers: ToolHandlerMap = {
  async "spawn_agent"({ agentId, args }) {
    let content = '';
    let isError = false;
    if (args.permissions) {
      const parentPerms = getAgentPermissions(agentId);
      if (!parentPerms.can_assign_permissions) {
        content = 'Permission denied: this agent cannot assign permissions to sub-agents. Spawn without custom permissions, or ask a user to grant "Assign Permissions" access.';
        isError = true;
        auditLog(agentId, 'spawn_agent', null, 'denied', 'can_assign_permissions is false');
        return { content, isError };
      }
    }
    // The creator owns the timeout: a non-ronin spawn REQUIRES timeout_minutes, no engine
    // default; a missing or invalid value is refused with a teaching error.
    const spawnClassification: 'ronin' | 'apprentice' = args.classification === 'ronin' ? 'ronin' : 'apprentice';
    let timeoutSecondsArg: number | undefined;
    if (spawnClassification !== 'ronin') {
      const tm = args.timeout_minutes;
      if (typeof tm !== 'number' || !Number.isFinite(tm) || tm <= 0) {
        content = `spawn_agent needs timeout_minutes for this sub-agent: how many minutes it may run before you (its creator) are asked to extend it or let it stop. There is no default. Size it to the task (a quick lookup ~5, a longer build ~30-60). If the work should run open-ended with no timeout, spawn it with classification="ronin" instead (ronin has no timeout and is ended only by the main agent, the owner, or itself with complete_task when its job is done).`;
        isError = true;
        auditLog(agentId, 'spawn_agent', args.name as string | null, 'denied', 'missing timeout_minutes');
        return { content, isError };
      }
      timeoutSecondsArg = Math.round(tm * 60);
    }

    // With a task, the handling is an explicit keep or transfer: `planSpawnTask` gates it
    // before anything is created; there is no silent default.
    let taskPlan: SpawnTaskPlan | null = null;
    if (args.task_id !== undefined && args.task_id !== null && args.task_id !== '') {
      const rt = resolveTaskId(args.task_id as string);
      const planned = rt.ok ? planSpawnTask(agentId, rt.id, args.task_handling) : { ok: false as const, text: `${formatResolveError('task', args.task_id as string, rt)} No agent was created.` };
      if (!planned.ok) {
        auditLog(agentId, 'spawn_agent', args.name as string | null, 'denied', 'task handling refused');
        return { content: planned.text, isError: true };
      }
      taskPlan = planned.plan;
    }

    // Resolve the squad BEFORE the insert so group_id is set at insert time.
    const squad = await resolveSpawnSquad({
      callerAgentId: agentId,
      rawTaskId: args.task_id as string | undefined,
      explicitGroupId: args.group_id as string | undefined,
    });
    if ('error' in squad) {
      content = squad.error;
      isError = true;
      auditLog(agentId, 'spawn_agent', args.name as string | null, 'denied', 'squad resolution failed');
      return { content, isError };
    }

    // The always-loaded list is capped and name-checked before the insert, so a refusal
    // leaves no half-built agent, and files INVALID_ARGS, never PERMISSION_DENIED.
    const declared = validateAlwaysLoadedTools(args.always_loaded_tools, toolDefinitionsByName());
    if (!declared.ok) { auditLog(agentId, 'spawn_agent', args.name as string | null, 'denied', declared.error.slice(0, 200)); return { content: declared.error, isError: true, errorCode: 'INVALID_ARGS' as const }; }
    // Wrap so raw SQLite errors ("FOREIGN KEY constraint failed", etc.) don't reach the
    // agent; `friendlyDbError` translates them into actionable plain language.
    try {
      const result = await spawnAgent({
        parentId: agentId,
        name: args.name as string,
        systemPrompt: args.system_prompt as string,
        modelId: args.model_id as string | undefined,
        permissions: args.permissions as Parameters<typeof spawnAgent>[0]['permissions'],
        toolsPolicy: args.tools as { allow: string[]; deny: string[] } | undefined,
        timeout: timeoutSecondsArg,
        taskId: args.task_id as string | undefined,
        contextHints: args.context_hints as string[] | undefined,
        persist: args.persist as boolean | undefined,
        classification: spawnClassification,
        shareUserProfile: args.share_user_profile as boolean | undefined,
        // Grants are forwarded RAW: `resolveSpawnGrants` inside `spawnAgent` is the one
        // place they are validated and bounded, shared with the dashboard and the engine.
        grants: args.grants,
        groupId: squad.groupId,
        equippedTechniques: args.techniques as string[] | undefined,
        alwaysLoadedTools: declared.names,
      });
      // The task half of the choice, now the agent exists: a transfer logs cause and actor
      // on the task's log; a failed transfer is SAID, never swallowed. A keep logs the helper.
      let reassignNote = '';
      let given: string | null = null;
      if (taskPlan?.handling === 'transfer') {
        const moved = moveAssignee({ taskId: taskPlan.taskId, by: 'agent', actorId: agentId, cause: taskPlan.cause, to: { agentId: result.agentId }, door: 'spawn_agent(task_handling="transfer")' });
        const freshTask = getTask(taskPlan.taskId);
        if (freshTask) broadcast({ type: 'tracker:task_updated', data: freshTask });
        given = moved.ok ? taskPlan.taskId : null;
        reassignNote = moved.ok
          ? `\nTask ${taskPlan.taskId.slice(0, 8)} transferred to ${result.name} (cause: ${moved.cause}).${mismatchWarning({ agentId: result.agentId, agentName: result.name, texts: [freshTask?.title, freshTask?.description] })}`   // the delegated task's own words, read off the row, not an undeclared arg
          : `\nThe agent was created, but task ${taskPlan.taskId.slice(0, 8)} was NOT transferred: ${moved.text.replace(/^Error: /, '')}`;
      } else if (taskPlan) {
        writeTaskLog({ taskId: taskPlan.taskId, fromEntity: `agent:${agentId}`, entryKind: 'observation', actionTaken: 'helper linked (spawn_agent with task_handling="keep")', reason: `agent ${result.agentId} spawned to help; the task stays with its current holder` });
        reassignNote = `\nTask ${taskPlan.taskId.slice(0, 8)} stays with its current holder; ${result.name}'s work for it is its own task, and its reply comes back to you.`;
      }
      // Every model-made grant change is audited: actor, target, and a delta measured
      // against the most-restrictive start, so the row says what this spawn ADDED; nothing
      // extra named means an empty delta and no row, keeping the audit honest.
      const spawnedGrants = readStoredGrants(result.agentId);
      if (spawnedGrants) {
        const delta = grantsDelta(MOST_RESTRICTIVE_GRANTS, spawnedGrants);
        if (delta) auditLog(agentId, 'spawn_agent', result.agentId, 'success', `grants: ${delta}`);
      }
      content = `Agent spawned successfully.${result.warnings.map((w) => `\nWarning: ${w}`).join('')}\nAgent ID: ${result.agentId}\nName: ${result.name}\nStatus: ${result.status}\nPersistent: ${result.persist ? 'yes' : 'no'}\nSquad: ${squad.squadName}${squad.note}${reassignNote}${accessLine(result.agentId)}${mismatchWarning({ agentId: result.agentId, agentName: result.name, texts: [args.system_prompt as string] })}`;   // tools the instructions name that the assignee cannot call, surfaced to the spawner
      // The job is handed over the way any agent is given work: one ASSIGN on its own thread with the job's rules.
      if (args.auto_start !== false) {
        const job = await sendToAgent(agentId, {
          // A spawn that named a task passes it, or null when it was kept or not moved, so no other task of the sender is given away.
          agent: result.agentId, intent: 'ASSIGN', requiresResponse: true, taskId: taskPlan ? given : undefined,
          payload: jobBrief({ systemPrompt: args.system_prompt as string, initialMessage: args.initial_message as string | undefined }),
        });
        content += `\n${job.content}`;
      }
    } catch (err) {
      // A refused GRANT is not a database error and must not be translated as one: the
      // reason names the field the caller has to fix, and the attempt itself is audited.
      if (err instanceof GrantRefusedError) {
        auditLog(agentId, 'spawn_agent', args.name as string | null, 'denied', err.plainReason.slice(0, 400));
        // PERMISSION_DENIED, not a bare error: `classifyToolResult` reads the CODE, not
        // the prose, and a refusal arriving as `failed` reads as a crash worth retrying.
        return { content: err.plainReason, isError: true, errorCode: 'PERMISSION_DENIED' as const };
      }
      const msg = err instanceof Error ? err.message : String(err);
      // A FK failure usually means a bad model_id, group_id, or task_id; say so plainly.
      if (msg.includes('FOREIGN KEY constraint failed')) {
        content = `Could not spawn agent, one of the references you passed (model_id, group_id, task_id, or parent_agent) points at something that doesn't exist. Double-check the IDs. Use list_models to find a valid model_id.`;
      } else {
        content = friendlyDbError(err, 'spawn_agent');
      }
      isError = true;
      auditLog(agentId, 'spawn_agent', args.name as string | null, 'error', msg.slice(0, 200));
    }
    return { content, isError };
  },

  async "kill_agent"({ agentId, args }) {
    let content = '';
    let isError = false;
    const killResolved = resolveAgentRef(args.agent_id as string, 'kill_agent');
    if (!killResolved.ok) { content = killResolved.error; isError = true; return { content, isError }; }
    const targetId = killResolved.id;
    const killDb = getDb();
    const targetAgent = killDb.prepare('SELECT classification, status FROM agents WHERE id = ?').get(targetId) as { classification: string; status: string } | undefined;
    // The main agent may end any agent; every other agent is refused a sensei or a ronin.
    const guarded = !isPrimaryAgent(agentId);
    if (guarded && targetAgent?.classification === 'sensei') {
      content = 'Cannot terminate sensei agent.';
      isError = true;
      return { content, isError };
    }
    if (guarded && targetAgent?.classification === 'ronin') {
      content = 'Cannot terminate ronin agent. Only the main agent, the owner, or the ronin itself with complete_task when its job is done can end a ronin agent.';
      isError = true;
      return { content, isError };
    }
    // Idempotency: killing an already-terminated agent is a no-op.
    if (targetAgent?.status === 'terminated') {
      content = `Agent ${targetId} is already terminated. No action taken.`;
      return { content, isError };
    }
    terminateAgent(targetId, `Killed by agent ${agentId}`, ownerAskedInThisTurn(agentId, args.user_quote).ok);
    content = `Agent ${targetId} has been terminated.`;
    return { content, isError };
  },

  async "spawn_timeout_decision"({ agentId, args }) {
    let content = '';
    let isError = false;
    const stdAction = args.action as string;
    if (stdAction !== 'extend' && stdAction !== 'terminate') {
      content = 'Error: action must be "extend" or "terminate".';
      isError = true;
      return { content, isError };
    }
    const stdResolved = resolveAgentRef(args.agent_id as string, 'spawn_timeout_decision');
    if (!stdResolved.ok) { content = stdResolved.error; isError = true; return { content, isError }; }
    const stdResult = await applySpawnTimeoutDecision({
      callerAgentId: agentId,
      agentId: stdResolved.id,
      action: stdAction as 'extend' | 'terminate',
      extendMinutes: coerceNumberArg(args.extend_minutes) ?? undefined,
    });
    content = stdResult.message;
    isError = !stdResult.ok;
    auditLog(agentId, 'spawn_timeout_decision', stdResolved.id, stdResult.ok ? 'success' : 'denied', stdAction);
    return { content, isError };
  },

  async "send_to_agent"({ agentId, args }) {
    let content = '';
    let isError = false;
    // All A2A traffic goes through the transport: threads, hop limits, dedup, routing.
    const agentRef = args.agent as string;
    // Normalize case/whitespace so a case slip is not a re-call loop.
    const intent = (args.intent as string | undefined)?.trim().toUpperCase();
    const payload = (args.payload as string) ?? (args.message as string) ?? '';
    if (!payload || !payload.trim()) {
      content = 'Error: send_to_agent needs a non-empty `payload` (or `message`), what you want to say to the other agent.';
      isError = true;
      return { content, isError };
    }

    // Intent is REQUIRED, no silent default: the old FYI fallback made a
    // wake-needing message dead-on-arrival, so every call chooses deliberately.
    const VALID_INTENTS = ['QUESTION', 'ASSIGN', 'BLOCK', 'ANSWER', 'DELIVERABLE', 'FYI', 'STATUS', 'COMPLETE', 'FAIL'];
    if (!intent || !VALID_INTENTS.includes(intent)) {
      content = `Error: \`intent\` is required for send_to_agent. Default to a wake intent unless you are CERTAIN the receiver has nothing to do with this message:
      • Wake intents (receiver wakes and decides what to do next):
        - QUESTION, you need an answer
        - ASSIGN, you are handing off work
        - BLOCK, you are stuck and need input
        - ANSWER, replying to a prior question
        - DELIVERABLE, here is the thing they asked for
        - COMPLETE, your assigned work is done (receiver almost always needs to react: forward, notify, mark tracker, decide next step)
        - FAIL, your assigned work failed (receiver almost always needs to react: escalate, retry, abandon)
      • No-wake intents (ambient context only, receiver does NOT wake):
        - FYI, purely for awareness, no action required
        - STATUS, mid-work progress update, no action required
    Re-call send_to_agent with the right intent. When in doubt, pick a wake intent, the receiver can decide silence is fine, but they can't act on a message they never woke for.`;
      isError = true;
      return { content, isError };
    }
    const threadId = args.thread_id as string | undefined;
    // A send ON a thread whose inbound request awaits its own turn belongs to that
    // turn; from any other turn it is refused, since delivery would cancel that turn.
    const keepSeparate = requestOnThreadForAnotherTurn(agentId, threadId);
    if (keepSeparate) {
      auditLog(agentId, 'tool_call', 'send_to_agent', 'denied', `thread:${keepSeparate.threadShort} request awaits its own turn`);
      return { content: keepSeparate.refusal, isError: true, errorCode: 'PERMISSION_DENIED' as const };
    }
    // The assignee's declared hand-off is forwarded verbatim; the transport owns its
    // meaning. Declared on the tool so a caller is not met with an unknown-arg warning.
    const handsOffThread = (args.hands_off_thread as string | undefined)?.trim() || undefined;
    const rawAttachPaths = args.attach_paths;
    const attachPaths: string[] = Array.isArray(rawAttachPaths)
      ? rawAttachPaths.filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
      : [];

    // requires_response: the explicit arg wins, else the intent default. ANSWER and
    // DELIVERABLE default to true (the receiver waits) even though they close the thread.
    let requiresResponse: boolean;
    if (args.requires_response !== undefined) {
      requiresResponse = !!args.requires_response;
    } else {
      requiresResponse = !isNoWakeIntent(intent as A2AIntent);
    }
    // No-wake intents ALWAYS force false (transport also enforces this)
    if (isNoWakeIntent(intent as A2AIntent)) {
      requiresResponse = false;
    }

    return sendToAgent(agentId, {
      agent: agentRef, intent: intent as A2AIntent, payload, threadId, requiresResponse,
      attachPaths: attachPaths.length > 0 ? attachPaths : undefined, handsOffThread,
    });
  },

  async "approve_destructive_action"({ agentId, args }) {
    let content = '';
    let isError = false;
    // Primary-only: the gate routes these requests, and only the primary decides.
    if (!isPrimaryAgent(agentId)) {
      content = 'Only the primary agent can decide destructive-action approvals. If you need one approved, the engine has already routed your request to the primary.';
      isError = true;
      return { content, isError };
    }
    const daToken = String((args as Record<string, unknown>).token ?? '').trim();
    const daDecision = String((args as Record<string, unknown>).decision ?? '').trim();
    if (!daToken || (daDecision !== 'approve' && daDecision !== 'deny')) {
      content = 'approve_destructive_action requires token and decision ("approve" or "deny").';
      isError = true;
      return { content, isError };
    }
    content = await decideApproval({
      deciderAgentId: agentId,
      token: daToken,
      decision: daDecision as 'approve' | 'deny',
    });
    return { content, isError };
  },

  async "broadcast_to_group"({ agentId, args }) {
    let content = '';
    let isError = false;
    const bcResolved = resolveGroupRef(args.group_id as string, 'broadcast_to_group');
    if (!bcResolved.ok) { content = bcResolved.error; isError = true; return { content, isError }; }
    const groupId = bcResolved.id;
    const broadcastPayload = (args.payload as string) ?? (args.message as string) ?? '';
    const bcIntent = (args.intent as string | undefined)?.trim().toUpperCase();
    if (!broadcastPayload || !broadcastPayload.trim()) { content = 'Error: `payload` (or `message`) is required, what to send to the group.'; isError = true; return { content, isError }; }

    const BC_VALID_INTENTS = ['QUESTION', 'ASSIGN', 'BLOCK', 'ANSWER', 'DELIVERABLE', 'FYI', 'STATUS', 'COMPLETE', 'FAIL'];
    if (!bcIntent || !BC_VALID_INTENTS.includes(bcIntent)) {
      content = `Error: \`intent\` is required for broadcast_to_group. Wake intents (QUESTION/ASSIGN/BLOCK/ANSWER/DELIVERABLE) wake EVERY group member, use sparingly. Most broadcasts should be FYI (informational) or STATUS (progress update). Re-call with an explicit intent.`;
      isError = true;
      return { content, isError };
    }

    const bcDb = getDb();

    const groupMembers = bcDb.prepare(`
      SELECT id, name, status FROM agents
      WHERE group_id = ? AND status != 'terminated' AND id != ?
    `).all(groupId, agentId) as Array<{ id: string; name: string; status: string }>;

    if (groupMembers.length === 0) {
      content = 'No other active agents in this group.';
      return { content, isError };
    }

    const sent: string[] = [];
    const sentIds = new Set<string>();

    const healthyMembers = groupMembers.filter(m => m.status !== 'error' && m.status !== 'paused');

    for (const member of healthyMembers) {
      const bcResult = await deliverBc({
        intent: bcIntent as import('../../a2a-transport.js').A2AIntent,
        // Fresh thread per member (empty, auto-generated in transport): a SHARED
        // thread_id collided the per-thread dedupe, hop counter and ASSIGN lookup.
        threadId: '',
        requiresResponse: ['QUESTION', 'ASSIGN', 'BLOCK'].includes(bcIntent),
        payload: broadcastPayload,
        toAgent: member.id,
        fromAgent: agentId,
      });
      if (bcResult.delivered) {
        sent.push(member.name);
        sentIds.add(member.id);
        // One receipt per delivered recipient grounds the broadcast as a real
        // cross-turn delivery; skipAudit since the transport handles fan-out audit.
        writeToolReceipt({ agentId, tool: 'broadcast_to_group', tier: 1, verified: true, basis: 'provider-id', providerId: bcResult.threadId, threadId: bcResult.threadId, recipient: member.name, sentText: broadcastPayload, detail: { intent: bcIntent, groupId }, skipAudit: true });
        // Same ledger closure as `send_to_agent`: a receipt and no `deliveries` row was
        // the same gap. ONE ROW PER DELIVERED MEMBER, one-for-one with the receipts: each
        // member gets a fresh thread, so a fan-out to N members is genuinely N deliveries.
        recordedId(recordAtDoor({
          outcome: 'delivered', channel: 'a2a',
          agentId, tool: 'broadcast_to_group',
          recipientId: member.id, recipientDisplay: member.name,
          provider: bcResult.threadId, threadRoot: bcResult.threadId,
          messageId: bcResult.messageId ?? null,
          detail: `A2A ${bcIntent} (group ${groupId})`,
        }), 'broadcast_to_group: fan-out to a group member', {
          from: agentId, to: member.id, thread: bcResult.threadId, groupId,
        });
      }
    }

    const notReached = groupMembers.filter((m) => !sentIds.has(m.id)).map((m) => m.name);
    if (sent.length === 0) {
      content = `Error: the broadcast reached nobody. Not reached: ${notReached.join(', ')}. Agents in error or paused status are skipped, and the engine can also drop a delivery.`;
      isError = true;
      return { content, isError };
    }
    content = `Broadcast sent to ${sent.length} agent(s): ${sent.join(', ')}` +
      (notReached.length > 0 ? `. Not reached: ${notReached.join(', ')}.` : '');
    return { content, isError };
  },

  async "complete_task"({ agentId, args }) {
    let content = '';
    let isError = false;
    const completeStatus = args.status as string | undefined;
    const completeSummary = args.summary as string | undefined;
    // Map only words whose intent is unambiguous (mirrors the work_update status fix);
    // the divergent side effects are preserved: complete fires the dependency cascade,
    // fallen archives silently, blocked notifies the owner. Anything else is rejected.
    const COMPLETE_STATUSES = ['complete', 'fallen', 'blocked'];
    const COMPLETE_SYNONYMS: Record<string, string> = {
      complete: 'complete', completed: 'complete', done: 'complete', finished: 'complete',
      fallen: 'fallen', failed: 'fallen', fail: 'fallen', cancelled: 'fallen', canceled: 'fallen',
      abandoned: 'fallen', dropped: 'fallen', wontfix: 'fallen',
      blocked: 'blocked', block: 'blocked', stuck: 'blocked', stalled: 'blocked',
    };
    const completeKey = completeStatus!.trim().toLowerCase().replace(/[\s-]+/g, '_');
    const completeMapped = COMPLETE_STATUSES.includes(completeKey) ? completeKey : COMPLETE_SYNONYMS[completeKey];
    if (!completeMapped) {
      content =
        `Error: \`status\` must be one of "complete", "fallen", "blocked" (got "${completeStatus}"). ` +
        `Common words map automatically ("done"/"finished" to complete, "failed"/"cancelled" to fallen, "stuck"/"stalled" to blocked). ` +
        `For work you are giving up on choose "fallen" (archived silently); for work that needs the owner's attention choose "blocked".`;
      isError = true;
      return { content, isError };
    }
    // Idempotent no-op: an already-terminated agent does not re-run the termination path.
    const agentDb = getDb();
    const completeAgentRow = agentDb.prepare('SELECT status FROM agents WHERE id = ?').get(agentId) as { status: string } | undefined;
    if (completeAgentRow?.status === 'terminated') {
      content = `Task completion was already recorded, you are terminated. No action taken.`;
      return { content, isError };
    }
    // ENGINE ENFORCEMENT: complete_task terminates the calling agent, gated to spawned agents
    // (plus the per-cycle Dreamer and Healer). The surface filter is advice and the model can
    // emit an unfiltered call, so re-check FRESH state here; a persistent agent must NOT end.
    if (!agentCanSelfCompleteById(agentId)) {
      content =
        `complete_task ends a spawned agent's lifecycle and is not available to a persistent agent. ` +
        `To hand tracker work in use work_update(action="hand_in", task_id=..., outcome="finished", proof=[...], note). ` +
        `If you are blocked, say so in your reply so the person you are talking to can act.`;
      isError = true;
      return { content, isError };
    }
    if (completeMapped !== 'blocked') {
      const no = await completeTaskHandIn(agentId, completeMapped as 'complete' | 'fallen', completeSummary ?? '');
      if (no) return { content: no, isError: true };
    }
    // Hand-in first, last words second: a refused hand-in above has sent nothing.
    await finalWordsBack({
      workerId: agentId, taskId: resolveAgentTaskId(agentId),
      text: [completeSummary, args.results as string | undefined].filter(Boolean).join('\n\n'),
      outcome: completeMapped === 'complete' ? 'COMPLETE' : 'FAIL', orNewThread: true,
    });
    try {
      await completeAgent(agentId, completeMapped as 'complete' | 'fallen' | 'blocked', completeSummary!);
      content = `Task completion reported: ${completeMapped}. Agent will be terminated.`;
    } catch (err) {
      content = friendlyDbError(err, 'complete_task');
      isError = true;
    }
    return { content, isError };
  },

  async "update_agent"({ agentId, args }) {
    let content = '';
    let isError = false;
    try {
      const newName = args.name as string | undefined;
      const newPrompt = args.system_prompt as string | undefined;
      const newModelId = args.model_id as string | undefined;
      const newPerms = args.permissions as Record<string, unknown> | undefined;
      const newTools = args.tools as Record<string, unknown> | undefined;
      const newGrants = args.grants;
      if (newName === undefined && newPrompt === undefined && newModelId === undefined && newPerms === undefined && newTools === undefined && newGrants === undefined) {
        content = 'Error: provide at least one of name, system_prompt, model_id, permissions, tools, or grants to update.';
        isError = true;
        return { content, isError };
      }
      // The permissions document carries the grants beside the manifest; the grants half is judged below.
      const { grants: _docGrants, ...manifestPart } = newPerms ?? {};
      const permsCheck = newPerms === undefined ? null : validateManifest(manifestPart);
      if (permsCheck && !permsCheck.ok) return { content: `Error: invalid permission manifest, ${permsCheck.reason}`, isError: true };
      const db = getDb();
      const uaResolved = resolveAgentRef(args.agent_id as string, 'update_agent');
      if (!uaResolved.ok) { content = uaResolved.error; isError = true; return { content, isError }; }
      const target = db.prepare('SELECT id, name, model_id FROM agents WHERE id = ?').get(uaResolved.id) as { id: string; name: string; model_id: string | null };
      const changes: string[] = [];
      let finalName = target.name;

      // Model resolved and the 32K floor checked FIRST, so a refusal leaves the edit unwritten.
      let resolvedModel: { id: string; name: string; is_enabled: number } | undefined;
      if (typeof newModelId === 'string' && newModelId !== 'auto') {
        // Resolve forgivingly: id, then case-insensitive name/api_model_id, then a unique
        // name substring; the schema primes names, so an exact-id lookup often misses.
        let model = db.prepare('SELECT id, name, is_enabled FROM models WHERE id = ?').get(newModelId) as { id: string; name: string; is_enabled: number } | undefined;
        if (!model) {
          const exact = db.prepare('SELECT id, name, is_enabled FROM models WHERE LOWER(name) = LOWER(?) OR LOWER(api_model_id) = LOWER(?)').all(newModelId, newModelId) as Array<{ id: string; name: string; is_enabled: number }>;
          if (exact.length === 1) model = exact[0];
          else if (exact.length === 0) {
            const sub = db.prepare('SELECT id, name, is_enabled FROM models WHERE LOWER(name) LIKE LOWER(?)').all(`%${newModelId}%`) as Array<{ id: string; name: string; is_enabled: number }>;
            if (sub.length === 1) model = sub[0];
          }
        }
        if (!model) { content = `Error: no model matches "${newModelId}". Call list_models for valid names and ids.`; isError = true; return { content, isError }; }
        if (!model.is_enabled) { content = `Error: Model "${model.name}" is disabled. Enable it in Settings → Models first.`; isError = true; return { content, isError }; }
        resolvedModel = model;
        const refused = await refuseAgentModel(model.id, target.model_id);
        if (refused) { content = `Error: ${refused}`; isError = true; return { content, isError }; }
      }

      // THE EDIT DOOR FOR ACCESS, separate from the manifest block below on purpose:
      // `can_assign_permissions` gates MANIFEST scope, while no-escalation bounds a GRANT
      // against the caller's own holdings, so even a permission holder cannot grant a
      // channel it lacks. The writes run first as a dry run via `inspectGainRefusal`.
      const applyAccess = (changes: string[]): { content: string; isError: true; errorCode?: 'PERMISSION_DENIED' } | null => {
        if (newGrants !== undefined) {
          const targetGrants = getAccessGrants(target.id);
          const resolution = resolveUpdateGrants(
            newGrants, targetGrants, getAccessGrants(agentId), isPrimaryAgent(agentId),
          );
          if (!resolution.ok) {
            auditLog(agentId, 'update_agent', target.id, 'denied', resolution.reason.slice(0, 400));
            return { content: resolution.reason, isError: true, errorCode: 'PERMISSION_DENIED' as const };
          }
          const delta = grantsDelta(targetGrants, resolution.grants);
          if (delta) {
            writeGrants(target.id, resolution.grants);
            auditLog(agentId, 'update_agent', target.id, 'success', `grants: ${delta}`);
            changes.push(`access grants: ${delta}`);
          }
        }

        // Permissions and tools policy (access control).
        if (newPerms !== undefined || newTools !== undefined) {
          if (newPerms !== undefined) {
            const existingPermsRow = db.prepare('SELECT permissions FROM agents WHERE id = ?').get(target.id) as { permissions: string };
            const merged = { ...JSON.parse(existingPermsRow.permissions || '{}'), ...newPerms };
            db.prepare("UPDATE agents SET permissions = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(merged), target.id);
            changes.push(`permissions: ${Object.keys(newPerms).join(', ')}`);
          }
          if (newTools !== undefined) {
            const existingToolsRow = db.prepare('SELECT tools_policy FROM agents WHERE id = ?').get(target.id) as { tools_policy: string | null };
            const mergedTools = { ...JSON.parse(existingToolsRow.tools_policy || '{}'), ...newTools };
            db.prepare("UPDATE agents SET tools_policy = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(mergedTools), target.id);
            changes.push(`tools policy: ${Object.keys(newTools).join(', ')}`);
          }
        }
        return null;
      };
      const preRefused = [newGrants, newPerms, newTools].some((v) => v !== undefined) ? inspectGainRefusal(agentId, target.id, () => applyAccess([])) : null;
      if (preRefused) return typeof preRefused === 'string' ? { content: preRefused, isError: true, errorCode: 'PERMISSION_DENIED' as const } : preRefused;
      // Identity (name / system_prompt).
      if (newName !== undefined || newPrompt !== undefined) {
        if (typeof newName === 'string' && newName.trim() && newName.trim() !== target.name) {
          const trimmedName = newName.trim();
          // ONE RENAME DOOR: the inline `UPDATE agents SET name` this replaced left the old
          // name baked into stored souls; `renameAgent` updates the row, role name, and souls.
          const renameOutcome = renameAgent(target.id, trimmedName);
          // The rename door's refusal surfaces here as an error, not a changes line.
          if (renameOutcome.refusal) { content = renameOutcome.refusal; isError = true; return { content, isError }; }
          changes.push(`name: "${target.name}" → "${trimmedName}"`);
          finalName = trimmedName;
        }
        if (typeof newPrompt === 'string') {
          // One write door: the store the runtime reads.
          writeAgentPromptSurface(target.id, newPrompt);
          db.prepare("UPDATE agents SET updated_at = datetime('now') WHERE id = ?").run(target.id);
          changes.push(`system prompt rewritten (${newPrompt.length} chars)`);
        }
      }

      if (typeof newModelId === 'string') {
        await setAgentModel(target.id, newModelId === 'auto' ? 'auto' : resolvedModel!.id);
        changes.push(newModelId === 'auto' ? 'model → auto-routing' : `model: ${target.model_id ?? 'auto'} → ${resolvedModel!.name}`);
      }
      const accessRefused = applyAccess(changes); if (accessRefused) return accessRefused;
      if (changes.length === 0) {
        content = `No changes: ${target.name} already matches the requested values.`;
      } else {
        content = `Updated ${finalName}: ${changes.join('; ')}`;
        logger.info('Agent updated via update_agent', { callerAgentId: agentId, targetAgentId: target.id, changes }, agentId);
      }
    } catch (err) {
      content = `Error updating agent: ${err instanceof Error ? err.message : String(err)}`;
      isError = true;
    }
    return { content, isError };
  },

  async "get_agent_profile"({ agentId, args }) {
    let content = '';
    let isError = false;
    try {
      const db = getDb();
      const gapResolved = resolveAgentRef(args.agent_id as string, 'get_agent_profile');
      if (!gapResolved.ok) { content = gapResolved.error; isError = true; return { content, isError }; }
      interface AgentProfileRow {
        id: string;
        name: string;
        status: string;
        classification: string | null;
        model_id: string | null;
        tools_policy: string | null;
        permissions: string | null;
        parent_agent: string | null;
        group_id: string | null;
        agent_type: string | null;
        spawn_depth: number | null;
        created_at: string;
        updated_at: string;
      }
      const target = db.prepare(`
        SELECT id, name, status, classification, model_id, tools_policy, permissions,
               parent_agent, group_id, agent_type, spawn_depth, created_at, updated_at
        FROM agents WHERE id = ?
      `).get(gapResolved.id) as AgentProfileRow;

      // The agent's STORED identity through the one surface the Settings card and the
      // runtime both use; a raw first-system-row SELECT can return an engine marker.
      let systemPrompt: string;
      try { systemPrompt = readAgentPromptSurface(target.id); }
      catch { systemPrompt = '(the saved prompt could not be read just now)'; }

      let modelLabel = '(none / auto-routed)';
      if (target.model_id && target.model_id !== 'auto') {
        const modelRow = db.prepare('SELECT name, api_model_id FROM models WHERE id = ?').get(target.model_id) as { name: string; api_model_id: string } | undefined;
        modelLabel = modelRow ? `${modelRow.name} (${modelRow.api_model_id}, id=${target.model_id})` : `id=${target.model_id} (model row missing)`;
      } else if (target.model_id === 'auto') {
        modelLabel = 'auto-routed';
      }

      let groupLabel = '(none)';
      if (target.group_id) {
        const groupRow = db.prepare('SELECT name FROM agent_groups WHERE id = ?').get(target.group_id) as { name: string } | undefined;
        groupLabel = groupRow ? `${groupRow.name} (id=${target.group_id})` : `id=${target.group_id}`;
      }

      const formatJson = (raw: string | null, fallback: string): string => {
        if (!raw) return fallback;
        try { return JSON.stringify(JSON.parse(raw), null, 2); } catch { return raw; }
      };
      const toolsPolicyText = formatJson(target.tools_policy, '(default, no policy set)');
      const permissionsText = formatJson(target.permissions, '(default, no permissions set)');

      content = [
        `Agent: ${target.name} (id=${target.id})`,
        `Status: ${target.status}`,
        `Classification: ${target.classification ?? '(none)'}`,
        `Type: ${target.agent_type ?? 'sub-agent'}`,
        `Spawn depth: ${target.spawn_depth ?? 0}`,
        `Parent agent: ${target.parent_agent ?? '(none)'}`,
        `Group: ${groupLabel}`,
        `Model: ${modelLabel}`,
        `Created: ${target.created_at}`,
        `Updated: ${target.updated_at}`,
        '',
        '── System prompt ──',
        systemPrompt || '(empty, no system prompt set)',
        '',
        '── Tools policy ──',
        toolsPolicyText,
        '',
        '── Permissions ──',
        permissionsText,
        '',
        // `getAccessGrants` answers for every agent, declared or derived, and these
        // two lines reuse the same wording `list_agents` and `spawn_agent` print.
        '── Access ──',
        `Capability: ${capabilityClause(target.id) || '(unavailable)'}`,
        accessLine(target.id).trim() || 'Access: (unavailable)',
      ].join('\n');

      logger.info('Agent profile read via tool', { callerAgentId: agentId, targetAgentId: target.id }, agentId);
    } catch (err) {
      content = `Error reading agent profile: ${err instanceof Error ? err.message : String(err)}`;
      isError = true;
    }
    return { content, isError };
  },

  async "create_agent_group"({ agentId, args }) {
    let content = '';
    let isError = false;
    try {
      const group = createGroup(
        args.name as string,
        args.description as string,
        agentId,
      );
      content = `Group created: "${group.name}" (ID: ${group.id})`;
    } catch (err) {
      content = friendlyDbError(err, 'create_agent_group');
      isError = true;
    }
    return { content, isError };
  },

  async "update_group"({ agentId, args }) {
    let content = '';
    let isError = false;
    const ugResolved = resolveGroupRef(args.group_id as string, 'update_group');
    if (!ugResolved.ok) { content = ugResolved.error; isError = true; return { content, isError }; }
    const gid = ugResolved.id;
    const newName = args.name as string | undefined;
    const newDescription = args.description as string | undefined;
    if (newName === undefined && newDescription === undefined) {
      content = 'Error: provide at least one of `name` or `description` to update.';
      isError = true;
      return { content, isError };
    }

    if (gid === SYS_GROUP_U && !isPrimaryAgent(agentId)) {
      content = 'Cannot modify the System group.';
      isError = true;
      return { content, isError };
    }

    const existing = getGroupDetail(gid);
    if (!existing) {
      content = `Error: Group ${gid} not found`;
      isError = true;
      return { content, isError };
    }

    const updates: { name?: string; description?: string } = {};
    const changes: string[] = [];
    if (typeof newName === 'string' && newName.trim() && newName.trim() !== existing.name) {
      updates.name = newName.trim();
      changes.push(`name: "${existing.name}" → "${newName.trim()}"`);
    }
    if (typeof newDescription === 'string' && newDescription !== (existing.description ?? '')) {
      updates.description = newDescription;
      changes.push(`description updated (${newDescription.length} chars)`);
    }

    if (changes.length === 0) {
      content = `No changes: group "${existing.name}" already matches the requested values.`;
      return { content, isError };
    }

    const updated = doUpdateGroup(gid, updates);
    if (!updated) {
      content = `Error: Failed to update group ${gid}`;
      isError = true;
      return { content, isError };
    }

    content = `Group "${updates.name ?? existing.name}" updated: ${changes.join('; ')}`;
    logger.info('Group updated via tool', { callerAgentId: agentId, groupId: gid, updates });
    return { content, isError };
  },

  async "assign_to_group"({ args }) {
    let content = '';
    let isError = false;
    const atgAgent = resolveAgentRef(args.agent_id as string, 'assign_to_group');
    if (!atgAgent.ok) { content = atgAgent.error; isError = true; return { content, isError }; }
    // `group_id` is handler-judged (see the `fields` declaration): null must reach the
    // writer so the model can ungroup, and the refusals match the generic boundary's.
    const atgGroupArg = args.group_id;
    if (atgGroupArg === undefined) {
      content = 'Error: `group_id` is required.';
      isError = true;
      return { content, isError };
    }
    if (atgGroupArg === null) {
      const ungroupResult = assignAgentToGroup(atgAgent.id, null);
      if (!ungroupResult.ok) {
        content = `Error: ${ungroupResult.error}`;
        isError = true;
      } else {
        content = `Agent ${atgAgent.id} removed from its group (now ungrouped)`;
      }
      return { content, isError };
    }
    if (typeof atgGroupArg !== 'string') {
      content = `Error: \`group_id\` must be a string (got ${Array.isArray(atgGroupArg) ? 'array' : typeof atgGroupArg}).`;
      isError = true;
      return { content, isError };
    }
    if (!atgGroupArg.trim()) {
      content = 'Error: `group_id` cannot be empty.';
      isError = true;
      return { content, isError };
    }
    const atgGroup = resolveGroupRef(atgGroupArg, 'assign_to_group');
    if (!atgGroup.ok) { content = atgGroup.error; isError = true; return { content, isError }; }
    const assignResult = assignAgentToGroup(atgAgent.id, atgGroup.id);
    if (!assignResult.ok) {
      content = `Error: ${assignResult.error}`;
      isError = true;
    } else {
      content = `Agent ${atgAgent.id} assigned to group ${atgGroup.id}`;
    }
    return { content, isError };
  },

  async "list_agents"({ args }) {
    let content = '';
    const isError = false;
    const listDb = getDb();
    const includeTerminated = args.include_terminated as boolean | undefined;
    const verbose = args.verbose as boolean | undefined;
    const statusFilter = includeTerminated ? '' : "AND status != 'terminated'";
    const agentRows = listDb.prepare(`
      SELECT a.id, a.name, a.status, a.classification, a.group_id,
             a.last_error, a.last_error_at, a.created_at,
             g.name as group_name
      FROM agents a
      LEFT JOIN agent_groups g ON g.id = a.group_id
      WHERE 1=1 ${statusFilter}
      ORDER BY a.name ASC
    `).all() as Array<Record<string, unknown>>;

    // INJURED / PAUSED stay ALL-CAPS in both modes: a caller that misses them keeps
    // waiting on a dead peer. Operational signal, not decoration.
    const labelForStatus = (s: string, brief: boolean): string => {
      switch (s) {
        case 'idle': return brief ? 'ready' : 'ready';
        case 'working': return 'working';
        case 'paused': return brief ? 'PAUSED' : 'PAUSED (hit error loop, needs reset_session to recover)';
        case 'error': return brief ? 'INJURED' : 'INJURED (runtime error, needs reset_session to recover, or will retry on next message but may re-fail)';
        case 'terminated': return 'terminated';
        default: return s;
      }
    };

    let lines: string[];
    if (verbose) {
      // Verbose mode: activity timestamps, dormant detection, group names, last_error.
      const nowMs = Date.now();
      const DORMANT_DAYS = 7;
      lines = agentRows.map(a => {
        const lastMsg = listDb.prepare(
          `SELECT datetime(created_at/1000,'unixepoch') AS created_at FROM messages WHERE agent_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`
        ).get(a.id as string) as { created_at: string } | undefined;
        const createdTs = a.created_at ? ((a.created_at as string).includes('Z') ? a.created_at as string : (a.created_at as string) + 'Z') : null;
        const createdMs = createdTs ? new Date(createdTs).getTime() : 0;
        const isNewlyCreated = (nowMs - createdMs) < DORMANT_DAYS * 86400000;
        let activityStr = '';
        let dormant = false;
        if (lastMsg) {
          const lastTs = lastMsg.created_at.includes('Z') ? lastMsg.created_at : lastMsg.created_at + 'Z';
          const lastMs = new Date(lastTs).getTime();
          const ageDays = Math.floor((nowMs - lastMs) / 86400000);
          if (ageDays >= DORMANT_DAYS && !isNewlyCreated) {
            dormant = true;
            activityStr = `, DORMANT (last active ${ageDays} days ago)`;
          } else if (ageDays >= 1) {
            activityStr = `, last active ${ageDays}d ago`;
          } else {
            const ageHours = Math.floor((nowMs - lastMs) / 3600000);
            activityStr = ageHours > 0 ? `, last active ${ageHours}h ago` : ', active recently';
          }
        } else if (isNewlyCreated) {
          activityStr = ', newly created';
        } else {
          activityStr = ', no activity';
          dormant = true;
        }
        const caps = capabilityClause(a.id as string);
        let line = `- ${a.name} (ID: ${a.id}), ${labelForStatus(a.status as string, false)}, ${a.classification}${a.group_name ? `, group: ${a.group_name}` : ''}${activityStr}${caps ? ` — ${caps}` : ''}`;
        if ((a.status === 'error' || a.status === 'paused') && a.last_error) {
          const errorSnippet = (a.last_error as string).slice(0, 150);
          line += `\n    Last error: ${errorSnippet}`;
        }
        if (dormant && a.status !== 'error' && a.status !== 'paused') {
          line += '\n    ^ Dormant, no recent activity, safe to ignore unless explicitly needed';
        }
        return line;
      });
    } else {
      // Compact: name, id, status, classification, optional group. No
      // activity timestamps; no dormant detection; injured/paused agents
      // still flagged loudly because that's load-bearing operational info.
      lines = agentRows.map(a => {
        const groupSuffix = a.group_name ? `, group: ${a.group_name}` : '';
        // Capability truth in BOTH modes: compact is what an agent reads before delegating.
        const caps = capabilityClause(a.id as string);
        return `- ${a.name} (${a.id}), ${labelForStatus(a.status as string, true)}, ${a.classification}${groupSuffix}${caps ? ` — ${caps}` : ''}`;
      });
    }

    // The injured/paused warning fires in BOTH modes: it is a safety signal.
    const injuredCount = agentRows.filter(a => a.status === 'error' || a.status === 'paused').length;
    if (injuredCount > 0) {
      lines.push('');
      lines.push(`⚠️ ${injuredCount} agent(s) injured/paused. Use reset_session(agent_id=...) to heal, or reassign work. Don't wait on an injured agent.`);
    }
    const baseOutput = lines.join('\n') || 'No agents found.';
    content = baseOutput + compactListTrailer({
      count: agentRows.length,
      expandTool: 'get_agent_profile',
      expandArg: 'agent_id',
      listTool: 'list_agents',
      verbose: !!verbose,
    });
    return { content, isError };
  },

  async "list_models"() {
    let content = '';
    const isError = false;
    const modelDb = getDb();
    const modelRows = modelDb.prepare(`
      SELECT m.id, m.name, m.api_model_id, p.name as provider_name, p.type as provider_type,
             m.input_cost_per_m, m.output_cost_per_m, m.context_window,
             m.max_output_tokens, m.thinking_enabled, m.capabilities
      FROM models m
      JOIN providers p ON p.id = m.provider_id
      WHERE m.is_enabled = 1 AND m.capabilities NOT LIKE '%"decision"%'
      ORDER BY COALESCE(m.input_cost_per_m, 0) ASC
    `).all() as Array<Record<string, unknown>>;   // the Dojo's decision model is no agent's model
    content = modelRows.map(m => {
      const inputCost = (m.input_cost_per_m as number) ?? 0;
      const outputCost = (m.output_cost_per_m as number) ?? 0;
      const costStr = inputCost === 0 && outputCost === 0
        ? 'FREE (local)'
        : `$${inputCost}/M in, $${outputCost}/M out`;
      const ctx = m.context_window ? `${Math.round((m.context_window as number) / 1000)}k ctx` : '';
      const maxOut = m.max_output_tokens ? `${Math.round((m.max_output_tokens as number) / 1000)}k max out` : '';
      let caps: string[] = [];
      if (m.capabilities) {
        try { caps = JSON.parse(m.capabilities as string); } catch { /* ignore */ }
      }
      const capStr = caps.length > 0 ? caps.join(', ') : 'text';
      const thinking = m.thinking_enabled ? 'thinking' : '';
      const features = [capStr, thinking, ctx, maxOut].filter(Boolean).join(', ');
      return `- ${m.name} (ID: ${m.id}), ${m.provider_name} (${m.provider_type}), ${costStr} | ${features}`;
    }).join('\n') || 'No enabled models found.';
    return { content, isError };
  },

  async "list_groups"({ args }) {
    let content = '';
    const isError = false;
    const allGroups = listAllGroups();
    const verbose = args.verbose as boolean | undefined;
    const lines = verbose
      ? allGroups.map(g => `- ${g.name} (ID: ${g.id}), ${g.memberCount} member(s)${g.description ? `: ${g.description}` : ''}`)
      : allGroups.map(g => `- ${g.name} (${g.id}), ${g.memberCount} member(s)`);
    const baseOutput = lines.join('\n') || 'No groups found.';
    content = baseOutput + compactListTrailer({
      count: allGroups.length,
      expandTool: 'get_group_detail',
      expandArg: 'group_id',
      listTool: 'list_groups',
      verbose: !!verbose,
    });
    return { content, isError };
  },

  async "get_group_detail"({ args }) {
    let content = '';
    let isError = false;
    const ggdResolved = resolveGroupRef(args.group_id as string, 'get_group_detail');
    if (!ggdResolved.ok) { content = ggdResolved.error; isError = true; return { content, isError }; }
    const detail = getGroupDetail(ggdResolved.id);
    if (!detail) {
      content = `Error: Group ${ggdResolved.id} no longer exists.`;
      isError = true;
      return { content, isError };
    }
    const memberLines = detail.members.length > 0
      ? detail.members.map(m => `  - ${m.name} (${m.id}), ${m.classification}, ${m.status}`).join('\n')
      : '  (no members)';
    content = [
      `Group: ${detail.name} (${detail.id})`,
      detail.description ? `Description: ${detail.description}` : 'Description: (none)',
      `Members: ${detail.memberCount}`,
      memberLines,
      `Created: ${detail.createdAt} by ${detail.createdBy}`,
      detail.dreamerIgnore ? 'Dreamer-ignore: yes' : '',
    ].filter(Boolean).join('\n');
    return { content, isError };
  },

  async "delete_group"({ agentId, args }) {
    let content = '';
    let isError = false;
    const dgResolved = resolveGroupRef(args.group_id as string, 'delete_group');
    if (!dgResolved.ok) { content = dgResolved.error; isError = true; return { content, isError }; }
    const groupId = dgResolved.id;

    if (groupId === SYS_GROUP) {
      content = 'Cannot delete the System group. Nothing was changed.';
      isError = true;
      return { content, isError };
    }

    // Terminate members BEFORE deleting the group (deleteGroup sets group_id to NULL,
    // so we must query members while group_id still matches)
    const terminated: string[] = [];
    const skipped: string[] = [];
    if (args.terminate_members) {
      const groupDb = getDb();
      const members = groupDb.prepare("SELECT id, name, classification FROM agents WHERE group_id = ? AND status != 'terminated'").all(groupId) as Array<{ id: string; name: string; classification: string }>;
      for (const member of members) {
        if (member.classification === 'sensei' || member.classification === 'ronin') {
          skipped.push(`${member.name} (${member.classification}: a group delete does not end it; kill_agent does)`);
          continue;
        }
        try {
          terminateAgent(member.id, `Group deleted by agent ${agentId}`);
          terminated.push(member.name);
        } catch (err) {
          skipped.push(`${member.name} (terminate failed: ${err instanceof Error ? err.message : String(err)})`);
        }
      }
      if (terminated.length > 0) {
        logger.info('Terminated group members before deletion', { groupId, terminated });
      }
    }

    // The tasks of terminated members (or of the group) are handed in as can't be done on the termination
    // record, and their schedules stop now, so no task is left with a worker that no longer exists.
    if (args.terminate_members) {
      const orphanedTasks = getDb().prepare(`
        SELECT w.id AS id FROM work w
        WHERE ${taskScope('w')}
          AND (w.assigned_to_group = ? OR w.agent_id IN (SELECT id FROM agents WHERE group_id = ? AND status = 'terminated'))
          AND ${workingExpr('w', true)}
      `).all(groupId, groupId) as Array<{ id: string }>;
      const { terminateLiveScheduleOnFallen } = await import('../../../scheduler/runner.js');
      for (const t of orphanedTasks) {
        engineHandIn(t.id, `the group this task belonged to was deleted by ${agentId} and its members terminated`, { outcome: 'cant_be_done' });
        terminateLiveScheduleOnFallen(t.id, 'the group this task belonged to was deleted', 'schedule stopped with the group');
      }
    }

    const deleted = doDeleteGroup(groupId);
    if (deleted) {
      const parts = [`Group ${groupId} deleted.`];
      if (args.terminate_members) {
        if (terminated.length > 0) parts.push(`Terminated: ${terminated.join(', ')}.`);
        if (skipped.length > 0) parts.push(`Skipped: ${skipped.join('; ')}.`);
        if (terminated.length === 0 && skipped.length === 0) parts.push('No members to terminate.');
      } else {
        parts.push('Remaining agents moved to ungrouped.');
      }
      content = parts.join(' ');
    } else {
      content = `Failed to delete group ${groupId}. It may not exist.`;
      isError = true;
    }
    return { content, isError };
  },
};
