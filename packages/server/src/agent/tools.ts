import { runWithToolCallId, currentTurnRoot } from './turn-state.js';
import { classifyToolResult, toolErrorCodeForThrow, type ToolOutcome } from './tool-outcome.js';
export { toolResultOf, toolWasBlocked, type ToolOutcome } from './tool-outcome.js';

// PHASE-5 T3: `promisify(exec)` is GONE from this file with the string-exec
// entry point it served, and so is every process spawn — both doors run through
// `agent/tools/process-run.ts`, which uses `execFile` (never a shell) and reaches
// /bin/zsh only with an explicit `-c`.
// (getRuntimeVersion import removed in Phase 9 Stage 2, single-track v2)
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { resolveToolAlias } from '../tools/aliases.js';
import { workOperation } from '../tools/work-verbs.js';
import {
  withOutboundAsyncIfAbsent, outboundChannelForTool, outboundRecipientForTool,
} from './v2/outbound.js';
import { resolveAgentRef, resolveGroupRef } from './tool-helpers.js';
// Phase 3.5 (2026-05-04), `shouldIntercept` / `interceptLargeFile` removed
// from the executeTool path. See agent/tools.ts:executeTool for the explanation.
// The functions still exist in `memory/large-files.ts` for backward compatibility
// with `large_files` table records created before Phase 3.5; new tool calls
// don't intercept.
// PHASE-0 T10: sensitive-path list, ~-expansion and the share/read gate.
import { sharePathGuard, pdfInputPaths } from './path-guards.js';
import { gatesForCall, ungatedEffectKinds } from './tools/gates.js';
import { validateToolArgs } from './tools/validate-args.js';
import { toolDefinitions, toolDefinitionsByName, isBoundaryValidated } from './tools/definitions.js';
import { getFilteredTools, getAgentDenySet } from './tools/surface.js';
// Re-exported so `agent/model.ts`, `prompt/assembler.ts`, `agent/v2/loop.ts` and
// `tools/tool-docs.ts` keep resolving until the executor's relocation follows every
// importer onto the leaf. A pointer, not a second surface.
export { getFilteredTools } from './tools/surface.js';
// Re-exported so `agent/model.ts` and `prompt/assembler.ts` keep resolving until the
// executor's own relocation moves every importer of this file onto its real home
// (`agent/tools/definitions.js` for the wire, `agent/tools/surface.js` for the surface).
// A pointer, not a second array: there is one `toolDefinitions` and it is the leaf's.
export { toolDefinitions } from './tools/definitions.js';
import { handlerFor } from './tools/handlers.js';
// The registration LOOP over `toolDefinitions` travelled to the definitions
// leaf with the array it projects; this file keeps only the cap's READER,
// which `applyMaxResultTokensCap` below is the sole caller of.
import { getRegisteredMaxResultTokens } from './v2/classifiers/concurrency.js';
import { prependUserMailboxBanner } from './tools/provider/mailbox-banner.js';
import { auditLog, agentCanSelfCompleteById, permissionDeniedMessage, openFileInCanvas } from './tools/util.js';
// PHASE-5 T4: `agentCanSelfComplete` / `agentCanSelfCompleteById` moved to
// `agent/tools/util.ts` so `permissionDeniedMessage` — which every relocated
// gated handler prints — could move with them. Re-exported here so this file's
// existing importers (`v2/loop.ts`) keep resolving until the executor's own
// relocation moves them onto `agent/tools/index.js`.
export { agentCanSelfComplete, agentCanSelfCompleteById } from './tools/util.js';
// PHASE-5 T4: `executeFilePatch` moved to `agent/tools/cat/fs.ts` with the nine
// file/exec handlers that were its only production callers. Re-exported here so
// `agent/__tests__/file-patch.test.ts` keeps resolving until the executor's own
// relocation moves this file's importers onto `agent/tools/index.js`.
export { executeFilePatch } from './tools/cat/fs.js';
import { evaluateGate, logOnly } from './tools/gate-eval.js';
import { isPrimaryAgent, isPMAgent } from '../config/platform.js';
// Single source of truth for the PM overseer allow-list; re-checked at the
// executor chokepoint (demolition Phase 1.7 PM verb enforcement).
// `PM_ONLY_WORK_OPS` left with the ladder: the gate that reads it now lives in
// `tools/gates.ts` (row 8). The `pmMayCall` WALL stays here, above the gate loop
// and outside the deleted range — RULING P5-R1.
import { pmMayCall } from '../tracker/pm-agent.js';
import { googleReadToolDefinitions, executeGoogleReadTool } from '../google/tools-read.js';
import { googleWriteToolDefinitions, executeGoogleWriteTool } from '../google/tools-write.js';
import { slidesToolNames, executeGoogleSlidesTool } from '../google/tools-slides.js';
import { pdfToolNames, executePdfTool } from './pdf-tools.js';
import { formsToolNames, executeGoogleFormsTool } from '../google/tools-forms.js';
import { getAgentGoogleAccessLevel } from '../google/auth.js';
import { microsoftReadToolDefinitions, executeMicrosoftReadTool } from '../microsoft/tools-read.js';
import { microsoftWriteToolDefinitions, executeMicrosoftWriteTool } from '../microsoft/tools-write.js';
import type { ToolCall, ToolResult, ToolErrorCode } from '@dojo/shared';

