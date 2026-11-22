import { dropEmptyMessages } from './drop-empty.js';
import type Anthropic from '@anthropic-ai/sdk';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { type PromptTurnContext } from '../prompt/assembler.js';
import { getModelOutputCap, getProviderCeilingTokens } from '../agent/model.js';
import { agentTurnWindow } from '../router/router-window.js';
import { repairToolPairing, type PairedMessage } from '../agent/tool-pairing.js';
import { measureAgentToolPayloadTokens } from '../tools/tool-docs.js';
import { getRecentMessages, getMessagesByIds } from './store.js';
import {
  eventAddressee, labelRows, labelText, lastViewedTriggerSeq, renderRowLabel, withSubjectKinds,
} from './row-label.js';
import { LabelFacts } from './summary-subject.js';
import { renderSummariesLane, truncateSummariesLane, type SummariesPayload } from './summaries-lane.js';
import { freshTailHorizon, groupsToDropForBudget, maxTrimUnits, tailTrimBlockGroups } from './tail-horizon.js';
import {
  estimateTokens, contextWindowPolicy, assertSystemPromptFits, SystemPromptTooLargeError,
  SUMMARY_SHARE, storedRowCost,
} from './budget.js';
import { readCall, toolResultView } from './tool-result-view.js';
import { overRoomRowView } from './kept-row-view.js';
import { chargeTurnAttachments } from './turn-attachments.js';
import { noteWindowHolds, reportStarvedWindow } from './window-starvation-card.js';
import {
  fitLanes,
  laneLimit,
  renderScaffoldingAck,
  renderTokens,
  truncateTextLane,
  LANE_PRIORITY,
  POST_BUDGET_LANES,
  reserveLadderFor,
  LANE_TRUNCATION_MARKER,
  LOOP_TAIL_EXTRA_STEP_TOKENS,
  type AllocationReport,
  type Lane,
  type LaneCandidate,
  type LaneMessage,
  type LaneRender,
} from './lanes.js';
import { tagMessageLane, tagMessageLanes, collectMessageLaneIds } from './message-lane-tag.js';
import { getContextSummaries } from './dag.js';
import { cachedToolPayloadTokens, toolSurfaceKey } from './assembled-estimate-cache.js';
import { buildRecallLaneMessage } from './recall-lane.js';
// The work-board blocks live in their own module so a post-budget lane can derive its reserve by calling its
// renderer.
import { buildWorkBoardLane } from './work-board-lane.js';
import { otherThreadsReserveExtra } from './other-threads-lane.js';
import { otherThreadsRoomTokens } from './other-threads-room.js';
import { buildIntegrationStatusLane } from './integration-status-lane.js';
import { todaysBriefing } from './briefing.js';
import { joinOrderFor } from '../agent/a2a-transport.js';
import { askIdForMessage } from '../work/store.js';
import { pinnedContextSection } from '../vault/retrieval.js';
import { keepsNoSummaries, pmViewParts } from './pm-view.js';
import { buildAssemblyContext, assembleSystemFromRegistry } from '../prompt/registry/assembler.js';
import { MessageSlot, type AssemblyTurnState } from '../prompt/registry/types.js';
import { turnBoundary } from '../agent/turn-state.js';
// ALIASED: `turnContext` already means `PromptTurnContext` (an assembly's per-turn inputs) in this file.
// This one is the turn's own ambient facts.
import { turnContext as liveTurnContext } from '../agent/turn-context.js';
import type { Summary } from './dag.js';
import type { Message } from '@dojo/shared';
import { parseTechniqueFreshRead, parseWorkingNote } from '@dojo/shared';

const logger = createLogger('memory-assembler');


// Raw tool results are capped at assembly time so one oversized result cannot dominate context; the number
// and cut note live in `./tool-result-view.ts`, shared by both cap sites and the paging tool.

// After this many turns a tool_result becomes a stub (the vault is the long-term memory), decided at the
// next compaction boundary (`compaction.ts stubOldToolResultsAtBoundary`).
export const V2_STUB_AFTER_TURNS = 12;

// Summaries naming a technique freshly re-read this session describe its old version, so they become a stub.


function extractFreshlyReadTechniques(messages: Message[]): Set<string> {
  const names = new Set<string>();
  for (const m of messages) {
    if (m.role !== 'tool') continue;
    let blocks: unknown;
    try {
      blocks = JSON.parse(m.content);
    } catch {
      continue;
    }
    if (!Array.isArray(blocks)) continue;
    for (const block of blocks) {
      const b = block as { type?: string; content?: unknown };
      if (b.type !== 'tool_result' || typeof b.content !== 'string') continue;
      const name = parseTechniqueFreshRead(b.content);
      if (name) names.add(name);
    }
  }
  return names;
}

/** Tool rows for the technique scrub, read over the whole session (not a scrolling window) under a row
 *  limit. */
function sessionToolRows(agentId: string): Message[] {
  const db = getDb();
  const sessionRow = db.prepare('SELECT session_started_at FROM agents WHERE id = ?')
    .get(agentId) as { session_started_at: string | null } | undefined;
  const cap = laneLimit('lane.summaries', 'rows', 'scrubWindow');
  const boundary = sessionRow?.session_started_at ?? null;
  const rows = boundary
    ? db.prepare(
        `SELECT id, content FROM messages
          WHERE agent_id = ? AND role = 'tool' AND created_at >= (unixepoch(?) * 1000)
          ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      ).all(agentId, boundary, cap)
    : db.prepare(
        `SELECT id, content FROM messages
          WHERE agent_id = ? AND role = 'tool'
          ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      ).all(agentId, cap);
  return (rows as Array<{ id: string; content: string }>)
    .map((r) => ({ ...r, role: 'tool' })) as unknown as Message[];
}

interface SummaryLike { id: string; content: string; tokenCount: number; }

function scrubSummariesAgainstFreshTechniques<S extends SummaryLike>(
  summaries: S[],
  freshTechniqueNames: Set<string>,
): S[] {
  if (freshTechniqueNames.size === 0) return summaries;
  const lowered = [...freshTechniqueNames].map((n) => n.toLowerCase());
  return summaries.map((s) => {
    const contentLower = s.content.toLowerCase();
    const mentionedNames = lowered.filter((n) => contentLower.includes(n));
    if (mentionedNames.length === 0) return s;
    const displayNames = [...freshTechniqueNames].filter((n) =>
      mentionedNames.includes(n.toLowerCase()),
    );
    const stub =
      `[STALE SUMMARY CLEARED by engine], this summary referenced technique${displayNames.length === 1 ? '' : 's'} ` +
      `"${displayNames.join('", "')}" which you have just read freshly in this session. ` +
      `Summaries describe a PRIOR version of the technique and may reference scripts, workflows, or steps ` +
      `that no longer exist on disk. Use the current technique_read result as the source of truth, do NOT ` +
      `paraphrase from this summary or assume "last time we did X" still applies. If you need detail from ` +
      `the technique, call technique_read again. Original summary was ${s.content.length} chars.`;
    return { ...s, content: stub, tokenCount: estimateTokens(stub) };
  });
}



// `reasoningContent` is declared here, on `LaneMessage` (`lanes.ts`) and on `ModelCallParams` (`model.ts`),
// so assembly cannot drop it unseen: a drop is a type error.
type LoopMsg = {
  role: 'user' | 'assistant';
  content: string | Anthropic.ContentBlockParam[];
  reasoningContent?: string;
};

// Each text message carries its own recorded time as its row label (`memory/row-label.ts labelRows`), so the
// model can compute elapsed time. A row renders byte-identically each call (created_at and the box timezone
// are stable; the date and year are always included), so the cached prefix is unaffected. Tool results stay
// bare.

// `normalizeCreatedAtUtc` and `renderMessageTimeStamp` live in `memory/message-stamp.ts` and are re-exported
// here; `agent/v2/outbound-ledger.ts`, `work/obligations.ts` and `memory/deliveries-lane.ts` are upstream of
// this module, so the formatter cannot live here (an import cycle).
import { renderMessageTimeStamp } from './message-stamp.js';
import { answeredMessageId, servedRowsOutOfView } from './served-ask.js';
import { END_OF_HISTORY, endOfHistoryMarker } from './end-of-history.js';
export { renderMessageTimeStamp };

/** Put a row's label before what the model reads: before a text body, or as a leading text block on a
 *  structured row that is not a tool result. No label, or an empty row: untouched. */
export function labelContent(
  content: string | Anthropic.ContentBlockParam[],
  label: string | null,
): string | Anthropic.ContentBlockParam[] {
  if (!label) return content;
  if (typeof content === 'string') return content.length === 0 ? content : `${label} ${content}`;
  if (content.length === 0 || content.some((b) => (b as { type?: string }).type === 'tool_result')) return content;
  return [{ type: 'text', text: label }, ...content];
}

/** Post-combine repairs that make the message array a valid provider request. The pre-combine cap stays
 *  in tail construction; delivery markers and the empty-context fallback run after, on session and
 *  config state. */
