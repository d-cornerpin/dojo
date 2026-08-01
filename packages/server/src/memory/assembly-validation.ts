// ════════════════════════════════════════════════════════════════════════════════════════
// EXIT VALIDATION. One validator between assembly and the provider, for every transport.
// PHASE-3 T4. Research 06 requirements C9, C10, C11.
// ════════════════════════════════════════════════════════════════════════════════════════
//
// ── WHAT STOOD HERE BEFORE ──────────────────────────────────────────────────────────────
// Nothing. Research 06 §3: "Exit-boundary validation — NONE in assembler." The assembler
// returned its array with no final size or shape check, and `applyIntegrityPass` ran BEFORE
// six further mutations and before the loop's own tail-append.
//
// The only size authority in the tree is a pair of provider FRONT-TRIMMERS — `model.ts`'s
// Anthropic block (splice(0,1) until it fits) and its OpenAI block (splice(1,1)) — which
// delete the OLDEST messages with no notion of priority, and the Anthropic one, when the
// array is STILL over after trimming, "logs a warning and SENDS ANYWAY". That is the exact
// shape requirement C11 names: warn-and-send.
//
// ── THE THREE REQUIREMENTS, AND WHERE EACH ONE LIVES ────────────────────────────────────
//   C9  one `validateAssembly()` between assembly and `callModel`, running AFTER every
//       mutation, the SAME for every agent type — no PM bypass. `validateAssembly` below
//       takes no agent-TYPE input at all, so there is no signature through which an
//       exemption could later be added; the `agentId` it does take is for the log line.
//   C10 on violation, repair in PRIORITY order — drop the lowest lane — NEVER oldest-first.
//       `repairAssembly` below. When it cannot identify lanes it REFUSES rather than
//       falling back to oldest-first, because the fallback IS the mechanism being deleted.
//   C11 unrepairable is a THROW (`AssemblyValidationError`), never a warning.
//
// ── THE MODE, AND WHY IT IS DETECT TODAY ────────────────────────────────────────────────
// `ASSEMBLY_VALIDATION_MODE` is `'detect'` for a dated 7-calendar-day window (PHASE-3 T4
// Step 2's AS-BUILT note carries the literal start date and SHA). In detect mode the
// validator LOGS divergence and the call proceeds — the front-trimmers are still the
// surviving ceiling backstop and T4's sequencing rider forbids deleting them while this is
// only detecting. On day 7 ONE constant below flips to `'repair'` and both front-trimmers
// are deleted IN THE SAME COMMIT (T4 Step 2b). Coupled, never separate: repair without the
// deletion is two authorities; deletion without repair is no authority at all.
//
// ── WHAT THIS MODULE DELIBERATELY DOES NOT DO ───────────────────────────────────────────
// It does not repair SHAPE. Orphan tool blocks are `sanitizeOrphanToolBlocks`'s job and it
// runs immediately before this — layered defense, not a duplicate mechanism (Part I). This
// validator REPORTS shape violations so a survivor after that sanitizer is visible instead
// of silently 400-ing at the provider. The one shape thing it does do is re-normalise the
// HEAD after a drop it made itself, because a repair that leaves the array starting on an
// assistant turn has traded one violation for another.
// ════════════════════════════════════════════════════════════════════════════════════════
import type Anthropic from '@anthropic-ai/sdk';
import { createLogger } from '../logger.js';
import { messageTokens, LANE_PRIORITY } from './lanes.js';
import { contextWindowPolicy, estimateTokens } from './budget.js';

const logger = createLogger('assembly-validation');

export type ValidatedMessage = {
  role: 'user' | 'assistant';
  content: string | Anthropic.ContentBlockParam[];
  reasoningContent?: string;
};

export type AssemblyValidationMode = 'detect' | 'repair';

/**
 * THE MODE. `'detect'` until T4 Step 2b's dated flip; `'repair'` after it, in the same
 * commit that deletes both provider front-trimmers. PHASE-3 T9's exit gate asserts
 * `'repair'`, and `assembly-validation.test.ts` pins whichever value is current so the flip
 * is a one-line change with a test that notices it.
 */
