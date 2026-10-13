import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/connection.js';
import { withLock } from '../db/with-lock.js';
import { MIN_COMPACTABLE_ROWS, compactionIsBraked, noteLowYield, notePassOutcome,
  summaryWriterUnavailable } from './compaction-brakes.js';  // v3.2.3 L1, re-aimed by OR-COMPACT-1
import { condenseUntilFits, condensableSummaries, rawContextSummaryTokens, type CondensationOutcome } from './condense-until-fits.js';   // OR-COMPACT-1
import { cachedAssembledEstimate, cachedToolPayloadTokens, toolSurfaceKey } from './assembled-estimate-cache.js';
export { forcedCompactionOptions } from './compaction-brakes.js';   // the emergency path's bounds, published where its callers already look
import { createLogger } from '../logger.js';
import { broadcast } from '../gateway/ws.js';
// (getRuntimeVersion import removed in Phase 9 Stage 2, single-track v2)
import { getMessagesOutsideFreshTail, getRecentMessages } from './store.js';
// t100: the fresh tail's front is the compaction boundary (t94). The gate READS that decision
// so its dry run measures the span the assembler will actually admit — see the call below.
import { freshTailHorizon, rowsLeavingView, tailTrimBlockGroups, type LeavingView } from './tail-horizon.js';
import { estimateTokens, getFreshTailCount, contextWindowPolicy, storedRowCost, CONTEXT_THRESHOLD, CONTEXT_WARN_THRESHOLD } from './budget.js';
import { reserveLadderFor } from './lanes.js';
// T82a: `agent/stream-patience.ts` is a LEAF (no imports of its own — see its header), so
// importing its arithmetic here does not create the cycle `agent/model.ts` is dynamically
// imported below to avoid.
import { providerAwareBudgetTokens } from '../agent/stream-patience.js';
import { insertMessageIfAbsent, retireReplayedReasoningBeforeTurn } from './message-store.js';
// T67b: the stub distance is DECLARED by the assembler, which renders it, and READ here,
// which decides when it applies. One number, two readers — never a second literal.
import { V2_STUB_AFTER_TURNS } from './assembler.js';
import { summaryWriterCandidates, eligibleSummaryWriters } from './summary-writer-health.js';
import {
  createLeafSummary,
  createCondensedSummary,
  getLeafSummariesNotCondensed,
  getCompactedMessageIds,
  getContextSummaries,
  replaceContextItems,
} from './dag.js';
import { generateSummary } from './summarize.js';
// T20: the summariser's own cited work id, resolved against the spine before the row is stored.
import { annotateSummaryObligations } from './summary-obligations.js';
import { archiveMessagesBeforeCompaction, isDreamerIgnored, getArchiveHighWaterMark } from '../vault/archive.js';
import { isSystemServiceAgent } from '../config/platform.js';
import { lastCompactionDividerAt } from '../agent/shared-state.js';
import { summaryPartyTag } from './party-label.js';
import { currentTurnNumber } from '../agent/v2/turn-record.js';   // G24
import { isPlatformNoise } from './platform-noise.js';
import type { Message } from '@dojo/shared';
// PHASE-3 T5 — the marker taxonomy. Both of the latter two were re-declared below.
import { formatDivider, A2A_INBOUND_RE, TECHNIQUE_FRESH_SENTINEL } from '@dojo/shared';

// Inbound A2A, a peer agent's message TO this agent. For the primary's own context
// summary this is inter-agent traffic, not the user's conversation, so it is excluded
// from summary input. Must match the SAME marker set the assembler strips from a human
// turn (assembler.ts A2A_INBOUND_RE): the modern [A2A: …] envelope plus the legacy
// agent-message / group-broadcast / PM-poke source markers, otherwise a legacy variant
// would be stripped from live turns but still bleed into the persistent summary.
// PHASE-3 T5: was `A2A_INBOUND_MARKER_RE` here with `/i` and the byte-identical
// alternation WITHOUT it in assembler.ts. The comment's promise above is now enforced by
// the import rather than by hope.

/** A row that must NOT be folded into a context summary: platform/inter-agent plumbing
 *  or an inbound peer A2A message. Keeps another agent's work out of the primary's
 *  narrative so the model can't later read it back and narrate it to the user.
 *  Exported for the nightly contaminated-summary rebuild (memory/summary-rebuild.ts),
 *  which re-runs old summaries' source messages through this same filter. */
export function isNonConversationForSummary(content: string | null | undefined): boolean {
  return isPlatformNoise(content) || (!!content && A2A_INBOUND_RE.test(content));
}

/** Placeholder stored when a summarized span contains no user conversation at all
 *  (pure system/inter-agent plumbing or tool traffic). Shared with the nightly
 *  summary rebuild so both paths write the identical minimal placeholder. */
export const NO_CONVERSATION_PLACEHOLDER = '(system/inter-agent activity, no user conversation in this span)';

// ── Assembled-context token estimate ──
//
// This is the right metric to gate compaction on: what the assembler will
// actually load into the next model call. Pre-2026-04-30 we summed every
// message ever written to the messages table this session, which never went
// down after compaction (raw messages are preserved for archive/search even
// when their content has been folded into summaries). Result: total tokens
// climbed monotonically into millions and compaction fired every turn,
// burning the model budget on summaries while the agent's effective context
// stayed pinned at the fresh-tail size.
//
// The assembler loads:
//   - summaries pinned to context_items (top-level DAG nodes)
//   - the fresh tail (every row since the compaction boundary — `tail-horizon.ts`)
//   - vault snippets and tracker tasks (variable, bounded by their own logic)
//
// We approximate the compressible portion: summaries + fresh tail. (t140: the continuity brief
// that used to be the third term is deleted — see the STRIP note where its writer stood.)
// Vault and active tasks aren't compressible by this engine, so leaving
// them out of the gating metric is correct.
// Per-message cap for the compaction gate. A single oversized message
// (think: file_read of a code file, web_fetch of a long page, list_agents
// returning tons of metadata) used to count its full token weight here,
// so one tool-heavy turn could trigger compaction by itself even when
// the conversation was otherwise quiet. The assembler's own
// budgetFreshTail already trims what the model actually sees; the gate
// just needs to know "is the fresh tail genuinely full of conversation",
// not "did somebody dump a 30K file into a single tool result".
// STRIP (PHASE-3 T2): `MAX_GATE_MESSAGE_TOKENS` (now `policy.gateMessageCap`) and
// `TOOL_AND_OUTPUT_RESERVE`, which was ALSO a bare literal in `assembler.ts:670`.
// STRIP (PHASE-3 T4): the re-export itself. The reserve is no longer a constant anybody can
// import — it is `toolAndOutputReserve({ measured tools, model output cap })`, computed per
// agent per call. `loop.ts` used the re-exported constant to describe the overhead the
// assembler had just produced; it now reads the number the assembler ACTUALLY used, off the
// dry-run below. requirement preserved: "the loop knows how much of the window the
// assembler did not control" — owned by `estimateAssembledTokens`'s `reserveTokens`.

/** The compaction gate's view of what the assembler will produce — an ALLOCATOR DRY-RUN
 *  since PHASE-3 T2, not a second model of it. What stood here derived the assembler's
 *  ceiling from THIS module's threshold (0.96) while the assembler used 0.75.
 *
 *  ASYNC since PHASE-3 T4, and for the reason the dry-run exists: the assembler's reserve
 *  is now MEASURED from this agent's real tools payload, and a gate that modelled it with a
 *  constant while the assembler measured it would be a second model of the budget again —
 *  the exact defect T2 deleted. Measuring needs the tool hub, which is loaded dynamically
 *  to avoid a cycle, so the dry run is async. All three call sites were already inside
 *  async functions. */
