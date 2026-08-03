// ════════════════════════════════════════════════════════════════════════════
// MANAGING OTHER AGENTS (PHASE-5 T4 — relocated from `agent/tools.ts`)
//
// Seventeen dispatch keys: the spawn/terminate lifecycle (`spawn_agent`,
// `kill_agent`, `spawn_timeout_decision`, `complete_task`), agent-to-agent
// traffic (`send_to_agent`, `broadcast_to_group`), the destructive-action
// approval a sub-agent asks its primary for, the identity/profile verbs
// (`update_agent`, `get_agent_profile`, `list_agents`, `list_models`) and the
// squad verbs (`create_agent_group`, `update_group`, `assign_to_group`,
// `list_groups`, `get_group_detail`, `delete_group`).
//
// RELOCATION, NOT REWRITE. Four things are load bearing and byte-faithful:
//
// 1. **`complete_task`'s `agentCanSelfCompleteById` re-check.** FN-8: the tool
//    ends a SPAWNED agent's lifecycle, and the surface filter is only advice
//    (Architecture Rule 1). The handler re-reads the agent row FRESH rather
//    than trusting a filter-time snapshot, which is why the predicate lives in
//    `tools/util.ts` and is called here.
// 2. **`send_to_agent`/`broadcast_to_group`'s argument ALIASES.** T3C declared
//    them `requiredNotEnforced` WITH THE REASON: a broadcast that passes
//    `payload` instead of `message` works today and the schema cannot say so.
//    The body's own argument handling is what makes that true; it is unchanged.
// 3. **`kill_agent` / `delete_group`'s `created_by` checks are NOT here.** Both
//    are DECLARED gates (T2 rows) that resolve their target through the same
//    resolvers these handlers use, evaluated in the executor ahead of dispatch.
// 4. **`resolveSpawnSquad` moved WITH `spawn_agent`**, its only caller
//    (re-derived at this HEAD). P4's rule that every agent-spawned agent lands
//    in a squad is its whole content, including the fallback that logs rather
//    than refusing when project-squad resolution fails.
// ════════════════════════════════════════════════════════════════════════════

import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../../../db/connection.js';
import { broadcast } from '../../../gateway/ws.js';
import { isPrimaryAgent } from '../../../config/platform.js';
import { insertMessageIfAbsent, rewriteSystemPromptRow } from '../../../memory/message-store.js';
import { writeToolReceipt } from '../../../receipts/store.js';
import { taskScope, projectScope, STATE_TO_STATUS_SQL } from '../../../work/tracker-view.js';
import { patchWork, setTrackerStatus, deliveryForTaskClose } from '../../../work/tracker-store.js';
import { skipOpenOccurrencesAsComplete } from '../../../work/occurrences.js';
import { spawnAgent, terminateAgent, completeAgent, applySpawnTimeoutDecision } from '../../spawner.js';
import { createGroup, assignAgentToGroup } from '../../groups.js';
import { friendlyDbError, resolveAgentRef, resolveGroupRef, compactListTrailer } from '../../tool-helpers.js';

import { auditLog, agentCanSelfCompleteById, toolsLogger as logger } from '../util.js';
import { activeRuns } from '../../shared-state.js';
import { currentTurnKind } from '../../turn-state.js';
import { decideApproval } from '../../destructive-gate.js';
import { findInboundAssignByThread, recordA2AReply } from '../../a2a-replies.js';
import { getAgentPermissions } from '../../permissions.js';
import { isHealerAgent } from '../../../config/platform.js';
import { isNoWakeIntent, deliverA2AMessage, deliverA2AMessage as deliverBc } from '../../a2a-transport.js';
import { onAgentRecovered } from '../../../healer/injury-recovery.js';
import { resolveTaskId, getTask } from '../../../tracker/schema.js';
import { sanitizeMessagesOnModelChange } from '../../model-switch.js';
import { updateGroup as doUpdateGroup, SYSTEM_GROUP_ID as SYS_GROUP_U, getGroupDetail, getGroups as listAllGroups, deleteGroup as doDeleteGroup, SYSTEM_GROUP_ID as SYS_GROUP } from '../../groups.js';
import { writeTaskLog } from '../../../tracker/task-log.js';
import type { ToolHandlerMap } from '../handler.js';

