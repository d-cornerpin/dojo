// Tool docs loading and the always-loaded tool sets. Session state lives in `tool-session-set.ts`.

import { createLogger } from '../logger.js';
import { readToolDoc } from './tool-doc-read.js';
import { resolveToolAlias } from './aliases.js';
import {
  LOAD_TOOL_DOCS_MAX_PER_CALL, evictionNote, forgetSessionLoadedTools, getSessionLoadedTools,
  loadToolDocsOverflowRefusal, markToolsLoaded,
} from './tool-session-set.js';
import type { ToolDefinition } from '../agent/tools/types.js';
import { sessionBoundaryText } from '../memory/session-boundary.js';

const logger = createLogger('tool-docs');

/** The name a recorded call resolves to today (requested names are canonicalized, so a replay must be). */
function canonicalToolName(name: string): string {
  const resolved = resolveToolAlias(name, {});
  return resolved.tombstone ? name : resolved.name;
}


export const DEFAULT_ALWAYS_LOADED_TOOLS = [
  'load_tool_docs',
  'complete_task',
  'get_current_time',
  'convert_time',
  'channel_inspect',
  'tool_result_read',   // a long result's pointer names it, so it is one call away for every agent
];

// Primary agent: its every-turn tools; `recall_recent_thread` is one step away for memory recovery.
export const PRIMARY_AGENT_ALWAYS_LOADED = [
  ...DEFAULT_ALWAYS_LOADED_TOOLS,
  // The approval tool must be callable the moment an approval request wakes the primary.
  'approve_destructive_action',
  'exec',
  'file_read',
  'file_write',
  'file_append',
  // `work_open` and `work_update` must be one call away: a `load_tool_docs` round-trip is the friction
  // that makes a weak model skip the tracker.
  'work_open',
  'work_update',
  'vault_search',
  'vault_remember',
  'send_to_agent',
  'list_agents',
  'imessage_send',
  'imessage_list_contacts',
  'sms_send',
  'image_create',
  'show_to_user',
  // Pre-loaded so "show me your screen" works in one call (`screen_screenshot` only screenshots for itself).
  'screen_broadcast',
  // Pre-loaded so "show me X in the canvas" works in one call; without it the model improvises with exec.
  'canvas_render',
  'recall_recent_thread',
  // The primary gets the OPEN WORK block, so commitments are one step away (recorded when promised).
  // `work_note` is deliberately absent: it would widen the cached prefix.
  'work_close_request',
  'scratchpad_set',
  'technique_read',
  'contact_search',
  'contact_remember',
  'contact_get',
  'dojo_inspect',
];

// PM agent: tracker-focused; edit tools are pre-loaded because the engine fires rename requests at it.
export const PM_AGENT_ALWAYS_LOADED = [
  ...DEFAULT_ALWAYS_LOADED_TOOLS,
  // Pre-loading `work_update` does not widen the PM's authority: `pmMayCall` in tracker/pm-agent.ts still
  // refuses the operations the PM may not do, at the executor.
  'work_update',
  'work_note',
  'work_validate',
  'send_to_agent',
  'list_agents',
  // templates/PM-SOUL.md has the PM vault_search before each review and vault_remember its state.
  'vault_search',
  'vault_get',
  'file_read',
  'vault_remember',
];

// Dreamer agent: vault-focused. Contact verbs are append-and-read only (the owner edits via the
// dashboard); credential verbs are list (duplicate check) and add, never get, update or delete.
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

// Trainer agent: technique-focused; tracker tools are pre-loaded because it drives multi-step builds.
export const TRAINER_AGENT_ALWAYS_LOADED = [
  ...DEFAULT_ALWAYS_LOADED_TOOLS,
  'list_techniques',
  'save_technique',
  'update_technique',
  'publish_technique',
  // templates/TRAINER-SOUL.md's import runbook ends with these two, then publish_technique.
  'technique_set_placeholder',
  'technique_finalize',
  'send_to_agent',
  'exec',
  'file_read',
  'file_write',
  'show_to_user',
  'work_open',
  'work_update',
  'work_note',
];

// Healer agent: its runbook is exec(sqlite3 ...), file_read and file_list, so all three are pre-loaded.
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
  'dojo_inspect',
];

