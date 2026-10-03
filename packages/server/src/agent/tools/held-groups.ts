// ════════════════════════════════════════════════════════════════════════════════
// A REFUSAL THAT SAYS WHAT THE AGENT *DOES* HOLD.
// (t90 D3 — live-test report #4)
//
// ── THE REPORT ──
// A sub-agent was spawned to write one short line into a file. *"The agent attempted a file-write
// tool first; the call was refused by a permission gate because the tool's group was not in the
// agent's grants. It then attempted the same effect via the shell tool; that was refused by the
// same gate, for the same reason. The task was therefore unrunnable end to end."* Two tools, two
// refusals, one cause — and the agent could not tell from either refusal that EVERY path to its
// deliverable was closed, so it spent its turns discovering that one call at a time.
//
// The report names the cheap fix itself, and it is this one: *"A short 'your grants cover these
// groups: …' line in the refusal would have turned the discovery loop into a single call."*
//
// ── WHY THIS IS A SEPARATE MODULE AND NOT THREE WORDS IN `gate-eval.ts` ──
// `gate-eval.ts` is pinned at 370 with two lines of headroom, and the refusal it builds is one
// expression inside a 25-row switch. The sentence this file returns is also the sentence the
// SPAWN-time check wants (the other half of report #4), so it has one home and two readers rather
// than two copies that drift — the same argument `toolCategoryLabels` already carries for the
// group name the refusal already prints.
//
// ── WHAT IT DELIBERATELY DOES NOT DO ──
// It does not guess. There is no "this task sounds like filesystem work" anywhere here: the
// groups are read from the agent's own grant record through the same accessor the gate and the
// surface strip already share, so the sentence cannot claim a capability the executor would
// refuse. An agent holding `'*'` is told so plainly rather than handed 38 labels.
// ════════════════════════════════════════════════════════════════════════════════

import { TOOL_CATEGORIES } from '../../tools/categories.js';
import { toolGrantsFor } from '../access/read.js';

/** How many group labels a refusal will name before it stops listing and starts counting. */
export const HELD_GROUPS_NAMED_MAX = 8;

/**
 * The `TOOL_CATEGORIES` labels this agent actually holds, in declaration order.
 *
 * `'*'` is returned as the literal string rather than expanded: an agent granted everything is
 * answering a different question ("which of my groups covers this?" → "all of them"), and
 * printing 38 labels into a tool result would push the useful half of the refusal past the point
 * a model reads.
 */
export function heldGroupLabels(agentId: string): string[] | '*' {
  const granted = toolGrantsFor(agentId).categories;
  if (granted === '*') return '*';
  const held = new Set(granted);
  return TOOL_CATEGORIES.map((c) => c.label).filter((l) => held.has(l));
}

/**
 * THE SENTENCE. Appended to a group refusal so the next call can be the right one.
 *
 * Three shapes, because the three situations need different advice:
 *   * `'*'`            — every group is granted, so a group refusal means the tool is in no
 *                        category at all or a DENY is in play; say that, do not list.
 *   * some groups      — name them, capped, so the agent can pick a tool it can actually call.
 *   * none             — the case report #4 hit, and the one worth saying out loud: no tool group
 *                        at all means no amount of retrying finds a path, and the only move is to
 *                        ask for a grant.
 */
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
