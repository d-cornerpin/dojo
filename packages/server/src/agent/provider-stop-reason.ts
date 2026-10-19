// ════════════════════════════════════════════════════════════════════════════════════════
// SWEEP-A TB8 JOB 1 (moved here by t239) — THE STOP REASON IS NEVER FABRICATED, ON ANY TRANSPORT.
//
// The OpenAI-compatible path used to report `stopReason: toolCalls.length > 0 ? 'tool_use' : 'end_turn'`
// and discard the provider's `finish_reason` entirely. Every call on that path therefore told the
// engine "the model finished normally" even when the provider had TRUNCATED it at the output cap, and
// the ladder that reads `TRUNCATION_STOP_REASONS` in `v2/classifiers/output.ts` could never once fire there.
//
// THE BOUND THAT MATTERS IS THE CAP THE PRODUCT ALREADY CONFIGURES, and it was derived from the
// durable sink rather than chosen: over 19,124 completed calls carrying a known cap (2026-07-27 →
// 2026-08-06, all four batteries), exactly 17 reached their model's own `max_output_tokens` —
// 0.089% — and every recorded runaway is one of them, across two different models and two different
// caps. A DURATION bound orders the two populations wrong (legitimate calls at 216.3 s against
// runaways at 129.95 s), and any sub-cap OUTPUT-TOKEN threshold sits 133 tokens (0.8%) from a
// legitimate call that ended in a tool call (both refused, with their numbers, in
// `steps/post-call-classify/__tests__/output-grind.test.ts`). The provider reporting its own
// truncation is the only signal that separates them categorically — 17 of 17 caught, 0 of 19,107
// false.
//
// t239: the Ollama transport kept the fabrication (`any parsed tool call => 'tool_use'`) after the
// OpenAI path lost it, and a reply cut mid-sentence whose tool call had already parsed ran as if it
// were whole. Both transports now go through THIS ONE rule. `'stop'` and `'tool_calls'` say only what
// the tool-call count already says, so they stay with it; anything else the provider reports
// (`length`, `max_tokens`, ...) is passed through untouched.
// ════════════════════════════════════════════════════════════════════════════════════════
export function resolveProviderStopReason(
  finishReason: string | null | undefined,
  toolCallCount: number,
): string {
  if (finishReason && finishReason !== 'stop' && finishReason !== 'tool_calls') return finishReason;
  return toolCallCount > 0 ? 'tool_use' : 'end_turn';
}
