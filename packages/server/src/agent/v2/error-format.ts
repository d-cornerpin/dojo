// One source of truth for error words aimed at a human or at the agent, both from one ErrorKind.
// formatErrorForHuman: plain English for iMessage, dashboard, toast, Vitals proposals;
// formatTierBNoteForAgent: a `[System: ...]` note persisted into history so the agent reads it next turn.
// Spec: docs/error-handling-spec.md.

export type ErrorKind =
  // Tier B (agent-actionable)
  | 'image_too_large_post_sips'
  | 'image_too_many'
  | 'vision_mismatch'
  | 'tool_name_unknown'
  | 'tool_args_invalid_json'
  | 'tool_args_schema_mismatch'
  | 'tool_format_rejected'
  | 'output_truncated'
  | 'empty_response_repeat'
  | 'refusal'
  | 'rate_limit_persistent'
  | 'malformed_request'
  | 'unsupported_modality'
  | 'unsupported_input'
  | 'provider_garbage'
  // Tier D (platform lock)
  | 'auth_invalid'
  | 'access_denied'
  | 'quota_exhausted'
  | 'no_models_available'
  | 'all_providers_down'
  | 'dns_failure'
  | 'db_write_fail'
  | 'disk_full'
  | 'oom_restart';

export interface ErrorContext {
  agentName?: string;
  providerName?: string;
  modelName?: string;
  filename?: string;
  toolName?: string;
  field?: string;
  expectedType?: string;
  actualValue?: string;
  imageCount?: number;
  imageTotal?: number;
  attemptedAlternatives?: number;
}

/** Tier B, agent-facing: the `[System: ...]` note content; the caller wraps it in the shell.
 *  The agent reads this on its next turn and answers the user or adapts its tool approach. */
export function formatTierBNoteForAgent(kind: ErrorKind, ctx: ErrorContext = {}): string {
  switch (kind) {
    case 'image_too_large_post_sips':
      return ctx.filename
        ? `An attached image (${ctx.filename}) was too large for the model even after compression and was dropped. Tell the person you are talking to the image exceeded the model's size limit.`
        : `One attached image was too large for the model even after compression and was dropped. Tell the person you are talking to the image exceeded the model's size limit.`;

    case 'image_too_many':
      return `Only the first ${ctx.imageCount ?? 'N'} of ${ctx.imageTotal ?? 'M'} images were sent — the model has a per-request limit. Mention this to the person you are talking to.`;

    case 'vision_mismatch':
      return `This model can't see images. Describe what you can from the filename and surrounding context, or suggest the owner switch to a vision-capable model in Settings.`;

    case 'tool_name_unknown':
      return ctx.toolName
        ? `Your last tool call referenced "${ctx.toolName}" which isn't a registered tool. Pick a name from your tool index (load_tool_docs shows a tool's full instructions), then adjust and continue.`
        : `Your last tool call referenced a tool that doesn't exist. Pick a name from your tool index (load_tool_docs shows a tool's full instructions), then adjust and continue.`;

    case 'tool_args_invalid_json':
      return `Your last tool call had invalid JSON arguments. Re-issue with valid JSON.`;

    case 'tool_args_schema_mismatch':
      if (ctx.toolName && ctx.field) {
        return `Tool "${ctx.toolName}" needs "${ctx.field}"${ctx.expectedType ? ` as ${ctx.expectedType}` : ''}; your last call sent it wrong. Re-call with the right shape.`;
      }
      return `Your last tool call didn't match the tool's schema. Re-call with the correct argument types and required fields.`;

    case 'tool_format_rejected':
      return `The provider rejected your last tool call format. Re-issue with the correct argument types and required fields. Call load_tool_docs for the tool if you need to recheck its schema.`;

    case 'output_truncated':
      return `Your last response was rejected because it exceeded the output token limit. Be more concise — produce a shorter response, or break the task into smaller pieces. If a tool result is too large to summarize in one turn, update the person you are talking to with what you've done so far and continue next turn.`;

    case 'empty_response_repeat':
      return `Two empty responses in a row. Apologize to the person you are talking to and end your turn.`;

    case 'refusal':
      return `The model refused your last request. Rephrase or tell the person you are talking to you can't help with this.`;

    case 'rate_limit_persistent':
      return ctx.providerName
        ? `${ctx.providerName} is rate-limited right now and retries haven't cleared. Tell the person you are talking to you'll try again in a few minutes, or end this thread cleanly.`
        : `The provider is rate-limited right now and retries haven't cleared. Tell the person you are talking to you'll try again in a few minutes, or end this thread cleanly.`;

    case 'malformed_request':
      return `The provider rejected your last request as malformed. Try a different approach — simpler input, different tool, or skip the step that triggered this.`;

    case 'unsupported_modality':
      return `The model does not support the type of input that was sent. Try the same request without the unsupported attachment, or use a different tool.`;

    case 'unsupported_input':
      return `The model does not support what was sent. Try the same request without the unsupported attachment or tool, or take a different approach.`;

    case 'provider_garbage':
      return `The provider sent a malformed response. Apologize to the person you are talking to and ask them to try again.`;

    // Tier D kinds must not reach this: the caller routes them to formatErrorForHuman; defensive default.
    case 'auth_invalid':
    case 'access_denied':
    case 'quota_exhausted':
    case 'no_models_available':
    case 'all_providers_down':
    case 'dns_failure':
    case 'db_write_fail':
    case 'disk_full':
    case 'oom_restart':
      return `A platform-level error occurred. The owner is being notified directly. End this turn.`;
  }
}

