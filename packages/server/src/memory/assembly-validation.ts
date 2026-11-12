// Exit validation: one validator between assembly and the provider, for every transport.
// `validateAssembly` runs after every mutation and takes no agent-type input, so no agent can be exempted.
// `repairAssembly` fixes size violations in lane-priority order (lowest lane first), never oldest-first, and
// refuses when it cannot identify lanes. Unrepairable is a throw (`AssemblyValidationError`), never warn-and-send.
// Shape is not repaired here: orphan tool blocks are `sanitizeOrphanToolBlocks`'s job, which runs just before.
// Surviving shape violations are reported; the one shape fix made here is re-normalising the head after a drop.
// The `'detect'` mode (log only, array untouched) is kept as the one-constant revert path.
import type Anthropic from '@anthropic-ai/sdk';
import { createLogger } from '../logger.js';
import { messageTokens, LANE_PRIORITY, isProtectedLaneId } from './lanes.js';
import { contextWindowPolicy, estimateTokens } from './budget.js';
import { appendDivergenceRecord } from './assembly-validation-sink.js';

const logger = createLogger('assembly-validation');

export type ValidatedMessage = {
  role: 'user' | 'assistant';
  content: string | Anthropic.ContentBlockParam[];
  reasoningContent?: string;
};

export type AssemblyValidationMode = 'detect' | 'repair';

/** `'repair'` repairs and throws when it cannot; `'detect'` only logs and leaves the array untouched. */
export const ASSEMBLY_VALIDATION_MODE: AssemblyValidationMode = 'repair';

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
  /** Plain words, never empty. */
  detail: string;
  /** Index in the validated array, where the violation belongs to one message. */
  index?: number;
}

export interface ValidateOptions {
  /** What this array was allowed to cost, in tokens of the one estimator: at the provider boundary, the
   *  assembler's remaining budget, so a divergence means something grew the array after the allocator. */
  budgetTokens: number;
  /** Lane id per message, aligned to `messages` (null for a message no lane owns). Only `repairAssembly` uses it;
   *  absent means the repair has no priority map and must refuse. */
  laneIds?: ReadonlyArray<string | null>;
  /** For the log line and the error text. NEVER consulted to decide anything (C9). */
  agentId?: string;
}

export interface AssemblyValidation {
  ok: boolean;
  violations: AssemblyViolation[];
  tokenTotal: number;
  budgetTokens: number;
  overBy: number;
}

/** Why a repair refused: the array cannot be repaired, or it fits only without the live conversation. */
export type AssemblyRefusalCode = 'UNREPAIRABLE' | 'LIVE_CONVERSATION_PROTECTED';

export class AssemblyValidationError extends Error {
  constructor(
    message: string,
    readonly violations: AssemblyViolation[],
    readonly droppedLaneIds: string[],
    readonly code: AssemblyRefusalCode = 'UNREPAIRABLE',
  ) {
    super(message);
    this.name = 'AssemblyValidationError';
  }
  /** Set on a size refusal by `refuseAndCondense`: what was dialed, and the condense it started. */
  refusedDial?: { modelId: string; systemPromptTokens: number; tokenTotal: number; budgetTokens: number; condensed: Promise<unknown> | null };
}

/**
 * The live conversation is not repair material: dropping it would send the model a call without what it is
 * working on. The repair drops every other droppable lane in priority order; when the array fits only without
 * this lane it refuses with `LIVE_CONVERSATION_PROTECTED` and the boundary starts condensing. `fitLanes` still
 * ranks the lane; only the repair may not take it. */
export const LIVE_CONVERSATION_LANE = 'lane.fresh-tail';

export interface RepairResult {
  messages: ValidatedMessage[];
  /** Lanes dropped, in the order they were dropped (lowest priority first). */
  droppedLaneIds: string[];
  before: AssemblyValidation;
  after: AssemblyValidation;
}