function applyIntegrityPass(messages: LoopMsg[], agentId: string, markerText = END_OF_HISTORY): LoopMsg[] {
  pruneOldImageBlocksInPlace(messages, /* maxKeepImages */ 1);
  capLargeToolResultsInPlace(messages);

  // Messages must start with a user role (provider requirement): drop leading assistant and orphan tool_result
  // messages.
  while (messages.length > 0) {
    const first = messages[0];
    if (first.role === 'assistant') {
      messages.shift();
      continue;
    }
    if (first.role === 'user' && Array.isArray(first.content)) {
      const blocks = first.content as Array<{ type?: string }>;
      const allToolResults = blocks.length > 0 && blocks.every(b => b.type === 'tool_result');
      if (allToolResults) {
        messages.shift();
        continue;
      }
    }
    break;
  }

  let merged = mergeConsecutiveRoles(dropEmptyMessages(messages));

  // Self-heal: drop orphaned tool blocks (loud warning if over half). `repairToolPairing` is the array-level
  // repair, the same one the provider boundary runs.
  const prePairingCount = merged.length;
  const pairingRepair = repairToolPairing(merged as unknown as PairedMessage[]);
  if (pairingRepair.strippedToolUse > 0 || pairingRepair.strippedToolResult > 0) {
    logger.warn('Sanitized orphaned tool blocks from context', {
      droppedToolUse: pairingRepair.strippedToolUse,
      droppedToolResult: pairingRepair.strippedToolResult,
      droppedMessages: pairingRepair.droppedMessages,
    }, agentId);
  }
  if (merged.length < prePairingCount / 2 && prePairingCount > 4) {
    logger.error('tool-pairing repair dropped over half the context, possible bug', {
      before: prePairingCount,
      after: merged.length,
      agentId,
    }, agentId);
  }
  if (pairingRepair.droppedMessages > 0) merged = mergeConsecutiveRoles(merged);   // a dropped row can leave two of one role side by side

  // Providers reject a trailing assistant message. Append a neutral engine line instead of popping it: popping
  // deletes the agent's newest delivered answer and the model re-delivers it.
  if (merged.length > 0 && merged[merged.length - 1].role === 'assistant') {
    merged.push(tagMessageLane({
      role: 'user',
      content: markerText,
    }, 'lane.engine-end-of-history'));
  }

  return merged;
}

export interface AssembledContext {
  systemPrompt: string;
  // A system-side lane for volatile per-turn content, rendered after the cached system block; stays empty.
  systemVolatile: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string | Anthropic.ContentBlockParam[]; reasoningContent?: string }>;
  systemEntryIds?: (string | null)[];
  messageEntryIds?: (string | null)[];
  /** Rows out of the live view: the trim's whole-group drop plus the horizon's unread rows. They are
   *  persisted and later summarized, so this is live-view loss, not data loss. */
  freshTailDropped?: number;
  /** The newest `messages.seq` this assembly took out of the live view (token trim or the horizon's
   *  unread rows, whichever reaches further); 0/absent when none. `out-of-view.ts` folds the unsummarised
   *  rows at or below it. */
  outOfViewThroughSeq?: number;
  /** Tokens set aside for tool schemas and output, measured; sizes the compaction gate's compressible
   *  budget. */
  reserveTokens?: number;
  /** The allocator's record: one grant per lane (rejected and truncated included) plus over-budget
   *  events. */
  allocation?: AllocationReport;
  /** Assembly is pure: one-shot markers (A2A preempt, Stop) are cleared by the turn that owns them, not
   *  here. */
  consumedOneShotFlags?: ConsumedOneShotFlags;
  /** The recall lane: read here but retrieved against the live ask, so the loop appends it past the cache
   *  boundary as `msg.relevant-memory`. Carried here so one owner decides it, as with `reserveTokens`. */
  recallLane?: string | null;
  /** The vault entries the recall lane rendered; the turn records them as used. */
  recalledVaultIds?: string[];
  /** The open-commitments snapshot, a pure function of the work board; the loop injects it ahead of the
   *  per-ask recall half. */
  openCommitmentsLane?: string | null;
  /** Lanes the loop emits past `volatileFrom` (attempt ledger, active tasks, scratchpad, events):
   *  whatever a tool can mutate must render below the conversation, or a rewritten block re-bills every
   *  token behind it. */
  attemptLedgerLane?: string | null;
  activeTasksLane?: string | null;
  scratchpadLane?: string | null;
  eventsLane?: string | null;
  integrationStatusLane?: string | null;
  view?: ContextView;
}

export interface ConsumedOneShotFlags {
  a2aPreemptPending?: boolean;
  stopMarkerPending?: boolean;
}

export async function assembleContext(
  agentId: string,
  modelId: string,
  turnContext?: PromptTurnContext,
  turnState?: AssemblyTurnState,
): Promise<AssembledContext> {
  return assembleContextViaRegistry(agentId, modelId, turnContext, turnState);
}

async function assembleContextViaRegistry(
  agentId: string,
  modelId: string,
  turnContext?: PromptTurnContext,
  turnState?: AssemblyTurnState,
): Promise<AssembledContext> {
  const ctx = buildAssemblyContext(agentId, modelId, turnContext, turnState);
  const sys = assembleSystemFromRegistry(ctx);
  // The counterparty header and hints render in the msg.turn-context near-tail message, keeping the system
  // prefix stable.
  const systemPrompt = sys.text;
  const built = await assembleMessageContext(agentId, modelId, systemPrompt, turnContext);
  // SPREAD the built result, never re-list its fields: a re-listing wrapper silently drops new ones.
  return { ...built, systemPrompt, systemVolatile: '', systemEntryIds: sys.entryIds };
}


/** Compact awareness-lane gist from a notification's structured inbound_meta (sender + subject) plus a
 *  body preview; null when there is no structured meta, so the caller uses the raw slice. Pure. */
function buildAwarenessGist(inboundMetaRaw: string | null | undefined, rawContent: string): string | null {
  if (!inboundMetaRaw) return null;
  let meta: { sender?: string | null; emailSubject?: string | null } | null = null;
  try {
    meta = JSON.parse(inboundMetaRaw) as { sender?: string | null; emailSubject?: string | null };
  } catch {
    return null;
  }
  const sender = labelText(meta?.sender ?? '', 254);
  const subject = labelText(meta?.emailSubject ?? '', 140);
  if (!sender && !subject) return null;
  const previewMatch = /(?:^|\n)\s*Preview:\s*([^\n]+)/i.exec(rawContent);
  const preview = previewMatch ? previewMatch[1].replace(/\s+/g, ' ').trim() : '';
  const parts: string[] = [];
  if (sender) parts.push(`from ${sender}`);
  if (subject) parts.push(`subject: "${subject}"`);
  if (preview) parts.push(preview.slice(0, 160));
  return parts.join(' | ');
}

// The message context, built from the lane table (`memory/lanes.ts`): the fit's decisions, rejections
// included, land in an `AllocationReport` that also generates the ack.

interface LaneRenderCtx {
  agentId: string;
  modelId: string;
  contextWindow: number;
  policy: ReturnType<typeof contextWindowPolicy>;
  turnContext?: PromptTurnContext;
  tail: () => { freshTail: Message[]; awarenessEvents: Message[] };
  summaries: () => Summary[];
}

const MIN_LANE_FLOOR_TOKENS = 64;

type TailPayload = {
  rows: Message[]; agentId: string; dropped: number;
  /** Owner message(s) a running turn serves that are not among `rows`: emitted verbatim, labelled, at the
   *  front of the tail. */
  served?: Message[];
  droppedThroughSeq?: number;
  /** Rows the EVENTS lane carries; a served trigger among them is in view there and not re-emitted. */
  inEvents?: Array<{ id: string }>;
  charge?: (rows: Message[]) => Message[];
};


function rowTokens(rows: Message[]): number {
  return rows.reduce((t, m) => t + storedRowCost(m), 0);
}

function textRender(content: string | null): LaneRender | null {
  if (!content) return null;
  const messages: LaneMessage[] = [{ role: 'user', content }];
  return { messages, tokens: renderTokens(messages) };
}

/** The summaries lane's ceiling, `min(available * 0.7, 6000)`, read by the lane and the gauge. */
function summariesCeilingFor(contentBudget: number): number {
  return Math.min(Math.floor(contentBudget * SUMMARY_SHARE), laneLimit('lane.summaries', 'tokens', 'relevanceBudget'));
}

// The gauge is the view: `measureView` IS this fit, stopped before the post-budget lanes, so compaction
// knows what the assembler will admit.
export interface ContextView {
  /** The content budget, the live conversation's room in it, the tools/output reserve, the system prompt. */
  budgetTokens: number; tailRoomTokens: number; reserveTokens: number; systemTokens: number;
  /** Summaries admitted and standing, in their stored units. */
  summaryTokens: number; summaryRawTokens: number; summaryCount: number;
  /** The live conversation before the token trim, and what the trim kept (the lane's grant). */
  tailTokens: number; tailKeptTokens: number; tailKeptRows: number;
  /** The newest seq the trim took out of view now; the rows one more trim block of growth would take. */
  outOfViewThroughSeq: number; leavingThroughSeq: number; leavingRows: number; leavingTokens: number;
  /** The protected recent part: the newest whole groups within half the tail's room, never less than the
   *  newest group. */
  protectedFromSeq: number;
}

function viewOf(f: {
  budget: number; cached: number; before: Message[]; kept: Message[]; outOfViewThroughSeq: number;
  summaries?: Summary[]; summariesAdmitted?: Summary[]; summaryGrantTokens?: number;
}, policy: { freshTailCount: number; toolAndOutputReserve: number }, systemTokens: number): ContextView {
  const groups = groupTail(f.before);
  const costs = groups.map((g) => g.tokens);
  const tailTokens = costs.reduce((a, b) => a + b, 0);
  const room = Math.max(0, f.budget - f.cached);
  const block = tailTrimBlockGroups(policy.freshTailCount);
  // One trim block of growth ahead: the fold needs room to finish before the cut. A giant newest row belongs
  // to the in-turn door (`out-of-view.ts`).
  const lead = groups.length > 0 ? block * (tailTokens / groups.length) : 0;
  let from = groups.length - 1;
  for (let i = groups.length - 2, used = costs[groups.length - 1] ?? 0; i >= 0 && used + costs[i] <= room / 2; i--) { used += costs[i]; from = i; }
  // Never into the protected recent part (`from`): no fold, routine or pressure, takes it.
  const next = groupsToDropForBudget(costs, Math.max(0, room - lead), block) > 0 ? Math.min(maxTrimUnits(groups.length, block), from) : 0;
  const leaving = groups.slice(0, next).flatMap((g) => g.messages);
  const sum = (xs: Summary[] | undefined): number => (xs ?? []).reduce((n, x) => n + (x.tokenCount ?? 0), 0);
  return {
    budgetTokens: f.budget, tailRoomTokens: room, reserveTokens: policy.toolAndOutputReserve, systemTokens,
    // The selection's chosen summaries, then the fit cuts the lane's TEXT to its grant: the smaller is sent.
    summaryTokens: Math.min(sum(f.summariesAdmitted), f.summaryGrantTokens ?? 0), summaryRawTokens: sum(f.summaries), summaryCount: f.summaries?.length ?? 0,
    tailTokens, tailKeptTokens: rowTokens(f.kept), tailKeptRows: f.kept.length, outOfViewThroughSeq: f.outOfViewThroughSeq,
    leavingThroughSeq: leaving.length > 0 ? (leaving[leaving.length - 1].rowid ?? 0) : 0,
    leavingRows: leaving.length, leavingTokens: rowTokens(leaving),
    protectedFromSeq: groups.length > 0 ? (groups[from].messages[0].rowid ?? 0) : 0,
  };
}