const logger = createLogger('tools');


// PHASE-5 T4: the per-turn recall budget (`RECALL_BUDGET_TOKENS` +
// `recallBudgetNotice`) moved WITH the four recall handlers it exists for, to
// `agent/tools/cat/recall.ts`. It had no other reader here.

// PHASE-5 T4: `getDownloadUrl`, `toDashboardPath` and `registerSharedFile`
// moved to `agent/tools/util.ts` — the comms handlers that mint a download URL
// left this file, and a category module may not import it back.

// PHASE-5 T4: the canvas-open cluster (`broadcastCanvasUpdate`, `canvasMime`,
// `queueCanvasDocAttachment`, `syncCanvasAfterWrite`, `openFileInCanvas`,
// `localOfficePathFromResult`) moved to `agent/tools/util.ts` — every category
// that writes a file asks it whether the user gets to see the result.

// ── Filtered tools per agent (based on permissions + tools policy) ──

// PHASE-5 T4: the WIRE ARRAY (`toolDefinitions`, ~2,474 lines),
// `getAllToolDefinitions()` (the ONE declared emission order) and the two
// definition-derived lookups the validation boundary uses
// (`toolDefinitionsByName`, `isBoundaryValidated`) moved to
// `agent/tools/definitions.ts`. The array IS the provider payload and both
// prompt goldens hash exactly its projection, so it relocated BYTE-IDENTICAL
// and the module it landed in says so at the top with the proof.

// PHASE-5 T4: the ADVERTISED SURFACE — `getFilteredTools`, `computeFilteredTools`,
// the per-agent memo and its fingerprint, `parseToolsPolicy` and the FU-4
// executor-side deny memo (`getAgentDenySet`) — moved to
// `agent/tools/surface.ts`. It had to move ahead of the last dispatch key:
// `load_tool_docs` reads `getFilteredTools`, and a category module may not
// import this file. The FU-4 GATE itself did not move — it is still the first
// branch of `executeToolInner`, ahead of the outbound-capture instrument.


// ── Tool definitions: the type is the LEAF now (PHASE-5 T1) ──
//
// `ToolDefinition` moved to `agent/tools/types.ts`, a module with zero imports,
// because fifteen modules type-imported it from HERE and this file statically
// imports eleven of them straight back (§T0-PINS P8). Those eleven cycles are
// why `applyTextPagination` had to be fetched through `await import()` at
// runtime from two of them. The re-export below keeps every consumer outside
// the toolbox working unchanged; new code should import from the leaf.
export type { ToolDefinition, ToolEffect, EffectKind, ToolFieldDeclaration } from './tools/types.js';
// The pagination leaf's two helpers keep their old public home so the six
// former `await import('../agent/tools.js')` call sites are the only movers.
export { applyTextPagination, coerceNumberArg } from './tools/pagination.js';

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



// ── Path Resolution ──
// resolvePath / SENSITIVE_BASENAMES / isSensitivePath moved to
// agent/path-guards.ts (PHASE-0 T10) so the case-fold and the share gate have
// one home. Imported at the top of this file; behaviour is unchanged here.


// The exec sensitive-file scan MOVED to `agent/brokers/proc.ts` at PHASE-5 T2.
// It answered "may this command run" from inside the string-exec handler, i.e. from the
// handler, while the ladder answered the same question at the door — two places,
// one question, which is the shape this phase exists to delete. The broker now
// asks it, with the refusal message carried verbatim on the verdict so nothing
// an agent reads changed.