// Sub-agents (ronin / apprentice): common defaults; a listed tool the agent may not call is dropped.
export const SUB_AGENT_ALWAYS_LOADED = [
  ...DEFAULT_ALWAYS_LOADED_TOOLS,
  'exec',
  'file_read',
  'file_write',
  'send_to_agent',
  'vault_search',
  // `work_open` lets a sub-agent create a task instead of inventing an id; its large declaration is
  // accepted because the static list keeps the per-agent prefix byte-stable for the prompt cache.
  'work_open',
  'work_update',
  'image_create',
  'show_to_user',
  'recall_recent_thread',
  'technique_read',
];

export { getSessionLoadedTools, markToolsLoaded } from './tool-session-set.js';

export function clearSessionLoadedTools(agentId: string): void {
  forgetSessionLoadedTools(agentId);
  // A reset is a decision to forget: leaving the rehydration flag set stops re-importing pre-reset tools.
  rehydratedAgents.add(agentId);
}

// Restart rehydration: the session set is lost on restart, so it is rebuilt once per agent per process
// by the turn owner, never inside assembly (a pure read; a mutation there breaks the cached prefix).
const rehydratedAgents = new Set<string>();

// One row per `load_tool_docs` call, read once per agent per process. The cap is a runaway guard far
// above any session's real count, and the newest rows are kept (the session ceiling evicts front-first).
const LOAD_SEQUENCE_CALL_CAP = 500;

/**
 * Re-import the tools this agent had loaded, once per process (idempotent), at the top of a turn
 * (`agent/v2/steps/preflight/counterparty-and-record.ts`), never from an assembly. Replays the recorded
 * `load_tool_docs` calls oldest-first, reproducing the pre-restart array byte for byte.
 */
export function rehydrateSessionToolsFromHistory(agentId: string, recentLimit = 40): void {
  if (rehydratedAgents.has(agentId)) return;
  rehydratedAgents.add(agentId);
  try {
    const db = getDb();
    // Respect the session boundary: a restart after a reset must not hand back a forgotten session.
    const boundary = sessionBoundaryText(agentId);

    const ordered: string[] = [];
    const placed = new Set<string>();
    const place = (name: string) => {
      if (typeof name !== 'string' || placed.has(name)) return;
      placed.add(name);
      ordered.push(name);
    };

    const loadRows = ((boundary
      ? db.prepare(
          `SELECT content FROM messages
            WHERE agent_id = ? AND role = 'assistant' AND content LIKE '%load_tool_docs%'
              AND created_at >= (unixepoch(?) * 1000)
            ORDER BY created_at DESC, rowid DESC LIMIT ?`,
        ).all(agentId, boundary, LOAD_SEQUENCE_CALL_CAP)
      : db.prepare(
          `SELECT content FROM messages
            WHERE agent_id = ? AND role = 'assistant' AND content LIKE '%load_tool_docs%'
            ORDER BY created_at DESC, rowid DESC LIMIT ?`,
        ).all(agentId, LOAD_SEQUENCE_CALL_CAP)) as Array<{ content: string }>).reverse();

    for (const r of loadRows) {
      if (typeof r.content !== 'string') continue;
      let parsed: unknown;
      try { parsed = JSON.parse(r.content); } catch { continue; }
      if (!Array.isArray(parsed)) continue;
      for (const block of parsed as Array<Record<string, unknown>>) {
        if (block?.type !== 'tool_use' || typeof block.name !== 'string') continue;
        if (canonicalToolName(block.name) !== 'load_tool_docs') continue;
        const requested = (block.input as { tools?: unknown } | undefined)?.tools;
        if (!Array.isArray(requested)) continue;
        for (const raw of requested) if (typeof raw === 'string') place(canonicalToolName(raw));
      }
    }
    const fromLoads = ordered.length;

    // Names it CALLED whose load is not on record (an older conversation, an archived session) still
    // come back, appended behind the replayed sequence so they never move a tool the record placed.
    const calledRows = db.prepare(
      "SELECT content FROM messages WHERE agent_id = ? AND role = 'assistant' ORDER BY created_at DESC, rowid DESC LIMIT ?",
    ).all(agentId, recentLimit) as Array<{ content: string }>;
    calledRows.reverse(); // the query is a newest-first recency window; call order is oldest-first
    for (const r of calledRows) {
      if (typeof r.content !== 'string' || !r.content.includes('tool_use')) continue;
      try {
        const parsed = JSON.parse(r.content);
        if (!Array.isArray(parsed)) continue;
        for (const block of parsed) {
          if (block?.type === 'tool_use' && typeof block.name === 'string') place(canonicalToolName(block.name));
        }
      } catch { /* skip */ }
    }

    if (ordered.length > 0) {
      markToolsLoaded(agentId, ordered);
      logger.info('Rehydrated session tool docs from history after restart', {
        agentId, count: ordered.length, fromLoadSequence: fromLoads,
      });
    }
  } catch { /* best effort: a missing table must not break a turn */ }
}

