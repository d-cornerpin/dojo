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
  'convert_time',
  'channel_inspect',
];

// Primary agent: needs file/exec + tracker + vault + communication basics.
// These are the tools the primary agent uses on nearly every meaningful turn.
// recall_recent_thread is always-loaded as a memory-recovery affordance, when
// the agent feels disoriented (post-compaction, post-model-switch), the tool
// must be reachable in one step, not "scan the index → load_tool_docs → call."
export const PRIMARY_AGENT_ALWAYS_LOADED = [
  ...DEFAULT_ALWAYS_LOADED_TOOLS,
  // The destructive-gate approval tool must be callable the moment an
  // approval request wakes the primary (no load_tool_docs round-trip).
  'approve_destructive_action',
  'exec',
  'file_read',
  'file_write',
  'file_append',
  'tracker_list_active',
  'tracker_create_task',
  'tracker_create_project',
  'tracker_update_status',
  'reminder_create',
  'vault_search',
  'vault_remember',
  'send_to_agent',
  'list_agents',
  'imessage_send',
  'imessage_list_contacts',
  // v2.9.18: Twilio SMS is daily-use for primary (mirror of iMessage).
  // Voice tools are NOT pre-loaded - phone calls are rare enough that
  // the load_tool_docs round-trip is cheap when actually needed.
  'sms_send',
  'image_create',
  'show_to_user',
  // Pre-loaded so "show me your screen" works in one call, without it the
  // model reaches for screen_screenshot (which only screenshots for itself) instead.
  'screen_broadcast',
  // Pre-loaded so "show me X in the canvas" works in one call (owner .19
  // transcript 2026-07-23: without it the model improvised with exec/file
  // tools for six minutes, renamed a file on the owner's Desktop chasing an
  // auto-open, and the untracked-work floor then bureaucratized the flail
  // into a tracker project. Same disease screen_broadcast's entry cures).
  'canvas_render',
  'recall_recent_thread',
  // RC-2: the primary is the agent that gets OPEN LOOPS injected, so the tool that
  // retires one must be callable in a single step (no load_tool_docs round-trip)
  // the moment it delivers an answer.
  'loop_resolve',
  'scratchpad_set',
  'technique_read',
  // v2.9.16: DOJO contacts store. Primary uses these on nearly every
  // person-mentioning turn (lookup before sending, append-observation
  // after a conversation). Pre-loading avoids a load_tool_docs
  // round-trip on what should be a one-call flow.
  'contact_search',
  'contact_remember',
  'contact_get',
];

// PM agent: tracker-focused, monitors tasks and sends messages to other agents.
// Edit tools are pre-loaded because the engine fires rename requests at PM on
// every multistep auto-create, making PM round-trip through load_tool_docs
// each time would burn a turn for what should be a single-call rename.
export const PM_AGENT_ALWAYS_LOADED = [
  ...DEFAULT_ALWAYS_LOADED_TOOLS,
  'tracker_list_active',
  'tracker_get_status',
  'tracker_update_status',
  'tracker_add_notes',
  'tracker_edit_task',
  'tracker_edit_project',
  'tracker_close_project',
  'tracker_validate',
  'tracker_retask',
  'send_to_agent',
  'list_agents',
  // v2.9.20: validator dereference tools. PM-SOUL tells PM to verify
  // evidence by dereferencing vault entry IDs and file paths before
  // rejecting work as "evidence insufficient." Those tools have to be
  // one call away, not gated behind load_tool_docs, or PM falls back
  // to the lazy reject pattern that triggered the JJ-report incident.
  'vault_search',
  'vault_get',
  'file_read',
  // FA-PT5: PM-SOUL ("# Vault, Review Continuity") tells the PM to
  // vault_remember important project state/decisions/blockers each cycle and
  // vault_search before each review. vault_search was preloaded, vault_remember
  // was not, so the save half of that per-cycle instruction cost a load_tool_docs
  // round-trip.
  'vault_remember',
];

// Dreamer agent: vault-focused, extracts knowledge from conversation archives.
// v2.9.16, also routes person-as-entity observations into the DOJO
// contacts store and persists credentials that appear verbatim in
// archives. Contact verbs: append-and-read only (no forget/update/get -
// the owner edits via dashboard). Credential verbs: list (check for
// duplicates) and add (when the value is in the archive); no get (no
// value reads needed during curation), no update/delete (mutation is
// explicit user action).
export const DREAMER_AGENT_ALWAYS_LOADED = [
  ...DEFAULT_ALWAYS_LOADED_TOOLS,
  'vault_remember',
  'vault_search',
  'vault_forget',
  'vault_update',
  'contact_remember',
  'contact_search',
  'contacts_overview',
  'credential_list',
  'credential_add',
  'send_to_agent',
];

// Trainer agent: technique-focused. Tracker tools are pre-loaded because the
// trainer drives multi-step technique builds (test, refine, publish) and gets
// stuck mid-flow if it can't create or close its own tasks without a
// round-trip through load_tool_docs.
export const TRAINER_AGENT_ALWAYS_LOADED = [
  ...DEFAULT_ALWAYS_LOADED_TOOLS,
  'list_techniques',
  'save_technique',
  'update_technique',
  'publish_technique',
  // FA-PT5: TRAINER-SOUL's "# Importing a Technique" runbook ends every import
  // with technique_set_placeholder (step 4, fill each scrubbed secret) then
  // technique_finalize then publish_technique (step 5). publish_technique was
  // preloaded but its two runbook predecessors were not, so each import spent a
  // load_tool_docs round-trip mid-flow on the floor model. (The SOUL's
  // credential_add instruction is a separate PERMISSION gap, not a preload one:
  // it is absent from the Trainer's tools_policy.allow, tracked under FA-X4.)
  'technique_set_placeholder',
  'technique_finalize',
  'send_to_agent',
  'exec',
  'file_read',
  'file_write',
  'show_to_user',
  'tracker_list_active',
  'tracker_create_task',
  'tracker_create_project',
  'tracker_update_status',
  'tracker_add_notes',
  'tracker_edit_task',
  'tracker_edit_project',
  'tracker_close_project',
];