/** The assembler's own dry run of the view it would send now (`contextWindow` overrides the model's
 *  own). Pure: the fit is a read. */
export async function measureView(
  agentId: string, modelId: string, opts: { contextWindow?: number; turnContext?: PromptTurnContext } = {},
): Promise<ContextView> {
  const sys = assembleSystemFromRegistry(buildAssemblyContext(agentId, modelId, opts.turnContext));
  const dry = await assembleMessageContext(agentId, modelId, sys.text, opts.turnContext, { contextWindow: opts.contextWindow });
  return dry.view!;
}

/** The lane table. Priority is data here only; `slot` is position (the briefing is emitted first and
 *  drops first, see `lanes.ts`). Every entry has a `truncate`, so pressure shortens a lane. */
function buildContentLanes(
  contentBudget: number,
  // The token trim's block size, from this window's own row cap, so one ladder rung's tail is never cut on
  // another's quantum (`memory/tail-horizon.ts`).
  freshTailCount: number,
): Array<Lane<LaneRenderCtx, unknown>> {
  const summariesCeiling = summariesCeilingFor(contentBudget);
  return [
    {
      id: 'lane.briefing',
      slot: MessageSlot.MorningBriefing,
      priority: LANE_PRIORITY['lane.briefing'],
      minTokens: 0,
      maxTokens: Infinity,
      truncate: truncateTextLane,
      // Only a briefing made today renders: yesterday's tells the agent stale news. It drops out once at local
      // midnight; within the day its stamp is its own date, so it holds still. It ranks last (priority 110), so it drops first.
      render: (ctx) => {
        const briefing = todaysBriefing(ctx.agentId);
        return briefing ? textRender(`<briefing generated="${briefing.day}">\n${briefing.content}\n</briefing>`) : null;
      },
    },
    {
      id: 'lane.vault',
      slot: MessageSlot.VaultPull,
      priority: LANE_PRIORITY['lane.vault'],
      minTokens: 0,
      maxTokens: Infinity,
      truncate: truncateTextLane,
      // Pinned and permanent entries and `session_context` entries: session-stable content only. Per-ask retrieval
      // lives in `memory/recall-lane.ts`, in the tail.
      render: async (ctx) => {
        try {
          const sections: string[] = [];
          const pinned = pinnedContextSection(ctx.agentId);
          if (pinned.section) sections.push(pinned.section);
          try {
            const { getSessionContextEntries } = await import('../vault/store.js');
            const sessionCtx = getSessionContextEntries(ctx.agentId);
            const alreadyIncluded = new Set(pinned.entryIds);
            const fresh = sessionCtx.filter((e) => !alreadyIncluded.has(e.id));
            if (fresh.length > 0) {
              const lines = fresh.map((e) => `[${e.type}] ${e.content}`);
              sections.push(
                `═══ SESSION CONTEXT (vault entries tagged session_context) ═══\n${lines.join('\n\n')}\n═══ END SESSION CONTEXT ═══`,
              );
            }
          } catch { /* best effort */ }
          return sections.length > 0 ? textRender(sections.join('\n\n')) : null;
        } catch (err) {
          logger.warn('Vault context injection failed', {
            error: err instanceof Error ? err.message : String(err),
          }, ctx.agentId);
          return null;
        }
      },
    },
    {
      id: 'lane.summaries',
      slot: MessageSlot.Summaries,
      priority: LANE_PRIORITY['lane.summaries'],
      minTokens: 0,
      // The ROOM bounds the lane; `summariesCeiling` only decides how many older summaries ride along, and the
      // newest is never cut to meet it (`memory/summaries-lane.ts`).
      maxTokens: Math.floor(contentBudget * SUMMARY_SHARE),
      truncate: truncateSummariesLane as Lane<LaneRenderCtx, unknown>['truncate'],
      // Newest-first under the ceiling, emitted chronologically, so the set changes only when a summary is written
      // (not ranked by the live ask: a lane ahead of the tail is session-stable).
      render: async (ctx) => renderSummariesLane(ctx.summaries(), ctx.agentId, summariesCeiling),
    },
    // `lane.relevant-memory` and the work-board lanes are post-budget tail lanes (`memory/recall-lane.ts`,
    // `memory/work-board-lane.ts`), each with a reserve derived by calling its own renderer; the recall block is
    // computed here.

    // There is no continuity lane; after a compaction the agent knows its work from the task list and the live
    // conversation.

    // `lane.scratchpad` is a post-budget tail lane too (MessageSlot.ScratchpadTail), since tools rewrite it.

    // `lane.events` is a post-budget tail lane too (`renderEventsLane`): a slice of the tail's awareness rows
    // re-renders as the conversation scrolls.

    {
      id: 'lane.fresh-tail',
      slot: MessageSlot.FreshTail,
      priority: LANE_PRIORITY['lane.fresh-tail'],
      minTokens: MIN_LANE_FLOOR_TOKENS,
      mandatoryFloor: true,
      maxTokens: Infinity,
      truncate: (render, maxTokens) => {
        const p = render.payload as TailPayload;
        let kept = budgetFreshTail(p.rows, maxTokens, tailTrimBlockGroups(freshTailCount));
        // The served owner message is never out of view: if the trim took it (or it sits behind the boundary) it is
        // re-emitted and its cost (attachments via `p.charge`) comes off the rest's room. Served rows share that room:
        // the message the turn answers first, then newest first; what no longer fits shrinks to its kept-row pointer.
        const servedOf = (rows: Message[]): Message[] => {
          const all = (p.charge ?? ((r: Message[]) => r))(servedRowsOutOfView(p.agentId, [...rows, ...(p.inEvents ?? [])]));
          const answered = answeredMessageId(p.agentId);
          let room = maxTokens;
          const shown = new Map([...all].reverse().sort((a, b) => Number(b.id === answered) - Number(a.id === answered))
            .map((m) => { const v = overRoomRowView(m, room); room = Math.max(0, room - rowTokens([v])); return [m.id, v] as const; }));
          return all.map((m) => shown.get(m.id) ?? m);
        };
        let served = servedOf(kept);
        if (served.length > 0) {
          kept = budgetFreshTail(p.rows, Math.max(0, maxTokens - rowTokens(served)), tailTrimBlockGroups(freshTailCount));
          served = servedOf(kept);
        }
        const dropped = Math.max(0, p.rows.length - kept.length);
        // `kept` is a suffix of `rows` (whole groups off the front), so the front cut ends just before it.
        const droppedThroughSeq = Math.max(p.droppedThroughSeq ?? 0, dropped > 0 ? (p.rows[dropped - 1].rowid ?? 0) : 0);
        return tailRender({ rows: kept, agentId: p.agentId, dropped: p.dropped + dropped, droppedThroughSeq, served, inEvents: p.inEvents, charge: p.charge });
      },
      render: (ctx) => {
        const { freshTail, awarenessEvents } = ctx.tail();
        if (freshTail.length === 0) return null;
        const rows = capLargeToolResultStrings(freshTail);
        const inEvents = awarenessEvents.slice(-laneLimit('lane.events', 'rows', 'events'));
        const charge = (r: Message[]): Message[] => chargeTurnAttachments(ctx.agentId, ctx.modelId, r, contentBudget);
        return tailRender({ rows, agentId: ctx.agentId, dropped: 0, served: charge(servedRowsOutOfView(ctx.agentId, [...rows, ...inEvents])), inEvents, charge });
      },
    },
  ];
}

// A round's text that rides with tool calls and is not the turn's answer is demoted to a system
// `[working-note]` row, which never enters model context. Here, at the model's one reader, a demoted note of
// the same turn that precedes an assistant row with `tool_use` and no text is rendered as that row's first
// block, so the model sees its own words. The stored rows do not change (reply floors, routing and the
// dashboard read assistant text), and the render is a pure function of stable rows. A note retired for
// duplicating the answer (`finalize/deferred-recovery.ts`) is skipped.
function demotedNarrationByRow(rows: readonly Message[]): Map<string, string> {
  const out = new Map<string, string>();
  let pending: { turn: number | null | undefined; ids: string[]; texts: string[] } | null = null;
  const candidates: Array<{ rowId: string; noteIds: string[]; texts: string[] }> = [];
  for (const msg of rows) {
    if (msg.role === 'system') {
      const note = parseWorkingNote(msg.content);
      if (note && note.text.trim()) {
        if (!pending || pending.turn !== msg.turnNumber) pending = { turn: msg.turnNumber, ids: [], texts: [] };
        pending.ids.push(msg.id);
        pending.texts.push(note.text.trim());
      }
      continue;
    }
    if (pending && msg.role === 'assistant' && pending.turn === msg.turnNumber) {
      try {
        const parsed: unknown = JSON.parse(msg.content);
        if (Array.isArray(parsed) && parsed.some((b) => (b as { type?: string }).type === 'tool_use')
          && !parsed.some((b) => (b as { type?: string }).type === 'text')) {
          candidates.push({ rowId: msg.id, noteIds: pending.ids, texts: pending.texts });
        }
      } catch { /* plain text: an answer row, never a tool round */ }
    }
    pending = null;
  }
  if (candidates.length === 0) return out;
  const allIds = candidates.flatMap((c) => c.noteIds);
  let retired = new Set<string>();
  try {
    const found = getDb().prepare(`SELECT id FROM messages WHERE retired_at IS NOT NULL AND id IN (${allIds.map(() => '?').join(',')})`).all(...allIds) as Array<{ id: string }>;
    retired = new Set(found.map((r) => r.id));
  } catch { /* unreadable: render every note (the model seeing its words twice is the lesser fault) */ }
  for (const c of candidates) {
    const texts = c.texts.filter((_, i) => !retired.has(c.noteIds[i]));
    if (texts.length > 0) out.set(c.rowId, texts.join('\n\n'));
  }
  return out;
}