// ── Tool Execution ──

// PHASE-5 T4: `auditLog` and its AUDIT_ACTION_MAP moved to
// `agent/tools/util.ts`. A relocated handler cannot import this file (that is
// the cycle the split is undoing), and two copies of an audit writer is exactly
// the disease — so there is ONE, imported by both surfaces.

// ════════════════════════════════════════════════════════════════════════════
// THE TWO EXEC DOORS (PHASE-5 T3 Step 1).
//
// WHAT STOOD HERE. One function — the string-exec entry point — which took
// `args.command as string` and handed it to `execAsync(command, { shell:
// '/bin/zsh' })`. It is DELETED — not flag-disabled, not renamed — and its
// identifier is grep-zero. Everything that made it dangerous was structural: the
// tool's schema said *"the shell command to execute"*, so the model composed
// shell syntax, and the gate in front of it could only ever inspect a program
// NAME inside a line the shell was about to re-parse.
//
// WHAT STANDS HERE INSTEAD:
//   `executeArgv`        `exec({argv})` — `execFile`, no shell at all. The
//                        program is argv[0], every other element is one literal
//                        argument, and the shell's metacharacters are inert.
//   `executeShellScript` `shell({script})` — `/bin/zsh -c <script>`, the same
//                        interpreter with the same semantics as before, behind
//                        its OWN grant class, with the FULL script text audited.
//
// ⚠ `executeShellScript` IS NOT THE DELETED ENTRY POINT RENAMED, and the
// difference is worth stating because a reviewer should be able to check it: the
// old function read `args.command`, was gated by a check that saw only a base
// command, and audited `command` as its target with no record of what the shell
// then did with it. This one reads `args.script`, is gated by the `shell` grant
// rows through the same seam the approval gate uses, and writes the whole script
// to the audit row. The owner's EXEC-LOOP ruling (2026-07-28) rides here intact:
// an agent with shell access runs loops, pipes and redirects as it did yesterday.
//
// The RUNNING — the per-stream 16K caps, the `stdout_truncated:true` flags, the
// `command_failed:` header, the ENOENT/SIGTERM translation — moved verbatim to
// `agent/tools/process-run.ts` so both doors share one body by construction.
// ════════════════════════════════════════════════════════════════════════════

/** Both doors write the same audit shape the deleted entry point wrote. */
// PHASE-5 T4: the file/exec implementations (`executeArgv`,
// `executeShellScript`, `executeFileRead/Write/Append/Patch/List`, the stored-
// attachment lookup and their helpers) moved to `agent/tools/cat/fs.ts` with
// the nine handlers that were their only callers.
// PHASE-5 T4: `USER_MAILBOX_READ_TOOLS` + `prependUserMailboxBanner` moved to
// `agent/tools/provider/mailbox-banner.ts`, with the TEST that holds the
// behaviour — the explicit Google and Microsoft read handlers both banner, the
// default membership branch below banners Google reads and not Microsoft ones,
// and that asymmetry is now a measured, tested fact rather than a comment.

