// ════════════════════════════════════════
// Tool Docs Loading & Session State
// Tracks which tools have been loaded per agent session
// so the next API call can include them in the tools array.
// ════════════════════════════════════════

import { createLogger } from '../logger.js';
import { readToolDoc } from './tool-doc-read.js';
import type { ToolDefinition } from '../agent/tools/types.js';

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
  // PHASE-2 T8V: the five tracker/reminder names below collapsed into two verbs.
  // `work_open` covers create-project / create-task / reminder / commitment;
  // `work_update` covers list + status. Both must be one call away for the same
  // reason each retired name was: a load_tool_docs round-trip is the friction
  // that makes a weak model skip the tracker entirely.
  'work_open',
  'work_update',
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
  // PHASE-2 T7: the primary is the agent that gets the OPEN WORK block injected, so both
  // commitment verbs must be callable in a single step, with no load_tool_docs round-trip.
  // Opening a promise in particular is worthless behind one: the promise is recorded at the
  // MOMENT it is made, and a round-trip is exactly the friction that makes a model skip it.
  // T8V: `work_open` is already above; `work_close_request` closes it. `work_note` is
  // deliberately NOT here: `tracker_add_notes` was never in the primary's always-loaded
  // set either, and the close-out gate allows `load_tool_docs` precisely so a close-out
  // tool's schema can be fetched. Adding it would have widened the primary's cached
  // prefix by 1,311 chars for a tool the primary never had one call away.
  'work_close_request',
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
  // PHASE-2 T8V: nine tracker names became three verbs. Pre-loading `work_update`
  // does NOT widen the PM's authority — `pmMayCall` in tracker/pm-agent.ts still
  // refuses the operations the PM was never allowed (the status flip, the step
  // advance), at the executor, which is the only place that ever enforced them.
  'work_update',
  'work_note',
  'work_validate',
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
  // PHASE-2 T8V: eight tracker names, three verbs.
  'work_open',
  'work_update',
  'work_note',
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
  // UX-REPAIR T5 (2026-08-09) — `work_open` joins its own pair, and the reason is measured.
  // This list carried the verb that CHANGES a task and not the verb that CREATES one, and it
  // was the only one of the three lists to do so (`work_open` is in the primary's list above
  // and the Trainer's below). The cost was paid in S1 of the UX review: a ronin agent under
  // the END-OF-TURN decision matrix called `work_update(action="list")`, was told "No active
  // tasks", and then called `work_update(status="in_progress", task_id:"placeholder")` — it
  // reached for the loaded tool and invented the id the schema demanded, against evidence
  // already in its own context. Its own thinking names the asymmetry: "work_open isn't in my
  // always-loaded list but it IS listed under 'Work Tracker' tools."
  //
  // This is the argument the pair above already makes, applied to the list that was missing
  // half of it: "a load_tool_docs round-trip is the friction that makes a weak model skip the
  // tracker entirely." Byte cost declared, because on this list byte cost has been the
  // deciding argument before — and MEASURED off a live ronin's own tools array rather than
  // estimated: `work_open`'s declaration is 10,129 chars, 22.7% of BehaviorBot's 44,632-char
  // array. (The investigation's "~5.5 KB" was the `input_schema` alone; the full entry is
  // nearly twice that. It is also NOT the largest entry in the file — `work_update`'s 13,174
  // is, and this list already carried it, which is the whole asymmetry.) The cost is spent
  // knowingly: the round-trip it removes is the one that produced a fabricated task id. It is
  // STATIC, so the per-agent prefix stays byte-stable turn to turn and prompt caching is
  // unaffected (PREFIX RE-BLESSING REGISTER, UX-REPAIR).
  'work_open',
  'work_update',
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
  // A reset is a DECISION to forget. Leaving the rehydration flag set is what makes it
  // stick: without this the next turn would re-import the pre-reset history's tool names
  // and hand the agent back the session it was just told to drop.
  rehydratedAgents.add(agentId);
}