// ── P4: mandatory squad resolution for agent spawns ──
// Every agent-spawned agent lands in a squad so the owner can see which spawned
// agents belong to which work. Resolution order:
//   1. explicit group_id  -> must exist AND be creator-owned or already stamped
//      on a project (an existing project squad the caller is joining)
//   2. linked task's project already has a squad -> reuse it
//   3. linked task's project has no squad -> auto-create one NAMED AFTER THE
//      PROJECT and stamp projects.group_id (migration 109) so later spawns join
//   4. no project linkage -> auto-create a squad named after the caller
// Returns the resolved group id + a user-facing squad name, or an error string.
// (Only the spawn_agent TOOL path calls this; internal engine spawns do not.)
async function resolveSpawnSquad(opts: {
  callerAgentId: string;
  rawTaskId?: string;
  explicitGroupId?: string;
}): Promise<{ groupId: string; squadName: string; note: string } | { error: string }> {
  const db = getDb();

  // 1. Explicit group_id: must exist and be creator-owned or project-stamped.
  if (opts.explicitGroupId) {
    const ref = resolveGroupRef(opts.explicitGroupId, 'spawn_agent');
    if (!ref.ok) return { error: ref.error };
    const grp = db.prepare('SELECT id, name, created_by FROM agent_groups WHERE id = ?').get(ref.id) as { id: string; name: string; created_by: string | null } | undefined;
    if (!grp) return { error: `Squad "${opts.explicitGroupId}" doesn't exist. Omit group_id to auto-create a squad, or pass one you created.` };
    const ownsIt = grp.created_by === opts.callerAgentId;
    const projectStamped = !!db.prepare(`SELECT 1 FROM work w WHERE ${projectScope('w')} AND w.group_id = ? LIMIT 1`).get(ref.id);
    if (!ownsIt && !projectStamped) {
      return { error: `You can only spawn into a squad you created or a project's squad. "${grp.name}" is neither. Omit group_id to auto-create your own squad.` };
    }
    return { groupId: grp.id, squadName: grp.name, note: '' };
  }

  // 2/3. Linked task -> project -> squad.
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
            patchWork(proj.id, { group_id: group.id });
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

  // 4. No project linkage: a squad named after the caller groups its ad-hoc spawns.
  const caller = db.prepare('SELECT name FROM agents WHERE id = ?').get(opts.callerAgentId) as { name: string } | undefined;
  const callerName = caller?.name ?? 'Agent';
  const group = createGroup(`${callerName}'s squad`, `Ad-hoc squad for agents spawned by ${callerName}.`, opts.callerAgentId);
  return { groupId: group.id, squadName: group.name, note: '' };
}

