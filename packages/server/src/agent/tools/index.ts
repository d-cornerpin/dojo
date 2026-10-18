// ════════════════════════════════════════════════════════════════════════════
// THE EXECUTOR (PHASE-5 T4 — relocated from `agent/tools.ts`, which is DELETED)
//
// `executeTool` is the single door every tool call goes through: the loop's
// parallel and serial batches, the loop's auto-delivery sends, and
// a2a-transport's parked-call resumes. It is research 05 §(a)'s
// `agent/tools/index.ts` — "alias resolve, deny/PM gate, registry lookup,
// result cap — NO switch" — and as of this commit there is no switch.
//
// ── THE ORDER IS THE CONTRACT, AND IT IS THE THING TO CHECK FIRST ──
// Every gate below runs in a deliberate sequence and each position was earned
// by an incident or a ruling. Reading top to bottom:
//
//   1. FU-4 `tools_policy.deny` — FIRST, and specifically AHEAD of any
//      outbound-capture instrumentation, so a denied comms send is never even
//      recorded as captured.
//   2. The `pmMayCall` overseer wall (RULING P5-R1) — the PM validates and
//      retasks; it never executes.
//   3. Malformed-argument JSON (`__malformed_args`) → PARSE_ERROR.
//   4. THE GATE LOOP (PHASE-5 T2) — fifteen hand-written permission branches
//      became declared gates in `tools/gates.ts` evaluated here, refusing
//      exactly what they refused, per row, with the same words and codes.
//   5. THE ONE SCHEMA-VALIDATION BOUNDARY (PHASE-5 T3 Step 3, RULING P5-R8) —
//      AFTER the refusals, so a call the platform was never going to run
//      answers "permission denied" rather than being graded on its arguments;
//      BEFORE dispatch, so no handler sees a shape it would crash on.
//   6. The three membership interceptors (PDF / Slides / Forms).
//   7. Dispatch: the handler table, else the membership fallback.
//   8. The tail: the result cap, the unknown-args warning, the audit row.
//
// ── THE THREE INTERCEPTORS ARE EXECUTOR BODY, NOT HANDLERS (RULING P5-R10) ──
// PDF, Slides and Forms each return a `ToolResult` DIRECTLY and therefore
// deliberately bypass the tail — the result cap in particular. The handler
// contract cannot express that and must not: a handler that could return early
// could skip a context-budget guarantee the loop depends on. So they moved here
// VERBATIM with the executor and they are absent from the handler table by
// construction. No worker re-opens this.
//
// ── THE MEMBERSHIP FALLBACK IS THE OLD `default:`, AND THE SHAPE CHANGED ONCE ──
// The switch's `default:` arm is now the `else` of `handlerFor(dispatchKey)`,
// which is what "no case matched" already meant. Its one `break` was a guard
// early-exit — `if (writeTool) { if (!primary) { …; break; } }` with nothing
// after the inner `if` — so it is exactly `else if (writeTool && !primary)`,
// and the second `break` sat at the end of the block doing nothing. The
// primary-only Workspace-write wall and the Google-read banner asymmetry are
// byte-identical to what stood in the switch.
//
// ── WHAT DELIBERATELY DID NOT COME HERE ──
// The 268 handler bodies (`tools/cat/*`, `tools/provider/*`), the wire array
// (`tools/definitions.ts`), the advertised surface (`tools/surface.ts`), the
// gates (`tools/gates.ts` + `tools/gate-eval.ts`), the validator
// (`tools/validate-args.ts`), the audit writer and the canvas cluster
// (`tools/util.ts`). This file dispatches; it does not implement.
// ════════════════════════════════════════════════════════════════════════════


import { runWithToolCallId } from '../turn-state.js';
import { turnContext } from '../turn-context.js';
import { classifyToolResult, toolErrorCodeForThrow, type ToolOutcome } from '../tool-outcome.js';
export { toolResultOf, toolWasBlocked, type ToolOutcome } from '../tool-outcome.js';