export const ASSEMBLY_VALIDATION_MODE: AssemblyValidationMode = 'detect';

export type ViolationCode =
  | 'empty-assembly'
  | 'budget-exceeded'
  | 'first-message-not-user'
  | 'first-message-leads-with-tool-result'
  | 'last-message-is-assistant'
  | 'tool-use-without-result'
  | 'tool-result-without-use'
  | 'empty-block'
  | 'empty-message';

export interface AssemblyViolation {
  code: ViolationCode;
  /** Plain words. Never empty — a verdict with no reason is what this replaces. */
  detail: string;
  /** Index in the validated array, where the violation belongs to one message. */
  index?: number;
}

export interface ValidateOptions {
  /**
   * What this array was allowed to cost, in tokens of the ONE estimator. At the provider
   * boundary that is the assembler's own remaining budget: `assemblyBudgetTokens` minus the
   * system prompt. Passing the same number the assembler spent against is what makes a
   * divergence mean "something after the assembler grew the array".
   */
  budgetTokens: number;
  /**
   * Lane id per message, ALIGNED to `messages` — `null` for a message no lane owns (the
   * loop's tail-append, the volatile near-tail). Only used by `repairAssembly`. Absent
   * means the repair has no priority map and must refuse; see C10 above.
   */
  laneIds?: ReadonlyArray<string | null>;
  /** For the log line and the error text. NEVER consulted to decide anything (C9). */
  agentId?: string;
}

export interface AssemblyValidation {
  ok: boolean;
  violations: AssemblyViolation[];
  tokenTotal: number;
  budgetTokens: number;
  /** 0 when inside budget. */
  overBy: number;
}

export class AssemblyValidationError extends Error {
  constructor(
    message: string,
    readonly violations: AssemblyViolation[],
    readonly droppedLaneIds: string[],
  ) {
    super(message);
    this.name = 'AssemblyValidationError';
  }
}

export interface RepairResult {
  messages: ValidatedMessage[];
  /** Lanes dropped, in the order they were dropped — lowest priority first. */
  droppedLaneIds: string[];
  before: AssemblyValidation;
  after: AssemblyValidation;
}

// ── cost ────────────────────────────────────────────────────────────────────────────────

/**
 * The cost of the array, by the ONE estimator, through `lanes.ts`'s own per-message
 * function. Not a second cost model: if the allocator and the validator disagreed about
 * what a message costs, the validator would refuse arrays the allocator was right to build.
 */
export function assemblyTokens(messages: readonly ValidatedMessage[]): number {
  let total = 0;
  for (const m of messages) total += messageTokens(m);
  return total;
}

// ── the five clauses ────────────────────────────────────────────────────────────────────

const blocksOf = (m: ValidatedMessage): Array<Record<string, unknown>> | null =>
  Array.isArray(m.content) ? (m.content as unknown as Array<Record<string, unknown>>) : null;

/**
 * C9. Every clause, every time — the array is walked once and ALL violations are returned,
 * because the first one is rarely the interesting one.
 */
