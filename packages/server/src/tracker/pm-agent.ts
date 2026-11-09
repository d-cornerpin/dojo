import { v4 as uuidv4 } from 'uuid';
import { validationMeasureLines, reviewLedgerRoomTokens } from './job-loop-facts.js';
import { primaryReady } from '../agent/primary-ready.js';
import { proofLines } from '../work/done/proof.js';
import { latestHandIn, workerOf } from '../work/done/record.js';
import { whoDecides, sendBacks, REVIEW_MISS_ENTRY } from '../work/done/who-decides.js';
import { LADDER_ENTRY } from '../work/done/ladder.js';
import { appendAuditEntry } from '../work/audit-trail.js';
import { heldDeliveryLine } from './owed-delivery.js';
import { readLaterMessages } from '../memory/task-list-words.js';
import { getDb } from '../db/connection.js';
// SWEEP CORE-2 item 2: the PM's one status write goes through the ONE writer.
import { writeAgentStatus } from '../agent/agent-status.js';
import { taskScope, holdWordsSql, heldByOwnerSql } from '../work/tracker-view.js';
import { workingExpr } from '../work/terminal-states.js';
import { createLogger } from '../logger.js';
import { broadcast } from '../gateway/ws.js';
import { getAgentRuntime } from '../agent/runtime.js';
import { deleteAgentDebrisBefore, insertEngineEventIfAbsent } from '../memory/message-store.js';
import { freshTailHorizon } from '../memory/tail-horizon.js';
import { contextWindowPolicy } from '../memory/budget.js';
import { agentTurnWindow } from '../router/router-window.js';
import { getPrimaryAgentId, getPMAgentId, getPMAgentName, isSetupCompleted } from '../config/platform.js';
import { workOperation, type WorkOp } from '../tools/work-verbs.js';


const OWNER_WORDS_EXCERPT_CHARS = 400;   // a display excerpt; history_get returns the whole message

/** The owner's later words the engine recorded against this task: what a decision-type close is judged on. */
function ownerWordsLines(taskId: string): string {
  const laters = readLaterMessages(taskId);
  if (laters.length === 0) return '\n  Owner words recorded on this task: none';
  const shown = laters.map((m) => {
    const id = (m.messageId ?? '').slice(0, 8);
    if (m.words === null) return `    message ${id}: no longer stored`;
    const flat = m.words.replace(/\s+/g, ' ').trim();
    const cut = flat.length > OWNER_WORDS_EXCERPT_CHARS ? `${flat.slice(0, OWNER_WORDS_EXCERPT_CHARS)}… (history_get(id="${m.messageId}") returns it whole)` : flat;
    return `    message ${id}: "${cut}"`;
  });
  return `\n  Owner words recorded on this task (sent while it was open; the turn that answered them touched it):\n${shown.join('\n')}`;
}

const logger = createLogger('pm-agent');

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
// RC-16: the PM is an OVERSEER, not a worker. It validates, overrides and retasks;
// it never edits task CONTENT, flips a worker's status, or REASSIGNS (owner ruling 2026-10-02).
// The worker verbs (work_update(action="status"), work_update(action="complete_step"),
// work_update(action="edit")) are intentionally ABSENT so a stale copy sitting in the PM's
// long-lived context can't silently rewrite a task's description or re-close
// already-closed work (P-1 / F-15). work_validate(action="retask") is the PM's corrective verb; the read-only / utility tools below are what the PM
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
  // T60: the third read. The PM judges whether work was done; "what moved on this board
  // over a window" is inspection of exactly the kind the two above already grant, and
  // withholding it would leave the validator reading state with no history behind it.
  'work_update:activity',
  'work_note',                                   // leave a note on a task
  'work_schedule:pause', 'work_schedule:resume',
  'work_validate:decide', 'work_validate:open_proof', 'work_validate:retask',
  'work_update:hand_in',                         // a task the PM itself works; the main agent decides it
  // ⛔ `work_update:reassign` WAS HERE. OWNER RULING 2026-10-02: "Their job is not to reassign a
  // task because they don't feel it is getting worked on fast enough. At no point during the
  // construction of the dojo did I ever ask for the PM agent to simply reassign tasks to another
  // agent." Re-ruled for v3.4 (dec 1): NEVER. `work/row-authority.ts:checkMove` also refuses the
  // PM by identity. `the-pm-waits-for-the-model-it-assigned.test.ts` §2 censuses this list.
  // The edit ops are REQUIRED by the engine's scaffold rename handoff
  // (loop.ts dispatchPMRenameHandoff explicitly instructs the PM to call it).
  // Omitting them (2026-07-17 battery, untracked-multistep-floor red) made the
  // executor gate refuse the rename; the PM's local model then compensated by
  // rewriting the PROJECT description (which used to strip the engine marker, before T8c
  // made that fact a `root_kind` column no edit can reach) and
  // FYI-ing the primary to do the task rename for it.
  'work_update:edit',
];