import { getDb } from '../../db/connection.js';
import { createLogger } from '../../logger.js';
import { resolveToolAlias } from '../../tools/aliases.js';
import { workOperation } from '../../tools/work-verbs.js';
import {
  withOutboundAsync, withOutboundAsyncIfAbsent, outboundChannelForTool, outboundRecipientForTool,
  currentOutboundDeliveryId,
} from '../v2/outbound.js';
import { TOLD_ABOUT_TASK_ARG, agentMayNameTask } from './told-about-task.js';
import { recordPersonTold } from '../../work/validation-drive.js';
import { resolveTaskId } from '../../tracker/schema.js';
import { resolveAgentRef, resolveGroupRef } from '../tool-helpers.js';
// PHASE-0 T10: sensitive-path list, ~-expansion and the share/read gate.
import { sharePathGuard, pdfInputPaths } from '../path-guards.js';
import { gatesForCall, ungatedEffectKinds } from './gates.js';
import { validateToolArgs } from './validate-args.js';
import { toolDefinitions, toolDefinitionsByName, isBoundaryValidated, getAllToolDefinitions } from './definitions.js';
import { getFilteredTools, getAgentDenySet } from './surface.js';
import { describeNameFailure } from '../../tools/name-help.js';
import { handlerFor } from './handlers.js';
// The registration LOOP over `toolDefinitions` travelled to the definitions
// leaf with the array it projects; this file keeps only the cap's READER,
// which `resultViewChars` below is the sole caller of.
import { getRegisteredMaxResultTokens } from '../v2/classifiers/concurrency.js';
import { TOOL_RESULT_VIEW_CHARS, toolResultView } from '../../memory/tool-result-view.js';
import { CHARS_PER_TOKEN } from '../../memory/budget.js';
import { prependMailboxOwnerHeader } from './provider/mailbox-banner.js';
import { auditLog, agentCanSelfCompleteById, permissionDeniedMessage, openFileInCanvas } from './util.js';
import { evaluateGate } from './gate-eval.js';
import { openCallCapability } from '../effects/scopes.js';
import { mayWriteWorkspace } from '../access/workspace.js';
import { isPrimaryAgent, isPMAgent } from '../../config/platform.js';
// Single source of truth for the PM overseer allow-list; re-checked at the
// executor chokepoint (demolition Phase 1.7 PM verb enforcement).
// `PM_ONLY_WORK_OPS` left with the ladder: the gate that reads it now lives in
// `tools/gates.ts` (row 8). The `pmMayCall` WALL stays here, above the gate loop
// and outside the deleted range — RULING P5-R1.
import { pmMayCall } from '../../tracker/pm-agent.js';
import { googleReadToolDefinitions, executeGoogleReadTool } from '../../google/tools-read.js';
import { googleWriteToolDefinitions, executeGoogleWriteTool } from '../../google/tools-write.js';
import { slidesToolNames, executeGoogleSlidesTool } from '../../google/tools-slides.js';
import { pdfToolNames, executePdfTool } from '../pdf-tools.js';
import { formsToolNames, executeGoogleFormsTool } from '../../google/tools-forms.js';
import { getAgentGoogleAccessLevel } from '../../google/auth.js';
import { microsoftReadToolDefinitions, executeMicrosoftReadTool } from '../../microsoft/tools-read.js';
import { microsoftWriteToolDefinitions, executeMicrosoftWriteTool } from '../../microsoft/tools-write.js';
import type { ToolCall, ToolResult, ToolErrorCode } from '@dojo/shared';

const logger = createLogger('tools');

// Membership sets for dispatch routing. The Google/Microsoft definition arrays
// already include the user_* slot variants (the generators push them at module
// load), so these sets cover base + user_ tools uniformly. executeTool routes
// by membership (in the default case) rather than a hand-maintained switch list,
// which silently dropped newer base tools and most user_* variants into
// "Unknown tool" even when the account was connected.
const GOOGLE_WRITE_TOOL_NAMES = new Set(googleWriteToolDefinitions.map(t => t.name));
const GOOGLE_READ_TOOL_NAMES = new Set(googleReadToolDefinitions.map(t => t.name));
const MS_WRITE_TOOL_NAMES = new Set(microsoftWriteToolDefinitions.map(t => t.name));
const MS_READ_TOOL_NAMES = new Set(microsoftReadToolDefinitions.map(t => t.name));


/**
 * THE UNKNOWN-ARGUMENT CENSUS, over the RUNTIME definition surface (PHASE-6 T0C).
 *
 * This is the one runtime mechanism that tells a model "that parameter is not in
 * the schema", and until T0C it was built from `toolDefinitions` — the 112-entry
 * CORE array — not from `toolDefinitionsByName()`, which is the 438 the platform
 * can actually expose. It was therefore blind to 326 of 438 definitions: every
 * Google, Microsoft, Slides, Forms, PDF, Plaud and credentials tool, plus all 117
 * `user_` twins, could be called with a misspelt parameter and the engine said
 * nothing. `getAllToolDefinitions()` is the surface the model is shown, so it is
 * the surface the warning must be measured against — the twins and the injected
 * `account` property do not exist in the core array at all.
 *
 * Extracted rather than inlined so the census clause can drive it: a source-text
 * assertion that "the fix is still there" is not the same thing as calling it for
 * a tool outside the core 112 and reading the answer.
 *
 * Returns `declared: null` when the name is not a live definition (an alias the
 * caller has not resolved, a tombstone, a retired name) — the caller warns about
 * nothing in that case, exactly as before. `__`-prefixed keys are the engine's own
 * markers (`__malformed_args`) and are never the model's arguments.
 */
