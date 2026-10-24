// B14 — THE CLAUDE SDK TRANSPORT'S STOP REASON IS THE PROVIDER'S OWN WORD.
//
// The transport returned `toolCalls.length > 0 ? 'tool_use' : 'end_turn'` and read no stop reason at
// all, so a reply the provider CUT at its output limit was reported as a normal finish and the cut
// ladder (which keys on the provider's word) could never fire on this transport.
//
// The SDK relays the reason in three places (the finished assistant message, the streamed
// `message_delta`, the closing `result`); the last non-null one wins. `max_output_tokens` also
// arrives as the assistant message's `error`, which says the same thing when no `stop_reason` rode
// along. A CUT is sticky: once any message said the output was cut, a later ordinary finish (the
// closing `result` mirrors the last message) cannot hide it. Anthropic's ordinary finishes (`end_turn`, `tool_use`, `stop_sequence`) say only what the
// parsed tool-call count already says (this transport parses its tool calls out of text, so the
// provider says `end_turn` even when one parsed); anything else, above all a cut, passes through.
import { resolveProviderStopReason } from '../agent/provider-stop-reason.js';
import { isOutputCut } from '../agent/v2/classifiers/output.js';

export function createSdkStopReasonTracker() {
  let seen: string | null = null;
  let cut: string | null = null;
  let outputLimitError = false;
  const note = (reason: unknown): void => {
    if (typeof reason !== 'string' || reason === '') return;
    if (isOutputCut(reason)) cut = reason;
    seen = reason;
  };
  return {
    /** Read whatever stop information one SDK message carries. */
    observe(message: { type?: string; [k: string]: unknown }): void {
      const m = message as { message?: { stop_reason?: unknown }; event?: { type?: string; delta?: { stop_reason?: unknown } }; error?: unknown; stop_reason?: unknown };
      if (message.type === 'assistant') {
        note(m.message?.stop_reason);
        if (m.error === 'max_output_tokens') outputLimitError = true;
      } else if (message.type === 'stream_event' && m.event?.type === 'message_delta') {
        note(m.event.delta?.stop_reason);
      } else if (message.type === 'result') {
        note(m.stop_reason);
      }
    },
    /** The stop reason to report, given how many tool calls parsed out of the text. */
    resolve(toolCallCount: number): string {
      const ordinary = seen === 'end_turn' || seen === 'tool_use' || seen === 'stop_sequence';
      const provider = cut ?? (outputLimitError ? 'max_output_tokens' : (ordinary ? null : seen));
      return resolveProviderStopReason(provider, toolCallCount);
    },
  };
}
