// Who holds dojo_inspect, one predicate for the advertised list (agent/tools/surface.ts) and the gate
// (agent/tools/gate-eval.ts): a deny wins; a tools.allow naming it grants any agent; else the main agent and
// the Healer, while the dashboard group is on. The shell door (agent/brokers/dojo-redirect.ts) never asks.

import { isHealerAgent, isPrimaryAgent } from '../config/platform.js';
import { toolGrantsFor, toolCategoryGranted, forgetAccessGrants } from '../agent/access/read.js';
import { getDb } from '../db/connection.js';

export const DOJO_INSPECT = 'dojo_inspect';

export function holdsDojoInspect(agentId: string): boolean {
  const tools = toolGrantsFor(agentId);
  if (tools.deny.includes(DOJO_INSPECT)) return false;
  if (tools.allow.includes(DOJO_INSPECT)) return true;
  return (isPrimaryAgent(agentId) || isHealerAgent(agentId)) && toolCategoryGranted(agentId, DOJO_INSPECT);
}

// tools.allow GRANTS here (elsewhere it restricts): owner routes never ask; the main agent holding it may.
export function mayGrantDojoInspect(granterId: string): boolean {
  return isPrimaryAgent(granterId) && holdsDojoInspect(granterId);
}

const names = (list: unknown): boolean => Array.isArray(list) && list.includes(DOJO_INSPECT);

export function inspectGrantRefusal(granterId: string, ...allows: unknown[]): string | null {
  if (!allows.some(names) || mayGrantDojoInspect(granterId)) return null;
  return 'tools.allow: cannot grant dojo_inspect — only the owner or the main agent can grant it.';
}

// Null when dropping an ungrantable inherited dojo_inspect empties it: an empty allow list means every tool.
export function withoutInheritedInspect(granterId: string, allow: string[]): string[] | null {
  if (!allow.includes(DOJO_INSPECT) || mayGrantDojoInspect(granterId)) return allow;
  const kept = allow.filter((t) => t !== DOJO_INSPECT);
  return kept.length > 0 ? kept : null;
}

// Judges an edit of another agent by what it leaves, in an always-rolled-back savepoint: refused if the
// target would GAIN the tool (always when the owner withheld it, else unless the editor may grant it).
// Returns the edit's own refusal or this one, nothing written either way; null: now make the edit for real.
export function inspectGainRefusal<R>(editorId: string, targetId: string, edit: () => R | null): R | string | null {
  const held = holdsDojoInspect(targetId);
  const withheld = toolGrantsFor(targetId).deny.includes(DOJO_INSPECT) || isPrimaryAgent(targetId) || isHealerAgent(targetId);
  const db = getDb();
  let gains = false;
  let editRefused: R | null = null;
  db.exec('SAVEPOINT inspect_gain');
  try {
    editRefused = edit();
    forgetAccessGrants(targetId);
    gains = !held && holdsDojoInspect(targetId);
  } finally {
    db.exec('ROLLBACK TO inspect_gain');
    db.exec('RELEASE inspect_gain');
    forgetAccessGrants(targetId);
  }
  if (editRefused) return editRefused;
  if (!gains || (!withheld && mayGrantDojoInspect(editorId))) return null;
  return withheld
    ? 'Refused, and nothing was changed: this edit would give dojo_inspect back, but the owner withheld it from this agent; only the owner can give it back, from the dashboard.'
    : 'Refused, and nothing was changed: this edit would give this agent dojo_inspect, which only the owner or the main agent can grant.';
}

export const DOJO_INSPECT_REFUSAL = 'Permission denied: dojo_inspect is reserved for the main agent and the Healer, and for an agent whose own tool grant names it. The request was not performed. Ask the main agent if you need something looked up in the Dojo.';