export async function estimateAssembledTokens(
  agentId: string,
  contextWindow: number,
  /** The model the turn will actually call, when the caller knows it. Absent means the
   *  output cap is unknown and the reserve uses its own floor rather than inventing one. */
  modelId?: string,
  opts?: {
    /**
     * T82 FIX WAVE, Important I1 — the model whose declared box-speed decides the provider-aware
     * CEILING, when it differs from `modelId` (which stays the output-cap source, unchanged).
     * `runCheckAndCompact` (below) is the one caller that needs this split: it resolves
     * `modelId` to the SUMMARY-WRITER model (`resolveSummaryWriterModel`, which may pick a
     * cheaper/different-provider model than the one serving the turn) before calling here, but
     * the compaction TRIGGER must key on the box actually producing the pressure — the same
     * `turnModelId` its own external threshold already uses (see that function's own comment).
     * Before this, an undeclared turn model paired with a declared-ceiling writer model shrank
     * this dry run's `assemblyBudgetTokens` (and therefore `summaryTokens`/`total`) against a
     * ceiling that has nothing to do with the model actually serving the turn, while the
     * EXTERNAL threshold this total is compared against stayed unceilinged (turn model
     * undeclared) — an asymmetric mismatch that made the trigger fire LATER than the R6
     * byte-preservation control promises for a genuinely undeclared row. Absent, defaults to
     * `modelId` — every existing caller (the two OTHER call sites in this file, and
     * `context-gates.ts`'s pre-call gate) passes one model for both roles and is byte-identical.
     */
    ceilingModelId?: string;
  },
): Promise<{
  total: number;
  summaryTokens: number;
  freshTailTokens: number;
  /**
   * t140 fix round 1 (C1): the live tail at the TOKEN TRIM's own per-row cost — `storedRowCost`,
   * the function `budgetFreshTail` spends, uncapped. `freshTailTokens` above keeps the gate's
   * 4K-per-row cap for the 96% emergency numerator, which is a different question.
   */
  liveTailTokens: number;
  freshTailCount: number;
  summaryCount: number;
  /** What the assembler set aside for tool schemas + output on this agent, measured. */
  reserveTokens: number;
  /** t140: the assembler's own admission budget on this window (system prompt + messages). */
  assemblyBudgetTokens: number;
  /** t140: the window's row floor — the newest rows no condense may fold. */
  policyFreshTailCount: number;
}> {
  const { measureAgentToolPayloadTokens } = await import('../tools/tool-docs.js');
  const { getModelOutputCap, getProviderCeilingTokens } = await import('../agent/model.js');
  const ceilingModelId = opts?.ceilingModelId ?? modelId;
  // T82a fix wave: thread the SAME provider-aware ceiling through this dry run's own
  // `contextWindowPolicy` call, so `policy.assemblyBudgetTokens` — and therefore the
  // `summaryBudget` cap below — matches what a REAL assembly of this agent, on this
  // model, will actually admit. Before this, the dry run modelled a bigger budget than
  // the assembler would honour, so this estimate could UNDER-report what the compaction
  // trigger is comparing against. `modelId` absent (the caller does not yet know it, e.g.
  // an auto-routed turn's pre-call gate reading the `'__auto__'` sentinel) resolves to
  // `null` the same way `getModelOutputCap` already does for that case — the honest
  // "unknown" answer, which leaves this exactly as it was (the over-trigger direction is
  // the safe one where the real ceiling cannot yet be named, and NULL never narrows
  // anything, only a genuine ceiling does).
  const policy = contextWindowPolicy(contextWindow, {
    toolPayloadTokens: await cachedToolPayloadTokens(agentId, toolSurfaceKey(agentId, modelId), () => measureAgentToolPayloadTokens(agentId)),
    maxOutputTokens: modelId ? getModelOutputCap(modelId) : undefined,
    // T82 FIX WAVE, I1: the ceiling reads off `ceilingModelId`, NOT `modelId` — see this
    // parameter's own doc above for why the two may legitimately differ.
    providerCeilingTokens: ceilingModelId ? getProviderCeilingTokens(ceilingModelId) : null,
  });
  const summaries = getContextSummaries(agentId);
  const rawSummaryTokens = summaries.reduce((sum, s) => sum + (s.tokenCount ?? 0), 0);

  // ── t100: THE GATE MEASURES THE TAIL THE ASSEMBLER ACTUALLY SENDS ──────────────────────
  //
  // This read was `getRecentMessages(agentId, policy.freshTailCount)` — the ROW CAP. Before
  // t94 that was the same set the assembler admitted, so the dry run and the real assembly
  // agreed by construction. t94 made the assembler's tail HORIZON-BOUNDED (every row since
  // the compaction boundary — `memory/tail-horizon.ts` carries the whole derivation), which
  // is MORE, so this estimate under-reported the assembly it is gating: measured at 68 rows
  // admitted against 40 seen, blind to 28 of them. Both readers of this number — the token
  // trigger in `runCheckAndCompact` below and `context-gates.ts`'s warn / compact / block
  // rungs — therefore read LOW, and preemptive compaction fired later than the real pressure
  // warranted. (Not a correctness hole while it stood: the assembler's own
  // `assemblyBudgetTokens` still bounds what is SENT, and the ROW-GAP trigger below is not
  // token-based and kept firing on schedule, which is what held the healthy path honest.)
  //
  // THE HORIZON IS READ HERE, NEVER RE-DERIVED. One module decides where the live
  // conversation starts; this is a dry run of that decision, not a second model of it — the
  // same rule that made this whole function an allocator dry run at PHASE-3 T2.
  //
  // AND THE ASK CARRIES NO SLACK, deliberately. The assembler pads its own ask by one row cap
  // in the FILTERED case only, and for one reason: its read excludes the newest user rows
  // with a `turnCutoff`, so a `LIMIT` sized to the span reaches that many rows further back
  // and the seq filter trims them off again. This function has no `turnCutoff` and excludes
  // nothing, so slack here would be pure over-ask — and in the FLOOR case (`keepFromSeq: 0`,
  // nothing filtered) it would measure up to 2×cap rows the assembler will never send. That
  // is t94 review I1's defect, removed from the assembler in its own fix round; the handed-up
  // diff reintroduced it on this side and it is not reproduced here.
  // `__tests__/the-tail-trims-only-at-a-boundary.test.ts` §9 holds both halves.
  const horizon = freshTailHorizon(agentId, policy);
  const freshTailRows = getRecentMessages(agentId, horizon.requestRows);
  const freshTail = horizon.keepFromSeq > 0
    ? freshTailRows.filter((m) => (m.rowid ?? 0) >= horizon.keepFromSeq)
    : freshTailRows;
  // T56 leg (a): `storedRowCost` is the assembler's own unit, now shared (it used to be
  // re-spelled here as `?? estimateTokens(…)`, which billed a stored `token_count` of 0 as
  // free). It includes the `reasoning_content` the replay site will actually send, so
  // "should this agent summarise" stops being decided against a number that omitted, on the
  // dev body, an average of 3,981 tokens per 40-row window. The per-row cap is unchanged and
  // still applies to the whole row, exactly as it does to an oversized tool result.
  const freshTailTokens = freshTail.reduce(
    (sum, m) => sum + Math.min(storedRowCost(m), policy.gateMessageCap),
    0,
  );
  const liveTailTokens = freshTail.reduce((sum, m) => sum + storedRowCost(m), 0);

  // Cap summary tokens at the same budget the assembler applies (assembler.ts:
  // budgetSummaries reserves 70% of remaining-after-scaffolding for summaries,
  // dropping oldest first to fit). Without this cap, a long-lived agent, or
  // anyone upgrading from v1 with a deep summary DAG, sees the gate trip at
  // >100% on its first turn, force-compaction can't reduce already-condensed
  // depth-N summaries any further, and the loop wedges firing the same
  // "memory is too full" message forever. The assembler will trim summaries
  // to fit; the gate must reflect that, not the unbounded raw total.
  const maxAssemblerTokens = policy.assemblyBudgetTokens;
  const summaryBudget = Math.max(0, Math.floor((maxAssemblerTokens - freshTailTokens) * policy.summaryShare));
  const summaryTokens = Math.min(rawSummaryTokens, summaryBudget);

  return {
    total: summaryTokens + freshTailTokens,
    summaryTokens,
    freshTailTokens,
    liveTailTokens,
    freshTailCount: freshTail.length,
    summaryCount: summaries.length,
    reserveTokens: policy.toolAndOutputReserve,
    assemblyBudgetTokens: policy.assemblyBudgetTokens,
    policyFreshTailCount: policy.freshTailCount,
  };
}

/**
 * t140 — IS THE LIVE VIEW FULL FOR THIS WINDOW? The "getting full for the model actually used"
 * half of the condense trigger (OR-V333-SET (1)); `memory/tail-horizon.ts`'s `rowsLeavingView`
 * owns the other half and decides WHICH rows leave.
 *
 * Read off the same dry run the pre-call gate reads, against the ADMISSION budget the assembler
 * will actually spend — not the gate's 96%-of-window emergency line, which only fires after the
 * assembler has already been trimming the live conversation for a while. The content the
 * assembler can hold is its budget, minus the system prompt, minus the post-budget reserve
 * ladder it takes off the top (`lanes.ts`'s `reserveLadderFor`, the same function). Full means
 * the summaries plus the live tail no longer fit in that.
 *
 * THE TAIL IS PRICED BY THE TRIM'S OWN FUNCTION (fix round 1, review C1): `liveTailTokens`, each
 * row at `storedRowCost` — what `budgetFreshTail` spends before it takes rows off the front.
 * The first cut used the gate's 4K-per-row cap here, on the theory that one large row is "the
 * trim's to handle"; the trim handles it by setting the OLDEST rows aside unsummarised, so a
 * file-reading agent on a 128K window lost rows for 131 turns with no fold (measured). Where the
 * assembler pre-caps a tool result above 15K tokens this overstates, which folds earlier, never
 * later. `systemPromptTokens` is the caller's measurement of the system prompt last assembled
 * for this agent; 0 makes the check more lenient, never stricter.
 *
 * AND IT LEADS BY ONE TRIM BLOCK. The token trim moves the view's front in whole blocks
 * (`tail-horizon.ts`'s `tailTrimBlockGroups`), so "about to leave" is "one more block of growth
 * and the trim cuts". The lead is that block priced at this tail's own average row: the condense
 * runs in the background and needs room to finish before the cut, the same reason the ceiling
 * trigger leads by a block of rows. It also absorbs what the dry run cannot see exactly — a
 * summary's rendered header, the scaffolding ack — which MEASURED (t140 probe, 32K window)
 * put the trim three turns ahead of an unled check: 11,740 rendered against 11,496 estimated.
 */
export function liveViewIsFull(
  est: {
    summaryTokens: number; freshTailTokens: number; liveTailTokens?: number; freshTailCount?: number;
    assemblyBudgetTokens?: number; policyFreshTailCount?: number;
  },
  systemPromptTokens: number,
): boolean {
  if (typeof est.assemblyBudgetTokens !== 'number') return false;
  const available = Math.max(0, est.assemblyBudgetTokens - Math.max(0, systemPromptTokens));
  const content = Math.max(0, available - reserveLadderFor(available).offTheTop);
  const rows = Math.max(1, est.freshTailCount ?? 1);
  const tail = est.liveTailTokens ?? est.freshTailTokens;
  const lead = tailTrimBlockGroups(est.policyFreshTailCount ?? 0) * (tail / rows);
  return est.summaryTokens + tail + lead > content;
}

const logger = createLogger('memory-compaction');

// ── Technique-content scrub for summarization (v2.7.6) ──
//
// Tool results from technique_read / use_technique all carry the
// freshness sentinel (techniques/tools.ts:TECHNIQUE_FRESH_SENTINEL).
// Before sending chunk text into the summarizer, replace any such
// block with a one-line stub so the technique body NEVER appears in
// the generated summary. Without this, the summary keeps a
// paraphrased copy of the technique and the agent later reads the
// summary as authoritative, defeating the v2.7.4 stub-after-1-turn
// freshness enforcement on the raw tool_result side.
const TECHNIQUE_SCRUB_STUB =
  '[technique read withheld from summary by engine policy, call technique_read for the current on-disk content; do not paraphrase from this summary]';