/** Convert stored rows into the emitted messages. The lane's cost is the row cost (the unit
 *  `budgetFreshTail` spends); the stamp/parse difference rides inside the post-budget reserve. */
function tailRender(payload: TailPayload): LaneRender<TailPayload> {
  const { rows: paired, silent } = hoistToolResults(payload.rows);
  const narration = demotedNarrationByRow(paired);
  const rows = stubOldToolResults(paired, payload.agentId);
  const labels = labelRows(payload.agentId, rows.filter((m) => !silent.has(m.id)));
  const messages: LaneMessage[] = [];
  // The served owner message(s), verbatim, ahead of the live rows they precede and only when not otherwise in
  // view, so exactly once. It wears the standard row label plus a pronoun-free phrase.
  const served = payload.served ?? [];
  if (served.length > 0) {
    const facts = new LabelFacts(payload.agentId);
    for (const msg of withSubjectKinds(payload.agentId, served)) {
      const label = `${renderRowLabel(msg, facts)} (the message this work is answering)`;
      messages.push({ role: 'user', content: labelContent(parseMessageContent(msg), label) });
    }
  }
  for (const msg of rows) {
    const parsed = parseMessageContent(msg);
    if (msg.role === 'tool') {
      messages.push({ role: 'user', content: parsed as Anthropic.ContentBlockParam[] });
    } else if (msg.role === 'user' || msg.role === 'assistant') {
      const said = msg.role === 'assistant' && !silent.has(msg.id) ? narration.get(msg.id) : undefined;   // the demoted working note (demotedNarrationByRow)
      const own = said !== undefined && Array.isArray(parsed) ? [{ type: 'text' as const, text: said }, ...parsed] : parsed;
      const out: LaneMessage = { role: msg.role, content: labelContent(own, labels.get(msg.id) ?? null) };
      // A row whose reasoning was retired at a compaction boundary renders without it for ever after: the stamp is
      // one-way, so no prefix byte moves between compactions. The text stays on the row.
      if (msg.role === 'assistant' && msg.reasoningContent && !msg.reasoningAgedOut) {
        out.reasoningContent = msg.reasoningContent;
      }
      messages.push(out);
    }
  }
  // Labels ride the uncounted stamp slack, so they stay small: counting them here alone, not in the
  // horizon, rewrites the prefix.
  return { messages, tokens: rowTokens(payload.rows) + rowTokens(payload.served ?? []), payload };
}

/** The PM's view (`memory/pm-view.ts`), fitted in trim priority: the present turn, the task's file, the pinned
 *  memories, then the conversation tail. Nothing leaves it unsummarised: what is not shown stays stored. */
function assemblePMView(a: {
  agentId: string; modelId: string; systemPrompt: string; systemTokens: number; turnContext?: PromptTurnContext;
  policy: ReturnType<typeof contextWindowPolicy>; contentBudget: number; offTheTop: number; dryRun: boolean;
}): AssembledContext {
  const { agentId, policy } = a;
  const block = tailTrimBlockGroups(policy.freshTailCount);
  const v = pmViewParts(agentId, a.turnContext, a.contentBudget, block);
  const present = budgetFreshTail(v.present, v.room, block);
  let left = v.room - rowTokens(present);
  const file = estimateTokens(v.file) <= left ? v.file : '';
  left -= estimateTokens(file);
  const pinned = estimateTokens(v.pinned) <= left ? v.pinned : '';
  left -= estimateTokens(pinned);
  const conversation = chargeTurnAttachments(agentId, a.modelId, v.tail, v.room);
  // What did not fit is said in one line after the conversation, never left out silently; its room is kept first.
  const leftOut = (older: boolean): string => {
    const parts = [v.pinned && !pinned ? 'your pinned memories' : '', v.file && !file ? 'the file of this task' : '', older ? 'older messages of this conversation' : ''];
    return parts.some(Boolean) ? `(Left out of this view to fit: ${parts.filter(Boolean).join(', ')}. They are still stored.)` : '';
  };
  const tail = budgetFreshTail(conversation, Math.max(0, left - estimateTokens(leftOut(true))), block);
  const omitted = leftOut(tail.length < conversation.length);
  if (a.dryRun) {
    const kept = [...tail, ...present];
    const fit = { budget: a.contentBudget, cached: 0, before: kept, kept, outOfViewThroughSeq: 0 };
    const view = viewOf(fit, policy, a.systemTokens);
    return {
      systemPrompt: a.systemPrompt, systemVolatile: '', messages: [], reserveTokens: policy.toolAndOutputReserve,
      view: { ...view, leavingThroughSeq: 0, leavingRows: 0, leavingTokens: 0 },
    };
  }
  const past = tailRender({ rows: tail, agentId, dropped: 0 });
  const now = tailRender({ rows: present, agentId, dropped: 0 });
  tagMessageLanes(past.messages, 'lane.pm-tail');
  tagMessageLanes(now.messages, 'lane.pm-tail');
  const text = (t: string, lane: string): LaneMessage[] =>
    (t ? [tagMessageLane({ role: 'user' as const, content: t }, lane)] : []);
  const messages = applyIntegrityPass(
    [...text(pinned, 'lane.vault'), ...past.messages, ...text(file, 'lane.pm-tail'), ...text(omitted, 'lane.pm-tail'), ...now.messages], agentId,
  );
  const spent = renderTokens(messages);
  const report: AllocationReport = {
    budgetTokens: a.contentBudget,
    reservedTokens: 0,
    spentTokens: spent,
    offTheTopTokens: a.offTheTop,
    grants: [{
      id: 'lane.pm-tail',
      slot: MessageSlot.FreshTail,
      priority: LANE_PRIORITY['lane.fresh-tail'],
      requested: past.tokens + now.tokens,
      granted: spent,
      status: messages.length > 0 ? 'admitted' : 'empty',
      reason: `the board is its memory: pinned memories, ${tail.length} conversation row(s), `
        + `${present.length} row(s) of the present turn`,
    }],
    admittedIds: messages.length > 0 ? ['lane.pm-tail'] : [],
    overBudget: [],
  };
  logger.debug('PM agent context assembled', {
    agentId, systemTokens: a.systemTokens, messageCount: messages.length, viewTokens: spent,
  }, agentId);
  return {
    systemPrompt: a.systemPrompt,
    systemVolatile: '',
    messages,
    messageEntryIds: collectMessageLaneIds(messages),
    freshTailDropped: 0,
    outOfViewThroughSeq: 0,
    reserveTokens: policy.toolAndOutputReserve,
    allocation: report,
    consumedOneShotFlags: {},
  };
}

