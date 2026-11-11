/** The one stop-reason rule for every transport: the tool count decides stop/tool_calls; length passes through. */
export function resolveProviderStopReason(
  finishReason: string | null | undefined,
  toolCallCount: number,
): string {
  if (finishReason && finishReason !== 'stop' && finishReason !== 'tool_calls') return finishReason;
  return toolCallCount > 0 ? 'tool_use' : 'end_turn';
}
