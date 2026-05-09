// ════════════════════════════════════════
// v2 control shell — runV2Turn
//
// The entire agent runtime. ~400 line target. Replaces v1's 2055-line
// runAgentLoop. Phase 2 implementation: real behavior wired throughout.
//
// Per Part XIX (preservation contract), every v1-visible behavior must
// work identically — see agent/v2/PRESERVATION_CHECKLIST.md.
//
// Phase 2 covers:
//   ✓ All 7 phases as real functions
//   ✓ All 14 Phase-1 classifiers wired
//   ✓ TRUE streaming (chunks broadcast immediately, not buffered)
//   ✓ complete_task / image_create loop exit
//   ✓ Status heartbeat preserved
//   ✓ Stop / preempt preserved (via shared-state)
//   ✓ Cost recording + embedding queueing preserved
//   ✓ chat:tool_call / chat:tool_result / chat:message broadcasts preserved
//   ✓ Synthetic Cancelled tool results when stopped mid-batch
//   ✓ Engine-injected ack (via ackInjector)
//   ✓ Tool partitioning (safe → parallel, others → serial)
//   ✓ Loop break detection (via loopDetector)
//   ✓ Permission denial nudging (via permissionAlternativeFinder)
//   ✓ Tracker enforcement (engine-side, no tool_use in context)
//   ✓ Spinning detection with model nudge (via progressClassifier)
//
// Deferred to later phases (with TODO markers in-line):
//   • Phase 3.5 — large-files.ts deletion + file_read offset/limit
//   • Phase 4 — compaction defaults change + scaffolding cuts
//   • Phase 5 — system prompt diet
//   • Phase 6 — full unified error cascade (Dreamer special case, etc.)
//   • Phase 7 — squad shared memory namespaces
// ════════════════════════════════════════

import { v4 as uuidv4 } from 'uuid';
import type Anthropic from '@anthropic-ai/sdk';
import { createLogger } from '../../logger.js';
import { getDb } from '../../db/connection.js';
import { broadcast } from '../../gateway/ws.js';
import type { Message, ToolCall } from '@dojo/shared';

import { assembleContext } from '../../memory/assembler.js';
import { callModel, getContextWindow } from '../model.js';
import { executeTool } from '../tools.js';
// recordError intentionally NOT imported — handleMessage's catch path calls
// it. Calling here would double-count errors and trip the loop-detector
// pause prematurely.
import { AgentError, clearErrors } from '../errors.js';
import { checkTimeouts } from '../spawner.js';
import {
  isAwaitingIMResponse,
  clearIMResponseFlag,
  sendResponseViaIMessage,
} from '../../services/imessage-bridge.js';
// recordCost intentionally NOT imported — callModel records cost internally.
import { queueEmbedding } from '../../memory/embeddings.js';
import { isPrimaryAgent } from '../../config/platform.js';
import { turnBoundary } from '../turn-state.js';

import {
  stoppedAgents,
  preemptedAgents,
  activeAbortControllers,
  pendingWakeups,
  statusHeartbeats,
  turnContinuationCounts,
  recoveryRunStreak,
} from '../shared-state.js';

// Force-import side-effect: also register the runtime singleton getter so v2
// can fire self-continuation handleMessage() calls (matches v1 behavior).
import { getAgentRuntime } from '../runtime.js';

import {
  type AgentTurnState,
  initState,
  advance,
  bumpLoopSignature,
  nextOutputEscalation,
} from './state.js';

import { partitionTools, type ToolBatch } from './classifiers/concurrency.js';
import { loopDetector, RECENT_TOOL_WINDOW } from './classifiers/loop.js';
// ackInjector intentionally NOT imported — engine ack disabled per invariant
// review (see "Engine-injected ack — DISABLED" comment below).
import { trackerEnforcer } from './classifiers/tracker.js';
import { compactionGate } from './classifiers/compaction.js';
import { checkAndCompact, estimateAssembledTokens } from '../../memory/compaction.js';
import { a2aReplyEnforcer, parseA2ATrigger } from './classifiers/a2a.js';
import { outputTruncationClassifier, outputPersistenceClassifier, sanitizeAssistantText } from './classifiers/output.js';
import { progressClassifier, buildSpinningNudge } from './classifiers/progress.js';
import { permissionAlternativeFinder } from './classifiers/permission.js';
import { techniqueMatcher } from './classifiers/technique.js';
import { listTechniques } from '../../techniques/store.js';

const logger = createLogger('v2-loop');

const STATUS_HEARTBEAT_INTERVAL_MS = 30_000;
const MAX_TOOL_LOOPS = 75;                     // matches v1
const TURN_TIME_BUDGET_MS = 15 * 60 * 1000;    // matches v1 — 15 min/turn
const MAX_TURN_AUTO_CONTINUATIONS = 3;         // matches v1
const ACK_DEFAULT_TEXT = 'Working on it…';

// ── Heartbeat (mirrors v1 helpers — local copy so v2 can run standalone) ──

function startStatusHeartbeat(agentId: string): void {
  const existing = statusHeartbeats.get(agentId);
  if (existing) clearInterval(existing);
  const timer = setInterval(() => {
    try {
      broadcast({ type: 'agent:status', agentId, status: 'working' });
    } catch {
      /* best effort */
    }
  }, STATUS_HEARTBEAT_INTERVAL_MS);
  statusHeartbeats.set(agentId, timer);
}

function stopStatusHeartbeat(agentId: string): void {
  const timer = statusHeartbeats.get(agentId);
  if (timer) {
    clearInterval(timer);
    statusHeartbeats.delete(agentId);
  }
}

export function setAgentStatus(agentId: string, status: string): void {
  try {
    const db = getDb();
    if (status === 'idle' || status === 'working') {
      db.prepare(`
        UPDATE agents SET status = ?, last_error = NULL, last_error_at = NULL, updated_at = datetime('now') WHERE id = ?
      `).run(status, agentId);
    } else {
      db.prepare(`
        UPDATE agents SET status = ?, updated_at = datetime('now') WHERE id = ?
      `).run(status, agentId);
    }
    broadcast({ type: 'agent:status', agentId, status });
  } catch (err) {
    logger.warn('Failed to update agent status', {
      agentId,
      status,
      error: err instanceof Error ? err.message : String(err),
    }, agentId);
  }
}

// ── Main entry ──

/**
 * Run a single user-message → agent-response cycle on the v2 runtime.
 * Mirrors v1's runAgentLoop semantics with the Control Shell pattern.
 */
