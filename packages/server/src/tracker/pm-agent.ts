import { v4 as uuidv4 } from 'uuid';
import { validationMeasureLines, reviewLedgerRoomTokens } from './job-loop-facts.js';
import { primaryReady } from '../agent/primary-ready.js';
import { proofLines } from '../work/done/proof.js';
import { latestHandIn, workerOf } from '../work/done/record.js';
import {
  decidedBy, holdingQuestions, questionsHoldUntil, requestOf, sendBacks, REVIEW_MISS_ENTRY, QUEUED_TURN_BOUND_MS,
} from '../work/done/who-decides.js';
import { LADDER_ENTRY, pmCanRun } from '../work/done/ladder.js';
import { appendAuditEntry } from '../work/audit-trail.js';
import { heldDeliveryLine } from './owed-delivery.js';
import { getDb } from '../db/connection.js';
import { writeAgentStatus } from '../agent/agent-status.js';
import { taskScope, holdWordsSql, heldByOwnerSql, msToUtcText } from '../work/tracker-view.js';
import { agentActivity } from './liveness.js';
import { planStepLineOf } from '../work/plan-store.js';
import { ownerWordsLines, projectOf, workFile } from '../work/project-file.js';
import { listTaskLog } from './task-log.js';
import { workingExpr } from '../work/terminal-states.js';
import { createLogger } from '../logger.js';
import { getAgentRuntime } from '../agent/runtime.js';
import { insertEngineEventIfAbsent } from '../memory/message-store.js';
import { contextWindowPolicy } from '../memory/budget.js';
import { agentTurnWindow } from '../router/router-window.js';
import { serviceAgentModelId } from '../agent/main-model-floor.js';
import { getPrimaryAgentId, getPMAgentId, getPMAgentName, isSetupCompleted } from '../config/platform.js';
import { workOperation, type WorkOp } from '../tools/work-verbs.js';


const logger = createLogger('pm-agent');

// The PM is a narrow-purpose oversight agent: read-only file access so close-out validation confirms the real
// deliverable (still bounded by the engine's global read-deny), and no file_write, exec, network or
// agent-spawning. The one source for the create and reactivate paths below.
const PM_PERMISSIONS_JSON = JSON.stringify({
  file_read: '*',
  file_write: 'none',
  exec_allow: [],
  exec_deny: ['*'],
  network_domains: 'none',
  can_spawn_agents: false,
  can_assign_permissions: false,
});

// PM tool policy: the PM is an OVERSEER, not a worker. It validates, overrides and retasks; it never edits task
// CONTENT, flips a worker's status or REASSIGNS. The authority is a list of OPERATIONS, not tool names, because
// `work_update` carries status, complete_step and edit as well as list; the advertised name list is derived from it.
// Exported and re-checked at the executor chokepoint (`agent/tools/index.ts`): the surface strip is only advice,
// so any operation outside the set is rejected there.
export const PM_ALLOWED_WORK_OPS: readonly WorkOp[] = [
  'work_update:list', 'work_update:get',        // read-only inspection
  // The third read: judging whether work was done needs the board's history, not only its state.
  'work_update:activity',
  'work_note',                                   // leave a note on a task
  'work_schedule:pause', 'work_schedule:resume',
  'work_validate:decide', 'work_validate:open_proof', 'work_validate:retask',
  'work_update:hand_in',                         // a task the PM itself works; the main agent decides it
  // `work_update:reassign` is deliberately absent: the PM never reassigns (`work/row-authority.ts` `checkMove`
  // also refuses the PM by identity). The edit op is in the set, so the executor gate lets the PM edit a task
  // (title and other fields).
  'work_update:edit',
];

const PM_ALLOWED_WORK_OPS_SET: ReadonlySet<string> = new Set<string>(PM_ALLOWED_WORK_OPS);

/** Operations only the PM and the main agent may perform, whichever verb carries them. Deciding is not one of them: the
 *  decision door itself says who decides (`work/done/who-decides.ts`). */
export const PM_ONLY_WORK_OPS: ReadonlySet<string> = new Set<string>(['work_validate:retask']);

const PM_ALLOWED_OTHER_TOOLS: readonly string[] = [
  'send_to_agent', 'broadcast_to_group', 'list_agents', 'list_groups',
  // The PM's own prompt names `vault_get`, so the gate must allow it (read-only).
  'vault_search', 'vault_get', 'vault_remember', 'history_search', 'history_get',
  'load_tool_docs', 'get_current_time', 'tool_result_read', 'continue_repeating',
  // Read-only artifact verification for close-out validation: confirm the deliverable, never write or exec.
  'file_read', 'file_list',
];