// Healer agent: diagnostic + agent management for injury recovery.
// FA-PT5: HEALER-SOUL is a shell/SQL runbook built on exec(sqlite3 ...),
// file_read, and file_list ("When unsure where a file lives, `file_list` the
// parent"; the Diagnostic Runbook is entirely exec + file_read). Those three
// were NOT preloaded, so on turn 1 of every diagnostic cycle the floor model was
// told to run them but neither was in the API tools array, forcing a
// load_tool_docs round-trip (or a give-up) before it could investigate at all.
// PRIMARY/TRAINER/SUB_AGENT all preload exec+file_read; the Healer now does too.
export const HEALER_AGENT_ALWAYS_LOADED = [
  ...DEFAULT_ALWAYS_LOADED_TOOLS,
  'list_agents',
  'send_to_agent',
  'reset_session',
  'imessage_send',
  'exec',
  'file_read',
  'file_list',
  'vault_search',
  'vault_remember',
  'healer_log_action',
  'healer_propose',
];

// Imaginer agent: doesn't run through the LLM runtime at all, its
// image model gets called directly by the image_create tool's async
// background task. The always-loaded set is minimal just in case the
// runtime tries to assemble tools for it (which shouldn't happen, but
// being safe). Imaginer never calls tools because image models don't
// support tool calling.
export const IMAGINER_AGENT_ALWAYS_LOADED = [
  ...DEFAULT_ALWAYS_LOADED_TOOLS,
];

// Sub-agents (ronin / apprentice): sensible defaults for common work.
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
  'show_to_user',
  'recall_recent_thread',
  'technique_read',
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
import { getPrimaryAgentId } from '../config/platform.js';

// Resolve which always-loaded tool set to use for a given agent. This runs
// synchronously at call time, so we can't `await import()`. Instead we read
// the agent's role directly from the DB (one cheap query) and match against
// known system agent IDs and classifications. The old `require()` approach
// silently failed in ESM, causing every agent to fall back to the 3-tool
// default set, meaning they had to `load_tool_docs` before every single
// tool use, which was slow and model-dependent.
function getDefaultForAgent(agentId: string): string[] {
  try {
    const db = getDb();

    // Check system agent IDs from config table. The primary id falls back to
    // the platform config default (name-free) rather than a hardcoded id.
    const configRows = db.prepare(
      "SELECT key, value FROM config WHERE key IN ('primary_agent_id', 'pm_agent_id', 'trainer_agent_id', 'imaginer_agent_id')",
    ).all() as Array<{ key: string; value: string }>;
    const configMap: Record<string, string> = {};
    for (const r of configRows) configMap[r.key] = r.value;

    if (agentId === (configMap['primary_agent_id'] ?? getPrimaryAgentId())) return PRIMARY_AGENT_ALWAYS_LOADED;
    if (agentId === (configMap['pm_agent_id'] ?? 'pm')) return PM_AGENT_ALWAYS_LOADED;
    if (agentId === (configMap['trainer_agent_id'] ?? 'trainer')) return TRAINER_AGENT_ALWAYS_LOADED;
    if (agentId === (configMap['imaginer_agent_id'] ?? 'imaginer')) return IMAGINER_AGENT_ALWAYS_LOADED;

    // Check healer by config (key may not exist on older installs)
    const healerRow = db.prepare("SELECT value FROM config WHERE key = 'healer_agent_id'").get() as { value: string } | undefined;
    if (healerRow && agentId === healerRow.value) return HEALER_AGENT_ALWAYS_LOADED;

    // Non-system agents: check by name (Dreamer) or classification
    const row = db.prepare('SELECT name, classification FROM agents WHERE id = ?').get(agentId) as
      | { name: string; classification: string }
      | undefined;
    if (row?.name === 'Dreamer') return DREAMER_AGENT_ALWAYS_LOADED;
    if (row && ['ronin', 'apprentice'].includes(row.classification)) {
      return SUB_AGENT_ALWAYS_LOADED;
    }
  } catch { /* DB not ready yet, use minimal default */ }
  return DEFAULT_ALWAYS_LOADED_TOOLS;
}

export function getAgentAlwaysLoadedTools(agentId: string): string[] {
  try {
    const db = getDb();
    const row = db.prepare('SELECT always_loaded_tools FROM agents WHERE id = ?').get(agentId) as { always_loaded_tools: string | null } | undefined;
    if (row?.always_loaded_tools) {
      try {
        const parsed = JSON.parse(row.always_loaded_tools);
        if (Array.isArray(parsed)) {
          // D13: A2A floor. A sub-agent spawned with a custom always_loaded_tools
          // set that omits send_to_agent physically CANNOT reply on the A2A thread
          // it was asked a QUESTION on, so ask -> park -> (no possible reply)
          // fails closed to permanent silence, even though the thread footer tells
          // it to "reply with send_to_agent". Always union in the reply tool.
          return parsed.includes('send_to_agent') ? parsed : [...parsed, 'send_to_agent'];
        }
      } catch { /* ignore */ }
    }
  } catch { /* column may not exist yet */ }
  return getDefaultForAgent(agentId);
}
