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