// The ADVERTISED surface (tools_policy.allow) can only name verbs, so a verb appears as soon as ANY of its
// operations is allowed; the executor gate enforces which operation (the surface is advice, the engine enforces).
export const PM_ALLOWED_TOOLS: readonly string[] = [
  ...new Set(PM_ALLOWED_WORK_OPS.map((op) => op.split(':')[0])),
  ...PM_ALLOWED_OTHER_TOOLS,
];

/** The executor gate's real check: a work verb needs `args`, since the operation, not the name, decides. */
export function pmMayCall(name: string, args?: Record<string, unknown>): boolean {
  const op = workOperation(name, args);
  if (op !== null) return PM_ALLOWED_WORK_OPS_SET.has(op);
  return PM_ALLOWED_OTHER_TOOLS.includes(name);
}


export function ensurePMAgentRunning(): void {
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
  if (!primaryReady('PM agent', primaryId, () => ensurePMAgentRunning())) return;

  const pm = db.prepare('SELECT id, status FROM agents WHERE id = ?').get(pmId) as { id: string; status: string } | undefined;

  if (pm && pm.status !== 'terminated') {
    logger.info('PM agent already running', { status: pm.status });
    // A running PM's `tools_policy` and `permissions` are never rewritten at boot, so an owner edit cannot
    // silently revert. The wall is `mayUseChannel` at the door (a non-primary sensei has `channels.master = null`),
    // with grants seeded once by `agent/access/materialize.ts`. The create and reactivate paths below mint a row.
    // No PM-SOUL system message is synced here: the soul file is the one store the runtime and the card read.
    return;
  }

  const modelId = serviceAgentModelId('pm_agent_model', primaryId);   // never a model under the floor

  if (pm) {
    const reactivatePermissions = PM_PERMISSIONS_JSON;
    const reactivateToolsPolicy = JSON.stringify({ allow: [...PM_ALLOWED_TOOLS] });
    // Identity columns here; STATUS through the ONE writer (`agent/agent-status.ts`), both in ONE transaction.
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
    const pmPermissions = PM_PERMISSIONS_JSON;
    const pmToolsPolicy = JSON.stringify({ allow: [...PM_ALLOWED_TOOLS] });
    // The PM is platform machinery, not a person's agent.
    db.prepare(`
      INSERT INTO agents (id, name, model_id, system_prompt_path, status, config, created_by, created_by_kind,
                          parent_agent, spawn_depth, agent_type, classification, max_runtime, timeout_at,
                          permissions, tools_policy, task_id, created_at, updated_at)
      VALUES (?, ?, ?, NULL, 'idle', '{"shareUserProfile":true}', ?, 'agent',
              ?, 1, 'persistent', 'sensei', NULL, NULL,
              ?, ?, NULL, datetime('now'), datetime('now'))
    `).run(pmId, pmName, modelId, primaryId, primaryId, pmPermissions, pmToolsPolicy);

    // No seed system row: it is not the PM's identity (the soul file is) and no model can see one.
    logger.info('PM agent created', { pmId, pmName });
  }
}

// The PM's review: one pass over the hand-ins waiting for its decision, plus the stalls the ladder marked.

const REVIEW_DEBOUNCE_MS = 10_000;
let reviewTimer: ReturnType<typeof setTimeout> | null = null;
let reviewing = false;
let rungWhileReviewing = false;
let reviewStartedAt = 0;
const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The PM's one wake: a hand-in or a ladder mark arms it, and a burst of them becomes one review. */
export function armDebouncedReview(taskId: string, why: string): void {
  if (reviewTimer) return;
  logger.info('PM review armed', { taskId, why, debounceMs: REVIEW_DEBOUNCE_MS });
  reviewTimer = setTimeout(() => {
    reviewTimer = null;
    runPMReview().catch((err: unknown) => logger.error('PM review failed', { error: errText(err) }));
  }, REVIEW_DEBOUNCE_MS);
}

function waitingForPM(pmId: string): string[] {
  return decidedBy(pmId).filter((id) => questionsHoldUntil(id) <= Date.now()).slice(0, 10);
}