// Same risk class, higher stakes: a credential_get result carries a raw secret
// in its body. If it ages into a compaction chunk the summarizer would otherwise
// see the value and could fold it into a persisted leaf summary, re-injected
// across sessions (a Rule-6 leak that must NOT rest on the summarizer model's
// discretion). credential_get prepends this sentinel; the summary scrub stubs it
// deterministically at the engine, exactly like a fresh technique read.
export const CREDENTIAL_FRESH_SENTINEL = '══ CREDENTIAL FRESH READ ══';
const CREDENTIAL_SCRUB_STUB =
  '[credential value withheld from summary by engine policy, call credential_get for the current value; never persist or paraphrase a secret]';

// Return the deterministic stub for a sentinel-tagged body, or null if the body
// carries no scrubbable sentinel.
function scrubStubFor(content: string): string | null {
  if (content.startsWith(TECHNIQUE_FRESH_SENTINEL)) return TECHNIQUE_SCRUB_STUB;
  if (content.startsWith(CREDENTIAL_FRESH_SENTINEL)) return CREDENTIAL_SCRUB_STUB;
  return null;
}

export function scrubTechniqueContentForSummary(messageContent: string): string {
  // Fast path: plain string content that starts with a sentinel
  // (covers any flow where the runtime persists the raw tool string
  // rather than a JSON tool_result block).
  const fast = scrubStubFor(messageContent);
  if (fast) return fast;
  // JSON path: walk tool_result blocks the way the assembler does.
  try {
    const parsed = JSON.parse(messageContent);
    if (!Array.isArray(parsed)) return messageContent;
    let changed = false;
    const next = parsed.map((block: unknown) => {
      const b = block as { type?: string; content?: unknown };
      if (b.type !== 'tool_result') return block;
      if (typeof b.content !== 'string') return block;
      const stub = scrubStubFor(b.content);
      if (!stub) return block;
      changed = true;
      return { ...b, content: stub };
    });
    return changed ? JSON.stringify(next) : messageContent;
  } catch {
    return messageContent;
  }
}

// ── Defaults ──
//
// v1: contextThreshold 0.75, fires at 75% utilization (the "compaction is
// load-bearing" architecture). v2 raises this to 0.96 emergency-only with
// a 0.90 WARN line per Part V, compaction becomes a debug signal, not a
// routine event. Threshold lookup is runtime-version-aware so v1 agents
// keep their original behavior while v2 agents see the new architecture.

const DEFAULTS = {
  // PHASE-3 T2: `contextThreshold` moved to `memory/budget.ts` as CONTEXT_THRESHOLD.
  // It was one of five declarations of the same number and the assembler's copy said 0.75
  // (§T0-C). The remaining entries here are summary SHAPES, not budget, and stay.
  leafChunkTokens: 30000,
  leafTargetTokens: 5000,
  condensedTargetTokens: 6000,
  // OR-COMPACT-1: the fanout is still the batch SIZE for a level with enough waiting
  // summaries, but it is no longer a FLOOR below which a level refuses to condense —
  // `condense-until-fits.ts` condenses 2, 3 or even 1. `incrementalMaxDepth: 1` is gone with
  // it: it capped `newDepth` at 2, which made a depth-2 summary the ceiling of the DAG and so
  // impossible to condense again. (NOT "depth 2 was unreachable" — see the condenser's header
  // for the re-read that corrected that claim.)
  condensedMinFanout: 4,
};

/** Summary size targets, exposed for the nightly summary rebuild so regenerated
 *  summaries match the sizes the live compaction path produces. */
export const SUMMARY_TARGET_TOKENS = {
  leaf: DEFAULTS.leafTargetTokens,
  condensed: DEFAULTS.condensedTargetTokens,
} as const;

function getContextThreshold(): number {
  return CONTEXT_THRESHOLD;
}

export function getLeafChunkTokens(): number {
  return DEFAULTS.leafChunkTokens;
}

/** The leaf summary's target size — what `replaceUncondensedPlaceholders` asks for too. */
export function getLeafTargetTokens(): number {
  return DEFAULTS.leafTargetTokens;
}

// Model-aware row floor for compaction: getFreshTailCount (memory/budget.ts). No compaction
// folds the newest floor rows; the live view above the floor is `memory/tail-horizon.ts`'s.

// ── STRIP (t140): THE ROW-GAP TRIGGER IS GONE ──────────────────────────────────────────────
// `UNCOMPACTED_GAP_THRESHOLD` (30) and `getUncompactedGapCount` lived here and drove the pre-call
// gate's routine drain: more than 30 unsummarised rows outside the newest row cap fired a
// summarise "regardless of token level". After t94 the live view is every row since the
// boundary, so those rows were the ones the model was READING (tracker #13; the owner's
// decision #16, re-opened and reversed 2026-10-12). requirement preserved: "every row is
// summarised before it leaves the live view" — owned now by `tail-horizon.ts`'s
// `rowsLeavingView` (the ceiling is its single owner of the number) and the leaving-view pass
// below, which fold exactly the rows that are leaving and nothing the agent is still reading.

