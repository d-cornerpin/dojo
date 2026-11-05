// ════════════════════════════════════════════════════════════════════════════
// WHO OWNS THE MAC (field fix 3, audit round). ONE answer for every place the Dojo widens a fence for
// the main agent alone.
//
// Owner rulings: OR-MAC-BELONGS-TO-THE-AGENT (2026-10-31): "the Mac belongs to the dojo agent.
// That's the point." 2026-11-04: "the main agent owns the Mac they live in and the dojo doesn't limit
// them." OR-AUDIT-ANSWERS (b), 2026-11-05: "Only Kevin": full-Mac access is the MAIN agent's; helper
// and worker agents keep their limits. OR-AUDIT-ANSWERS (a): "Keep secrets hidden": key and password
// files and the credential tables stay hidden from every agent, the main agent included, so no
// caller of this predicate may use it to open those.
// ════════════════════════════════════════════════════════════════════════════

import { isPrimaryAgent } from '../config/platform.js';

/** Is this the agent the Mac belongs to (the main agent)? */
export function ownsTheMac(agentId: string | null | undefined): boolean {
  return !!agentId && isPrimaryAgent(agentId);
}
