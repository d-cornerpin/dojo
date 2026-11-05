// B11 (GitHub #22) — THE REFUSAL FOR A CALL MADE ONLY OF UNKNOWN ARGUMENTS.
//
// When the arguments an agent sent are ALL ones the tool does not declare, the call is not "a call
// with a stray extra"; it is a call to a different shape of the tool, and running it empty let the
// model read past the warning to a line that said "done". The door refuses it before any gate, with
// what the tool does take and the declared name each unknown one most likely meant. When some
// declared argument IS present this returns null and the old warning stays (the tools' own
// empty-change guards own "an id but no action"). A call with no arguments at all has no extras and
// never reaches here: the required-field door owns it. A tool that declares no arguments is exempt:
// it runs the same way whatever was passed, so there is nothing for the call to have meant.
import { suggestArgNames } from '../../tools/arg-name-help.js';

import { workOpCallName, workOpsThatRead, type WorkOp } from '../../tools/work-verbs.js';

export function allUnknownArgsRefusal(
  name: string,
  args: Record<string, unknown> | undefined,
  declared: ReadonlySet<string>,
  extras: readonly string[],
): string | null {
  const carriesDeclared = Object.keys(args ?? {}).some((k) => !k.startsWith('__') && declared.has(k));
  if (declared.size === 0 || carriesDeclared) return null;
  const byGiven = new Map<string, string[]>();
  for (const { given, meant } of suggestArgNames([...extras], [...declared])) {
    byGiven.set(given, [...(byGiven.get(given) ?? []), meant]);
  }
  const did = [...byGiven].map(([g, ms]) => `${g} → ${ms.join(' or ')}`).join(', ');
  return `Refused: none of the arguments you passed exist on "${name}" (${extras.map((e) => `"${e}"`).join(', ')}). `
    + `Declared arguments: ${[...declared].join(', ')}. ${did ? `Did you mean: ${did}. ` : ''}`
    + `Call load_tool_docs(tools=["${name}"]) and retry with the declared names. Nothing was done.`;
}

/**
 * v3.5 field fix 3, test-2 rank 3: the refusal for DECLARED arguments the chosen operation does not read
 * (`unreadWorkArgs`, `tools/work-verbs.ts`). Facts only: which operation, which arguments, that nothing
 * was done, and which operations read each one, from the same map. The tool text stays unchanged; the
 * guidance rides here.
 */
export function unreadArgsRefusal(op: WorkOp, unread: readonly string[]): string {
  const quoted = unread.map((a) => `"${a}"`);
  const list = quoted.length <= 1 ? quoted.join('') : `${quoted.slice(0, -1).join(', ')} or ${quoted[quoted.length - 1]}`;
  const where = unread.map((a) => {
    const ops = workOpsThatRead(op, a);
    if (ops.length === 0) return `"${a}" is read by no other work operation.`;
    const named = ops.length === 1 ? ops[0] : `${ops.slice(0, -1).join(', ')} and ${ops[ops.length - 1]}`;
    return `"${a}" is read by ${named}.`;
  });
  return `Refused: ${workOpCallName(op)} does not read ${list}, so nothing was done. ${where.join(' ')}`;
}