export function unknownArgsAgainstSchema(
  name: string,
  args: Record<string, unknown> | undefined,
): { declared: ReadonlySet<string> | null; extras: string[] } {
  const def = toolDefinitionsByName().get(name);
  if (!def || !def.input_schema || typeof def.input_schema !== 'object') {
    return { declared: null, extras: [] };
  }
  const schema = def.input_schema as { properties?: Record<string, unknown> };
  const declared = new Set(Object.keys(schema.properties ?? {}));
  const extras = Object.keys(args ?? {}).filter(
    (k) => !k.startsWith('__') && !declared.has(k),
  );
  return { declared, extras };
}

// ── Tool Execution ──

// P6a: one tool call = one execution context. Everything below records against
// `toolCall.id` through getCurrentToolCallId, so the identity is attached here,
// at the single door every dispatch path goes through (the loop's parallel and
// serial batches, the loop's auto-delivery sends, and a2a-transport's parked-call
// resumes), rather than in a shared slot the concurrent batch overwrites. See the
// AsyncLocalStorage note in turn-state.ts.
export async function executeTool(agentId: string, toolCall: ToolCall): Promise<ToolOutcome> {
  // PHASE-4 T1 cluster 3: the door classifies. Everything below still speaks
  // `ToolResult`; the five-way is applied HERE, once, from `isError` + `errorCode` and
  // never from the prose — so a caller can tell "the platform refused" from "the tool
  // broke" without reading English, and cannot discard the answer (must-consume).
  return classifyToolResult(await runWithToolCallId(agentId, toolCall.id, () => executeToolInCallContext(agentId, toolCall)));
}

async function executeToolInCallContext(agentId: string, toolCall: ToolCall): Promise<ToolResult> {
  // C27 hook 2: resolve tool aliases FIRST, so the sim intercept, unknown-arg
  // detection, and every dispatcher case operate on the CANONICAL name. This is
  // the safety net covering every dispatch path (synthetic calls, A2A relay,
  // auto-route) even when the loop-ingestion hook (hook 1) did not run. A
  // tombstoned (removed) tool returns its pointer error immediately; a rename
  // prepends a one-line note so the model learns the new name.
  const resolved = resolveToolAlias(toolCall.name, (toolCall.arguments ?? {}) as Record<string, unknown>);
  if (resolved.tombstone) {
    return { toolCallId: toolCall.id, name: toolCall.name, content: resolved.tombstone, isError: true };
  }
  // PHASE-2 T5: ONE SCOPE PER SEND TOOL CALL, opened at the single door every dispatch path
  // goes through — the same place and the same reasoning as the P6a tool-call identity above.
  // This is what closes the ten unrecorded send paths in one change instead of ten: the tool
  // declares WHO is sending and on which channel, the transport door underneath it records
  // what actually happened, and `writeToolReceipt` links its receipt to that row from inside
  // the same scope. Nothing here decides an outcome, so a tool that refuses before reaching a
  // transport writes no row at all.
  const sendChannel = outboundChannelForTool(resolved.name);
  if (sendChannel !== null) {
    const intent = {
      agentId, tool: resolved.name, channel: sendChannel,
      recipientId: outboundRecipientForTool(resolved.name, resolved.args as Record<string, unknown>),
      conversationId: turnContext(agentId)?.root?.conversationId ?? null,
    };
    // t146: a send whose ARGUMENTS name its task (`task_id`, ./told-about-task.ts) opens its OWN
    // scope, and the person is recorded as told about that task from the row THIS send wrote.
    // The record itself refuses anyone but the owner or the row's requester, and only a caller who
    // holds, was assigned or opened the row (or the primary) may name it. No argument, no
    // record: never inferred from the words or from what the turn was serving. Whether the send
    // reached the person is the ledger's answer (the record checks the delivery's outcome).
    const named = (resolved.args as Record<string, unknown>)[TOLD_ABOUT_TASK_ARG];
    if (typeof named !== 'string' || named.trim() === '') {
      return withOutboundAsyncIfAbsent(intent, () => dispatchResolved(agentId, toolCall, resolved));
    }
    return withOutboundAsync(intent, async () => {
      const r = await dispatchResolved(agentId, toolCall, resolved);
      const deliveryId = currentOutboundDeliveryId();
      const task = resolveTaskId(named);
      if (deliveryId && task.ok && agentMayNameTask(agentId, task.id)) {
        const told = recordPersonTold(task.id, { deliveryId, via: 'send_tool' });
        if (told.kind === 'refused') logger.info('a send named its task but is not recorded as a tell', { taskId: task.id, reason: told.reason }, agentId);
      }
      return r;
    });
  }
  return dispatchResolved(agentId, toolCall, resolved);
}

async function dispatchResolved(
  agentId: string,
  toolCall: ToolCall,
  resolved: { name: string; args: Record<string, unknown>; note?: string | null },
): Promise<ToolResult> {
  if (resolved.name === toolCall.name) {
    return executeToolInner(agentId, toolCall);
  }
  const result = await executeToolInner(agentId, { ...toolCall, name: resolved.name, arguments: resolved.args });
  if (resolved.note) result.content = `${resolved.note}\n${result.content}`;
  return result;
}

