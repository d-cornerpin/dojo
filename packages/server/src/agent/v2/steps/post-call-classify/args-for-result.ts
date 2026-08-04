// ════════════════════════════════════════
// PHASE-6 T6 (CUT 8) — `argsForResult`, MOVED WITH THE CODE THAT BINDS IT.
//
// It was declared at `loop.ts`'s module level and had exactly FOUR uses, all of them
// inside this tranche's span (measured `out=0` by binder census before the move, which
// is CUT 6's own rule for deciding move-vs-pass). So one declaration travelled; a
// second copy was not born.
// ════════════════════════════════════════

/**
 * A tool RESULT carries no arguments, but the operation a work verb performed is
 * IN its arguments — so every result-side match resolves the args from the tool
 * CALL that produced it. Without this a `work_update` result would be
 * indistinguishable from any other and the four result-side gates below
 * (transitioned-this-turn, counts-as-task-work, the promise floor, the
 * bookkeeping nudge) would each have to guess. Returns undefined for a result
 * with no matching call, which `workOperation` then resolves by shape.
 */
export function argsForResult(
  toolCalls: ReadonlyArray<{ id: string; name: string; arguments: Record<string, unknown> }>,
  tr: { toolCallId?: string; name?: string },
): Record<string, unknown> | undefined {
  for (let i = toolCalls.length - 1; i >= 0; i--) {
    if (toolCalls[i].id === tr.toolCallId) return toolCalls[i].arguments;
  }
  return undefined;
}