export const agentsHandlers: ToolHandlerMap = {
  async "spawn_agent"({ agentId, args }) {
    let content = '';
    let isError = false;
    // If the agent is passing custom permissions, check can_assign_permissions
    if (args.permissions) {
      const parentPerms = getAgentPermissions(agentId);
      if (!parentPerms.can_assign_permissions) {
        content = 'Permission denied: this agent cannot assign permissions to sub-agents. Spawn without custom permissions, or ask a user to grant "Assign Permissions" access.';
        isError = true;
        auditLog(agentId, 'spawn_agent', null, 'denied', 'can_assign_permissions is false');
        return { content, isError };
      }
    }
    // P3 (spawn contract): the creator owns the timeout. A non-ronin spawn
    // REQUIRES timeout_minutes, there is no engine default. Reject a missing/
    // invalid value with a teaching error naming the parameter and pointing
    // at ronin for open-ended work.
    const spawnClassification: 'ronin' | 'apprentice' = args.classification === 'ronin' ? 'ronin' : 'apprentice';
    let timeoutSecondsArg: number | undefined;
    if (spawnClassification !== 'ronin') {
      const tm = args.timeout_minutes;
      if (typeof tm !== 'number' || !Number.isFinite(tm) || tm <= 0) {
        content = `spawn_agent needs timeout_minutes for this sub-agent: how many minutes it may run before you (its creator) are asked to extend it or let it stop. There is no default. Size it to the task (a quick lookup ~5, a longer build ~30-60). If the work should run open-ended with no timeout, spawn it with classification="ronin" instead (ronin has no timeout and is dismissed only by the user).`;
        isError = true;
        auditLog(agentId, 'spawn_agent', args.name as string | null, 'denied', 'missing timeout_minutes');
        return { content, isError };
      }
      timeoutSecondsArg = Math.round(tm * 60);
    }

    // P4 (mandatory squads): resolve the squad this spawn lands in before
    // creating the agent, so its group_id is set at insert and the tool
    // result can name the squad.
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

    // v2.3.19 (Scenario 7 finding), wrap in try/catch so raw SQLite
    // errors ("FOREIGN KEY constraint failed", etc.) don't leak to
    // the agent. friendlyDbError translates them into actionable
    // plain language.
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
        groupId: squad.groupId,
        initialMessage: args.initial_message as string | undefined,
        equippedTechniques: args.techniques as string[] | undefined,
        alwaysLoadedTools: args.always_loaded_tools as string[] | undefined,
        autoStart: args.auto_start as boolean | undefined,
      });
      // Delegation assignment (demolition Phase 1.7, the Brookstom modeling
      // fix): spawning WITH a task_id means the caller is delegating that task
      // to the new agent, so reassign it (assigned_to = the spawned agent)
      // unless keep_assignment=true. Tasks pre-created by the parent default to
      // assigned_to=parent; without this, the tracker would model the parent as
      // the doer while the sub-agent actually does the work. spawnAgent already
      // set agents.task_id but does NOT touch tasks.assigned_to, so we do it
      // here. Resolve the id the same way the tracker verbs do, and skip
      // silently if it no longer resolves (the FK on spawn would already have
      // failed a bad id).
      let reassignNote = '';
      if (args.task_id && args.keep_assignment !== true) {
        try {
          const resolvedTask = resolveTaskId(args.task_id as string);
          if (resolvedTask.ok) {
            patchWork(resolvedTask.id, { agent_id: result.agentId, assignee_agent: result.agentId, assigned_to_group: null });
            writeTaskLog({
              taskId: resolvedTask.id,
              fromEntity: `agent:${agentId}`,
              entryKind: 'observation',
              actionTaken: 'reassigned on delegation (spawn_agent with task_id)',
              reason: `work delegated to newly spawned agent ${result.name} (${result.agentId})`,
            });
            const freshTask = getTask(resolvedTask.id);
            if (freshTask) broadcast({ type: 'tracker:task_updated', data: freshTask });
            reassignNote = `\nTask ${resolvedTask.id.slice(0, 8)} reassigned to ${result.name}.`;
          }
        } catch (reassignErr) {
          logger.warn('spawn_agent: task reassignment failed (non-fatal, agent still spawned)', {
            taskId: args.task_id, error: reassignErr instanceof Error ? reassignErr.message : String(reassignErr),
          }, agentId);
        }
      }
      content = `Agent spawned successfully.\nAgent ID: ${result.agentId}\nName: ${result.name}\nStatus: ${result.status}\nPersistent: ${result.persist ? 'yes' : 'no'}\nSquad: ${squad.squadName}${squad.note}${reassignNote}`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // FK constraint failure usually means a bad model_id, group_id,
      // or task_id reference. Make that explicit instead of leaking
      // the raw SQLite message.
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
    // Resolve via the standard helper so names + sensei ids work too.
    const killResolved = resolveAgentRef(args.agent_id as string, 'kill_agent');
    if (!killResolved.ok) { content = killResolved.error; isError = true; return { content, isError }; }
    const targetId = killResolved.id;
    // Check classification before terminating
    const killDb = getDb();
    const targetAgent = killDb.prepare('SELECT classification, status FROM agents WHERE id = ?').get(targetId) as { classification: string; status: string } | undefined;
    if (targetAgent?.classification === 'sensei') {
      content = 'Cannot terminate sensei agent.';
      isError = true;
      return { content, isError };
    }
    if (targetAgent?.classification === 'ronin') {
      content = 'Cannot terminate ronin agent. Only the owner can manage ronin agents from the dashboard.';
      isError = true;
      return { content, isError };
    }
    // Idempotency: killing an already-terminated agent is a no-op.
    if (targetAgent?.status === 'terminated') {
      content = `Agent ${targetId} is already terminated. No action taken.`;
      return { content, isError };
    }
    terminateAgent(targetId, `Killed by agent ${agentId}`);
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
      extendMinutes: typeof args.extend_minutes === 'number' ? (args.extend_minutes as number) : undefined,
    });
    content = stdResult.message;
    isError = !stdResult.ok;
    auditLog(agentId, 'spawn_timeout_decision', stdResolved.id, stdResult.ok ? 'success' : 'denied', stdAction);
    return { content, isError };
  },

  async "send_to_agent"({ agentId, args }) {
    let content = '';
    let isError = false;
            // ── A2A Protocol: Structured inter-agent messaging ──
            // All agent-to-agent communication goes through the A2A transport
            // which enforces thread tracking, hop limits, semantic dedup, and
            // requires_response routing.
            const agentRef = args.agent as string;
            // Normalize case/whitespace so a valid intent in the wrong case (a
            // weak-model habit) is accepted, not rejected into a re-call loop.
            const intent = (args.intent as string | undefined)?.trim().toUpperCase();
            const payload = (args.payload as string) ?? (args.message as string) ?? '';
            if (!payload || !payload.trim()) {
              content = 'Error: send_to_agent needs a non-empty `payload` (or `message`), what you want to say to the other agent.';
              isError = true;
              return { content, isError };
            }

            // Intent is REQUIRED, no silent default. Previously this fell back
            // to 'FYI', which is a no-wake intent. Agents that didn't specify
            // an intent for a wake-needing message (deliver work, ask the primary agent to
            // iMessage, etc.) had their messages silently dead-on-arrival.
            // Force a deliberate choice every call by erroring on missing intent.
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
            const rawAttachPaths = args.attach_paths;
            const attachPaths: string[] = Array.isArray(rawAttachPaths)
              ? rawAttachPaths.filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
              : [];

            // Determine requires_response from explicit arg, or default by intent.
            // ANSWER and DELIVERABLE default to true (receiver is waiting for
            // the content) even though they close the thread. FYI, STATUS,
            // COMPLETE, FAIL default to false (no one is waiting).
            let requiresResponse: boolean;
            if (args.requires_response !== undefined) {
              requiresResponse = !!args.requires_response;
            } else {
              // Default: no-wake intents don't wake; everything else does
              requiresResponse = !isNoWakeIntent(intent as import('../../a2a-transport.js').A2AIntent);
            }
            // No-wake intents ALWAYS force false (transport also enforces this)
            if (isNoWakeIntent(intent as import('../../a2a-transport.js').A2AIntent)) {
              requiresResponse = false;
            }

            // Check if target is injured, healer bypass
            const sendDb = getDb();
            let targetCheck = sendDb.prepare('SELECT id, name, status, created_at FROM agents WHERE id = ?').get(agentRef) as { id: string; name: string; status: string; created_at: string } | undefined;
            if (!targetCheck) {
              targetCheck = sendDb.prepare("SELECT id, name, status, created_at FROM agents WHERE name = ? AND status != 'terminated' ORDER BY created_at DESC LIMIT 1")
                .get(agentRef) as { id: string; name: string; status: string; created_at: string } | undefined;
            }
            if (targetCheck && (targetCheck.status === 'error' || targetCheck.status === 'paused')) {
              // v2.9.20, spawn-race auto-recover. When a newly-spawned
              // sub-agent's initial turn fails (any preflight error: model
              // not ready, network blip, rate limit, etc.), its status
              // flips to 'error' before the parent's first send_to_agent
              // arrives. The parent would then see "Agent INJURED, Message
              // NOT delivered" and be forced to chain spawn → kill →
              // spawn → reset_session manually. The 2026-06-06 vision-
              // delegate workflow hit this on ~80% of spawn attempts.
              //
              // Detect by: agent in error, created in the last 60 seconds.
              // Auto-heal back to idle and let delivery proceed. If the
              // agent had time to do real work and crash (created > 60s
              // ago), this isn't a spawn race - keep the existing
              // rejection so the parent intervenes.
              if (targetCheck.status === 'error') {
                const createdAtMs = new Date(
                  targetCheck.created_at + (targetCheck.created_at.includes('Z') ? '' : 'Z'),
                ).getTime();
                const ageMs = Date.now() - createdAtMs;
                if (ageMs >= 0 && ageMs < 60_000) {
                  try {
                    sendDb.prepare(
                      "UPDATE agents SET status = 'idle', last_error = NULL, last_error_at = NULL, updated_at = datetime('now') WHERE id = ?",
                    ).run(targetCheck.id);
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
            if (targetCheck && (targetCheck.status === 'error' || targetCheck.status === 'paused')) {
              let isHealerSender = false;
              try {
                isHealerSender = isHealerAgent(agentId);
              } catch { /* */ }
              if (!isHealerSender) {
                const stateLabel = targetCheck.status === 'error' ? 'INJURED' : 'PAUSED';
                content = `Agent "${targetCheck.name}" is ${stateLabel}. Message NOT delivered. Use reset_session(agent_id="${targetCheck.id}") to heal them, or reassign the work.`;
                isError = true;
                return { content, isError };
              }
            }

            if (!isError) {
              const result = await deliverA2AMessage({
                intent: intent as import('../../a2a-transport.js').A2AIntent,
                threadId: threadId ?? '',  // empty = auto-generate in transport
                requiresResponse,
                payload,
                toAgent: agentRef,
                fromAgent: agentId,
                attachPaths: attachPaths.length > 0 ? attachPaths : undefined,
              });

              if (result.delivered) {
                const effectiveIntent = result.autoPromotedFromFyi ? 'DELIVERABLE' : intent;
                // v2.5.31, Mark any open inbound ASSIGN/QUESTION/BLOCK on this
                // thread as replied. Without this, the v2 loop's preflight
                // re-derives "you owe a reply" from the most-recent-user-message
                // on every handleMessage invocation; the missed-reply enforcer
                // then fires repeatedly for an ASSIGN the agent already handled.
                // See loop.txt 2026-05-13 for the 30-nudge spiral this prevents.
                try {
                  const inbound = findInboundAssignByThread(agentId, result.threadId);
                  if (inbound) {
                    recordA2AReply({
                      assignMessageId: inbound.messageId,
                      agentId,
                      threadId: result.threadId,
                      replyIntent: effectiveIntent,
                    });
                  }
                } catch { /* best effort, never block the send on bookkeeping */ }
                auditLog(agentId, 'tool_call', 'send_to_agent', 'success',
                  `to:${agentRef} intent:${effectiveIntent}${result.autoPromotedFromFyi ? '(promoted from FYI)' : ''} thread:${result.threadId.slice(0, 8)} requires_response:${requiresResponse}${result.autoCreatedTaskId ? ` task:${result.autoCreatedTaskId.slice(0, 8)}` : ''}`,
                );
                // RC-12: a delivered inter-agent send is a real delivery; record a receipt
                // so the grounding ledger recognizes "I told <agent>" as grounded across
                // turns (recipient = target agent name; the A2A thread id is the provider
                // id). skipAudit: the auditLog row above is the provenance row.
                writeToolReceipt({ agentId, tool: 'send_to_agent', tier: 1, verified: true, basis: 'provider-id', providerId: result.threadId, threadId: result.threadId, recipient: agentRef, sentText: payload, detail: { intent: effectiveIntent }, skipAudit: true });
                content = `[A2A:${effectiveIntent}] Message delivered to "${agentRef}" on thread ${result.threadId.slice(0, 8)}.` +
                  (requiresResponse || result.autoPromotedFromFyi
                    ? ` Their reply is ASYNCHRONOUS, it arrives on a LATER turn, NOT now, and you do NOT have it yet. ` +
                      `If someone is waiting on that answer (e.g. the owner asked you to find it out), tell them you have ASKED ` +
                      `and will report back when "${agentRef}" replies, NEVER make up, guess, or relay a response you have not ` +
                      `actually received. Do not message "${agentRef}" again about this (re-sending does not speed it up). ` +
                      `End your turn now; you will be woken when they answer.`
                    : ' No response expected (read-only context).');
                // A2A busy signal (owner request 2026-07-23): the transport knows the
                // recipient's live state; telling the SENDER prevents the weak-model
                // re-send/escalate reflex when a queued-behind-busy reply reads as
                // being ignored. Purely informational, delivery is unchanged.
                try {
                  if (targetCheck && activeRuns.has(targetCheck.id)) {
                    const humanBusy = currentTurnKind.get(targetCheck.id) === 'user';
                    content += humanBusy
                      ? ` NOTE: "${agentRef}" is currently in a live conversation with their user, so your message is queued and will be served when they are free. Expect a slower reply; do not re-send and do not escalate.`
                      : ` NOTE: "${agentRef}" is currently mid-task, so your message is queued and will be served when they are free. Expect a slower reply; do not re-send.`;
                  }
                } catch { /* best effort; the note is advisory */ }
                if (result.autoPromotedFromFyi) {
                  content +=
                    `\nNote: the engine auto-promoted your FYI to DELIVERABLE because the payload looked deliverable-shaped (URL or completion+artefact reference). Your receiver was woken. Use intent="DELIVERABLE" explicitly next time so the routing is unambiguous.`;
                }
                // Engine-driven task discipline (Phase 7+): ASSIGN intent
                // auto-creates a tracker task. Surface the ID so the sender
                // knows where to track progress without having to call
                // work_open(kind="task") themselves.
                if (result.autoCreatedTaskId) {
                  const taskShort = result.autoCreatedTaskId.slice(0, 8);
                  content += result.autoTaskIsNew
                    ? `\nTask ${taskShort} auto-created and assigned to "${agentRef}", track progress with work_update(action="get", task_id="${result.autoCreatedTaskId}"). You will be notified automatically when they mark it complete.`
                    : `\nContinuing on existing task ${taskShort} (created by an earlier ASSIGN on this thread).`;
                }
              } else {
                // Message was dropped by the protocol, log the reason but don't error
                // (the protocol is doing its job, this is expected behavior)
                auditLog(agentId, 'tool_call', 'send_to_agent', 'success',
                  `to:${agentRef} intent:${intent} reason:${result.reason}`,
                );
                switch (result.reason) {
                  case 'TERMINAL_THREAD_CLOSED':
                    // v2.5.34, Transport no longer rejects on this; if it
                    // somehow still surfaces, it's a transport bug. Tell the
                    // agent something useful instead of "the thread is closed."
                    content = `Thread ${result.threadId.slice(0, 8)} reported a stale closure marker (engine bug, the transport should have auto-cleared it). Try again, or omit thread_id to start a fresh thread.`;
                    break;
                  case 'HOP_LIMIT_EXCEEDED':
                    content = `Thread ${result.threadId.slice(0, 8)} has reached the maximum of 8 messages. Start a new thread (omit thread_id) if you need to continue.`;
                    break;
                  case 'SEMANTIC_DUPLICATE':
                    // W3-4 follow-up: an ASSIGN dropped as a duplicate means the
                    // work is ALREADY assigned (possibly via cross-thread reuse of
                    // an omitted thread_id). Re-sending spawns nothing and does
                    // not speed the reply up; say so instead of the generic copy,
                    // and do NOT advise starting a fresh thread (that is the
                    // duplicate-task vector this guard exists to close).
                    content = intent === 'ASSIGN'
                      ? `Assignment not re-sent: you already assigned essentially this same work to "${agentRef}" moments ago (thread ${result.threadId.slice(0, 8)}). The engine tracks it as a tracker task and you will be woken when they reply or complete it. Do not re-assign; end your turn and wait.`
                      : 'Message not sent, your last few messages on this thread are too similar to this one. The platform thinks you are repeating yourself. Options: (a) if you are reporting work completion, use intent="ANSWER" or intent="DELIVERABLE", those bypass dedup because completion notices need to land regardless of phrasing; (b) rephrase substantively (not just word swaps); (c) start a fresh thread by omitting thread_id.';
                    break;
                  case 'AWAITING_REPLY':
                    // RC-14: the receiver still owes a reply to this sender's last
                    // wake-intent on this thread and we are inside the cooldown.
                    // Re-sending does not speed the reply up; it is dropped
                    // deterministically. Rendered like the ASSIGN-duplicate refusal:
                    // do NOT advise a fresh thread for the re-ask (that just spawns
                    // a parallel open loop).
                    content = intent === 'ASSIGN'
                      ? `Assignment not re-sent: you already assigned this to "${agentRef}" on thread ${result.threadId.slice(0, 8)} and they have not replied yet. The engine tracks it as a tracker task and will wake you when they reply or complete it. Do not re-assign; end your turn and wait.`
                      : `Message not sent: you already have an open ${intent} awaiting a reply from "${agentRef}" on thread ${result.threadId.slice(0, 8)}, and they have not answered yet. Re-asking does not speed it up. End your turn; you will be woken when they reply. (If this is genuinely new, unrelated work, start a fresh thread by omitting thread_id.)`;
                    break;
                  case 'AGENT_NOT_FOUND':
                    content = `No agent found with ID or name "${agentRef}".`;
                    isError = true;
                    break;
                  default:
                    content = `Message not delivered: ${result.reason}`;
                    break;
                }
              }
            }

            // NOTE: do NOT clear the pending iMessage-reply flag here. This is
            // send_to_agent, delegating work to ANOTHER AGENT, never a reply to
            // the user. The earlier code cleared it (with a copy-pasted "if the
            // agent explicitly sent an iMessage" comment that never matched what
            // this handler does), which silently wiped the user's reply recipient
            // mid-turn. Canonical failure: user iMessages "pause Nora", the agent
            // delegates the pause to Nora via send_to_agent, the clear nukes the
            // pending sender, and the end-of-turn auto-route has no one to deliver
            // to, so the reply falls into dashboard chat the user never sees.
            // The only legitimate "the agent handled the reply itself" clear lives
            // in imessage_send (double-send guard); stale flags are swept at
            // end-of-turn by the `if (imFlagSetAtRunStart)` cleanup in loop.ts.
            return { content, isError };
  },

  async "approve_destructive_action"({ agentId, args }) {
    let content = '';
    let isError = false;
    // Primary-only: the gate routes requests here, and only the primary
    // decides (open question 6 hierarchy).
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

    // Intent is REQUIRED, same rationale as send_to_agent.
    const BC_VALID_INTENTS = ['QUESTION', 'ASSIGN', 'BLOCK', 'ANSWER', 'DELIVERABLE', 'FYI', 'STATUS', 'COMPLETE', 'FAIL'];
    if (!bcIntent || !BC_VALID_INTENTS.includes(bcIntent)) {
      content = `Error: \`intent\` is required for broadcast_to_group. Wake intents (QUESTION/ASSIGN/BLOCK/ANSWER/DELIVERABLE) wake EVERY group member, use sparingly. Most broadcasts should be FYI (informational) or STATUS (progress update). Re-call with an explicit intent.`;
      isError = true;
      return { content, isError };
    }

    const bcDb = getDb();

    // Get all non-terminated agents in the group (excluding the sender)
    const groupMembers = bcDb.prepare(`
      SELECT id, name, status FROM agents
      WHERE group_id = ? AND status != 'terminated' AND id != ?
    `).all(groupId, agentId) as Array<{ id: string; name: string; status: string }>;

    if (groupMembers.length === 0) {
      content = 'No other active agents in this group.';
      return { content, isError };
    }

    const bcThreadId = args.thread_id as string | undefined;
    const sent: string[] = [];

    // Filter out injured/paused agents, don't try to wake broken agents
    const healthyMembers = groupMembers.filter(m => m.status !== 'error' && m.status !== 'paused');

    for (const member of healthyMembers) {
      const bcResult = await deliverBc({
        intent: bcIntent as import('../../a2a-transport.js').A2AIntent,
        // A-1/A-2 (comms-audit): each recipient gets a FRESH thread (empty →
        // auto-generated per member in the transport). A SHARED thread_id across
        // recipients collided the per-thread semantic-dedup, hop counter, and
        // ASSIGN-task lookup, so an identical broadcast to N members silently
        // dropped members 2+ as duplicates / mis-assigned the task to member 1.
        // Broadcasts are one-to-many fan-out with no shared-thread semantics.
        threadId: '',
        requiresResponse: ['QUESTION', 'ASSIGN', 'BLOCK'].includes(bcIntent),
        payload: broadcastPayload,
        toAgent: member.id,
        fromAgent: agentId,
      });
      if (bcResult.delivered) {
        sent.push(member.name);
        // RC-12: one receipt per delivered recipient (recipient = that agent's
        // name) so the grounding ledger recognizes the broadcast as a real
        // cross-turn delivery. skipAudit: the fan-out audit is handled by the
        // transport / the summary content below.
        writeToolReceipt({ agentId, tool: 'broadcast_to_group', tier: 1, verified: true, basis: 'provider-id', providerId: bcResult.threadId, threadId: bcResult.threadId, recipient: member.name, sentText: broadcastPayload, detail: { intent: bcIntent, groupId }, skipAudit: true });
      }
    }

    content = `Broadcast sent to ${sent.length} agent(s): ${sent.join(', ')}`;
    return { content, isError };
  },

  async "complete_task"({ agentId, args }) {
    let content = '';
    let isError = false;
    const completeStatus = args.status as string | undefined;
    const completeSummary = args.summary as string | undefined;
    // Normalize case/synonyms at the tool boundary (mirrors the
    // work_update(action="status") STATUS_SYNONYMS fix). A weak floor model saying
    // "done"/"failed"/"stuck" previously hard-errored here even though the
    // intent was unambiguous. Map ONLY words whose intent is unambiguous so
    // the divergent side effects are preserved: complete fires the dependency
    // cascade, fallen archives silently, blocked notifies the owner. Anything
    // that isn't clearly one of the three (e.g. "paused"/"waiting", which are
    // not terminal completion states) is still rejected with guidance.
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
    // Idempotency: if the agent is already terminated, don't re-run the
    // termination path. Return a clean no-op message instead of mutating
    // state again or sending a duplicate parent notification.
    const agentDb = getDb();
    const completeAgentRow = agentDb.prepare('SELECT status FROM agents WHERE id = ?').get(agentId) as { status: string } | undefined;
    if (completeAgentRow?.status === 'terminated') {
      content = `Task completion was already recorded, you are terminated. No action taken.`;
      return { content, isError };
    }
    // FN-8: ENGINE ENFORCEMENT. complete_task terminates the calling agent,
    // so it is gated to spawned agents (and the persistent per-cycle Dreamer
    // and Healer, whose batch filing keys off complete_task).
    // getFilteredTools already removes the tool for anyone else, but the model
    // can still emit an unfiltered call, so re-check against fresh DB state
    // here. Never rely on the model not calling it. A persistent agent that
    // reaches this point must NOT be terminated.
    if (!agentCanSelfCompleteById(agentId)) {
      content =
        `complete_task ends a spawned agent's lifecycle and is not available to a persistent agent. ` +
        `To mark tracker work done use work_update(action="status", task_id=..., status="complete"). ` +
        `If you are blocked, say so in your reply so the user can act.`;
      isError = true;
      return { content, isError };
    }
    try {
      await completeAgent(
        agentId,
        completeMapped as 'complete' | 'fallen' | 'blocked',
        completeSummary!,
        args.results as string | undefined,
      );
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
      if (newName === undefined && newPrompt === undefined && newModelId === undefined && newPerms === undefined && newTools === undefined) {
        content = 'Error: provide at least one of name, system_prompt, model_id, permissions, or tools to update.';
        isError = true;
        return { content, isError };
      }
      const db = getDb();
      const uaResolved = resolveAgentRef(args.agent_id as string, 'update_agent');
      if (!uaResolved.ok) { content = uaResolved.error; isError = true; return { content, isError }; }
      const target = db.prepare('SELECT id, name, model_id FROM agents WHERE id = ?').get(uaResolved.id) as { id: string; name: string; model_id: string | null };
      const changes: string[] = [];
      let finalName = target.name;

      // Identity (name / system_prompt): forbidden on the primary agent.
      if (newName !== undefined || newPrompt !== undefined) {
        if (isPrimaryAgent(target.id)) {
          content = 'Error: cannot edit the primary agent via this tool. Edit its SOUL.md in Settings > Soul instead.';
          isError = true;
          return { content, isError };
        }
        if (typeof newName === 'string' && newName.trim() && newName.trim() !== target.name) {
          const trimmedName = newName.trim();
          db.prepare("UPDATE agents SET name = ?, updated_at = datetime('now') WHERE id = ?").run(trimmedName, target.id);
          changes.push(`name: "${target.name}" → "${trimmedName}"`);
          finalName = trimmedName;
        }
        if (typeof newPrompt === 'string') {
          const existingMsg = db.prepare("SELECT id FROM messages WHERE agent_id = ? AND role = 'system' ORDER BY rowid ASC LIMIT 1").get(target.id) as { id: string } | undefined;
          if (existingMsg) {
            rewriteSystemPromptRow(existingMsg.id, newPrompt);
          } else {
            insertMessageIfAbsent({ id: uuidv4(), agentId: target.id, role: 'system', content: newPrompt });
          }
          db.prepare("UPDATE agents SET updated_at = datetime('now') WHERE id = ?").run(target.id);
          changes.push(`system prompt rewritten (${newPrompt.length} chars)`);
        }
      }

      // Model.
      if (typeof newModelId === 'string') {
        if (newModelId === 'auto') {
          db.prepare("UPDATE agents SET model_id = 'auto', updated_at = datetime('now') WHERE id = ?").run(target.id);
          sanitizeMessagesOnModelChange(target.id);
          changes.push('model → auto-routing');
        } else {
          // Resolve forgivingly: id, then case-insensitive name/api_model_id,
          // then a unique name substring. The tool primes model NAMES, so a
          // weak model passes a name where a uuid id is expected and an
          // exact-id lookup misses.
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
          if (!model.is_enabled) { content = `Error: Model "${model.name}" is disabled. Enable it in Settings > Models first.`; isError = true; return { content, isError }; }
          db.prepare("UPDATE agents SET model_id = ?, updated_at = datetime('now') WHERE id = ?").run(model.id, target.id);
          const { collapsed } = sanitizeMessagesOnModelChange(target.id);
          changes.push(`model: ${target.model_id ?? 'auto'} → ${model.name}${collapsed > 0 ? ` (${collapsed} tool msg(s) sanitized)` : ''}`);
        }
      }

      // Permissions and tools policy (access control): gated by can_assign_permissions.
      if (newPerms !== undefined || newTools !== undefined) {
        const callerPerms = getAgentPermissions(agentId);
        if (!callerPerms.can_assign_permissions) {
          content = 'Permission denied: you do not have permission to change other agents\' permissions or tool policy.';
          isError = true;
          return { content, isError };
        }
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

      // System prompt = first system-role message (mirrors update_agent)
      const promptRow = db.prepare(
        "SELECT content FROM messages WHERE agent_id = ? AND role = 'system' ORDER BY rowid ASC LIMIT 1"
      ).get(target.id) as { content: string } | undefined;
      const systemPrompt = promptRow?.content ?? '';

      // Resolve model name if a model is configured
      let modelLabel = '(none / auto-routed)';
      if (target.model_id && target.model_id !== 'auto') {
        const modelRow = db.prepare('SELECT name, api_model_id FROM models WHERE id = ?').get(target.model_id) as { name: string; api_model_id: string } | undefined;
        modelLabel = modelRow ? `${modelRow.name} (${modelRow.api_model_id}, id=${target.model_id})` : `id=${target.model_id} (model row missing)`;
      } else if (target.model_id === 'auto') {
        modelLabel = 'auto-routed';
      }

      // Resolve group name
      let groupLabel = '(none)';
      if (target.group_id) {
        const groupRow = db.prepare('SELECT name FROM agent_groups WHERE id = ?').get(target.group_id) as { name: string } | undefined;
        groupLabel = groupRow ? `${groupRow.name} (id=${target.group_id})` : `id=${target.group_id}`;
      }

      // Pretty-print tools_policy and permissions JSON, but degrade gracefully on bad JSON
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

    if (gid === SYS_GROUP_U) {
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
    const atgGroup = resolveGroupRef(args.group_id as string, 'assign_to_group');
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

    // Status labels, INJURED / PAUSED stay ALL-CAPS in both modes because
    // a calling agent that misses these will keep waiting on a dead peer.
    // This is operational signal, not decoration.
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
      // Verbose: full v1 behavior, activity timestamps, dormant detection,
      // group names, last_error snippets.
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
        let line = `- ${a.name} (ID: ${a.id}), ${labelForStatus(a.status as string, false)}, ${a.classification}${a.group_name ? `, group: ${a.group_name}` : ''}${activityStr}`;
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
        return `- ${a.name} (${a.id}), ${labelForStatus(a.status as string, true)}, ${a.classification}${groupSuffix}`;
      });
    }

    // Injured/paused warning fires in BOTH modes, it's a safety signal,
    // not a decoration.
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
      WHERE m.is_enabled = 1
      ORDER BY COALESCE(m.input_cost_per_m, 0) ASC
    `).all() as Array<Record<string, unknown>>;
    content = modelRows.map(m => {
      const inputCost = (m.input_cost_per_m as number) ?? 0;
      const outputCost = (m.output_cost_per_m as number) ?? 0;
      const costStr = inputCost === 0 && outputCost === 0
        ? 'FREE (local)'
        : `$${inputCost}/M in, $${outputCost}/M out`;
      const ctx = m.context_window ? `${Math.round((m.context_window as number) / 1000)}k ctx` : '';
      const maxOut = m.max_output_tokens ? `${Math.round((m.max_output_tokens as number) / 1000)}k max out` : '';
      // Parse capabilities
      let caps: string[] = [];
      if (m.capabilities) {
        try { caps = JSON.parse(m.capabilities as string); } catch { /* ignore */ }
      }
      const capStr = caps.length > 0 ? caps.join(', ') : 'text';
      const thinking = m.thinking_enabled ? 'thinking' : '';
      // Build feature tags
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
      content = 'Cannot delete the System group.';
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
          skipped.push(`${member.name} (${member.classification}, protected)`);
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

    // Auto-complete any tasks still assigned to terminated members or the group
    // This prevents orphaned tasks stuck in on_deck/in_progress after cleanup
    if (args.terminate_members) {
      const groupDb2 = getDb();
      const orphanedTasks = groupDb2.prepare(`
        SELECT w.id AS id, w.title AS title, ${STATE_TO_STATUS_SQL('w.state')} AS status,
               w.schedule_status AS schedule_status FROM work w
        WHERE ${taskScope('w')}
          AND (w.assigned_to_group = ? OR w.agent_id IN (SELECT id FROM agents WHERE group_id = ? AND status = 'terminated'))
          AND w.state NOT IN ('done', 'failed')
      `).all(groupId, groupId) as Array<{ id: string; title: string; status: string; schedule_status: string }>;
      for (const t of orphanedTasks) {
        // G7: closing this as `complete` points at the work the agent actually delivered
        // before its group was torn down. With nothing on the ledger the gate refuses and
        // the row stays visible rather than being silently marked finished.
        // PHASE-2 T8T: `by: 'engine'`. This is teardown bookkeeping, not the caller
        // claiming the work is finished — the agent that owned the task has just been
        // terminated and cannot claim anything. Under RULING 1 an agent's own close of a
        // tracker row is a Key-1 request, so keeping `by: 'agent'` would leave every
        // orphaned task open with a request nobody will validate. G6 still makes the
        // engine point at the delivery, and with nothing on the ledger G7 still refuses.
        const orphanDelivery = deliveryForTaskClose(t.id);
        const r = setTrackerStatus(t.id, 'complete', {
          by: 'engine', actorId: agentId,
          reason: 'the group this task belonged to was deleted and its members terminated',
          evidenceRef: orphanDelivery,
          resultDeliveryId: orphanDelivery,
        });
        if (r.kind === 'applied') {
          patchWork(t.id, {
            schedule_status: t.schedule_status === 'unscheduled' ? 'unscheduled' : 'completed',
            is_paused: 1,
          });
        } else {
          logger.warn('group-delete task close refused', { taskId: t.id, result: r });
        }
        skipOpenOccurrencesAsComplete(t.id, 'Auto-completed: group deleted');
      }
      if (orphanedTasks.length > 0) {
        logger.info('Auto-completed orphaned tasks during group deletion', { groupId, count: orphanedTasks.length });
      }
    }

    // Now delete the group (ungroups any remaining agents)
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