// ── Chat divider helpers ──
//
// After compaction, we drop a "── Memory Compacted ──" system message
// into the agent's chat so the user sees a horizontal divider in the
// timeline. Mirrors the existing "── New Session ──" pattern. The
// dashboard renders any system message shaped "── label ──" as a
// divider with the label centered.

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}K tokens`;
  return `${n} tokens`;
}

// v2.5.11, After the divider, drop a separate, agent-facing system message
// that nudges the agent toward recall_recent_thread if it needs detail from
// the summarized portion. Sits in the messages table so it lands in the
// v2.7.10, insertRecallNudge / RECALL_NUDGE_TEXT removed.
//
// The nudge text told the agent to call recall_recent_thread before
// responding. Paired with the v2/loop.ts hard intercept (also removed)
// that AUTO-RAN that recall and pasted ~15K chars of prior thread
// content back into the message log as a system message. Real
// production failure: scheduled-task agent processing 17 emails in
// sequence hit compaction → nudge inserted → auto-recall re-injected
// 8 turns of fresh-tail content as a new system message → next turn's
// fresh tail was bigger → compaction triggered again → another
// re-injection → context spiraled. Agent started sending emails twice
// and marking unsent emails complete because the re-injected log made
// past work look pending.
//
// Recovery: recall_recent_thread is back to being a TOOL the agent
// calls on demand. The "── Memory Compacted ──" divider still appears
// (insertCompactionDivider, throttled to once per 10 min) so the
// agent sees compaction happened, but nothing else is auto-injected
// into the message log.

/** Min interval between compaction dividers shown to the user, per agent. */
const COMPACTION_DIVIDER_THROTTLE_MS = 10 * 60 * 1000;

/**
 * True when enough time has elapsed since the last divider broadcast for
 * this agent to show another one. Avoids spamming the chat during a backlog
 * drain that runs across many turns, while still surfacing compactions
 * during a normal long task at most once per 10 minutes.
 */
function shouldShowCompactionDivider(agentId: string): boolean {
  const last = lastCompactionDividerAt.get(agentId) ?? 0;
  return Date.now() - last >= COMPACTION_DIVIDER_THROTTLE_MS;
}

function insertCompactionDivider(agentId: string, opts: { label: string }): void {
  try {
    const id = uuidv4();
    const content = formatDivider(opts.label);
    const createdAt = new Date().toISOString();
    insertMessageIfAbsent({ id, agentId, role: 'system', content });
    broadcast({
      type: 'chat:message',
      agentId,
      message: {
        id,
        agentId,
        role: 'system' as const,
        content,
        tokenCount: null,
        modelId: null,
        cost: null,
        latencyMs: null,
        createdAt,
      },
    });
    lastCompactionDividerAt.set(agentId, Date.now());
  } catch (err) {
    logger.warn('Failed to insert compaction divider', {
      agentId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// Wrap a compaction work call so the dashboard's ActiveJobsIndicator shows a
// "Compacting memory" row while it runs. Engine-managed (no Stop button): the
// panel adds the row on the 'start' broadcast and removes it on 'end'. Robust
// across the work's early returns/throws via try/finally.
async function withCompactionActivity<T>(agentId: string, work: () => Promise<T>): Promise<T> {
  const id = `compaction_${agentId}_${Date.now()}`;
  const startedAt = new Date().toISOString();
  const emit = (phase: 'start' | 'end'): void =>
    broadcast({ type: 'engine:activity', data: { id, kind: 'compaction', agentId, label: 'Compacting memory', startedAt, phase } });
  emit('start');
  try {
    return await work();
  } finally {
    emit('end');
  }
}

// ── Summary-writer model resolution ──
//
// Resolve which model WRITES summaries. It must be able to produce text:
// media-generation (image/video/music) and embedding models all cost 0, so a
// naive "cheapest enabled model" picked one of them and every summarization
// call failed, the gap trigger then re-fires every turn forever (summaries
// never get written). Precedence:
//   1) the explicit Settings → compaction model, if enabled + text-capable
//   2) the caller's preferred model (the agent's own), if it's text-capable
//   3) the cheapest enabled text-capable model (the floor), deterministic tiebreak
// Shared by checkAndCompact and the nightly summary rebuild so both write
// summaries with the same (cheap) model choice. Returns null when no
// text-capable model exists at all.
export function resolveSummaryWriterModel(agentId: string, preferredModelId?: string): string | null {
  // t140 round 3: the order above, with writers whose provider is broken or failed a summary in
  // the last few minutes passed over (`summary-writer-health.ts`) — so an unreachable cheapest
  // model is not picked again and again. When every writer is passed over, the first in order is
  // still returned: the pressure path has its own brake, and "no writer" would be a false defect.
  const all = summaryWriterCandidates(preferredModelId);
  const pick = eligibleSummaryWriters(preferredModelId)[0] ?? all[0] ?? null;
  if (pick) logger.info('Resolved summary-writer model', { resolvedModelId: pick, passedOver: all.slice(0, all.indexOf(pick)) }, agentId);
  return pick;
}

// ── Main Entry Point ──


export interface CheckAndCompactOptions {
  force?: boolean;
  // v2.5.12, Per-call cap on how many leaf chunks may be summarized.
  // Used by the routine gap-trigger path so a huge backlog (e.g. an
  // upgrade from a pre-gap-trigger version with thousands of uncompacted
  // messages) drains across many turns instead of blocking a single turn
  // for minutes while it does dozens of LLM calls back-to-back.
  maxChunksPerRun?: number;
  // v2.5.14, Optional abort signal for cancellation. Used by the
  // background condense in the v2 pre-call gate so a hung summarizer LLM call
  // can actually be cancelled instead of running until the SDK's
  // 10-minute default timeout fires.
  abortSignal?: AbortSignal;
  /**
   * t140: the rows the caller has measured are leaving the live view (`rowsLeavingView`). When
   * the call is not under pressure, ONLY these are folded. Absent, an unforced call asks
   * `rowsLeavingView` itself, ceiling cause only (it has no view-full measurement of its own).
   */
  leaving?: LeavingView | null;
  /**
   * t140 fix round 1 (review I3): the model this call's pressure was measured for — the box
   * actually serving the turn, whose declared ceiling the trigger keys on. Absent, it is
   * `modelId`. It is kept APART from `modelId` because `modelId` is the summary WRITER's
   * preference (`resolveSummaryWriterModel`): an auto-routed loop locked to an expensive routed
   * model must still have its summaries written by the owner's compaction model, else the
   * cheapest text model, exactly as before t140.
   */
  dialedModelId?: string;
}

export type CompactionResult = { leafCreated: number; condensedCreated: number; tokensReclaimed: number };

const NO_COMPACTION: CompactionResult = { leafCreated: 0, condensedCreated: 0, tokensReclaimed: 0 };

/**
 * PHASE-1 T2: the ONE site that covers all seven compaction entry points (the
 * v2 loop's four, recovery, the memory route, and the routine background
 * drain). Every one of them arrives here, so the mutual exclusion belongs here
 * and nowhere else.
 *
 * Requirement preserved: a second compaction for the SAME agent can no longer
 * overlap the first. Both used to read the uncompacted set before either wrote
 * a summary, so both summarised the same messages and both wrote depth-0 rows
 * over them — 11.4% of depth-0 summaries were duplicates in real data (44/387,
 * research 22). The race last fired 2026-06-26; the corruption class is real
 * and the platform had no mutual-exclusion primitive to stop it.
 *
 * `ifBusy:'skip'` and not `'wait'`, deliberately: a queued second compaction
 * would run against a history the first one just compacted and find nothing to
 * do, after holding the caller's turn open for a full summarizer round-trip.
 * Skipping returns the same zero result those callers already handle — every
 * caller reads the counts and none treats zero as an error — and the work is
 * not lost: the next turn's gate re-checks and compacts if pressure remains.
 *
 * Scope: `withLock` is IN-PROCESS. One dojo server owns its box, which is the
 * shape of the observed race; it is not a cross-process lock and must not be
 * described as one.
 */
export async function checkAndCompact(
  agentId: string,
  modelId: string,
  contextWindow: number,
  options?: CheckAndCompactOptions,
): Promise<CompactionResult> {
  const result = await withLock(
    `compact:${agentId}`,
    () => runCheckAndCompact(agentId, modelId, contextWindow, options),
    { ifBusy: 'skip' },
  );
  if (result === undefined) {
    logger.info('Compaction skipped: another compaction is already running for this agent', {}, agentId);
    return NO_COMPACTION;
  }
  return result;
}

async function runCheckAndCompact(
  agentId: string,
  modelId: string,
  contextWindow: number,
  options?: CheckAndCompactOptions,
): Promise<CompactionResult> {
  // T82a: the model whose BOX is actually serving this agent's turns — captured before the
  // summary-writer resolution below can reassign `modelId` to a different (often cheaper,
  // often different-provider) model. The compaction trigger cares about the box that produced
  // the pressure, not the box that will write the summary describing it.
  const turnModelId = options?.dialedModelId ?? modelId;

  // Resolve which model WRITES the summaries (see resolveSummaryWriterModel).
  {
    const resolved = resolveSummaryWriterModel(agentId, modelId);
    if (!resolved) {
      // OR-COMPACT-1 part 3 (review I3): under pressure this is a repairable reason, not a shrug.
      // `force` IS the pressure signal — the gate only forces at ≥96% — so no reorder is needed.
      // ⚠ NOT the brake (t91 M-b): it returns before `compactionIsBraked`; see compaction-defect.
      if (options?.force) notePassOutcome(agentId, true, NO_COMPACTION, { stage: 'summary_writer_unresolvable', modelId: turnModelId });
      logger.warn('No text-capable model available for compaction, skipping', {}, agentId);
      return NO_COMPACTION;
    }
    modelId = resolved;
  }

  // T82 FIX WAVE, I1: `modelId` here is the (possibly reassigned) summary-WRITER model — the
  // output-cap side of the dry run correctly still reads it, unchanged. The CEILING side must
  // read `turnModelId` (the box actually serving this agent's turns, captured above before the
  // reassignment), the SAME model the external `threshold` below keys on — otherwise the two
  // halves of one comparison silently disagree about whose declared speed they are honouring.
  // See `estimateAssembledTokens`'s own `ceilingModelId` doc for the full incident this closes.
  const assembled = await cachedAssembledEstimate(agentId, contextWindow, modelId, () => estimateAssembledTokens(agentId, contextWindow, modelId, { ceilingModelId: turnModelId }));
  const totalTokens = assembled.total;
  const activeThreshold = getContextThreshold();
  const rawThreshold = activeThreshold * contextWindow;
  // T82a: the SAME provider-aware ceiling `memory/budget.ts`'s admission budget keys on
  // (`agent/model.ts`'s `getProviderCeilingTokens`, off the same `getModelInfo` join
  // `refuseIfDoomed` already trusts), applied to the compaction trigger's own threshold so a
  // slow box compacts early and continuously instead of waiting on a percentage of a window it
  // cannot serve at speed. `null` (either half of the provider's declaration is missing —
  // every provider configured before this task) leaves `threshold` exactly
  // `activeThreshold * contextWindow`, byte-identical to today (R6).
  const { getProviderCeilingTokens } = await import('../agent/model.js');
  const providerCeilingTokens = getProviderCeilingTokens(turnModelId);
  const threshold = providerCeilingTokens != null
    ? providerAwareBudgetTokens(rawThreshold, providerCeilingTokens)
    : rawThreshold;

  const force = options?.force ?? false;

  // t140: the row-gap trigger that stood here is deleted (see the STRIP note above
  // `checkAndCompact`'s options). Two triggers remain, and they are the ruling's two: PRESSURE
  // (forced by the gate, or the assembled total over this window's threshold) and ROWS LEAVING
  // THE VIEW (`rowsLeavingView`). The count below is no longer a trigger: it is the size of the
  // pressure path's leaf input (rows outside the floor), which its yield guards read.
  const needsCompactionByTokens = totalTokens > threshold;
  const pressure = force || needsCompactionByTokens;
  const uncompactedOutsideFloor = pressure
    ? (() => {
      const outside = getMessagesOutsideFreshTail(agentId, getFreshTailCount(contextWindow));
      const compacted = getCompactedMessageIds(agentId);
      return outside.filter(m => !compacted.has(m.id)).length;
    })()
    : 0;
  const leaving = pressure ? null
    : options?.leaving !== undefined
      ? options.leaving
      : rowsLeavingView(agentId, { freshTailCount: getFreshTailCount(contextWindow) }, { viewFull: false });

  logger.info(`Compaction check: assembled=${totalTokens} (summaries=${assembled.summaryTokens}, freshTail=${assembled.freshTailTokens}), threshold=${Math.round(threshold)} (${Math.round(activeThreshold * 100)}% of ${contextWindow})${leaving ? `, leaving=${leaving.rowsLeaving} rows (${leaving.cause}) through seq ${leaving.throughSeq}` : ''}${force ? ' [FORCED]' : ''}`, {
    assembledTokens: totalTokens,
    summaryTokens: assembled.summaryTokens,
    freshTailTokens: assembled.freshTailTokens,
    freshTailCount: assembled.freshTailCount,
    summaryCount: assembled.summaryCount,
    threshold: Math.round(threshold),
    contextWindow,
    uncompactedOutsideFloor,
    needsCompactionByTokens,
    leavingCause: leaving?.cause ?? null,
    leavingRows: leaving?.rowsLeaving ?? 0,
    leavingThroughSeq: leaving?.throughSeq ?? null,
    force,
  }, agentId);

  // 90% WARN line (Part V), if under threshold but past 90%, log loudly +
  // broadcast a chat:error severity=warning. Each WARN is an architecture
  // bug to fix in tools/scaffolding/prompts. Fires once per checkAndCompact
  // invocation, not per loop iteration.
  if (!force) {
    const warnRatio = totalTokens / contextWindow;
    if (warnRatio >= CONTEXT_WARN_THRESHOLD && warnRatio < CONTEXT_THRESHOLD) {
      const reason = `Context utilization at ${(warnRatio * 100).toFixed(1)}% (${totalTokens}/${contextWindow}). This should not happen in normal v2 operation, investigate tool result sizes, scaffolding injection, system prompt cost.`;
      logger.warn(reason, { agentId, ratio: warnRatio }, agentId);
      // User-facing toast: plain language, no internal jargon. The technical
      // detail goes to the log where developers can see it.
      const userMsg = `Agent's memory is getting full (${(warnRatio * 100).toFixed(0)}%). Working normally for now.`;
      try {
        broadcast({
          type: 'chat:error',
          agentId,
          error: userMsg,
          code: 'CONTEXT_HIGH',
          severity: 'warning',
          retryable: false,
        });
      } catch { /* best effort */ }
    }
  }

  if (pressure) {
    // No-op guard: if the gate metric is over threshold but there's
    // nothing outside the fresh tail to compact, the bloat IS the fresh
    // tail and compaction can't help. Pre-2026-05-01 we still ran the
    // whole reactive path (continuity brief LLM call, condensation,
    // rebuild, divider broadcast) even when leafCreated would be 0, 
    // and the next turn's gate check tripped again, looping. Now we
    // detect the no-op case and log out cleanly.
    // t140: the pressure path's own leaf-input count (computed above only when pressured).
    const guardUncompactedCount = uncompactedOutsideFloor;
    // Minimum-yield floor (owner report 2026-07-23: "compaction SO much,
    // saving like 16 tokens"). A handful of rows outside the tail passes the
    // zero-guard below, runs the FULL reactive cycle (continuity-brief LLM
    // call, condensation, rebuild, divider), reclaims peanuts, and the
    // still-crossed threshold refires next turn: a compaction treadmill. A
    // tiny outside-tail region cannot reclaim meaningfully; skip it, and
    // after any low-yield run back off for a while. Emergency (force) always
    // bypasses, pressure at 96%+ must act regardless of yield.
    if (compactionIsBraked(agentId, force)) return NO_COMPACTION;
    // ── OR-COMPACT-1: NOTHING LEFT AT THE LEAF IS THE CASE FOR CONDENSATION ──
    // Three things stood here and all three said "no pass can help": t87's pre-work latch
    // `latchIfSummariesExceedBudget` (premise: summaries already over budget ⇒ terminal) and
    // the two `!force` no-op guards that returned zero while the assembly was over budget.
    // That trio IS the incident's state — ~86K of summaries with nothing raw left to fold —
    // and the owner ruled that state is more condensation, not a dead end.
    // ⚠ THE ANTI-THRASH PROPERTY IS NOT LOST, which is what those guards were really for: the
    // pass below runs NO continuity brief, NO archive and NO leaf chunking (so the treadmill
    // of re-summarising a handful of rows cannot happen), it returns early when the assembly
    // is in fact within budget, and a pass that reclaims nothing arms the same 15-minute
    // backoff through `notePassOutcome`.
    if (guardUncompactedCount < MIN_COMPACTABLE_ROWS) {
      return condenseOnlyPass(agentId, modelId, turnModelId, contextWindow, threshold, force, guardUncompactedCount, options);
    }

    // Full reactive compaction
    logger.info('Running full reactive compaction', {
      assembledTokens: totalTokens,
      threshold,
      uncompactedOutsideTail: guardUncompactedCount,
    }, agentId);

    // ── STRIP (t140): THE PRE-COMPACTION CONTINUITY BRIEF IS GONE ──────────────────────────
    // A model call here wrote a 1,500–3,000-word "continuity brief" into `agents.config` before
    // every non-routine compaction, injected for three turns ahead of the conversation
    // (`lane.continuity`, slot 700, inside the cached region) and announced for 24 hours in the
    // system prompt. It asked for the user's last instructions VERBATIM and "what the agent was
    // about to do next … continue exactly from here", built from undated rows with no record of
    // what was already answered — a second "what's current" beside the task list, which the
    // owner ruled is the only one (OR-TRACKER-1), and a carrier of finished work back into a live
    // turn (tracker #7). It existed to bridge compaction cutting what the agent was reading;
    // t140 removes that cause (only rows LEAVING the view are folded), so it is deleted, not
    // repaired (build plan §1 choice 6). requirement preserved: "after a compaction the agent
    // knows what it was working on" — owned by the task list (the tracker survives compaction
    // unchanged) and by the live conversation itself, which a fold no longer reaches into.
    // Migration 187 removes the stored keys.

    // Archive raw messages to vault BEFORE compaction destroys them.
    // If archival fails, ABORT compaction, better to have a bloated context than lost data.
    // Exception: if the agent is on the Dreamer ignore list, the archive is
    // intentionally skipped (returns null). Don't abort compaction in that case.
    const messagesForArchive = getMessagesOutsideFreshTail(agentId, getFreshTailCount(contextWindow));
    const archiveCompactedIds = getCompactedMessageIds(agentId);
    // D1: never re-archive messages already copied to the vault. A reset archives
    // messages without marking them compacted, so without the high-water bound a
    // later compaction would re-copy them (reintroducing the duplicate-blob bloat).
    // This bounds only the ARCHIVE input; compaction itself is unaffected.
    // Migration 088: bound by rowid (tie-free) instead of the old second-granular
    // created_at, which dropped an equal-second boundary row from the archive
    // while it was still compacted (silent loss). A missing rowid falls to
    // "include" so the safe direction is always to archive, never to skip.
    const archiveHighWater = getArchiveHighWaterMark(agentId);
    const uncompactedForArchive = messagesForArchive.filter(
      m => !archiveCompactedIds.has(m.id) && (archiveHighWater == null || m.rowid == null || m.rowid > archiveHighWater),
    );
    // C11: service agents (Healer/Trainer/PM/Imaginer/Dreamer) are excluded from archival, 
    // archiveMessagesBeforeCompaction returns null for them (its own service-agent skip),
    // and this guard previously misread that null as "archive FAILED → abort compaction",
    // so the healer never compacted, grew unbounded, and retried every few seconds. Their
    // histories are pure plumbing (never memory-worthy), so skipping the archive step is
    // correct; compaction then proceeds normally.
    if (uncompactedForArchive.length > 0 && !isDreamerIgnored(agentId) && !isSystemServiceAgent(agentId)) {
      const archiveId = archiveMessagesBeforeCompaction(agentId, uncompactedForArchive);
      if (!archiveId) {
        logger.error('Archive failed, aborting compaction to prevent data loss', { agentId, messageCount: uncompactedForArchive.length }, agentId);
        return { leafCreated: 0, condensedCreated: 0, tokensReclaimed: 0 };
      }
    }

    const tokensBefore = totalTokens;
    const leafCreated = await withCompactionActivity(agentId, () => runLeafCompaction(agentId, modelId, contextWindow, {
      maxChunks: options?.maxChunksPerRun,
      abortSignal: options?.abortSignal,
    }));
    // The pressure path condenses until the assembly fits (OR-COMPACT-1). The routine fold of
    // rows leaving the view never reaches here (`leavingViewPass`), so nothing needs skipping.
    const condensation = await condenseUntilFits(condenseArgs(agentId, modelId, turnModelId, contextWindow, options?.abortSignal));
    const condensedCreated = condensation?.condensedCreated ?? 0;
    rebuildContextItems(agentId);
    // T56 leg (b): the prefix has just been rewritten, so this is the one instant at which
    // retiring reasoning costs no cache reuse. Gated on a summary actually having been
    // created — see the header above `ageOutReplayedReasoning`.
    if (leafCreated > 0) { ageOutReplayedReasoning(agentId); stubOldToolResultsAtBoundary(agentId); }

    // T82 FIX WAVE, I1: same `ceilingModelId` threading as the dry run above — `tokensBefore`
    // (captured from that dry run) and `tokensAfter` must be measured on the SAME ceiling basis
    // or the subtraction below compares two different budgets, not the same budget before/after.
    const tokensAfter = (await cachedAssembledEstimate(agentId, contextWindow, modelId, () => estimateAssembledTokens(agentId, contextWindow, modelId, { ceilingModelId: turnModelId }))).total;
    const tokensReclaimed = tokensBefore - tokensAfter;

    const result = { leafCreated, condensedCreated, tokensReclaimed: Math.max(tokensReclaimed, 0) };

    // v3.2.3 L1, re-aimed by OR-COMPACT-1: the brake, plus the D3 defect report. The stage
    // the condenser named (if any) travels with the numbers, so a pass that ended over
    // budget having reclaimed nothing says WHICH stage refused instead of showing a card.
    notePassOutcome(agentId, Boolean(force), result, { ...passFacts(condensation, threshold, guardUncompactedCount, agentId, modelId), assembledTokens: tokensAfter, tokensBefore });
    broadcast({
      type: 'memory:compaction',
      agentId,
      ...result,
    });

    // Insert a chat divider only when something *actually* changed.
    // A reactive compaction that created no summaries and reclaimed no
    // meaningful tokens is just noise in the timeline (and was a symptom
    // of the pre-v1.15.108 runaway-loop bug). The no-op guard above
    // should catch most of those, but also gate the divider as
    // belt-and-braces.
    // v2.5.29, Show the divider on routine drains too, throttled to once
    // per 10 min per agent. Pre-v2.5.29 routine drains suppressed it
    // entirely (because backlog upgrades would emit one per turn); the
    // side effect was zero compaction visibility on normal long tasks,
    // which is exactly the path that hits compaction most often. The
    // throttle covers both: backlog stays quiet across rapid drains,
    // normal flow gets a marker the user can actually see.
    if (
      (result.leafCreated > 0 || result.condensedCreated > 0 || result.tokensReclaimed > 1000) &&
      shouldShowCompactionDivider(agentId)
    ) {
      insertCompactionDivider(agentId, {
        label: `Memory Compacted${result.tokensReclaimed > 0 ? `, reclaimed ~${formatTokens(result.tokensReclaimed)}` : ''}${result.leafCreated > 0 ? ` (${result.leafCreated} new summar${result.leafCreated === 1 ? 'y' : 'ies'})` : ''}`,
      });
    }

    if (result.tokensReclaimed < 2000 && result.leafCreated <= 1) {
      // The run happened and bought almost nothing; the threshold will still
      // be crossed next turn. Back off instead of treadmilling.
      noteLowYield(agentId);
    }
    logger.info('Compaction complete', result, agentId);
    return result;
  }

  // ── STRIP (t140): THE "PROACTIVE LEAF COMPACTION" ARM IS GONE ──────────────────────────
  // It folded every unsummarised row outside the newest row cap once they held 30,000 tokens,
  // with no pressure at all — a second non-pressure trigger, and after t94 those rows were IN
  // the live view. requirement preserved: "rows do not accumulate unsummarised past the view"
  // — owned by `rowsLeavingView` (ceiling cause) and `leavingViewPass` below.
  if (leaving) return leavingViewPass(agentId, modelId, contextWindow, leaving, options);
  logger.info('Compaction skipped: no pressure on this window and nothing is leaving the live view', {
    assembledTokens: totalTokens, threshold: Math.round(threshold),
  }, agentId);
  return { leafCreated: 0, condensedCreated: 0, tokensReclaimed: 0 };
}

