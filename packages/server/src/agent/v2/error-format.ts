// ════════════════════════════════════════
// Error Format — single source of truth for user-facing and
// agent-facing error language.
//
// Two surfaces:
//   - formatErrorForHuman(kind, context): plain-English message for
//     iMessage / dashboard banner / chat:error toast / Vitals proposals.
//     Strictly no JSON, no provider error fields, no tracebacks. End with
//     a concrete next action.
//   - formatTierBNoteForAgent(kind, context): `[System: …]` template
//     persisted into the agent's chat history so the agent has explicit
//     context on its next turn.
//
// Spec: docs/error-handling-spec.md.
// ════════════════════════════════════════

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

/**
 * Tier B — agent-facing `[System: …]` note content. Caller wraps in the
 * `[System: …]` shell when persisting. Templates assume the agent will
 * read this on its next turn and produce a normal text reply to the user
 * (or adapt its approach for tool errors).
 */
export function formatTierBNoteForAgent(kind: ErrorKind, ctx: ErrorContext = {}): string {
  switch (kind) {
    case 'image_too_large_post_sips':
      return ctx.filename
        ? `An attached image (${ctx.filename}) was too large for the model even after compression and was dropped. Tell the user the image exceeded the model's size limit.`
        : `One attached image was too large for the model even after compression and was dropped. Tell the user the image exceeded the model's size limit.`;

    case 'image_too_many':
      return `Only the first ${ctx.imageCount ?? 'N'} of ${ctx.imageTotal ?? 'M'} images were sent — the model has a per-request limit. Mention this to the user.`;

    case 'vision_mismatch':
      return `This model can't see images. Describe what you can from the filename and surrounding context, or suggest the user switch to a vision-capable model in Settings.`;

    case 'tool_name_unknown':
      return ctx.toolName
        ? `Your last tool call referenced "${ctx.toolName}" which isn't a registered tool. Use list_tool_docs to see what's available, then adjust and continue.`
        : `Your last tool call referenced a tool that doesn't exist. Use list_tool_docs to see what's available, then adjust and continue.`;

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
      return `Your last response was rejected because it exceeded the output token limit. Be more concise — produce a shorter response, or break the task into smaller pieces. If a tool result is too large to summarize in one turn, update the user with what you've done so far and continue next turn.`;

    case 'empty_response_repeat':
      return `Two empty responses in a row. Apologize to the user and end your turn.`;

    case 'refusal':
      return `The model refused your last request. Rephrase or tell the user you can't help with this.`;

    case 'rate_limit_persistent':
      return ctx.providerName
        ? `${ctx.providerName} is rate-limited right now and retries haven't cleared. Tell the user you'll try again in a few minutes, or end this thread cleanly.`
        : `The provider is rate-limited right now and retries haven't cleared. Tell the user you'll try again in a few minutes, or end this thread cleanly.`;

    case 'malformed_request':
      return `The provider rejected your last request as malformed. Try a different approach — simpler input, different tool, or skip the step that triggered this.`;

    case 'unsupported_modality':
      return `The model does not support the type of input that was sent. Try the same request without the unsupported attachment, or use a different tool.`;

    case 'unsupported_input':
      return `The model does not support what was sent. Try the same request without the unsupported attachment or tool, or take a different approach.`;

    case 'provider_garbage':
      return `The provider sent a malformed response. Apologize to the user and ask them to try again.`;

    // Tier D kinds shouldn't reach this function — caller routes Tier D to
    // formatErrorForHuman instead. Defensive default for completeness.
    case 'auth_invalid':
    case 'access_denied':
    case 'quota_exhausted':
    case 'no_models_available':
    case 'all_providers_down':
    case 'dns_failure':
    case 'db_write_fail':
    case 'disk_full':
    case 'oom_restart':
      return `A platform-level error occurred. The user is being notified directly. End this turn.`;
  }
}

/**
 * Tier D — user-facing plain-English message. Used for iMessage alerts,
 * dashboard banners, and chat:error toasts when the platform genuinely
 * can't proceed without user action.
 *
 * Hard rule: zero JSON, zero provider error fields, zero tracebacks.
 * Always end with a concrete next action.
 */
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
        ? `${provider} has hit its quota for the day. Switch providers in Settings or wait until reset.`
        : `Your AI provider has hit its quota for the day. Switch providers in Settings or wait until reset.`;

    case 'no_models_available':
      return `I couldn't find any working model for ${agent}'s task. Check provider status in Settings → Providers.`;

    case 'all_providers_down':
      return `None of your AI providers are responding. Looks like an internet issue — I'll keep trying every 5 minutes.`;

    case 'dns_failure':
      return `Can't reach the internet right now. I'll retry shortly.`;

    case 'db_write_fail':
      return `The platform's storage is having a problem. Open the dashboard for recovery options.`;

    case 'disk_full':
      return `Your Mac's hard drive is full. Free up some space and the platform will resume.`;

    case 'oom_restart':
      return `The platform restarted because it ran out of memory.`;

    // Tier B kinds shouldn't reach this surface — caller routes them via
    // formatTierBNoteForAgent instead. Defensive default.
    default:
      return `${agent} hit a problem with its last request. It'll explain in chat when you check.`;
  }
}

/**
 * Strip anything that smells like raw provider JSON or stack-trace noise
 * from a string. Used as a defense-in-depth net for any code path that
 * might accidentally pass technical detail to a user-facing surface.
 *
 * NOT a replacement for going through formatErrorForHuman — this is a
 * last-line scrub so callers that bypass the helper still produce
 * readable output.
 */
export function scrubTechnicalDetail(s: string): string {
  let out = s;
  // Drop anything that looks like JSON object or array literal. Iterate
  // until stable so nested JSON gets stripped (one non-greedy pass leaves
  // outer braces behind when the inner literal is removed first).
  for (let i = 0; i < 8; i++) {
    const before = out;
    out = out.replace(/\{[\s\S]*?\}/g, '').replace(/\[[\s\S]*?\]/g, '');
    if (out === before) break;
  }
  // Catch-all sweep for orphan braces and stray bracket fragments that
  // survive non-greedy matching against malformed input.
  out = out.replace(/[{}\[\]]+/g, '');
  // Drop common error envelope phrases AND the source field-path / size
  // markers Anthropic emits, plus stack frame patterns.
  out = out.replace(
    /(?:Model call failed:|invalid_request_error|messages\.\d+\.content[\w.]*|\.source\.base64|\bbytes maximum\b|\bstack trace\b:?|\bat\s+[\w./]+:\d+:\d+)/gi,
    '',
  );
  // Collapse whitespace produced by the strips.
  out = out.replace(/\s{2,}/g, ' ').trim();
  return out;
}