/** The cost of the array, by the one estimator through `lanes.ts`'s per-message function. A second cost model
 *  would make the validator refuse arrays the allocator was right to build. */
export function assemblyTokens(messages: readonly ValidatedMessage[]): number {
  let total = 0;
  for (const m of messages) total += messageTokens(m);
  return total;
}

const blocksOf = (m: ValidatedMessage): Array<Record<string, unknown>> | null =>
  Array.isArray(m.content) ? (m.content as unknown as Array<Record<string, unknown>>) : null;

/** Every clause, every time: all violations are returned, because the first is rarely the interesting one. */
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

/** The head rule the assembler's integrity pass applies, re-applied after a drop THIS function made: a repair
 *  must not hand back an array starting on an assistant turn. */
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
 * Drop the lowest-priority lane, re-check, repeat. Never the oldest message, never a message no lane claims (the
 * loop's tail-append). Refuses loudly when there is no lane map (the only other order is oldest-first), when a
 * lane id is declared in no lane table (dropping on a guess eats directives), or when everything droppable is
 * gone and it still does not fit. */
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
    // A shape violation reaching here survived `sanitizeOrphanToolBlocks` and `applyIntegrityPass`, and this module
    // does not repair shape (a second repairer would duplicate them). Throwing names the defect locally; the
    // provider answers these shapes with a 400 anyway. In `'detect'` mode this is never reached.
    throw new AssemblyValidationError(
      `assembly has a SHAPE violation this validator cannot repair${who}: ` +
        `${before.violations.map((v) => `${v.code}: ${v.detail}`).join(' | ')}. ` +
        `Shape is repaired upstream (sanitizeOrphanToolBlocks, applyIntegrityPass); a ` +
        `violation surviving to the provider boundary is an unknown defect, and the ` +
        `provider answers it with a 400 anyway. Failing loud here names it (C11).`,
      before.violations,
      [],
    );
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

  // Lane ids come from two tables: `LANE_PRIORITY` (the allocator's droppable ladder) and the post-budget lanes
  // (`isProtectedLaneId`), content added after the budget decision. An id in neither is a finding and refuses.
  const unknown = [...new Set(laneIds.filter((id): id is string => id !== null))]
    .filter((id) => LANE_PRIORITY[id] === undefined && !isProtectedLaneId(id));
  if (unknown.length > 0) {
    throw new AssemblyValidationError(
      `assembly is over budget${who} and carries lane id(s) no lane table declares: ` +
        `${unknown.join(', ')}. An undeclared lane has no priority, and dropping content ` +
        `whose priority is unknown is a guess. Declare it in LANE_PRIORITY or fix the map.`,
      before.violations,
      [],
    );
  }

  // Droppable lanes, lowest priority first (a bigger number survives less). Protected ids are skipped, like
  // untagged messages (the loop's tail), and the live conversation lane is never dropped.
  const droppable = [...new Set(laneIds.filter((id): id is string => id !== null))]
    .filter((id) => LANE_PRIORITY[id] !== undefined && id !== LIVE_CONVERSATION_LANE)
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
  // `LIVE_CONVERSATION_PROTECTED` only when the array would fit without the tagged conversation (both condense).
  const tailTokens = kept.reduce((t, m, i) => t + (keptLanes[i] === LIVE_CONVERSATION_LANE ? messageTokens(m) : 0), 0);
  if (keptLanes.includes(LIVE_CONVERSATION_LANE) && after.tokenTotal - tailTokens <= after.budgetTokens) {
    throw new AssemblyValidationError(
      `assembly is over budget${who} and would fit only by dropping the live conversation ` +
        `(${LIVE_CONVERSATION_LANE}) after every other droppable lane ` +
        `(${droppedLaneIds.join(', ') || 'none'}) was already gone: ${after.tokenTotal} tokens ` +
        `against ${after.budgetTokens}. Refusing rather than sending the model a call without ` +
        `its conversation. Repairable: condense this agent's history against the dialed ` +
        `window, or size the array for the model being dialed before it reaches the boundary.`,
      after.violations,
      droppedLaneIds,
      'LIVE_CONVERSATION_PROTECTED',
    );
  }
  throw new AssemblyValidationError(
    `assembly is STILL over budget${who} after dropping every droppable lane ` +
      `(${droppedLaneIds.join(', ') || 'none'}): ${after.tokenTotal} tokens against ` +
      `${after.budgetTokens}. Failing loud rather than sending an assembly known to be ` +
      `wrong — the warn-and-send path is what requirement C11 deletes.`,
    after.violations,
    droppedLaneIds,
  );
}

