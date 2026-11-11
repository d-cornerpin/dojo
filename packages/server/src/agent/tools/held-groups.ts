// A group refusal names the groups this agent holds, read from the gate's own accessor so it never claims
// a capability the gate would refuse. The spawn-time check uses the same sentence: one home, no drift.

import { TOOL_CATEGORIES } from '../../tools/categories.js';
import { toolGrantsFor } from '../access/read.js';

export const HELD_GROUPS_NAMED_MAX = 8;

/** `TOOL_CATEGORIES` labels held, in order. `'*'` stays literal: expanding buries the advice. */
export function heldGroupLabels(agentId: string): string[] | '*' {
  const granted = toolGrantsFor(agentId).categories;
  if (granted === '*') return '*';
  const held = new Set(granted);
  return TOOL_CATEGORIES.map((c) => c.label).filter((l) => held.has(l));
}

/** Refusal line. All held: deny or ungrouped. Some: capped labels. None: ask for the grant. */
export function heldGroupsClause(agentId: string): string {
  const held = heldGroupLabels(agentId);
  if (held === '*') {
    return ' This agent holds every tool group, so this refusal is a deny rule or a tool that'
      + ' belongs to no group — retrying a different tool in the same family will not help.';
  }
  if (held.length === 0) {
    return ' This agent holds NO tool groups, so no other tool will reach this either —'
      + ' retrying a different one cannot work. Ask for the group by name.';
  }
  const named = held.slice(0, HELD_GROUPS_NAMED_MAX);
  const rest = held.length - named.length;
  return ` This agent's grants cover: ${named.join(', ')}`
    + `${rest > 0 ? ` (+${rest} more)` : ''}.`
    + ' If none of those can do this, ask for the group above by name rather than trying'
    + ' another tool in it.';
}