export function resetRehydrationForTests(agentId?: string): void {
  if (agentId) rehydratedAgents.delete(agentId);
  else rehydratedAgents.clear();
}


/**
 * The tools array is a declared prefix lane: always-loaded tools come first in declared order, then
 * session-loaded extras, and `model.ts` puts `cache_control` on the last always-loaded tool, so a
 * mid-session load appends behind the breakpoint instead of rewriting the cached prefix.
 */
export interface PartitionedTools {
  tools: ToolDefinition[];
  alwaysLoaded: ToolDefinition[];
  sessionExtras: ToolDefinition[];
  /** Index in `tools` of the last always-loaded tool, where `cache_control` goes; `-1` if there is none. */
  cacheBreakpointIndex: number;
}

/** The tools to send: the always-loaded head in declared order (first wins), then the load order. */
export function partitionToolsForApiCall(
  agentId: string,
  allPermittedTools: ToolDefinition[],
  alwaysLoaded: string[],
): PartitionedTools {
  const loaded = getSessionLoadedTools(agentId);
  const alwaysLoadedSet = new Set(alwaysLoaded);
  alwaysLoadedSet.add('load_tool_docs'); // Always include the meta-tool

  const byName = new Map<string, ToolDefinition>();
  for (const t of allPermittedTools) if (!byName.has(t.name)) byName.set(t.name, t);

  const headNames: string[] = [];
  const seen = new Set<string>();
  for (const name of [...alwaysLoaded, 'load_tool_docs']) {
    if (seen.has(name)) continue;
    seen.add(name);
    if (byName.has(name)) headNames.push(name);
  }
  const head = headNames.map((n) => byName.get(n) as ToolDefinition);

  // The tail: everything else the session loaded, in LOAD order (a JS Set keeps insertion order), so a
  // later load never shifts the bytes of an earlier one and the provider's prefix cache holds.
  const tail = [...loaded]
    .filter((name) => !seen.has(name) && byName.has(name))
    .map((name) => byName.get(name) as ToolDefinition);

  return {
    tools: [...head, ...tail],
    alwaysLoaded: head,
    sessionExtras: tail,
    cacheBreakpointIndex: head.length > 0 ? head.length - 1 : -1,
  };
}

/** The measured tool payload in tokens: the array `model.ts` sends, so the budget reserves the wire's size.
 *  The surface is imported dynamically: statically it closes a cycle back through `memory/assembler.ts`. */
export async function measureAgentToolPayloadTokens(agentId: string): Promise<number> {
  const { getFilteredTools } = await import('../agent/tools/surface.js');
  const { estimateTokens } = await import('../memory/budget.js');
  const allPermitted = getFilteredTools(agentId);
  const alwaysLoaded = getAgentAlwaysLoadedTools(agentId);
  const part = partitionToolsForApiCall(agentId, allPermitted, alwaysLoaded);
  return estimateTokens(JSON.stringify(part.tools));
}

export function filterToolsForApiCall(
  agentId: string,
  allPermittedTools: ToolDefinition[],
  alwaysLoaded: string[],
): ToolDefinition[] {
  return partitionToolsForApiCall(agentId, allPermittedTools, alwaysLoaded).tools;
}


/**
 * The registry's own account of a tool, for a box whose generated manual never landed: the description
 * and `input_schema` the model gets on the wire, with a first line saying it is not a manual. `null` when
 * the registry has no entry. The registry is an argument, not an import, to stay out of the registry graph.
 */
function registryManual(name: string, registry: readonly ToolDefinition[]): string | null {
  const d = registry.find((t) => t.name === name);
  if (!d) return null;
  const schema = (d as { input_schema?: unknown }).input_schema;
  return `# ${name}\n\n`
    + '⚠ No generated manual is present on this install, so this is the LIVE REGISTRY entry — '
    + 'the same description and argument schema the model is given on the wire. It is complete '
    + 'enough to call the tool correctly, and it carries none of the worked examples or failure '
    + 'notes a generated manual would.\n\n'
    + `${d.description}\n\n`
    + `## Arguments\n\n\`\`\`json\n${JSON.stringify(schema, null, 2)}\n\`\`\``;
}

