// 9603 — the SDK delivers a provider refusal as an assistant message carrying a top-level
// `error`. These helpers name which kinds are refusals and phrase them in words the shared
// classifier (`classifyProviderErrorText`) reads. `max_output_tokens` and `unknown` are not refusals.
const PHRASES: Record<string, string> = {
  billing_error: 'insufficient balance (billing_error)',
  authentication_failed: 'authentication_error (authentication_failed)',
  rate_limit: 'rate_limit (rate limit)',
  server_error: 'internal server error (server_error)',
  invalid_request: 'invalid_request_error',
};

export function refusalKindOf(error: unknown): string | null {
  return typeof error === 'string' && Object.prototype.hasOwnProperty.call(PHRASES, error) ? error : null;
}

export function sdkRefusalMessage(kind: string, text: string): string {
  return `Agent SDK refused: ${PHRASES[kind]}: ${text}`;
}

/**
 * Watches the SDK's messages for a refusal. `observe` returns true for a message that is the
 * provider's own sentence (so the caller skips it as reply text); `throwIfNoReply` raises it after
 * the loop when no real reply text arrived, or raises a bare error result that carried no text.
 */
export class SdkRefusalWatch {
  private kind: string | null = null;
  private text = '';
  private errored: string | null = null;

  observe(message: { type?: string }): boolean {
    const m = message as { is_error?: unknown; subtype?: unknown; error?: unknown; message?: { content?: Array<{ type?: string; text?: unknown }> } };
    if (message.type === 'result' && m.is_error === true) this.errored = String(m.subtype ?? 'unknown');
    const kind = message.type === 'assistant' ? refusalKindOf(m.error) : null;
    if (!kind) return false;
    this.kind = kind;
    this.text = (m.message?.content ?? [])
      .filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text as string).join('').trim().slice(0, 300);
    return true;
  }

  throwIfNoReply(reply: string): void {
    if (reply) return;
    if (this.kind) throw new Error(sdkRefusalMessage(this.kind, this.text));
    if (this.errored !== null) throw new Error(`Agent SDK ended with an error (${this.errored})`);
  }
}