async function assembleMessageContext(
  agentId: string,
  modelId: string,
  systemPrompt: string,
  turnContext?: PromptTurnContext,
  dryRun?: { contextWindow?: number },   // stop at the fit and report the view (`measureView`)
): Promise<AssembledContext> {
  const contextWindow = dryRun?.contextWindow ?? agentTurnWindow(agentId, modelId);   // an auto agent's one router window
  // One budget: threshold, reserve and ceiling come from `memory/budget.ts`. The reserve is measured; the
  // serving ceiling comes from the join `refuseIfDoomed` trusts (`getModelInfo`), and `null` leaves the budget
  // unchanged.
  const policy = contextWindowPolicy(contextWindow, {
    // A dry run reads the per-surface memo so the tool-payload stringify stays off the measuring path.
    toolPayloadTokens: dryRun ? await cachedToolPayloadTokens(agentId, toolSurfaceKey(agentId, modelId), () => measureAgentToolPayloadTokens(agentId))
      : await measureAgentToolPayloadTokens(agentId),
    maxOutputTokens: getModelOutputCap(modelId),
    providerCeilingTokens: getProviderCeilingTokens(modelId),
  });
  const maxTokens = policy.assemblyBudgetTokens;

  const systemTokens = estimateTokens(systemPrompt);
  // Fail loud rather than assemble a lie: a negative budget would silently yield a one-message context.
  // `reportStarvedWindow` cards the person once per outage; `noteWindowHolds` forgets it when assembly fits.
  if (dryRun) assertSystemPromptFits(systemTokens, policy);   // a dry run reads the refusal, never cards it
  else try {
    assertSystemPromptFits(systemTokens, policy);
    noteWindowHolds(agentId);
  } catch (err) {
    if (err instanceof SystemPromptTooLargeError) reportStarvedWindow(agentId, systemTokens, policy);
    throw err;
  }

  // Reservations taken off the top: the generated ack (slot 1000) and the post-budget lanes. A flat sum would
  // clamp a small window's content budget to zero, so `reserveLadderFor` holds the bound and floor.
  const loopTailExtra = otherThreadsReserveExtra(agentId, liveTurnContext(agentId)?.conversationId ?? null, otherThreadsRoomTokens(maxTokens, systemPrompt))
    + joinOrderTokens(agentId);
  const ladder = reserveLadderFor(maxTokens - systemTokens, loopTailExtra);
  const offTheTop = ladder.offTheTop;
  // The PM's view is fitted to this too: the loop's appends need room.
  const contentBudget = Math.max(0, maxTokens - systemTokens - offTheTop);
  if (keepsNoSummaries(agentId)) {
    return assemblePMView({ agentId, modelId, systemPrompt, systemTokens, turnContext, policy, contentBudget, offTheTop, dryRun: !!dryRun });
  }

  // The scaffolding lanes render unconditionally: a gate firing at session start and for five turns past the
  // continuity-brief horizon gave the prefix two shapes and re-billed the history each flip. `fitLanes`
  // still drops them first under pressure.

  let tailCache: { freshTail: Message[]; awarenessEvents: Message[] } | null = null;
  let horizonSkippedRows = 0;
  let horizonSkippedThroughSeq = 0;
  let summaryCache: Summary[] | null = null;
  const laneCtx: LaneRenderCtx = {
    agentId,
    modelId,
    contextWindow,
    policy,
    turnContext,
    summaries: () => {
      if (summaryCache) return summaryCache;
      const rawSummaries = getContextSummaries(agentId);
      // Scrub summaries describing an earlier version of a technique freshly re-read this session. The window is
      // the session, not the last N rows, so a scrolled-out read cannot bring the stale summary back.
      let freshlyReadTechniques: Set<string> = new Set();
      try {
        freshlyReadTechniques = extractFreshlyReadTechniques(sessionToolRows(agentId));
      } catch { /* best effort, fall back to no scrub */ }
      summaryCache = scrubSummariesAgainstFreshTechniques(rawSummaries, freshlyReadTechniques);
      return summaryCache;
    },
    tail: () => {
      if (tailCache) return tailCache;
      // User messages newer than this turn's start are excluded; they get their own run via the wakeup.
      const turnCutoff = turnBoundary.get(agentId);
      // The tail's front is the compaction boundary, not a scrolling row window (a row cap would re-prefill the
      // cache every turn). `memory/tail-horizon.ts` carries the derivation; the read stops at twice the content
      // budget.
      const horizon = freshTailHorizon(agentId, policy, 2 * contentBudget);
      horizonSkippedRows = horizon.unreadRows;
      horizonSkippedThroughSeq = horizon.unreadRows > 0 && horizon.keepFromSeq > 0 ? horizon.keepFromSeq - 1 : 0;
      // The slack refills the rows `turnCutoff` excludes; the seq filter trims the overreach. With no
      // filter (the floor, `keepFromSeq: 0`) it would add summarised rows beside their summary: ask plain.
      const freshTailRows = getRecentMessages(
        agentId,
        horizon.keepFromSeq > 0 ? horizon.requestRows + policy.freshTailCount : horizon.requestRows,
        turnCutoff,
      );
      const freshTailRaw = withSubjectKinds(agentId, horizon.keepFromSeq > 0
        ? freshTailRows.filter((m) => (m.rowid ?? 0) >= horizon.keepFromSeq)
        : freshTailRows);
      // One tail for every turn kind: every conversation's rows are in view, each labelled with the one it belongs to.
      // EVENTS lane: engine notices and unauthorized human inbound, gisted at 400. This turn's own trigger row stays whole.
      const keepFullId = turnContext?.engineEventKeepFullId ?? null;
      const awarenessEvents = freshTailRaw.filter((m) =>
        m.role === 'user' &&
        (keepFullId ? m.id !== keepFullId : true) &&
        (m.origin?.kind === 'engine' || (m.origin?.kind === 'user' && m.origin?.authorized === false)),
      );
      const awarenessIds = new Set(awarenessEvents.map((m) => m.id));
      tailCache = { freshTail: chargeTurnAttachments(agentId, modelId, freshTailRaw.filter((m) => !awarenessIds.has(m.id)), contentBudget), awarenessEvents };
      return tailCache;
    },
  };

  if (ladder.scaled) {
    logger.warn('Post-budget reserves scaled down: this window cannot hold the full ladder', {
      contextWindow: policy.contextWindow, declaredReserveTokens: ladder.declared,
      reservedTokens: offTheTop, contentBudgetTokens: contentBudget,
      systemPromptTokens: systemTokens,
    }, agentId);
  }

  const lanes = buildContentLanes(contentBudget, policy.freshTailCount);
  const candidates: LaneCandidate[] = [];
  for (const lane of lanes) {
    let render: LaneRender | null = null;
    let renderError: string | null = null;
    try {
      render = (await lane.render(laneCtx)) as LaneRender | null;
    } catch (err) {
      // One bad lane may not fail the whole assembly nor read as "had nothing": the error rides into the grant as
      // `failed`, so the receipt tells a thrown lane from a silent one.
      renderError = err instanceof Error ? err.message : String(err);
      logger.warn('lane render failed', { lane: lane.id, error: renderError }, agentId);
    }
    candidates.push({ lane: lane as Lane, render, renderError });
  }

  const tailBefore = (candidates.find((c) => c.lane.id === 'lane.fresh-tail')?.render?.payload as TailPayload | undefined)?.rows ?? [];
  const { emitted, report } = fitLanes(candidates, contentBudget, { offTheTopTokens: offTheTop });
  report.loopTailExtraTokens = loopTailExtra;

  const ackText = renderScaffoldingAck(report.admittedIds);
  const messages: Array<{ role: 'user' | 'assistant'; content: string | Anthropic.ContentBlockParam[] }> = [];
  let ackEmitted = false;
  const pushAck = () => {
    if (ackEmitted || !ackText) return;
    ackEmitted = true;
    // The ack is generated from the admitted lane ids only (no clock, counts or ids): it sits ahead of the tail
    // boundary, so a volatile byte re-bills every message after it (`lanes.test.ts` pins the purity).
    messages.push(tagMessageLane({ role: 'assistant', content: ackText }, 'lane.scaffolding-ack'));
    report.grants.push({
      id: 'lane.scaffolding-ack',
      slot: MessageSlot.ScaffoldingAck,
      priority: LANE_PRIORITY['lane.scaffolding-ack'],
      requested: estimateTokens(ackText),
      granted: estimateTokens(ackText),
      status: 'admitted',
      reason: `generated from ${report.admittedIds.length} admitted lane(s); reserved off the top`,
    });
  };
  for (const e of emitted) {
    if (e.slot > MessageSlot.ScaffoldingAck) pushAck();
    // Tagged here, the one door every lane's output passes, so a new lane can never arrive untagged.
    tagMessageLanes(e.messages, e.id);
    messages.push(...e.messages);
  }
  pushAck();

  // The current time is not injected here: volatile per call, it would break caching for the history. It is
  // the last engine message in the loop (msg.current-time), after the tail.

  const tailGrant = report.grants.find((g) => g.id === 'lane.fresh-tail');
  const tailPayload = (candidates.find((c) => c.lane.id === 'lane.fresh-tail')?.render?.payload ?? null) as TailPayload | null;
  const freshTailDropped = (tailPayload?.dropped ?? 0) + horizonSkippedRows;
  const outOfViewThroughSeq = Math.max(tailPayload?.droppedThroughSeq ?? 0, horizonSkippedThroughSeq);
  if (dryRun) {
    const summaryGrant = report.grants.find((g) => g.id === 'lane.summaries');
    return { systemPrompt, systemVolatile: '', messages: [], reserveTokens: policy.toolAndOutputReserve, view: viewOf({
      budget: contentBudget, before: tailBefore, kept: tailPayload?.rows ?? [], outOfViewThroughSeq,
      cached: report.grants.filter((g) => g.slot < MessageSlot.FreshTail).reduce((n, g) => n + g.granted, 0),
      summaries: laneCtx.summaries(), summaryGrantTokens: summaryGrant?.granted ?? 0,
      summariesAdmitted: (candidates.find((c) => c.lane.id === 'lane.summaries')?.render?.payload as SummariesPayload | undefined)?.chosen ?? [],
    }, policy, systemTokens) };
  }

  const merged = applyIntegrityPass(messages, agentId, endOfHistoryMarker(agentId, tailPayload?.rows ?? []));

  const postBudget: string[] = [];
  const consumedOneShotFlags: ConsumedOneShotFlags = {};

  // Guard: with zero messages after filtering, pull the last user message from the DB so the agent sees what
  // to answer. Respect session_started_at, or a pre-reset message makes it call reset_session again.
  let fallbackLabel: { msg: LoopMsg; label: string | null } | null = null;
  if (merged.length === 0) {
    postBudget.push('lane.empty-context-fallback');
    try {
      const db = getDb();
      const sessionRow = db.prepare(
        'SELECT session_started_at FROM agents WHERE id = ?',
      ).get(agentId) as { session_started_at: string | null } | undefined;
      const sessionBoundary = sessionRow?.session_started_at ?? null;

      const baseConditions = [
        'agent_id = ?',
        "role = 'user'",
        "content NOT LIKE '[System:%'",
        "content NOT LIKE '%reset_session%'",
      ];
      const params: unknown[] = [agentId];
      if (sessionBoundary) {
        baseConditions.push('created_at >= (unixepoch(?) * 1000)');
        params.push(sessionBoundary);
      }
      const sql = `SELECT id, content FROM messages WHERE ${baseConditions.join(' AND ')} ORDER BY created_at DESC, rowid DESC LIMIT 1`;
      const lastUserMsg = db.prepare(sql).get(...params) as { id: string; content: string } | undefined;

      if (lastUserMsg) {
        logger.error('Context assembly produced 0 messages after filtering, recovering last user message', {
          agentId,
        }, agentId);
        // The last resort wears the standard row label like every other row, so the model is never handed an
        // unlabelled message. Applied after the markers below are prepended, so the label stays at the start.
        const [row] = withSubjectKinds(agentId, getMessagesByIds([lastUserMsg.id]));
        const msg = tagMessageLane({ role: 'user' as const, content: row ? overRoomRowView(row, contentBudget).content : lastUserMsg.content }, 'lane.empty-context-fallback');   // never whole over the room
        fallbackLabel = { msg, label: row ? `${renderRowLabel(row, new LabelFacts(agentId))} (recovered: the last message sent to you)` : null };
        merged.push(msg);
      } else if (sessionBoundary) {
        logger.info('Context assembly: post-reset with no user message after boundary, returning empty for clean idle', {
          sessionBoundary, agentId,
        }, agentId);
      } else {
        logger.error('Context assembly produced 0 messages after filtering and no recoverable user message', {
          agentId,
        }, agentId);
        merged.push(tagMessageLane({ role: 'user', content: 'Continue with your current task.' }, 'lane.empty-context-fallback'));
      }
    } catch {
      merged.push({ role: 'user', content: 'Continue with your current task.' });
    }
  }

  try {
    const db = getDb();
    const sessionRow = db.prepare('SELECT session_started_at FROM agents WHERE id = ?').get(agentId) as { session_started_at: string | null } | undefined;
    if (sessionRow?.session_started_at) {
      const assistantInSession = db.prepare(
        "SELECT COUNT(*) as cnt FROM messages WHERE agent_id = ? AND role = 'assistant' AND created_at >= (unixepoch(?) * 1000)",
      ).get(agentId, sessionRow.session_started_at) as { cnt: number };
      if (assistantInSession.cnt === 0 && merged.length > 0 && merged[merged.length - 1].role === 'user') {
        const lastMsg = merged[merged.length - 1];
        if (typeof lastMsg.content === 'string') {
          postBudget.push('lane.new-session');
          lastMsg.content = `[New Session] Your previous conversation history has been archived. You still have access to your long-term memory via vault_search. You DO NOT have the detailed conversation from before, only summaries. If the user references something specific from before, use vault_search to find it.\n\n${lastMsg.content}`;
        }
      }
    }
  } catch { /* session_started_at column may not exist yet */ }

  try {
    const db = getDb();
    const row = db.prepare('SELECT config FROM agents WHERE id = ?').get(agentId) as { config: string } | undefined;
    if (row?.config) {
      const config = JSON.parse(row.config) as Record<string, unknown>;

      if (config.a2aPreemptPending && typeof config.a2aPreemptPending === 'object') {
        const p = config.a2aPreemptPending as {
          fromName?: string; intent?: string; threadShort?: string; recentCount?: number;
        };
        const fromName = p.fromName ?? 'another agent';
        const intent = p.intent ?? 'message';
        const threadShort = p.threadShort ?? '';
        const recentCount = typeof p.recentCount === 'number' ? p.recentCount : 1;

        const stormHint = recentCount >= 3
          ? ` ${fromName} has interrupted you ${recentCount}x in the last 5 minutes, if this looks like ping-pong (you keep responding, they keep asking), KEEP YOUR REPLY EXTREMELY TERSE (one sentence max) so the back-and-forth burns out and you can return to the original work.`
          : '';

        const PREEMPT_MARKER = (
          `[Context note: ${fromName} interrupted your turn with a [A2A:${intent}] message on thread ${threadShort}, that's the message right below this note. ` +
          `Handle it now: respond via send_to_agent on the same thread (or take whatever action they're asking for). ` +
          `Your prior tool work was aborted mid-flight, so the most recent tool_use in your fresh tail may NOT have a matching tool_result yet, if you need that result to continue, re-call the tool. ` +
          `After dealing with this interruption, resume the work you were on before.${stormHint}]`
        );

        if (merged.length > 0 && merged[merged.length - 1].role === 'user') {
          const lastMsg = merged[merged.length - 1];
          if (typeof lastMsg.content === 'string') {
            lastMsg.content = `${PREEMPT_MARKER}\n\n${lastMsg.content}`;
          } else if (Array.isArray(lastMsg.content)) {
            lastMsg.content = [
              { type: 'text', text: PREEMPT_MARKER } as Anthropic.TextBlockParam,
              ...(lastMsg.content as Anthropic.ContentBlockParam[]),
            ];
          }
          postBudget.push('lane.a2a-preempt');
          consumedOneShotFlags.a2aPreemptPending = true;
        }
      }

      if (config.stopMarkerPending) {
        // The marker is PREPENDED to the user's message, so it must not say "the next user message" (weaker models
        // read that as "wait for one to arrive"). It names the stopped request when Stop ended one.
        const words = typeof config.stopMarkerPending === 'string' ? (getDb().prepare("SELECT replace(substr(m.content, 1, 160), char(10), ' ') AS w FROM work a JOIN messages m ON m.id = a.root_id WHERE a.id = ?").get(config.stopMarkerPending) as { w: string } | undefined)?.w : undefined;
        const STOP_MARKER = `[Context note: your previous work${words ? ` on "${words}"` : ''} was stopped, and that request is ended. Do not resume it, retry its last action or send what it was writing. Answer what is in front of you now on its own.]`;
        if (merged.length > 0 && merged[merged.length - 1].role === 'user') {
          const lastMsg = merged[merged.length - 1];
          if (typeof lastMsg.content === 'string') {
            lastMsg.content = `${STOP_MARKER}\n\n${lastMsg.content}`;
          } else if (Array.isArray(lastMsg.content)) {
            lastMsg.content = [
              { type: 'text', text: STOP_MARKER } as Anthropic.TextBlockParam,
              ...(lastMsg.content as Anthropic.ContentBlockParam[]),
            ];
          }
          postBudget.push('lane.stop-marker');
          consumedOneShotFlags.stopMarkerPending = true;
        }
      }
    }
  } catch { /* config may not exist or be malformed */ }

  if (fallbackLabel) fallbackLabel.msg.content = labelContent(fallbackLabel.msg.content, fallbackLabel.label);

  // The recall lane: computed here, emitted by the loop past `volatileFrom`. Best-effort: a recall failure
  // costs recall, never the assembly. Computed before the post-budget report so the grant says if it fired.
  let recallLane: string | null = null;
  let openCommitmentsLane: string | null = null;
  let recalledVaultIds: string[] = [];
  try {
    // `includeVault` is unconditionally true: this lane is the one owner of the vault pull, from the tail.
    const blocks = await buildRecallLaneMessage(
      agentId,
      true,
      policy,
      liveTurnContext(agentId)?.conversationId ?? null,
    );
    recallLane = blocks.recall;
    openCommitmentsLane = blocks.commitments;
    recalledVaultIds = blocks.vaultIds;
  } catch (err) {
    logger.debug('recall lane failed', {
      error: err instanceof Error ? err.message : String(err),
    }, agentId);
  }
  // One lane, one reserve: both halves are `lane.relevant-memory`'s, and `recallLaneWorstCaseTokens` derives
  // it by rendering both. Either half firing is the lane firing.
  if (recallLane || openCommitmentsLane) postBudget.push('lane.relevant-memory');

  // The scratchpad and events blocks are read here and emitted by the loop past `volatileFrom`; a failed
  // scratchpad read costs only its block.
  const scratchpadLane = renderScratchpadLane(agentId);
  if (scratchpadLane) postBudget.push('lane.scratchpad');

  const eventsLane = renderEventsLane(agentId, laneCtx.tail().awarenessEvents);
  if (eventsLane) postBudget.push('lane.events');

  // The live integration-status line, read here and emitted past `volatileFrom`. It outranks a stale memory
  // about a connection; best-effort in its own try, but it warns when the read fails.
  let integrationStatusLane: string | null = null;
  try {
    integrationStatusLane = await buildIntegrationStatusLane(agentId);
  } catch (err) {
    logger.warn('Integration-status lane failed — live connection truth is NOT in front of the model', {
      error: err instanceof Error ? err.message : String(err),
    }, agentId);
  }
  if (integrationStatusLane) postBudget.push('lane.integration-status');

  // The work board is read last: it is laid out in the room the array and the blocks above leave.
  let attemptLedgerLane: string | null = null;
  let activeTasksLane: string | null = null;
  try {
    const board = await buildWorkBoardLane(agentId, {
      availableTokens: maxTokens - systemTokens, emitted: merged, liveRows: tailPayload?.rows ?? [], loopTailExtraTokens: loopTailExtra,
      blocks: [recallLane, openCommitmentsLane, scratchpadLane, eventsLane, integrationStatusLane],
    });
    attemptLedgerLane = board.attemptLedger;
    activeTasksLane = board.activeTasks;
  } catch (err) {
    logger.warn('Work-board lane failed — the active task board is NOT in front of the model', {
      error: err instanceof Error ? err.message : String(err),
    }, agentId);
  }
  if (attemptLedgerLane) postBudget.push('lane.attempt-ledger');
  if (activeTasksLane) postBudget.push('lane.active-tasks');

  // Record the post-budget lanes that fired against their declared reserves. They are inline pushes, not
  // `lane.render()` calls behind a catch, so "did not fire" is the whole truth.
  for (const l of POST_BUDGET_LANES) {
    const fired = postBudget.includes(l.id);
    report.grants.push({
      id: l.id,
      slot: l.slot,
      priority: Number.MAX_SAFE_INTEGER,
      requested: fired ? l.reserveTokens : 0,
      granted: fired ? l.reserveTokens : 0,
      status: fired ? 'admitted' : 'empty',
      reason: fired
        ? `post-budget lane fired; ${l.reserveTokens} tokens reserved off the top (${l.measured})`
        : 'post-budget lane did not fire on this turn',
    });
  }
  report.grants.sort((a, b) => a.slot - b.slot);

  logger.info('Context assembled', {
    systemPromptTokens: systemTokens,
    contentBudget,
    reservedOffTheTop: offTheTop,
    spentTokens: report.spentTokens,
    admittedLanes: report.admittedIds.length,
    rejectedLanes: report.grants.filter((g) => g.status === 'rejected').length,
    failedLanes: report.grants.filter((g) => g.status === 'failed').length,
    truncatedLanes: report.grants.filter((g) => g.status === 'truncated').length,
    overBudgetEvents: report.overBudget.length,
    freshTailCount: tailGrant?.granted ?? 0,
    totalMessages: merged.length,
  }, agentId);

  return {
    systemPrompt,
    systemVolatile: '',
    messages: merged,
    // Read off the final array after every mutation, so the ids align by construction.
    messageEntryIds: collectMessageLaneIds(merged),
    freshTailDropped,
    outOfViewThroughSeq,
    reserveTokens: policy.toolAndOutputReserve,
    allocation: report,
    consumedOneShotFlags,
    recallLane,
    recalledVaultIds,
    openCommitmentsLane,
    attemptLedgerLane,
    activeTasksLane,
    scratchpadLane,
    eventsLane,
    integrationStatusLane,
  };
}