// ── Restart rehydration (PHASE-3 T3 / S3) ───────────────────────────────────────────────
//
// WHAT MOVED AND WHY. `memory/assembler.ts:1262-1281` (pre-repin) called `markToolsLoaded`
// from inside the assembly READ path: it scanned the fresh tail for `tool_use` names and
// mutated this module's session state. Two costs, both measured:
//
//   1. PURITY. Assembly is a read. A mutation there means a probe, a retry or a dry-run
//      changes what the next real call sends. (This phase's Global Constraints: "Assembly
//      becomes PURE".)
//   2. CACHE. It ran on EVERY assembly, so the first assembly after any restart re-broke the
//      cached prefix for every agent at once, and any assembly could grow the array again.
//
// THE REQUIREMENT IT ENCODED IS PRESERVED, not deleted (#15): "an agent previously loaded a
// tool but the server restarted, so the in-memory session state was lost; it should not have
// to re-call load_tool_docs for a tool it is already using." That is a RESTART-RECOVERY
// concern, so it belongs where a restart is visible — once per agent per process, driven by
// the turn owner, not once per context assembly.

const rehydratedAgents = new Set<string>();

/**
 * Re-import the tool names this agent was already using, ONCE per process. Idempotent and
 * cheap after the first call. Called by the turn owner (`agent/v2/loop.ts`) at the top of a
 * turn; never from an assembly.
 */
export function rehydrateSessionToolsFromHistory(agentId: string, recentLimit = 40): void {
  if (rehydratedAgents.has(agentId)) return;
  rehydratedAgents.add(agentId);
  try {
    const db = getDb();
    const rows = db.prepare(
      "SELECT content FROM messages WHERE agent_id = ? AND role = 'assistant' ORDER BY created_at DESC, rowid DESC LIMIT ?",
    ).all(agentId, recentLimit) as Array<{ content: string }>;
    const seen = new Set<string>();
    for (const r of rows) {
      if (typeof r.content !== 'string' || !r.content.includes('tool_use')) continue;
      try {
        const parsed = JSON.parse(r.content);
        if (!Array.isArray(parsed)) continue;
        for (const block of parsed) {
          if (block?.type === 'tool_use' && typeof block.name === 'string') seen.add(block.name);
        }
      } catch { /* not JSON, skip */ }
    }
    if (seen.size > 0) {
      markToolsLoaded(agentId, [...seen]);
      logger.info('Rehydrated session tool docs from history after restart', {
        agentId, count: seen.size,
      });
    }
  } catch { /* best effort — a missing table must not break a turn */ }
}

/** Test seam: forget that an agent was rehydrated (the process boundary, made addressable). */
export function resetRehydrationForTests(agentId?: string): void {
  if (agentId) rehydratedAgents.delete(agentId);
  else rehydratedAgents.clear();
}

// ── Resolve which tools get sent in the API tools parameter ──

/**
 * ════════════════════════════════════════════════════════════════════════════════════════
 * S1 — THE TOOLS ARRAY IS A DECLARED PREFIX LANE (PHASE-3 T3, §T0-E).
 * ════════════════════════════════════════════════════════════════════════════════════════
 *
 * ── THE DEFECT, MEASURED ────────────────────────────────────────────────────────────────
 * The cacheable prefix is `tools + system`, ≈ 98,945 chars ≈ 24.7K tokens (§T0-E, from
 * 1,460 real context receipts). The volatile message array the allocator fights over is
 * ≈ 6,810 chars — 6.4% of the input. And the prefix was being thrown away on purpose:
 *
 *   • the cache breakpoint sat on the LAST tool in the array (`model.ts:2375`,
 *     `i === arr.length - 1`);
 *   • membership was `allPermittedTools.filter(...)` — REGISTRY order — so a tool loaded
 *     mid-session by `load_tool_docs` could land AHEAD of an always-loaded one;
 *   • therefore every mid-session tool load rewrote the cached prefix, and the next call
 *     paid full price for ~24.7K tokens — about 13× the entire prefix growth the owner
 *     accepted on 2026-07-30.
 *
 * ── THE FIX, AND IT TRIMS NOTHING ───────────────────────────────────────────────────────
 * Two orderings, no removals, no wording change, no tool dropped:
 *   (a) always-loaded tools are emitted FIRST, in the order their set DECLARES them (the
 *       `PRIMARY_AGENT_ALWAYS_LOADED` array above and its siblings), and session-loaded
 *       extras follow in registry order;
 *   (b) `model.ts` puts `cache_control` on the LAST ALWAYS-LOADED tool, so a mid-session
 *       load appends BEHIND the breakpoint and the ~24.7K-token prefix survives.
 *
 * A tool that is BOTH always-loaded and session-loaded (load_tool_docs marks the ones it
 * hands back, whether or not they were already preloaded) counts as always-loaded: the
 * always-loaded set is a declaration and the session set is a cache of what was fetched.
 *
 * Rider 1 of §T0-E: `systemVolatile` must stay `''` or the system half re-breaks anyway.
 * It does — `assembler.ts` returns `''` at every site and the cache-prefix gate asserts it.
 */