async function executeToolInner(agentId: string, toolCall: ToolCall): Promise<ToolResult> {
  const { id, name, arguments: args } = toolCall;

  logger.info('Executing tool', { tool: name, args }, agentId);

  // ── FU-4: executor-side tools_policy.deny enforcement ──
  // computeFilteredTools strips a denied tool from the advertised surface, but
  // that strip is only advisory (Architecture Rule 1: the engine enforces, the
  // model follows). The floor model parses tool calls from free text, so a
  // deny-listed agent (e.g. the technique trainer for the comms-to-people set)
  // can still emit a denied name and reach here. Re-check the SAME deny set (one
  // parser, parseToolsPolicy, backs both the strip and this gate) ahead of any
  // outbound-capture instrumentation, so a denied comms send is never even recorded as
  // captured. `name` is already alias-canonical (executeTool resolves it), and
  // parseToolsPolicy canonicalizes the deny entries, so both sides match.
  if (getAgentDenySet(agentId).has(name)) {
    auditLog(agentId, name, null, 'denied', `${name} is denied by this agent's tools_policy`);
    logger.warn('Blocked tools_policy-denied tool call', { tool: name }, agentId);
    return {
      toolCallId: id,
      name,
      content: `[BLOCKED by engine] ${name} is not available to this agent (denied by policy). The request was not performed. If this needs to happen, escalate to the primary agent with send_to_agent.`,
      isError: true, errorCode: 'PERMISSION_DENIED',
    };
  }

  // ── PM overseer verb enforcement (demolition Phase 1.7) ──
  // The PM is an OVERSEER, not a worker: it validates, overrides, retasks
  // (the SAME holder; it never moves a task) and inspects; it never executes or edits the work itself, and
  // never flips a worker's status directly. computeFilteredTools already strips
  // non-allow-list tools from the PM's advertised surface, but per Architecture
  // Rule 1 that strip is advice only: the floor model can emit a worker verb
  // (a work_update status flip, spawn_agent, an exec/send) from free text and reach
  // here. Re-check the SAME single-source allow-list (`pmMayCall`, owned by
  // tracker/pm-agent.ts, which matches the OPERATION not the verb name — see the
  // T8V note there) at the executor and refuse anything outside it,
  // naming the overseer verbs so the PM redirects instead of doing the work.
  if (isPMAgent(agentId) && !pmMayCall(name, args)) {
    auditLog(agentId, name, null, 'denied', `${name} is outside the PM overseer allow-list`);
    logger.warn('Blocked PM tool call outside overseer allow-list', { tool: name }, agentId);
    return {
      toolCallId: id,
      name,
      content: `[BLOCKED by engine] You are the project manager (overseer), so "${name}" is not available to you. You do NOT execute or edit work; you oversee it. Your overseer verbs are: work_validate (bless or reject a close-out with action="validate", send work back with action="retask", adjudicate with action="override" / "apply_user_verdict"), work_schedule (pause / resume), plus read-only inspection (work_update with action="get" or "list", file_read/file_list, history_search, vault_search) and messaging (send_to_agent, broadcast_to_group). If a worker needs to do "${name}", direct the assigned agent to do it via send_to_agent or work_validate(action="retask").`,
      isError: true,
    };
  }

  let content: string = '';
  let isError = false;
  // PHASE-4 T1 cluster 3: the door's own refusals say so STRUCTURALLY. The guard
  // branches below assign `content`/`isError` and `break` rather than returning, so
  // they need a place to record "the platform refused" that survives to the single
  // result below — otherwise the classifier reads them as `crashed`, which is a lie
  // about a guard that worked. Prose-matching `[BLOCKED]` is the banned alternative.
  let errorCode: ToolErrorCode | undefined;

  // ── v2.3.19 (Scenario 18 finding), unknown-arg detection ──
  // Pre-spec, an agent could call e.g. work_open(kind="task") with
  // schedule_cron="every fortnight" and the engine silently dropped the
  // unknown arg. Net result: the agent thought it scheduled a task and
  // it didn't, with no feedback. Now we detect args not in the tool's
  // declared schema and prepend a warning to the tool result so the
  // agent (and through it, the user) finds out.
  let unknownArgsWarning: string | null = null;
  try {
    const { declared, extras } = unknownArgsAgainstSchema(name, args);
    if (declared) {
      if (extras.length > 0) {
        // A tool the handler is ABOUT to refuse as not-available must not lead
        // with schema advice: the warning's "check the spelling with
        // load_tool_docs" reads to a floor model as "this tool exists for you,
        // fix the args and retry", which directly contradicts the refusal's
        // steering (observed: a persistent agent ping-ponged complete_task ->
        // schema warning -> load_tool_docs -> permission error). The FN-8
        // availability refusal carries its own redirect; let it speak alone.
        const refusalWillSpeak = name === 'complete_task' && !agentCanSelfCompleteById(agentId);
        if (!refusalWillSpeak) {
          const declaredList = [...declared].join(', ') || '(none)';
          unknownArgsWarning =
            `[Engine warning: "${name}" was called with arg(s) not in its schema, ${extras.map((e) => `"${e}"`).join(', ')}. These were silently ignored. Declared args: ${declaredList}. If you meant a different param, check the spelling with load_tool_docs(tools=["${name}"]).]`;
        }
        logger.warn('Unknown tool args ignored', {
          tool: name, extras, declared: [...declared],
        }, agentId);
      }
    }
  } catch { /* best effort */ }

  // ── Malformed tool call arguments ──
  // If the model produced invalid JSON for tool arguments, model.ts flags it
  // with __malformed_args. Return a clear error so the model can retry.
  if (args.__malformed_args) {
    const rawSnippet = String(args.__malformed_args).slice(0, 300);
    content = `Error: Your tool call arguments for "${name}" were malformed JSON and could not be parsed.\n\nThe raw text was:\n${rawSnippet}\n\nPlease retry this tool call with valid JSON arguments. Call load_tool_docs(tools=["${name}"]) to see the expected parameter schema.`;
    logger.warn('Rejecting tool call with malformed arguments', { tool: name, rawSnippet }, agentId);
    return { toolCallId: id, name, content, isError: true, errorCode: 'PARSE_ERROR' as const };
  }

  // ── THE GATE LOOP (PHASE-5 T2 Step 3) ─────────────────────────────────────
  // What stood here was a run of FIFTEEN `if (name === …)` branches of four
  // different kinds — six calling `checkPermission`, three testing the caller's
  // identity, two reading `created_by` out of the database, two reading the
  // manifest's `system_control` in place, and one (`web_browse`) holding TWO
  // gates that a single `authorize()` call cannot express. §T0-PINS P1 tabled
  // all fifteen with the requirement each one encoded; every requirement is now
  // a DECLARED gate in `agent/tools/gates.ts`, and this loop evaluates them.
  //
  // The point is not that it is shorter. It is that the requirement became a
  // value: `gatesForCall()` can be printed, diffed and tested, whereas fifteen
  // branches could only be read — and the survey found two the reading had
  // already lost (`web_browse`'s second gate, and `web_search`'s gate, which has
  // no argument to key on and is invisible to any scan of the args).
  //
  // RULING P5-R5 — ENFORCEMENT PARITY — is what this loop is measured against:
  // it refuses exactly what the fifteen branches refused, in the same order,
  // with the same words, the same `errorCode` per row, and the same audit rows.
  // A declared effect that no ladder row gated gets NO new refusal here; it is
  // RECORDED (`ungatedEffectKinds`) so the enumeration exists when the owner or
  // a later task decides one of them should gate.
  {
    const gates = gatesForCall(name, args);
    for (const gate of gates) {
      const outcome = await evaluateGate(gate, {
        agentId,
        name,
        args,
        // The two `created_by` rows resolve their target through the SAME
        // resolvers the handlers use; injected rather than imported so the gate
        // module does not have to reach back into this file.
        resolveRef: (entity, ref) => {
          const resolved = entity === 'agent'
            ? resolveAgentRef(ref, 'kill_agent')
            : resolveGroupRef(ref, 'delete_group');
          if (!resolved.ok) return null;
          const table = entity === 'agent' ? 'agents' : 'agent_groups';
          const row = getDb()
            .prepare(`SELECT created_by, name FROM ${table} WHERE id = ?`)
            .get(resolved.id) as { created_by: string | null; name: string | null } | undefined;
          if (!row) return null;
          return { id: resolved.id, createdBy: row.created_by, label: row.name ?? resolved.id };
        },
      });

      const { verdict } = outcome;
      if (verdict.allowed) continue;

      // ⚰ T2 Step 4's staged-enablement branch stood here and is DELETED
      // (PHASE-5 T7). It could record a refusal instead of applying it, for a
      // sub-agent, when the refusal was a hardening rule rather than a global
      // deny — a window RULING P5-R6 narrowed to empty after the live box showed
      // what the literal wording cost. What is left is one refusal path that
      // does not ask who the agent is: a computed refusal is an applied refusal,
      // for every agent, by construction. `tools/__tests__/ladder-rows.test.ts`
      // holds that structurally; `brokers/__tests__/staged-set.test.ts` holds
      // the other half — that nothing the brokers produce would have been staged
      // on the day it died, so this deletion changed no behaviour.
      auditLog(agentId, outcome.auditAs || name, outcome.resource, 'denied', verdict.reason);
      logger.warn('Blocked by a registry-declared gate', {
        tool: name, gateRow: outcome.gate.row, rule: verdict.rule, reason: verdict.reason,
      }, agentId);
      return {
        toolCallId: id,
        name,
        content: verdict.blockedMessage ?? permissionDeniedMessage(verdict.reason, agentId),
        isError: true,
        ...(outcome.errorCode ? { errorCode: outcome.errorCode as ToolErrorCode } : {}),
      };
    }

    // P5-R5's record-don't-refuse half, at debug so it costs nothing on the hot
    // path and is there the moment somebody asks "what does this tool do that
    // nothing checks?".
    const ungated = ungatedEffectKinds(name, gates);
    if (ungated.length > 0) {
      logger.debug('declared effects with no gate today (recorded, not refused)', {
        tool: name, effects: ungated,
      }, agentId);
    }

    // ── THE CAPABILITY (PHASE-5 T8 Step 2, RULING P5-R14) ───────────────────
    // Every gate answered and none refused, so what this call may proceed TO
    // becomes a value: its DECLARED effects, resolved against these arguments,
    // as the only resources the facade will perform work on. The half Phase 5
    // promised and did not build — it DECIDED and nothing CARRIED, so a handler
    // acting on a resource it never declared was seen by no check. It mints no
    // permission of its own; why, and the refusals: `agent/effects/scopes.ts`.
    openCallCapability(agentId, name, id, args);
  }

  // ── THE ONE SCHEMA-VALIDATION BOUNDARY (PHASE-5 T3 Step 3, RULING P5-R8) ──
  // What stood here was 57 per-tool `checkRequired([...])` arrays inside the
  // dispatch cases below and 8 `validateAgainstSchema(...)` calls inside the
  // provider dispatchers — two mechanisms, one job, each re-stating field names
  // and types the tool's own `input_schema` declares. They are now one compiled
  // validator driven by that schema plus the `fields` sibling that carries what
  // JSON schema cannot say (`allowEmpty`, `requiredNotEnforced`). The four
  // messages are byte-identical to the ones the model has always retried on.
  //
  // POSITION IS DELIBERATE, and it is the ordering the deleted sites had:
  // AFTER the deny set, the PM allow-list and the gate loop, so a call the
  // platform REFUSES still answers "permission denied" rather than grading the
  // arguments of something it was never going to run; and BEFORE dispatch, so a
  // handler never sees a shape it would have crashed on. Alias resolution and
  // the weak-model arg repair both run ahead of this (`resolveToolAlias` at the
  // door, `coerceNumberArg` inside the handlers on OPTIONAL fields) — repair
  // first, then validation, unchanged.
  //
  // SCOPE is RULING P5-R8's: the tools these two mechanisms already covered.
  // Tools that never had a required-field check gain NO refusal here.
  if (isBoundaryValidated(name)) {
    const argsError = validateToolArgs(toolDefinitionsByName().get(name), args);
    if (argsError) {
      logger.warn('Tool call rejected by the schema-validation boundary', { tool: name, error: argsError }, agentId);
      // INVALID_ARGS had no writer before this boundary: a malformed-shape call
      // classified `crashed`, which reads as "the platform broke" when in fact
      // the platform refused a call it understood perfectly well. It says
      // `refused` now, structurally and not from prose.
      return { toolCallId: id, name, content: argsError, isError: true, errorCode: 'INVALID_ARGS' };
    }
  }

  try {
    // ── PDF tools (creation + manipulation, no external auth) ──
    if (pdfToolNames.includes(name)) {
      // T10: pdf_read and friends read a caller-chosen path straight into the
      // model's context. Gate every INPUT path exactly as share_file does.
      for (const rawPdfPath of pdfInputPaths(args)) {
        const pdfGuard = await sharePathGuard(agentId, name, rawPdfPath);
        if (!pdfGuard.allowed) {
          auditLog(agentId, name, pdfGuard.absPath, 'denied', pdfGuard.reason);
          return { toolCallId: id, name, content: pdfGuard.blockedMessage ?? permissionDeniedMessage(pdfGuard.reason, agentId), isError: true, errorCode: 'PERMISSION_DENIED' };
        }
      }
      content = await executePdfTool(name, args, agentId);
      isError = content.startsWith('Error');
      // Auto-open the produced PDF in the canvas (it renders natively). Every
      // PDF tool that writes an output reports it as ".../<file>.pdf"; the
      // read-only tools (pdf_read / pdf_get_info) don't produce a new file, so
      // skip them to avoid re-opening an input the agent was only inspecting.
      const PDF_READ_ONLY = name === 'pdf_read' || name === 'pdf_get_info';
      if (!isError && !PDF_READ_ONLY) {
        const pdfPath = content.match(/(\/\S+\.pdf)\b/i)?.[1];
        if (pdfPath && openFileInCanvas(agentId, pdfPath).opened) {
          content += '\n\nThis PDF is now open in the canvas, the user can see it. No need to call canvas_render, show_to_user, or share_file to show it; just tell them it is on the canvas (share the download link only if they ask to save it).';
        }
      }
      return { toolCallId: id, name, content, isError };
    }

    // ── Google Slides tools (many, dispatched before switch to avoid enumerating every case) ──
    // Available to both primary AND read-level agents (Ronin/Apprentice). PM agents
    // (googleAccess === 'none') are blocked because the tool isn't in their registry
    // at all, so they'd fall through to the unknown-tool path.
    if (slidesToolNames.includes(name)) {
      const slidesAccess = getAgentGoogleAccessLevel(agentId, isPrimaryAgent(agentId), isPMAgent(agentId));
      if (slidesAccess === 'none') {
        content = 'Permission denied: this agent does not have Google Slides access.';
        isError = true;
        auditLog(agentId, name, null, 'denied', 'Google Slides tool blocked: no Google access');
      } else {
        const agentRow = getDb().prepare('SELECT name FROM agents WHERE id = ?').get(agentId) as { name: string } | undefined;
        content = await executeGoogleSlidesTool(name, args, agentId, agentRow?.name ?? agentId);
        isError = content.startsWith('Error');
      }
      return { toolCallId: id, name, content, isError };
    }

    // ── Google Forms tools (mirror of slides dispatch). Read tools are
    // available to read-level agents; write tools are primary-only (enforced
    // by the tool-filtering step above, write tools won't appear in a
    // read-level agent's registry, so they fall through to "unknown tool"). ──
    if (formsToolNames.includes(name)) {
      const formsAccess = getAgentGoogleAccessLevel(agentId, isPrimaryAgent(agentId), isPMAgent(agentId));
      if (formsAccess === 'none') {
        content = 'Permission denied: this agent does not have Google Forms access.';
        isError = true;
        auditLog(agentId, name, null, 'denied', 'Google Forms tool blocked: no Google access');
      } else {
        const agentRow = getDb().prepare('SELECT name FROM agents WHERE id = ?').get(agentId) as { name: string } | undefined;
        content = await executeGoogleFormsTool(name, args, agentId, agentRow?.name ?? agentId);
        isError = content.startsWith('Error');
      }
      return { toolCallId: id, name, content, isError };
    }

    // PHASE-2 T8V: dispatch on the OPERATION, not the raw tool name. For the six
    // work verbs `workOperation` turns (name, args) into `<verb>:<discriminator>`;
    // every other tool keys on its own name exactly as before. Case labels below
    // therefore read `work_update:status` rather than a retired verb name, so
    // nothing in this switch can be mistaken for a tool name and T10's grep-zero
    // over the retired verb list has nothing left to find here.
    const dispatchKey = workOperation(name, args) ?? name;

    // ── DISPATCH (PHASE-5 T4) ───────────────────────────────────────────────
    // Every one of the 268 dispatch keys answers from `tools/cat/*` or
    // `tools/provider/*`. There is no switch left: the `else` below is the old
    // `default:` arm, which is what "no case matched" always meant.
    //
    // The handler answers with the same two values the case bodies assigned, so
    // everything below — the result admission (t200), the unknown-args
    // warning, the try/catch that turns a throw into `Tool execution failed: …`
    // — still applies to it identically. That is why a handler CANNOT return
    // early, and why the three interceptors above are not handlers.
    const relocated = handlerFor(dispatchKey);
    if (relocated) {
      const outcome = await relocated({ agentId, name, args, callId: id, toolCall });
      content = outcome.content;
      isError = outcome.isError;
      if (outcome.errorCode) errorCode = outcome.errorCode;
    } else if (
      // The switch's `default:` arm, and its guard early-exit written as the
      // condition it always was: `if (write) { if (!primary) { …break; } }` had
      // nothing after the inner `if`, so this is the same branch.
      // UX-ACCESS A1: the predicate is this agent's per-ACCOUNT Workspace grant
      // (and, for a send, its channel grant). Message and audit row unchanged.
      (GOOGLE_WRITE_TOOL_NAMES.has(name) || MS_WRITE_TOOL_NAMES.has(name))
      && !mayWriteWorkspace(agentId, name, GOOGLE_WRITE_TOOL_NAMES.has(name) ? 'google' : 'microsoft')
    ) {
      content = 'Permission denied: only the primary agent can use Workspace write tools.';
      isError = true;
      auditLog(agentId, name, null, 'denied', 'Workspace write tool restricted to primary agent');
    } else {
      // Membership-based routing for Google / Microsoft tools that the
      // explicit cases above don't list, newer base tools (drive_move,
      // gmail_create_label, docs_insert_text, sheets_format, calendar_freebusy,
      // …) and the user_* slot variants (user_calendar_create, user_docs_create,
      // …). Without this they fell through to "Unknown tool" even with the
      // account connected. The executors handle the user_ prefix + slot.
      const dispatchAgentName =
        (getDb().prepare('SELECT name FROM agents WHERE id = ?').get(agentId) as { name: string } | undefined)?.name ?? agentId;
      if (GOOGLE_WRITE_TOOL_NAMES.has(name)) {
        content = await executeGoogleWriteTool(name, args, agentId, dispatchAgentName);
        isError = content.startsWith('Error');
      } else if (GOOGLE_READ_TOOL_NAMES.has(name)) {
        content = prependMailboxOwnerHeader(await executeGoogleReadTool(name, args, agentId, dispatchAgentName), name, args);
        isError = content.startsWith('Error');
      } else if (MS_WRITE_TOOL_NAMES.has(name)) {
        content = await executeMicrosoftWriteTool(name, args, agentId, dispatchAgentName);
        isError = content.startsWith('Error');
      } else if (MS_READ_TOOL_NAMES.has(name)) {
        content = await executeMicrosoftReadTool(name, args, agentId, dispatchAgentName);
        isError = content.startsWith('Error');
      } else {
        // T80a: a model that never called load_tool_docs and instead emitted
        // a bad name straight from free text (Architecture Rule 1: the
        // engine enforces, the model follows) reaches here directly. Same
        // classified truth as the load_tool_docs path — GENERIC, not keyed
        // on this agent's name landing here: it is `unknown` unless the
        // name really does exist elsewhere in the platform's tool universe,
        // in which case it is honestly `exists_not_allowed`.
        const allowedToolNames = new Set(getFilteredTools(agentId).map(t => t.name));
        const knownToolNames = new Set(getAllToolDefinitions().map(t => t.name));
        content = describeNameFailure([name], allowedToolNames, knownToolNames);
        isError = true;
        auditLog(agentId, 'tool_call', name, 'error', 'Unknown tool');
      }
    }
  } catch (err) {
    content = `Tool execution failed: ${err instanceof Error ? err.message : String(err)}`;
    isError = true;
    // PHASE-4 T5: when the throw came from a provider call it carries a status, a structured
    // error type or a transport code, and the door can say WHY structurally instead of
    // handing the classifier a bare `crashed`. A verdict reached from the error's WORDS
    // populates nothing — see `toolErrorCodeForThrow`.
    errorCode = errorCode ?? toolErrorCodeForThrow(err);
    auditLog(agentId, 'tool_call', name, 'error', content);
  }

  // t200 (D12): admission. A result longer than its view is kept WHOLE (`keptWhole`, written by
  // the loop's recorder) and the agent sees its pointer; nothing is cut away and running the tool
  // again is never the advice. It replaced the Phase-3 cap here, which threw the rest away.
  const admitted = admitToolResult(name, id, content, isError);
  content = admitted.content;
  const keptWhole = admitted.keptWhole;

  // v2.3.19, prepend the unknown-args warning if one was raised at
  // the top of executeTool. Goes AFTER the admission so a pointer never
  // hides it. Applied to both success and error results so the
  // agent always sees it.
  if (unknownArgsWarning) {
    content = `${unknownArgsWarning}\n\n${content}`;
  }

  return {
    toolCallId: id,
    name,
    content,
    isError,
    ...(isError && errorCode ? { errorCode } : {}),
    ...(keptWhole !== undefined ? { keptWhole } : {}),
  };
}

