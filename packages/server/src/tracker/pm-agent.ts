import fs from 'node:fs';
import { findDeliveryEvidenceForTask, renderDeliveryEvidence, resolveTaskAnswerPointer } from './delivery-evidence.js';
import { renderTaskStamps, renderStepFacts, type TaskStampFields } from './task-stamps.js';
import { turnContext } from '../agent/turn-context.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/connection.js';
// SWEEP CORE-2 item 2: the PM's one status write goes through the ONE writer.
import { writeAgentStatus } from '../agent/agent-status.js';
import {
  taskScope, msToText, STATE_TO_STATUS_SQL, validatedExpr, revertCountExpr,
  awaitingUserVerdictExpr, pendingCloseRequestExpr,
  stampColumns,
} from '../work/tracker-view.js';
import { patchWork, setTrackerStatus, deliveryForTaskClose } from '../work/tracker-store.js';
import { noteUnsettled } from '../work/store.js';
import { listOverrideRequests, PENDING_OVERRIDE_COUNT_SQL } from '../work/override-requests.js';
import { activeRuns as pmActiveRuns } from '../agent/shared-state.js';
import {
  setValidationDoorbellHandler, validationAttemptCountExpr, validationQueueOrderExpr,
  VALIDATION_ATTEMPT_MISS, VALIDATION_ATTEMPT_UNAVAILABLE, type DoorbellRing,
} from '../work/validation-drive.js';
import { VALIDATION_ESCALATION_MIN } from '../scheduler/runner.js';
import { createLogger } from '../logger.js';
import { broadcast } from '../gateway/ws.js';
import { sendAgentMessage } from '../agent/agent-bus.js';
import { postAgentNotice } from '../agent/agent-notice.js';
import { listTasks, getTask } from './schema.js';
import { currentRung, lastPoke as lastPokeOf, recordPoke, recordRemediation } from '../work/poke-ladder.js';
import { getAgentRuntime } from '../agent/runtime.js';
import { getRecentObservations, getRecentTransitions, formatEntryLine, listTaskLog, writeTaskLog } from './task-log.js';
import {
  deleteForAgentBefore,
  deleteNonSystemForAgent,
  insertMessage,
  insertMessageIfAbsent,
  insertEngineEventIfAbsent,
} from '../memory/message-store.js';
import { getPrimaryAgentId, getPrimaryAgentName, getPMAgentId, getPMAgentName, isPMEnabled, isSetupCompleted, getOwnerName, isSystemServiceAgent, isDreamerAgent } from '../config/platform.js';
import type { Message } from '@dojo/shared';
import { workOperation, type WorkOp } from '../tools/work-verbs.js';

const logger = createLogger('pm-agent');

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Poke Thresholds (in seconds) ──

const POKE_THRESHOLDS: Record<string, { first: number; second: number; escalate: number; autoReset: number }> = {
  high:   { first: 180,  second: 600,   escalate: 1200, autoReset: 2400 },
  normal: { first: 300,  second: 900,   escalate: 1800, autoReset: 3600 },
  low:    { first: 600,  second: 1200,  escalate: 2400, autoReset: 4800 },
};

const POKE_INTERVAL_MS = 60_000; // 60 seconds

// ⟨TOMBSTONE⟩ SWEEP CORE-2 item 3 (SWEEP-F T2): `SCHEDULER_INTERVAL_MS` and `schedulerTimer`
// lived here, and `startPokeLoop`/`stopPokeLoop` installed and cleared the scheduler's clock.
// They are `scheduler/clock.ts`'s now, with the 30-second period carried verbatim. The
// coupling was not cosmetic: the scheduler's ONLY start sat inside `index.ts` 4c's
// `isSetupCompleted() && isPMEnabled()` gate, so turning the project manager OFF silently
// stopped every reminder and recurring task on the box.
// requirement preserved: the immediate first check and the 30s period, both carried into
// `startScheduler()`; asserted by `scheduler/__tests__/scheduler-owns-its-clock.test.ts` A1.

let pokeLoopTimer: ReturnType<typeof setInterval> | null = null;

// ── PM Agent System Prompt ──

function loadPMSoulPrompt(): string {
  const pmName = getPMAgentName();
  const primaryName = getPrimaryAgentName();
  const ownerName = getOwnerName();

  // Try loading from templates directory
  const templatePaths = [
    path.resolve(__dirname, '../../../../templates/PM-SOUL.md'),
    path.resolve(__dirname, '../../../templates/PM-SOUL.md'),
    // RICK-SOUL.md removed, only PM-SOUL.md is used
  ];

  for (const templatePath of templatePaths) {
    try {
      if (fs.existsSync(templatePath)) {
        let content = fs.readFileSync(templatePath, 'utf-8');
        // Replace template variables
        content = content.replace(/\{\{pm_agent_name\}\}/g, pmName);
        content = content.replace(/\{\{primary_agent_name\}\}/g, primaryName);
        content = content.replace(/\{\{owner_name\}\}/g, ownerName);
        return content;
      }
    } catch {
      // Try next path
    }
  }

  // Fallback default
  return `# Identity

You are ${pmName}, the project manager for this agent platform. Your only job is to track tasks, poke agents that stall, and escalate when needed.

# Rules

- You do NOT execute tasks. You track them.
- Check the project tracker on your poke schedule.
- When poking an agent, include full task context so they can resume immediately.
- Escalation chain: poke once -> poke with urgency -> escalate to ${primaryName} -> escalate to ${ownerName} via iMessage.
- After a restart, the escalation ladder resumes itself from the work record — never re-send a poke you have already sent.
- Keep messages short. You're a PM, not a novelist.`;
}

// ── PM permission manifest ──
// The PM is a narrow-purpose oversight agent. It gets read-only artifact
// verification (C2 sub-finding) so close-out validation confirms the actual
// deliverable rather than trusting the agent's claim; file_read is the H4
// evidence gate. Reads are still bounded by the engine's global read-deny
// (secrets.yaml + Healer logs are refused regardless of this manifest). Every
// other capability stays fully confined: no file_write, file_delete, exec,
// network, or agent-spawning. Single source of truth for all three write sites
// (create / reactivate / boot-sync) so they cannot drift.
const PM_PERMISSIONS_JSON = JSON.stringify({
  file_read: '*',
  file_write: 'none',
  file_delete: 'none',
  exec_allow: [],
  exec_deny: ['*'],
  network_domains: 'none',
  can_spawn_agents: false,
  can_assign_permissions: false,
});

// ── PM tool allow-list (single source of truth) ──
//
// RC-16: the PM is an OVERSEER, not a worker. It validates, overrides, retasks,
// and reassigns; it never edits task CONTENT or flips a worker's status directly.
// The worker verbs (work_update(action="status"), work_update(action="complete_step"),
// work_update(action="edit")) are intentionally ABSENT so a stale copy sitting in the PM's
// long-lived context can't silently rewrite a task's description or re-close
// already-closed work (P-1 / F-15). work_validate(action="retask") + work_update(action="reassign") are
// the PM's corrective verbs; the read-only / utility tools below are what the PM
// legitimately needs to do oversight (list, inspect, message, read artifacts for
// close-out verification, search memory/history).
//
// This constant is the ONE place the list lives. All three tools_policy write
// sites (create / reactivate / boot-sync) read it, so the advertised surface
// (computeFilteredTools' allow filter) cannot drift. It is also EXPORTED and
// re-checked at the executor chokepoint (agent/tools.ts executeToolInner): per
// Architecture Rule 1 the surface strip is only advice (the floor model can emit
// a tool name from free text and reach the executor), so the PM verb enforcement
// re-checks this same set and rejects any tool outside it with a TOOL-RESULT
// error naming the overseer verbs.
// PHASE-2 T8V — THE SITE THE VERB COLLAPSE BREAKS HARDEST, so it moved from
// NAMES to OPERATIONS rather than being renamed.
//
// The rule this list encodes is not "the PM may call these tools". It is "the
// PM may perform these OPERATIONS": it may close a whole project, but it may
// NOT flip a worker's task status; it may edit, but it may not complete a step.
// Before the collapse those were different tool names, so a name set said it.
// After the collapse `work_update` performs all of them, so a name set can no
// longer distinguish them — allowing `work_update` would hand the PM the status
// flip and the step advance that this gate has refused since the demolition,
// and refusing it would take away the edit the scaffold rename handoff needs.
// So the authority is the OP list; the NAME list below is derived from it and
// is only what the advertised surface can express.
export const PM_ALLOWED_WORK_OPS: readonly WorkOp[] = [
  'work_update:list', 'work_update:get',        // read-only inspection
  'work_note',                                   // leave a note on a task
  'work_schedule:pause', 'work_schedule:resume',
  'work_validate:validate', 'work_validate:retask',
  'work_update:reassign',
  'work_validate:override',
  'work_close_request:override',
  'work_validate:apply_user_verdict',
  // The edit ops are REQUIRED by the engine's scaffold rename handoff
  // (loop.ts dispatchPMRenameHandoff explicitly instructs the PM to call it).
  // Omitting them (2026-07-17 battery, untracked-multistep-floor red) made the
  // executor gate refuse the rename; the PM's local model then compensated by
  // rewriting the PROJECT description (which used to strip the engine marker, before T8c
  // made that fact a `root_kind` column no edit can reach) and
  // FYI-ing the primary to do the task rename for it.
  'work_update:edit',
  'work_update:close_project',
];

const PM_ALLOWED_WORK_OPS_SET: ReadonlySet<string> = new Set<string>(PM_ALLOWED_WORK_OPS);

/**
 * Operations only the PM may perform, whichever verb carries them. Kept as ops
 * for the same reason: `work_validate`'s five actions are all PM-only today,
 * but the executor gate states the rule rather than relying on that.
 */
export const PM_ONLY_WORK_OPS: ReadonlySet<string> = new Set<string>([
  'work_validate:validate',
  'work_validate:retask',
  'work_validate:override',
  'work_validate:apply_user_verdict',
  'work_validate:apply_user_validation',
]);

// Non-work tools the PM may call. Plain names: these tools were not collapsed.
const PM_ALLOWED_OTHER_TOOLS: readonly string[] = [
  'send_to_agent', 'broadcast_to_group', 'list_agents', 'list_groups',
  // UX-REPAIR round 2 T11: `vault_get` was named by the PM's own prompt (`PM-SOUL.md:66`) and
  // refused by this gate — the prompt described a door that did not exist. Read-only, and the
  // alignment is to the prompt: no prompt text changed (it is the PM's prefix; cache tenet).
  'vault_search', 'vault_get', 'vault_remember', 'history_search', 'history_get',
  'load_tool_docs', 'get_current_time',
  // Read-only artifact verification for close-out validation (C2 sub-finding):
  // confirm the actual deliverable instead of trusting the agent's claim.
  // Read only, never file_write / file_delete / exec / network.
  'file_read', 'file_list',
];

// The ADVERTISED surface (tools_policy.allow, written to the agents row by the
// three sync sites below). It can only name verbs, so a verb appears here as
// soon as ANY of its operations is allowed — the executor gate below is what
// enforces which operation. That asymmetry is deliberate and is exactly
// Architecture Rule 1: the surface is advice, the engine enforces.
export const PM_ALLOWED_TOOLS: readonly string[] = [
  ...new Set(PM_ALLOWED_WORK_OPS.map((op) => op.split(':')[0])),
  ...PM_ALLOWED_OTHER_TOOLS,
];

/**
 * The executor gate's real check. `args` are required for a work verb because
 * the operation — not the name — is what the PM is or is not allowed to do.
 */
export function pmMayCall(name: string, args?: Record<string, unknown>): boolean {
  const op = workOperation(name, args);
  if (op !== null) return PM_ALLOWED_WORK_OPS_SET.has(op);
  return PM_ALLOWED_OTHER_TOOLS.includes(name);
}

// O(1) membership check for surface-level (name-only) callers. NOT the gate.
export const PM_ALLOWED_TOOLS_SET: ReadonlySet<string> = new Set(PM_ALLOWED_TOOLS);

// ── Ensure PM Agent Running ──

export function ensurePMAgentRunning(): void {
  if (!isPMEnabled()) {
    logger.info('PM agent is disabled, skipping auto-spawn');
    return;
  }

  if (!isSetupCompleted()) {
    logger.info('Setup not completed, deferring PM agent creation to setup wizard');
    return;
  }

  const db = getDb();
  const pmId = getPMAgentId();
  const pmName = getPMAgentName();
  const primaryId = getPrimaryAgentId();

  logger.info('PM agent auto-spawn check triggered', { pmId, pmName });

  // Ensure the primary agent exists before creating PM (parent_agent FK constraint)
  const primaryExists = db.prepare('SELECT id FROM agents WHERE id = ?').get(primaryId);
  if (!primaryExists) {
    logger.warn('Primary agent not yet created, deferring PM agent spawn', { primaryId });
    // Retry after a short delay
    setTimeout(() => ensurePMAgentRunning(), 5000);
    return;
  }

  const pm = db.prepare('SELECT id, status FROM agents WHERE id = ?').get(pmId) as { id: string; status: string } | undefined;

  if (pm && pm.status !== 'terminated') {
    logger.info('PM agent already running', { status: pm.status });
    // Ensure permissions are up to date on every boot. Allow-list from the single
    // source (PM_ALLOWED_TOOLS) so the surface strip never drifts from the
    // executor gate.
    const syncToolsPolicy = JSON.stringify({ allow: [...PM_ALLOWED_TOOLS] });
    // Sync BOTH tools_policy and permissions on every boot so an already-running
    // PM picks up the read-only file_read grant (C2) without needing a reactivate.
    db.prepare("UPDATE agents SET tools_policy = ?, permissions = ?, updated_at = datetime('now') WHERE id = ?").run(syncToolsPolicy, PM_PERMISSIONS_JSON, pmId);
    // Phase B.1: also keep the PM-SOUL system message in sync with the
    // template on every boot. Without this, the skepticism block (and any
    // other prompt updates) never reach an already-running PM. We INSERT
    // a fresh system message rather than mutating the original so the
    // history audit trail is preserved; the runtime message-assembly path
    // reads the LATEST system message for context.
    try {
      const freshPrompt = loadPMSoulPrompt();
      const existing = db.prepare(`
        SELECT content FROM messages
        WHERE agent_id = ? AND role = 'system'
        ORDER BY created_at DESC, rowid DESC LIMIT 1
      `).get(pmId) as { content: string } | undefined;
      if (!existing || existing.content !== freshPrompt) {
        insertMessage({ id: uuidv4(), agentId: pmId, role: 'system', content: freshPrompt });
        logger.info('PM system prompt refreshed from template', { pmId });
      }
    } catch (err) {
      logger.warn('PM system prompt refresh failed (non-fatal)', { error: err instanceof Error ? err.message : String(err) });
    }
    startPokeLoop();
    return;
  }

  const systemPrompt = loadPMSoulPrompt();

  // Get PM model: check saved setting first, fall back to primary agent's model
  const pmModelSetting = db.prepare("SELECT value FROM config WHERE key = 'pm_agent_model'").get() as { value: string } | undefined;
  let modelId: string | null = pmModelSetting?.value ?? null;
  if (!modelId) {
    const primary = db.prepare('SELECT model_id FROM agents WHERE id = ?').get(primaryId) as { model_id: string | null } | undefined;
    modelId = primary?.model_id ?? null;
  }

  if (pm) {
    // PM exists but was terminated, reactivate with correct name, model, and permissions
    const reactivatePermissions = PM_PERMISSIONS_JSON;
    const reactivateToolsPolicy = JSON.stringify({ allow: [...PM_ALLOWED_TOOLS] });
    // SWEEP CORE-2 item 2: the identity columns stay here; the STATUS goes through the ONE
    // writer (`agent/agent-status.ts`). Both inside ONE transaction, so the reactivation is
    // as atomic as the single statement it replaces.
    db.transaction(() => {
      db.prepare(`
        UPDATE agents SET
          name = ?,
          model_id = ?,
          agent_type = 'persistent',
          parent_agent = ?,
          spawn_depth = 1,
          max_runtime = NULL,
          timeout_at = NULL,
          permissions = ?,
          tools_policy = ?,
          updated_at = datetime('now')
        WHERE id = ?
      `).run(pmName, modelId, primaryId, reactivatePermissions, reactivateToolsPolicy, pmId);
      writeAgentStatus(pmId, 'idle');
    })();

    logger.info('PM agent reactivated', { pmId, pmName });
  } else {
    // Create PM agent with permissions for tracker, messaging, and monitoring
    const pmPermissions = PM_PERMISSIONS_JSON;
    // Allow only the tools the PM needs (single source: PM_ALLOWED_TOOLS).
    const pmToolsPolicy = JSON.stringify({ allow: [...PM_ALLOWED_TOOLS] });
    // T11 Step 1b: the PM is platform machinery, not a person's agent.
    db.prepare(`
      INSERT INTO agents (id, name, model_id, system_prompt_path, status, config, created_by, created_by_kind,
                          parent_agent, spawn_depth, agent_type, classification, max_runtime, timeout_at,
                          permissions, tools_policy, task_id, created_at, updated_at)
      VALUES (?, ?, ?, NULL, 'idle', '{"shareUserProfile":true}', ?, 'agent',
              ?, 1, 'persistent', 'sensei', NULL, NULL,
              ?, ?, NULL, datetime('now'), datetime('now'))
    `).run(pmId, pmName, modelId, primaryId, primaryId, pmPermissions, pmToolsPolicy);

    insertMessageIfAbsent({ id: uuidv4(), agentId: pmId, role: 'system', content: systemPrompt });

    logger.info('PM agent created', { pmId, pmName });
  }

  startPokeLoop();
}

