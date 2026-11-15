// THE EXECUTOR. `executeTool` is the single door every tool call goes through: the
// loop's batches, its auto-delivery sends, the parked a2a resumes. THE ORDER IS THE CONTRACT:
//   1. tools_policy.deny FIRST, ahead of any outbound-capture instrumentation.
//   2. The PM overseer wall: it validates and retasks, never executes.
//   3. Malformed-argument JSON -> PARSE_ERROR. 4. The declared gate loop.
//   5. The schema boundary: AFTER refusals (a refused call answers "permission
//      denied"), BEFORE dispatch (no handler sees a shape it could crash on).
//   6. The three membership interceptors. 7. Dispatch: handler table, else
//      membership fallback.
//   8. The tail: fence, admission, unknown-args warning, audit.
// THE INTERCEPTORS ARE EXECUTOR BODY, NOT HANDLERS: they return a `ToolResult` directly
// and skip the tail; handlers must not return early (a context-budget guarantee rides it).


import { runWithToolCallId } from '../turn-state.js';
import { turnContext } from '../turn-context.js';
import { refuseSendWithNoRecipient, recipientNoteFor } from '../v2/send-recipient.js';
import { classifyToolResult, toolErrorCodeForThrow, type ToolOutcome } from '../tool-outcome.js';
export { toolResultOf, toolWasBlocked, type ToolOutcome } from '../tool-outcome.js';

import { getDb } from '../../db/connection.js';
import { createLogger } from '../../logger.js';
import { resolveToolAlias } from '../../tools/aliases.js';
import { workOperation } from '../../tools/work-verbs.js';
import { withOutboundAsyncIfAbsent, outboundIntentForTool } from '../v2/outbound.js';
import { resolveAgentRef, resolveGroupRef } from '../tool-helpers.js';
import { sharePathGuard, pdfInputPaths } from '../path-guards.js';
import { gatesForCall, ungatedEffectKinds } from './gates.js';
import { validateToolArgs } from './validate-args.js';
import { toolDefinitions, toolDefinitionsByName, isBoundaryValidated, getAllToolDefinitions } from './definitions.js';
import { getFilteredTools, getAgentDenySet } from './surface.js';
import { describeNameFailure } from '../../tools/name-help.js';
import { allUnknownArgsRefusal, unreadArgsRefusal } from './unknown-args-refusal.js';
import { unreadWorkArgs, type WorkOp } from '../../tools/work-verbs.js';
import { handlerFor } from './handlers.js';
// The definitions leaf owns the registration loop; this file keeps only the cap's reader.
import { getRegisteredMaxResultTokens } from '../v2/classifiers/concurrency.js';
import { TOOL_RESULT_VIEW_CHARS, toolResultView } from '../../memory/tool-result-view.js';
import { CHARS_PER_TOKEN } from '../../memory/budget.js';
import { prependMailboxOwnerHeader } from './provider/mailbox-banner.js';
import { fenceOutsideSpan } from '../../tools/inbound-fences.js';
import { auditLog, agentCanSelfCompleteById, permissionDeniedMessage, openFileInCanvas } from './util.js';
import { evaluateGate } from './gate-eval.js';
import { openCallCapability } from '../effects/scopes.js';
import { mayWriteWorkspace } from '../access/workspace.js';
import { isPrimaryAgent, isPMAgent } from '../../config/platform.js';
// Single-source PM allow-list, re-checked at this chokepoint: the wall sits above the gate loop.
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

// Dispatch routing sets; membership routing stops newer tools falling to "Unknown tool".
const GOOGLE_WRITE_TOOL_NAMES = new Set(googleWriteToolDefinitions.map(t => t.name));
const GOOGLE_READ_TOOL_NAMES = new Set(googleReadToolDefinitions.map(t => t.name));
const MS_WRITE_TOOL_NAMES = new Set(microsoftWriteToolDefinitions.map(t => t.name));
const MS_READ_TOOL_NAMES = new Set(microsoftReadToolDefinitions.map(t => t.name));