function markedStalls(pmId: string): string[] {
  return (getDb().prepare(
    `SELECT w.id FROM work w WHERE ${taskScope('w')} AND ${workingExpr('w', true)} AND NOT ${heldByOwnerSql('w')} AND EXISTS (SELECT 1 FROM work_events e
       WHERE e.work_id = w.id AND e.kind = 'audit' AND json_extract(e.payload, '$.entry_kind') = ?
         AND e.created_at >= COALESCE((SELECT MAX(m.created_at) FROM messages m WHERE m.agent_id = ? AND m.origin_intent = 'pm_review'), 0))
     ORDER BY w.updated_at LIMIT 10`,
  ).all(LADDER_ENTRY.pm, pmId) as Array<{ id: string }>).map((r) => r.id);
}

/** One waiting hand-in: goal, outcome, the proof by index and kind, the worker's note, the send-backs so far. */
function handInBlock(id: string, n: number, roomTokens: number): string {
  const w = getDb().prepare('SELECT title, goal FROM work WHERE id = ?').get(id) as { title: string | null; goal: string | null };
  const h = latestHandIn(id);
  const items = h?.items ?? [];
  const backs = sendBacks(id), asked = requestOf(id);
  return `${n}. HANDED IN: "${w.title ?? id}" [${id}] by ${h?.filedBy ?? workerOf(id)}, as ${h?.outcome === 'cant_be_done' ? "can't be done" : 'finished'}`
    + `${h?.scope === 'run' ? ' (one run of a recurring task; the schedule goes on whatever you decide)' : ''}.\n  Goal: ${w.goal ?? '(none recorded)'}\n  Note: ${h?.note ?? '(none)'}\n`
    + (items.length > 0 ? `  Proof (open each item before approving):\n${proofLines(items).map((l, i) => `    ${i}. ${l}`).join('\n')}` : '  Proof: none.')
    + `\n  Sent back so far: ${backs.length === 0 ? 'never' : backs.map((b) => `"${b.reason}"`).join('; ')}`
    + (asked ? `\n  The request this was opened for: ${asked.id ? `answered to ${asked.who ?? 'its sender'} at ${asked.at} UTC (delivery ${asked.id})` : 'not answered'}` : '')
    + `${validationMeasureLines(id, roomTokens)}${heldDeliveryLine(id)}${ownerWordsLines(id)}${taskLines(id)}`;
}

/** The plan step a task is on and the last instruction it was given. */
function taskLines(id: string): string {
  const step = planStepLineOf(id);
  const directive = listTaskLog(id, { limit: 1, kinds: ['directive'] })[0]?.reason;
  return `${step ? `\n  This step: ${step}` : ''}${directive ? `\n  Last instruction given: ${directive}` : ''}`;
}

/** One stall the ladder marked: the hint did not move it, so the PM may give the worker one directive. */
function stallBlock(id: string, n: number): string {
  const w = getDb().prepare(`SELECT w.title, ${holdWordsSql('w')} AS hold FROM work w WHERE w.id = ?`).get(id) as { title: string | null; hold: string };
  const refused = (getDb().prepare(
    `SELECT payload FROM work_events WHERE work_id = ? AND kind = 'hand_in_refused'
       AND id > COALESCE((SELECT MAX(h.id) FROM work_events h WHERE h.work_id = ? AND h.kind IN ('handed_in', 'decided')), 0) ORDER BY id`,
  ).all(id, id) as Array<{ payload: string }>).map((r) => (JSON.parse(r.payload) as { reasons?: string[] }).reasons?.join(' ') ?? '');
  const act = agentActivity(workerOf(id));
  return `${n}. STALLED: "${w.title ?? id}" [${id}], worked by ${workerOf(id)}, has made no progress past its patience bound since the engine's hint.`
    + `${w.hold ? ` It is held: ${w.hold}.` : ''}`
    + `\n  Its worker was last seen: ${act.lastWhat}${act.lastAt ? ` at ${msToUtcText(act.lastAt)}` : ''}.`
    + (refused.length > 0 ? `\n  Its refused hand-ins:\n${refused.map((r, i) => `    ${i + 1}. ${r}`).join('\n')}` : '')
    + taskLines(id);
}