// ── OR-COMPACT-1 — the recursion's three call-site helpers ──────────────────────────────
//
// The policy itself lives in `memory/condense-until-fits.ts`. These three are only the seam:
// what to pass it, what to tell the brake afterwards, and the leaf-less pass. They sit here
// because the SINGLE assembled estimate and `rebuildContextItems` are this module's, and the
// condenser takes both as arguments precisely so there is never a second estimator.

/** The condenser's arguments, with THE single estimate wired in as its `measure`. */
function condenseArgs(
  agentId: string, modelId: string, turnModelId: string, contextWindow: number,
  abortSignal?: AbortSignal,
): Parameters<typeof condenseUntilFits>[0] {
  return {
    agentId, modelId,
    minFanout: DEFAULTS.condensedMinFanout,
    targetTokens: DEFAULTS.condensedTargetTokens,
    abortSignal,
    measure: () => cachedAssembledEstimate(agentId, contextWindow, modelId, () =>
      estimateAssembledTokens(agentId, contextWindow, modelId, { ceilingModelId: turnModelId })),
    rebuild: () => rebuildContextItems(agentId),
  };
}

/** What the brake and the defect line need to know about the pass that just ran. */
function passFacts(
  condensation: CondensationOutcome | null, budgetTokens: number,
  compactableRows: number, agentId: string, modelId: string,
): Parameters<typeof notePassOutcome>[3] {
  return {
    stage: condensation?.refusedStage ?? null, detail: condensation?.refusedDetail ?? null,
    assembledTokens: condensation?.assembledTotalAfter, budgetTokens,
    summaryTokens: condensation?.summaryTokensAfter, admittedSummaryTokens: condensation?.admittedSummaryTokens,
    compactableRows, topLevelSummaries: condensableSummaries(agentId), modelId,
  };
}