// The provider boundary: `callModel` calls this once, after the universal orphan sanitizer and above every
// transport branch, so there is one validation site rather than one per provider.
// Greppable log tokens: ASSEMBLY_VALIDATION_DIVERGENCE (one per divergent call, with the running checked and
// diverged counters, so one line yields a rate) and ASSEMBLY_VALIDATION_HEARTBEAT (every 200 clean calls: proof
// the validator ran, since absence of divergence lines cannot tell clean from never installed). Each divergence
// is also appended to the durable sink (`assembly-validation-sink.ts`) because dojo.log rotates in minutes.
// Counters are per process and reset on restart; every sink record carries its `pid`: group by it, never sum.

let checkedCalls = 0;
let divergentCalls = 0;
const HEARTBEAT_EVERY = 200;

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
  /** Mutated in place in repair mode; see `validateAtProviderBoundary`. */
  messages: ValidatedMessage[];
  systemPrompt: string;
  contextWindow: number;
  maxOutputTokens?: number;
  /** A declared utility dial's own output cap; absent = charge `maxOutputTokens`. */
  dialOutputTokens?: number | null;
  /** Does this dial carry the agent's tools? Absent = yes. A `tools: false` dial sends none, so charging it
   *  the tool payload would measure a budget for a request nobody makes. */
  toolsSent?: boolean;
  laneIds?: ReadonlyArray<string | null>;
}

/**
 * The exit boundary. In `'detect'` mode it logs and leaves the array untouched. In `'repair'` mode it repairs in
 * priority order, IN PLACE, and throws when it cannot. In place because every transport branch reads the same
 * `messages` array (as with `sanitizeOrphanToolBlocks`), so a returned copy could be ignored by one branch; the
 * returned validation is the report, not the payload. */