/** One review miss on each row this review held that is still waiting on the same hand-in, unless it asked about it. */
function recordMisses(pmId: string, held: ReadonlyMap<string, number>, why: string): void {
  for (const [id, handInId] of held) {
    if (latestHandIn(id)?.eventId !== handInId || holdingQuestions(id).some((q) => q.at >= reviewStartedAt)) continue;
    const still = getDb().prepare("SELECT 1 FROM work WHERE id = ? AND state = 'handed_in'").get(id);
    if (still) appendAuditEntry(id, pmId, { entryKind: REVIEW_MISS_ENTRY, reason: why });
  }
}

/** One PM review: wake the PM once with the waiting hand-ins and marked stalls (up to ten each); once its turn
 *  has ended (or never ran), each held hand-in still undecided records a miss. */
export async function runPMReview(): Promise<void> {
  if (reviewing) { rungWhileReviewing = true; return; }
  reviewing = true;
  const pmId = getPMAgentId();
  reviewStartedAt = Math.floor(Date.now() / 1000) * 1000;   // receipts are stamped to the second
  let held = new Map<string, number>();
  try {
    const waiting = waitingForPM(pmId), stalled = markedStalls(pmId);
    held = new Map(waiting.map((id) => [id, latestHandIn(id)?.eventId ?? 0] as const));
    if (waiting.length + stalled.length === 0) return;
    const pm = getDb().prepare('SELECT model_id FROM agents WHERE id = ?').get(pmId) as { model_id: string | null } | undefined;
    if (!pmCanRun() || !pm?.model_id) { recordMisses(pmId, held, 'the project manager could not run its review'); return; }
    // One file per project (or per task with none), each in its own room beside the blocks.
    const subjects = [...new Set([...waiting, ...stalled].map((id) => projectOf(id)?.id ?? id))];
    const policy = contextWindowPolicy(agentTurnWindow(pmId, pm.model_id), { toolPayloadTokens: 0 });
    const budget = policy.assemblyBudgetTokens;
    const room = reviewLedgerRoomTokens(budget, waiting.length + stalled.length + subjects.length);
    const files = subjects.map((id) => workFile(id, room)).filter((f) => f.length > 0);
    const blocks = [
      ...waiting.map((id, i) => handInBlock(id, i + 1, room)),
      ...stalled.map((id, i) => stallBlock(id, waiting.length + i + 1)),
      ...(files.length > 0 ? [`The files of this work:${files.join('\n')}`] : []),
    ];
    const report = `Tracker review -- ${waiting.length} hand-in(s) wait for your decision, ${stalled.length} stalled task(s).\n\n${blocks.join('\n\n')}\n\n`
      + '[Engine hint: for each HANDED IN row, open its proof with work_validate(action="open_proof", task_id, item=N), then work_validate(action="decide", task_id, '
      + 'verdict="approve", reason="<one line: how the proof meets the goal>"), or verdict="send_back" with the reason naming what is missing. A measured task is met when its '
      + 'measure reads 0 or the named remainder holds; a task whose job is a decision is met by the owner\'s recorded words above, never by the worker quoting him. '
      + 'A row you do not decide stays waiting and goes to the next decider. For each STALLED row: work_validate(action="retask", task_id, '
      + 'directive="<the next concrete step>") if it can go on; no move means its work has stopped. Never poke, never reassign, never send_to_agent(intent="ASSIGN").]';
    const msgId = uuidv4();
    insertEngineEventIfAbsent({ id: msgId, agentId: pmId, content: report, sourceAgentId: null, originIntent: 'pm_review', work: null });
    const runtime = getAgentRuntime();
    const asked = await runtime.handleMessage(pmId, report);
    let bound: ReturnType<typeof setTimeout> | undefined;
    const turn = asked !== 'queued' ? asked : await Promise.race([
      runtime.whenQueuedRunEnds?.(pmId) ?? Promise.resolve('not-run' as const),
      new Promise<'not-run'>((resolve) => { bound = setTimeout(() => resolve('not-run'), QUEUED_TURN_BOUND_MS); }),
    ]).finally(() => clearTimeout(bound));
    recordMisses(pmId, held, turn === 'ran' ? 'the review ran and gave no verdict on this hand-in' : 'the review\'s turn never ran');
  } catch (err) {
    logger.error('PM review failed', { error: errText(err) });
    recordMisses(pmId, held, 'the review failed before a verdict');
  } finally {
    reviewing = false;
    if (rungWhileReviewing) {
      rungWhileReviewing = false;
      void runPMReview().catch((err: unknown) => logger.error('PM review failed', { error: errText(err) }));
    }
  }
}