/** The unknown-argument census over the RUNTIME surface, not the core array (blind to
 *  provider tools and `user_` twins). `declared: null` for a not-live name: warn nothing. */
export function unknownArgsAgainstSchema(
  name: string,
  args: Record<string, unknown> | undefined,
): { declared: ReadonlySet<string> | null; extras: string[]; unread: string[]; op: WorkOp | null } {
  const def = toolDefinitionsByName().get(name);
  if (!def || !def.input_schema || typeof def.input_schema !== 'object') {
    return { declared: null, extras: [], unread: [], op: null };
  }
  const schema = def.input_schema as { properties?: Record<string, unknown> };
  const declared = new Set(Object.keys(schema.properties ?? {}));
  const extras = Object.keys(args ?? {}).filter(
    (k) => !k.startsWith('__') && !declared.has(k),
  );
  const { op, unread } = unreadWorkArgs(name, args, declared);
  return { declared, extras, unread, op };
}


// One execution context per call, at the single door (not a shared slot the batch overwrites).
export async function executeTool(agentId: string, toolCall: ToolCall): Promise<ToolOutcome> {
  // Classifies the five-way outcome ONCE from `isError` + `errorCode`, never prose; must be consumed.
  return classifyToolResult(await runWithToolCallId(agentId, toolCall.id, async () => {
    const refused = refuseSendWithNoRecipient(agentId, toolCall.name, toolCall.arguments, toolCall.id);
    if (refused) return refused;
    const r = await executeToolInCallContext(agentId, toolCall);
    if (!r.isError) r.content += recipientNoteFor(agentId, toolCall.name, toolCall.arguments);
    return r;
  }));
}