export async function runV2Turn(agentId: string): Promise<void> {
  const db = getDb();

  const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(agentId) as
    | Record<string, unknown>
    | undefined;
  if (!agent) {
    throw new AgentError('Agent not found', agentId, { code: 'AGENT_NOT_FOUND' });
  }
  const configuredModelId = agent.model_id as string | null;
  if (!configuredModelId) {
    throw new AgentError('Agent has no model configured', agentId, { code: 'NO_MODEL' });
  }

  const isAutoRouted = configuredModelId === 'auto';
  const contextModelId = isAutoRouted ? '__auto__' : configuredModelId;
  const contextWindow = getContextWindow(contextModelId);

  setAgentStatus(agentId, 'working');
  startStatusHeartbeat(agentId);

  // Trigger context — read once at preflight (Part XIX preservation)
  const triggerRow = db.prepare(
    "SELECT content FROM messages WHERE agent_id = ? AND role = 'user' ORDER BY created_at DESC, rowid DESC LIMIT 1",
  ).get(agentId) as { content: string } | undefined;
  const lastUserMessageContent = triggerRow?.content ?? null;
  const triggeredByIMessage = lastUserMessageContent?.includes('[SOURCE: IMESSAGE FROM') ?? false;
  const imFlagSetAtRunStart = isAwaitingIMResponse(agentId);
  const a2aReplyContext = parseA2ATrigger(lastUserMessageContent);

  // Determine v2 turn_number — read max from messages, increment.
  // Per Part XVIII §E: turn_number is per-agent, monotonically increasing,
  // resets to 0 on session reset (handled elsewhere).
  const lastTurn = db.prepare(
    'SELECT MAX(turn_number) as max_turn FROM messages WHERE agent_id = ?',
  ).get(agentId) as { max_turn: number | null } | undefined;
  const turnNumber = (lastTurn?.max_turn ?? 0) + 1;

  // Snapshot turn boundary so context assembly excludes mid-run user messages
  const turnStartedAt = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
  turnBoundary.set(agentId, turnStartedAt);

  // Initial state
  let state = initState({
    agentId,
    contextWindow,
    isAutoRouted,
    configuredModelId,
    turnNumber,
    triggeredByIMessage,
    triggeredByA2AReplyIntent: a2aReplyContext,
    imFlagSetAtRunStart,
    lastUserMessageContent,
    shouldNudgeTracker: false, // Phase 2.1 may compute this; baseline disabled
  });

  try {
    // ── Main loop ──
    while (state.phase !== 'done' && state.loopCount < MAX_TOOL_LOOPS) {
      state = advance(state, { loopCount: state.loopCount + 1, phase: 'preCallGates' });

      // Stop / preempt checks
      if (stoppedAgents.has(agentId)) {
        stoppedAgents.delete(agentId);
        logger.info('v2 agent stopped by user', {}, agentId);
        setAgentStatus(agentId, 'idle');
        break;
      }
      if (preemptedAgents.has(agentId)) {
        preemptedAgents.delete(agentId);
        logger.info('v2 run preempted — queued wakeup will fire', {}, agentId);
        setAgentStatus(agentId, 'idle');
        break;
      }

      // ── Turn time budget — auto-continue, don't halt ──
      // (Matches v1 runtime.ts:884-919.) When a turn runs longer than 15 min,
      // force a compaction and queue a wakeup so the agent picks up where it
      // left off. After MAX_TURN_AUTO_CONTINUATIONS consecutive checkpoints
      // we give up — usually indicates a stuck loop.
      if (Date.now() - state.turnStartMs > TURN_TIME_BUDGET_MS) {
        const elapsedMin = Math.round((Date.now() - state.turnStartMs) / 60000);
        const continuationCount = (turnContinuationCounts.get(agentId) ?? 0) + 1;

        if (continuationCount > MAX_TURN_AUTO_CONTINUATIONS) {
          turnContinuationCounts.delete(agentId);
          logger.error('v2 turn auto-continuation cap reached — stopping', {
            elapsedMin, continuationCount, max: MAX_TURN_AUTO_CONTINUATIONS, agentId,
          }, agentId);
          const totalMin = (MAX_TURN_AUTO_CONTINUATIONS + 1) * (TURN_TIME_BUDGET_MS / 60000);
          const stuckMsg = (
            `[System: This task has been running for about ${totalMin} minutes without finishing. ` +
            `Pausing — this usually means a stuck loop, an over-scoped task, or a slow model. ` +
            `Send a follow-up to resume, or break the work into smaller pieces.]`
          );
          const stuckId = uuidv4();
          db.prepare(`
            INSERT OR IGNORE INTO messages (id, agent_id, role, content, turn_number, created_at)
            VALUES (?, ?, 'system', ?, ?, datetime('now'))
          `).run(stuckId, agentId, stuckMsg, turnNumber);
          broadcast({
            type: 'chat:message',
            agentId,
            message: {
              id: stuckId, agentId, role: 'system' as const,
              content: stuckMsg,
              tokenCount: null, modelId: null, cost: null, latencyMs: null,
              createdAt: new Date().toISOString(),
            },
          });
          break;
        }

        turnContinuationCounts.set(agentId, continuationCount);
        logger.warn('v2 turn time budget reached — auto-continuing with forced compaction', {
          elapsedMin, continuationCount, agentId,
        }, agentId);

        // Force compaction so next turn starts with summarized history.
        try {
          const effectiveModel =
            state.modelId === '__auto__' ? configuredModelId : state.modelId;
          await checkAndCompact(agentId, effectiveModel, getContextWindow(effectiveModel), { force: true });
        } catch (compErr) {
          logger.warn('v2 forced compaction at turn-budget checkpoint failed', {
            agentId, error: compErr instanceof Error ? compErr.message : String(compErr),
          }, agentId);
        }

        const sysMsg = (
          `[System: This turn ran for ${elapsedMin} minutes. Pausing here and continuing on a fresh turn ` +
          `(${continuationCount} of ${MAX_TURN_AUTO_CONTINUATIONS}). ` +
          `Your earlier conversation has been summarized — pick up where you left off. ` +
          `Check tracker_list_active for the task you were working on; do not start over.]`
        );
        const sysMsgId = uuidv4();
        db.prepare(`
          INSERT OR IGNORE INTO messages (id, agent_id, role, content, turn_number, created_at)
          VALUES (?, ?, 'system', ?, ?, datetime('now'))
        `).run(sysMsgId, agentId, sysMsg, turnNumber);
        broadcast({
          type: 'chat:message',
          agentId,
          message: {
            id: sysMsgId, agentId, role: 'system' as const,
            content: sysMsg,
            tokenCount: null, modelId: null, cost: null, latencyMs: null,
            createdAt: new Date().toISOString(),
          },
        });
        // Queue wakeup so handleMessage's finally fires the loop again
        pendingWakeups.add(agentId);
        break;
      }

      // ── Pre-call compaction gate (Part V) ──
      // Check assembled context utilization BEFORE the model call. v2's
      // architecture is "compaction is a debug signal, not routine":
      //   <90%   noop (the common case)
      //   90–96% warn (log + chat:warning broadcast — every WARN is a v2 architecture bug)
      //   96–99% emergency compact (force checkAndCompact + queue wakeup)
      //   ≥99%   block (surrender turn — recovery cascade re-runs)
      const assembledEstimate = estimateAssembledTokens(agentId, contextWindow);
      const gateResult = compactionGate(assembledEstimate.total, contextWindow);
      if (gateResult.decision === 'warn') {
        // The chat:warning toast comes from compaction.ts internal WARN block
        // when checkAndCompact runs — but in WARN-only mode we don't call
        // checkAndCompact. Fire the broadcast directly so dashboard surfaces it.
        logger.warn(gateResult.reason ?? 'context utilization warning', {
          agentId, ratio: gateResult.ratio, assembledTokens: gateResult.assembledTokens,
        }, agentId);
        try {
          // User-facing: plain language. Internal reason goes to logs only.
          const ratioPct = (gateResult.ratio * 100).toFixed(0);
          broadcast({
            type: 'chat:error',
            agentId,
            error: `Agent's memory is getting full (${ratioPct}%). Working normally for now.`,
            code: 'CONTEXT_HIGH',
            severity: 'warning',
            retryable: false,
          });
        } catch { /* best effort */ }
        // Continue the turn — WARN is informational, not a blocker.
      } else if (gateResult.decision === 'compact') {
        logger.error(gateResult.reason ?? 'emergency compaction', {
          agentId, ratio: gateResult.ratio,
        }, agentId);
        try {
          const effectiveModel = isAutoRouted ? configuredModelId : configuredModelId;
          await checkAndCompact(agentId, effectiveModel, contextWindow, { force: true });
        } catch (compErr) {
          logger.warn('v2: emergency compaction failed', {
            agentId, error: compErr instanceof Error ? compErr.message : String(compErr),
          }, agentId);
        }
        // Queue wakeup so the next iteration assembles fresh post-compaction context
        pendingWakeups.add(agentId);
        break;
      } else if (gateResult.decision === 'block') {
        logger.error(gateResult.reason ?? 'context impossibly full', {
          agentId, ratio: gateResult.ratio,
        }, agentId);
        const blockMsg = (
          `[System: Memory is too full to continue this turn (${(gateResult.ratio * 100).toFixed(0)}%). ` +
          `Pausing — the DOJO will compact memory and resume automatically.]`
        );
        const blockMsgId = uuidv4();
        db.prepare(`
          INSERT OR IGNORE INTO messages (id, agent_id, role, content, turn_number, created_at)
          VALUES (?, ?, 'system', ?, ?, datetime('now'))
        `).run(blockMsgId, agentId, blockMsg, turnNumber);
        broadcast({
          type: 'chat:message',
          agentId,
          message: {
            id: blockMsgId, agentId, role: 'system' as const,
            content: blockMsg,
            tokenCount: null, modelId: null, cost: null, latencyMs: null,
            createdAt: new Date().toISOString(),
          },
        });
        // Force compaction then wakeup so we recover next turn
        try {
          await checkAndCompact(agentId, configuredModelId, contextWindow, { force: true });
        } catch { /* best effort */ }
        pendingWakeups.add(agentId);
        break;
      }

      // ── Phase: assemble context ──
      state = advance(state, { phase: 'assemble' });
      const ctx = await assembleContext(agentId, contextModelId);
      let systemPrompt = ctx.systemPrompt;
      const messages = ctx.messages;

      // ── Technique matcher (Part VI #5, Phase 5) ──
      // Replaces v1's "MANDATORY: Check Techniques Before Starting Work"
      // prompt instruction with engine-side fuzzy matching: when the user
      // sends a message, the engine matches their intent against published
      // techniques and surfaces relevant ones in the system prompt. The
      // agent doesn't have to remember to check the index.
      //
      // Only fires:
      //   - on the first loop iteration of a turn (not per tool call)
      //   - when there is a last user message (not on auto-continuations,
      //     A2A wakes, or PM pokes — those carry their own context)
      if (state.loopCount === 1 && lastUserMessageContent) {
        try {
          const techniques = listTechniques({ state: 'published' }).map((t) => ({
            id: t.id,
            name: t.name,
            description: t.description ?? undefined,
            tags: t.tags,
          }));
          const matches = techniqueMatcher({ query: lastUserMessageContent, techniques });
          if (matches.length > 0) {
            // Two modes:
            //   - STRONG MATCH (score >= 0.5): the engine loads TECHNIQUE.md
            //     and WRAPS the user's most recent message with the technique
            //     body, framed as authoritative guidance from the user. The
            //     wrap is in-message (user-role, adjacent to the ask) rather
            //     than appended to the system prompt — frontier models weight
            //     user-role instructions and recent tokens far more than
            //     buried system-prompt rules. v2.2.8 inlined into the system
            //     prompt and the model still ignored it; v2.3.2 puts the
            //     technique where the model actually pays attention.
            //   - WEAK MATCH (score < 0.5): keep the existing hint behavior
            //     in the system prompt; agent decides whether to load.
            //
            // Cap at one auto-injected technique per turn to keep token cost
            // bounded. If the technique is too large to inline (>25K chars ≈
            // 6K tokens), still wrap the user message but with a load-it
            // instruction instead of the full body.
            const STRONG_MATCH_THRESHOLD = 0.5;
            const MAX_INLINE_CHARS = 25_000;
            const strongMatch = matches[0].score >= STRONG_MATCH_THRESHOLD ? matches[0] : null;
            const weakMatches = strongMatch
              ? matches.slice(1).filter((m) => m.score < STRONG_MATCH_THRESHOLD)
              : matches;

            let injectedTechniqueId: string | null = null;
            let userMessageWrap: string | null = null;
            if (strongMatch) {
              try {
                const { getTechniqueDetail, recordTechniqueUsage } = await import('../../techniques/store.js');
                const detail = getTechniqueDetail(strongMatch.technique.id);
                if (detail?.instructions && detail.instructions.length > 0) {
                  const md = detail.instructions;
                  const tooLarge = md.length > MAX_INLINE_CHARS;
                  if (tooLarge) {
                    userMessageWrap =
                      `[DOJO: This task is covered by the "${strongMatch.technique.name}" technique. The full instructions are too long to inline (${md.length} chars) — load it via use_technique('${strongMatch.technique.id}') before doing the work. Do not improvise an alternative approach.]\n\n`;
                  } else {
                    userMessageWrap =
                      `[DOJO: This task is covered by the "${strongMatch.technique.name}" technique. Follow the procedure below as written — do not improvise an alternative approach.]\n\n` +
                      `--- TECHNIQUE: ${strongMatch.technique.name} ---\n${md}\n--- END TECHNIQUE ---\n\n`;
                  }
                  injectedTechniqueId = strongMatch.technique.id;
                  try { recordTechniqueUsage(strongMatch.technique.id, agentId); } catch { /* best effort */ }
                  logger.info('v2 techniqueMatcher: wrapping user message with strong-match technique', {
                    agentId,
                    techniqueId: strongMatch.technique.id,
                    techniqueName: strongMatch.technique.name,
                    score: strongMatch.score,
                    contentChars: md.length,
                    inlinedFully: !tooLarge,
                  }, agentId);
                }
              } catch (loadErr) {
                logger.warn('v2 techniqueMatcher: strong-match load failed — falling back to hint', {
                  agentId,
                  techniqueId: strongMatch.technique.id,
                  error: loadErr instanceof Error ? loadErr.message : String(loadErr),
                }, agentId);
              }
            }

            // Apply the wrap to the most recent user message in `messages`.
            // The DB-stored row is untouched — only this in-flight model call
            // sees the wrap. Handles both string and content-block forms.
            if (userMessageWrap) {
              for (let i = messages.length - 1; i >= 0; i--) {
                const m = messages[i];
                if (m.role !== 'user') continue;
                if (typeof m.content === 'string') {
                  m.content = userMessageWrap + m.content;
                } else if (Array.isArray(m.content)) {
                  const blocks = m.content as unknown as Array<Record<string, unknown>>;
                  const firstTextIdx = blocks.findIndex((b) => b.type === 'text');
                  if (firstTextIdx >= 0) {
                    blocks[firstTextIdx] = {
                      ...blocks[firstTextIdx],
                      text: userMessageWrap + ((blocks[firstTextIdx].text as string) ?? ''),
                    };
                  } else {
                    blocks.unshift({ type: 'text', text: userMessageWrap });
                  }
                }
                break;
              }
            }

            // Weak matches (and the strong match if its load failed) get the
            // legacy "consider these" hint.
            const hintMatches = injectedTechniqueId === null
              ? matches
              : weakMatches;
            if (hintMatches.length > 0) {
              const lines = hintMatches.map((m) => {
                const reason = m.score >= 0.6 ? 'strong match' : 'possible match';
                const desc = m.technique.description ? ` — ${m.technique.description}` : '';
                return `- \`${m.technique.name}\` (${reason})${desc}\n  Load with \`use_technique('${m.technique.id}')\` if applicable.`;
              });
              const hintHeader = injectedTechniqueId
                ? `\n\n## Other Techniques That Might Also Apply\n\n`
                : `\n\n## Possibly Relevant Techniques\n\n`;
              systemPrompt += hintHeader +
                `Based on the user's message, the DOJO matched these techniques. Load any that fit the task; ignore otherwise.\n\n` +
                lines.join('\n');
            }
            logger.debug('v2 techniqueMatcher: surfaced matches', {
              agentId,
              matchCount: matches.length,
              autoInjected: injectedTechniqueId,
              names: matches.map((m) => m.technique.name),
            }, agentId);
          }
        } catch (err) {
          // "no such table: techniques" fires during integration test runs
          // (mocked in-memory DB without the techniques table) and pre-migration
          // fresh installs. It's not a production failure mode — log at debug,
          // not warn, so it doesn't pollute the WARN-rate acceptance signal.
          const msg = err instanceof Error ? err.message : String(err);
          const isMissingTable = /no such table/i.test(msg);
          if (isMissingTable) {
            logger.debug('v2 techniqueMatcher: techniques table not present (expected in tests/fresh DBs)', { agentId }, agentId);
          } else {
            logger.warn('v2 techniqueMatcher failed (non-fatal)', { agentId, error: msg }, agentId);
          }
        }
      }

      // ── Multi-step detection (v2.3.3) ──
      // Engine-side detection of prompts that need a tracker project.
      // When confident (heuristic high, or local-LLM classifier confirms),
      // create the project + initial task directly so the agent can't
      // forget to do it. Same lesson as the technique matcher above:
      // system-prompt instructions don't reliably get followed.
      //
      // Same fire conditions as technique matcher: loopCount === 1 with
      // a real user message (not auto-continuation / A2A / PM poke).
      if (state.loopCount === 1 && lastUserMessageContent) {
        try {
          const { detectMultistep, getMultistepConfig } = await import('./classifiers/multistep.js');
          const cfg = getMultistepConfig();
          if (cfg.enabled) {
            // Skip if there's already an active tracker task assigned to
            // this agent — assume it's still being worked. This avoids
            // creating a sibling project on a follow-up message.
            const db = getDb();
            const existingTask = db.prepare(`
              SELECT id FROM tasks
              WHERE assigned_to = ? AND status IN ('on_deck', 'in_progress', 'paused')
              LIMIT 1
            `).get(agentId) as { id: string } | undefined;

            if (!existingTask) {
              const decision = await detectMultistep(lastUserMessageContent, cfg);
              logger.info('v2 multistep classifier ran', {
                agentId,
                source: decision.source,
                multistep: decision.multistep,
                name: decision.name,
                signals: decision.heuristic.signals,
              }, agentId);

              if (decision.multistep) {
                const { createProject } = await import('../../tracker/schema.js');

                const fallbackName = lastUserMessageContent
                  .split('\n')[0]
                  .slice(0, 50)
                  .trim()
                  .replace(/[.!?]+$/, '');
                const projectTitle = decision.name ?? fallbackName ?? 'Multi-step task';
                const taskTitle = decision.name ?? fallbackName ?? 'Initial task';

                try {
                  // createdBy == agentId so createProject's auto-start
                  // condition fires (assignee === createdBy on the first
                  // step → status='in_progress'). Otherwise the task lands
                  // in on_deck and waits for someone to pull it forward.
                  // Matches the pattern when an agent calls
                  // tracker_create_project on itself.
                  const created = createProject({
                    title: projectTitle,
                    description: lastUserMessageContent.slice(0, 2000),
                    level: 1,
                    createdBy: agentId,
                    tasks: [{
                      title: taskTitle,
                      description: lastUserMessageContent.slice(0, 2000),
                      assignedTo: agentId,
                      priority: 'normal',
                    }],
                  });
                  logger.info('v2 multistep: auto-created tracker project', {
                    agentId,
                    projectId: created.projectId,
                    taskIds: created.taskIds,
                    title: projectTitle,
                    source: decision.source,
                  }, agentId);

                  // Inject the standard task-assignment notification —
                  // same payload tracker_create_task uses, including the
                  // explicit "When finished, call tracker_update_status"
                  // instruction. Persists to DB (survives compaction)
                  // and broadcasts WS for the dashboard. skipWake=true
                  // because we ARE the running turn — handleMessage
                  // would just queue a redundant follow-up.
                  const { injectTaskAssignmentNotification } = await import('../../tracker/notify.js');
                  const taskId = created.taskIds[0];
                  const notif = injectTaskAssignmentNotification({
                    assignedAgentId: agentId,
                    creatorAgentId: 'dojo-system',
                    taskId,
                    title: taskTitle,
                    description: lastUserMessageContent.slice(0, 2000),
                    projectId: created.projectId,
                    priority: 'normal',
                    skipWake: true,
                  });

                  // Push the same content into the in-flight messages
                  // array so the agent sees it THIS turn (not just on
                  // the next assemble). Goes after the user's prompt
                  // chronologically — agent reads "user said X" then
                  // "the engine assigned you a task for it."
                  if (notif.ok && notif.content) {
                    messages.push({ role: 'user', content: notif.content });
                  }
                } catch (createErr) {
                  logger.warn('v2 multistep: createProject failed (non-fatal)', {
                    agentId,
                    error: createErr instanceof Error ? createErr.message : String(createErr),
                  }, agentId);
                }
              }
            }
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const isMissingTable = /no such table/i.test(msg);
          if (isMissingTable) {
            logger.debug('v2 multistep: tracker tables not present (expected in tests/fresh DBs)', { agentId }, agentId);
          } else {
            logger.warn('v2 multistep classifier failed (non-fatal)', { agentId, error: msg }, agentId);
          }
        }
      }

      // Inject user-uploaded attachments (images, PDFs) as content blocks.
      // Without this, the agent never sees images/PDFs the user attached —
      // it only sees the text content of those messages and hallucinates.
      // Same path v1 uses (runtime.ts:1929 in v1).
      const { injectAttachmentBlocks } = await import('../runtime.js');
      injectAttachmentBlocks(messages, agentId);

      // Inject pendingNudge if present (synthetic user message, not persisted).
      // Per v1 runtime.ts:940-947 — only inject if last message is assistant
      // (so alternation stays valid). Then clear the nudge.
      if (state.pendingNudge && (messages.length === 0 || messages[messages.length - 1].role === 'assistant')) {
        messages.push({ role: 'user', content: state.pendingNudge });
        state = advance(state, { pendingNudge: null });
      }

      // Empty-messages guard (preserve v1 behavior at runtime.ts:1014-1020)
      if (messages.length === 0) {
        logger.info('v2: assembled context has zero messages — clean exit', {
          agentId,
          loopCount: state.loopCount,
        }, agentId);
        setAgentStatus(agentId, 'idle');
        break;
      }

      // ── Phase: model call ──
      // (Auto-routing + capability gate + retry-fallback + TRUE streaming.)
      state = advance(state, { phase: 'callLLM' });
      const messageId = uuidv4();
      state = advance(state, { currentMessageId: messageId });

      // ── Auto-routing model selection (matches v1 runtime.ts:954-988) ──
      // For auto-routed agents, pick the right model for THIS query. Lock
      // the model across tool loops so we don't switch mid-task.
      let modelId: string;
      let routerTier: string | null = null;
      const excludedModels: string[] = [];

      if (isAutoRouted) {
        if (state.lockedModelId && state.loopCount > 1) {
          modelId = state.lockedModelId;
          routerTier = state.lockedTier;
          logger.info('v2 auto-router: using locked model (mid-task)', {
            modelId, tier: routerTier,
          }, agentId);
        } else {
          const { scoreQuery } = await import('../../router/scorer.js');
          const { selectModel } = await import('../../router/selector.js');
          const scoringResult = scoreQuery(
            systemPrompt,
            messages as Array<{ role: string; content: string | object[] }>,
          );
          routerTier = scoringResult.tier;
          const selected = selectModel(scoringResult.tier, agentId, undefined, ['tools']);
          if (!selected) {
            throw new AgentError('Auto-router: no models available in any tier', agentId, { code: 'NO_MODEL' });
          }
          modelId = selected.modelId;
          logger.info(`v2 auto-router: tier=${scoringResult.tier} → ${modelId}`, {
            tier: scoringResult.tier,
            modelId,
            fallbackUsed: selected.fallbackUsed,
          }, agentId);
        }
      } else {
        modelId = configuredModelId;
      }
      state = advance(state, { modelId, routerTier });

      // ── Pre-flight capability enforcement (matches v1 runtime.ts:995) ──
      // Strips image/document blocks if model lacks vision (with banner).
      // Returns useTools=false if model lacks tool support (with banner).
      const { enforceModelCapabilities } = await import('../runtime.js');
      const { useTools } = enforceModelCapabilities(agentId, modelId, messages);

      // If tools are disabled, inject a one-shot note so the model knows it
      // can only respond with text. Only inject on first iteration when last
      // message is assistant (alternation safety).
      if (!useTools && state.loopCount === 1 && messages.length > 0 && messages[messages.length - 1].role === 'assistant') {
        const toolNote = (
          `[System note: Your current model does not support tool calling. You can only respond with text. ` +
          `If the user asks you to do something that requires tools (file access, web search, tracker, etc.), ` +
          `explain that your model doesn't support it and suggest they switch to a tool-capable model in Settings.]`
        );
        messages.push({ role: 'user', content: toolNote });
      }

      // ── Call model with retry-and-fallback (matches v1 runtime.ts:1028-1116) ──
      // For auto-routed agents, try up to 3 different models in the tier.
      // For fixed-model agents, throw on first failure.
      const maxAttempts = isAutoRouted ? 3 : 1;
      let result: Awaited<ReturnType<typeof callModel>> | undefined;
      let callSucceeded = false;

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const abortController = new AbortController();
        activeAbortControllers.set(agentId, abortController);

        try {
          result = await callModel({
            agentId,
            modelId,
            messages,
            systemPrompt,
            tools: useTools,
            routerTier: routerTier ?? undefined,
            // Real abort signal — when stopAgent fires controller.abort(), the
            // underlying SDK call (Anthropic/OpenAI/Ollama) actually cancels
            // the in-flight fetch and throws here. Without this signal, stop
            // would only halt the runtime loop AFTER the model call finished.
            abortSignal: abortController.signal,
            // TRUE streaming — broadcast each chunk as it arrives.
            onChunk: (chunk) => {
              if (abortController.signal.aborted) return;
              broadcast({
                type: 'chat:chunk',
                agentId,
                messageId,
                content: chunk,
                done: false,
              });
            },
            // Reasoning / thinking chunks (DeepSeek native, OpenRouter
            // unified). The dashboard renders these in a collapsible
            // "Thinking…" panel above the assistant bubble — separate
            // from the final-answer text stream.
            onReasoningChunk: (chunk) => {
              if (abortController.signal.aborted) return;
              broadcast({
                type: 'chat:reasoning_chunk',
                agentId,
                messageId,
                content: chunk,
                done: false,
              });
            },
          });
          activeAbortControllers.delete(agentId);
          callSucceeded = true;
          break;
        } catch (err) {
          activeAbortControllers.delete(agentId);

          if (stoppedAgents.has(agentId)) {
            stoppedAgents.delete(agentId);
            setAgentStatus(agentId, 'idle');
            return;
          }
          if (preemptedAgents.has(agentId)) {
            preemptedAgents.delete(agentId);
            logger.info('v2 run preempted — queued wakeup will fire', {}, agentId);
            setAgentStatus(agentId, 'idle');
            return;
          }

          // Not auto-routed OR exhausted attempts — rethrow.
          // (v1's catch path in handleMessage handles further recovery —
          // Dreamer overflow, provider 4xx, healer notification, etc. Phase 6
          // moves all of that into agent/v2/recovery.ts.)
          if (!isAutoRouted || attempt >= maxAttempts - 1) {
            throw err;
          }

          // Auto-routed: try the next model in the fallback chain.
          excludedModels.push(modelId);
          // Clear model lock so fallback can pick a different model.
          state = advance(state, { lockedModelId: null, lockedTier: null });
          const { selectModel } = await import('../../router/selector.js');
          const fallbackTier = routerTier ?? state.lockedTier ?? 'standard';
          const fallback = selectModel(fallbackTier, agentId, excludedModels, ['tools']);
          if (!fallback) {
            logger.error('v2 auto-router: no fallback models available', {
              failedModel: modelId, tier: fallbackTier, excludedModels, attempt,
            }, agentId);
            throw err;
          }
          logger.warn(`v2 auto-router: ${modelId} failed → falling back to ${fallback.modelId}`, {
            failedModel: modelId,
            fallbackModel: fallback.modelId,
            tier: routerTier,
            error: err instanceof Error ? err.message.slice(0, 100) : String(err),
          }, agentId);
          modelId = fallback.modelId;
          state = advance(state, { modelId });
        }
      }

      if (!callSucceeded || !result) {
        throw new AgentError('Model call failed after all attempts', agentId, { code: 'MODEL_CALL_FAILED' });
      }

      // ── Lock model for tool loops ──
      // For auto-routed agents that just kicked off tool calls, pin the
      // chosen model for the remainder of this turn so tools+follow-up calls
      // use the same model.
      if (isAutoRouted && !state.lockedModelId && result.toolCalls.length > 0) {
        state = advance(state, { lockedModelId: modelId, lockedTier: routerTier });
        logger.info('v2 auto-router: locking model for tool loop', { modelId, tier: routerTier }, agentId);
      }

      // Cost recording happens inside callModel (model.ts records once per
      // provider path). The v2 loop must NOT call recordCost again — doing so
      // double-bills the cost tracker. Verified against logs 2026-05-04.
      //
      // Embedding queueing: callModel does NOT queue embeddings — that's the
      // runtime's job. v1 calls queueEmbedding for assistant text responses
      // (runtime.ts), so v2 does the same.
      // Skip embedding the no-reply sentinel — it's not real content and the
      // matching assistant message row never gets persisted.
      const isNoReplySentinel =
        !!result.content &&
        result.toolCalls.length === 0 &&
        /^\s*\[no-reply\]\s*$/i.test(result.content);
      if (result.content && result.content.trim().length > 0 && !isNoReplySentinel) {
        try {
          queueEmbedding('message', messageId, agentId, result.content);
        } catch { /* best effort */ }
      }

      state = advance(state, { lastResponse: result, toolCalls: result.toolCalls });

      // ── Phase: post-call classification ──
      state = advance(state, { phase: 'postCallClassify' });

      // Empty response handling — v1 has 3-phase retry. Phase 2 baseline:
      // single output-truncation check; if not truncated and no text/tools,
      // surface as toast and break.
      if (result.toolCalls.length === 0 && (!result.content || result.content.trim().length === 0)) {
        const trunc = outputTruncationClassifier({
          stopReason: result.stopReason,
          contentLength: 0,
          currentBudget: state.outputTokensEscalated,
        });
        if (trunc.truncated && trunc.escalateTo !== null) {
          // Output was truncated — escalate budget and retry.
          state = advance(state, { outputTokensEscalated: trunc.escalateTo });
          continue;
        }
        // Clean end-of-turn after tools — legitimate exit, no error.
        if (state.toolCallsExecutedThisTurn > 0) {
          // v1 line 1167-1171: agent did work and has nothing more to say.
          break;
        }
        // No tools called and no text — empty response. v1 runtime.ts:1166-1199
        // does a 3-phase fallback before giving up. Many empties are transient
        // (streaming hiccup, model hesitation) and resolve on a silent retry.
        // Phase 1: silent retry (no nudge, just re-run the model).
        if (!state.retriedEmptyResponse) {
          logger.warn('v2: model returned empty response, retrying silently', {
            loopCount: state.loopCount, stopReason: result.stopReason,
          }, agentId);
          state = advance(state, { retriedEmptyResponse: true });
          continue;
        }
        // Phase 2: explicit nudge — inject a [System: ...] note via pendingNudge
        // so the assemble phase wraps it as a synthetic user message next turn.
        if (!state.nudgedForEmptyResponse) {
          logger.warn('v2: model returned empty after silent retry, nudging', {
            loopCount: state.loopCount, stopReason: result.stopReason,
          }, agentId);
          state = advance(state, {
            nudgedForEmptyResponse: true,
            pendingNudge:
              "[System: You returned an empty response. Please respond to the user's last message or call a tool to continue your task. If you are finished, say so clearly.]",
          });
          continue;
        }
        // Phase 3: give up — toast the user, no DB changes.
        logger.warn('v2: model returned empty after nudge, breaking', {
          loopCount: state.loopCount, stopReason: result.stopReason,
        }, agentId);
        state = advance(state, { pendingNudge: null });
        broadcast({
          type: 'chat:error',
          agentId,
          error: 'Agent gave an empty reply. Send your message again to retry.',
          code: 'MODEL_FAILED',
          severity: 'warning',
          retryable: true,
        });
        break;
      }

      // Sanitize text before persistence (#39, v1 runtime.ts:1208-1219).
      // Weak models emit literal `\n` and over-pad blank lines.
      result.content = sanitizeAssistantText(result.content ?? null) ?? '';

      // Dedup check (#40, v1 runtime.ts:1221-1232). If the model produced
      // the exact same text as the most recent assistant message AND there
      // are no tool calls, break the loop without persisting. Catches the
      // "model regenerated identical text" failure mode (multiple triggers,
      // model stalls). Tool-bearing turns are exempt — even with identical
      // text, the tool calls themselves carry new state.
      if (result.content && result.toolCalls.length === 0) {
        const lastAssistant = db
          .prepare(
            "SELECT content FROM messages WHERE agent_id = ? AND role = 'assistant' ORDER BY created_at DESC, rowid DESC LIMIT 1",
          )
          .get(agentId) as { content: string } | undefined;
        if (lastAssistant && lastAssistant.content === result.content) {
          logger.warn('v2: skipping duplicate assistant response (identical to last message)', {
            loopCount: state.loopCount,
          }, agentId);
          break;
        }
      }

      // Broadcast streaming complete + persist assistant message.
      const persistenceDecision = outputPersistenceClassifier({
        responseText: result.content ?? null,
        toolCallsThisTurn: result.toolCalls,
        isInterAgentTrigger:
          lastUserMessageContent?.includes('[SOURCE: AGENT MESSAGE FROM') ||
          lastUserMessageContent?.includes('[SOURCE: GROUP BROADCAST FROM') ||
          lastUserMessageContent?.includes('[SOURCE: PM AGENT POKE FROM') ||
          lastUserMessageContent?.startsWith('[A2A:') || false,
        sentToAgentThisTurn: state.sentToAgentThisTurn,
      });

      let persistedContent: string | null = result.content;
      if (persistenceDecision.decision === 'suppress' && result.toolCalls.length === 0) {
        logger.debug('v2: suppressed trailing text', {
          agentId,
          reason: persistenceDecision.reason,
        }, agentId);
        persistedContent = null;
      }

      // No-reply sentinel: the agent emits `[no-reply]` (case-insensitive,
      // possibly with surrounding whitespace) when the incoming message
      // closes the conversation (goodnight, that's all, etc.) and there's
      // nothing actionable to respond to. We swallow the literal sentinel
      // (so it doesn't get echoed via iMessage or rendered in chat) and
      // persist a system marker instead, so the agent's next turn sees
      // that the prior turn ended silently. Skipping persistedContent here
      // means lastAssistantTextForIM stays unset, which suppresses the
      // iMessage routing at end-of-turn. Critical for preventing endless
      // back-and-forth chatter on iMessage.
      if (
        persistedContent &&
        result.toolCalls.length === 0 &&
        /^\s*\[no-reply\]\s*$/i.test(persistedContent)
      ) {
        persistedContent = null;
        // Clear the streaming bubble in the dashboard. We need BOTH events:
        //  - chat:chunk done:true ends the bubble's streaming state (without
        //    this the thinking dots stay forever, since the normal done:true
        //    at line ~923 only fires when persistedContent or tools exist).
        //  - chat:message with empty content tells the dashboard to drop the
        //    bubble entirely so the chat doesn't show an empty assistant row.
        broadcast({
          type: 'chat:chunk',
          agentId,
          messageId,
          content: '',
          done: true,
        });
        broadcast({
          type: 'chat:message',
          agentId,
          message: {
            id: messageId, agentId, role: 'assistant' as const,
            content: '',
            tokenCount: null, modelId: null, cost: null, latencyMs: null,
            createdAt: new Date().toISOString(),
          },
        });
        const sysId = uuidv4();
        const sysContent = '[Agent ended turn without replying — conversation closed]';
        try {
          db.prepare(`
            INSERT OR IGNORE INTO messages (id, agent_id, role, content, turn_number, created_at)
            VALUES (?, ?, 'system', ?, ?, datetime('now'))
          `).run(sysId, agentId, sysContent, turnNumber);
          broadcast({
            type: 'chat:message',
            agentId,
            message: {
              id: sysId, agentId, role: 'system' as const,
              content: sysContent,
              tokenCount: null, modelId: null, cost: null, latencyMs: null,
              createdAt: new Date().toISOString(),
            },
          });
        } catch (err) {
          logger.warn('v2: failed to persist no-reply marker', {
            agentId, error: err instanceof Error ? err.message : String(err),
          }, agentId);
        }
        logger.info('v2: agent ended turn silently via [no-reply] sentinel', {
          agentId, loopCount: state.loopCount,
        }, agentId);
      }

      // ── XML-fallback detection (matches v1 runtime.ts:1240) ──
      // Weak/local models that don't support structured tool calling emit
      // tool calls via the XML text-fallback parser. Their tool IDs are
      // synthetic (`text_tool_*`). Persisting them as structured tool_use
      // blocks would corrupt the next turn — the provider can't reference
      // IDs it didn't generate. Instead we persist text-only, then broadcast
      // a collapsed view with calls + results inline so the user sees them.
      const hasXmlFallbackTools = result.toolCalls.some((tc) =>
        tc.id.startsWith('text_tool_'),
      );

      // Drain attachments queued by show_to_user during prior tool calls
      // in this turn. The runtime owns assistant-message persistence, so
      // we attach here rather than letting the tool insert a synthetic
      // message (which would break tool_use/tool_result alternation).
      // Mirrors v1 runtime.ts:1242-1248.
      const { drainPendingAttachments } = await import('../pending-attachments.js');
      const queuedAttachments = drainPendingAttachments(agentId);
      const queuedAttachmentsJson =
        queuedAttachments.length > 0 ? JSON.stringify(queuedAttachments) : null;

      // Build content for persistence (text + tool_use blocks if any)
      const effectiveModelIdForPersist =
        state.modelId === '__auto__' ? configuredModelId : state.modelId;

      if (result.toolCalls.length > 0 && !hasXmlFallbackTools) {
        const assistantContent: Anthropic.ContentBlockParam[] = [];
        if (persistedContent) {
          assistantContent.push({ type: 'text', text: persistedContent });
        }
        for (const tc of result.toolCalls) {
          assistantContent.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.name,
            input: tc.arguments,
          });
        }
        db.prepare(`
          INSERT OR IGNORE INTO messages (id, agent_id, role, content, attachments, token_count, model_id, cost, latency_ms, turn_number, reasoning_content, created_at)
          VALUES (?, ?, 'assistant', ?, ?, ?, ?, ?, NULL, ?, ?, datetime('now'))
        `).run(
          messageId,
          agentId,
          JSON.stringify(assistantContent),
          queuedAttachmentsJson,
          result.outputTokens,
          effectiveModelIdForPersist,
          null,
          turnNumber,
          result.reasoningContent ?? null,
        );
        broadcast({
          type: 'chat:message',
          agentId,
          message: {
            id: messageId,
            agentId,
            role: 'assistant' as Message['role'],
            content: JSON.stringify(assistantContent),
            tokenCount: null,
            modelId: effectiveModelIdForPersist,
            cost: null,
            latencyMs: null,
            createdAt: new Date().toISOString(),
            attachments: queuedAttachments.length > 0 ? queuedAttachments : undefined,
            reasoningContent: result.reasoningContent ?? undefined,
          },
        });
      } else if (persistedContent) {
        db.prepare(`
          INSERT OR IGNORE INTO messages (id, agent_id, role, content, attachments, token_count, model_id, cost, latency_ms, turn_number, reasoning_content, created_at)
          VALUES (?, ?, 'assistant', ?, ?, ?, ?, ?, NULL, ?, ?, datetime('now'))
        `).run(
          messageId,
          agentId,
          persistedContent,
          queuedAttachmentsJson,
          result.outputTokens,
          effectiveModelIdForPersist,
          null,
          turnNumber,
          result.reasoningContent ?? null,
        );
        if (persistedContent.trim().length > 0) {
          state = advance(state, { lastAssistantTextForIM: persistedContent.trim() });
        }
        // Per v1 runtime.ts:1303-1318 — text-only response. The streaming
        // chunks already delivered the text live, so we'd dupe-render if we
        // unconditionally fired chat:message. With attachments present,
        // however, the dashboard's chat:message handler updates the streaming
        // bubble in-place to ATTACH the files — that's the only way the
        // attachments reach the live UI without a page reload.
        if (queuedAttachments.length > 0) {
          broadcast({
            type: 'chat:message',
            agentId,
            message: {
              id: messageId,
              agentId,
              role: 'assistant' as Message['role'],
              content: persistedContent,
              tokenCount: null,
              modelId: effectiveModelIdForPersist,
              cost: null,
              latencyMs: null,
              createdAt: new Date().toISOString(),
              attachments: queuedAttachments,
            },
          });
        }
      }

      // Broadcast streaming complete (only if we actually streamed something)
      if ((persistedContent && persistedContent.trim().length > 0) || result.toolCalls.length > 0) {
        broadcast({
          type: 'chat:chunk',
          agentId,
          messageId,
          content: '',
          done: true,
          modelId: state.modelId === '__auto__' ? configuredModelId : state.modelId,
        });
      }

      // No tools? Loop is done.
      if (result.toolCalls.length === 0) {
        // Missed-reply nudge (subsumes v1 runtime.ts:1344-1378)
        const replyDecision = a2aReplyEnforcer({
          triggeredByReplyNeededIntent: a2aReplyContext !== null,
          sentToAgentThisTurn: state.sentToAgentThisTurn,
          alreadyNudgedForMissedReply: false, // Phase 2 baseline: fire-once is per-turn implicit
          agentProducedText: !!(persistedContent && persistedContent.trim().length > 0),
          intent: a2aReplyContext?.intent,
          threadShort: a2aReplyContext?.threadShort,
          fromName: a2aReplyContext?.fromName,
        });
        if (replyDecision.decision === 'nudge') {
          const nudgeId = uuidv4();
          db.prepare(`
            INSERT OR IGNORE INTO messages (id, agent_id, role, content, turn_number, created_at)
            VALUES (?, ?, 'system', ?, ?, datetime('now'))
          `).run(nudgeId, agentId, replyDecision.nudgeText, turnNumber);
          broadcast({
            type: 'chat:message',
            agentId,
            message: {
              id: nudgeId, agentId, role: 'system' as const,
              content: replyDecision.nudgeText,
              tokenCount: null, modelId: null, cost: null, latencyMs: null,
              createdAt: new Date().toISOString(),
            },
          });
          // Continue loop so the agent reads the nudge and retries
          continue;
        }
        break;
      }

      // ── Engine-injected ack — DISABLED ──
      //
      // The v2 plan called for an engine-written ack ("Working on it…") to fire
      // when the agent goes straight to a tool call without text. In practice
      // this turned out to be both noise AND structurally broken: the ack was
      // persisted as a system message into the messages table BETWEEN the
      // assistant's tool_use and its matching tool_result — which violates the
      // conversation invariant (tool_use and tool_result must be in adjacent
      // messages). The assembler's defensive `sanitizeToolPairs` would then
      // drop both messages from context, and the model would re-issue the
      // tool call on the next turn because it lost memory of running it.
      //
      // The chat:tool_call broadcast (fired by executePhase below) already
      // serves the "agent is working" signal. The ack adds no information
      // and broke the conversation invariant. Removed 2026-05-04.
      //
      // INVARIANT (Part XIX, sharpened): never insert any persisted message
      // between an assistant tool_use and its matching tool_result. If we
      // ever want a transient "thinking" indicator, it must be broadcast-only,
      // never written to the messages table.
      //
      // The `ackInjector` classifier (agent/v2/classifiers/ack.ts) and its
      // tests are kept for potential future use as a broadcast-only path.

      // ── Tracker enforcer (engine-side insertion, Q22) ──
      // Phase 2 baseline: classifier runs but engine-side task creation is
      // deferred to Phase 4 (where it integrates cleanly with the assembler's
      // session-start scaffolding). For now we just log the decision.
      const trackerDecision = trackerEnforcer({
        plannedTools: result.toolCalls,
        agentHasTrackerTools: state.shouldNudgeTracker,
        trackerToolCalledThisTurn: state.trackerToolCalledThisTurn,
        agentHasInProgressTask: false, // Phase 4: query tracker
      });
      if (trackerDecision.decision === 'create') {
        logger.debug('v2: trackerEnforcer wants to create task (deferred to Phase 4)', {
          agentId,
          reason: trackerDecision.reason,
        }, agentId);
      }

      // ── Phase: execute tools (partitioned) ──
      state = advance(state, { phase: 'execute' });
      const batches = partitionTools(result.toolCalls);
      const turnToolResults: Array<{
        toolCallId: string;
        name: string;
        content: string;
        isError: boolean;
        contentBlocks?: Array<{ type: string; [key: string]: unknown }>;
      }> = [];

      let stoppedMidBatch = false;
      let calledCompleteTask = false;
      let calledImageCreate = false;
      let recentSigs = state.recentToolSignatures;

      outer: for (const batch of batches) {
        if (stoppedMidBatch) break;

        // Per-call processing (used in both parallel and serial paths).
        const runOne = async (tc: ToolCall) => {
          // Loop-break check
          const loopCheck = loopDetector(tc, recentSigs);
          recentSigs = bumpLoopSignature(recentSigs, loopCheck.signature, RECENT_TOOL_WINDOW);
          if (loopCheck.decision === 'block') {
            try {
              broadcast({ type: 'chat:tool_call', agentId, tool: tc.name, args: tc.arguments });
              broadcast({ type: 'chat:tool_result', agentId, tool: tc.name, result: loopCheck.refusalMessage!.slice(0, 500) });
            } catch { /* best effort */ }
            return {
              toolCallId: tc.id,
              name: tc.name,
              content: loopCheck.refusalMessage!,
              isError: true,
            };
          }
          // Broadcast tool call
          try {
            broadcast({ type: 'chat:tool_call', agentId, tool: tc.name, args: tc.arguments });
          } catch { /* best effort */ }
          // Track sentToAgentThisTurn for downstream classifiers
          if (tc.name === 'send_to_agent' || tc.name === 'broadcast_to_group') {
            state = advance(state, { sentToAgentThisTurn: true });
          }
          // Execute (with safety wrapper)
          let toolResult;
          try {
            toolResult = await executeTool(agentId, tc);
            // Transfer content blocks from the tool call (set by file_read for images/PDFs)
            const contentBlocks = (tc as unknown as Record<string, unknown>).__contentBlocks as
              | Array<{ type: string; [key: string]: unknown }>
              | undefined;
            if (contentBlocks) {
              (toolResult as { contentBlocks?: unknown }).contentBlocks = contentBlocks;
            }
          } catch (toolErr) {
            const errMsg = toolErr instanceof Error ? toolErr.message : String(toolErr);
            logger.error('v2: tool crashed', { tool: tc.name, error: errMsg }, agentId);
            toolResult = {
              toolCallId: tc.id,
              name: tc.name,
              content: `Error: Tool "${tc.name}" crashed: ${errMsg}. Try a different approach or skip this step.`,
              isError: true,
            };
          }
          state = advance(state, { toolCallsExecutedThisTurn: state.toolCallsExecutedThisTurn + 1 });
          // Permission denial suggestion appendix
          if (toolResult.isError && toolResult.content.includes('[BLOCKED]')) {
            try {
              const { getAgentPermissions } = await import('../permissions.js');
              const { getFilteredTools } = await import('../tools.js');
              const manifest = getAgentPermissions(agentId);
              const tools = getFilteredTools(agentId);
              const suggestions = permissionAlternativeFinder({
                toolName: tc.name,
                toolArgs: (tc.arguments ?? {}) as Record<string, unknown>,
                denyReason: toolResult.content,
                manifest,
                hasSendToAgent: tools.some((t) => t.name === 'send_to_agent'),
                hasCompleteTask: tools.some((t) => t.name === 'complete_task'),
              });
              if (suggestions.suggestions.length > 0) {
                toolResult = {
                  ...toolResult,
                  content: `${toolResult.content}\n\nAlternatives:\n${suggestions.suggestions.map((s) => `  • ${s}`).join('\n')}`,
                };
              }
            } catch { /* best effort */ }
          }
          // Broadcast result
          try {
            broadcast({
              type: 'chat:tool_result',
              agentId,
              tool: tc.name,
              result: toolResult.content.slice(0, 500),
            });
          } catch { /* best effort */ }
          if (tc.name === 'complete_task') calledCompleteTask = true;
          if (tc.name === 'image_create') calledImageCreate = true;
          return toolResult;
        };

        if (batch.category === 'safe') {
          // Parallel execution for safe reads
          const results = await Promise.all(batch.calls.map(runOne));
          turnToolResults.push(...results);
        } else {
          // Serial execution for everything else
          for (const tc of batch.calls) {
            // Stop check between each serial call
            if (stoppedAgents.has(agentId)) {
              stoppedAgents.delete(agentId);
              // Fill synthetic Cancelled for remaining calls (Part XIX preservation)
              const remaining = batch.calls.slice(batch.calls.indexOf(tc));
              for (const rem of remaining) {
                turnToolResults.push({
                  toolCallId: rem.id,
                  name: rem.name,
                  content: 'Cancelled by user (agent stopped).',
                  isError: true,
                });
              }
              stoppedMidBatch = true;
              break outer;
            }
            const r = await runOne(tc);
            turnToolResults.push(r);
          }
        }
      }

      // Update state with new signatures + results
      state = advance(state, {
        recentToolSignatures: recentSigs,
        toolResults: state.toolResults.concat(turnToolResults),
      });

      // ── Persist tool results ──
      // XML-fallback path (matches v1 runtime.ts:1542-1570): collapse tool
      // calls + results into a single plain-text assistant message and
      // broadcast that. The DB INSERT is IGNORE'd because messageId is the
      // same as the assistant message we already persisted (text-only above);
      // the broadcast carries the user-facing collapsed view. Net effect:
      // model context has plain text only, dashboard shows tool calls + results.
      if (hasXmlFallbackTools) {
        const collapsedParts: string[] = [];
        if (persistedContent) collapsedParts.push(persistedContent);
        for (let i = 0; i < result.toolCalls.length; i++) {
          const tc = result.toolCalls[i];
          const tr = turnToolResults[i];
          const argJson = JSON.stringify(tc.arguments);
          collapsedParts.push(`[Called ${tc.name}: ${argJson}]`);
          if (tr) {
            collapsedParts.push(`[Result${tr.isError ? ' ERROR' : ''}: ${tr.content}]`);
          }
        }
        const collapsedText = collapsedParts.join('\n');
        // Same messageId as the assistant first-persist — INSERT OR IGNORE
        // keeps the original text-only row intact.
        db.prepare(`
          INSERT OR IGNORE INTO messages (id, agent_id, role, content, token_count, model_id, cost, latency_ms, turn_number, created_at)
          VALUES (?, ?, 'assistant', ?, ?, ?, NULL, NULL, ?, datetime('now'))
        `).run(
          messageId,
          agentId,
          collapsedText,
          result.outputTokens,
          effectiveModelIdForPersist,
          turnNumber,
        );
        broadcast({
          type: 'chat:message',
          agentId,
          message: {
            id: messageId,
            agentId,
            role: 'assistant' as Message['role'],
            content: collapsedText,
            tokenCount: null,
            modelId: effectiveModelIdForPersist,
            cost: null,
            latencyMs: null,
            createdAt: new Date().toISOString(),
          },
        });
        logger.info('v2: collapsed XML-fallback tool calls into plain text', {
          toolCount: result.toolCalls.length,
          tools: result.toolCalls.map((tc) => tc.name),
        }, agentId);
      } else {
        // Normal path: persist as a separate `tool` role message with
        // structured tool_result blocks. If a tool result has contentBlocks
        // (e.g. file_read on an image), use those instead of plain string —
        // the model sees the image via vision capabilities.
        const toolMessageId = uuidv4();
        const toolResultContent = turnToolResults.map((tr) => {
          const blocks = (tr as { contentBlocks?: Array<{ type: string; [key: string]: unknown }> }).contentBlocks;
          return {
            type: 'tool_result' as const,
            tool_use_id: tr.toolCallId,
            content: blocks
              ? (blocks as unknown as Anthropic.ToolResultBlockParam['content'])
              : tr.content,
            is_error: tr.isError,
          };
        }) as Anthropic.ToolResultBlockParam[];
        db.prepare(`
          INSERT OR IGNORE INTO messages (id, agent_id, role, content, turn_number, created_at)
          VALUES (?, ?, 'tool', ?, ?, datetime('now'))
        `).run(toolMessageId, agentId, JSON.stringify(toolResultContent), turnNumber);
        broadcast({
          type: 'chat:message',
          agentId,
          message: {
            id: toolMessageId, agentId, role: 'tool' as Message['role'],
            content: JSON.stringify(toolResultContent),
            tokenCount: null, modelId: null, cost: null, latencyMs: null,
            createdAt: new Date().toISOString(),
          },
        });
      }

      clearErrors(agentId);

      if (stoppedMidBatch) {
        setAgentStatus(agentId, 'idle');
        break;
      }

      // ── complete_task / image_create exit conditions (Part XIX) ──
      if (calledCompleteTask) {
        logger.info('v2: complete_task called, exiting loop', { agentId }, agentId);
        break;
      }
      if (calledImageCreate) {
        logger.info('v2: image_create called, exiting loop (async delivery)', { agentId }, agentId);
        break;
      }

      // ── Phase: post-execution gates ──
      state = advance(state, { phase: 'postExecution' });

      // ── Repetition detection (matches v1 runtime.ts:1622-1634) ──
      // If the model produces the SAME text + SAME tool calls as the last
      // iteration, it's stuck. Nudge once. If still repeating, break with
      // STUCK_REPEATING. The loopDetector catches duplicate-tool-call
      // patterns; this catches duplicate-FULL-response patterns including
      // text-only responses.
      const currentResponseSig =
        (result.content ?? '') +
        '|' +
        result.toolCalls
          .map((tc) => `${tc.name}:${JSON.stringify(tc.arguments)}`)
          .sort()
          .join(',');
      if (state.lastResponseSig === currentResponseSig) {
        if (!state.nudgedForRepetition) {
          logger.warn('v2: agent repeating itself — nudging on next iteration', {
            loopCount: state.loopCount,
          }, agentId);
          state = advance(state, {
            nudgedForRepetition: true,
            pendingNudge:
              '[System: You are repeating yourself — your last two responses were identical. ' +
              'Try a different approach. If the task is complete, call complete_task or ' +
              'tracker_update_status. If you need help, explain what you are stuck on.]',
          });
          continue;
        }
        logger.warn('v2: breaking tool loop — agent still repeating after nudge', {
          loopCount: state.loopCount,
        }, agentId);
        broadcast({
          type: 'chat:error',
          agentId,
          error: 'Agent got stuck repeating itself. Send a follow-up to redirect it.',
          code: 'STUCK_REPEATING',
          severity: 'warning',
          retryable: true,
        });
        break;
      }
      state = advance(state, { lastResponseSig: currentResponseSig });

      // Permission denial counter
      const allBlocked = turnToolResults.every((tr) => tr.isError && tr.content.includes('[BLOCKED]'));
      if (allBlocked && turnToolResults.length > 0) {
        state = advance(state, {
          consecutivePermissionDenials: state.consecutivePermissionDenials + turnToolResults.length,
        });
      } else if (turnToolResults.length > 0) {
        state = advance(state, { consecutivePermissionDenials: 0 });
      }

      // ── No-results detection (matches v1 runtime.ts:1658-1678) ──
      // When search tools (vault_search, memory_grep, web_search, etc.)
      // repeatedly return "No results found" / "not in memory", the agent
      // is probably looking for something that doesn't exist. Nudge once,
      // then break with a NO_RESULTS error if it persists.
      const allNoResults =
        turnToolResults.length > 0 &&
        turnToolResults.every(
          (tr) =>
            tr.content.includes('No results found') ||
            tr.content.includes('not in memory'),
        );
      if (allNoResults && turnToolResults.every((tr) => !tr.isError)) {
        const nextNoResultsCount = state.consecutiveNoResultTools + 1;
        if (nextNoResultsCount >= 2) {
          if (!state.nudgedForNoResults) {
            logger.warn('v2: consecutive empty search results — nudging on next iteration', {
              loopCount: state.loopCount,
              consecutiveNoResultTools: nextNoResultsCount,
            }, agentId);
            state = advance(state, {
              nudgedForNoResults: true,
              pendingNudge:
                '[System: Multiple searches returned no results. The information may not exist in memory. ' +
                'Try responding based on what you already know, or ask the user for clarification.]',
              consecutiveNoResultTools: 0,
            });
            continue;
          }
          // Already nudged — break with NO_RESULTS error
          logger.warn('v2: breaking tool loop — still no results after nudge', {
            loopCount: state.loopCount,
          }, agentId);
          broadcast({
            type: 'chat:error',
            agentId,
            error: 'Agent stopped — searches kept coming up empty. The info may not be in memory yet.',
            code: 'NO_RESULTS',
            severity: 'warning',
            retryable: true,
          });
          break;
        }
        state = advance(state, { consecutiveNoResultTools: nextNoResultsCount });
      } else if (turnToolResults.length > 0) {
        state = advance(state, { consecutiveNoResultTools: 0 });
      }

      // Spinning detection (Part XVIII §F — engine asks model before breaking)
      const progressDecision = progressClassifier({
        toolCallsExecutedThisTurn: state.toolCallsExecutedThisTurn,
        consecutiveSmallDeltas: 0, // Phase 4 will track this
        consecutivePermissionDenials: state.consecutivePermissionDenials,
        consecutiveNoResultTools: 0, // Phase 4 will track this
        spinningNudgeCount: state.spinningNudgeCount,
        loopCount: state.loopCount,
      });
      if (!progressDecision.progressing) {
        // If we've already nudged 3 times and the agent kept going, break.
        if (progressDecision.signals?.includes('nudge cap')) {
          logger.warn('v2: spinning nudge cap reached — breaking', { agentId }, agentId);
          break;
        }
        // Otherwise inject a nudge and continue once.
        const nudgeText = buildSpinningNudge({
          toolCallsExecutedThisTurn: state.toolCallsExecutedThisTurn,
          consecutiveSmallDeltas: 0,
          consecutivePermissionDenials: state.consecutivePermissionDenials,
          consecutiveNoResultTools: 0,
          spinningNudgeCount: state.spinningNudgeCount,
          loopCount: state.loopCount,
        });
        const nudgeId = uuidv4();
        db.prepare(`
          INSERT OR IGNORE INTO messages (id, agent_id, role, content, turn_number, created_at)
          VALUES (?, ?, 'system', ?, ?, datetime('now'))
        `).run(nudgeId, agentId, nudgeText, turnNumber);
        broadcast({
          type: 'chat:message',
          agentId,
          message: {
            id: nudgeId, agentId, role: 'system' as const,
            content: nudgeText,
            tokenCount: null, modelId: null, cost: null, latencyMs: null,
            createdAt: new Date().toISOString(),
          },
        });
        state = advance(state, { spinningNudgeCount: state.spinningNudgeCount + 1 });
      }

      // Loop continues — model will see tool results and respond
    }

    if (state.loopCount >= MAX_TOOL_LOOPS) {
      // Matches v1 runtime.ts:1683-1707. Hit the soft tool-loop cap but
      // (presumably) still making progress — auto-continue with a fresh
      // turn instead of dead-stopping. The continuity brief + tracker
      // tasks let the agent pick up where they left off.
      logger.warn('v2 hit MAX_TOOL_LOOPS — auto-continuing with fresh turn', {
        agentId, maxLoops: MAX_TOOL_LOOPS,
      }, agentId);
      const sysMsg = (
        `[System: This turn reached ${MAX_TOOL_LOOPS} tool calls. Starting a fresh turn ` +
        `to continue your work. Pick up where you left off.]`
      );
      const sysMsgId = uuidv4();
      db.prepare(`
        INSERT OR IGNORE INTO messages (id, agent_id, role, content, turn_number, created_at)
        VALUES (?, ?, 'system', ?, ?, datetime('now'))
      `).run(sysMsgId, agentId, sysMsg, turnNumber);
      broadcast({
        type: 'chat:message',
        agentId,
        message: {
          id: sysMsgId, agentId, role: 'system' as const,
          content: sysMsg,
          tokenCount: null, modelId: null, cost: null, latencyMs: null,
          createdAt: new Date().toISOString(),
        },
      });
      // Schedule a self-continuation. Reassembles context fresh — the agent
      // sees its full history including the work it just did and continues
      // naturally. 1s delay lets DB writes settle.
      setTimeout(() => {
        try {
          getAgentRuntime().handleMessage(agentId, '').catch((err) => {
            logger.error('v2 auto-continuation after tool limit failed', {
              agentId, error: err instanceof Error ? err.message : String(err),
            }, agentId);
          });
        } catch (err) {
          logger.error('v2 auto-continuation failed to schedule', {
            agentId, error: err instanceof Error ? err.message : String(err),
          }, agentId);
        }
      }, 1000);
    }

    // ── Phase: finalize ──
    state = advance(state, { phase: 'finalize' });

    // ── iMessage routing (Part XIX preservation, matches v1 runtime.ts:1688-1747) ──
    // Two paths can send a response via iMessage:
    //   1. The turn was triggered by an iMessage → reply goes back via iMessage
    //   2. User is "away from the dojo" → all primary responses forward via iMessage
    // In EITHER case, persist a `[SENT VIA IMESSAGE to <owner>]` system tag
    // so the agent (next turn) and user (chat feed) both see the routing
    // happened. v1 had a `sentViaIMessage` flag for this; v2 mirrors it.
    if (isPrimaryAgent(agentId) && state.lastAssistantTextForIM) {
      let sentViaIMessage = false;
      try {
        if (triggeredByIMessage || imFlagSetAtRunStart) {
          sendResponseViaIMessage(state.lastAssistantTextForIM, agentId);
          sentViaIMessage = true;
        } else {
          const { getPresence, maybeForwardToImessage } = await import('../../services/presence.js');
          if (getPresence() === 'away') {
            maybeForwardToImessage(agentId, state.lastAssistantTextForIM);
            sentViaIMessage = true;
          }
        }

        if (sentViaIMessage) {
          const tagId = uuidv4();
          const { getOwnerName } = await import('../../config/platform.js');
          const tagContent = `[SENT VIA IMESSAGE to ${getOwnerName()}]`;
          db.prepare(`
            INSERT OR IGNORE INTO messages (id, agent_id, role, content, turn_number, created_at)
            VALUES (?, ?, 'system', ?, ?, datetime('now'))
          `).run(tagId, agentId, tagContent, turnNumber);
          broadcast({
            type: 'chat:message',
            agentId,
            message: {
              id: tagId, agentId, role: 'system' as const,
              content: tagContent,
              tokenCount: null, modelId: null, cost: null, latencyMs: null,
              createdAt: new Date().toISOString(),
            },
          });
        }
      } catch (err) {
        logger.warn('v2: iMessage routing failed', {
          agentId,
          error: err instanceof Error ? err.message : String(err),
        }, agentId);
      }
    }
    if (imFlagSetAtRunStart) clearIMResponseFlag(agentId);

    stopStatusHeartbeat(agentId);

    // Clean turn end — clear the in-loop recovery streak. The agent reached
    // a natural exit without further recovery, so any prior recovery
    // attempts are presumed resolved (matches v1 runtime.ts:1404).
    recoveryRunStreak.delete(agentId);

    // Set agent back to idle (unless terminated)
    const currentAgent = db.prepare('SELECT status FROM agents WHERE id = ?').get(agentId) as
      | { status: string }
      | undefined;
    if (currentAgent && currentAgent.status !== 'terminated') {
      setAgentStatus(agentId, 'idle');
    }

    // Reset the persisted recovery_attempts counter on a successful turn.
    // Pre-2026-05-06 the counter only reset inside reset_session, so 3
    // transient errors spread over weeks would silently accumulate and
    // permanently suppress the Healer for the agent until the user
    // manually intervened. Only fire onAgentRecovered when attempts > 0
    // (there was actually something to recover from) to avoid spamming
    // the "recovered" toast on every healthy turn.
    if (currentAgent && currentAgent.status !== 'terminated') {
      try {
        const attemptsRow = db
          .prepare('SELECT recovery_attempts FROM agents WHERE id = ?')
          .get(agentId) as { recovery_attempts: number | null } | undefined;
        if ((attemptsRow?.recovery_attempts ?? 0) > 0) {
          const { onAgentRecovered } = await import('../../healer/injury-recovery.js');
          onAgentRecovered(agentId);
        }
      } catch { /* best effort */ }
    }

    // Post-turn checks (preserved)
    try {
      checkTimeouts();
    } catch (err) {
      logger.error('v2: post-turn timeout check failed', {
        error: err instanceof Error ? err.message : String(err),
      }, agentId);
    }

    // Compaction is rare in v2 (Part V). For Phase 2 we skip the post-turn
    // call entirely — the pre-call compactionGate (added in Phase 4) will
    // handle it. v1's post-turn compaction call was the failure mode this
    // whole architecture is fixing.
  } catch (err) {
    // Best-effort cleanup before recovery so heartbeats / abort controllers
    // don't keep firing while the recovery cascade does its DB writes.
    stopStatusHeartbeat(agentId);
    activeAbortControllers.delete(agentId);

    // Phase 6 (2026-05-04) — v2 now owns its own recovery cascade.
    // recoverFromError handles all side effects: context-overflow recovery,
    // recoverable provider 4xx (with streak cap + system note), or generic
    // injury (recordError + last_error + healer notification + chat:error).
    //
    // No re-throw — handleMessage's outer catch is now a no-op for v2 errors,
    // and any exception escaping recoverFromError is itself logged but
    // swallowed (the agent is already in a degraded state; throwing further
    // would double-handle).
    try {
      const { recoverFromError } = await import('./recovery.js');
      await recoverFromError(state, err);
    } catch (recovErr) {
      logger.error('v2 recovery cascade itself threw — swallowing to avoid double-handle', {
        agentId,
        recoveryError: recovErr instanceof Error ? recovErr.message : String(recovErr),
        originalError: err instanceof Error ? err.message : String(err),
      }, agentId);
    }
  }
}