/**
 * THE LEAF-LESS PASS — over budget with nothing raw left to fold, which is the incident's
 * own state and used to be the dead end.
 *
 * It runs condensation and nothing else: no archive (there
 * is nothing to archive), no leaf chunking (the handful of rows outside the tail is below the
 * floor that makes folding them worth a model call). An assembly that is in fact within this
 * module's own threshold returns before spending anything at all.
 */
async function condenseOnlyPass(
  agentId: string, modelId: string, turnModelId: string, contextWindow: number,
  threshold: number, force: boolean, compactableRows: number, options?: CheckAndCompactOptions,
): Promise<CompactionResult> {
  const args = condenseArgs(agentId, modelId, turnModelId, contextWindow, options?.abortSignal);
  // Asked BEFORE the activity broadcast, so a tail-bloated agent does not flicker
  // "Compacting memory" on the dashboard every turn for work nobody is going to do.
  const est = await args.measure();
  if (rawContextSummaryTokens(agentId) <= est.summaryTokens && est.total <= threshold) {
    logger.info('Compaction skipped: nothing outside the fresh tail, and every summary already fits', {
      assembledTokens: est.total, threshold, uncompactedOutsideTail: compactableRows,
    }, agentId);
    return NO_COMPACTION;
  }
  const condensation = await withCompactionActivity(agentId, () => condenseUntilFits(args));
  // ⚠ RECLAIMED IN SUMMARY TOKENS, NOT IN THE GATE'S TOTAL, and the module header says why:
  // the gate's total already reports the CAPPED figure, so condensation cannot move it. What
  // these tokens buy is oldest summaries NOT being dropped from the agent's context.
  const result = {
    leafCreated: 0, condensedCreated: condensation.condensedCreated,
    tokensReclaimed: Math.max(condensation.summaryTokensBefore - condensation.summaryTokensAfter, 0),
  };
  notePassOutcome(agentId, force, result, passFacts(condensation, threshold, compactableRows, agentId, modelId));
  broadcast({ type: 'memory:compaction', agentId, ...result });
  logger.info('Condensation-only compaction complete', {
    ...result, levels: condensation.levels, modelCalls: condensation.modelCalls,
    deepestDepth: condensation.deepestDepth, fits: condensation.fits,
    summaryTokens: condensation.summaryTokensAfter, admittedSummaryTokens: condensation.admittedSummaryTokens,
    assembledTokens: condensation.assembledTotalAfter, threshold,
  }, agentId);
  return result;
}

/**
 * t140 — THE LEAVING-VIEW PASS. Fold exactly the rows `rowsLeavingView` named, and nothing the
 * agent is still reading.
 *
 * The leaf machinery is the pressure path's own (archive first, abort if the archive fails,
 * chunk, summarise, rebuild, age out at the boundary), pointed at one bounded span: every
 * unsummarised row of this session with `seq <= leaving.throughSeq`. No condensation of older
 * summaries here: that is pressure's job (OR-COMPACT-1's recursion, on the forced path), and a
 * fold of leaving rows is not pressure. No backoff is ARMED by a small yield either — the span
 * is leaving the view whatever it reclaims — but an existing brake is honoured, so a summary
 * writer that keeps failing is not dialed again every turn.
 *
 * t140 round 3 (R-V333-10 item 5): EXCEPT cause 'out-of-view' — rows the view has already dropped
 * are owed their fold now; the brake (built for low-yield pressure passes) neither blocks it nor is
 * armed or reset by it. Its own bound, writer fallback and placeholders live in its door.
 */
export async function leavingViewPass(
  agentId: string, modelId: string, contextWindow: number, leaving: LeavingView,
  options?: CheckAndCompactOptions,
): Promise<CompactionResult> {
  const outOfView = leaving.cause === 'out-of-view';
  if (!outOfView && compactionIsBraked(agentId, false)) return NO_COMPACTION;
  logger.info('Condensing rows leaving the live view', {
    cause: leaving.cause, rowsLeaving: leaving.rowsLeaving, throughSeq: leaving.throughSeq,
  }, agentId);

  const archiveHighWater = getArchiveHighWaterMark(agentId);
  const compactedIds = getCompactedMessageIds(agentId);
  const floorRows = outOfView ? 1 : getFreshTailCount(contextWindow);
  const span = getMessagesOutsideFreshTail(agentId, floorRows)
    .filter(m => !compactedIds.has(m.id) && (m.rowid ?? Number.POSITIVE_INFINITY) <= leaving.throughSeq);
  const toArchive = span.filter(m => archiveHighWater == null || m.rowid == null || m.rowid > archiveHighWater);
  if (toArchive.length > 0 && !isDreamerIgnored(agentId) && !isSystemServiceAgent(agentId)) {
    if (!archiveMessagesBeforeCompaction(agentId, toArchive)) {
      logger.error('Archive failed, aborting the leaving-view condense to prevent data loss', { agentId, messageCount: toArchive.length }, agentId);
      return NO_COMPACTION;
    }
  }

  const leafCreated = await withCompactionActivity(agentId, () => runLeafCompaction(agentId, modelId, contextWindow, {
    maxChunks: options?.maxChunksPerRun,
    abortSignal: options?.abortSignal,
    throughSeq: leaving.throughSeq,
    floorRows,
  }));
  rebuildContextItems(agentId);
  // T56 leg (b): the prefix has just been rewritten at the summaries lane, so this is the one
  // instant at which retiring reasoning and stubbing old tool results costs no cache reuse.
  if (leafCreated > 0) { ageOutReplayedReasoning(agentId); stubOldToolResultsAtBoundary(agentId); }

  const result = { leafCreated, condensedCreated: 0, tokensReclaimed: 0 };
  if (!outOfView) notePassOutcome(agentId, false, result);
  broadcast({ type: 'memory:compaction', agentId, ...result });
  if (leafCreated > 0 && shouldShowCompactionDivider(agentId)) {
    insertCompactionDivider(agentId, {
      label: `Memory Compacted (${leafCreated} summar${leafCreated === 1 ? 'y' : 'ies'} of messages leaving view)`,
    });
  }
  logger.info('Leaving-view condense complete', { ...result, cause: leaving.cause }, agentId);
  return result;
}

// t140 round 3: the engine's out-of-view assembly door moved to `memory/out-of-view-fold.ts`, with
// its own bound, a writer fallback and placeholders; it calls `leavingViewPass` below.

// ── T56 leg (b) — the age-out, and the boundary it may never cross ──────────────────────
//
// THE COST. Stored `reasoning_content` replays on every assistant row that carries a tool
// call, for as long as that row is in the live tail. It is the model's thinking about a tool
// chain that finished, and nothing re-reads it once the chain is done — but on the dev body
// a single 40-row window carried up to 78,909 tokens of it, and the 80-row window of the
// primary agent carried 17,513, of which ZERO belonged to the turn in progress.
//
// THE BOUNDARY, and why this is cache-safe rather than cache-costly. Dropping reasoning from
// a row changes bytes the provider has already cached, so it may happen ONLY at an instant
// when the prefix is being rewritten anyway. A compaction that created a leaf summary is
// exactly that instant: the summaries lane (slot 300) sits ahead of the fresh tail, so the
// cached prefix is re-formed from the summary onward regardless. `leafCreated > 0` is the
// gate; a run that summarised nothing moves nothing (and the background gap-drain, which is
// fire-and-forget and CAN overlap a live turn, is bound by the same rule).
//
// THE CUT, chosen from the measurement and not from taste. The provider needs reasoning for
// the ACTIVE tool chain and nothing else: dsh's own serialiser omits `reasoning_content`
// entirely on a tool-call turn that has none (`llm-deepseek/src/serialize.ts:96-100`), and
// our `requiresReasoningReplay` contract is satisfied by the `''` fallback that already
// ships on every reasoning-less tool-call row today. So the cut is the TURN: rows of the
// agent's current turn keep their reasoning; everything older is retired. `turn_number` is
// never null on a replayable row (measured: 0 of 7,575 on the dev body), and a
// `currentTurnNumber` that fails answers 0, which retires nothing — the fail-safe direction.

/**
 * Retire the reasoning of every row older than the ACTIVE turn. One-way, durable, and only
 * ever called from a compaction that has already rewritten this agent's prefix.
 *
 * Returns the number of rows retired, for the caller's log line.
 */