export async function validateAtProviderBoundary(
  input: BoundaryCheckInput,
): Promise<AssemblyValidation> {
  const { measureAgentToolPayloadTokens } = await import('../tools/tool-docs.js');
  const policy = contextWindowPolicy(input.contextWindow, {
    toolPayloadTokens: input.toolsSent === false ? 0 : await measureAgentToolPayloadTokens(input.agentId),
    maxOutputTokens: input.dialOutputTokens ?? input.maxOutputTokens,
  });
  // The comparable budget is the assembler's own remaining budget (its allowance minus the system prompt), so a
  // divergence means the array grew after the allocator decided.
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
  const codeList = [...new Set(result.violations.map((v) => v.code))].sort();
  const codes = codeList.join(',');
  const violations = result.violations.map((v) => `${v.code}: ${v.detail}`);

  // Durable record first: the logger's copy can be rotated away in minutes, this cannot.
  appendDivergenceRecord({
    at: new Date().toISOString(), pid: process.pid, mode: ASSEMBLY_VALIDATION_MODE,
    agentId: input.agentId, modelId: input.modelId, codes: codeList, violations,
    tokenTotal: result.tokenTotal, budgetTokens: result.budgetTokens, overBy: result.overBy,
    messageCount: input.messages.length, checked: checkedCalls, diverged: divergentCalls,
  });

  logger.warn(
    `ASSEMBLY_VALIDATION_DIVERGENCE mode=${ASSEMBLY_VALIDATION_MODE} codes=${codes} ` +
    `overBy=${result.overBy} tokens=${result.tokenTotal} budget=${result.budgetTokens} ` +
    `messages=${input.messages.length} checked=${checkedCalls} diverged=${divergentCalls}`,
    {
      agentId: input.agentId,
      modelId: input.modelId,
      mode: ASSEMBLY_VALIDATION_MODE,
      codes,
      violations,
      tokenTotal: result.tokenTotal,
      budgetTokens: result.budgetTokens,
      overBy: result.overBy,
      messageCount: input.messages.length,
      checked: checkedCalls,
      diverged: divergentCalls,
    },
    input.agentId,
  );

  // Detect mode: send anyway. This branch is the one-constant revert path.
  if (ASSEMBLY_VALIDATION_MODE === 'detect') return result;

  // Repair mode: fix the array the transports are about to read, or throw. The throw must reach the caller:
  // a boundary that swallows its own loud failure is warn-and-send.
  let repaired: RepairResult;
  try {
    repaired = repairAssembly(input.messages, opts);
  } catch (err) {
    // Every size refusal condenses; a shape refusal does not.
    if (err instanceof AssemblyValidationError && err.violations.some((v) => v.code === 'budget-exceeded')) refuseAndCondense(input, err, result);
    throw err;
  }
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

/**
 * A size refusal as a repairable-defect report with the repair started: a durable sink record under its own
 * code, a named log line, and a forced background condense against the dialed window (it dials a model;
 * skip-if-busy). The caller re-throws; the condense rides the error so recovery re-assembles only after it.
 * Budget 0 is not condensed: no condense helps. */
function refuseAndCondense(
  input: BoundaryCheckInput, err: AssemblyValidationError, result: AssemblyValidation,
): void {
  appendDivergenceRecord({
    at: new Date().toISOString(), pid: process.pid, mode: ASSEMBLY_VALIDATION_MODE,
    agentId: input.agentId, modelId: input.modelId, codes: [err.code.toLowerCase().replace(/_/g, '-')],
    violations: [err.message], tokenTotal: result.tokenTotal, budgetTokens: result.budgetTokens,
    overBy: result.overBy, messageCount: input.messages.length,
    checked: checkedCalls, diverged: divergentCalls,
  });
  logger.error(
    `ASSEMBLY_VALIDATION_${err.code} tokens=${result.tokenTotal} ` +
    `budget=${result.budgetTokens} dropped=${err.droppedLaneIds.join('|') || 'none'}`,
    { agentId: input.agentId, modelId: input.modelId, contextWindow: input.contextWindow },
    input.agentId,
  );
  // Measured for the dialed model; written by the summary writer resolved from the agent's configured model,
  // never by a dialed routed pick.
  err.refusedDial = { modelId: input.modelId, systemPromptTokens: estimateTokens(input.systemPrompt), tokenTotal: result.tokenTotal, budgetTokens: result.budgetTokens, condensed: result.budgetTokens === 0 ? null : Promise.all([import('./compaction.js'), import('../db/connection.js'), import('./turn-patience.js')])
    .then(([{ checkAndCompact, forcedCompactionOptions }, { getDb }, { turnPatienceMs }]) => {
      const configured = (getDb().prepare('SELECT model_id FROM agents WHERE id = ?').get(input.agentId) as
        { model_id: string | null } | undefined)?.model_id ?? input.modelId;
      return checkAndCompact(input.agentId, configured, input.contextWindow,
        { ...forcedCompactionOptions(turnPatienceMs(input.agentId, input.modelId)), dialedModelId: input.modelId, untilItFits: true, inTurn: true });
    })
    .catch((condenseErr: unknown) => {
      logger.warn('the condense started by a size refusal failed', {
        agentId: input.agentId,
        error: condenseErr instanceof Error ? condenseErr.message : String(condenseErr),
      }, input.agentId);
    }) };
}
