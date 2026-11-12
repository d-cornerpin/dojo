/** The arguments of the call that produced a result (a result carries none); undefined if none matches. */
export function argsForResult(
  toolCalls: ReadonlyArray<{ id: string; name: string; arguments: Record<string, unknown> }>,
  tr: { toolCallId?: string; name?: string },
): Record<string, unknown> | undefined {
  for (let i = toolCalls.length - 1; i >= 0; i--) {
    if (toolCalls[i].id === tr.toolCallId) return toolCalls[i].arguments;
  }
  return undefined;
}