const PM_ALLOWED_WORK_OPS_SET: ReadonlySet<string> = new Set<string>(PM_ALLOWED_WORK_OPS);

/** Operations only the PM may perform, whichever verb carries them. Deciding is not one of them: the
 *  decision door itself says who decides (`work/done/who-decides.ts`). */
export const PM_ONLY_WORK_OPS: ReadonlySet<string> = new Set<string>(['work_validate:retask']);

// Non-work tools the PM may call. Plain names: these tools were not collapsed.
const PM_ALLOWED_OTHER_TOOLS: readonly string[] = [
  'send_to_agent', 'broadcast_to_group', 'list_agents', 'list_groups',
  // UX-REPAIR round 2 T11: `vault_get` was named by the PM's own prompt (`PM-SOUL.md:66`) and
  // refused by this gate — the prompt described a door that did not exist. Read-only, and the
  // alignment is to the prompt: no prompt text changed (it is the PM's prefix; cache tenet).
  'vault_search', 'vault_get', 'vault_remember', 'history_search', 'history_get',
  'load_tool_docs', 'get_current_time', 'tool_result_read',
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

// ── Ensure PM Agent Running ──

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
    // ⟨RETIRED — UX-ACCESS A1, owner ruling 3⟩ The per-boot rewrite of this
    // agent's `tools_policy` + `permissions` stood here. Census C8: it was one of
    // four sites that overwrote a live row on EVERY restart, which meant an owner
    // edit to this agent was silently reverted — the exact defect ruling 3 names
    // ("the boot rewriter retires so edits stop silently reverting").
    //
    // WHAT STILL HOLDS THE INVARIANT IT WAS PROTECTING. The frozen deny/allow list
    // was never the real wall: a sensei that is not the primary now carries
    // `channels.master = null` and no channel grant at all, so every tool on the
    // build-checked `SEND_TO_PEOPLE` surface is refused AT THE DOOR by
    // `mayUseChannel` — including one added after this boot, which a frozen list
    // of names could never have covered. The declared grants are seeded once, from
    // this row's own values, by `agent/access/materialize.ts`.
    //
    // The CREATE and REACTIVATE paths below still write the policy: those mint a
    // row rather than overwrite a live one, so they revert nobody.
    // ⟨TOMBSTONE⟩ W24: the Phase-B.1 "keep the PM-SOUL system message in sync on every boot"
    // block stood here. Its comment claimed *"the runtime message-assembly path reads the
    // LATEST system message for context"* — that was false when it was written and false
    // every boot since (`tailRender` emits user/assistant/tool only), so this wrote a row
    // nothing reads and reported success. The requirement it was reaching for — a prompt
    // update actually arriving at an already-running PM — is met by the soul file being the
    // one store both the runtime and the card read; see the tombstone above.
    return;
  }

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

    // ⟨TOMBSTONE⟩ W24: the seed `role='system'` row went in here. A system row is not the
    // PM's identity — `prompt/assembler.ts`'s soul file is, for a fresh PM and a worn one
    // alike — and the message assembler cannot show a system row to a model in any case.
    logger.info('PM agent created', { pmId, pmName });
  }
}

// ── THE PM'S REVIEW: one pass over the hand-ins waiting for its decision, plus the stalls the ladder marked ──

const REVIEW_DEBOUNCE_MS = 10_000;
let reviewTimer: ReturnType<typeof setTimeout> | null = null;
let reviewing = false;
let rungWhileReviewing = false;
/** How long a review waits for a queued PM turn before it counts as one that never ran. */
const QUEUED_TURN_BOUND_MS = 30 * 60_000;
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

/** The hand-ins the PM decides now, oldest first. */
function waitingForPM(pmId: string): string[] {
  const rows = getDb().prepare(`SELECT w.id FROM work w WHERE ${taskScope('w')} AND w.state = 'handed_in' ORDER BY w.updated_at`).all() as Array<{ id: string }>;
  return rows.map((r) => r.id).filter((id) => { const d = whoDecides(id); return d?.kind === 'agent' && d.agentId === pmId; }).slice(0, 10);
}