// ── Poke Loop ──

export function startPokeLoop(): void {
  if (pokeLoopTimer) {
    logger.info('PM poke loop already running');
    return;
  }

  logger.info(`PM poke loop started, checking every ${POKE_INTERVAL_MS / 1000}s`);

  // Run an immediate first check (fire-and-forget; errors are logged inside).
  runPokeCheck().catch((err) => {
    logger.error('PM poke loop initial check failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  });

  pokeLoopTimer = setInterval(() => {
    runPokeCheck().catch((err) => {
      logger.error('PM poke loop tick failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, POKE_INTERVAL_MS);
}

export function stopPokeLoop(): void {
  if (pokeLoopTimer) {
    clearInterval(pokeLoopTimer);
    pokeLoopTimer = null;
  }
  logger.info('Poke loop stopped');
}

// ── Phase B.1: event-driven PM wake on transitions ──
// When trackerUpdateStatus flips a task into paused/complete/blocked the
// engine buffers the task id, debounces 10 seconds (so a burst of
// transitions becomes one PM review), then fires a fresh review that
// bypasses the polled 10-minute throttle. The polled review still runs
// as a safety-net heartbeat. The smell-pattern detector runs inline on
// transition and writes any signals into task_log + tasks.last_smell_flag.

const TRANSITION_DEBOUNCE_MS = 10_000;
const SMELL_POKE_WINDOW_SEC = 60;
const SMELL_PAUSE_THRASH_CYCLES = 3;
const SMELL_PAUSE_THRASH_WINDOW_MIN = 30;
const transitionBuffer = new Set<string>();
let transitionDebounceTimer: ReturnType<typeof setTimeout> | null = null;

// ════════════════════════════════════════════════════════════════════════════════════════
// SWEEP CORE-2 ITEM 1 — THE DOORBELL (the owner's design, 2026-08-06, his words):
//   *"so and so says they got this done. Confirm and mark it in the tracker, or push back,
//    or get more info — whatever needs done to make sure the task gets completed."*
//
// A completion that owes Key 2 wakes this validator CARRYING THAT ROW. `work/store.ts` rings
// it from inside `transition()` — the spine's one writer — so no close path can forget, and
// the rows ride in as a RIDER on the next review rather than waiting to be re-discovered by
// a patrol sweep whose dedup then compares the unchanged set equal and skips it.
//
// THE LATENCY BOUND IS CARRIED, NOT CHOSEN: `TRANSITION_DEBOUNCE_MS`, the burst-coalescer
// this file has used for event wakes since Phase B.1. It exists so a chaotic spell of
// transitions becomes ONE review instead of thirty, and that reason is unchanged. Measured
// against the only clock in the product that says how long a row may await Key 2 before the
// OWNER is told — `VALIDATION_ESCALATION_MIN` = 5 min — it is 1/30th of it. The defect this
// closes is those two clocks running in the wrong order; 10 s vs 300 s orders them.
//
// WHAT IT REPLACES, MEASURED: BATTERY6 `bmsh708xse7` — 102 miss rows, one at 36.9 minutes.
// BATTERY9 `bmshmu5ygd5` — ZERO Key-2 verdicts in 84 minutes, 96 of 98 handed rows missed.
// ════════════════════════════════════════════════════════════════════════════════════════

/** The doorbell's latency: how long a completion may wait for its targeted wake. */
export const PM_DOORBELL_LATENCY_MS = TRANSITION_DEBOUNCE_MS;

/** Rows rung in and not yet carried into a review. */
const doorbellRows = new Set<string>();

/** Wire the spine's doorbell to this validator. Called at module load so no boot path can
 *  forget it, and re-callable (it is idempotent — one registry slot). */
export function wireValidationDoorbell(): void {
  setValidationDoorbellHandler(noteValidationDoorbell);
}
wireValidationDoorbell();

/**
 * THE DOORBELL RANG. Buffer the row and arm a targeted review inside the stated bound.
 *
 * Note what is deliberately NOT here: no cap, no budget, no per-row attempt ceiling and no
 * "we already looked at this one" suppression. *"cost and token use is not really a factor…
 * let her do it."*
 */
export function noteValidationDoorbell(ring: DoorbellRing): void {
  doorbellRows.add(ring.workId);
  logger.info('PM doorbell: an agent says this is done and Key 2 is owed', {
    taskId: ring.workId, shape: ring.shape, carrying: doorbellRows.size,
    latencyMs: PM_DOORBELL_LATENCY_MS,
  });
  armDebouncedReview(ring.workId, `doorbell:${ring.shape}`);
}

/**
 * The rows THIS review carries. Drained once: after the review has held them they live in
 * the ordinary queue with their own attempt count, and a rider that never drained would
 * bypass the dedup for ever.
 */
export function drainValidationDoorbell(): string[] {
  const ids = Array.from(doorbellRows);
  doorbellRows.clear();
  return ids;
}

/** How many rows are waiting to be carried. Exported for the driven clause. */
export function pendingValidationDoorbellCount(): number {
  return doorbellRows.size;
}

/**
 * Called by trackerUpdateStatus / completeAgent / closeProjectAndOpenTasks
 * whenever a task transitions into paused, complete, or blocked. Buffers
 * the task id and schedules a debounced PM review. The review runs as a
 * fresh LLM call regardless of the polled throttle.
 */
export function noteTransitionForReview(taskId: string, toStatus: string): void {
  if (!['paused', 'complete', 'blocked'].includes(toStatus)) return;
  // Smell detection happens here so the flag lands BEFORE PM reviews.
  try {
    runSmellDetector(taskId, toStatus);
  } catch (err) {
    logger.warn('runSmellDetector threw (non-fatal)', { taskId, toStatus, error: err instanceof Error ? err.message : String(err) });
  }
  armDebouncedReview(taskId, `transition:${toStatus}`);
}

/**
 * ONE debounced wake, shared by the transition wake and the doorbell.
 *
 * SWEEP CORE-2 item 1: the cap check that used to sit in the timer's body is GONE. It
 * dropped the wake entirely — *"PM event wake dropped: hourly LLM cap reached"* — which is
 * the throttle the owner retired outright, in the one place where dropping the wake means
 * the completion is never looked at until a patrol sweep happens to notice it.
 */
function armDebouncedReview(taskId: string, why: string): void {
  const wasEmpty = transitionBuffer.size === 0;
  transitionBuffer.add(taskId);
  if (transitionDebounceTimer) {
    logger.info('PM event wake: buffered (timer already running)', { taskId, why, bufferSize: transitionBuffer.size });
    return;
  }
  logger.info('PM event wake: armed debounce timer', { taskId, why, debounceMs: TRANSITION_DEBOUNCE_MS, freshBuffer: wasEmpty });
  transitionDebounceTimer = setTimeout(() => {
    transitionDebounceTimer = null;
    const fired = Array.from(transitionBuffer);
    transitionBuffer.clear();
    // Reset the throttle so the next runPMReview fires immediately (responsive to a
    // genuine transition). Do NOT clear lastSituationReportHash here: a transition that
    // does not change the actionable issue-set must still dedup-skip, or we reintroduce
    // the "re-notify the same board on every task churn" firehose. runPMReview recomputes
    // the issue-set and re-runs only if it actually changed — and a DOORBELL row bypasses
    // that gate on its own terms, because a doorbell IS the change.
    lastLLMReviewAt = 0;
    logger.info('PM event wake: firing runPMReview', { batchedTasks: fired, carryingDoorbell: doorbellRows.size });
    runPMReview().catch((err) => {
      logger.error('Event-driven PM review failed', { error: err instanceof Error ? err.message : String(err) });
    });
  }, TRANSITION_DEBOUNCE_MS);
}

/**
 * Engine-to-PM escalation for close-out misses.
 *
 * When the engine's pre-turn close-out gate fires, the dangling one-shot tasks
 * are left in_progress (demolition Phase 1.4: the engine no longer auto-pauses
 * or pre-blesses a pause, and the reply stays visible to the user) BUT we:
 *   - write a `closeout_miss` entry into task_log per affected task
 *   - send a direct A2A message to the PM with what the agent said, the task
 *     goals, and the explicit verb menu (accept-complete / retask / dispose)
 *
 * PHASE-2 T8c item 2: the brief used to carry each task's `deliverable_shown` state. That
 * column has had NO WRITER since the P2 drive boundary (2026-07-21) and is read-only legacy
 * data, so on every row this platform has opened since then the line read
 * `deliverable_shown=false` — a constant, printed as if it were a fact about the work, in
 * the one message that is supposed to give the PM a real basis to decide. The live half of
 * that requirement is the retask backstop in `tracker/tools.ts`, which is now a tested
 * predicate (`retaskWouldOverwriteDeliveredWork`), and THAT is what protects delivered work.
 * requirement preserved: the PM is still told what each dangling task was for (its goal)
 * and still gets the receipts block below; nothing that varies per row was removed.
 *
 * Before this, the PM only learned about close-out misses indirectly via the
 * periodic situation report, which surfaced the pause as "UNVALIDATED_PAUSE"
 * with no context about what the agent actually said or what they should have
 * done. PM had no real basis to do anything except validate the pause, which is
 * exactly the rubber-stamp behavior the user called out.
 *
 * Fire-and-forget: PM acting takes a real LLM call; if PM is offline or capped
 * the task stays in_progress and the user can resolve from the dashboard.
 */
export async function escalateCloseoutMissToPM(ctx: {
  agentId: string;
  danglingTaskIds: string[];
  agentText: string;
  source: 'idle-hardcap' | 'pre-turn-gate';
}): Promise<void> {
  if (!ctx.danglingTaskIds || ctx.danglingTaskIds.length === 0) return;

  const pmId = getPMAgentId();
  if (!pmId) {
    logger.info('Closeout-miss escalation skipped: no PM configured', { source: ctx.source, taskCount: ctx.danglingTaskIds.length });
    return;
  }
  if (pmId === ctx.agentId) {
    logger.info('Closeout-miss escalation skipped: dangler agent IS the PM', { agentId: ctx.agentId, source: ctx.source });
    return;
  }

  const db = getDb();
  const rows = ctx.danglingTaskIds
    .map((id) => db.prepare(`SELECT id, title, goal FROM work WHERE id = ?`).get(id) as { id: string; title: string; goal: string | null } | undefined)
    .filter((r): r is { id: string; title: string; goal: string | null } => Boolean(r));
  if (rows.length === 0) return;

  const sourceLabel = ctx.source === 'idle-hardcap' ? 'idle-with-in_progress hardcap' : 'pre-turn close-out gate';

  try {
    const { writeTaskLog } = await import('./task-log.js');
    for (const r of rows) {
      writeTaskLog({
        taskId: r.id,
        fromEntity: 'engine',
        entryKind: 'closeout_miss',
        actionTaken: `escalated to PM via ${sourceLabel}`,
        reason: 'agent produced user-facing text without calling work_update(action="status"); the reply was shown to the user and the task remains in_progress pending PM review',
        note: ctx.agentText.slice(0, 4000),
      });
    }
  } catch (err) {
    logger.warn('Failed to write closeout_miss task_log entries', {
      error: err instanceof Error ? err.message : String(err), taskCount: rows.length,
    });
  }

  const taskLines = rows
    .map((r) => `  - ${r.id.slice(0, 8)} "${r.title}" (goal: ${r.goal ?? '(none recorded)'})`)
    .join('\n');
  const truncatedSaid = ctx.agentText.length > 1500
    ? ctx.agentText.slice(0, 1500) + '...'
    : ctx.agentText;

  // v2.10.2, receipts in the A2A body. Pre-fix, PM only saw the
  // agent's suppressed text ("08 done"), not the tool-call rows from
  // task_log. That made it easy for PM to conclude "no evidence,
  // re-run" when the audit log actually had the [SENT] success row.
  // Pull the last few tool_use audit entries for each paused task
  // and embed them inline so PM has the receipts in the same
  // message as the question.
  let receiptsBlock = '';
  try {
    const receiptLines: string[] = [];
    for (const r of rows) {
      // PHASE-2 T10G: reads the trail through its own seam now that the table is gone.
      // `tool_use` LEAVES the kind list and is not replaced: it is not one of the thirteen
      // kinds `TaskLogEntryKind` declares, no writer in the tree has ever emitted it, and the
      // box carried zero rows of it — a dead kind inside a live predicate, which is why the
      // list is a measurement and not a copy.
      const auditRows = listTaskLog(r.id, { limit: 6, kinds: ['transition', 'observation'] });
      if (auditRows.length === 0) continue;
      receiptLines.push(`  ${r.id.slice(0, 8)} recent audit (newest first):`);
      for (const a of auditRows) {
        const action = a.actionTaken ?? '(no action recorded)';
        const detail = [a.reason, a.note].filter(Boolean).join(' / ').slice(0, 180);
        receiptLines.push(`    [${a.createdAt}] ${action}${detail ? `, ${detail}` : ''}`);
      }
    }
    // C26: engine-written verification receipts. These are machine facts (the
    // provider's own id / a read-only re-fetch), not the agent's prose, so PM
    // can tell a real send from an invented "sent it." Render per-task rows
    // (stamped when the complete gate consumed them) plus the assignee's recent
    // rows in the window (a turn that did NOT close through the gate leaves them
    // unstamped). Read-only.
    const fmtReceipt = (vr: { tool: string; verified: number; basis: string; provider_id: string | null; created_at: string }): string =>
      `    [${vr.created_at}] ${vr.tool} ${vr.verified ? 'VERIFIED' : 'unverified'} (${vr.basis})${vr.provider_id ? `, id ${vr.provider_id}` : ''}`;
    for (const r of rows) {
      const taskReceipts = db.prepare(`
        SELECT tool, verified, basis, provider_id, created_at
        FROM tool_receipts WHERE task_id = ?
        ORDER BY created_at DESC LIMIT 10
      `).all(r.id) as Array<{ tool: string; verified: number; basis: string; provider_id: string | null; created_at: string }>;
      if (taskReceipts.length === 0) continue;
      receiptLines.push(`  ${r.id.slice(0, 8)} engine receipts:`);
      for (const vr of taskReceipts) receiptLines.push(fmtReceipt(vr));
    }
    const assigneeReceipts = db.prepare(`
      SELECT tool, verified, basis, provider_id, created_at
      FROM tool_receipts
      WHERE agent_id = ? AND task_id IS NULL AND created_at >= datetime('now', '-2 hours')
      ORDER BY created_at DESC LIMIT 10
    `).all(ctx.agentId) as Array<{ tool: string; verified: number; basis: string; provider_id: string | null; created_at: string }>;
    if (assigneeReceipts.length > 0) {
      receiptLines.push(`  ${ctx.agentId} recent engine receipts (unstamped, last 2h):`);
      for (const vr of assigneeReceipts) receiptLines.push(fmtReceipt(vr));
    }
    if (receiptLines.length > 0) {
      receiptsBlock = `Audit log excerpts (the actual receipts, read these BEFORE deciding):\n${receiptLines.join('\n')}\n\n`;
    }
  } catch (err) {
    logger.warn('Failed to assemble audit-log receipts for closeout-miss A2A (non-fatal)', {
      error: err instanceof Error ? err.message : String(err), taskCount: rows.length,
    });
  }

  const payload =
    `[Engine notice - CLOSEOUT MISS]\n\n` +
    `Agent "${ctx.agentId}" finished a turn without calling work_update(action="status") / work_update(action="complete_step"). The engine ` +
    `did NOT pause or close the dangling one-shot task(s) below; they remain in_progress with their true status. Your job: don't rubber-stamp. Decide per task.\n\n` +
    `Dangling task(s) (still in_progress):\n${taskLines}\n\n` +
    `What the agent said to the user (shown in chat this turn):\n` +
    `> ${truncatedSaid.split('\n').join('\n> ')}\n\n` +
    receiptsBlock +
    `Trigger: ${sourceLabel}\n\n` +
    `Your verbs:\n` +
    `  (a) work_validate(action="retask", task_id, directive), push the agent back at it with concrete corrective guidance ` +
    `(e.g. "you wrote the brief in chat but the task spec is email; call send_email with this same content to <recipient>"). USE THIS WHEN the agent did the wrong thing and you can name what they should do instead.\n` +
    `  (b) leave it in_progress or dispose of it, the engine did NOT pause it. If the assignee is legitimately still mid-flight, do nothing (it stays in_progress and continues). If the work genuinely can't proceed without user input you can name, or the task is no longer relevant, work_update(action="close_project") on the parent project or work_update(action="reassign"). USE THIS WHEN the task is stuck or dead, not done.\n` +
    `  (c) work_validate(action="override", ...) or work_validate(action="validate", kind="complete", ...), accept as complete. USE THIS WHEN you can verify (via the audit-log excerpts above + what the agent said + a quick work_update(action="get") / file check / etc.) that the work actually got done and the agent just forgot to close the tracker.\n\n` +
    `**Non-idempotent tools demand option (c), not (a).** If the audit log shows a successful call to gmail_send, outlook_send, ` +
    `imessage_send, sms_send, teams_send_message, voice_call, calendar_create, drive_upload, docs_create, sheets_create, share_publicly, ` +
    `or an exec that hit a live external API, the action already happened. Re-running it would duplicate the side effect (double email, ` +
    `double text, double charge). Accept as complete via work_validate(action="override") / work_validate(action="validate"), citing the audit row as evidence. ` +
    `Do NOT use work_validate(action="retask") on these; that produces duplicates.\n\n` +
    `For everything else, inspect the goal against what the agent said. If they delivered the wrong artifact OR in the wrong channel, retask. ` +
    `Rubber-stamping means the recurring task / user-promised work dies silently. Be a PM, not a status forwarder.`;

  try {
    const { deliverA2AMessage } = await import('../agent/a2a-transport.js');
    await deliverA2AMessage({
      intent: 'QUESTION',
      threadId: uuidv4(),
      requiresResponse: true,
      payload,
      toAgent: pmId,
      fromAgent: 'system',
    });
    logger.info('Closeout-miss escalated to PM', {
      pmId, agentId: ctx.agentId, taskCount: rows.length, source: ctx.source,
    });
  } catch (err) {
    logger.warn('Failed to deliver closeout-miss escalation to PM', {
      error: err instanceof Error ? err.message : String(err),
      pmId, taskCount: rows.length,
    });
  }
}

/**
 * Smell-pattern detector. Writes signal entries into task_log and sets
 * tasks.last_smell_flag for PM to read as context. Never blocks the
 * transition (that's the engine hard-gate's job), this is purely an
 * advisory signal.
 */
/** Humane rendering of the structured smell flag for the PM model's context.
 *  Legacy prose flags (pre-P6b rows) pass through unchanged. */
function renderSmellFlag(raw: string): string {
  try {
    const f = JSON.parse(raw) as { kind?: string; elapsedSec?: number; cycles?: number; windowMin?: number };
    if (f.kind === 'complete_dodges_poke') return `closed within ${f.elapsedSec}s of the last poke with no non-tracker tool calls on the closing turn`;
    if (f.kind === 'pause_resume_thrash') return `pause-resume thrash: ${f.cycles} transitions in last ${f.windowMin} min`;
  } catch { /* legacy prose flag */ }
  return raw;
}

function runSmellDetector(taskId: string, toStatus: string): void {
  const db = getDb();
  if (toStatus === 'complete') {
    const lastPoke = lastPokeOf(taskId);
    if (lastPoke) {
      const elapsedSec = Math.floor((Date.now() - lastPoke.sentAtMs) / 1000);
      if (elapsedSec <= SMELL_POKE_WINDOW_SEC) {
        const taskAgent = db.prepare(`SELECT agent_id AS assigned_to FROM work WHERE id = ?`).get(taskId) as { assigned_to: string | null } | undefined;
        // P6b REKEY: "did any real work ride this close" reads the CLOSING
        // TURN's own audit set (turn_number lineage, mig 116), not an
        // agent-global clock window that credited tool calls from unrelated
        // concurrent conversations. The dodge shape is by definition the
        // assignee closing its own task in-turn, so the closing turn is the
        // assignee's live turn; an engine/Key-2 close has no live turn and is
        // not a dodge, so no flag.
        const closingTurn = taskAgent?.assigned_to ? turnContext(taskAgent.assigned_to)?.turnNumber : undefined;
        if (taskAgent?.assigned_to && closingTurn !== undefined) {
          // PHASE-2 T8V — A NAME MATCH THE TYPESCRIPT SWEEP COULD NOT SEE, because it
          // is a SQL LIKE against `audit_log.target`. `audit_log` records the tool NAME,
          // and after the verb collapse no live tool starts with `tracker_`, so
          // `NOT LIKE 'tracker_%'` would have been TRUE for every work call — the smell
          // would have found a "non-tracker tool" in every closing turn and NEVER fired
          // again. It matches the live prefix now. The retired prefix is kept alongside
          // it because `audit_log` is HISTORY: a turn straddling the upgrade, or a
          // re-read of an older turn, still holds rows written under the old names.
          const nonTrackerTool = db.prepare(`
            SELECT 1 FROM audit_log
            WHERE agent_id = ?
              AND turn_number = ?
              AND action_type = 'tool_call'
              AND target NOT LIKE 'work\_%' ESCAPE '\'
              AND target NOT LIKE 'tracker\_%' ESCAPE '\'
            LIMIT 1
          `).get(taskAgent.assigned_to, closingTurn) as { 1: number } | undefined;
          if (!nonTrackerTool) {
            // Structured flag (P6b): readers parse fields, not prose.
            const flag = JSON.stringify({ kind: 'complete_dodges_poke', elapsedSec, closingTurn });
            noteUnsettled(patchWork(taskId, { last_smell_flag: flag }, { touch: false }), 'pm: smell flag stamped', { taskId });
            void import('./task-log.js').then(({ writeTaskLog }) => writeTaskLog({
              taskId,
              fromEntity: 'engine',
              entryKind: 'smell_flag',
              reason: flag,
            }));
            logger.info('Smell flag set: complete dodging poke', { taskId, elapsedSec, closingTurn });
          }
        }
      }
    }
  } else if (toStatus === 'paused' || toStatus === 'in_progress') {
    // Pause-resume thrash: count transitions in/out of paused for this task
    // within the last 30 minutes.
    // PHASE-2 T10G: counted off the spine's own transition events. The predicate is carried
    // shape-for-shape, and it survives the vocabulary change because `paused` is the ONE word
    // the two vocabularies share — `setTrackerStatus` passes it straight through to
    // `transition()`, so the event payload says `paused` exactly as the old column did.
    // MEASURED before the re-point rather than assumed: `work_events` transition payloads on
    // this box carry `to` values `done|claimed|abandoned|failed|open|paused|blocked`, so the
    // input this guard needs is present. The old table's own two paused rows are why this was
    // not converted on the "it never fires" reasoning (#15).
    const cycles = db.prepare(`
      SELECT COUNT(*) as c FROM work_events
      WHERE work_id = ?
        AND kind = 'transition'
        AND (json_extract(payload, '$.to') = 'paused'
             OR (json_extract(payload, '$.from') = 'paused'
                 AND json_extract(payload, '$.to') != 'paused'))
        AND created_at > (unixepoch('now') - ${SMELL_PAUSE_THRASH_WINDOW_MIN} * 60) * 1000
    `).get(taskId) as { c: number } | undefined;
    if (cycles && cycles.c >= SMELL_PAUSE_THRASH_CYCLES) {
      // The window here is the rate definition of "thrash", not a scar; the
      // count already reads structured spine transitions. Structured flag.
      const flag = JSON.stringify({ kind: 'pause_resume_thrash', cycles: cycles.c, windowMin: SMELL_PAUSE_THRASH_WINDOW_MIN });
      noteUnsettled(patchWork(taskId, { last_smell_flag: flag }, { touch: false }), 'pm: smell flag stamped', { taskId });
      void import('./task-log.js').then(({ writeTaskLog }) => writeTaskLog({
        taskId,
        fromEntity: 'engine',
        entryKind: 'smell_flag',
        reason: flag,
      }));
      logger.info('Smell flag set: pause-resume thrash', { taskId, cycles: cycles.c });
    }
  }
}

// ── PM LLM Review, runs the PM agent's brain periodically ──

let lastLLMReviewAt = 0;
let lastSituationReportHash = '';
const LLM_REVIEW_INTERVAL_MS = 600_000; // 10 minutes, gives tasks time to settle before reviewing

// ════════════════════════════════════════════════════════════════════════════════════════
// ⚰ TOMBSTONE — THE PM'S HOURLY LLM CALL CAP, RETIRED OUTRIGHT (SWEEP CORE-2 item 1).
//
// WHAT WAS HERE: `PM_LLM_CALLS_PER_HOUR_CAP = 30` with `pmLlmCallTimestamps`,
// `recordPmLlmCall()`, `pmLlmCallsInLastHour()`, `pmCapReached()`, and FA-T5's reserved
// `lastValidationReviewAt` cadence (~6/hr) that was supposed to keep validation from being
// starved by the cap. Three gates read them: the event-wake drop, the validation-review
// deferral, and the non-validation skip.
//
// WHY IT WENT, in the owner's words (2026-08-06): *"cost and token use is not really a
// factor… let her do it."* The cap was a blunt patch for a DIFFERENT problem — the PM
// spinning out for tens of minutes on something trivial — and it treated the symptom by
// rationing the validator. BATTERY9 `bmshmu5ygd5` measured what that costs: the cap
// throttling validation to ~6/hr while 98 rows waited, ZERO Key-2 verdicts written in 84
// minutes, and 96 of 98 handed rows missed across 27 no-verdict reviews.
//
// WHAT REPLACES IT: nothing. No replacement throttle, no budget, no reserved cadence. The
// SPIN is handled where a spin belongs — the platform's existing detect-and-steer recovery
// that every other agent already gets (the grind rung keyed on the provider's own stop
// signal, `agent/v2/steps/post-call-classify/empty-response.ts`; the repeated-identical-work
// brake, `agent/v2/identical-call-brake.ts`, whose own header records that the PM is the
// agent it was BUILT for). *"This needs to be more of a 'get the agent back on track when
// spinning out' thing like we do with the other agents. Then otherwise, let the PM do their
// work."*
//
// requirement preserved: the ~900-calls/day poll loop D7 closed stays closed — by
// `LLM_REVIEW_INTERVAL_MS` above (the idle heartbeat, unchanged) and by the `stableIssuesKey`
// dedup below, which are cadence and necessity gates rather than a ration.
// ════════════════════════════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════════════════════════════
// SWEEP-A TB8 JOB 2 — VALIDATION COVERAGE: did the validator actually rule?
//
// ── THE MEASUREMENT THIS EXISTS FOR (battery `bmsgs7qejup`, 00:32:44 → 01:55:13) ─────────
// The PM shows up: 89 poke ticks, 43 validation reviews, 85 model calls, 5 verdicts. The
// inherited "ZERO audits in both delegation windows" was the wrong instrument — a
// SUCCESSFUL validation writes no `audit` row at all, because every blessing goes through
// `writeTaskLog({ entryKind: 'transition' })` and `task-log.ts:119` returns null for that
// kind. What actually fails is latency, and the two clocks run in the wrong order:
//
//   01:14:17/:23/:33  three rows request Key 2
//   01:15:00–01:16:10 PM validation turn #1 — handed those rows, returned NO verdict
//   01:17:00–01:18:04 PM validation turn #2 — same rows, same silence
//   01:20:00          the SCHEDULER escalates all three TO THE OWNER as unvalidated
//   01:23:11          PM turn #3 finally upholds them — 8m38s–8m54s after Key 1
//
// Nothing recorded turns #1 and #2. Not a log line anyone can read (the skips are
// `logger.debug` and the level is pinned at 'info'), not a work event, not a counter. So
// the `stableIssuesKey` dedup — which compares the SAME unchanged issue-set equal and
// returns — silently swallowed every later attempt, and the only thing that moved was the
// owner escalation. That is the owner's two-key law failing in its bookkeeping half: a
// validator that does not rule must SAY SO, and the system must ask again.
//
// ── THE BOUND, WHICH IS NOT INVENTED (#14) ──────────────────────────────────────────────
// No cadence is chosen here. `VALIDATION_ESCALATION_MIN` is the product's OWN existing
// owner-escalation clock, imported from `scheduler/runner.ts` rather than copied. The law
// this file adds is only that the two clocks be ORDERED: a row must not reach the owner as
// "unvalidated" while the platform holds no record that its validator was ever asked.
// ════════════════════════════════════════════════════════════════════════════════════════

/** The product's own owner-escalation clock, in ms. Single-sourced, never re-declared. */
export const VALIDATION_COVERAGE_BOUND_MS = VALIDATION_ESCALATION_MIN * 60_000;

export interface ValidationCoverageInput {
  /** The rows this review actually put in front of the validator, awaiting Key 2. */
  readonly asked: ReadonlyArray<{ id: string; awaitingSinceMs: number }>;
  /** Read back AFTER the review turn: the ids that still await Key 2. */
  readonly stillAwaiting: ReadonlySet<string>;
  readonly nowMs: number;
}

export interface ValidationCoverage {
  /** Rows the validator was handed and did not rule on. */
  readonly missed: ReadonlyArray<{ id: string; waitedMs: number; pastOwnerBound: boolean }>;
  /** At least one miss has already outlived the owner-escalation clock. */
  readonly anyPastOwnerBound: boolean;
  /** Ask again on the next tick — the dedup must not swallow an unruled row. */
  readonly reReview: boolean;
}

/**
 * What a validation review COVERED, decided from the rows it held and the rows still
 * awaiting Key 2 when its turn came back. Pure on purpose: the whole point of TB8 JOB 2 is
 * that this question was previously unanswerable anywhere, so it gets an answer that can be
 * tested without a live PM, a live model or a live board.
 *
 * A row that was never handed to the validator cannot be a miss — this measures the
 * validator's coverage of what it was ASKED, never the board's total backlog.
 */
/**
 * Of the given task ids, which still await Key 2 — the SAME predicate the review's own
 * unvalidated-complete queue selects on, read once more after the turn. One expression, one
 * meaning: a second copy of "awaiting Key 2" is exactly the drift TB5/TB6 spent two tasks
 * removing from the kit.
 */
function idsStillAwaitingKeyTwo(ids: readonly string[]): Set<string> {
  if (ids.length === 0) return new Set();
  try {
    const db = getDb();
    const holes = ids.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT w.id AS id FROM work w
      WHERE w.id IN (${holes})
        AND (
          (w.state = 'done' AND ${validatedExpr('w', 'done')} = 0)
          OR (w.state = 'claimed' AND ${pendingCloseRequestExpr('w')} = 1)
        )
        AND ${awaitingUserVerdictExpr('w')} = 0
    `).all(...ids) as Array<{ id: string }>;
    return new Set(rows.map((r) => r.id));
  } catch {
    // A read that cannot run must not manufacture a clean bill of health: an unreadable
    // board is not a validated one, so nothing is reported as covered.
    return new Set(ids);
  }
}

export function validationCoverageAfterReview(input: ValidationCoverageInput): ValidationCoverage {
  const missed = input.asked
    .filter((row) => input.stillAwaiting.has(row.id))
    .map((row) => {
      const waitedMs = Math.max(0, input.nowMs - row.awaitingSinceMs);
      return { id: row.id, waitedMs, pastOwnerBound: waitedMs >= VALIDATION_COVERAGE_BOUND_MS };
    });
  return {
    missed,
    anyPastOwnerBound: missed.some((m) => m.pastOwnerBound),
    reReview: missed.length > 0,
  };
}

/**
 * THE VALIDATOR COULD NOT BE ASKED. Record it on the rows that are waiting, once each.
 *
 * SWEEP CORE-2 item 1. Scoped to the unvalidated-COMPLETE class (TB8's scope, and the class
 * the owner's ordering law is about) and to rows carrying NO recorded attempt yet — so the
 * record is exactly what the escalation gate needs and never a per-tick firehose into the
 * audit trail while a PM is down. The next tick re-reads the same predicate, so a row that
 * appears while the validator is still gone gets its own entry.
 */
function recordValidatorUnavailable(pmId: string, pmStatus: string): void {
  try {
    const rows = getDb().prepare(`
      SELECT w.id AS id FROM work w
      WHERE ${taskScope('w')}
        AND (
          (w.state = 'done' AND ${validatedExpr('w', 'done')} = 0)
          OR (w.state = 'claimed' AND ${pendingCloseRequestExpr('w')} = 1)
        )
        AND ${awaitingUserVerdictExpr('w')} = 0
        AND ${validationAttemptCountExpr('w')} = 0
      LIMIT 20
    `).all() as Array<{ id: string }>;
    if (rows.length === 0) return;
    logger.error('PM validation review CANNOT RUN: there is no validator to ask', {
      pmId, pmStatus, rowsWaiting: rows.length,
    });
    for (const r of rows) {
      writeTaskLog({
        taskId: r.id,
        fromEntity: 'pm',
        entryKind: 'observation',
        actionTaken: VALIDATION_ATTEMPT_UNAVAILABLE,
        reason:
          `the platform tried to get this row validated and there was no validator to ask `
          + `(PM ${pmId} is ${pmStatus}); the owner escalation is released so this does not sit silent`,
      });
    }
  } catch (err) {
    logger.warn('recording validator-unavailable failed (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// How many recent messages to keep for the PM. Bumped from 10 to 30 in
// v2.7.27, at 10 the pair-aware cutoff + downstream orphan sanitizer
// were trimming the PM down to 1-2 effective messages on bad turns,
// leaving it with no context to judge anything. 30 gives the sanitizer
// more pair-completeness to work with while still keeping the PM's
// window small. PM is still stateless conceptually (tracker is its
// memory), this is just enough scratch space.
const PM_MAX_MESSAGES = 30;

/**
 * Prune old PM messages to keep the context window small.
 * The PM doesn't need history, the tracker is its memory.
 */
function pruneOldPMMessages(pmId: string): void {
  const db = getDb();
  try {
    // Count total messages
    const countRow = db.prepare('SELECT COUNT(*) as c FROM messages WHERE agent_id = ?').get(pmId) as { c: number };
    if (countRow.c <= PM_MAX_MESSAGES) return;

    // Get the ID of the Nth most recent message (our initial cutoff candidate)
    const initialCutoff = db.prepare(`
      SELECT id FROM messages WHERE agent_id = ?
      ORDER BY created_at DESC, rowid DESC
      LIMIT 1 OFFSET ?
    `).get(pmId, PM_MAX_MESSAGES) as { id: string } | undefined;

    if (!initialCutoff) return;

    // v2.7.27: tool_call_pair-aware cutoff. If the initial cutoff lands on a
    // 'tool' role message, the resulting kept window starts with an orphaned
    // tool result (no preceding assistant with tool_calls). DeepSeek and most
    // other providers 400 with "Messages with role 'tool' must be a response
    // to a preceding message with 'tool_calls'", which then triggered the
    // injury-recovery loop and made the PM perpetually broken. The fix walks
    // forward from the initial cutoff to find the first non-tool message,
    // using that as the safe cutoff. We may keep fewer than PM_MAX_MESSAGES
    // when this fires; that's fine, PM is stateless and tracker is its memory.
    const cutoff = db.prepare(`
      SELECT id FROM messages
      WHERE agent_id = ?
        AND rowid >= (SELECT rowid FROM messages WHERE id = ?)
        AND role != 'tool'
      ORDER BY rowid ASC
      LIMIT 1
    `).get(pmId, initialCutoff.id) as { id: string } | undefined;

    if (!cutoff) return;

    // The incident this line remembers: summary_messages.message_id used to reference
    // messages(id) WITHOUT ON DELETE CASCADE, so a raw DELETE on a compacted PM message
    // threw and the prune failed forever ("Failed to prune PM messages" every 10 min for
    // hours, observed in production). The PM doesn't need its archived summaries anyway —
    // the tracker is its memory — so the link rows go first, then the messages, both inside
    // deleteForAgentBefore in one transaction.
    // PHASE-1 T7 re-stated: the reference is BACK (migration 130, now that one table holds
    // every lane) and it is ON DELETE CASCADE precisely so this incident cannot return by
    // way of some other delete path forgetting the ordering. deleteForAgentBefore keeps its
    // explicit first delete regardless — see the note there.
    const deleted = deleteForAgentBefore(pmId, cutoff.id);

    if (deleted > 0) {
      logger.debug('Pruned old PM messages', { pmId, deleted, kept: PM_MAX_MESSAGES });
    }
  } catch (err) {
    logger.warn('Failed to prune PM messages', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function runPMReview(): Promise<void> {
  const now = Date.now();
  const db = getDb();

  // SWEEP CORE-2 item 1 — THE RIDER. Whatever the doorbell rang for since the last review is
  // carried INTO this one: these rows lead the queue, skip the settle window (a doorbell row
  // IS the completion event) and defeat the dedup gate (a doorbell IS the change).
  const doorbell = new Set(drainValidationDoorbell());

  // The 10-minute time gate avoids spamming the LLM when nothing meaningful is
  // happening. But unvalidated-complete / blocked / paused tasks and pending
  // override requests are time-sensitive: the sooner PM validates them, the
  // sooner real danglers surface to the user, so the review bypasses the
  // 10-minute cadence gate when validation work is queued.
  const pendingValidationCount = (() => {
    try {
      return (db.prepare(`
        SELECT
          (SELECT COUNT(*) FROM work w WHERE ${taskScope('w')} AND w.state = 'done' AND ${validatedExpr('w','done')} = 0 AND ${awaitingUserVerdictExpr('w')} = 0) +
          -- PHASE-2 T8T: the SECOND shape of an unvalidated close. A worker's own close is a
          -- Key-1 REQUEST now (RULING 1), so the row it is about is still claimed - counting
          -- only the done ones would make the queue read empty while work waited in it.
          (SELECT COUNT(*) FROM work w WHERE ${taskScope('w')} AND w.state = 'claimed' AND ${pendingCloseRequestExpr('w')} = 1 AND ${awaitingUserVerdictExpr('w')} = 0) +
          (SELECT COUNT(*) FROM work w WHERE ${taskScope('w')} AND w.state = 'blocked' AND ${validatedExpr('w','blocked')} = 0 AND ${awaitingUserVerdictExpr('w')} = 0) +
          (SELECT COUNT(*) FROM work w WHERE ${taskScope('w')} AND w.state = 'paused' AND ${validatedExpr('w','paused')} = 0) +
          ${PENDING_OVERRIDE_COUNT_SQL}
        AS c
      `).get() as { c: number }).c;
    } catch {
      return 0;
    }
  })();
  const validationPending = pendingValidationCount > 0;
  if (!validationPending && now - lastLLMReviewAt < LLM_REVIEW_INTERVAL_MS) return;

  // SWEEP CORE-2 item 1: the two per-hour cap gates that stood here are DELETED. See the
  // tombstone above `PM_MAX_MESSAGES`. Nothing rations the validator now — a spin is handled
  // by the platform's own recovery, and validation runs whenever there is validation to do.

  const pmId = getPMAgentId();

  // Prune old messages before each review to keep context tight
  pruneOldPMMessages(pmId);

  // ── Validation-review context wipe ──
  // When there's pending validation work, the PM agent's previous turns
  // left assistant tool_calls + tool_results in its history. The OpenAI
  // Pass 1 sanitizer can strip orphan tool_results (e.g., when a prior
  // assistant got pruned away or compacted out), leaving the PM's view
  // of its own past work inconsistent, and it responds with [no-reply]
  // because it can't reconcile what it sees with what it's being asked
  // to do. The codebase's design intent is that PM is stateless and the
  // tracker is its memory. Honor that: wipe the PM's conversation
  // history before each validation review so it starts fresh. We keep
  // system messages (system prompt, session boundary) so identity /
  // instructions persist.
  if (pendingValidationCount > 0) {
    try {
      const wiped = deleteNonSystemForAgent(pmId);
      if (wiped > 0) {
        // D7: do NOT reset the dedup hash here. The dedup key is the actionable
        // issue-SET (stableIssuesKey), so keeping the hash means a re-review fires
        // only when the set of tasks needing validation actually CHANGES, not on
        // every 60s poll of an unchanged board. Resetting it forced a fresh LLM
        // review each poll while any task sat unvalidated, the ~900-calls/day loop.
        logger.info('Wiped PM conversation history before validation review', {
          pmId, deletedMessages: wiped, pendingValidation: pendingValidationCount,
        });
      }
    } catch (err) {
      logger.warn('Failed to wipe PM conversation before validation review (non-fatal)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const pmName = getPMAgentName();
  const primaryName = getPrimaryAgentName();

  // Check if PM agent exists and has a model
  const pmAgent = db.prepare('SELECT id, model_id, status FROM agents WHERE id = ?').get(pmId) as { id: string; model_id: string | null; status: string } | undefined;
  if (!pmAgent || !pmAgent.model_id || pmAgent.status === 'terminated') {
    // ── SWEEP CORE-2 item 1 — THERE IS NO VALIDATOR TO ASK, AND THE ROW MUST SAY SO ──
    // This return has always been silent, and it becomes load-bearing the moment the owner
    // escalation waits for a recorded attempt: a box whose PM is gone would record nothing,
    // escalate nothing, and tell the owner NOTHING for ever. An attempt that could not be
    // made is still an attempt — recorded through the SAME audit door as a miss, with its own
    // marker so the record does not claim a review happened.
    if (validationPending) recordValidatorUnavailable(pmId, pmAgent?.status ?? 'missing');
    return;
  }

  // ── Engine-level checks (fast, deterministic, no LLM needed) ──
  const allTasks = listTasks({});
  const activeTasks = allTasks.filter(t => !['complete', 'fallen', 'paused'].includes(t.status));

  // Phase B.1: even when no tasks are "active" (in_progress / on_deck /
  // blocked), there may still be unvalidated-complete or override-request
  // rows that need PM judgment. Only return early when truly nothing
  // requires PM attention. Cheap COUNT queries before deciding.
  if (activeTasks.length === 0) {
    const pendingCount = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM work w WHERE ${taskScope('w')} AND w.state = 'done' AND ${validatedExpr('w','done')} = 0 AND ${awaitingUserVerdictExpr('w')} = 0) +
          -- PHASE-2 T8T: the SECOND shape of an unvalidated close. A worker's own close is a
          -- Key-1 REQUEST now (RULING 1), so the row it is about is still claimed - counting
          -- only the done ones would make the queue read empty while work waited in it.
          (SELECT COUNT(*) FROM work w WHERE ${taskScope('w')} AND w.state = 'claimed' AND ${pendingCloseRequestExpr('w')} = 1 AND ${awaitingUserVerdictExpr('w')} = 0) +
        (SELECT COUNT(*) FROM work w WHERE ${taskScope('w')} AND w.state = 'blocked' AND ${validatedExpr('w','blocked')} = 0 AND ${awaitingUserVerdictExpr('w')} = 0) +
        (SELECT COUNT(*) FROM work w WHERE ${taskScope('w')} AND w.state = 'paused' AND ${validatedExpr('w','paused')} = 0) +
        ${PENDING_OVERRIDE_COUNT_SQL}
      AS c
    `).get() as { c: number };
    if (pendingCount.c === 0) return;
  }

  lastLLMReviewAt = now;
  // (FA-T5's reserved validation cadence marker was here. It existed only to keep the
  // retired per-hour cap from starving validation; with the cap gone it rationed nothing and
  // is deleted with it — see the tombstone.)

  const agents = db.prepare(`
    SELECT id, name, status, classification, updated_at, parent_agent, task_id, timeout_at
      FROM agents WHERE status != 'terminated'
  `).all() as Array<{ id: string; name: string; status: string; classification: string; updated_at: string; parent_agent: string | null; task_id: string | null; timeout_at: string | null }>;

  // P5c SHRINK: dormancy is LIFECYCLE state, not message recency. The old rule
  // ("no message in 7 days") inferred lifecycle from quiet and silently
  // excluded a merely-unused agent's tasks from review, the hidden-state class
  // the STATUS-TRUTH invariant bans. An agent is out of PM scope exactly when
  // its lifecycle says so:
  //   - its runtime window expired (timeout_at in the past), or
  //   - it is a spawned worker whose spawning task is finished or gone
  //     (parent_agent set; task_id missing/terminal), the "old test group"
  //     debris the recency heuristic was actually built for.
  // A quiet-but-alive agent's tasks are reviewed like anyone else's; the
  // per-issue dedup bounds any one-time surfacing of long-stale work.
  const dormantAgentIds = new Set<string>();
  const nowMs = Date.now();
  for (const agent of agents) {
    if (agent.timeout_at) {
      const t = Date.parse(agent.timeout_at.includes('Z') ? agent.timeout_at : agent.timeout_at + 'Z');
      if (Number.isFinite(t) && t < nowMs) {
        dormantAgentIds.add(agent.id);
        continue;
      }
    }
    if (agent.parent_agent) {
      if (!agent.task_id) {
        dormantAgentIds.add(agent.id);
        continue;
      }
      const spawnTask = db.prepare(`SELECT ${STATE_TO_STATUS_SQL('state')} AS status FROM work WHERE id = ?`)
        .get(agent.task_id) as { status: string } | undefined;
      if (!spawnTask || spawnTask.status === 'complete' || spawnTask.status === 'fallen') {
        dormantAgentIds.add(agent.id);
      }
    }
  }

  // Issues collected as { stableId, text }. The stableId, keyed on task
  // id + issue type, is what feeds the dedup hash. The free-form text
  // (with "X minutes" counters) is what the LLM sees. Without this split,
  // every minute of elapsed time changed the hash and the dedup at line
  // 510 never fired (v2.3.7).
  const issues: Array<{ stableId: string; text: string }> = [];
  // SWEEP-A TB8 JOB 2 — the rows this review actually puts in front of the validator with
  // Key 2 outstanding. Scoped DELIBERATELY to the unvalidated-COMPLETE queue: that is the
  // two-key class the owner's law is about and the one `delegation-longhorizon` clause (c)
  // measures. The pause/block queues are a different verdict with a different meaning and
  // are not claimed by this measurement.
  const askedForKeyTwo: Array<{ id: string; awaitingSinceMs: number }> = [];
  const nowDate = new Date();

  for (const task of activeTasks) {
    // Skip tasks assigned to dormant agents, they belong to old test groups
    // or paused projects and should not trigger false alarms.
    // EXCEPTION: in_progress tasks are never skipped, if someone manually
    // activated a task on a dormant agent, the PM should still monitor it.
    if (task.assignedTo && dormantAgentIds.has(task.assignedTo) && task.status !== 'in_progress') continue;

    // 1. Orphaned tasks: assigned to terminated agents
    if (task.assignedTo) {
      const agent = agents.find(a => a.id === task.assignedTo);
      if (!agent) {
        issues.push({
          stableId: `${task.id}|ORPHANED`,
          text: `ORPHANED: "${task.title}" is assigned to a terminated agent. Notify ${primaryName}.`,
        });
      }
    }

    // 2. Overdue scheduled tasks
    if (task.nextRunAt) {
      const nextRunTime = new Date(task.nextRunAt.includes('Z') ? task.nextRunAt : task.nextRunAt + 'Z');
      if (nextRunTime < nowDate && task.scheduleStatus === 'waiting') {
        const overdueMin = Math.floor((nowDate.getTime() - nextRunTime.getTime()) / 60000);
        if (overdueMin > 5) {
          issues.push({
            stableId: `${task.id}|OVERDUE`,
            text: `OVERDUE: "${task.title}" was due ${overdueMin} minutes ago but hasn't fired.`,
          });
        }
      }
    }

    // 3. Blocked tasks sitting too long
    if (task.status === 'blocked') {
      const updatedTime = new Date(task.updatedAt.includes('Z') ? task.updatedAt : task.updatedAt + 'Z');
      const blockedMin = Math.floor((nowDate.getTime() - updatedTime.getTime()) / 60000);
      if (blockedMin > 30) {
        issues.push({
          stableId: `${task.id}|BLOCKED`,
          text: `BLOCKED: "${task.title}" has been blocked for ${blockedMin} minutes. May need ${primaryName}'s attention.`,
        });
      }
    }

    const GRACE_PERIOD_MINUTES = 30;
    const taskUpdatedTime = new Date(task.updatedAt.includes('Z') ? task.updatedAt : task.updatedAt + 'Z');
    const timeSinceUpdateMin = Math.floor((nowDate.getTime() - taskUpdatedTime.getTime()) / 60000);

    // 4. Non-scheduled tasks stuck in on_deck with no activity.
    if (task.status === 'on_deck' && !task.scheduledStart && task.assignedTo && task.scheduleStatus !== 'waiting') {
      const updatedTime = new Date(task.updatedAt.includes('Z') ? task.updatedAt : task.updatedAt + 'Z');
      const staleMin = Math.floor((nowDate.getTime() - updatedTime.getTime()) / 60000);
      if (staleMin > GRACE_PERIOD_MINUTES && timeSinceUpdateMin > GRACE_PERIOD_MINUTES) {
        const agentName = task.assignedToName ?? task.assignedTo;
        issues.push({
          stableId: `${task.id}|STALE`,
          text: `STALE: "${task.title}" has been on_deck for ${staleMin} minutes, assigned to ${agentName} but not started.`,
        });
      }
    }

    // 5. In-progress tasks where the assigned agent has been sitting idle.
    // v2.7.17 - tightened from "no message in 30 min" to "agent.status='idle'
    // AND agents.updated_at older than 2 min." Two reasons:
    //   (a) status='idle' on the agents row means the agent has actually
    //       ended a turn and is NOT mid-tool-call. Don't poke during slow
    //       legitimate work.
    //   (b) agents.updated_at gets bumped when status flips - so it's an
    //       exact "agent went idle at" timestamp, not a sloppy proxy.
    // The agent's end-of-turn nudge teaches it to mark waiting-on-user
    // tasks as 'paused' (PM ignores) and escalation cases as 'blocked' (PM
    // surfaces but doesn't poke). An IDLE issue here means the agent
    // genuinely stalled out without transitioning, and the PM should poke.
    //
    // Exempts recurring tasks with a future nextRunAt - those are stuck-
    // between-runs from a previous fire that didn't close cleanly. The
    // scheduler's cleanupStaleRuns is responsible for those (v2.3.7);
    // PM nagging only adds noise on top.
    const IN_PROGRESS_IDLE_THRESHOLD_MIN = 2;
    if (task.status === 'in_progress' && task.assignedTo) {
      let waitingForFutureFire = false;
      if (task.nextRunAt) {
        const nextRunMs = new Date(task.nextRunAt.includes('Z') ? task.nextRunAt : task.nextRunAt + 'Z').getTime();
        if (nextRunMs - nowDate.getTime() > IN_PROGRESS_IDLE_THRESHOLD_MIN * 60_000) {
          waitingForFutureFire = true;
        }
      }
      if (!waitingForFutureFire) {
        const agent = agents.find(a => a.id === task.assignedTo);
        if (agent && agent.status === 'idle') {
          const agentUpdatedAt = new Date(agent.updated_at.includes('Z') ? agent.updated_at : agent.updated_at + 'Z');
          const idleMin = Math.floor((nowDate.getTime() - agentUpdatedAt.getTime()) / 60000);
          if (idleMin >= IN_PROGRESS_IDLE_THRESHOLD_MIN) {
            const agentName = task.assignedToName ?? task.assignedTo;
            issues.push({
              stableId: `${task.id}|IDLE`,
              // P2 drive boundary: the engine poke LADDER owns driving idle
              // work (task-staleness clock, working-skip, 4-option check-in,
              // escalation rungs). The review just surfaces the fact; the old
              // fully-scripted "POKE THEM ... continue from EXACTLY where you
              // stopped" duplicate (whose main job was undoing the ladder's own
              // mid-turn false positives, now impossible) is retired.
              text: `IDLE: "${task.title}" (${task.id.slice(0, 8)}) is in_progress and ${agentName} has been idle ${idleMin} minute(s). The engine poke ladder is driving this; only act if you see something the ladder cannot fix (wrong assignee, impossible task, needs the user), in which case use the tracker verbs or message ${agentName} with the specific problem.`,
            });
          }
        }
      }
    }
  }

  // ── v2.7.18: unvalidated-pause detection ──
  // Every task with status='paused' AND pause_validated=0 needs a PM
  // judgment call before it's "trusted." Catches the gaming pattern
  // where agents mark tasks paused just to silence PM pokes.
  //
  // Wait at least 1 minute after the pause to give the agent a beat to
  // also resolve / unpause / get woken up by an inbound user message.
  // Include the agent's last user-facing assistant message (so PM can
  // judge whether the pause notes match a real request) and the task
  // notes themselves (the pause reason the agent supplied).
  const unvalidatedPauseRows = db.prepare(`
    SELECT w.id AS id, w.title AS title, w.agent_id AS assigned_to,
           ${msToText('w.updated_at')} AS updated_at
    FROM work w
    WHERE ${taskScope('w')} AND w.state = 'paused'
      AND ${validatedExpr('w', 'paused')} = 0
      AND w.updated_at < ?
    ORDER BY w.updated_at ASC
    LIMIT 10
  `).all(Date.now() - 60_000) as Array<{ id: string; title: string; assigned_to: string | null; updated_at: string }>;

  // Phase B.0: read the pause reason from the most recent observation entry
  // attached to this task in task_log, with fallback to the legacy notes
  // column for tasks that pre-date the migration backfill. Once the
  // backfill has run on this DB the legacy fallback should rarely hit.
  //
  // v2.9.22, also accept 'auto_sweep' entries so engine-initiated pauses
  // surface a real reason. Pre-fix, engine auto-pauses wrote auto_sweep
  // entries that this filter missed, so PM saw "(EMPTY)" and rejected
  // every engine-paused task as gaming. The primary fix (engine auto-pause
  // setting pause_validated=1) makes this filter irrelevant for engine
  // pauses going forward, but if any other code path leaves an
  // unvalidated auto-pause in the world, PM at least sees the reason.
  // PHASE-2 T10G: the trail's own reader. Same three kinds, same newest-first order; the
  // statement is gone because the table is.
  const recentObservation = (id: string): { note: string | null } | undefined =>
    listTaskLog(id, { limit: 1, kinds: ['observation', 'legacy_note', 'auto_sweep'] })[0];
  const legacyNotesStmt = db.prepare(`SELECT notes FROM work WHERE id = ?`);

  for (const pTask of unvalidatedPauseRows) {
    const agentName = pTask.assigned_to
      ? agents.find(a => a.id === pTask.assigned_to)?.name ?? pTask.assigned_to
      : 'unassigned';
    let lastAssistantSnippet = '(no recent assistant message)';
    if (pTask.assigned_to) {
      const lastMsg = db.prepare(`
        SELECT content FROM messages
        WHERE agent_id = ? AND role = 'assistant'
        ORDER BY created_at DESC, rowid DESC LIMIT 1
      `).get(pTask.assigned_to) as { content: string } | undefined;
      if (lastMsg?.content) {
        lastAssistantSnippet = lastMsg.content.length > 220
          ? lastMsg.content.slice(0, 220) + '...'
          : lastMsg.content;
      }
    }
    const logRow = recentObservation(pTask.id);
    const legacyRow = legacyNotesStmt.get(pTask.id) as { notes: string | null } | undefined;
    const rawReason = logRow?.note ?? legacyRow?.notes ?? null;
    const pauseReason = rawReason && rawReason.trim()
      ? rawReason.replace(/\s+/g, ' ').trim()
      : '(EMPTY)';
    issues.push({
      stableId: `${pTask.id}|UNVALIDATED_PAUSE`,
      text:
        `UNVALIDATED_PAUSE: "${pTask.title}" (${pTask.id.slice(0, 8)}) was paused by ${agentName} but has not been validated yet.\n` +
        `  Pause reason notes: "${pauseReason}"\n` +
        `  Agent's last user-facing message: "${lastAssistantSnippet}"\n` +
        `  Decide: valid pause (names a specific external trigger that matches a real request) or gaming (vague / no matching request / sounds like 'blocked' instead). ` +
        `Call work_validate(action="validate", kind="pause", task_id="${pTask.id}", valid=true) if real. ` +
        `Call work_validate(action="validate", kind="pause", task_id="${pTask.id}", valid=false, reject_reason="...one sentence...") if gaming. ` +
        `Rejection auto-reverts the task to in_progress (or pass target_status to pick on_deck/blocked) and notifies the agent.`,
    });
  }

  // SWEEP CORE-2 item 1 — the doorbell's rows, as a bound OR-arm on the settle window.
  // Parameterised (never interpolated) because a work id is data.
  const doorbellIds = Array.from(doorbell).slice(0, 20);
  const doorbellIn = doorbellIds.length > 0
    ? { sql: `OR w.id IN (${doorbellIds.map(() => '?').join(',')})`, params: doorbellIds }
    : { sql: '', params: [] as string[] };

  // ── Phase B.1: UNVALIDATED_COMPLETE ──
  // Every task whose close is filed and unblessed needs a PM judgment. Read the goal,
  // result, evidence, and any smell_flag context; open files / pull audit log entries when
  // evidence points there.
  //
  // PHASE-2 T8T — THIS RUNG HAS TWO SHAPES NOW, AND THAT IS THE WHOLE POINT OF THE TRIGGER.
  //   * `done` + no authority verdict — the engine's own delivery-receipt close (strike 0,
  //     strike 2, the assignment-thread deliverable). Unchanged: the engine turns the
  //     trigger's key, never the PM's, so the row lands here exactly as it always did.
  //   * `claimed` + a pending close request — the worker said it was finished and RULING 1
  //     says that is Key 1. The row does not move until this rung blesses it.
  // Reading only the first shape is how the queue would go quiet while work waited in it.
  const unvalidatedCompleteRows = db.prepare(`
    SELECT w.id AS id, w.title AS title, w.agent_id AS assigned_to, w.goal AS goal,
           w.result AS result, w.evidence_json AS evidence_json, w.last_smell_flag AS last_smell_flag,
           w.requester_id AS created_by, w.parent_id AS project_id,
           w.repeat_interval AS repeat_interval, ${msToText('w.next_run_at')} AS next_run_at,
           w.priority AS priority, ${msToText('w.updated_at')} AS updated_at,
           -- TB8 JOB 2: the raw epoch beside the rendered text. The text form is what the
           -- model reads; the coverage law needs a clock, and re-parsing prose for one is
           -- how a measurement quietly stops meaning what it says.
           w.updated_at AS updated_at_ms,
           ${validationAttemptCountExpr('w')} AS attempts_recorded,
           ${revertCountExpr('w')} AS revert_count
    FROM work w
    WHERE ${taskScope('w')}
      AND (
        (w.state = 'done' AND ${validatedExpr('w', 'done')} = 0)
        OR (w.state = 'claimed' AND ${pendingCloseRequestExpr('w')} = 1)
      )
      AND ${awaitingUserVerdictExpr('w')} = 0
      -- SWEEP CORE-2 item 1 — THE RIDER SKIPS THE SETTLE WINDOW. The 15 s guard exists so a
      -- row is not reported mid-write; a DOORBELL row was rung by the very write that
      -- finished it, with its result and evidence already persisted, so making it wait is the
      -- patrol sweep this task removes wearing a shorter name.
      AND (w.updated_at < ? ${doorbellIn.sql})
    -- SWEEP CORE-2 item 1 — HEAD-OF-LINE IS DESIGNED OUT (owner's constraint (c)).
    -- Ordering by age alone meant the row that kept defeating the validator LED EVERY
    -- REVIEW, eating the turn while the queue behind it went unserved — 84 minutes of it in
    -- BATTERY9. Ordering by recorded attempts first means a steered-off spin serves the items
    -- behind it and CIRCLES BACK: the count is a COUNT over durable audit rows, the row is
    -- never dropped, never capped, and never rendered un-approvable. Age still breaks ties,
    -- so equal-attempt rows keep their FIFO fairness. The order is READ from
    -- work/validation-drive.ts, never restated, so the proof and the queue cannot drift.
    ORDER BY ${validationQueueOrderExpr('w')}
    LIMIT 10
  `).all(Date.now() - 15_000, ...doorbellIn.params) as Array<{
    id: string; title: string; assigned_to: string | null; goal: string | null;
    result: string | null; evidence_json: string | null; last_smell_flag: string | null;
    created_by: string; project_id: string | null;
    repeat_interval: number | null; next_run_at: string | null;
    priority: string; updated_at: string; updated_at_ms: number; attempts_recorded: number;
    revert_count: number;
  }>;

  // Phase B.1: per-task lookup for goal-edit history. If the goal was
  // edited AFTER the task moved to in_progress, the assigned agent may have
  // moved the goalposts; PM needs to know.
  // PHASE-2 T10G: read off the trail. The `action_taken = 'goal_edited'` discriminator is
  // preserved as a filter on the projected entry, because that string is the whole signal.
  const goalEditStmt = (id: string): Array<{ note: string | null; edited_at: string }> =>
    listTaskLog(id, { limit: 20, kinds: ['observation'] })
      .filter((e) => e.actionTaken === 'goal_edited')
      .slice(0, 3)
      .map((e) => ({ note: e.note, edited_at: e.createdAt }));

  for (const cTask of unvalidatedCompleteRows) {
    // ── Engine-maintenance adjudication (owner ruling 2026-07-18) ──
    // Service-agent maintenance tasks (memory-cycle batches, healer/trainer/
    // imaginer housekeeping, PM self-tasks) must be adjudicated by the ENGINE
    // against its own receipts, deterministically, never by the PM model chain
    // (which cannot inspect internal machinery and stalls in poke ping-pong)
    // and never by the user (who cannot observe it at all). Production chain:
    // churn-era dreamer tasks sat complete+unvalidated for days, then the
    // newly-visible escalation tier asked the OWNER yes/no questions about
    // archive batches. The escalation skip alone would leave the stall in
    // place forever; this branch RESOLVES it through the sanctioned Key-2 door
    // (trackerValidateComplete as the PM), with the basis recorded.
    // P6b SHRINK: the old bases 2 (dreamer + global archive-queue consult) and
    // 3 (silent unverifiable leftover) are gone. With receipt-filed closeouts
    // + execution lineage, every legitimate maintenance completion carries its
    // own receipt (basis 1). A receipt-LESS one still closes (valid=false
    // would re-open churn on a shell nobody can work, the days-stall class)
    // but the basis names it a DEFECT and the log is error-level: the
    // completing path failed to file its receipt, which is a bug to fix, not
    // background noise to adjudicate around.
    if (cTask.assigned_to && isSystemServiceAgent(cTask.assigned_to)) {
      try {
        const { trackerValidateComplete } = await import('./tools.js');
        const hasReceipt = Boolean((cTask.result && cTask.result.trim()) || (cTask.evidence_json && cTask.evidence_json !== '[]'));
        const basis = hasReceipt
          ? `engine-maintenance receipt on the task itself: ${(cTask.result ?? '').slice(0, 160) || 'evidence array recorded'}`
          : 'DEFECT: maintenance completion filed NO receipt (result/evidence empty); closed by engine jurisdiction rule to prevent churn, but the completing path owes a receipt';
        if (!hasReceipt) {
          logger.error('PM sweep: maintenance task completed WITHOUT a receipt (receipt-filed closeout contract violated by the completing path)', {
            taskId: cTask.id, assignedTo: cTask.assigned_to, title: (cTask.title ?? '').slice(0, 120),
          });
        }
        await trackerValidateComplete(getPMAgentId(), { task_id: cTask.id, valid: true });
        const { writeTaskLog } = await import('./task-log.js');
        writeTaskLog({
          taskId: cTask.id,
          fromEntity: 'pm',
          entryKind: 'observation',
          actionTaken: 'engine-maintenance adjudication',
          reason: basis,
        });
        logger.info('PM sweep: engine-maintenance task adjudicated deterministically (never via model chain or user)', {
          taskId: cTask.id, assignedTo: cTask.assigned_to, basis: basis.slice(0, 200),
        });
      } catch (err) {
        logger.warn('PM sweep: engine-maintenance adjudication failed (will retry next sweep)', {
          taskId: cTask.id, error: err instanceof Error ? err.message : String(err),
        });
      }
      continue;
    }

    const agentName = cTask.assigned_to
      ? agents.find(a => a.id === cTask.assigned_to)?.name ?? cTask.assigned_to
      : 'unassigned';
    const isRecurringRun = cTask.repeat_interval !== null && cTask.next_run_at !== null;
    const tierHint = cTask.assigned_to === cTask.created_by
      ? '  Trust hint: this is a SELF-ASSIGNED task. Bias toward validate unless something concretely smells off.'
      : '';
    const smellLine = cTask.last_smell_flag
      ? `\n  ⚠ SMELL_FLAG: ${renderSmellFlag(cTask.last_smell_flag)}`
      : '';
    const runLine = isRecurringRun
      ? `\n  Per-run completion (recurring task, next fire at ${cTask.next_run_at}). On valid=true the engine archives result/evidence to task_log and resets to on_deck for next fire.`
      : '';
    const goalEdits = goalEditStmt(cTask.id);
    const goalEditLine = goalEdits.length > 0
      ? `\n  ⚠ GOAL EDITED ${goalEdits.length} time(s). Most recent: ${goalEdits[0].edited_at}. ` +
        `Compare result against the ORIGINAL goal, not the rewritten one. Diffs:\n` +
        goalEdits.map((e) => `    - ${e.note ?? '(no diff captured)'}`).join('\n')
      : '';
    let evidenceLines = '(no evidence array)';
    try {
      if (cTask.evidence_json) {
        const parsed = JSON.parse(cTask.evidence_json) as Array<{ kind?: string; claim?: string; pointer?: string }>;
        evidenceLines = parsed.map((e, i) => `    ${i + 1}. [${e.kind ?? '?'}] ${e.claim ?? ''}${e.pointer ? ` @ ${e.pointer}` : ''}`).join('\n');
      }
    } catch { /* leave as default */ }
    // TB8 JOB 2: this row is now IN FRONT OF the validator. Recorded here, judged after
    // the turn returns — coverage is about what was ASKED, never the board's total backlog.
    askedForKeyTwo.push({ id: cTask.id, awaitingSinceMs: cTask.updated_at_ms });
    // SWEEP CORE-2 item 1 — the doorbell's own line, in the owner's framing. It is model-
    // directed engine prose exactly like every other line in this report (OR2 holds by
    // shape: the engine steers, the PM speaks), and it names the ONE thing he asked for —
    // confirm it, push back on it, or go get more information.
    const doorbellLine = doorbell.has(cTask.id)
      ? `\n  🔔 ${agentName} just said they got this done. Confirm and mark it in the tracker, `
        + `or push back, or get more info — whatever it takes to make sure the task actually `
        + `gets completed. Do this one now.`
      : '';
    // UX-REPAIR round 2 T11 — THE DEREFERENCEABLE POINTER, finally in the payload that demands
    // one. `resolveTaskAnswerPointer` reads the ask's own recorded receipt (via T11's task→ask
    // edge) or the task's answered turn; it returns null rather than anything inferred, so a
    // row with nothing behind it reads exactly as it does today. See its header for why the
    // review could not do this before: kelly's ~40 `history_search` calls on S4 were searching
    // lanes the answer does not live in, because the payload gave it nothing to open.
    const answerPointer = resolveTaskAnswerPointer(cTask.id);
    const deliveredLine = answerPointer
      ? `\n  📄 DELIVERED ANSWER ON RECORD (${answerPointer.basis === 'parent-ask-receipt'
          ? 'the receipt the engine recorded for the request this task exists for'
          : 'this task\'s own answered turn'}`
        + `${answerPointer.channel ? `, via ${answerPointer.channel}` : ''}`
        + `${answerPointer.at ? `, ${answerPointer.at} UTC` : ''}`
        + `; delivery ${answerPointer.deliveryId.slice(0, 8)}`
        + `${answerPointer.messageId ? `, message ${answerPointer.messageId.slice(0, 8)}` : ''}):\n`
        + `    "${answerPointer.excerpt}"\n`
        + `  This IS the dereference — compare it against the goal and rule. `
        + `Use history_get on the message id above if you need the whole thing.`
      : '';
    // Not shown to the model — it is the ordering fact, and prose about it would only invite
    // the validator to treat a stubborn row as suspect. Logged instead, below.
    void cTask.attempts_recorded;
    issues.push({
      stableId: `${cTask.id}|UNVALIDATED_COMPLETE|${cTask.revert_count}`,
      text:
        `UNVALIDATED_COMPLETE: "${cTask.title}" (${cTask.id.slice(0, 8)}) closed by ${agentName}, awaiting your validation.${doorbellLine}${smellLine}${runLine}${goalEditLine}\n` +
        `  Goal: ${cTask.goal ?? '(no goal recorded, pre-migration row)'}\n` +
        `  Result: ${cTask.result ?? '(none)'}\n` +
        `  Evidence:\n${evidenceLines}${deliveredLine}\n` +
        `  Priority=${cTask.priority}, revert_count=${cTask.revert_count}.${tierHint}\n` +
        `  Read the file/audit log/output referenced in evidence BEFORE validating (skepticism rule). ` +
        `Call work_validate(action="validate", kind="complete", task_id="${cTask.id}", valid=true) when the work demonstrably matches the goal. ` +
        `Call work_validate(action="validate", kind="complete", task_id="${cTask.id}", valid=false, reject_reason="...", target_status="in_progress") when it does not.`,
    });
  }

  // ── Phase B.1: UNVALIDATED_BLOCK ──
  const unvalidatedBlockRows = db.prepare(`
    SELECT w.id AS id, w.title AS title, w.agent_id AS assigned_to, w.goal AS goal,
           w.priority AS priority, ${msToText('w.updated_at')} AS updated_at,
           ${revertCountExpr('w')} AS revert_count
    FROM work w
    WHERE ${taskScope('w')} AND w.state = 'blocked'
      AND ${validatedExpr('w', 'blocked')} = 0
      AND ${awaitingUserVerdictExpr('w')} = 0
      AND w.updated_at < ?
    ORDER BY w.updated_at ASC
    LIMIT 10
  `).all(Date.now() - 60_000) as Array<{
    id: string; title: string; assigned_to: string | null; goal: string | null;
    priority: string; updated_at: string; revert_count: number;
  }>;

  for (const bTask of unvalidatedBlockRows) {
    const agentName = bTask.assigned_to
      ? agents.find(a => a.id === bTask.assigned_to)?.name ?? bTask.assigned_to
      : 'unassigned';
    const obsRow = recentObservation(bTask.id);
    const blockReason = obsRow?.note?.trim() || '(no recent observation)';
    issues.push({
      stableId: `${bTask.id}|UNVALIDATED_BLOCK|${bTask.revert_count}`,
      text:
        `UNVALIDATED_BLOCK: "${bTask.title}" (${bTask.id.slice(0, 8)}) marked blocked by ${agentName}, awaiting validation.\n` +
        `  Goal: ${bTask.goal ?? '(no goal recorded)'}\n` +
        `  Block reason: ${blockReason}\n` +
        `  Priority=${bTask.priority}, revert_count=${bTask.revert_count}.\n` +
        `  Real block (genuine external obstacle, no workaround) -> work_validate(action="validate", kind="blocked", task_id="${bTask.id}", valid=true). ` +
        `Not really blocked (agent hasn't asked the user, or has a workaround they haven't tried) -> work_validate(action="validate", kind="blocked", task_id="${bTask.id}", valid=false, reject_reason="...").`,
    });
  }

  // ── Phase B.1: OVERRIDE_REQUEST ──
  // PHASE-2 T8T RESUMED-2 (RULING 4): the queue is `work_events` now, and the ordering key
  // is the event sequence rather than a TEXT clock — oldest ask first, exactly as before.
  const overrideRows = listOverrideRequests({ status: 'pending', limit: 10 });

  for (const oRow of overrideRows) {
    const agentName = oRow.requestedBy === 'engine'
      ? 'engine (circuit-breaker)'
      : agents.find(a => a.id === oRow.requestedBy)?.name ?? oRow.requestedBy;
    issues.push({
      stableId: `override|${oRow.id}`,
      text:
        `OVERRIDE_REQUEST (id=${oRow.id.slice(0, 8)}): ${agentName} wants task "${oRow.taskTitle ?? '?'}" (${oRow.taskId.slice(0, 8)}) forced to "${oRow.requestedStatus}".\n` +
        `  Goal: ${oRow.taskGoal ?? '(no goal recorded)'}\n` +
        `  Justification: ${oRow.justification}\n` +
        (oRow.lastEngineError ? `  Last engine error: ${oRow.lastEngineError}\n` : '') +
        (oRow.attemptsAttached > 1 ? `  Engine-auto-fired after ${oRow.attemptsAttached} hard-gate rejections, the agent was thrashing on shape.\n` : '') +
        `  Approve: work_validate(action="override", override_request_id="${oRow.id}", approve=true, reason="..."). ` +
        `Deny: work_validate(action="override", override_request_id="${oRow.id}", approve=false, reason="...").`,
    });
  }

  // Build a compact summary of active tasks for the LLM to review
  // Only include active tasks -- skip completed/fallen to keep the prompt small
  const taskSummary = activeTasks.map(t => {
    let line = `- [${t.status.toUpperCase()}] "${t.title}" -> ${t.assignedToName ?? 'unassigned'}`;
    if (t.repeatInterval) line += ` (repeats every ${t.repeatInterval} ${t.repeatUnit})`;
    if (t.scheduledStart) {
      const nextRun = t.nextRunAt ? new Date(t.nextRunAt.includes('Z') ? t.nextRunAt : t.nextRunAt + 'Z') : null;
      if (nextRun && nextRun > nowDate) {
        line += ` [next run: ${t.nextRunAt}]`;
      }
    }
    if (t.status === 'blocked') line += ' [BLOCKED]';
    // Include task description so PM can make informed decisions
    if (t.description) {
      const desc = t.description.length > 150 ? t.description.slice(0, 150) + '...' : t.description;
      line += `\n  Instructions: ${desc}`;
    }
    // Remediation 4e: ledger evidence inline, the PM judges from what the
    // agent actually DID (rejects, observations, transitions), not from
    // timestamps plus its own wiped history. Same durable record the agent
    // itself sees via the attempt-ledger context block.
    try {
      const evidence = [
        ...getRecentObservations(t.id, 2),
        ...getRecentTransitions(t.id, 2),
      ].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(-3);
      if (evidence.length > 0) {
        line += `\n  Ledger: ${evidence.map((e) => formatEntryLine(e)).join(' | ').slice(0, 400)}`;
      }
    } catch { /* ledger optional */ }
    return line;
  }).join('\n');

  // Pre-digested issues the engine already detected
  const engineIssues = issues.length > 0
    ? `\nENGINE-DETECTED ISSUES (act on these):\n${issues.map((issue, i) => `${i + 1}. ${issue.text}`).join('\n')}`
    : '';

  const situationReport = `Tracker review -- ${activeTasks.length} active tasks:

${taskSummary}
${engineIssues}

IMPORTANT: Always deliver your findings to ${primaryName} using send_to_agent. Do not just write your analysis in chat -- ${primaryName} cannot see your chat. The ONLY way ${primaryName} receives your report is if you call send_to_agent.

If you spot issues, call send_to_agent to tell ${primaryName}. You can also message agents directly to ask about stalled tasks.
For engine-detected issues, act on them: call send_to_agent to notify ${primaryName} or poke the relevant agent.

DO NOT contact ${primaryName} when:
- Everything looks fine ("all clear" is noise, end silently).
- You investigated an engine flag and concluded it's a false positive (e.g., recurring task waiting for its next fire). End silently; ${primaryName} does not need to hear what you ruled out.
- You have nothing actionable to add beyond what the engine already detected.

Only contact ${primaryName} when there is something they need to do. Keep it brief.`;

  // No engine-detected issues and nothing looks unusual, don't burn tokens
  // for the PM to say "all clear."
  if (issues.length === 0) {
    // AUDIT-FIX: clear the dedup hash on an empty set. Without this, the sequence
    // {A} -> {} -> {A} (the same issue-set recurring after being fully resolved)
    // compared equal to the stale hash and was skipped until a restart.
    lastSituationReportHash = '';
    // TB8 JOB 2: was `logger.debug`, which `logger.ts:21` pins out of existence in
    // production (`setLogLevel` is never called). A skip nobody can read is the silent
    // skip the owner ruled against; this one is benign but it must still be READABLE.
    logger.info('PM review: no issues detected, skipping LLM call');
    return;
  }

  // Stable dedup hash, keyed ONLY on the actionable issue-set (taskId, issueType).
  // This is the engine-level "don't firehose the primary" gate: the PM brain (and
  // therefore any PM→primary send it produces) re-runs ONLY when the set of genuinely
  // actionable issues changes, a new/changed/resolved (task, issue-type). It must NOT
  // re-run on board CHURN: the full `taskSummary` (ledger lines, notes, status text,
  // next_run_at timestamps) shifts constantly, so including it here made every minor
  // tracker change bust the dedup and re-review/re-notify the same board every few
  // minutes (the owner's "PM keeps sending everything" firehose). The stableId strips the
  // "X minutes ago" drift that defeated the older text hash (v2.3.7). A genuinely large
  // report is still fine when the issue-set DID change, this gates frequency/necessity,
  // never length.
  const stableIssuesKey = issues.map(i => i.stableId).sort().join(',');
  const reportHash = stableIssuesKey;
  // SWEEP CORE-2 item 1 — A DOORBELL DEFEATS THE DEDUP, because a doorbell IS the change.
  // The gate compares the issue-SET; a row rung in by its own completion event can have the
  // same stable id it had a minute ago (the id is `task|UNVALIDATED_COMPLETE|revert_count`),
  // and skipping it as "unchanged" is precisely what swallowed the silent turns TB8 measured.
  const carriedDoorbell = issues.some((i) => doorbell.has(i.stableId.split('|')[0]));
  if (reportHash === lastSituationReportHash && !carriedDoorbell) {
    // TB8 JOB 2: promoted from `logger.debug` (structurally invisible in production).
    // THIS is the line that swallowed the two silent validation turns measured in battery
    // `bmsgs7qejup` — it now says how much validation work it is skipping over.
    logger.info('PM review: actionable issue-set unchanged since last review, skipping (no re-notify)', {
      pendingValidation: pendingValidationCount, issues: issues.length,
    });
    return;
  }
  lastSituationReportHash = reportHash;

  const msgId = uuidv4();
  // ── PHASE-2 T8c item 1 — THE PM'S OWN REPORT IS NOT THE OWNER TALKING (T6 §11.4) ──
  //
  // This row used to be `role='user'` with no channel on the OWNER lane. T6 closed the half
  // that mattered structurally (it opened an ask ticket nobody could ever serve or close) but
  // deliberately left the ATTRIBUTION, naming it as T8's PM rekey. The attribution is the
  // half the PM's own turn reads: an owner-lane user row makes `isEngineTurn` false, so
  // `renderCounterpartyHeader` prints "You are responding to <owner> ... your reply goes back
  // to them on dashboard" for a report the ENGINE wrote to itself. The PM's whole job is that
  // it must NOT reply to the owner — it must call send_to_agent — and the header was telling
  // it the opposite every review.
  //
  // The fix is the mechanism this tree already has for exactly this, not a new one:
  // `insertEngineEvent` (lane='events'), the same door `tracker/notify.ts` uses for a task
  // assignment notice. `isEngineTurn` then renders the ENGINE variant, which says in so many
  // words "NOT a person messaging you ... do NOT address the user".
  // requirement preserved: the report still wakes the PM (the wake is `handleMessage`, which
  // ignores its content argument and reads the persisted rows), still lands in the PM's
  // context, and still shows in the dashboard through the same broadcast below.
  insertEngineEventIfAbsent({
    id: msgId, agentId: pmId, content: situationReport,
    sourceAgentId: null, originIntent: 'pm_review', work: null,
  });

  broadcast({
    type: 'chat:message',
    agentId: pmId,
    message: { id: msgId, agentId: pmId, role: 'user' as const, content: situationReport, tokenCount: null, modelId: null, cost: null, latencyMs: null, createdAt: new Date().toISOString() },
  });

  const runtime = getAgentRuntime();
  try {
    await runtime.handleMessage(pmId, situationReport);

    // ── SWEEP-A TB8 JOB 2: DID THE VALIDATOR ACTUALLY RULE? ──────────────────────────────
    // The turn is back. Read the SAME rows again: anything this review handed the
    // validator that still awaits Key 2 is a MISS, and until now a miss was invisible in
    // every sink — no log at the production level, no work event, no counter — while the
    // `stableIssuesKey` gate above silently skipped every later attempt on the unchanged
    // set. Measured shape (battery `bmsgs7qejup`): two PM validation turns in a row
    // returned no verdict on three rows, the owner was told at 5m00s, the verdict landed
    // at 8m38s, and nothing anywhere recorded the two silent turns.
    //
    // Nothing new is invented to fix it. The record rides the EXISTING audit door
    // (`writeTaskLog`), the re-drive is the EXISTING 60 s tick (the dedup hash is released
    // exactly as the catch block below already releases it for a thrown failure, and for
    // the same stated reason), and the escalation surface stays the scheduler's existing
    // 5-minute owner escalation — whose own clock is now the bound this measures against.
    if (askedForKeyTwo.length > 0) {
      const stillAwaiting = idsStillAwaitingKeyTwo(askedForKeyTwo.map((r) => r.id));
      const coverage = validationCoverageAfterReview({
        asked: askedForKeyTwo, stillAwaiting, nowMs: Date.now(),
      });
      if (coverage.missed.length > 0) {
        // LOUD, at the production log level, with the denominator and the ordering fact.
        const line = 'PM validation review returned WITHOUT a verdict on rows it was handed';
        const meta = {
          asked: askedForKeyTwo.length,
          missed: coverage.missed.length,
          longestWaitMs: Math.max(...coverage.missed.map((m) => m.waitedMs)),
          ownerEscalationBoundMs: VALIDATION_COVERAGE_BOUND_MS,
          pastOwnerBound: coverage.missed.filter((m) => m.pastOwnerBound).map((m) => m.id),
        };
        if (coverage.anyPastOwnerBound) logger.warn(line, meta); else logger.info(line, meta);

        // DURABLE, on the row itself, so a census can finally see the thing BATTERY4's
        // `audit` count was reaching for. One entry per missed row per review.
        //
        // SWEEP CORE-2 item 1: this record now has TWO more jobs. It is what releases the
        // owner escalation (`scheduler/runner.ts` will not tell him a row is unvalidated
        // until one of these exists), and its COUNT is what orders the queue so a stubborn
        // row stops leading every review. The marker string is single-sourced in
        // `work/validation-drive.ts` so the writer here and the reader there cannot drift.
        for (const m of coverage.missed) {
          writeTaskLog({
            taskId: m.id,
            fromEntity: 'pm',
            entryKind: 'observation',
            actionTaken: VALIDATION_ATTEMPT_MISS,
            reason:
              `the validation review ran and returned no verdict on this row; ` +
              `awaiting Key 2 for ${Math.round(m.waitedMs / 1000)}s` +
              (m.pastOwnerBound
                ? ` — PAST the ${VALIDATION_ESCALATION_MIN}-minute owner-escalation bound, so the owner has been (or is about to be) told this is unvalidated before its validator ruled`
                : ''),
          });
        }
      }
      // RE-DRIVE: release the dedup so the next tick asks again about the same rows. An
      // unchanged issue-set is exactly what the gate above compares equal, so without this
      // the review that ruled on nothing was also the LAST review those rows ever got.
      if (coverage.reReview) lastSituationReportHash = '';
    }
  } catch (err) {
    logger.error('PM LLM review failed', { error: err instanceof Error ? err.message : String(err) });
    // Engine-guaranteed delivery (remediation Phase 4, 4a): a failed PM
    // review must not swallow engine-detected issues. Pre-fix, the dedup
    // hash was already consumed above, so the SAME issue-set was skipped as
    // "unchanged" on every later cycle and nobody ever heard about it.
    // Reset the hash so the next cycle retries, and deliver the engine's
    // own issue list straight to the primary (system sender: wakes, and is
    // dedup-exempt). The PM's judgment layer is unchanged on the success
    // path; this only guarantees the failure path. ('' never matches a real
    // hash, so the next cycle retries this exact issue-set.)
    lastSituationReportHash = '';
    // comms-audit rank 8: on a PM-LLM failure this used to splice the FULL engine issue
    // list, issues.map(i => i.text), which is engine-internal directive prose written FOR
    // the PM, including literal "POKE THEM: send_to_agent(...)" restart scripts, straight
    // into a [A2A:QUESTION from:system] to the primary, where it reached the model as
    // re-narration bait. The PM retries next cycle (hash reset above) and the issues are
    // already on the tracker board, so the primary only needs a brief heads-up, not the raw
    // engine directives. Post a brief PM awareness note; never forward issue.text.
    postAgentNotice({
      toAgentId: getPrimaryAgentId(),
      fromName: 'PM',
      intent: 'pm_review_failed',
      brief: `My review couldn't run this cycle, ${issues.length} tracker item${issues.length === 1 ? '' : 's'} still need${issues.length === 1 ? 's' : ''} a look (they're on the board). I'll retry next cycle; handle anything urgent directly.`,
    });
  }
}

export async function runPokeCheck(): Promise<void> {
  const db = getDb();

  // ── A2A auto-task sweeper ──
  // Closes stale on_deck tasks that were auto-created by the engine
  // when an agent sent intent=ASSIGN (autoCreateAssignTask in
  // tracker/schema.ts). The receiver was already woken via A2A and
  // typically handles the work in their reply rather than by updating
  // the tracker row, so without this sweep, every A2A assignment that
  // doesn't get an explicit close leaves an on_deck task forever.
  //
  // Conservative criteria, only touches tasks where ALL of:
  //   - a2a_thread_id IS NOT NULL (engine-injected, not user/agent-made)
  //   - status = 'on_deck'  (not in_progress / not yet handled)
  //   - no schedule (scheduled tasks legitimately wait on_deck)
  //   - updated_at older than 30 min  (give the receiver time to act)
  //   - the receiver has SENT a message since the task was created
  //     (proves they were active, they just didn't update the tracker)
  //
  // Marks 'fallen' with an audit note so the row stays queryable but
  // drops off the active kanban. Never touches agent-created or user-
  // created tasks.
  try {
    const STALE_A2A_GRACE_MS = 30 * 60 * 1000;
    const candidates = db.prepare(`
      SELECT t.id AS id, t.title AS title, t.agent_id AS assigned_to,
             ${msToText('t.opened_at')} AS created_at, t.parent_id AS project_id
      FROM work t
      WHERE ${taskScope('t')} AND t.state = 'on_deck'
        AND t.a2a_thread_id IS NOT NULL
        AND (t.scheduled_start IS NULL OR t.schedule_status = 'unscheduled')
        AND t.is_paused = 0
        AND t.updated_at < ?
      LIMIT 50
    `).all(Date.now() - STALE_A2A_GRACE_MS) as Array<{ id: string; title: string; assigned_to: string; created_at: string; project_id: string | null }>;

    if (candidates.length > 0) {
      // Phase B.0: tasks.notes is read-only legacy. Audit trail lives in task_log.
      const closeStmt = {
        run: (id: string) => noteUnsettled(setTrackerStatus(id, 'fallen', {
          by: 'pm', actorId: getPMAgentId(), claim: 'authoritative',
          reason: 'stale A2A assignment: the receiver was active but never moved this ticket',
        }), 'pm: stale A2A assignment swept', { taskId: id }),
      };
      const activeCheck = db.prepare(`
        SELECT 1 FROM messages
        WHERE agent_id = ? AND role = 'assistant' AND created_at > (unixepoch(?) * 1000)
        LIMIT 1
      `);
      let swept = 0;
      const sweptProjects = new Set<string>();
      const { writeTaskLog } = await import('./task-log.js');
      for (const t of candidates) {
        // Only close if the receiver was active (sent any assistant
        // message) after the task was created. If they were silent the
        // whole time, the proper failure path is the in_progress poke
        // chain, leave it for that, don't sweep silently.
        const wasActive = activeCheck.get(t.assigned_to, t.created_at) as { 1: number } | undefined;
        if (!wasActive) continue;
        closeStmt.run(t.id);
        if (t.project_id) sweptProjects.add(t.project_id);
        writeTaskLog({
          taskId: t.id,
          fromEntity: 'engine',
          entryKind: 'auto_sweep',
          fromStatus: 'on_deck',
          toStatus: 'fallen',
          actionTaken: 'A2A auto-task sweeper',
          reason: `A2A-assigned on_deck task untouched for >= 30 min while receiver ("${t.assigned_to}") was otherwise active. Handled via reply not via tracker.`,
        });
        swept++;
      }
      if (swept > 0) {
        logger.info('A2A auto-task sweeper closed stale on_deck rows', {
          swept, candidates: candidates.length,
          sample: candidates.slice(0, 3).map(t => `${t.id.slice(0, 8)}:${t.title.slice(0, 40)}`),
        });
        // D-K: a sweep-to-fallen can be the transition that empties a project of
        // open tasks; run the success-vs-fail-open check so the project gets its
        // needs-attention label + primary notice instead of staying silently
        // active. Idempotent, extra calls are harmless. Dynamic import: tools.ts
        // statically imports this module, a static back-import would cycle.
        const { checkProjectCompletion } = await import('./tools.js');
        for (const projectId of sweptProjects) {
          checkProjectCompletion(projectId, getPMAgentId());
        }
      }
    }
  } catch (err) {
    logger.warn('A2A auto-task sweeper failed (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // ── Engine-level quick checks (still needed for immediate alerts) ──
  const allActiveTasks = listTasks({}).filter(t => !['complete', 'fallen', 'paused'].includes(t.status));

  // 2026-06-02 bug fix: also count tasks that need PM judgment but are not
  // "active" (complete-but-unvalidated, blocked-but-unvalidated, paused-but-
  // unvalidated, pending override requests). Without this, a completed task
  // sits with complete_validated=0 forever because activeTasks is 0, the
  // polled review never fires, and the event-driven debounce is the only
  // path that could wake the PM. Belt-and-suspenders.
  const pendingValidation = (() => {
    try {
      const row = getDb().prepare(`
        SELECT
          (SELECT COUNT(*) FROM work w WHERE ${taskScope('w')} AND w.state = 'done' AND ${validatedExpr('w','done')} = 0 AND ${awaitingUserVerdictExpr('w')} = 0) +
          -- PHASE-2 T8T: the SECOND shape of an unvalidated close. A worker's own close is a
          -- Key-1 REQUEST now (RULING 1), so the row it is about is still claimed - counting
          -- only the done ones would make the queue read empty while work waited in it.
          (SELECT COUNT(*) FROM work w WHERE ${taskScope('w')} AND w.state = 'claimed' AND ${pendingCloseRequestExpr('w')} = 1 AND ${awaitingUserVerdictExpr('w')} = 0) +
          (SELECT COUNT(*) FROM work w WHERE ${taskScope('w')} AND w.state = 'blocked' AND ${validatedExpr('w','blocked')} = 0 AND ${awaitingUserVerdictExpr('w')} = 0) +
          (SELECT COUNT(*) FROM work w WHERE ${taskScope('w')} AND w.state = 'paused' AND ${validatedExpr('w','paused')} = 0) +
          ${PENDING_OVERRIDE_COUNT_SQL}
        AS c
      `).get() as { c: number };
      return row.c;
    } catch {
      return 0;
    }
  })();

  logger.info('PM poke loop tick', { activeTasks: allActiveTasks.length, pendingValidation });

  // Trigger PM review if there's any active or pending-validation work.
  if (allActiveTasks.length > 0 || pendingValidation > 0) {
    runPMReview().catch(err => {
      logger.error('PM review failed', { error: err instanceof Error ? err.message : String(err) });
    });
  }

  // ── Engine-level in_progress poke chain (nudge → urgent → escalate) ──
  const inProgressTasks = allActiveTasks.filter(t => t.status === 'in_progress');
  const now = Date.now();

  for (const task of inProgressTasks) {
    if (!task.assignedTo) continue;

    // P2 drive boundary: the per-priority threshold table IS the grace. The
    // old blanket 30-minute POKE_GRACE_PERIOD_MS silently neutered the
    // ladder's own design (high.first=180s and normal.second=900s could never
    // fire), which is exactly the "in_progress sits ignored" class the owner
    // banned. A just-touched task is protected by the same clock: idle below
    // thresholds.first pokes nothing.
    const taskUpdated = new Date(task.updatedAt.includes('Z') ? task.updatedAt : task.updatedAt + 'Z').getTime();

    // Skip tasks with a future scheduled_start -- they're waiting for the scheduler, not stale
    if (task.scheduledStart) {
      const scheduledMs = new Date(task.scheduledStart.includes('Z') ? task.scheduledStart : task.scheduledStart + 'Z').getTime();
      if (scheduledMs > now) continue;
    }
    // Skip tasks in a waiting schedule state
    if (task.scheduleStatus === 'waiting') continue;

    const thresholds = POKE_THRESHOLDS[task.priority] ?? POKE_THRESHOLDS.normal;

    // ── Idle detection (v2.3.6) ──
    // Use the OLDER of two signals so a busy-but-stalled task can still
    // be detected:
    //   1. Per-task idle (task.updated_at), captures finished-but-not-
    //      closed tasks. The bug we're fixing in v2.3.6: if the agent is
    //      busy on Task B, per-agent idle never triggers and Task A sits
    //      open forever. task.updated_at is reliable as "last assignee-
    //      driven change" because pokes log to poke_log, not the task row.
    //   2. Per-agent idle (last message anywhere), preserves the
    //      original "agent crashed entirely / went silent" coverage.
    //
    // Whichever signal is older drives the idleSeconds. If the agent is
    // active globally but the task hasn't moved, per-task wins → poke.
    // If both are old, both agree → poke.
    const pokeDb = getDb();
    // P2 drive boundary rekey: idle = TASK staleness, full stop. The old
    // min(taskUpdated, agentLastMessageAnywhere) inflated idleness for a
    // fresh task whose agent was merely quiet (false pokes), while the case
    // it existed for (agent busy elsewhere, task stalled) is already covered
    // by task staleness alone. "Is the agent active on THIS task" is the task
    // row's clock, not the agent's chatter.
    const idleSeconds = Math.max(0, Math.floor((now - taskUpdated) / 1000));

    // P2 drive boundary: a poke never fires while the assignee is MID-TURN.
    // A live turn is by definition not idle; poking it produced the false
    // positives the old "STILL WORKING: continue from EXACTLY where you
    // stopped" counter-prompt existed to undo. The rung fires on the next
    // tick after the turn ends if the task still hasn't moved.
    const assigneeStatus = (pokeDb.prepare('SELECT status FROM agents WHERE id = ?')
      .get(task.assignedTo) as { status: string } | undefined)?.status;
    if (assigneeStatus === 'working') continue;

    // The rung this ticket has already reached in the CURRENT escalation cycle, read from the
    // work event log (T8c item 1). Was `poke_log`'s newest row; the query and its meaning are
    // the same, the store is the spine, and the previous cycle's pokes survive a remediation.
    const lastPoke = lastPokeOf(task.id);
    const lastPokeNumber = currentRung(task.id);

    // Determine what poke to send based on idle time and previous pokes
    let pokeType: string | null = null;
    let pokeNumber = 0;

    if (idleSeconds >= thresholds.autoReset && lastPokeNumber < 4) {
      pokeType = 'auto_reset';
      pokeNumber = 4;
    } else if (idleSeconds >= thresholds.escalate && lastPokeNumber < 3) {
      pokeType = 'escalate_primary';
      pokeNumber = 3;
    } else if (idleSeconds >= thresholds.second && lastPokeNumber < 2) {
      pokeType = 'urgent';
      pokeNumber = 2;
    } else if (idleSeconds >= thresholds.first && lastPokeNumber < 1) {
      pokeType = 'nudge';
      pokeNumber = 1;
    }

    if (!pokeType) continue;

    // P2 drive boundary (owner status-truth invariant, 2026-07-21): the
    // deliverable_shown stand-down redirect that lived here was DELETED. A
    // hidden flag contradicting the visible status silenced the one mechanism
    // that restarts stalled work (the yacht-research silent hour). in_progress
    // means the ladder drives, every time; delivered work is protected by the
    // Key-1 state (complete + complete_validated=0, PM-validated) and the
    // retask allow_regenerate gate, not by standing the ladder down.
    const primaryId = getPrimaryAgentId();
    const pmId = getPMAgentId();
    const pmName = getPMAgentName();

    // ── Auto-reset: escalation failed, take direct action ──
    if (pokeType === 'auto_reset') {
      const idleMinutes = Math.floor(idleSeconds / 60);

      // Move task back to on_deck so it can be retried
      noteUnsettled(setTrackerStatus(task.id, 'on_deck', {
        by: 'pm', actorId: getPMAgentId(), claim: 'authoritative',
        reason: `auto-reset: the escalation ladder ran out and the agent stayed idle ${idleMinutes} minutes`,
      }), 'pm: auto-reset after the ladder ran out', { taskId: task.id });

      // If this is a scheduled task, also reset schedule_status so the scheduler retries
      if (task.scheduleStatus === 'running') {
        // Fail the current run and let onTaskRunComplete reset to waiting
        import('../scheduler/runner.js').then(({ onTaskRunComplete }) => {
          onTaskRunComplete(task.id, 'failed', `Auto-failed: agent idle for ${idleMinutes} minutes after full escalation chain`).catch(() => {});
        });
      }

      // Notify primary agent via A2A transport
      const resetMsg = `AUTO-RESET: Task "${task.title}" (${task.id}) was moved back to on_deck after ${idleMinutes} minutes idle. The assigned agent (${task.assignedToName ?? task.assignedTo}) did not respond after 3 pokes and escalation. The task needs to be reassigned or investigated.`;

      // Auto-reset only fires after the full escalation chain has already
      // failed (2 pokes + 1 escalation), by definition something needs the
      // primary's attention NOW. Use ASSIGN so primary actually wakes and
      // reassigns/investigates, not FYI which would let the task sit
      // unassigned until the primary is woken by something else.
      import('../agent/a2a-transport.js').then(({ deliverA2AMessage: deliverReset }) => {
        deliverReset({
          intent: 'ASSIGN',
          threadId: '',
          requiresResponse: true,
          payload: resetMsg,
          toAgent: primaryId,
          fromAgent: pmId,
        }).catch(err => {
          logger.error('PM auto-reset: A2A delivery failed', { error: err instanceof Error ? err.message : String(err) });
        });
      });

      // Auto-reset is the terminal remediation: the full escalation chain
      // failed and the task is going back to on_deck for a fresh attempt.
      // Re-arm the ladder so the on_deck move starts a clean escalation
      // cycle -- if the task is re-pulled and stalls again it re-arms from
      // nudge(1) instead of being stuck above rung 4 forever. This marker is
      // written at a remediation event, never mid-cycle, so the cross-restart
      // poke dedup stays intact. We deliberately do NOT record rung 4 here:
      // persisting it would leave the rung at 4 and defeat the reset. The
      // auto-reset is still recorded via logger.warn + the tracker:poke
      // broadcast below.
      //
      // T8c item 1: a MARKER, not a DELETE — the pokes of the cycle that just
      // failed stay on the record, so "this has stalled twice" is answerable.
      recordRemediation(task.id, getPMAgentId(), `auto-reset after ${idleMinutes} minutes idle`);
      logger.warn('PM auto-reset: task moved to on_deck', { taskId: task.id, title: task.title, idleMinutes, assignedTo: task.assignedTo });

      broadcast({ type: 'tracker:poke', data: { taskId: task.id, agentId: task.assignedTo!, pokeType } });
      continue;
    }

    // ── Delivery-evidence consult (2026-07-22 production incident) ──
    // Before driving the WORK, check the engine's own records: did an
    // answered turn on this task's originating conversation already happen
    // since the task existed? If yes, the honest problem is a missing
    // CLOSE-OUT, not stalled work, and a blind drive re-fires the whole job
    // (the yacht search was fully redone live). Strike 1: the poke becomes an
    // evidence-carrying close steer. Strike 2 (a poke was already sent after
    // the evidence existed and the status still lies): the engine closes the
    // task itself, complete, with the receipt basis recorded, and the normal
    // validation flow takes it from there. Engine-enforced, not nudged: the
    // neutral nudge was tried live and the floor model paused the task.
    const deliveryEvidence = task.status === 'in_progress' ? findDeliveryEvidenceForTask(task.id) : null;
    // Strike 2 requires a TANGIBLE handover on record (artifact or channel
    // delivery), not just an answered reply: the engine only ever closes a
    // task on evidence it can point at. Text-only deliveries keep getting
    // the close steer every rung instead (the model closes; the engine
    // never guesses).
    // `deliveredVia` is a DISTINCT read of `deliveries` inside `findDeliveryEvidenceForTask`
    // (delivery-evidence.ts), so strike 2's tangible-handover test reads the delivery ledger
    // directly — T8c item 1's requirement, verified rather than rebuilt.
    const tangibleHandover = !!deliveryEvidence && (deliveryEvidence.artifacts.length > 0 || deliveryEvidence.deliveredVia.length > 0);
    // The poke's instant is epoch ms now (`work_events.created_at`); the evidence's is the
    // `turns` table's TEXT instant. Compare as numbers, never as strings of different shapes.
    const evidenceAtMs = deliveryEvidence
      ? Date.parse(/[TZ]/.test(deliveryEvidence.answeredAt) ? deliveryEvidence.answeredAt : `${deliveryEvidence.answeredAt}Z`)
      : NaN;
    if (deliveryEvidence && tangibleHandover && lastPoke && !Number.isNaN(evidenceAtMs)
        && lastPoke.sentAtMs >= evidenceAtMs) {
      const db = getDb();
      const basis = `engine close on delivery receipt: ${renderDeliveryEvidence(deliveryEvidence)}; a close steer was already sent (${new Date(lastPoke.sentAtMs).toISOString().replace('T', ' ').slice(0, 19)} UTC) and the status still said in_progress`;
      // Strike 2 closes on a delivery RECEIPT, so the receipt is what G7 is handed.
      const strike2Delivery = deliveryForTaskClose(task.id);
      const s2 = setTrackerStatus(task.id, 'complete', {
        by: strike2Delivery ? 'engine' : 'pm', actorId: 'engine',
        evidenceRef: strike2Delivery, resultDeliveryId: strike2Delivery,
        expectedState: 'claimed', reason: basis,
      });
      if (s2.kind !== 'applied') {
        logger.warn('strike-2 engine close refused by the work gate', { taskId: task.id, result: s2 });
      } else {
        const cur = db.prepare('SELECT result FROM work WHERE id = ?').get(task.id) as { result: string | null } | undefined;
        if (!cur?.result) noteUnsettled(patchWork(task.id, { result: `Delivered (engine-recorded): ${renderDeliveryEvidence(deliveryEvidence)}` }), 'pm: delivery evidence recorded on the poke sweep', { taskId: task.id });
      }
      void import('./task-log.js').then(({ writeTaskLog }) => writeTaskLog({
        taskId: task.id,
        fromEntity: 'engine',
        entryKind: 'observation',
        fromStatus: 'in_progress',
        toStatus: 'complete',
        actionTaken: 'delivery-receipt close (strike 2)',
        reason: basis,
      }));
      recordRemediation(task.id, 'engine', 'strike-2 engine close on delivery receipt');
      logger.warn('PM drive: delivered-but-unclosed task engine-closed on receipt basis (strike 2)', {
        taskId: task.id, title: task.title, turnNumber: deliveryEvidence.turnNumber,
      });
      broadcast({ type: 'tracker:poke', data: { taskId: task.id, agentId: task.assignedTo!, pokeType: 'receipt_close' } });
      continue;
    }

    // ── Normal poke (nudge / urgent / escalate) ──
    const pokeMessage = deliveryEvidence && tangibleHandover
      ? `CLOSE-OUT NEEDED, NOT RE-WORK: task "${task.title}" (${task.id}) still says in_progress, but the engine's own records show ${renderDeliveryEvidence(deliveryEvidence)}. ` +
        `If that delivery completed this task, call work_update(action="status", task_id="${task.id}", status="complete") with the result NOW. ` +
        `Do NOT redo the work, do NOT pause the task, and do NOT re-deliver what the user already has. ` +
        `Only if the delivery did NOT actually finish the task should you continue working it (and say what remains).`
      : buildPokeMessage(task, pokeType, pokeNumber, idleSeconds);
    const recipient = pokeType === 'escalate_primary' ? primaryId : task.assignedTo;

    // Busy deferral (owner request 2026-07-23): a poke landing while the
    // assignee is mid-run queues up and then collides with that work, and to
    // the ladder the deferred serve reads like being ignored. If the assignee
    // is busy RIGHT NOW, skip this tick entirely: no poke, no strike; the next
    // sweep pokes when they are free. The owner's ruling: pokes are fine "as
    // long as the agent doesn't go crazy because of it".
    if (recipient && pmActiveRuns.has(recipient)) {
      logger.info('PM poke deferred: assignee is mid-run; no poke, no strike this tick', {
        taskId: task.id, recipient, pokeType,
      });
      continue;
    }

    // Deliver poke via A2A transport. Pokes use QUESTION intent (we want
    // a response) with a thread seeded by task ID + poke stage so each
    // escalation level gets its own thread and hop counter.
    import('../agent/a2a-transport.js').then(({ deliverA2AMessage, makeThreadId }) => {
      const pokeThreadId = makeThreadId(`poke-${task.id}-${pokeType}`);
      deliverA2AMessage({
        intent: pokeType === 'escalate_primary' ? 'ASSIGN' : 'QUESTION',
        threadId: pokeThreadId,
        requiresResponse: true, // All pokes expect a response, even escalations to primary
        payload: pokeMessage,
        toAgent: recipient,
        fromAgent: pmId,
      }).catch(err => {
        logger.error('PM poke: A2A delivery failed', {
          recipient,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }); // close .then()

    // Record the poke on the work's own event log, then tell the dashboard. The broadcast
    // used to ride inside `logPoke`; it stays a UI concern at the call site because `work/`
    // does not import the websocket gateway.
    // requirement preserved: the dashboard still receives `tracker:poke` on every poke.
    recordPoke(task.id, pmId, pokeNumber, pokeType, recipient ?? task.assignedTo);
    broadcast({ type: 'tracker:poke', data: { taskId: task.id, agentId: task.assignedTo, pokeType } });

    logger.info('PM poke sent via A2A transport', {
      taskId: task.id,
      taskTitle: task.title,
      recipient,
      pokeType,
      pokeNumber,
      idleSeconds,
    });
  }
}

function buildPokeMessage(
  task: ReturnType<typeof getTask> & object,
  pokeType: string,
  pokeNumber: number,
  idleSeconds: number,
): string {
  if (!task) return '';

  const idleMinutes = Math.floor(idleSeconds / 60);
  // Ticket stamps (2026-07-22): every poke carries the engine's observed
  // state + live step facts, so a drive can never read as "start over."
  let stampLine = '';
  try {
    const st = getDb().prepare(
      `SELECT w.id AS id, ${stampColumns('w')},
              w.step_number AS step_number, w.total_steps AS total_steps,
              w.parent_id AS project_id
         FROM work w WHERE w.id = ?`,
    ).get(task.id) as TaskStampFields | undefined;
    if (st) {
      const steps = renderStepFacts(st);
      stampLine = `Engine state: ${renderTaskStamps(st)}${steps ? ` | ${steps}` : ''}`;
    }
  } catch { /* best effort */ }
  const taskInfo = [
    `Task: ${task.title}`,
    `ID: ${task.id}`,
    ...(stampLine ? [stampLine] : []),
    `Priority: ${task.priority}`,
    `Status: ${task.status}`,
    task.description ? `Description: ${task.description}` : null,
    task.projectId ? `Project: ${task.projectId}` : null,
    task.stepNumber !== null ? `Step: ${task.stepNumber}${task.totalSteps ? ` of ${task.totalSteps}` : ''}` : null,
    task.notes ? `\nLatest notes:\n${task.notes.split('\n').slice(-3).join('\n')}` : null,
  ].filter(Boolean).join('\n');

  switch (pokeType) {
    case 'nudge':
      return `Checking in, task "${task.title}" has been idle for ${idleMinutes} minutes.\n\n${taskInfo}\n\nIf you've finished this work, call work_update(action="status") with task_id="${task.id}" and status="complete" with notes on what you did.\nIf still working, no action needed.\nIf blocked, call work_update(action="status") with status="blocked" and explain why.`;

    case 'urgent':
      return `URGENT: Task "${task.title}" has been idle for ${idleMinutes} minutes. This is poke #${pokeNumber}.\n\n${taskInfo}\n\nYou MUST do one of:\n1. Call work_update(action="status", task_id="${task.id}", status="complete", notes="...") if the work is done\n2. Call work_update(action="status", task_id="${task.id}", status="blocked", notes="...") if you're stuck\n3. Continue working on the task`;

    case 'escalate_primary':
      return `ESCALATION: Task "${task.title}" (${task.id}) assigned to ${task.assignedTo} has been idle for ${idleMinutes} minutes with no response after 2 pokes.\n\n${taskInfo}\n\nPlease intervene:\n- Call work_update(action="status", task_id="${task.id}", status="complete") if the work was already done\n- Reassign or unblock the task\n- Or cancel/fail it if it's no longer needed`;

    default:
      return `Poke #${pokeNumber} for task: ${task.title} (idle ${idleMinutes}m)\n\n${taskInfo}\n\nCall work_update(action="status", task_id="${task.id}", status="complete") if done.`;
  }
}

// ── Dependency Checker ──

export function checkDependencies(completedTaskId: string): void {
  const db = getDb();

  // Find tasks that depend on the completed task
  const dependentTasks = db.prepare(`
    SELECT w.id AS id, w.title AS title, ${STATE_TO_STATUS_SQL('w.state')} AS status,
           w.agent_id AS assigned_to, w.depends_on AS depends_on
    FROM work w
    WHERE ${taskScope('w')} AND w.state IN ('on_deck', 'blocked')
      AND w.depends_on LIKE ?
  `).all(`%${completedTaskId}%`) as Array<{
    id: string;
    title: string;
    status: string;
    assigned_to: string | null;
    depends_on: string;
  }>;

  for (const row of dependentTasks) {
    let dependsOn: string[];
    try {
      dependsOn = JSON.parse(row.depends_on) as string[];
    } catch {
      continue;
    }

    // Check if this task actually depends on the completed task
    if (!dependsOn.includes(completedTaskId)) continue;

    // Check if ALL dependencies are now complete
    const allDepsComplete = dependsOn.every(depId => {
      const depTask = db.prepare(`SELECT ${STATE_TO_STATUS_SQL('state')} AS status FROM work WHERE id = ?`).get(depId) as { status: string } | undefined;
      return depTask?.status === 'complete';
    });

    if (allDepsComplete) {
      // Unblock the task. v2.8.x rule: tasks without a future schedule
      // land in 'in_progress' so they stay visible. 'on_deck' is reserved
      // for scheduled-for-later. A previously-blocked task whose deps just
      // cleared is ready to be worked on now, not parked.
      noteUnsettled(setTrackerStatus(row.id, 'in_progress', {
        by: 'pm', actorId: getPMAgentId(),
        reason: `every dependency of this task is complete (last: ${completedTaskId.slice(0, 8)})`,
      }), 'pm: dependencies cleared, task unblocked', { taskId: row.id });

      logger.info('Task unblocked by dependency completion', {
        taskId: row.id,
        taskTitle: row.title,
        completedDep: completedTaskId,
      });

      // Notify primary agent or the assigned agent
      const recipient = row.assigned_to ?? getPrimaryAgentId();
      const task = getTask(row.id);

      if (task) {
        const message = `Task "${task.title}" (${task.id}) is now unblocked. All dependencies are complete.\n\n` +
          `Priority: ${task.priority}\n` +
          (task.description ? `Description: ${task.description}\n` : '') +
          `Previously blocked on: ${dependsOn.join(', ')}`;

        sendAgentMessage(getPMAgentId(), recipient, 'status', message, {
          taskId: task.id,
          event: 'unblocked',
          completedDependency: completedTaskId,
        });
      }
    }
  }
}