async function executeToolInCallContext(agentId: string, toolCall: ToolCall): Promise<ToolResult> {
  // Resolve aliases FIRST: every check below sees the CANONICAL name (catches a missed hook).
  const resolved = resolveToolAlias(toolCall.name, (toolCall.arguments ?? {}) as Record<string, unknown>);
  if (resolved.tombstone) {
    return { toolCallId: toolCall.id, name: toolCall.name, content: resolved.tombstone, isError: true };
  }
  // ONE SCOPE PER SEND CALL: the transport records what happened; a pre-transport refusal writes none.
  const intent = outboundIntentForTool(agentId, resolved.name, resolved.args as Record<string, unknown>, turnContext(agentId)?.root?.conversationId ?? null);
  if (intent !== null) {
    return withOutboundAsyncIfAbsent(intent, () => dispatchResolved(agentId, toolCall, resolved));
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

  // tools_policy.deny: the surface strip is only advice, so a floor model can still emit a
  // denied name. Re-check the SAME deny set ahead of any outbound capture (name is canonical).
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

  // The PM validates, retasks and inspects; it never executes. The surface strip is advice,
  // so re-check the SAME allow-list (`pmMayCall`, matched on the OPERATION) at this wall.
  if (isPMAgent(agentId) && !pmMayCall(name, args)) {
    auditLog(agentId, name, null, 'denied', `${name} is outside the PM overseer allow-list`);
    logger.warn('Blocked PM tool call outside overseer allow-list', { tool: name }, agentId);
    return {
      toolCallId: id,
      name,
      content: `[BLOCKED by engine] You are the project manager (overseer), so "${name}" is not available to you. You do NOT execute work; you oversee it. Your overseer verbs are: work_validate (open a hand-in's proof with action="open_proof", approve it or send it back with action="decide", redirect open work with action="retask"), work_schedule (pause / resume), work_note (a note on a task or project), work_update (action="get", "list" or "activity" to inspect, "edit" for a task's fields, "hand_in" for a task you work yourself), plus read-only inspection (file_read/file_list, history_search, vault_search) and messaging (send_to_agent, broadcast_to_group). If a worker needs to do "${name}", direct the assigned agent to do it via send_to_agent or work_validate(action="retask").`,
      isError: true,
    };
  }

  let content: string = '';
  let isError = false;
  // The guard branches assign and `break`, so this holds "the platform refused" until the return.
  let errorCode: ToolErrorCode | undefined;

  // Unknown-arg detection: without it a dropped arg is silent and the agent believes it took effect.
  let unknownArgsWarning: string | null = null;
  try {
    const { declared, extras, unread, op } = unknownArgsAgainstSchema(name, args);
    // A declared arg the chosen operation does not read refuses the WHOLE call, before anything runs.
    if (op && unread.length > 0) {
      logger.warn('Tool call refused: declared args its operation does not read', { tool: name, op, unread }, agentId);
      return { toolCallId: id, name, content: unreadArgsRefusal(op, unread), isError: true, errorCode: 'UNKNOWN_ARGS' };
    }
    if (declared) {
      if (extras.length > 0) {
        // Not-available refusals speak alone: schema advice ("check the spelling") implies the tool
        // is usable and contradicts the refusal's own redirect.
        const refusalWillSpeak = name === 'complete_task' && !agentCanSelfCompleteById(agentId);
        if (!refusalWillSpeak) {
          const declaredList = [...declared].join(', ') || '(none)';
          const refusal = allUnknownArgsRefusal(name, args, declared, extras);
          if (refusal) return { toolCallId: id, name, content: refusal, isError: true, errorCode: 'UNKNOWN_ARGS' };
          unknownArgsWarning =
            `[Engine warning: "${name}" was called with arg(s) not in its schema, ${extras.map((e) => `"${e}"`).join(', ')}. These were silently ignored. Declared args: ${declaredList}. If you meant a different param, check the spelling with load_tool_docs(tools=["${name}"]).]`;
        }
        logger.warn('Unknown tool args ignored', {
          tool: name, extras, declared: [...declared],
        }, agentId);
      }
    }
  } catch { /* best effort */ }

  // Invalid-JSON args are flagged by model.ts as `__malformed_args`; answer so the model can retry.
  if (args.__malformed_args) {
    const rawSnippet = String(args.__malformed_args).slice(0, 300);
    content = `Error: Your tool call arguments for "${name}" were malformed JSON and could not be parsed.\n\nThe raw text was:\n${rawSnippet}\n\nPlease retry this tool call with valid JSON arguments. Call load_tool_docs(tools=["${name}"]) to see the expected parameter schema.`;
    logger.warn('Rejecting tool call with malformed arguments', { tool: name, rawSnippet }, agentId);
    return { toolCallId: id, name, content, isError: true, errorCode: 'PARSE_ERROR' as const };
  }

  // THE GATE LOOP: the fifteen hand-written permission branches that stood here are now
  // declared gates in `agent/tools/gates.ts`. Parity: same refusals, order, words, audit.
  {
    const gates = gatesForCall(name, args);
    for (const gate of gates) {
      const outcome = await evaluateGate(gate, {
        agentId,
        name,
        args,
        // Resolvers the handlers use too, injected so the gate module never imports this file.
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

    const ungated = ungatedEffectKinds(name, gates);
    if (ungated.length > 0) {
      logger.debug('declared effects with no gate today (recorded, not refused)', {
        tool: name, effects: ungated,
      }, agentId);
    }

    // THE CAPABILITY: all gates answered. The declared effects resolved against these
    // args are the only resources the facade will perform; it mints no permission.
    openCallCapability(agentId, name, id, args);
  }

  // THE ONE SCHEMA-VALIDATION BOUNDARY: one validator over `input_schema` and the
  // `fields` sibling (`allowEmpty`, `requiredNotEnforced`); no check, no new refusal.
  if (isBoundaryValidated(name)) {
    const argsError = validateToolArgs(toolDefinitionsByName().get(name), args);
    if (argsError) {
      logger.warn('Tool call rejected by the schema-validation boundary', { tool: name, error: argsError }, agentId);
      return { toolCallId: id, name, content: argsError, isError: true, errorCode: 'INVALID_ARGS' };
    }
  }

  try {
    if (pdfToolNames.includes(name)) {
      // A caller-chosen path goes straight into context: gate every INPUT path as share_file does.
      for (const rawPdfPath of pdfInputPaths(args)) {
        const pdfGuard = await sharePathGuard(agentId, name, rawPdfPath);
        if (!pdfGuard.allowed) {
          auditLog(agentId, name, pdfGuard.absPath, 'denied', pdfGuard.reason);
          return { toolCallId: id, name, content: pdfGuard.blockedMessage ?? permissionDeniedMessage(pdfGuard.reason, agentId), isError: true, errorCode: 'PERMISSION_DENIED' };
        }
      }
      content = await executePdfTool(name, args, agentId);
      isError = content.startsWith('Error');
      // Auto-open a PRODUCED pdf; read-only PDF tools produce no file and must not re-open an input.
      const PDF_READ_ONLY = name === 'pdf_read' || name === 'pdf_get_info';
      if (!isError && !PDF_READ_ONLY) {
        const pdfPath = content.match(/(\/\S+\.pdf)\b/i)?.[1];
        if (pdfPath && openFileInCanvas(agentId, pdfPath).opened) {
          content += '\n\nThis PDF is now open in the canvas, the user can see it. No need to call canvas_render, show_to_user, or share_file to show it; just tell them it is on the canvas (share the download link only if they ask to save it).';
        }
      }
      return { toolCallId: id, name, content, isError };
    }

    // Primary AND read-level agents; PM agents ('none') aren't shown these, fall to unknown-tool.
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

    // Google Forms (slides dispatch mirrored): writes are primary-only via tool filtering.
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

    // Dispatch on the OPERATION, not the raw name: verbs key as `<verb>:<discriminator>`.
    const dispatchKey = workOperation(name, args) ?? name;

    // DISPATCH: every key answers from `tools/cat/*` or `tools/provider/*`; the `else` below
    // is the old `default:` arm. The tail applies to handler results identically.
    const relocated = handlerFor(dispatchKey);
    if (relocated) {
      const outcome = await relocated({ agentId, name, args, callId: id, toolCall });
      content = outcome.content;
      isError = outcome.isError;
      if (outcome.errorCode) errorCode = outcome.errorCode;
    } else if (
      // The guard's predicate: the agent's per-ACCOUNT Workspace grant (plus a send's channel grant).
      (GOOGLE_WRITE_TOOL_NAMES.has(name) || MS_WRITE_TOOL_NAMES.has(name))
      && !mayWriteWorkspace(agentId, name, GOOGLE_WRITE_TOOL_NAMES.has(name) ? 'google' : 'microsoft')
    ) {
      content = 'Permission denied: only the primary agent can use Workspace write tools.';
      isError = true;
      auditLog(agentId, name, null, 'denied', 'Workspace write tool restricted to primary agent');
    } else {
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
        // The SAME classified truth as the load_tool_docs path: `unknown`, or `exists_not_allowed`.
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
    // A provider throw carries a status or structured code: a structural WHY, not a `crashed`.
    errorCode = errorCode ?? toolErrorCodeForThrow(err);
    auditLog(agentId, 'tool_call', name, 'error', content);
  }

  // Admission: a result longer than its view is kept WHOLE and the agent sees its pointer.
  // The other-people's-text fence applies HERE, before admission, so a whole is stored fenced.
  content = fenceOutsideSpan(name, args, content, toolCall);
  const admitted = admitToolResult(name, id, content, isError);
  content = admitted.content;
  const keptWhole = admitted.keptWhole;

  // The unknown-args warning goes on AFTER admission, so a pointer never hides it.
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

/** The view the agent sees, plus the whole when that view is its pointer (the recorder keeps it). */
export function admitToolResult(toolName: string, callId: string, content: string, isError = false): { content: string; keptWhole?: string } {
  const size = resultViewChars(toolName, content, isError);
  return callId && content.length > size ? { content: toolResultView(content, callId, size), keptWhole: content } : { content };
}

/** Characters shown whole: never past `TOOL_RESULT_VIEW_CHARS`; a declared `maxResultTokens` lowers it
 *  (x2 for the tool's own pages); an error gets the view alone. */
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

// LAST in the file on purpose: `gates.js` already loads the registry; this never moves eval order.
export { effectsFor } from './registry.js';