/** The room the turn serving a delegated request needs for its order (the steer quoting every piece), in
 *  the loop-tail reserve's steps; 0 on every other turn. */
function joinOrderTokens(agentId: string): number {
  const root = liveTurnContext(agentId)?.root;
  const order = root?.kind === 'ask' && root.id ? joinOrderFor(askIdForMessage(root.id)) : null;
  const tokens = order ? renderTokens([{ role: 'user', content: order.text }]) : 0;
  return Math.ceil(tokens / LOOP_TAIL_EXTRA_STEP_TOKENS) * LOOP_TAIL_EXTRA_STEP_TOKENS;
}


// The scratchpad and events blocks, rendered for the tail: the lane renders byte for byte plus the one
// bounding change each needs to be declarable as a reserve (the pad cap, the ceiling enforcement).
// Both renderers stay pure: the worst-case reserves are derived by calling them.

const SCRATCHPAD_HEAD =
  '═══ YOUR SCRATCHPAD (agent-maintained outline + progress, survives compaction; update '
  + 'with scratchpad_set) ═══';
const SCRATCHPAD_TAIL = '═══ END SCRATCHPAD ═══';

export function renderScratchpadBlock(pad: string): string | null {
  if (pad.length === 0) return null;
  const cap = laneLimit('lane.scratchpad', 'chars', 'pad');
  const body = pad.length > cap ? `${pad.slice(0, cap)}${LANE_TRUNCATION_MARKER}` : pad;
  return `${SCRATCHPAD_HEAD}\n${body}\n${SCRATCHPAD_TAIL}`;
}

