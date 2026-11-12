// Refuse a call whose arguments are ALL unknown to the tool: running it empty would report
// success for a shape never accepted. Null when some declared argument is present (the per-tool
// warnings own that) or the tool declares none; a call with no args belongs to the required-field door.
import { canonicalToken, editDistance } from '../../tools/name-help.js';
import { workOpCallName, workOpsThatRead, type WorkOp } from '../../tools/work-verbs.js';

// Likely-meant names, lexical only: edit distance of two or less, or one shared underscore
// stem of at least three letters. Short words like "id" sit in half the schemas.

function argTokens(name: string): string[] {
  return name.toLowerCase().split('_').filter((t) => t.length >= 3).map(canonicalToken);
}

/** For each unknown argument name, the declared name(s) it most likely meant. A close
 * spelling wins over a shared stem; a stem fitting several names returns them all. */
export function suggestArgNames(
  unknown: string[],
  declared: readonly string[],
): Array<{ given: string; meant: string }> {
  const out: Array<{ given: string; meant: string }> = [];
  for (const given of unknown) {
    const g = given.toLowerCase();
    let bestDistance = Infinity;
    let close: string[] = [];
    for (const d of declared) {
      const dl = d.toLowerCase();
      if (Math.min(g.length, dl.length) < 4) continue;
      const distance = editDistance(g, dl);
      if (distance > 2) continue;
      if (distance < bestDistance) { bestDistance = distance; close = [d]; }
      else if (distance === bestDistance) close.push(d);
    }
    let meant = close;
    if (meant.length === 0) {
      const givenTokens = new Set(argTokens(given));
      meant = declared.filter((d) => argTokens(d).some((t) => givenTokens.has(t)));
    }
    for (const m of meant) out.push({ given, meant: m });
  }
  return out;
}

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

/** Refusal for declared arguments the chosen operation does not read (`unreadWorkArgs`,
 * `tools/work-verbs.ts`): facts only, nothing was done, and the tool text stays as it is. */
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