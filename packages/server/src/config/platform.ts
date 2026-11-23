// Platform config lookups: agent ids, names and identity, read from the config table and cached.

import { getDb } from '../db/connection.js';
import { setConfigValue } from './config-value.js';


let cache: Record<string, string> = {};
let cacheLoaded = false;

function loadCache(): void {
  try {
    const db = getDb();
    const rows = db.prepare("SELECT key, value FROM config WHERE key IN ('owner_name', 'primary_agent_id', 'primary_agent_name', 'pm_agent_id', 'pm_agent_name', 'trainer_agent_id', 'trainer_agent_name', 'healer_agent_id', 'healer_agent_name', 'dreamer_agent_id', 'dreamer_agent_name', 'setup_completed')").all() as Array<{ key: string; value: string }>;
    cache = {};
    for (const row of rows) {
      cache[row.key] = row.value;
    }
    cacheLoaded = true;
  } catch {
    // DB might not be ready yet
  }
}

function get(key: string, fallback: string): string {
  if (!cacheLoaded) loadCache();
  return cache[key] ?? fallback;
}

export function clearPlatformConfigCache(): void {
  cache = {};
  cacheLoaded = false;
}



/** The only default for the owner's name; ownerNameIsSet() tells this fallback from a real answer. */
export const OWNER_NAME_FALLBACK = 'User';

export function getOwnerName(): string {
  return get('owner_name', OWNER_NAME_FALLBACK);
}

/** Asked of the row, not the value: an owner really named "User" must not read as unset. */
export function ownerNameIsSet(): boolean {
  if (!cacheLoaded) loadCache();
  const v = cache['owner_name'];
  return typeof v === 'string' && v.trim() !== '';
}


export function getPrimaryAgentId(): string {
  return get('primary_agent_id', 'primary');
}

export function getPrimaryAgentName(): string {
  return get('primary_agent_name', 'Agent');
}


export function getPMAgentId(): string {
  return get('pm_agent_id', 'pm');
}

export function getPMAgentName(): string {
  return get('pm_agent_name', 'PM');
}


export function getTrainerAgentId(): string {
  return get('trainer_agent_id', 'trainer');
}

export function getTrainerAgentName(): string {
  return get('trainer_agent_name', 'Trainer');
}


// The spawn gate: an absent flag reads false, so nothing spawns. Not for deciding what the network may
// reach; that question fails the other way and lives in ./setup-state.ts (isPastFirstRun).
export function isSetupCompleted(): boolean {
  return get('setup_completed', 'false') === 'true';
}


export function setPlatformConfig(key: string, value: string): void {
  setConfigValue(key, value);
  clearPlatformConfigCache();
}


export function isPrimaryAgent(agentId: string | null | undefined): boolean {
  return !!agentId && agentId === getPrimaryAgentId();
}

export function isPMAgent(agentId: string): boolean {
  return agentId === getPMAgentId();
}

export function isTrainerAgent(agentId: string): boolean {
  return agentId === getTrainerAgentId();
}


export function getHealerAgentId(): string {
  return get('healer_agent_id', 'healer');
}

export function getHealerAgentName(): string {
  return get('healer_agent_name', 'Healer');
}

export function isHealerAgent(agentId: string): boolean {
  return agentId === getHealerAgentId();
}

export const holdsResetSession = (agentId: string): boolean => isPrimaryAgent(agentId) || isHealerAgent(agentId);

export function getDreamerAgentId(): string {
  return get('dreamer_agent_id', 'dreamer');
}

export function getDreamerAgentName(): string {
  return get('dreamer_agent_name', 'Dreamer');
}

export function isDreamerAgent(agentId: string): boolean {
  return agentId === getDreamerAgentId();
}


// Agent ids whose distilled vault memory is shared: the main agent and the Dreamer, which files memory on
// its behalf (one person per Dojo). OWNER_VAULT_AGENT_ID is not here: the recall scope adds owner entries.
export function getHouseholdAgentIds(): string[] {
  return [getPrimaryAgentId(), getDreamerAgentId()];
}

// Service agents whose conversations are pure platform mechanics. Their archives must never reach the
// Dreamer, which would re-ingest its own cycle messages in a growing loop. The primary is not one.
export function isSystemServiceAgent(agentId: string): boolean {
  return isDreamerAgent(agentId)
    || isTrainerAgent(agentId)
    || isHealerAgent(agentId)
    || isPMAgent(agentId);
}

/** Resolved IDs of every service agent. Used by bulk-cleanup queries. */
export function getSystemServiceAgentIds(): string[] {
  return [
    getDreamerAgentId(),
    getTrainerAgentId(),
    getHealerAgentId(),
    getPMAgentId(),
  ];
}

// Meta-role agents (PM, Healer, Dreamer) whose tasks are hidden from the tracker view by default, and
// for whom autoCreateAssignTask creates no tracker rows. The Trainer is deliberately not here.
export function getDashboardHiddenAgentIds(): Set<string> {
  const ids = new Set<string>();
  try {
    const db = getDb();
    const rows = db.prepare(
      `SELECT value FROM config WHERE key IN ('pm_agent_id', 'healer_agent_id', 'dreamer_agent_id')`,
    ).all() as Array<{ value: string }>;
    for (const r of rows) {
      if (r.value) ids.add(r.value);
    }
    // Matched by configured id only, never by display name: a user's own agent named Healer or Dreamer
    // must stay visible.
  } catch {
    /* DB may not be ready; return empty set so nothing gets hidden */
  }
  return ids;
}

export function isDashboardHiddenAgent(agentId: string): boolean {
  return getDashboardHiddenAgentIds().has(agentId);
}