export function validateAssembly(
  messages: readonly ValidatedMessage[],
  opts: ValidateOptions,
): AssemblyValidation {
  const violations: AssemblyViolation[] = [];
  const budgetTokens = Math.max(0, Math.floor(opts.budgetTokens));
  const tokenTotal = assemblyTokens(messages);

  if (messages.length === 0) {
    violations.push({
      code: 'empty-assembly',
      detail:
        'the assembled array is empty; there is nothing for the model to answer, and an ' +
        'empty prompt is a failure to assemble rather than a valid small one',
    });
    return { ok: false, violations, tokenTotal, budgetTokens, overBy: 0 };
  }

  // ── 1. token total <= budget ──
  if (tokenTotal > budgetTokens) {
    violations.push({
      code: 'budget-exceeded',
      detail:
        `the assembled array costs ${tokenTotal} tokens against a budget of ${budgetTokens} ` +
        `(over by ${tokenTotal - budgetTokens}); something after the allocator grew it, or ` +
        `the allocator's own budget is wrong`,
    });
  }

  // ── 2. first message is user-role and does not lead with a tool_result ──
  const first = messages[0];
  if (first.role !== 'user') {
    violations.push({
      code: 'first-message-not-user',
      index: 0,
      detail:
        `the array opens on a ${first.role} message; every provider this platform speaks to ` +
        `requires the first message to be the user's`,
    });
  } else {
    const b = blocksOf(first);
    if (b && b.length > 0 && b[0].type === 'tool_result') {
      violations.push({
        code: 'first-message-leads-with-tool-result',
        index: 0,
        detail:
          'the first user message leads with a tool_result, whose tool_use was trimmed away; ' +
          'Anthropic answers this with "unexpected tool_use_id found in tool_result blocks"',
      });
    }
  }

  // ── 3. last message is not the assistant ──
  const last = messages[messages.length - 1];
  if (last.role === 'assistant') {
    violations.push({
      code: 'last-message-is-assistant',
      index: messages.length - 1,
      detail:
        'the array ends on an assistant message, so the model is being asked to continue its ' +
        'own last turn rather than to answer anything',
    });
  }

  // ── 4. tool_use / tool_result pairing, both directions ──
  const useIds = new Map<string, number>();
  const resultIds = new Map<string, number>();
  messages.forEach((m, i) => {
    const b = blocksOf(m);
    if (!b) return;
    for (const block of b) {
      if (block.type === 'tool_use' && typeof block.id === 'string') useIds.set(block.id, i);
      if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        resultIds.set(block.tool_use_id, i);
      }
    }
  });
  for (const [id, i] of useIds) {
    if (!resultIds.has(id)) {
      violations.push({
        code: 'tool-use-without-result',
        index: i,
        detail: `tool_use "${id}" at message ${i} has no matching tool_result anywhere in the array`,
      });
    }
  }
  for (const [id, i] of resultIds) {
    if (!useIds.has(id)) {
      violations.push({
        code: 'tool-result-without-use',
        index: i,
        detail: `tool_result for "${id}" at message ${i} refers to a tool_use that is not in the array`,
      });
    }
  }

  // ── 5. no empty blocks, no empty messages ──
  messages.forEach((m, i) => {
    const b = blocksOf(m);
    if (b === null) {
      if (typeof m.content === 'string' && m.content.trim() === '') {
        violations.push({
          code: 'empty-message',
          index: i,
          detail: `message ${i} (${m.role}) carries no text at all; providers reject an empty content string`,
        });
      }
      return;
    }
    if (b.length === 0) {
      violations.push({
        code: 'empty-message',
        index: i,
        detail: `message ${i} (${m.role}) carries an empty content array; providers reject it`,
      });
      return;
    }
    for (const block of b) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim() === '') {
        violations.push({
          code: 'empty-block',
          index: i,
          detail: `message ${i} (${m.role}) carries a text block with no text; providers reject it`,
        });
      }
    }
  });

  return {
    ok: violations.length === 0,
    violations,
    tokenTotal,
    budgetTokens,
    overBy: Math.max(0, tokenTotal - budgetTokens),
  };
}

// ── C10: repair, in priority order, or not at all ───────────────────────────────────────

/**
 * The head rule the assembler's own integrity pass applies, re-applied after a drop THIS
 * function made. Not a second mechanism: a repair that hands back an array starting on an
 * assistant turn has swapped one violation for another, and the caller would be right to
 * refuse it.
 */
function normaliseHead(messages: ValidatedMessage[]): void {
  while (messages.length > 0) {
    const first = messages[0];
    if (first.role === 'assistant') { messages.shift(); continue; }
    const b = blocksOf(first);
    if (b) {
      const kept = b.filter((x) => x.type !== 'tool_result');
      if (kept.length === 0) { messages.shift(); continue; }
      if (kept.length < b.length) {
        messages[0] = { ...first, content: kept as unknown as Anthropic.ContentBlockParam[] };
      }
    }
    break;
  }
}