function renderScratchpadLane(agentId: string): string | null {
  try {
    const cfgRow = getDb().prepare('SELECT config FROM agents WHERE id = ?').get(agentId) as
      { config: string } | undefined;
    if (!cfgRow?.config) return null;
    const cfg = JSON.parse(cfgRow.config) as Record<string, unknown>;
    const pad = typeof cfg.scratchpad === 'string' ? cfg.scratchpad.trim() : '';
    return renderScratchpadBlock(pad);
  } catch (err) {
    logger.warn('Scratchpad injection failed', {
      error: err instanceof Error ? err.message : String(err),
    }, agentId);
    return null;
  }
}

let scratchpadWorstCase: number | null = null;
/** Derived by CALLING the renderer with the pad cap flooded, never counted beside it. */
export function scratchpadWorstCaseTokens(): number {
  if (scratchpadWorstCase !== null) return scratchpadWorstCase;
  const cap = laneLimit('lane.scratchpad', 'chars', 'pad');
  scratchpadWorstCase = estimateTokens(renderScratchpadBlock('p'.repeat(cap + 10)) ?? '');
  return scratchpadWorstCase;
}

const EVENTS_HEAD =
  '═══ EVENTS & NOTICES (things that happened; each says who it is addressed to. A notice '
  + 'TO THE OWNER is about his mail or channels: you are AWARE of it but NOT in conversation '
  + 'with its sender, who is NOT the person you are replying to below; never reply to it. '
  + 'An item TO YOU comes from the platform or another agent. NEW = arrived since your last '
  + 'finished turn; HANDLED = already in front of you on a finished turn) ═══';

export function renderEventsBlock(lines: string[]): string | null {
  if (lines.length === 0) return null;
  return `${EVENTS_HEAD}\n${lines.join('\n')}`;
}

function renderEventsLane(agentId: string, awarenessEvents: Message[]): string | null {
  if (awarenessEvents.length === 0) return null;
  const gistCap = laneLimit('lane.events', 'chars', 'gist');
  const seenThrough = lastViewedTriggerSeq(agentId);
  const lines = awarenessEvents.slice(-laneLimit('lane.events', 'rows', 'events')).map((m) => {
    const o = m.origin;
    const rawContent = typeof m.content === 'string' ? m.content : '';
    const body = rawContent.replace(/^\s*\[[^\]]*\]\s*/, '').replace(/\s+/g, ' ').trim();
    const structured = o?.kind === 'user' ? buildAwarenessGist(m.inboundMeta, rawContent) : null;
    const status = seenThrough !== null && m.rowid != null && m.rowid <= seenThrough ? 'HANDLED' : 'NEW';
    return renderEventsBullet(m, status, structured ?? body.slice(0, gistCap));
  });
  return renderEventsBlock(lines);
}

/** One EVENTS bullet from the real formatter: `• <status> [<instant>][<addressee>] <gist>`. */
export function renderEventsBullet(m: Message, status: 'NEW' | 'HANDLED', gist: string): string {
  return `• ${status} ${renderMessageTimeStamp(m.createdAt) ?? ''}[${eventAddressee(m)}] ${gist}`;
}

let eventsWorstCase: number | null = null;
/** Derived by CALLING the renderer with every declared cap flooded at once. */
export function eventsLaneWorstCaseTokens(): number {
  if (eventsWorstCase !== null) return eventsWorstCase;
  const rows = laneLimit('lane.events', 'rows', 'events');
  const gistCap = laneLimit('lane.events', 'chars', 'gist');
  // The widest label `eventAddressee` can build (its 24/64/32 caps) and widest stamp instant; keep in step.
  const label = [`${'c'.repeat(24)} notice TO THE OWNER, from ${'s'.repeat(64)}`,
    `TO YOU, from ${'s'.repeat(64)}: ${'i'.repeat(32)}`].sort((x, y) => y.length - x.length)[0];
  const at = renderMessageTimeStamp('2026-09-30T23:41:59.999Z') ?? '';
  const lines = Array.from({ length: rows }, () => `• HANDLED ${at}[${label}] ${'g'.repeat(gistCap)}`);
  eventsWorstCase = estimateTokens(renderEventsBlock(lines) ?? '');
  return eventsWorstCase;
}


/** Stub-and-store: replace tool_result content older than V2_STUB_AFTER_TURNS turns with a short stub.
 *  Works on Message[] (turn_number is only on the DB row); a NULL turn_number counts as very old. */
export function stubOldToolResults(messages: Message[], agentId: string): Message[] {
  // The watermark decides, not the live clock: `compaction.ts stubOldToolResultsAtBoundary` advances it at the
  // boundary, so a tool_result never flips to a stub mid-session. A missing watermark stubs nothing.
  let watermark = Number.NEGATIVE_INFINITY;
  try {
    const row = getDb().prepare('SELECT config FROM agents WHERE id = ?').get(agentId) as
      { config: string | null } | undefined;
    const cfg = row?.config ? JSON.parse(row.config) as Record<string, unknown> : {};
    if (typeof cfg.toolResultsStubbedBeforeTurn === 'number') watermark = cfg.toolResultsStubbedBeforeTurn;
  } catch { /* no watermark: stub nothing */ }
  if (watermark === Number.NEGATIVE_INFINITY) return messages;

  let stubbedCount = 0;

  const stubbed = messages.map((msg) => {
    if (msg.role !== 'tool') return msg;
    const msgTurn = msg.turnNumber ?? -Infinity;
    if (!(msgTurn < watermark)) return msg;

    let blocks: unknown;
    try {
      blocks = JSON.parse(msg.content);
    } catch {
      return msg;
    }
    if (!Array.isArray(blocks)) return msg;

    let messageChanged = false;
    const newBlocks = blocks.map((b: { type?: string; content?: unknown; tool_use_id?: string }) => {
      if (b.type !== 'tool_result') return b;
      const contentStr = typeof b.content === 'string' ? b.content : '';
      const len = contentStr.length;
      const turnLabel = msg.turnNumber !== null && msg.turnNumber !== undefined ? `turn ${msg.turnNumber}` : 'pre-v2 history';
      messageChanged = true;
      const readBack = b.tool_use_id ? `; ${readCall(b.tool_use_id)} reads it back` : '';
      return {
        ...b,
        content: `[Tool result from ${turnLabel}, ${len} chars, cleared from context${readBack}.]`,
      };
    });

    if (!messageChanged) return msg;
    stubbedCount++;
    return { ...msg, content: JSON.stringify(newBlocks) };
  });

  if (stubbedCount > 0) {
    logger.debug('v2 stubOldToolResults: stubbed old tool results', {
      agentId,
      stubbedCount,
      watermarkTurn: watermark,
      stubAfterTurns: V2_STUB_AFTER_TURNS,
    }, agentId);
  }

  return stubbed;
}


/** Pre-budget cap for raw tool messages (content still a JSON string), run before budgetFreshTail so
 *  the budget sees realistic counts and one result cannot evict the user's question. */
export function capLargeToolResultStrings(messages: Message[]): Message[] {
  return messages.map((msg) => {
    if (msg.role !== 'tool') return msg;
    let parsed: unknown;
    try {
      parsed = JSON.parse(msg.content);
    } catch {
      return msg;
    }
    if (!Array.isArray(parsed)) return msg;

    let mutated = false;
    const newBlocks = parsed.map((block: unknown) => {
      const blk = block as Record<string, unknown>;
      if (blk.type !== 'tool_result') return block;
      const c = blk.content;
      if (typeof c !== 'string') return block;
      const truncated = toolResultView(c, String(blk.tool_use_id ?? ''));
      if (truncated === c) return block;
      mutated = true;
      return { ...blk, content: truncated };
    });
    if (!mutated) return msg;
    return { ...msg, content: JSON.stringify(newBlocks), tokenCount: null };
  });
}

/** Post-combine cap of string tool_result content, in place. Array content (images, documents) is left
 *  to pruneOldImageBlocksInPlace. */