export function ageOutReplayedReasoning(agentId: string): number {
  const activeTurn = currentTurnNumber(agentId);
  // The write itself belongs to the single writer of `messages`; this function owns WHEN.
  const rowsRetired = retireReplayedReasoningBeforeTurn({ agentId, activeTurn });
  if (rowsRetired > 0) {
    logger.info('Retired replayed reasoning at a compaction boundary', {
      rowsRetired, activeTurnProtected: activeTurn,
    }, agentId);
  }
  return rowsRetired;
}

// ── T67b — THE TOOL-RESULT STUB CROSSES THE SAME BOUNDARY, FOR THE SAME REASON ──────────
//
// `stubOldToolResults` (`memory/assembler.ts`) replaced the content of every tool_result
// older than `V2_STUB_AFTER_TURNS` with a short stub. Correct in intent — context stays
// roughly flat as the agent works — but it RE-DERIVED the decision from the LIVE TURN
// COUNTER on every assembly, so on a 200K window (80 tail rows, ~15-20 turns) a row twelve
// turns back flipped from full to stubbed MID-SESSION, rewriting bytes in the middle of the
// history with no compaction anywhere near it. That is precisely what T56 leg (b)'s
// boundary rule forbids, one column over, and the note above states the rule in full: a byte
// the provider has already cached may move only at an instant when the prefix is being
// rewritten anyway.
//
// So the DECISION moves here and becomes a durable watermark. The rule itself is unchanged —
// the same `V2_STUB_AFTER_TURNS` distance from the same active turn — and the watermark is
// monotonic (`Math.max` against what is already recorded), so a row that has been stubbed
// stays stubbed and no row is ever stubbed twice at two different widths.
//
// WHERE IT LIVES: `agents.config.toolResultsStubbedBeforeTurn`, an integer. No migration:
// this is a per-agent scalar of exactly the kind that column already holds
// (the deleted continuity brief's turn horizon was its precedent), and the assembler
// reads it on a path that already reads this config. The read stays PURE (PHASE-3 S3) —
// assembly never writes it.
//
// WHAT IT COSTS, stated rather than discovered: between two compactions, tool results older
// than twelve turns are now REPLAYED instead of stubbed. They are still capped per row by
// `capLargeToolResultStrings` and still evictable by `budgetFreshTail`, so the window is
// protected by the two mechanisms that were always protecting it; what changes is that the
// growth is paid in cached tokens rather than in a prefix rewrite every single turn.

export function stubOldToolResultsAtBoundary(agentId: string): number {
  const activeTurn = currentTurnNumber(agentId);
  const before = activeTurn - V2_STUB_AFTER_TURNS;
  if (!Number.isFinite(before)) return 0;
  const db = getDb();
  const row = db.prepare('SELECT config FROM agents WHERE id = ?').get(agentId) as
    { config: string | null } | undefined;
  let cfg: Record<string, unknown> = {};
  try { cfg = row?.config ? JSON.parse(row.config) as Record<string, unknown> : {}; } catch { cfg = {}; }
  const prior = typeof cfg.toolResultsStubbedBeforeTurn === 'number'
    ? cfg.toolResultsStubbedBeforeTurn : Number.NEGATIVE_INFINITY;
  const next = Math.max(prior, before);
  if (!(next > prior)) return 0;
  cfg.toolResultsStubbedBeforeTurn = next;
  db.prepare('UPDATE agents SET config = ? WHERE id = ?').run(JSON.stringify(cfg), agentId);
  logger.info('Advanced the tool-result stub watermark at a compaction boundary', {
    watermarkTurn: next, activeTurn,
  }, agentId);
  return next;
}

// ── Leaf Compaction ──

/**
 * THE summarizer's leaf input. PHASE-3 T5 Step 1c (research 06 E19: "dedupe buildLeafInput
 * + fresh-read extractor — one builder, one extractor, both imported").
 *
 * This was written twice, byte-identically: inline here and as `buildLeafInput` in
 * `memory/summary-rebuild.ts`, whose whole job is to REPLAY this exact transformation over
 * an old summary's source messages and check whether the result is still contaminated. Two
 * copies of a replay is the one duplication that cannot be tolerated: the moment they drift,
 * the nightly rebuild is measuring a summariser that does not exist, and it either loops
 * forever on rows it can never clean or declares clean rows it never fixed.
 *
 * Every clause is load-bearing and each one is an incident:
 *   • the NOISE FILTER — without it the summarizer folded another agent's completion dump
 *     into the primary's context summary and the model narrated that work back to the user
 *     (the repeated "Dreamer batch" summaries). The vault already stripped these; this is
 *     what makes live compaction agree with it.
 *   • the PARTY TAG — so the summarizer can carry attribution into every fact.
 *   • the SCRUBS — a technique body or a credential value must never reach a persisted
 *     summary (`scrubStubFor`), because a summary is re-injected across sessions.
 */
export function buildLeafSummaryInput(messages: Message[]): string {
  const answered = answeredAskTurns(messages);
  return messages
    .filter(m => !isNonConversationForSummary(m.content))
    .map(m => {
      const role = m.role.toUpperCase();
      const party = summaryPartyTag(m);
      const base = party ? `${role} · ${party}` : role;
      const servedBy = answered.get(m.id);
      const tag = servedBy == null ? base : `${base} · ${ANSWERED_TAG} in turn ${servedBy}`;
      return `[${tag}] ${condenseToolJsonForSummary(scrubTechniqueContentForSummary(m.content))}`;
    })
    .join('\n\n---\n\n');
}

/** The literal the input builder writes and the summariser's own instruction names. One
 *  token, so the writer, the prompt and the tests cannot drift apart. Deliberately free of
 *  `]` — `summary-rebuild.ts`'s `ROLE_TAG_RE` strips `^\s*\[(USER|…)\b[^\]]*\]`, and a
 *  bracket inside the tag would break the replay that file exists to perform. */
export const ANSWERED_TAG = 'ANSWERED';

/**
 * UX-REPAIR ROUND 6 T24 — THE ASK'S ANSWERED STATE TRAVELS WITH THE ASK.
 *
 * T20's law, one surface further on: the spine is the only truth, and a summary is the
 * context around it. A summary that lists the afternoon's questions with no record that they
 * were ANSWERED is a parallel memory of obligations wearing a narrative's clothes — and it is
 * what the model read on 2026-08-10 at turn 4656 before it re-ran the weather and vet asks and
 * re-delivered research it had finished 100 seconds earlier.
 *
 * The state is asked of the LEDGER (`messages.answer_message_id` / `served_by_turn`, migration
 * 113 — the same stamps `engine.recently-answered` reads), never inferred from the prose, and
 * it is resolved HERE, at write, for the same reason T20 resolves where it does: summaries ride
 * `MessageSlot.Summaries = 300`, inside the cacheable prefix. Stored once, read as stored.
 *
 * It rides the INPUT rather than being appended to the output because there is no id token in
 * a user-ask line to key an annotation on, and keying one on the prose is the parser `839eedc`
 * deleted. `summary-rebuild.ts` replays through this same builder, so the replay stays honest.
 */
function answeredAskTurns(messages: Message[]): Map<string, number> {
  const out = new Map<string, number>();
  const asks = messages.filter(m => m.role === 'user');
  if (asks.length === 0) return out;
  try {
    const stmt = getDb().prepare(
      `SELECT served_by_turn AS turn FROM messages
        WHERE id = ? AND answer_message_id IS NOT NULL AND served_by_turn IS NOT NULL`,
    );
    for (const ask of asks) {
      const row = stmt.get(ask.id) as { turn: number } | undefined;
      if (row) out.set(ask.id, row.turn);
    }
  } catch { /* best effort: a missing stamp must never cost the summary itself */ }
  return out;
}

/**
 * Does this span hold anything the ledger calls CONVERSATION?
 *
 * The placeholder branch below claims "no user conversation in this span" and then marks the
 * rows compacted, which destroys them. The claim must be answered by the record, not by the
 * content filter that produced the empty string: the filter is anchored prose matching, and a
 * genuine answer that opens "I'm sorry — I'm having trouble…" reads to it as plumbing.
 *
 * MEASURED on the dev body before it was written (2026-08-10): all three genuine placeholder
 * summaries hold ZERO owner-lane user rows and ZERO answer stamps, so they still take the
 * branch; the eaten spans hold 7 and 3, so they never could again.
 */
function spanHoldsConversation(agentId: string, messageIds: string[]): boolean {
  const stmt = getDb().prepare(
    `SELECT 1 FROM messages m
      WHERE m.agent_id = ? AND m.id = ?
        AND ( (m.role = 'user' AND m.lane = 'owner')
           OR m.answer_message_id IS NOT NULL
           OR EXISTS (SELECT 1 FROM messages a
                       WHERE a.agent_id = m.agent_id AND a.answer_message_id = m.id)
           OR EXISTS (SELECT 1 FROM turns t
                       WHERE t.agent_id = m.agent_id AND t.answer_message_id = m.id) )
      LIMIT 1`,
  );
  for (const id of messageIds) {
    if (stmt.get(agentId, id)) return true;
  }
  return false;
}