/**
 * C10. Drop the LOWEST-PRIORITY lane, re-check, repeat. Never the oldest message, never a
 * message no lane claims (that is the loop's tail-append — the thing that just arrived, and
 * the first casualty of every oldest-first trimmer this replaces).
 *
 * Refuses, loudly, in three cases, and each refusal is the point rather than a gap:
 *   • no lane map at all — a repair that cannot see priority cannot repair IN priority
 *     order, and the only other order available is the one being deleted;
 *   • a lane id `LANE_PRIORITY` does not declare — an undeclared lane is a finding, and
 *     dropping content on a guess is how a directive gets eaten;
 *   • everything droppable is gone and it still does not fit (C11).
 */
export function repairAssembly(
  messages: readonly ValidatedMessage[],
  opts: ValidateOptions,
): RepairResult {
  const who = opts.agentId ? ` (agent ${opts.agentId})` : '';
  const before = validateAssembly(messages, opts);
  if (before.ok) {
    return { messages: [...messages], droppedLaneIds: [], before, after: before };
  }

  const sizeViolation = before.violations.some((v) => v.code === 'budget-exceeded');
  if (!sizeViolation) {
    // ── SHAPE-ONLY: reported, never thrown, and this boundary is exactly where that line
    // is drawn (PHASE-3 T4, decided ON MEASUREMENT rather than in the abstract) ──
    //
    // C11's "fail loud, never warn-and-send" names ONE mechanism: the Anthropic
    // front-trimmer that, when the array is STILL over the limit after trimming, logs a
    // warning and sends anyway. Its subject is SIZE. Killing a turn over a SHAPE defect
    // this validator did not create, and that the provider in front of it tolerates today,
    // would be a brand-new authority nobody asked for.
    //
    // The measurement that settled it, from the first live detect run (2026-07-31, 73 real
    // calls through the OR8 set): 17 divergences, **0 of them size**, and every one shape —
    // 14 `tool-result-without-use` each preceded WITHIN THE SAME SECOND by
    // `sanitizeOrphanToolBlocks`'s own "Stripped orphan tool_use blocks" line, plus 3 on
    // the PM. Had this thrown, the flip would have killed 23% of turns on day 7 over
    // defects that pre-date it. Both have named owners and are in the issues log; the flip's
    // precondition is that they read ZERO, not that this function shouts louder.
    return { messages: [...messages], droppedLaneIds: [], before, after: before };
  }

  const laneIds = opts.laneIds;
  if (!laneIds || laneIds.length !== messages.length) {
    throw new AssemblyValidationError(
      `assembly is over budget${who} and cannot be repaired: no per-message lane map was ` +
        `supplied, so there is no way to drop the lowest-PRIORITY lane. Refusing to fall ` +
        `back to oldest-first, which is the provider front-trimmer behaviour requirement ` +
        `C10 exists to delete. ` +
        `(${before.tokenTotal} tokens against ${before.budgetTokens})`,
      before.violations,
      [],
    );
  }

  const unknown = [...new Set(laneIds.filter((id): id is string => id !== null))]
    .filter((id) => LANE_PRIORITY[id] === undefined);
  if (unknown.length > 0) {
    throw new AssemblyValidationError(
      `assembly is over budget${who} and carries lane id(s) no lane table declares: ` +
        `${unknown.join(', ')}. An undeclared lane has no priority, and dropping content ` +
        `whose priority is unknown is a guess. Declare it in LANE_PRIORITY or fix the map.`,
      before.violations,
      [],
    );
  }

  // Droppable lanes, LOWEST PRIORITY FIRST (priority is a rank: bigger number survives less).
  const droppable = [...new Set(laneIds.filter((id): id is string => id !== null))]
    .sort((a, b) => LANE_PRIORITY[b] - LANE_PRIORITY[a] || a.localeCompare(b));

  let kept: ValidatedMessage[] = [...messages];
  let keptLanes: Array<string | null> = [...laneIds];
  const droppedLaneIds: string[] = [];

  for (const laneId of droppable) {
    const next: ValidatedMessage[] = [];
    const nextLanes: Array<string | null> = [];
    kept.forEach((m, i) => {
      if (keptLanes[i] === laneId) return;
      next.push(m);
      nextLanes.push(keptLanes[i]);
    });
    kept = next;
    keptLanes = nextLanes;
    droppedLaneIds.push(laneId);

    // Re-normalise the head, keeping the lane map aligned as messages leave the front.
    const beforeLen = kept.length;
    normaliseHead(kept);
    if (kept.length < beforeLen) keptLanes = keptLanes.slice(beforeLen - kept.length);

    const check = validateAssembly(kept, { ...opts, laneIds: keptLanes });
    if (check.ok) {
      return { messages: kept, droppedLaneIds, before, after: check };
    }
  }

  const after = validateAssembly(kept, { ...opts, laneIds: keptLanes });
  throw new AssemblyValidationError(
    `assembly is STILL over budget${who} after dropping every droppable lane ` +
      `(${droppedLaneIds.join(', ') || 'none'}): ${after.tokenTotal} tokens against ` +
      `${after.budgetTokens}. Failing loud rather than sending an assembly known to be ` +
      `wrong — the warn-and-send path is what requirement C11 deletes.`,
    after.violations,
    droppedLaneIds,
  );
}