/** Tier D, user-facing: plain English for iMessage alerts, dashboard banners, chat:error toasts.
 *  Hard rule: zero JSON, zero provider fields, zero tracebacks; always end with a concrete next action. */
export function formatErrorForHuman(kind: ErrorKind, ctx: ErrorContext = {}): string {
  const provider = ctx.providerName ?? null;
  const agent = ctx.agentName ?? 'your agent';

  switch (kind) {
    case 'auth_invalid':
      return provider
        ? `${agent}'s ${provider} API key stopped working. Open Settings → Providers and check the key.`
        : `${agent}'s API key stopped working. Open Settings → Providers and check the key for whichever service ${agent} is using.`;

    case 'access_denied':
      return ctx.modelName
        ? `Your account doesn't have access to ${ctx.modelName}${ctx.attemptedAlternatives ? ` (and ${ctx.attemptedAlternatives} alternatives also failed)` : ''}. Pick a different model in Settings.`
        : `Your account doesn't have access to that model. Pick a different model in Settings.`;

    case 'quota_exhausted':
      return provider
        ? `${agent} is stopped: ${provider} says the account is out of credit or quota. Add credit with ${provider} or switch providers in Settings.`
        : `${agent} is stopped: its AI provider says the account is out of credit or quota. Add credit or switch providers in Settings.`;

    case 'no_models_available':
      return `No working model was found for ${agent}'s task. Check provider status in Settings → Providers.`;

    case 'all_providers_down':
      return `None of your AI providers are responding. Looks like an internet issue — The Dojo will keep trying every 5 minutes.`;

    case 'dns_failure':
      return `Can't reach the internet right now. The Dojo will retry shortly.`;

    case 'db_write_fail':
      return `The platform's storage is having a problem. Open the dashboard for recovery options.`;

    case 'disk_full':
      return `Your Mac's hard drive is full. Free up some space and the platform will resume.`;

    case 'oom_restart':
      return `The platform restarted because it ran out of memory.`;

    // Tier B kinds must not reach this surface: the caller routes them via formatTierBNoteForAgent.
    default:
      return `${agent} hit a problem with its last request. It'll explain in chat when you check.`;
  }
}

/** Last-line net that strips raw provider JSON and stack-trace noise from any string about to reach
 *  a user surface. NOT a replacement for formatErrorForHuman: a scrub so bypassers stay readable. */
export function scrubTechnicalDetail(s: string): string {
  let out = s;
  // Strip JSON literals; iterate until stable, since one non-greedy pass leaves outer braces behind.
  for (let i = 0; i < 8; i++) {
    const before = out;
    out = out.replace(/\{[\s\S]*?\}/g, '').replace(/\[[\s\S]*?\]/g, '');
    if (out === before) break;
  }
  // Sweep orphan braces and bracket fragments that survive non-greedy matching on malformed input.
  out = out.replace(/[{}\[\]]+/g, '');
  // Drop error envelope phrases, Anthropic field-path/size markers, and stack frame patterns.
  out = out.replace(
    /(?:Model call failed:|invalid_request_error|messages\.\d+\.content[\w.]*|\.source\.base64|\bbytes maximum\b|\bstack trace\b:?|\bat\s+[\w./]+:\d+:\d+)/gi,
    '',
  );
  // Collapse whitespace produced by the strips.
  out = out.replace(/\s{2,}/g, ' ').trim();
  return out;
}

// An honest stop (spending limit reached, or no model that fits): not a fault, and the Healer cannot
// fix either; plain words, no codes, never "the Healer is looking". The owner reads the true cause,
// what becomes of the message, and the one action.
export type HonestStopKind = 'budget_stop' | 'no_model_fits';
export interface HonestStopContext { scope?: 'global' | 'agent'; period?: string; spendUsd?: number; limitUsd?: number; freeDown?: boolean }

export function honestStopWords(kind: HonestStopKind, ctx: HonestStopContext = {}): string {
  if (kind === 'no_model_fits') {
    return 'None of this agent\'s models can hold its instructions and tools, so its turn was not run. '
      + 'Your message is kept. Pick a bigger model for this agent (or give it fewer tools) and it will answer.';
  }
  const money = ctx.spendUsd !== undefined && ctx.limitUsd !== undefined ? ` ($${ctx.spendUsd.toFixed(2)} of $${ctx.limitUsd.toFixed(2)})` : '';
  const whose = ctx.scope === 'agent' ? `This agent's ${ctx.period ?? 'daily'} spending limit` : 'Today\'s spending limit';
  if (ctx.freeDown) return `${whose} is reached${money}, and none of the free models it can still use answered, so this agent's turn was not run. `
    + 'Your message is kept. It is tried again when you send this agent another message, and answered when the limit resets or is raised, or its models change.';
  return `${whose} is reached${money}, so this agent's turn was not run. `
    + 'Your message is kept. It will be answered when the limit resets, or as soon as you raise the limit in Settings.';
}
