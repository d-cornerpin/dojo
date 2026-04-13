// ════════════════════════════════════════
// Platform Configuration Lookups
// De-hardcoded agent names and platform identity
// ════════════════════════════════════════

import { getDb } from '../db/connection.js';

// ── Cached lookups (invalidated on set) ──

let cache: Record<string, string> = {};
let cacheLoaded = false;

function loadCache(): void {
  try {
    const db = getDb();
    const rows = db.prepare("SELECT key, value FROM config WHERE key IN ('platform_name', 'owner_name', 'primary_agent_id', 'primary_agent_name', 'pm_agent_id', 'pm_agent_name', 'pm_agent_enabled', 'trainer_agent_id', 'trainer_agent_name', 'trainer_agent_enabled', 'imaginer_agent_id', 'imaginer_agent_name', 'imaginer_enabled', 'healer_agent_id', 'healer_agent_name', 'dreamer_agent_id', 'dreamer_agent_name', 'setup_completed')").all() as Array<{ key: string; value: string }>;
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

// ── Platform ──

export function getPlatformName(): string {
  return get('platform_name', 'DOJO Agent Platform');
}

// ── Owner ──

export function getOwnerName(): string {
  return get('owner_name', 'User');
}

// ── Primary Agent ──

export function getPrimaryAgentId(): string {
  return get('primary_agent_id', 'primary');
}

export function getPrimaryAgentName(): string {
  return get('primary_agent_name', 'Agent');
}

// ── PM Agent ──

export function getPMAgentId(): string {
  return get('pm_agent_id', 'pm');
}

export function getPMAgentName(): string {
  return get('pm_agent_name', 'PM');
}

export function isPMEnabled(): boolean {
  return get('pm_agent_enabled', 'true') === 'true';
}

// ── Trainer Agent ──

export function getTrainerAgentId(): string {
  return get('trainer_agent_id', 'trainer');
}

export function getTrainerAgentName(): string {
  return get('trainer_agent_name', 'Trainer');
}

export function isTrainerEnabled(): boolean {
  return get('trainer_agent_enabled', 'true') === 'true';
}

// ── Imaginer Agent ──

export function getImaginerAgentId(): string {
  return get('imaginer_agent_id', 'imaginer');
}

export function getImaginerAgentName(): string {
  return get('imaginer_agent_name', 'Imaginer');
}

export function isImaginerEnabled(): boolean {
  return get('imaginer_enabled', 'true') === 'true';
}

// ── Setup ──

export function isSetupCompleted(): boolean {
  return get('setup_completed', 'false') === 'true';
}

// ── Setters ──

export function setPlatformConfig(key: string, value: string): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')
  `).run(key, value, value);
  clearPlatformConfigCache();
}

// ── Bulk getter for dashboard ──

export function getAllPlatformConfig(): Record<string, string> {
  if (!cacheLoaded) loadCache();
  return { ...cache };
}

// ── Helper: is this agent the primary or PM? ──

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

// ── Healer Agent ──

export function getHealerAgentId(): string {
  return get('healer_agent_id', 'healer');
}

export function getHealerAgentName(): string {
  return get('healer_agent_name', 'Healer');
}

export function isHealerAgent(agentId: string): boolean {
  return agentId === getHealerAgentId();
}

// ── Dreamer Agent ──

export function getDreamerAgentId(): string {
  return get('dreamer_agent_id', 'dreamer');
}

export function getDreamerAgentName(): string {
  return get('dreamer_agent_name', 'Dreamer');
}

export function isDreamerAgent(agentId: string): boolean {
  return agentId === getDreamerAgentId();
}

export function isPermanentAgent(agentId: string): boolean {
  return isPrimaryAgent(agentId) || isPMAgent(agentId) || isTrainerAgent(agentId) || isHealerAgent(agentId) || isDreamerAgent(agentId);
}