// ── THE PROVIDER BOUNDARY: one install, every transport ─────────────────────────────────
//
// PHASE-3 T4 Step 2. `callModel` calls this ONCE, immediately after the universal orphan
// sanitizer and above every transport branch (ollama / openai / agent-sdk / anthropic), so
// there is one validation site rather than one per provider — which is what made the two
// front-trimmers diverge in estimator, reserve and repair strategy in the first place.
//
// ── THE LOG IS THE INSTRUMENT, so it is built to be READ ────────────────────────────────
// Step 2b's flip decision is taken FROM this log, so "it looked fine" is not an answer it
// can accept. Two stable tokens, both greppable:
//
//   ASSEMBLY_VALIDATION_DIVERGENCE   one per divergent call, carrying the violation codes,
//                                    the numbers, AND the running checked/diverged counters,
//                                    so a single line yields a RATE, not just an incident.
//   ASSEMBLY_VALIDATION_HEARTBEAT    every 200 clean calls. Positive evidence that the
//                                    validator RAN — because "no divergence lines" is
//                                    otherwise ambiguous between "clean" and "never
//                                    installed", and inferring health from absence is the
//                                    reasoning roadmap #15 exists to forbid.
//
// To read the window:
//   grep -c ASSEMBLY_VALIDATION_DIVERGENCE  <log>     # incidents
//   grep    ASSEMBLY_VALIDATION_HEARTBEAT   <log> | tail -1   # denominator, per process
//   grep -o 'codes=[^ ]*' <log> | sort | uniq -c | sort -rn   # what actually diverged
//
// Counters are per PROCESS and reset on restart, deliberately: they describe this build's
// behaviour, and a counter persisted across a deploy would blur two different builds.

let checkedCalls = 0;
let divergentCalls = 0;
const HEARTBEAT_EVERY = 200;

/** Reset for tests. Never called in production. */
export function __resetAssemblyValidationCounters(): void {
  checkedCalls = 0;
  divergentCalls = 0;
}

export function assemblyValidationCounters(): { checked: number; diverged: number } {
  return { checked: checkedCalls, diverged: divergentCalls };
}

export interface BoundaryCheckInput {
  agentId: string;
  modelId: string;
  /** MUTATED IN PLACE in repair mode — see `validateAtProviderBoundary`. */
  messages: ValidatedMessage[];
  systemPrompt: string;
  contextWindow: number;
  maxOutputTokens?: number;
  /** Lane id per message when the caller can supply one. See `repairAssembly`. */
  laneIds?: ReadonlyArray<string | null>;
}

