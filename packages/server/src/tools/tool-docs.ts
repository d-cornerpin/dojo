// ════════════════════════════════════════
// Tool Docs Loading & Session State
// Tracks which tools have been loaded per agent session
// so the next API call can include them in the tools array.
// ════════════════════════════════════════

import { createLogger } from '../logger.js';
import { readToolDoc } from './index-generator.js';
import type { ToolDefinition } from '../agent/tools.js';

const logger = createLogger('tool-docs');

// ── Always-loaded defaults ──

// Base tools always loaded for every agent.
// load_tool_docs is the lookup mechanism itself and must always be present.
// complete_task is how sub-agents signal they are done.
// get_current_time is cheap and agents need it constantly for scheduling.
export const DEFAULT_ALWAYS_LOADED_TOOLS = [
  'load_tool_docs',
  'complete_task',
  'get_current_time',
];

// Primary agent: needs file/exec + tracker + vault + communication basics.
// These are the tools the primary agent uses on nearly every meaningful turn.
export const PRIMARY_AGENT_ALWAYS_LOADED = [
  ...DEFAULT_ALWAYS_LOADED_TOOLS,
  'exec',
  'file_read',
  'file_write',
  'tracker_list_active',
  'tracker_create_task',
  'tracker_update_status',
  'vault_search',
  'vault_remember',
  'send_to_agent',
  'list_agents',
  'imessage_send',
  'image_create',
];

// PM agent: tracker-focused, monitors tasks and sends messages to other agents.
export const PM_AGENT_ALWAYS_LOADED = [
  ...DEFAULT_ALWAYS_LOADED_TOOLS,
  'tracker_list_active',
  'tracker_get_task',
  'tracker_update_status',
  'tracker_add_notes',
  'send_to_agent',
  'list_agents',
];

// Dreamer agent: vault-focused, extracts knowledge from conversation archives.
export const DREAMER_AGENT_ALWAYS_LOADED = [
  ...DEFAULT_ALWAYS_LOADED_TOOLS,
  'vault_remember',
  'vault_search',
  'vault_forget',
  'vault_describe',
  'send_to_agent',
];

// Trainer agent: technique-focused.
export const TRAINER_AGENT_ALWAYS_LOADED = [
  ...DEFAULT_ALWAYS_LOADED_TOOLS,
  'list_techniques',
  'save_technique',
  'update_technique',
  'publish_technique',
  'send_to_agent',
  'exec',
  'file_read',
  'file_write',
];

// Imaginer agent: doesn't run through the LLM runtime at all — its
// image model gets called directly by the image_create tool's async
// background task. The always-loaded set is minimal just in case the
// runtime tries to assemble tools for it (which shouldn't happen, but
// being safe). Imaginer never calls tools because image models don't
// support tool calling.
export const IMAGINER_AGENT_ALWAYS_LOADED = [
  ...DEFAULT_ALWAYS_LOADED_TOOLS,
];

// Sub-agents (ronin / apprentice / freelance): sensible defaults for common work.
// These tools are used by most sub-agents regardless of specific task.
// Permission filtering will strip any tools the sub-agent lacks permission for.
export const SUB_AGENT_ALWAYS_LOADED = [
  ...DEFAULT_ALWAYS_LOADED_TOOLS,
  'exec',
  'file_read',
  'file_write',
  'send_to_agent',
  'vault_search',
  'tracker_update_status',
  'image_create',
];

// ── Per-session tool loading state ──
// Maps agent ID -> set of tool names that have been loaded via load_tool_docs in this session

const sessionLoadedTools: Map<string, Set<string>> = new Map();

export function getSessionLoadedTools(agentId: string): Set<string> {
  return sessionLoadedTools.get(agentId) ?? new Set();
}

export function markToolsLoaded(agentId: string, toolNames: string[]): void {
  let loaded = sessionLoadedTools.get(agentId);
  if (!loaded) {
    loaded = new Set();
    sessionLoadedTools.set(agentId, loaded);
  }
  for (const name of toolNames) {
    loaded.add(name);
  }
}

export function clearSessionLoadedTools(agentId: string): void {
  sessionLoadedTools.delete(agentId);
}

// ── Resolve which tools get sent in the API tools parameter ──

/**
 * Given an agent's permitted tools and their always-loaded list,
 * return only the tools that should actually be sent in the API call.
 * This includes:
 * - All always-loaded tools
 * - Tools loaded via load_tool_docs earlier in the session
 * - load_tool_docs itself (meta-tool, always available)
 */
