// The reported stop reason is the provider's own word, so the cut ladder can fire. The last non-null of the
// assistant message, `message_delta` and closing `result` wins; an assistant `error` of `max_output_tokens`
// also counts as a cut. A CUT is sticky (the closing `result` cannot hide it); ordinary finishes (`end_turn`,
// `tool_use`, `stop_sequence`) defer to the parsed tool-call count, since tool calls are parsed from text.
import { resolveProviderStopReason } from '../agent/provider-stop-reason.js';
import { SdkRefusalWatch } from './sdk-refusal.js';
import { isOutputCut } from '../agent/v2/classifiers/output.js';

export function createSdkStopReasonTracker() {
  let seen: string | null = null;
  let cut: string | null = null;
  let outputLimitError = false;
  const refusals = new SdkRefusalWatch();
  const note = (reason: unknown): void => {
    if (typeof reason !== 'string' || reason === '') return;
    if (isOutputCut(reason)) cut = reason;
    seen = reason;
  };
  return {
    /** Reads the stop information one SDK message carries; true means it is the provider's refusal, not reply text. */
    observe(message: { type?: string; [k: string]: unknown }): boolean {
      const m = message as { message?: { stop_reason?: unknown }; event?: { type?: string; delta?: { stop_reason?: unknown } }; error?: unknown; stop_reason?: unknown };
      if (message.type === 'assistant') {
        note(m.message?.stop_reason);
        if (m.error === 'max_output_tokens') outputLimitError = true;
      } else if (message.type === 'stream_event' && m.event?.type === 'message_delta') {
        note(m.event.delta?.stop_reason);
      } else if (message.type === 'result') {
        note(m.stop_reason);
      }
      return refusals.observe(message);
    },
    throwIfNoReply(reply: string): void { refusals.throwIfNoReply(reply); },
    /** The stop reason to report, given how many tool calls parsed out of the text. */
    resolve(toolCallCount: number): string {
      const ordinary = seen === 'end_turn' || seen === 'tool_use' || seen === 'stop_sequence';
      const provider = cut ?? (outputLimitError ? 'max_output_tokens' : (ordinary ? null : seen));
      return resolveProviderStopReason(provider, toolCallCount);
    },
  };
}