/** Working rows the ladder marked for the PM since its last report. */
function markedStalls(pmId: string): string[] {
  return (getDb().prepare(
    `SELECT w.id FROM work w WHERE ${taskScope('w')} AND ${workingExpr('w')} AND NOT ${heldByOwnerSql('w')} AND EXISTS (SELECT 1 FROM work_events e
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
  const backs = sendBacks(id);
  return `${n}. HANDED IN: "${w.title ?? id}" [${id}] by ${h?.filedBy ?? workerOf(id)}, as ${h?.outcome === 'cant_be_done' ? "can't be done" : 'finished'}`
    + `${h?.scope === 'run' ? ' (one run of a recurring task; the schedule goes on whatever you decide)' : ''}.\n  Goal: ${w.goal ?? '(none recorded)'}\n  Note: ${h?.note ?? '(none)'}\n`
    + (items.length > 0 ? `  Proof (open each item before approving):\n${proofLines(items).map((l, i) => `    ${i}. ${l}`).join('\n')}` : '  Proof: none.')
    + `\n  Sent back so far: ${backs.length === 0 ? 'never' : backs.map((b) => `"${b.reason}"`).join('; ')}`
    + `${validationMeasureLines(id, roomTokens)}${heldDeliveryLine(id)}${ownerWordsLines(id)}`;
}

/** One stall the ladder marked: the hint did not move it, so the PM may give the worker one directive. */
function stallBlock(id: string, n: number): string {
  const w = getDb().prepare(`SELECT w.title, ${holdWordsSql('w')} AS hold FROM work w WHERE w.id = ?`).get(id) as { title: string | null; hold: string };
  const refused = (getDb().prepare(
    `SELECT payload FROM work_events WHERE work_id = ? AND kind = 'hand_in_refused'
       AND id > COALESCE((SELECT MAX(h.id) FROM work_events h WHERE h.work_id = ? AND h.kind IN ('handed_in', 'decided')), 0) ORDER BY id`,
  ).all(id, id) as Array<{ payload: string }>).map((r) => (JSON.parse(r.payload) as { reasons?: string[] }).reasons?.join(' ') ?? '');
  return `${n}. STALLED: "${w.title ?? id}" [${id}], worked by ${workerOf(id)}, has made no progress past its patience bound since the engine's hint.`
    + `${w.hold ? ` It is held: ${w.hold}.` : ''}`
    + (refused.length > 0 ? `\n  Its refused hand-ins:\n${refused.map((r, i) => `    ${i + 1}. ${r}`).join('\n')}` : '');
}

/** One review miss on each row this review held that is still waiting on the same hand-in. */
function recordMisses(pmId: string, held: ReadonlyMap<string, number>, why: string): void {
  for (const [id, handInId] of held) {
    if (latestHandIn(id)?.eventId !== handInId) continue;
    const still = getDb().prepare("SELECT 1 FROM work WHERE id = ? AND state = 'handed_in'").get(id);
    if (still) appendAuditEntry(id, pmId, { entryKind: REVIEW_MISS_ENTRY, reason: why });
  }
}

/** THE PM'S REVIEW (header). The PM runs once; when its turn has ended (or never ran), each held hand-in still
 *  undecided records the miss. */
export async function runPMReview(): Promise<void> {
  if (reviewing) { rungWhileReviewing = true; return; }
  reviewing = true;
  const pmId = getPMAgentId();
  let held = new Map<string, number>();
  try {
    const waiting = waitingForPM(pmId), stalled = markedStalls(pmId);
    held = new Map(waiting.map((id) => [id, latestHandIn(id)?.eventId ?? 0] as const));
    if (waiting.length + stalled.length === 0) return;
    const pm = getDb().prepare('SELECT model_id, status FROM agents WHERE id = ?').get(pmId) as { model_id: string | null; status: string } | undefined;
    if (!pm?.model_id || pm.status === 'terminated') { recordMisses(pmId, held, 'the project manager could not run its review'); return; }
    pruneOldPMMessages(pmId);
    const room = reviewLedgerRoomTokens(contextWindowPolicy(agentTurnWindow(pmId, pm.model_id), { toolPayloadTokens: 0 }).assemblyBudgetTokens, waiting.length);
    const blocks = [...waiting.map((id, i) => handInBlock(id, i + 1, room)), ...stalled.map((id, i) => stallBlock(id, waiting.length + i + 1))];
    const report = `Tracker review -- ${waiting.length} hand-in(s) wait for your decision, ${stalled.length} stalled task(s).\n\n${blocks.join('\n\n')}\n\n`
      + '[Engine hint: for each HANDED IN row, open its proof with work_validate(action="open_proof", task_id, item=N), then work_validate(action="decide", task_id, '
      + 'verdict="approve", reason="<one line: how the proof meets the goal>"), or verdict="send_back" with the reason naming what is missing. A measured task is met when its '
      + 'measure reads 0 or the named remainder holds; a task whose job is a decision is met by the owner\'s recorded words above, never by the worker quoting him. '
      + 'A row you do not decide stays waiting and goes to the next decider. For each STALLED row your one move is work_validate(action="retask", task_id, '
      + 'directive="<the next concrete step>"), or nothing: never poke, never reassign, never send_to_agent(intent="ASSIGN").]';
    const msgId = uuidv4();
    insertEngineEventIfAbsent({ id: msgId, agentId: pmId, content: report, sourceAgentId: null, originIntent: 'pm_review', work: null });
    broadcast({ type: 'chat:message', agentId: pmId, message: { id: msgId, agentId: pmId, role: 'user' as const, content: report, tokenCount: null, modelId: null, cost: null, latencyMs: null, createdAt: new Date().toISOString() } });
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

// How many recent messages to keep for the PM. Bumped from 10 to 30 in
// v2.7.27, at 10 the pair-aware cutoff + downstream orphan sanitizer
// were trimming the PM down to 1-2 effective messages on bad turns,
// leaving it with no context to judge anything. 30 gives the sanitizer
// more pair-completeness to work with while still keeping the PM's
// window small. PM is still stateless conceptually (tracker is its
// memory), this is just enough scratch space.
// t123 RAISED THIS FROM 30 TO 60, for coherence with the lane rather than as a tuning nudge.
// t206: a FLOOR now. The PM's tail is every row since its newest fold, often more than 60 rows,
// so the pruner also stops at the fold boundary: it removes only rows a fold took out of view.
export const PM_MAX_MESSAGES = 60;

/** Prune old PM engine rows to bound the table, never at or past the fold boundary (t206): the
 *  cut is the older of the newest `PM_MAX_MESSAGES` rows and the boundary. Exported for t206 §1d. */
export function pruneOldPMMessages(pmId: string): void {
  const db = getDb();
  try {
    // The fold boundary (`freshTailHorizon` owns where a tail starts). `keepFromSeq` 0 is the
    // floor, where the view is "the newest rows" and nothing is out of view for good.
    const modelId = (db.prepare('SELECT model_id FROM agents WHERE id = ?').get(pmId) as { model_id: string | null } | undefined)?.model_id ?? '';
    const horizon = freshTailHorizon(pmId, contextWindowPolicy(agentTurnWindow(pmId, modelId), { toolPayloadTokens: 0 }));
    if (horizon.keepFromSeq <= 0 || horizon.anchorSeq <= 0) return;

    // The Nth most recent message (none: too few rows to prune), then the older of it and the boundary.
    const floorRow = db.prepare('SELECT seq FROM messages WHERE agent_id = ? ORDER BY seq DESC LIMIT 1 OFFSET ?')
      .get(pmId, PM_MAX_MESSAGES) as { seq: number } | undefined;
    if (!floorRow) return;
    const cutSeq = Math.min(floorRow.seq, horizon.anchorSeq);

    // v2.7.27: tool_call_pair-aware cutoff. If the initial cutoff lands on a
    // 'tool' role message, the resulting kept window starts with an orphaned
    // tool result (no preceding assistant with tool_calls). DeepSeek and most
    // other providers 400 with "Messages with role 'tool' must be a response
    // to a preceding message with 'tool_calls'", which then triggered the
    // injury-recovery loop and made the PM perpetually broken. The fix walks
    // forward from the initial cutoff to find the first non-tool message,
    // using that as the safe cutoff. We may keep fewer than PM_MAX_MESSAGES
    // when this fires; that's fine, PM is stateless and tracker is its memory.
    // t206: the walk never passes the boundary row, so it cannot reach into the view.
    const cutoff = db.prepare(`
      SELECT id FROM messages
      WHERE agent_id = ?
        AND seq >= ?
        AND seq <= ?
        AND role != 'tool'
      ORDER BY seq ASC
      LIMIT 1
    `).get(pmId, cutSeq, horizon.anchorSeq) as { id: string } | undefined;

    if (!cutoff) return;

    // The incident this line remembers: summary_messages.message_id used to reference
    // messages(id) WITHOUT ON DELETE CASCADE, so a raw DELETE on a compacted PM message
    // threw and the prune failed forever ("Failed to prune PM messages" every 10 min for
    // hours, observed in production). The PM doesn't need its archived summaries anyway —
    // the tracker is its memory — so the link rows go first, then the messages, both inside
    // deleteAgentDebrisBefore in one transaction.
    // PHASE-1 T7 re-stated: the reference is BACK (migration 130, now that one table holds
    // every lane) and it is ON DELETE CASCADE precisely so this incident cannot return by
    // way of some other delete path forgetting the ordering. deleteAgentDebrisBefore keeps its
    // explicit first delete regardless — see the note there.
    const deleted = deleteAgentDebrisBefore(pmId, cutoff.id);

    if (deleted > 0) {
      logger.debug('Pruned old PM messages', { pmId, deleted, kept: PM_MAX_MESSAGES });
    }
  } catch (err) {
    logger.warn('Failed to prune PM messages', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