export async function runLeafCompaction(
  agentId: string,
  modelId: string,
  contextWindow?: number,
  opts?: {
    maxChunks?: number; abortSignal?: AbortSignal;
    /** t140: fold only rows with `seq <= throughSeq` (the leaving-view span). Absent: every
     *  unsummarised row outside the floor, the pressure path's input. */
    throughSeq?: number;
    /** t140 round 2: the newest rows this fold may not take. Absent: the window's floor. A fold
     *  of rows the trim already took out of view passes 1 — the floor bounds what PRESSURE may
     *  fold, not what the trim takes, and the newest row is never out of view. */
    floorRows?: number;
  },
): Promise<number> {
  const cw = contextWindow ?? 200000;
  const messagesOutside = getMessagesOutsideFreshTail(agentId, opts?.floorRows ?? getFreshTailCount(cw));
  const compactedIds = getCompactedMessageIds(agentId);
  const through = opts?.throughSeq;

  // Filter to only uncompacted messages (chronological, oldest first, that's
  // what getMessagesOutsideFreshTail returns).
  const uncompacted = messagesOutside.filter(m => !compactedIds.has(m.id)
    && (through === undefined || (m.rowid ?? Number.POSITIVE_INFINITY) <= through));

  if (uncompacted.length === 0) {
    logger.debug('No messages to compact', {}, agentId);
    return 0;
  }

  // Group into chunks of ~leafChunkTokens. Chunks come out in chronological
  // order (oldest first), which matters for maxChunks: when capped, we drain
  // the OLDEST gap first so newer messages stay raw in fresh tail longer.
  const allChunks = chunkMessages(uncompacted, getLeafChunkTokens());
  const chunks = opts?.maxChunks ? allChunks.slice(0, opts.maxChunks) : allChunks;

  logger.info('Leaf compaction: processing chunks', {
    totalMessages: uncompacted.length,
    chunkCount: chunks.length,
    chunksAvailable: allChunks.length,
    capped: opts?.maxChunks ? true : false,
  }, agentId);

  let summariesCreated = 0;

  for (const chunk of chunks) {
    if (chunk.length === 0) continue;
    if (summaryWriterUnavailable(agentId, modelId)) break;   // v3.2.3 L2c/L3: do not build what cannot be sent

    // Build content from chunk messages. scrubTechniqueContentForSummary
    // strips technique tool-result bodies so they don't leak into the
    // summary the model writes next (and which the agent would later
    // read as authoritative, bypassing freshness enforcement).
    // condenseToolJsonForSummary then flattens remaining tool_use/tool_result
    // JSON to one-liners: fed verbatim, the summarizer quotes raw JSON into
    // summaries (observed live), wasting tokens on wire format while keeping
    // none of the meaning beyond tool name + outcome, which the one-liner keeps.
    const content = buildLeafSummaryInput(chunk);

    const messageIds = chunk.map(m => m.id);
    const earliestAt = chunk[0].createdAt;
    const latestAt = chunk[chunk.length - 1].createdAt;

    try {
      // Bail out fast if a caller-supplied abort signal has already fired
      // (e.g. background-drain wall-clock timeout). Prevents starting a
      // brand-new chunk's LLM call after the caller has given up.
      if (opts?.abortSignal?.aborted) {
        logger.info('Leaf compaction aborted before chunk started', {
          messageCount: chunk.length, summariesCreated,
        }, agentId);
        break;
      }
      // A chunk that was ENTIRELY inter-agent/lifecycle plumbing has no
      // conversation to summarize. Skip the LLM round-trip and record a minimal
      // placeholder so the rows are still marked compacted + removed from the live
      // tail (bookkeeping intact) without inventing narrative from plumbing.
      //
      // UX-REPAIR ROUND 6 T24: "entirely plumbing" is now the LEDGER'S verdict, not the
      // content filter's. The filter is anchored prose matching; the branch it feeds marks
      // rows compacted, and that is irreversible. Where the two disagree the span is LEFT
      // UNCOMPACTED — the SUMMARY_REFUSED law four branches down, applied to the same cost:
      // writing the placeholder over a span holding a real ask would be a lie about a span
      // the summariser never read, and the rows would then be marked done.
      if (content.trim().length === 0) {
        if (spanHoldsConversation(agentId, messageIds)) {
          logger.warn('COMPACTION_REFUSED filtered-empty chunk holds ledger conversation; left uncompacted', {
            messageCount: chunk.length, earliestAt, latestAt,
          }, agentId);
          continue;
        }
        createLeafSummary(
          agentId,
          NO_CONVERSATION_PLACEHOLDER,
          estimateTokens(NO_CONVERSATION_PLACEHOLDER),
          messageIds,
          earliestAt,
          latestAt,
        );
        summariesCreated++;
        continue;
      }

      const summary = await generateSummary({
        content,
        depth: 0,
        targetTokens: DEFAULTS.leafTargetTokens,
        agentId,
        modelId,
        abortSignal: opts?.abortSignal,
      });

      // PHASE-3 T5 Step 2: a REFUSAL leaves the chunk exactly where it is. `createLeafSummary`
      // is what marks these message ids compacted, so skipping it is what makes the span
      // survive to be summarised on the next drain. Writing NO_CONVERSATION_PLACEHOLDER here
      // instead would be a lie about a span the summariser never read — and an irreversible
      // one, because the rows would then be marked done.
      if (!summary.ok) {
        logger.warn('SUMMARY_REFUSED leaf chunk left uncompacted', {
          messageCount: chunk.length, reason: summary.reason,
        }, agentId);
        continue;
      }

      // PHASE-2 T7: the fenced-section ingest is GONE. Compaction used to run the summarizer's
      // output through a parser that upserted rows into the prose-parsed obligation store and
      // then stripped the section back out of the text it had just been handed — a summariser
      // writing the obligation ledger. Obligations are `work` rows created when the obligation
      // is made (4a), so a summary is a summary again: stored exactly as it was generated.
      // (The table name is deliberately not written here: T10's grep-zero list carries the
      // token, and a comment is not worth a false hit on it.)

      // ── UX-REPAIR ROUND 4 T20 — THE CITED ID IS FINALLY DEREFERENCED ──
      // The tombstone above records what `839eedc` removed and why: a summariser must not
      // write the obligation ledger. It also added the instruction to CITE the work id, and
      // nothing was ever built to read it, so a promise that died four days ago kept being
      // served in the present tense from a stored summary while the OPEN WORK block in the
      // same prompt correctly carried nothing. Resolving the id is not the deleted mechanism
      // returning: nothing is parsed into a second table, no obligation is created, and the
      // agent's sentence is left intact with the spine's answer appended beside it.
      //
      // It happens HERE, at write, because summaries ride slot 300 — the CACHEABLE PREFIX.
      // Resolving at render would rewrite prefix bytes on a turn that changed nothing, which
      // is the line T17 declined to cross for the recall lane and the reason it could fix the
      // vault for free. Stored once, read as stored, for ever after.
      //
      // ROUND 7 T28: the agent is passed because the id-LESS leg is agent-scoped — it may only
      // ever match a line against THIS agent's own commitment rows. Without it the call is
      // T20's, unchanged.
      const resolvedText = annotateSummaryObligations(summary.text, agentId);
      createLeafSummary(
        agentId,
        resolvedText,
        resolvedText === summary.text ? summary.tokenCount : estimateTokens(resolvedText),
        messageIds,
        earliestAt,
        latestAt,
      );

      summariesCreated++;
    } catch (err) {
      logger.error('Failed to create leaf summary for chunk', {
        messageCount: chunk.length,
        error: err instanceof Error ? err.message : String(err),
      }, agentId);
    }
  }

  return summariesCreated;
}

// ── Rebuild Context Items ──

export function rebuildContextItems(agentId: string): void {
  // Get all summaries that are NOT parents in summary_parents
  // i.e., the "leaf nodes" of the DAG (top of the tree, highest depth)
  const db = getDb();

  // Look up agent's model context window for tail sizing
  const agentModel = db.prepare('SELECT model_id FROM agents WHERE id = ?').get(agentId) as { model_id: string | null } | undefined;
  let contextWindow = 200000; // default
  if (agentModel?.model_id) {
    const model = db.prepare('SELECT context_window FROM models WHERE id = ?').get(agentModel.model_id) as { context_window: number | null } | undefined;
    if (model?.context_window) contextWindow = model.context_window;
  }

  interface TopLevelRow {
    id: string;
    earliest_at: string;
  }

  const topLevel = db.prepare(`
    SELECT s.id, s.earliest_at FROM summaries s
    WHERE s.agent_id = ?
      AND s.id NOT IN (
        SELECT parent_id FROM summary_parents
      )
    ORDER BY s.earliest_at ASC, s.id ASC
  `).all(agentId) as TopLevelRow[];

  // Fresh tail messages
  const freshTail = getRecentMessages(agentId, getFreshTailCount(contextWindow));

  // Build context items: summaries first, then fresh tail messages
  const items: Array<{ itemType: 'message' | 'summary'; itemId: string }> = [];

  for (const summary of topLevel) {
    items.push({ itemType: 'summary', itemId: summary.id });
  }

  for (const msg of freshTail) {
    items.push({ itemType: 'message', itemId: msg.id });
  }

  replaceContextItems(agentId, items);

  logger.info('Rebuilt context items', {
    summaryCount: topLevel.length,
    freshTailCount: freshTail.length,
  }, agentId);
}

// ── Helpers ──

// Persisted tool rows (and assistant tool_use rows) are raw JSON arrays.
// For the summarizer they are flattened to one-liners that keep WHAT happened
// (tool name, ok/error, a short result head) and drop the wire format. Pure
// text content passes through untouched.
export function condenseToolJsonForSummary(content: string): string {
  const trimmed = content.trim();
  if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) return content;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    const lines: string[] = [];
    for (const b of arr) {
      if (!b || typeof b !== 'object') continue;
      const block = b as { type?: string; name?: string; text?: string; content?: unknown; is_error?: boolean };
      if (block.type === 'tool_use') {
        lines.push(`(called tool ${block.name ?? 'unknown'})`);
      } else if (block.type === 'tool_result') {
        const body = typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '');
        lines.push(`(tool result${block.is_error ? ' ERROR' : ''}: ${body.slice(0, 200)})`);
      } else if (block.type === 'text' && typeof block.text === 'string') {
        lines.push(block.text);
      }
    }
    return lines.length > 0 ? lines.join('\n') : content;
  } catch {
    return content; // not JSON after all
  }
}

export function chunkMessages(messages: Message[], targetTokens: number): Message[][] {
  const chunks: Message[][] = [];
  let currentChunk: Message[] = [];
  let currentTokens = 0;

  for (const msg of messages) {
    const msgTokens = msg.tokenCount ?? estimateTokens(msg.content);

    if (currentTokens + msgTokens > targetTokens && currentChunk.length > 0) {
      chunks.push(currentChunk);
      currentChunk = [];
      currentTokens = 0;
    }

    currentChunk.push(msg);
    currentTokens += msgTokens;
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  return chunks;
}