function capLargeToolResultsInPlace(
  messages: Array<{ role: 'user' | 'assistant'; content: string | Anthropic.ContentBlockParam[] }>,
): void {
  let cappedCount = 0;
  let tokensSaved = 0;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (typeof msg.content === 'string') continue;
    if (!Array.isArray(msg.content)) continue;

    const newContent = msg.content.map((block) => {
      const blk = block as unknown as Record<string, unknown>;
      if (blk.type !== 'tool_result') return block;

      const content = blk.content;
      if (typeof content !== 'string') return block;

      const truncated = toolResultView(content, String(blk.tool_use_id ?? ''));
      if (truncated === content) return block;

      cappedCount++;
      tokensSaved += estimateTokens(content) - estimateTokens(truncated);
      return { ...blk, content: truncated } as unknown as Anthropic.ContentBlockParam;
    });

    messages[i] = { ...msg, content: newContent };
  }

  if (cappedCount > 0) {
    logger.debug('v2 capLargeToolResultsInPlace: capped tool results', {
      cappedCount,
      tokensSaved,
    });
  }
}

/** Walk newest-first, keep the newest `maxKeepImages` images, and turn every older image and every document
 *  (top-level or inside a tool_result) into a text placeholder. In place. */
function pruneOldImageBlocksInPlace(
  messages: Array<{ role: 'user' | 'assistant'; content: string | Anthropic.ContentBlockParam[] }>,
  maxKeepImages: number,
): void {
  let imagesKept = 0;
  let prunedCount = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (typeof msg.content === 'string') continue;
    if (!Array.isArray(msg.content)) continue;

    const newContent: Anthropic.ContentBlockParam[] = msg.content.map(block => {
      const blk = block as unknown as Record<string, unknown>;

      if (blk.type === 'tool_result' && Array.isArray(blk.content)) {
        const nestedContent = blk.content as Array<Record<string, unknown>>;
        const newNested = nestedContent.map(nested => {
          if (nested.type === 'image') {
            if (imagesKept < maxKeepImages) {
              imagesKept++;
              return nested;
            }
            prunedCount++;
            return { type: 'text', text: '[image previously loaded, call file_read again on the same path if you need to re-examine it]' };
          }
          if (nested.type === 'document') {
            prunedCount++;
            return { type: 'text', text: '[document previously loaded, call file_read again if you need to re-examine it]' };
          }
          return nested;
        });
        return { ...blk, content: newNested } as unknown as Anthropic.ContentBlockParam;
      }

      if (blk.type === 'image') {
        if (imagesKept < maxKeepImages) {
          imagesKept++;
          return block;
        }
        prunedCount++;
        return { type: 'text', text: '[image previously loaded]' } as Anthropic.ContentBlockParam;
      }

      if (blk.type === 'document') {
        prunedCount++;
        return { type: 'text', text: '[document previously loaded]' } as Anthropic.ContentBlockParam;
      }

      return block;
    });

    messages[i] = { ...msg, content: newContent };
  }

  if (prunedCount > 0) {
    logger.debug('Pruned old image/document blocks from context', { prunedCount, imagesKept });
  }
}

/** The trim's atoms: a standalone message, or an [assistant(tool_use), tool(tool_result)] pair. A row
 *  that renders nothing (`role='system'`) rides with the group before it, so it never takes the
 *  newest-group safety. */
export function groupTail(messages: Message[]): Array<{ messages: Message[]; tokens: number }> {
  const groups: Array<{ messages: Message[]; tokens: number }> = [];
  let i = 0;
  while (i < messages.length) {
    const msg = messages[i];
    const tokens = storedRowCost(msg);
    if (msg.role === 'system' && groups.length > 0) {
      groups[groups.length - 1].messages.push(msg);
      groups[groups.length - 1].tokens += tokens;
      i++;
      continue;
    }

    let hasToolUse = false;
    try {
      const parsed = JSON.parse(msg.content);
      if (Array.isArray(parsed)) {
        hasToolUse = parsed.some((b: { type?: string }) => b.type === 'tool_use');
      }
    } catch {}

    if (hasToolUse && msg.role === 'assistant' && i + 1 < messages.length && messages[i + 1].role === 'tool') {
      const nextMsg = messages[i + 1];
      const nextTokens = storedRowCost(nextMsg);
      groups.push({ messages: [msg, nextMsg], tokens: tokens + nextTokens });
      i += 2;
    } else {
      groups.push({ messages: [msg], tokens });
      i++;
    }
  }
  return groups;
}

function budgetFreshTail(
  messages: Message[], availableTokens: number, blockGroups: number,
): Message[] {
  const groups = groupTail(messages);

  // Drop whole blocks off the front, or nothing: dropping the minimum is the costliest cadence on a prefix
  // cache. `groupsToDropForBudget` returns 0 when all fits, else a multiple of the block from the front
  // (`memory/tail-horizon.ts`).
  const dropped = groupsToDropForBudget(groups.map((g) => g.tokens), availableTokens, blockGroups);
  const includedGroups = groups.slice(Math.min(dropped, Math.max(0, groups.length - 1)));

  // Safety: an over-budget context beats none, so the newest group rides even when alone over the budget.
  const keptTokens = includedGroups.reduce((t, g) => t + g.tokens, 0);
  if (groups.length > 0 && keptTokens > availableTokens) {
    logger.warn('budgetFreshTail: all groups exceed budget, forcing last group inclusion', {
      groupCount: groups.length,
      lastGroupTokens: groups[groups.length - 1].tokens,
      availableTokens,
      groupsDropped: dropped,
    });
  }

  // What rides over the budget is never a whole row that alone exceeds the room: it is shown as head, tail and
  // the kept-whole pointer (`kept-row-view.ts`). The result is already chronological.
  return includedGroups.flatMap(g => (keptTokens > availableTokens ? g.messages.map((m) => overRoomRowView(m, availableTokens)) : g.messages));
}

/** Move each tool-result row to just after the row that made its calls, so a pair renders back to back and
 *  the rows that sat between follow it. It deletes nothing: `repairToolPairing` strips a block nothing pairs.
 *  `silent` names the rows made only of calls nothing answered: they say nothing once stripped, so they get no
 *  label or working note and the repair leaves no message for them. */
function hoistToolResults(rows: Message[]): { rows: Message[]; silent: Set<string> } {
  const ids = rows.map((msg) => {
    let blocks: Array<{ type?: string; id?: unknown; tool_use_id?: unknown }> = [];
    try {
      const parsed: unknown = JSON.parse(msg.content);
      if (Array.isArray(parsed)) blocks = parsed;
    } catch { /* plain text: no tool blocks */ }
    const of = (type: string, key: 'id' | 'tool_use_id'): string[] => blocks
      .filter((b) => b.type === type)
      .map((b) => b[key])
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
    const use = of('tool_use', 'id');
    return { use, result: msg.role === 'tool' ? of('tool_result', 'tool_use_id') : [], callsOnly: use.length > 0 && use.length === blocks.length };
  });
  const taken = new Set<number>();
  const silent = new Set<string>();
  const out: Message[] = [];
  const take = (k: number): void => {
    out.push(rows[k]);
    taken.add(k);
  };
  for (let i = 0; i < rows.length; i++) {
    if (taken.has(i)) continue;
    take(i);
    const pending = new Set(ids[i].use);
    let last = i;
    for (let j = i + 1; j < rows.length && pending.size > 0; j++) {
      if (taken.has(j) || !ids[j].result.some((id) => pending.has(id))) continue;
      take(j);
      last = j;
      for (const id of ids[j].result) pending.delete(id);
    }
    if (ids[i].callsOnly && last === i) silent.add(rows[i].id);
    // The ordinary rows the pair spanned follow it at once; tool rows among them keep their own place.
    for (let k = i + 1; k < last; k++) {
      if (!taken.has(k) && ids[k].use.length === 0 && ids[k].result.length === 0) take(k);
    }
  }
  return { rows: out, silent };
}

function parseMessageContent(
  msg: Message,
): string | Anthropic.ContentBlockParam[] {
  try {
    const parsed = JSON.parse(msg.content);
    if (Array.isArray(parsed)) {
      return parsed;
    }
    return msg.content;
  } catch {
    return msg.content;
  }
}

/** Fold consecutive same-role messages so the array alternates. A run's `reasoning_content` bodies are
 *  JOINED in order, earlier first, so merging cannot lose one. */
function mergeConsecutiveRoles(messages: LoopMsg[]): LoopMsg[] {
  const merged: LoopMsg[] = [];

  for (const msg of messages) {
    if (merged.length > 0 && merged[merged.length - 1].role === msg.role) {
      const prev = merged[merged.length - 1];
      // A tool-call message requires reasoning, so a merged run carries every contributor's, in order.
      // A run where nobody had reasoning stays absent, not `''` (that fallback is `model.ts`'s alone).
      if (msg.reasoningContent) {
        prev.reasoningContent = prev.reasoningContent
          ? `${prev.reasoningContent}\n\n${msg.reasoningContent}`
          : msg.reasoningContent;
      }
      if (typeof prev.content === 'string' && typeof msg.content === 'string') {
        prev.content = prev.content + '\n\n' + msg.content;
      } else {
        const prevArr = typeof prev.content === 'string'
          ? [{ type: 'text' as const, text: prev.content }]
          : prev.content;
        const msgArr = typeof msg.content === 'string'
          ? [{ type: 'text' as const, text: msg.content }]
          : msg.content;
        const combined = [...prevArr, ...msgArr];
        const seenToolResultIds = new Set<string>();
        const deduped = combined.filter((block) => {
          const b = block as unknown as Record<string, unknown>;
          if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
            if (seenToolResultIds.has(b.tool_use_id)) return false;
            seenToolResultIds.add(b.tool_use_id);
          }
          return true;
        });
        prev.content = deduped;
      }
    } else {
      merged.push({ ...msg });
    }
  }

  return merged;
}