/** The executor's admission (t200): the result as the agent sees it, plus the whole when that
 *  view is the result's pointer. The recorder keeps the whole with the row (`memory/kept-results.ts`). */
export function admitToolResult(toolName: string, callId: string, content: string, isError = false): { content: string; keptWhole?: string } {
  const size = resultViewChars(toolName, content, isError);
  return callId && content.length > size ? { content: toolResultView(content, callId, size), keptWhole: content } : { content };
}

/**
 * How many characters of this result the agent is shown whole (t200). Every tool's view is
 * `TOOL_RESULT_VIEW_CHARS`; a tool that declares `maxResultTokens` is shown whole only up to that
 * size, or up to twice it when the result is one of its OWN pages (it ends with the tool's paging
 * trailer: a page that slightly overshoots keeps its "continue" line in sight). Never past the view.
 * An error is held to the view alone, as it always was. Beyond this size the result is its pointer.
 */
export function resultViewChars(toolName: string, content: string, isError = false): number {
  const declared = getRegisteredMaxResultTokens(toolName) ?? toolDefinitions.find((t) => t.name === toolName)?.maxResultTokens;
  if (!declared || isError) return TOOL_RESULT_VIEW_CHARS;
  const OWN_PAGE_TRAILERS = [
    /\[Read lines \d+-\d+ of \d+ total\./,
    /\[End of file\. Read lines \d+-\d+ of \d+ total\.\]$/,
    /\[Read chars \d+-\d+ of \d+ total\./,
    /\[End of content\. Read chars \d+-\d+ of \d+ total\.\]$/,
    /\[End of content\. Total: \d+ chars\. Requested offset/,
  ];
  const tail = content.slice(-400);
  const ownPage = OWN_PAGE_TRAILERS.some((re) => re.test(tail));
  return Math.min(declared * CHARS_PER_TOKEN * (ownPage ? 2 : 1), TOOL_RESULT_VIEW_CHARS);
}