export interface PartitionedTools {
  /** The array to send: `alwaysLoaded` then `sessionExtras`, in that order. */
  tools: ToolDefinition[];
  /** The stable head — the cached prefix's tools half. */
  alwaysLoaded: ToolDefinition[];
  /** Session-loaded extras, which ride BEHIND the cache breakpoint. */
  sessionExtras: ToolDefinition[];
  /**
   * Index in `tools` of the last always-loaded tool — where `cache_control` goes.
   * `-1` when there is no always-loaded tool at all (then nothing is cacheable and the
   * breakpoint falls back to the end of the array, which is the old behaviour).
   */
  cacheBreakpointIndex: number;
}

/**
 * Given an agent's permitted tools and their always-loaded list, return the tools that
 * should be sent in the API call, PARTITIONED and ORDERED so the always-loaded head is a
 * stable, cacheable prefix.
 *
 * Determinism: the head follows the declared always-loaded order (de-duplicated, first
 * declaration wins) and the tail follows `allPermittedTools` order. Neither depends on
 * `Set` iteration of a set the session mutated, which is what made the old array's order a
 * function of WHEN a tool was loaded.
 */
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

  // The head, in DECLARED order. `load_tool_docs` is appended only if the declaration did
  // not already name it, so a set that lists it first keeps it first.
  const headNames: string[] = [];
  const seen = new Set<string>();
  for (const name of [...alwaysLoaded, 'load_tool_docs']) {
    if (seen.has(name)) continue;
    seen.add(name);
    if (byName.has(name)) headNames.push(name);
  }
  const head = headNames.map((n) => byName.get(n) as ToolDefinition);

  // The tail: everything else the session loaded, in registry order.
  const tail = allPermittedTools.filter((t) => !seen.has(t.name) && loaded.has(t.name));

  return {
    tools: [...head, ...tail],
    alwaysLoaded: head,
    sessionExtras: tail,
    cacheBreakpointIndex: head.length > 0 ? head.length - 1 : -1,
  };
}

/**
 * THE MEASURED TOOL PAYLOAD, in tokens of the one estimator — what the transport will
 * actually serialise for this agent on this call, not an estimate of it.
 *
 * PHASE-3 T4. The budget's `toolAndOutputReserve` was the literal 15,000 from
 * `assembler.ts:670`, and T2 measured that the primary's tools array alone is ~17,500
 * tokens — the schemas exceeded the whole reserve before one output token, so the
 * assembler's ceiling was over the window before the transport even added the tools. T2
 * refused to retune it by hand (#14 forbids inventing a threshold) and named the honest
 * fix: the assembler has to KNOW the payload. This is that number.
 *
 * It is the same expression `model.ts` runs on every call — `partitionToolsForApiCall`'s
 * array, JSON-stringified — so the budget reserves what the wire carries. Not a parallel
 * estimate of it: a second way to size the tools array is the disease this phase deletes.
 *
 * `agent/tools.js` is imported DYNAMICALLY for the same reason `model.ts` does it: that
 * module is the tool hub and importing it statically from here would close a cycle.
 */
export async function measureAgentToolPayloadTokens(agentId: string): Promise<number> {
  const { getFilteredTools } = await import('../agent/tools/surface.js');
  const { estimateTokens } = await import('../memory/budget.js');
  const allPermitted = getFilteredTools(agentId);
  const alwaysLoaded = getAgentAlwaysLoadedTools(agentId);
  const part = partitionToolsForApiCall(agentId, allPermitted, alwaysLoaded);
  return estimateTokens(JSON.stringify(part.tools));
}

/**
 * The flat array, for callers that do not place the cache breakpoint. Same membership as
 * before S1 — only the ORDER changed, and that change is the point.
 */
export function filterToolsForApiCall(
  agentId: string,
  allPermittedTools: ToolDefinition[],
  alwaysLoaded: string[],
): ToolDefinition[] {
  return partitionToolsForApiCall(agentId, allPermittedTools, alwaysLoaded).tools;
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