export function executeLoadToolDocs(
  agentId: string,
  toolNames: string[],
  /** The tools this agent may call; empty by default, so a caller with no registry gets an honest empty answer. */
  registry: readonly ToolDefinition[] = [],
): string {
  if (!Array.isArray(toolNames) || toolNames.length === 0) {
    return 'Error: tools parameter must be a non-empty array of tool names';
  }
  // The handler refuses the RAW array first (`cat/meta.ts`); both read `LOAD_TOOL_DOCS_MAX_PER_CALL`.
  if (toolNames.length > LOAD_TOOL_DOCS_MAX_PER_CALL) return loadToolDocsOverflowRefusal(toolNames.length);

  const results: string[] = [];
  const loaded: string[] = [];
  // A missing manual is not a missing tool: the handler already intersected every name with
  // `getFilteredTools(agentId)`, so it is real and callable, is marked loaded, and the absent manual is
  // reported as a fact about this install. "No such tool" stays with the handler's `describeNameFailure`.
  const manualMissing: string[] = [];
  const registryServed: string[] = [];

  for (const name of toolNames) {
    const doc = readToolDoc(name);
    loaded.push(name);
    if (doc) { results.push(doc); continue; }
    const fallback = registryManual(name, registry);
    if (fallback) {
      results.push(fallback);
      registryServed.push(name);
      logger.warn('no generated manual on this install; served the live registry entry', { agentId, name });
    } else manualMissing.push(name);
  }

  const evicted = markToolsLoaded(agentId, loaded);
  logger.info('Tool docs loaded into session', { agentId, tools: loaded });

  const parts: string[] = [];
  if (results.length > 0) {
    parts.push(`Loaded documentation for ${results.length} tool(s). These tools are now available to call directly.\n\n`
      + results.join('\n\n---\n\n'));
  }
  if (registryServed.length > 0) {
    parts.push(`No generated manual is present on this install for: ${registryServed.join(', ')} — `
      + 'the LIVE REGISTRY entry was served instead, which is the same description and argument '
      + 'schema the model is given on the wire. It is complete enough to call the tool correctly; '
      + 'it carries none of the worked examples a generated manual would.');
  }
  if (manualMissing.length > 0) {
    parts.push(`Loaded, but no manual is available on this install for: ${manualMissing.join(', ')}. `
      + 'Those tools are real and callable — the generated documentation is missing, not the tool, '
      + 'and the registry has no entry under this name to fall back to either.');
  }
  const output = parts.join('\n\n');
  return evicted.length > 0 ? output + evictionNote(evicted) : output;
}


import { getDb } from '../db/connection.js';
import { getPrimaryAgentId, isDreamerAgent } from '../config/platform.js';

// The always-loaded set for an agent, read synchronously from the DB (this cannot `await import()`).
function getDefaultForAgent(agentId: string): string[] {
  try {
    const db = getDb();

    const configRows = db.prepare(
      "SELECT key, value FROM config WHERE key IN ('primary_agent_id', 'pm_agent_id', 'trainer_agent_id')",
    ).all() as Array<{ key: string; value: string }>;
    const configMap: Record<string, string> = {};
    for (const r of configRows) configMap[r.key] = r.value;

    if (agentId === (configMap['primary_agent_id'] ?? getPrimaryAgentId())) return PRIMARY_AGENT_ALWAYS_LOADED;
    if (agentId === (configMap['pm_agent_id'] ?? 'pm')) return PM_AGENT_ALWAYS_LOADED;
    if (agentId === (configMap['trainer_agent_id'] ?? 'trainer')) return TRAINER_AGENT_ALWAYS_LOADED;

    const healerRow = db.prepare("SELECT value FROM config WHERE key = 'healer_agent_id'").get() as { value: string } | undefined;
    if (healerRow && agentId === healerRow.value) return HEALER_AGENT_ALWAYS_LOADED;

    // By configured id, like every service agent above (a name match let a rename lose the loadout).
    if (isDreamerAgent(agentId)) return DREAMER_AGENT_ALWAYS_LOADED;
    const row = db.prepare('SELECT classification FROM agents WHERE id = ?').get(agentId) as { classification: string } | undefined;
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
          // A2A floor: a sub-agent whose custom set omits send_to_agent cannot reply on the thread it was
          // asked a question on, so the reply tool is always unioned in.
          return parsed.includes('send_to_agent') ? parsed : [...parsed, 'send_to_agent'];
        }
      } catch { /* ignore */ }
    }
  } catch { /* column may not exist yet */ }
  return getDefaultForAgent(agentId);
}
