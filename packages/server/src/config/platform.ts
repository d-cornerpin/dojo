// Platform config lookups: agent ids, names and identity, read from the config table and cached.

import { getDb } from '../db/connection.js';


let cache: Record<string, string> = {};
let cacheLoaded = false;

// Memoized household ids; cleared with the main cache in clearPlatformConfigCache.
let householdCache: string[] | null = null;

function loadCache(): void {
  try {
    const db = getDb();
    const rows = db.prepare("SELECT key, value FROM config WHERE key IN ('platform_name', 'owner_name', 'primary_agent_id', 'primary_agent_name', 'pm_agent_id', 'pm_agent_name', 'trainer_agent_id', 'trainer_agent_name', 'imaginer_agent_id', 'imaginer_agent_name', 'healer_agent_id', 'healer_agent_name', 'dreamer_agent_id', 'dreamer_agent_name', 'household_agent_ids', 'setup_completed')").all() as Array<{ key: string; value: string }>;
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
  householdCache = null;
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


export function getImaginerAgentId(): string {
  return get('imaginer_agent_id', 'imaginer');
}

export function getImaginerAgentName(): string {
  return get('imaginer_agent_name', 'Imaginer');
}


// The spawn gate: an absent flag reads false, so nothing spawns. Not for deciding what the network may
// reach; that question fails the other way and lives in ./setup-state.ts (isPastFirstRun).
export function isSetupCompleted(): boolean {
  return get('setup_completed', 'false') === 'true';
}


export function setPlatformConfig(key: string, value: string): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')
  `).run(key, value, value);
  clearPlatformConfigCache();
}


export function getAllPlatformConfig(): Record<string, string> {
  if (!cacheLoaded) loadCache();
  return { ...cache };
}


export function isPrimaryAgent(agentId: string): boolean {
  return agentId === getPrimaryAgentId();
}

export function isPMAgent(agentId: string): boolean {
  return agentId === getPMAgentId();
}

export function isTrainerAgent(agentId: string): boolean {
  return agentId === getTrainerAgentId();
}

export function isImaginerAgent(agentId: string): boolean {
  return agentId === getImaginerAgentId();
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


export function getDreamerAgentId(): string {
  return get('dreamer_agent_id', 'dreamer');
}

export function getDreamerAgentName(): string {
  return get('dreamer_agent_name', 'Dreamer');
}

export function isDreamerAgent(agentId: string): boolean {
  return agentId === getDreamerAgentId();
}


export const HOUSEHOLD_AGENT_IDS_KEY = 'household_agent_ids';

// Agent ids whose distilled vault memory is shared across the household: the stored list (or the primary
// alone when it is absent or invalid), plus the Dreamer, which files memory on the primaries' behalf.
// Every other agent is excluded. OWNER_VAULT_AGENT_ID is not here: the recall scope adds owner entries
// separately, and folding them in would make a non-member's own scope household.
export function getHouseholdAgentIds(): string[] {
  if (householdCache) return householdCache;
  const ids = new Set<string>();
  const raw = get(HOUSEHOLD_AGENT_IDS_KEY, '');
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const v of parsed) {
          if (typeof v === 'string' && v.trim().length > 0) ids.add(v);
        }
      }
    } catch {
      /* malformed row -> fall back to the primary below */
    }
  }
  if (ids.size === 0) ids.add(getPrimaryAgentId());
  ids.add(getDreamerAgentId());
  householdCache = [...ids];
  return householdCache;
}

// Service agents whose conversations are pure platform mechanics. Their archives must never reach the
// Dreamer, which would re-ingest its own cycle messages in a growing loop. The primary is not one.
export function isSystemServiceAgent(agentId: string): boolean {
  return isDreamerAgent(agentId)
    || isTrainerAgent(agentId)
    || isHealerAgent(agentId)
    || isPMAgent(agentId)
    || isImaginerAgent(agentId);
}

/** Resolved IDs of every service agent. Used by bulk-cleanup queries. */
export function getSystemServiceAgentIds(): string[] {
  return [
    getDreamerAgentId(),
    getTrainerAgentId(),
    getHealerAgentId(),
    getPMAgentId(),
    getImaginerAgentId(),
  ];
}

// Meta-role agents (PM, Healer, Dreamer) whose tasks are hidden from the tracker view by default, and
// for whom autoCreateAssignTask creates no tracker rows. Trainer and Imaginer are deliberately not here.
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