export function filterToolsForApiCall(
  agentId: string,
  allPermittedTools: ToolDefinition[],
  alwaysLoaded: string[],
): ToolDefinition[] {
  const loaded = getSessionLoadedTools(agentId);
  const alwaysLoadedSet = new Set(alwaysLoaded);
  alwaysLoadedSet.add('load_tool_docs'); // Always include the meta-tool

  return allPermittedTools.filter(t =>
    alwaysLoadedSet.has(t.name) || loaded.has(t.name)
  );
}

// ── Execute load_tool_docs ──

/**
 * Handle a load_tool_docs call. Marks the requested tools as loaded
 * for this session and returns their full documentation.
 */
export function executeLoadToolDocs(agentId: string, toolNames: string[]): string {
  if (!Array.isArray(toolNames) || toolNames.length === 0) {
    return 'Error: tools parameter must be a non-empty array of tool names';
  }

  const results: string[] = [];
  const loaded: string[] = [];
  const notFound: string[] = [];

  for (const name of toolNames) {
    const doc = readToolDoc(name);
    if (doc) {
      results.push(doc);
      loaded.push(name);
    } else {
      notFound.push(name);
    }
  }

  if (loaded.length > 0) {
    markToolsLoaded(agentId, loaded);
    logger.info('Tool docs loaded into session', { agentId, tools: loaded });
  }

  let output = '';
  if (results.length > 0) {
    output += `Loaded documentation for ${loaded.length} tool(s). These tools are now available to call directly.\n\n`;
    output += results.join('\n\n---\n\n');
  }
  if (notFound.length > 0) {
    output += `\n\nTools not found: ${notFound.join(', ')}`;
  }

  return output || 'No valid tool names provided.';
}

// ── Always-loaded tools lookup per agent (from DB) ──

import { getDb } from '../db/connection.js';

// Resolve which always-loaded tool set to use for a given agent. This runs
// synchronously at call time, so we can't `await import()`. Instead we read
// the agent's role directly from the DB (one cheap query) and match against
// known system agent IDs and classifications. The old `require()` approach
// silently failed in ESM, causing every agent to fall back to the 3-tool
// default set — meaning they had to `load_tool_docs` before every single
// tool use, which was slow and model-dependent.
function getDefaultForAgent(agentId: string): string[] {
  try {
    const db = getDb();

    // Check system agent IDs from config table (avoids importing platform.ts)
    const configRows = db.prepare(
      "SELECT key, value FROM config WHERE key IN ('primary_agent_id', 'pm_agent_id', 'trainer_agent_id', 'imaginer_agent_id')",
    ).all() as Array<{ key: string; value: string }>;
    const configMap: Record<string, string> = {};
    for (const r of configRows) configMap[r.key] = r.value;

    if (agentId === (configMap['primary_agent_id'] ?? 'kevin')) return PRIMARY_AGENT_ALWAYS_LOADED;
    if (agentId === (configMap['pm_agent_id'] ?? 'pm')) return PM_AGENT_ALWAYS_LOADED;
    if (agentId === (configMap['trainer_agent_id'] ?? 'trainer')) return TRAINER_AGENT_ALWAYS_LOADED;
    if (agentId === (configMap['imaginer_agent_id'] ?? 'imaginer')) return IMAGINER_AGENT_ALWAYS_LOADED;

    // Non-system agents: check by name (Dreamer) or classification
    const row = db.prepare('SELECT name, classification FROM agents WHERE id = ?').get(agentId) as
      | { name: string; classification: string }
      | undefined;
    if (row?.name === 'Dreamer') return DREAMER_AGENT_ALWAYS_LOADED;
    if (row && ['ronin', 'apprentice', 'freelance'].includes(row.classification)) {
      return SUB_AGENT_ALWAYS_LOADED;
    }
  } catch { /* DB not ready yet — use minimal default */ }
  return DEFAULT_ALWAYS_LOADED_TOOLS;
}

export function getAgentAlwaysLoadedTools(agentId: string): string[] {
  try {
    const db = getDb();
    const row = db.prepare('SELECT always_loaded_tools FROM agents WHERE id = ?').get(agentId) as { always_loaded_tools: string | null } | undefined;
    if (row?.always_loaded_tools) {
      try {
        const parsed = JSON.parse(row.always_loaded_tools);
        if (Array.isArray(parsed)) return parsed;
      } catch { /* ignore */ }
    }
  } catch { /* column may not exist yet */ }
  return getDefaultForAgent(agentId);
}
