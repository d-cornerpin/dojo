// ════════════════════════════════════════════════════════════════════════════════════════
// WHAT A DASHBOARD-CREATED AGENT STARTS WITH — OWNER RULING 2026-10-05 #4.
//
// The ruling, as the decisions batch put it: *"Default-grant recall for dashboard-created
// agents (grant Conversation Recall by default, or keep offer-with-consent?)"* — GRANT IT.
//
// ── WHY THIS IS A SEPARATE OBJECT AND NOT AN EDIT TO `MOST_RESTRICTIVE_GRANTS` ──
// `MOST_RESTRICTIVE_GRANTS` (`@dojo/shared`) is owner ruling 2's FLOOR: the object every new
// agent starts from, the base `resolveSpawnGrants` clamps, and the thing `grantsDelta` measures
// an audit row against. Widening it would hand the category to every agent an AGENT spawns too
// — `spawn_agent`, the PM's workers, the squad paths — and ruling #4 is about the door the
// OWNER presses, not about what one agent may give another. One door moved; the floor did not.
//
// ── WHY THE OWNER'S DOOR IS THE ONE THAT MAY BE WIDER ──
// `gateway/routes/agents.ts`'s create route is the owner acting through the dashboard: its
// ceiling is the primary agent's own grants and `granterIsPrimary` is true there, which is
// already why that route can switch on a human channel's master that no sub-agent may. A
// different DEFAULT at that door is the same distinction, one field over.
//
// ── EXISTING AGENTS ARE NOT BACKFILLED. DECIDED, AND SAID OUT LOUD ──
// This changes what a NEW agent is created with. It does not reach agents that already exist,
// and that is a decision rather than an omission: a standing grant is something the owner can
// read on the Access panel and was last changed by an audited edit he made. Rewriting the
// stored grants of agents already running would move access under agents whose panel he has
// already read, with no audit row he asked for — the dishonest-UI family. If he wants the
// existing roster to hold it, that is a visible, audited, ORDERED backfill (one migration, one
// `grantsDelta` audit row per agent), and he has not ordered one. Until then: new agents hold
// it, old agents keep whatever their panel says.
//
// ── THE CLAMP STILL APPLIES ──
// Nothing here escalates. The object is handed to `resolveSpawnGrants` as the BASE, which
// clamps it to the granter before anything else happens, so on a box whose primary somehow does
// not hold this category the default quietly falls back to the floor instead of refusing the
// create. That is the one behaviour a hand-built object must not get wrong, and it is why this
// is a base rather than a requested patch (a patch would be judged by the no-escalation rule
// and could turn a create into a 400).
// ════════════════════════════════════════════════════════════════════════════════════════

import type { AccessGrants } from '@dojo/shared';
import { MOST_RESTRICTIVE_GRANTS, cloneGrants } from '@dojo/shared';

/**
 * The tool group the four `recall_*` tools live under, as `tools/categories.ts` labels it.
 *
 * Spelled once here and asserted against the index by
 * `__tests__/a-dashboard-agent-remembers-its-own-threads.test.ts`, which also asserts that the
 * group still CONTAINS the recall tools — a label that survives a re-filing of its tools would
 * be a default grant to an empty room.
 */
export const DASHBOARD_DEFAULT_CATEGORIES = ['Conversation Recall'] as const;

/**
 * THE BASE THE DASHBOARD CREATE ROUTE RESOLVES AGAINST: ruling 2's floor, plus ruling #4's
 * category. Everything else — channels, integrations, credentials, techniques — is the floor's
 * own value, untouched, which is the half of the ruling that is as load-bearing as the addition.
 */
export const DASHBOARD_CREATE_DEFAULT_GRANTS: AccessGrants = (() => {
  const floor = MOST_RESTRICTIVE_GRANTS.tools.categories;
  if (!Array.isArray(floor)) {
    // `'*'` would mean the floor already grants every group and this module is a no-op built on
    // a false premise. Refusing at module load beats shipping a default nobody can reason about.
    throw new Error('MOST_RESTRICTIVE_GRANTS.tools.categories is no longer a list — ruling #4\'s default must be re-derived');
  }
  const grants = cloneGrants(MOST_RESTRICTIVE_GRANTS);
  const categories = [...floor];
  for (const label of DASHBOARD_DEFAULT_CATEGORIES) {
    if (!categories.includes(label)) categories.push(label);
  }
  grants.tools.categories = categories;
  return grants;
})();
