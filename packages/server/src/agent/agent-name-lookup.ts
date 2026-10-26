import { getDb } from '../db/connection.js';
import { editDistance } from '../tools/name-help.js';

// ── Finding a live agent by NAME, without regard to case (E21) ───────────────
//
// A name is a name: "Worker-B", "worker-b" and "WORKER-B" are one agent to a person. `agents.name`
// has no UNIQUE constraint and no collation, so two live rows can differ only by case; the newest
// is the one a name means (the same rule `resolveAgentRef` applies). `rowid` breaks a tie between
// two rows created in the same second, so the tool and the transport can never pick differently.

export interface LiveAgentByName { id: string; name: string; status: string; created_at: string }

/** Every non-terminated agent whose name matches `name` ignoring case, newest first. */
export function liveAgentsNamed(name: string): LiveAgentByName[] {
  return getDb().prepare(
    `SELECT id, name, status, created_at FROM agents
       WHERE name = ? COLLATE NOCASE AND status != 'terminated'
       ORDER BY created_at DESC, rowid DESC`,
  ).all(name) as LiveAgentByName[];
}

/**
 * E21 parked minor: the live agent the create/rename doors must refuse, when `name` would mint a
 * second agent the case-insensitive lookup cannot tell apart. Returns the existing row when a
 * live agent's name differs from `name` only by capital letters; null for an exact byte-identical
 * duplicate (pre-existing behaviour, still allowed), for an agent's own name (`selfId` is
 * skipped — renaming "Helper" to "helper" is fine), and for terminated agents (never found by name).
 */
export function caseVariantClash(name: string, selfId?: string): LiveAgentByName | null {
  const wanted = name.trim();
  for (const row of liveAgentsNamed(wanted)) {
    if (row.id === selfId) continue;
    if (row.name !== wanted) return row;
  }
  return null;
}

/** The plain door error naming the clashing agent, in the style the doors already use. */
export function caseVariantClashMessage(existingName: string): string {
  return `An agent named "${existingName}" already exists; names are matched without regard to capital letters.`;
}

/** E21: when a name matches two live agents (differing only by case), the sender is told who got it. */
export function sameNameNote(ref: string, named: ReadonlyArray<{ id: string; name: string }>): string {
  if (named.length < 2) return '';
  return ` NOTE: ${named.length} live agents are named "${ref}" (differing only by capital letters): ${named.map((a) => `"${a.name}" (${a.id})`).join(', ')}. The message went to the newest, "${named[0].name}" (${named[0].id}); pass an agent id to reach a different one.`;
}

/**
 * The live agents' names a failed lookup of `requested` most plausibly meant: the ones that contain it
 * or are contained by it, or are within two edits of it (ignoring case). When none is close the answer
 * is every live name, so the sender always has the real choices in front of it.
 */
export function liveAgentNamesNear(requested: string): string[] {
  const names = (getDb().prepare(
    `SELECT name FROM agents WHERE status != 'terminated' AND name IS NOT NULL ORDER BY name COLLATE NOCASE`,
  ).all() as Array<{ name: string }>).map((r) => r.name);
  const want = requested.trim().toLowerCase();
  const close = want === '' ? [] : names.filter((n) => {
    const have = n.toLowerCase();
    return have.includes(want) || want.includes(have) || editDistance(want, have) <= 2;
  });
  return [...new Set(close.length > 0 ? close : names)];
}