// PHASE-5 T4: `normalizeRepeatDaysOfWeek` + `REPEAT_DAY_NAME_MAP` moved to
// `agent/tools/cat/tracker.ts` with the three work-verb handlers that were
// their only callers.

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
    return withOutboundAsyncIfAbsent(
      {
        agentId, tool: resolved.name, channel: sendChannel,
        recipientId: outboundRecipientForTool(resolved.name, resolved.args as Record<string, unknown>),
        conversationId: currentTurnRoot.get(agentId)?.conversationId ?? null,
      },
      () => dispatchResolved(agentId, toolCall, resolved),
    );
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
  // The PM is an OVERSEER, not a worker: it validates, overrides, retasks,
  // reassigns, and inspects; it never executes or edits the work itself, and
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
      content: `[BLOCKED by engine] You are the project manager (overseer), so "${name}" is not available to you. You do NOT execute or edit work; you oversee it. Your overseer verbs are: work_validate (bless or reject a close-out with action="validate", send work back with action="retask", adjudicate with action="override" / "apply_user_verdict"), work_update(action="reassign") to hand work to another agent, work_schedule (pause / resume), plus read-only inspection (work_update with action="get" or "list", file_read/file_list, history_search, vault_search) and messaging (send_to_agent, broadcast_to_group). If a worker needs to do "${name}", direct the assigned agent to do it via send_to_agent or work_validate(action="retask").`,
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
    const def = toolDefinitions.find((t) => t.name === name);
    if (def && def.input_schema && typeof def.input_schema === 'object') {
      const schema = def.input_schema as { properties?: Record<string, unknown> };
      const declared = new Set(Object.keys(schema.properties ?? {}));
      const extras = Object.keys(args ?? {}).filter(
        (k) => !k.startsWith('__') && !declared.has(k),
      );
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

      // ── Step 4's staging, and its ONE deliberate narrowing of itself ──
      // `logOnly` is true only for the two refusals T2 ADDS (the `-wal`/`-shm`
      // siblings, the symlink-resolved target on the read tier) and only for a
      // sub-agent. Every parity refusal enforces for every agent, always —
      // staging one of those off would be a capability widening in the
      // dangerous direction, which is the opposite of what a log-only window is
      // for. T5 fixes the sub-agent manifest; T7 deletes this branch.
      if (logOnly(agentId, verdict)) {
        logger.warn('BROKER (log-only, staged for sub-agents): would have refused', {
          tool: name, gateRow: outcome.gate.row, rule: verdict.rule,
          resource: outcome.resource, reason: verdict.reason,
        }, agentId);
        auditLog(agentId, outcome.auditAs || name, outcome.resource, 'denied', `[log-only] ${verdict.reason}`);
        continue;
      }

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

    // ── THE RELOCATED HANDLERS (PHASE-5 T4) ─────────────────────────────────
    // Categories that have moved out of this file answer from `agent/tools/`
    // instead of from the switch below. A dispatch key is served by ONE of the
    // two, never both — a category's move deletes its cases in the same commit
    // that adds its module — so this is a shrinking switch, not a second
    // dispatcher racing it (roadmap non-negotiable #1). `handler-table.test.ts`
    // asserts the two key sets are disjoint rather than trusting the discipline.
    //
    // The handler answers with the same two values the case bodies assigned, so
    // everything below the switch — the per-tool `maxResultTokens` cap, the
    // unknown-args warning, the try/catch that turns a throw into
    // `Tool execution failed: …` — still applies to it identically.
    const relocated = handlerFor(dispatchKey);
    if (relocated) {
      const outcome = await relocated({ agentId, name, args, callId: id, toolCall });
      content = outcome.content;
      isError = outcome.isError;
      if (outcome.errorCode) errorCode = outcome.errorCode;
    } else
    switch (dispatchKey) {
      case 'load_tool_docs': {
        const { executeLoadToolDocs } = await import('../tools/tool-docs.js');
        const requestedTools = (args.tools as string[]) ?? [];
        // v2.5.15, Validate the input shape FIRST and emit a precise error
        // so the agent doesn't conflate format problems with permission
        // problems. Previously a permission-stripped request fell through
        // to executeLoadToolDocs([]) which then complained about an
        // "empty array", sending the agent down the wrong rabbit hole.
        if (!Array.isArray(requestedTools)) {
          content = `Error: tools parameter must be an array of tool names. You passed ${typeof args.tools}. Example: load_tool_docs({tools: ["web_fetch", "gmail_send"]}).`;
          isError = true;
          break;
        }
        if (requestedTools.length === 0) {
          content = 'Error: tools parameter must be a non-empty array. Pass at least one tool name. Example: load_tool_docs({tools: ["web_fetch"]}).';
          isError = true;
          break;
        }
        // C27 hook 3: an old (renamed) tool name resolves to the NEW tool's
        // docs; collect a note so the model learns the new name. Tombstoned
        // (removed) tools keep their name and fall through to the blocked path.
        const aliasDocNotes: string[] = [];
        const canonicalRequested = requestedTools.map((t) => {
          const r = resolveToolAlias(t, {});
          if (r.tombstone) return t;
          if (r.name !== t) aliasDocNotes.push(`"${t}" is now "${r.name}"`);
          return r.name;
        });
        // Now intersect with the agent's accessible tools.
        const allowedToolNames = new Set(getFilteredTools(agentId).map(t => t.name));
        const filteredTools = canonicalRequested.filter(t => allowedToolNames.has(t));
        const blockedTools = canonicalRequested.filter(t => !allowedToolNames.has(t));
        if (filteredTools.length === 0) {
          // FN-8: only point at complete_task when this agent actually has it
          // (allowedToolNames already reflects the completability filter).
          const blockedEscalation = allowedToolNames.has('complete_task')
            ? `Ask the user to update this agent's permissions, or call complete_task(status="blocked").`
            : `Ask the user to update this agent's permissions, use send_to_agent to reach an agent with broader permissions, or tell the user you are blocked.`;
          content =
            `Error: none of the requested tools are accessible to this agent. ` +
            `Requested: [${requestedTools.join(', ')}]. ` +
            `This is a permission issue, not a format issue, the tools may exist for other agents but are not on this agent's allow list, or the permission filter is stripping them ` +
            `(e.g. web_search/web_fetch require network_domains != "none", exec requires exec_allow non-empty, file_read requires file_read permission). ` +
            blockedEscalation;
          isError = true;
          break;
        }
        content = executeLoadToolDocs(agentId, filteredTools);
        // C27 hook 3: tell the model which requested names were renamed.
        if (aliasDocNotes.length > 0 && !content.startsWith('Error')) {
          content += `\n\n[Engine note: ${aliasDocNotes.join('; ')}. Docs above are for the new name(s).]`;
        }
        // If some (but not all) of the requested tools were blocked, append
        // a note so the agent knows which ones it didn't get and why.
        if (blockedTools.length > 0 && !content.startsWith('Error')) {
          content +=
            `\n\n[Note: these requested tools were not accessible to this agent and were skipped: ${blockedTools.join(', ')}. ` +
            `Tools may be blocked by tools_policy or by permission filters (network/file/exec/etc.).]`;
        }
        isError = content.startsWith('Error');
        break;
      }

      default: {
        // Membership-based routing for Google / Microsoft tools that the
        // explicit cases above don't list, newer base tools (drive_move,
        // gmail_create_label, docs_insert_text, sheets_format, calendar_freebusy,
        // …) and the user_* slot variants (user_calendar_create, user_docs_create,
        // …). Without this they fell through to "Unknown tool" even with the
        // account connected. The executors handle the user_ prefix + slot.
        if (GOOGLE_WRITE_TOOL_NAMES.has(name) || MS_WRITE_TOOL_NAMES.has(name)) {
          if (!isPrimaryAgent(agentId)) {
            content = 'Permission denied: only the primary agent can use Workspace write tools.';
            isError = true;
            auditLog(agentId, name, null, 'denied', 'Workspace write tool restricted to primary agent');
            break;
          }
        }
        const dispatchAgentName =
          (getDb().prepare('SELECT name FROM agents WHERE id = ?').get(agentId) as { name: string } | undefined)?.name ?? agentId;
        if (GOOGLE_WRITE_TOOL_NAMES.has(name)) {
          content = await executeGoogleWriteTool(name, args, agentId, dispatchAgentName);
          isError = content.startsWith('Error');
        } else if (GOOGLE_READ_TOOL_NAMES.has(name)) {
          content = prependUserMailboxBanner(await executeGoogleReadTool(name, args, agentId, dispatchAgentName), name);
          isError = content.startsWith('Error');
        } else if (MS_WRITE_TOOL_NAMES.has(name)) {
          content = await executeMicrosoftWriteTool(name, args, agentId, dispatchAgentName);
          isError = content.startsWith('Error');
        } else if (MS_READ_TOOL_NAMES.has(name)) {
          content = await executeMicrosoftReadTool(name, args, agentId, dispatchAgentName);
          isError = content.startsWith('Error');
        } else {
          content = `Unknown tool: ${name}`;
          isError = true;
          auditLog(agentId, 'tool_call', name, 'error', 'Unknown tool');
        }
        break;
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

  // Phase 3.5 (2026-05-04), large-files interception path REMOVED.
  // The v1 pattern (`shouldIntercept` + `interceptLargeFile`) replaced
  // oversized content with an "exploration summary" stub that had no path
  // back to the actual content, agents trying to read a 35K-token HTML
  // file got stuck because the recovery tools (history_get / history_expand)
  // returned metadata, not the real content. The new model is per-tool
  // `maxResultTokens` (Phase 3) + offset/limit pagination on `file_read`
  // (Phase 3.5). The `large_files` table stays for backfill of pre-existing
  // intercepted files in production agent histories.

  // Phase 3 (2026-05-04), per-tool result cap enforcement. If the tool's
  // definition declares maxResultTokens and the content exceeds it, truncate
  // here and append a trailer telling the agent how to paginate. Approximate
  // 1 token ≈ 4 chars (conservative; real ratios are 3-4 for English text).
  // Successful results only, error messages stay intact regardless of size.
  if (!isError) {
    content = applyMaxResultTokensCap(name, content);
  }

  // v2.3.19, prepend the unknown-args warning if one was raised at
  // the top of executeTool. Goes BEFORE the cap so it survives any
  // result truncation. Applied to both success and error results so the
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
  };
}

/**
 * Truncate `content` to the tool's `maxResultTokens` cap if exceeded.
 * Adds a generic trailer so the agent knows it was truncated and can
 * paginate via the tool's own offset/limit/filter parameters.
 *
 * Phase 3 (2026-05-04). Used by `executeTool` for every tool whose
 * definition declares `maxResultTokens`. Char/token conversion is
 * approximate (4 chars ≈ 1 token, conservative); the goal is to keep
 * single tool results from blowing context, not exact metering.
 */

export function applyMaxResultTokensCap(toolName: string, content: string): string {
  // Phase 3.5 (2026-05-04), check the cross-file registry first so tools
  // defined outside agent/tools.ts (Google, Microsoft, Slides, Office) can
  // declare caps too. Falls back to the local toolDefinitions array.
  const registered = getRegisteredMaxResultTokens(toolName);
  const local = toolDefinitions.find((t) => t.name === toolName)?.maxResultTokens;
  const cap = registered ?? local;
  if (!cap) return content;

  const charBudget = cap * 4;
  if (content.length <= charBudget) return content;

  // If the tool already appended its own friendly trailer (file_read's
  // pagination stub, end-of-file marker, etc.), don't re-truncate, that
  // would eat the more-helpful per-tool guidance. The tool already capped
  // itself; the engine just slightly overshot the char budget.
  //
  // EXCEPTION: if the content is way over budget (more than 2x), the tool's
  // self-cap is broken, apply the generic truncation regardless of the
  // trailer. Pre-2026-05-06 fix: file_read's per-line cap was missing, so a
  // single-line 5.9MB HTML file appended a "[End of file]" trailer and then
  // bypassed this entire safety net, blowing the model's context window.
  const HARD_OVERSHOOT_RATIO = 2;
  const isHardOvershoot = content.length > charBudget * HARD_OVERSHOOT_RATIO;
  if (!isHardOvershoot) {
    const TOOL_TRAILER_PATTERNS = [
      /\[Read lines \d+-\d+ of \d+ total\./,
      /\[End of file\. Read lines \d+-\d+ of \d+ total\.\]$/,
      /\[Read chars \d+-\d+ of \d+ total\./,
      /\[End of content\. Read chars \d+-\d+ of \d+ total\.\]$/,
      /\[End of content\. Total: \d+ chars\. Requested offset/,
    ];
    const tail = content.slice(-400);
    if (TOOL_TRAILER_PATTERNS.some((re) => re.test(tail))) {
      return content;
    }
  }

  const approxOriginalTokens = Math.round(content.length / 4);
  // Phase 3.5 fix, tool-aware trailer guidance. Tools that have offset/limit
  // pagination get guided toward it; tools that don't get guided toward
  // narrowing their query/scope. Avoids the "use pagination" advice on tools
  // like web_search / vault_search that don't actually support it.
  const TOOLS_WITH_PAGINATION = new Set([
    'file_read',
    'gmail_read', 'outlook_read',
    'drive_read', 'docs_read', 'sheets_read', 'onedrive_read',
  ]);
  const guidance = TOOLS_WITH_PAGINATION.has(toolName)
    ? "Re-call with offset/limit to read more, or use a more specific query."
    : "Narrow your query, ask for less, or use a more specific tool to fit under the cap.";
  const trailer =
    `\n\n[Truncated by engine: returned ~${cap} tokens of ` +
    `~${approxOriginalTokens} total. ${guidance}]`;
  // Reserve room for the trailer so the final string fits the budget.
  const truncatedBody = content.slice(0, Math.max(0, charBudget - trailer.length));
  return truncatedBody + trailer;
}