/**
 * The exit boundary. In `'detect'` mode it LOGS and leaves the array untouched — the
 * provider front-trimmers are still the ceiling backstop and T4's sequencing rider forbids
 * removing them while this only watches. In `'repair'` mode it repairs in priority order,
 * IN PLACE, and THROWS when it cannot; the trimmers are deleted in that same commit.
 *
 * IN PLACE is deliberate and it is the same contract `sanitizeOrphanToolBlocks` uses two
 * lines above the call site: every transport branch below reads the same `messages` array,
 * so a repair that returned a new array would need threading through four branches and
 * would be silently ignored by any branch a later task forgot. The returned validation is
 * the report, not the payload.
 */
export async function validateAtProviderBoundary(
  input: BoundaryCheckInput,
): Promise<AssemblyValidation> {
  const { measureAgentToolPayloadTokens } = await import('../tools/tool-docs.js');
  const policy = contextWindowPolicy(input.contextWindow, {
    toolPayloadTokens: await measureAgentToolPayloadTokens(input.agentId),
    maxOutputTokens: input.maxOutputTokens,
  });
  // The comparable budget is the assembler's OWN remaining budget: what it was allowed to
  // spend, minus the system prompt it had to spend it against. A divergence therefore means
  // "the array grew after the allocator decided", which is the question worth asking.
  const budgetTokens = Math.max(0, policy.assemblyBudgetTokens - estimateTokens(input.systemPrompt));

  const opts: ValidateOptions = { budgetTokens, laneIds: input.laneIds, agentId: input.agentId };
  const result = validateAssembly(input.messages, opts);
  checkedCalls++;

  if (result.ok) {
    if (checkedCalls % HEARTBEAT_EVERY === 0) {
      logger.info(
        `ASSEMBLY_VALIDATION_HEARTBEAT mode=${ASSEMBLY_VALIDATION_MODE} ` +
        `checked=${checkedCalls} diverged=${divergentCalls}`,
        { checked: checkedCalls, diverged: divergentCalls, mode: ASSEMBLY_VALIDATION_MODE },
      );
    }
    return result;
  }

  divergentCalls++;
  const codes = [...new Set(result.violations.map((v) => v.code))].sort().join(',');
  logger.warn(
    `ASSEMBLY_VALIDATION_DIVERGENCE mode=${ASSEMBLY_VALIDATION_MODE} codes=${codes} ` +
    `overBy=${result.overBy} tokens=${result.tokenTotal} budget=${result.budgetTokens} ` +
    `messages=${input.messages.length} checked=${checkedCalls} diverged=${divergentCalls}`,
    {
      agentId: input.agentId,
      modelId: input.modelId,
      mode: ASSEMBLY_VALIDATION_MODE,
      codes,
      violations: result.violations.map((v) => `${v.code}: ${v.detail}`),
      tokenTotal: result.tokenTotal,
      budgetTokens: result.budgetTokens,
      overBy: result.overBy,
      messageCount: input.messages.length,
      checked: checkedCalls,
      diverged: divergentCalls,
    },
    input.agentId,
  );

  // DETECT ONLY, for the dated window in T4 Step 2's AS-BUILT note: send anyway. The
  // deliberate no-op is the whole point of the window — it measures what repair mode WOULD
  // have done before repair mode is allowed to do it.
  if (ASSEMBLY_VALIDATION_MODE === 'detect') return result;

  // Repair mode: fix the array the transports are about to read, or throw (C11). The throw
  // must reach the caller — a boundary that swallows its own loud failure is warn-and-send
  // with extra steps.
  const repaired = repairAssembly(input.messages, opts);
  input.messages.splice(0, input.messages.length, ...repaired.messages);
  logger.warn(
    `ASSEMBLY_VALIDATION_REPAIRED mode=${ASSEMBLY_VALIDATION_MODE} ` +
    `dropped=${repaired.droppedLaneIds.join('|') || 'none'} ` +
    `tokens=${repaired.before.tokenTotal}->${repaired.after.tokenTotal} ` +
    `budget=${repaired.after.budgetTokens}`,
    { agentId: input.agentId, droppedLaneIds: repaired.droppedLaneIds },
    input.agentId,
  );
  return repaired.after;
}
