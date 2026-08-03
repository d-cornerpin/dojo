import type { ToolDefinition } from './tools/types.js';
import { coerceNumberArg } from './tools/pagination.js';
import { runWithToolCallId, currentTurnRoot } from './turn-state.js';
import { classifyToolResult, toolErrorCodeForThrow, type ToolOutcome } from './tool-outcome.js';
export { toolResultOf, toolWasBlocked, type ToolOutcome } from './tool-outcome.js';

// PHASE-5 T3: `promisify(exec)` is GONE from this file with the string-exec
// entry point it served, and so is every process spawn — both doors run through
// `agent/tools/process-run.ts`, which uses `execFile` (never a shell) and reaches
// /bin/zsh only with an explicit `-c`.
import fs from 'node:fs';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
// (getRuntimeVersion import removed in Phase 9 Stage 2, single-track v2)
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { resolveToolAlias } from '../tools/aliases.js';
import { workOperation } from '../tools/work-verbs.js';
import {
  withOutboundAsyncIfAbsent, outboundChannelForTool, outboundRecipientForTool,
} from './v2/outbound.js';
import { broadcast } from '../gateway/ws.js';
import { queueLinkArtifact } from './pending-attachments.js';
import { insertMessageIfAbsent } from '../memory/message-store.js';
import { resolveAgentRef, resolveGroupRef } from './tool-helpers.js';
// Phase 3.5 (2026-05-04), `shouldIntercept` / `interceptLargeFile` removed
// from the executeTool path. See agent/tools.ts:executeTool for the explanation.
// The functions still exist in `memory/large-files.ts` for backward compatibility
// with `large_files` table records created before Phase 3.5; new tool calls
// don't intercept.
import { getAgentPermissions } from './permissions.js';
// PHASE-0 T10: sensitive-path list, ~-expansion and the share/read gate.
import { resolvePath, isSensitivePath, sharePathGuard, pdfInputPaths } from './path-guards.js';
import { gatesForCall, ungatedEffectKinds, PRIMARY_ONLY_TOOLS } from './tools/gates.js';
import { validateToolArgs, PER_TOOL_VALIDATED_AT_BOUNDARY } from './tools/validate-args.js';
import { handlerFor } from './tools/handlers.js';
import { prependUserMailboxBanner } from './tools/provider/mailbox-banner.js';
import { auditLog, registerSharedFile, agentCanSelfComplete, agentCanSelfCompleteById, permissionDeniedMessage, syncCanvasAfterWrite, openFileInCanvas } from './tools/util.js';
// PHASE-5 T4: `agentCanSelfComplete` / `agentCanSelfCompleteById` moved to
// `agent/tools/util.ts` so `permissionDeniedMessage` — which every relocated
// gated handler prints — could move with them. Re-exported here so this file's
// existing importers (`v2/loop.ts`) keep resolving until the executor's own
// relocation moves them onto `agent/tools/index.js`.
export { agentCanSelfComplete, agentCanSelfCompleteById } from './tools/util.js';
import { evaluateGate, logOnly } from './tools/gate-eval.js';
import { resolveArgvArg } from './brokers/resolve.js';
import {
  runProcess, resolveProcessCwd, processTimeout, type ProcessAudit,
} from './tools/process-run.js';
// S2 (PHASE-3 T3): the 17 property schemas `work_open` and `work_update` both declare,
// declared ONCE. N1 (post-exit, owner-approved 2026-08-01): the seven fields whose two
// descriptions were paraphrases of each other now have ONE canonical wording, said once on
// the wire — `WORK_FIELD_TEXT`. The other ten pairs are NOT paraphrases and are untouched;
// work-verb-schema.ts enumerates them and says why.
import { workProp, WORK_PRIORITY_ENUM, WORK_FIELD_TEXT } from './work-verb-schema.js';
import { isPrimaryAgent, isPMAgent, isImaginerAgent, getPrimaryAgentId } from '../config/platform.js';
import { getAgentRuntime } from './runtime.js';
// Single source of truth for the PM overseer allow-list; re-checked at the
// executor chokepoint (demolition Phase 1.7 PM verb enforcement).
// `PM_ONLY_WORK_OPS` left with the ladder: the gate that reads it now lives in
// `tools/gates.ts` (row 8). The `pmMayCall` WALL stays here, above the gate loop
// and outside the deleted range — RULING P5-R1.
import { pmMayCall } from '../tracker/pm-agent.js';
import { googleReadToolDefinitions, executeGoogleReadTool } from '../google/tools-read.js';
import { googleWriteToolDefinitions, executeGoogleWriteTool } from '../google/tools-write.js';
import { slidesToolDefinitions, slidesToolNames, executeGoogleSlidesTool } from '../google/tools-slides.js';
import { pdfToolDefinitions, pdfToolNames, executePdfTool } from './pdf-tools.js';
import { formsToolDefinitions, formsToolNames, executeGoogleFormsTool } from '../google/tools-forms.js';
import { getAgentGoogleAccessLevel, getEnabledServices, isGoogleConnected, getGoogleWorkspaceConfig, isAnyGoogleAccountConnected, isGoogleServiceEnabledForKind, getGoogleServiceFlagsForKind } from '../google/auth.js';
import { microsoftReadToolDefinitions, executeMicrosoftReadTool } from '../microsoft/tools-read.js';
import { plaudReadToolDefinitions } from '../plaud/tools-read.js';
import { isPlaudConnected } from '../plaud/auth.js';
import { credentialsToolDefinitions } from '../credentials/tools.js';
import { microsoftWriteToolDefinitions, executeMicrosoftWriteTool } from '../microsoft/tools-write.js';
import { officeCreateToolDefinitions, officeWordEditToolDefinitions, officeExcelEditToolDefinitions, officeEditToolDefinitions } from '../microsoft/tools-office.js';
import { getAgentMicrosoftAccessLevel, getMicrosoftWorkspaceConfig, isAnyMicrosoftAccountConnected, isMsServiceEnabledForKind, getMsServiceFlagsForKind } from '../microsoft/auth.js';
import { areOfficePackagesInstalled } from '../microsoft/office-packages.js';
import { unifiedToolDefinitions, EMAIL_SEARCH_TOOL } from '../tools/unified-read.js';
import { getEffectiveAudioGenModel } from '../services/audio-gen-model.js';
import { getToolConfigGeneration } from './tool-config-generation.js';
import { getModelVoiceCatalog, defaultVoiceCatalogFor, formatVoiceCatalog } from '../services/voice-catalog.js';
import type { ToolCall, ToolResult, ToolErrorCode } from '@dojo/shared';
import { TECHNIQUE_FRESH_SENTINEL } from '@dojo/shared';
import { NEW_SESSION_DIVIDER } from '@dojo/shared';

const logger = createLogger('tools');


// PHASE-5 T4: the per-turn recall budget (`RECALL_BUDGET_TOKENS` +
// `recallBudgetNotice`) moved WITH the four recall handlers it exists for, to
// `agent/tools/cat/recall.ts`. It had no other reader here.

// PHASE-5 T4: `getDownloadUrl`, `toDashboardPath` and `registerSharedFile`
// moved to `agent/tools/util.ts` — the comms handlers that mint a download URL
// left this file, and a category module may not import it back.

// PHASE-5 T4: the canvas-open cluster (`broadcastCanvasUpdate`, `canvasMime`,
// `queueCanvasDocAttachment`, `syncCanvasAfterWrite`, `openFileInCanvas`,
// `localOfficePathFromResult`) moved to `agent/tools/util.ts` — every category
// that writes a file asks it whether the user gets to see the result.

// ── Filtered tools per agent (based on permissions + tools policy) ──

/**
 * Every tool definition the platform can expose to any agent, across all
 * families. Single source of truth for the doc generator: a new family must
 * be added HERE, never to a side list, so "described" and "loadable via
 * load_tool_docs" cannot drift apart (pre-v2.11 drift left forms/pdf/
 * credentials/plaud advertised in the prompt index but absent from the
 * generated docs, so loading them reported "Tools not found").
 */
export function getAllToolDefinitions(): ToolDefinition[] {
  return [
    ...toolDefinitions,
    ...pdfToolDefinitions,
    ...formsToolDefinitions,
    ...credentialsToolDefinitions,
    ...plaudReadToolDefinitions,
    ...googleReadToolDefinitions,
    ...googleWriteToolDefinitions,
    ...slidesToolDefinitions,
    ...microsoftReadToolDefinitions,
    ...microsoftWriteToolDefinitions,
    ...officeCreateToolDefinitions,
    ...officeWordEditToolDefinitions,
    ...officeExcelEditToolDefinitions,
    ...officeEditToolDefinitions,
    ...unifiedToolDefinitions,
  ];
}

// ── THE SCHEMA-VALIDATION BOUNDARY'S SCOPE (PHASE-5 T3 Step 3, RULING P5-R8) ──
// Two lookups, both memoized because `executeToolInner` asks on every call.

let toolDefsByName: Map<string, ToolDefinition> | null = null;

/** Every definition by name, including the `user_` twins. Memoized: the
 *  validation boundary asks on every tool call. */
function toolDefinitionsByName(): ReadonlyMap<string, ToolDefinition> {
  if (!toolDefsByName) {
    toolDefsByName = new Map(getAllToolDefinitions().map((d) => [d.name, d] as const));
  }
  return toolDefsByName;
}

let boundaryValidatedNames: Set<string> | null = null;

/**
 * IS THIS TOOL'S `input_schema.required` ENFORCED AT THE ONE BOUNDARY?
 *
 * True for exactly what the two deleted mechanisms already covered:
 *   • the 57 tools that carried a per-tool `checkRequired([...])` array in
 *     `executeToolInner`'s dispatch (`PER_TOOL_VALIDATED_AT_BOUNDARY`), and
 *   • every tool defined in the eight provider modules that ran
 *     `validateAgainstSchema` at the head of their own dispatcher — taken from
 *     the definition arrays themselves, so a new provider tool is covered the
 *     moment it is declared and no list can drift away from them.
 *
 * False for the six work verbs, whose requiredness is per-OPERATION and stays
 * in their own operation cases, and for the tools that have never had a
 * required-field check on any path — those would be NEW refusals, which RULING
 * P5-R5 reserves to the owner rather than to a refactor. Exported so the
 * conformance test can assert both halves.
 */
export function isBoundaryValidated(name: string): boolean {
  if (!boundaryValidatedNames) {
    boundaryValidatedNames = new Set<string>(PER_TOOL_VALIDATED_AT_BOUNDARY);
    for (const defs of [
      formsToolDefinitions,
      plaudReadToolDefinitions,
      googleReadToolDefinitions,
      googleWriteToolDefinitions,
      slidesToolDefinitions,
      microsoftReadToolDefinitions,
      microsoftWriteToolDefinitions,
      officeCreateToolDefinitions,
      officeWordEditToolDefinitions,
      officeExcelEditToolDefinitions,
      officeEditToolDefinitions,
    ]) {
      for (const d of defs) boundaryValidatedNames.add(d.name);
    }
  }
  return boundaryValidatedNames.has(name);
}

/**
 * FA-TS2: owner-facing platform, session, and group management controls. Each
 * acts on the OWNER's behalf or on other agents: install+restart the platform,
 * rewrite a capability's model, enable/disable a whole channel, change voice or
 * presence (which reroutes the owner's comms), drive the owner's dashboard, and
 * inspect/edit or group other agents' identities. getFilteredTools strips these
 * from every non-primary agent's advertised toolset (below), but that strip is
 * only advisory: Architecture Rule 1 is "the engine enforces, the model
 * follows". The floor model parses tool calls from FREE TEXT, so any non-primary
 * agent (a spawned worker, a role/service agent, an A2A relay, an injection) can
 * emit one of these names and reach the executor. executeToolInner re-checks
 * this SAME set before dispatch, turning the surface hint into enforcement. One
 * constant backs both sites so the strip and the gate can never drift.
 *
 * reset_session is deliberately NOT in this set: the Healer (a non-primary
 * service agent) legitimately calls the reset_session TOOL to clear a wedged
 * agent's corrupted context. It stays surface-stripped but stays executable, so
 * it is pushed onto the strip separately below rather than through this set.
 */

// ── Tool-eligibility memo (FA-TS1) ──
// callModel calls getFilteredTools once per tool-loop iteration; a 20-tool-call
// turn used to rebuild the list ~20 times, each rebuild running ~185 synchronous
// google_accounts / microsoft_accounts scans that CANNOT change mid-turn. The
// memo caches the computed list per agent, validated by two cheap keys:
//   - the module-level tool-config generation (bumped by every GLOBAL write that
//     changes the surface: account connect/disconnect/service-toggle, plaud,
//     office packages, audio-gen model), and
//   - a per-agent fingerprint (a single SELECT of the agent's own
//     eligibility-relevant columns plus its primary/PM identity).
// The generation covers global state; the fingerprint covers the agent's own row
// by construction, so the diffuse set of agents-row write sites needs no manual
// bump. On a hit the whole call costs ONE fingerprint SELECT (vs ~185 scans);
// on a miss it recomputes and re-caches. Keyed by agentId with the gen +
// fingerprint stored in the entry, so the map holds at most one entry per agent.
interface FilteredToolsCacheEntry {
  generation: number;
  fingerprint: string;
  tools: ToolDefinition[];
}
const filteredToolsCache = new Map<string, FilteredToolsCacheEntry>();
// Bound the map so a long-lived server that spawns many ephemeral agents can't
// leak one entry per agent id forever. FIFO eviction (Map preserves insertion
// order); an evicted agent just recomputes on its next call. Comfortably above
// the count of concurrently-active agents on any real box.
const FILTERED_TOOLS_CACHE_MAX = 512;

/**
 * FA-TS1: single SELECT of everything AGENT-SPECIFIC that getFilteredTools
 * consumes: the permission manifest source (`permissions`, `spawn_depth`,
 * `created_by`), the tools-policy / group / lifecycle fields, and the agent's
 * primary/PM identity (which flips the FA-TS2 strip and the Google/MS access
 * level). Any change to these flips the fingerprint, so the memo self-invalidates
 * on a per-agent row change without hunting the diffuse agents-table write sites.
 */
function computeAgentToolFingerprint(agentId: string): string {
  const primary = isPrimaryAgent(agentId) ? '1' : '0';
  const pm = isPMAgent(agentId) ? '1' : '0';
  const row = getDb()
    .prepare('SELECT permissions, spawn_depth, created_by, tools_policy, group_id, classification, task_id FROM agents WHERE id = ?')
    .get(agentId) as {
      permissions: string | null;
      spawn_depth: number | null;
      created_by: string | null;
      tools_policy: string | null;
      group_id: string | null;
      classification: string | null;
      task_id: string | null;
    } | undefined;
  if (!row) return `none\x00${primary}\x00${pm}`;
  return [
    primary,
    pm,
    row.permissions ?? '',
    row.spawn_depth ?? '',
    row.created_by ?? '',
    row.tools_policy ?? '',
    row.group_id ?? '',
    row.classification ?? '',
    row.task_id ?? '',
  ].join('\x00');
}

export function getFilteredTools(agentId: string): ToolDefinition[] {
  const generation = getToolConfigGeneration();
  const fingerprint = computeAgentToolFingerprint(agentId);
  const cached = filteredToolsCache.get(agentId);
  if (cached && cached.generation === generation && cached.fingerprint === fingerprint) {
    return cached.tools;
  }
  const tools = computeFilteredTools(agentId);
  // Callers treat the list as read-only (filter/map/some/find, audited); freeze
  // the container outside production so a future in-place mutation of the shared
  // cached array trips loudly instead of silently corrupting every agent's cache.
  if (process.env.NODE_ENV !== 'production') Object.freeze(tools);
  filteredToolsCache.delete(agentId); // re-insert at the tail so FIFO stays honest
  filteredToolsCache.set(agentId, { generation, fingerprint, tools });
  if (filteredToolsCache.size > FILTERED_TOOLS_CACHE_MAX) {
    const oldest = filteredToolsCache.keys().next().value;
    if (oldest !== undefined) filteredToolsCache.delete(oldest);
  }
  return tools;
}

/**
 * FU-4: the SINGLE parser for a stored tools_policy, used by BOTH the
 * advertised-surface strip (computeFilteredTools) and the executor-side deny
 * re-check (getAgentDenySet / executeToolInner), so the two cannot drift.
 * Alias-maps old/renamed names to canonical (C27 hook 4) so allow/deny still bind
 * to the new tool after a rename; tombstoned names are left as-is (match nothing).
 */
function parseToolsPolicy(rawToolsPolicy: string | null | undefined): { allow: string[]; deny: string[] } {
  let allow: string[] = [];
  let deny: string[] = [];
  if (rawToolsPolicy) {
    try {
      const parsed = JSON.parse(rawToolsPolicy);
      if (Array.isArray(parsed.allow)) allow = parsed.allow;
      if (Array.isArray(parsed.deny)) deny = parsed.deny;
    } catch { /* ignore malformed policy */ }
  }
  const canon = (n: string): string => {
    const r = resolveToolAlias(n, {});
    return r.tombstone ? n : r.name;
  };
  return { allow: allow.map(canon), deny: deny.map(canon) };
}

// ── Executor-side tools_policy.deny memo (FU-4) ──
// computeFilteredTools strips a denied tool from the ADVERTISED surface, but per
// Architecture Rule 1 that strip is only advice: the floor model can emit a
// denied tool name from free text and reach the executor. executeToolInner
// re-checks this deny set before dispatch (the same surface-strip/executor-
// recheck pairing PRIMARY_ONLY_TOOLS uses). Kept O(1) per call by mirroring the
// FA-TS1 filtered-tools memo shape: keyed by agentId, validated by the SAME
// (generation, fingerprint) keys. The fingerprint already includes tools_policy,
// so any policy edit self-invalidates without hunting the agents-table write sites.
interface DenySetCacheEntry {
  generation: number;
  fingerprint: string;
  deny: Set<string>;
}
const agentDenySetCache = new Map<string, DenySetCacheEntry>();

function getAgentDenySet(agentId: string): Set<string> {
  const generation = getToolConfigGeneration();
  const fingerprint = computeAgentToolFingerprint(agentId);
  const cached = agentDenySetCache.get(agentId);
  if (cached && cached.generation === generation && cached.fingerprint === fingerprint) {
    return cached.deny;
  }
  const row = getDb()
    .prepare('SELECT tools_policy FROM agents WHERE id = ?')
    .get(agentId) as { tools_policy: string | null } | undefined;
  const deny = new Set(parseToolsPolicy(row?.tools_policy).deny);
  agentDenySetCache.delete(agentId); // re-insert at the tail so FIFO stays honest
  agentDenySetCache.set(agentId, { generation, fingerprint, deny });
  if (agentDenySetCache.size > FILTERED_TOOLS_CACHE_MAX) {
    const oldest = agentDenySetCache.keys().next().value;
    if (oldest !== undefined) agentDenySetCache.delete(oldest);
  }
  return deny;
}

// PHASE-5 T4: `resolveSpawnSquad` moved to `agent/tools/cat/agents.ts` with
// `spawn_agent`, its only caller (re-derived at that HEAD).

function computeFilteredTools(agentId: string): ToolDefinition[] {
  const manifest = getAgentPermissions(agentId);

  // Get tools policy from DB
  const db = getDb();
  const agentRow = db.prepare('SELECT tools_policy, group_id, classification, task_id FROM agents WHERE id = ?').get(agentId) as { tools_policy: string; group_id: string | null; classification: string | null; task_id: string | null } | undefined;
  // FU-4: one shared parser (also used by the executor deny re-check) so the
  // surface strip and the executor gate read the SAME canonicalized allow/deny.
  const toolsPolicy = parseToolsPolicy(agentRow?.tools_policy);

  // Base toolkit includes the static `toolDefinitions` plus the PDF
  // creation/manipulation tools, which require no external auth and
  // are safe for every agent classification.
  let filtered = [...toolDefinitions, ...pdfToolDefinitions];

  // 1. Tools policy deny list, remove denied tools
  if (toolsPolicy.deny.length > 0) {
    filtered = filtered.filter(t => !toolsPolicy.deny.includes(t.name));
  }

  // 2. Tools policy allow list, if non-empty, only include allowed tools
  if (toolsPolicy.allow.length > 0) {
    filtered = filtered.filter(t => toolsPolicy.allow.includes(t.name));
  }

  // 2b. Phase 7 (Part X), squad coordination primitives auto-available to
  // any agent with a group_id, even when tools_policy.allow is set. This
  // prevents the "two agents in a squad can share/retrieve" acceptance
  // criterion from silently regressing whenever an agent has a curated
  // allow list that predates Phase 7. Explicit `tools_policy.deny` still
  // wins (filter step 1 above), the user can opt out per-agent.
  if (agentRow?.group_id) {
    const present = new Set(filtered.map(t => t.name));
    const explicitDeny = new Set(toolsPolicy.deny);
    for (const name of ['squad_share', 'squad_recall']) {
      if (present.has(name) || explicitDeny.has(name)) continue;
      const def = toolDefinitions.find(t => t.name === name);
      if (def) filtered.push(def);
    }
  }

  // 3. Permission-based filtering
  const hasFileRead = manifest.file_read === '*' || (Array.isArray(manifest.file_read) && manifest.file_read.length > 0);
  const hasFileWrite = manifest.file_write === '*' || (Array.isArray(manifest.file_write) && manifest.file_write.length > 0);
  const hasExec = manifest.exec_allow.length > 0;
  const hasNetwork = manifest.network_domains !== 'none';
  const sysControl = manifest.system_control ?? [];
  const hasSysControl = sysControl.includes('*') || sysControl.length > 0;
  const hasWebBrowse = sysControl.includes('*') || sysControl.includes('web_browse');

  const removeTools: string[] = [];

  if (!hasFileRead) removeTools.push('file_read', 'file_list');
  if (!hasFileWrite) removeTools.push('file_write', 'file_append', 'file_patch');
  if (!hasExec) removeTools.push('exec');
  if (!hasNetwork) removeTools.push('web_search', 'web_fetch');
  if (!hasSysControl) removeTools.push('mouse_click', 'mouse_move', 'keyboard_type', 'screen_screenshot', 'applescript_run');
  if (!hasWebBrowse) removeTools.push('web_browse');
  if (!manifest.can_spawn_agents) removeTools.push('spawn_agent', 'kill_agent', 'spawn_timeout_decision');

  // C27: update_agent (merged) self-gates its permissions/tools fields on
  // can_assign_permissions inside the handler, so it stays available for
  // name/model/prompt edits even without that permission (no removeTools here).

  // Only primary-level agents should have group management, session, and presence tools.
  // C27: update_agent replaces update_agent_{model,profile}; tunnel replaces the
  // tunnel_* quartet but self-gates mutating actions (start/stop/restart) to the
  // primary inside the handler, so non-primary agents keep tunnel({action:"status"}).
  // FA-TS2: the set here is PRIMARY_ONLY_TOOLS, the SAME constant executeToolInner
  // enforces, so the surface strip and the executor gate cannot drift. reset_session
  // is stripped here too but is intentionally not in that set (the Healer executes it).
  if (!isPrimaryAgent(agentId)) {
    removeTools.push(...PRIMARY_ONLY_TOOLS, 'reset_session');
  }

  // Technique tools: only Sensei can save/publish/update, everyone can use/list
  const agentClassification = agentRow?.classification ?? undefined;
  if (agentClassification !== 'sensei') {
    removeTools.push('save_technique', 'publish_technique', 'update_technique', 'submit_technique_for_review', 'delete_technique', 'technique_set_placeholder', 'technique_finalize');
  }

  // FN-8: complete_task terminates the calling agent. It is a SPAWNED-agent
  // lifecycle tool, not a general "mark work done" tool. Remove it from any
  // agent that must not self-terminate (the primary, standalone agents), so a
  // weak floor model can't end a persistent agent by emitting the call. The
  // handler re-checks this same predicate as the actual engine enforcement.
  const canSelfComplete = agentRow ? agentCanSelfComplete(agentId, agentRow) : false;
  if (!canSelfComplete) {
    removeTools.push('complete_task');
  }


  if (removeTools.length > 0) {
    filtered = filtered.filter(t => !removeTools.includes(t.name));
  }

  // ── Permission-aware tool descriptions ──
  // Customize tool descriptions with the agent's specific permissions so
  // the agent knows upfront what it CAN do, not just what will be denied.
  // This prevents loops where the agent tries a disallowed command 20+
  // times because the generic description says "run a command" without
  // specifying which commands are allowed.
  if (hasExec && manifest.exec_allow[0] !== '*') {
    const allowedCmds = manifest.exec_allow.join(', ');
    // FN-8: only suggest complete_task(status="blocked") to agents that can
    // actually self-complete; others get a routing/escalation hint that does
    // not name a tool they don't have.
    const blockedHint = canSelfComplete
      ? 'use send_to_agent to ask an agent with broader permissions, or call complete_task(status="blocked")'
      : 'use send_to_agent to ask an agent with broader permissions, or tell the user you are blocked';
    filtered = filtered.map(t => {
      if (t.name !== 'exec') return t;
      return {
        ...t,
        description: `Execute a shell command. You can ONLY run these commands: ${allowedCmds}. Any other command will be blocked. If you need a command that's not in this list, ${blockedHint}. Has a 30-second timeout.`,
      };
    });
  }

  if (hasFileRead && manifest.file_read !== '*' && Array.isArray(manifest.file_read)) {
    const allowedPaths = manifest.file_read.join(', ');
    filtered = filtered.map(t => {
      if (t.name !== 'file_read') return t;
      return {
        ...t,
        description: `Read a file. You can only read from: ${allowedPaths}. Other paths will be blocked.`,
      };
    });
  }

  if (hasFileWrite && manifest.file_write !== '*' && Array.isArray(manifest.file_write)) {
    const allowedPaths = manifest.file_write.join(', ');
    filtered = filtered.map(t => {
      if (t.name !== 'file_write') return t;
      return {
        ...t,
        description: `Write a file. You can only write to: ${allowedPaths}. Other paths will be blocked.`,
      };
    });
  }

  // ── tts_create voice catalog ──
  // Inject the configured TTS model's known voices (id + character) into the
  // tool description so the agent picks a real voice by vibe instead of
  // guessing. OpenRouter returns null for supported_voices on gpt-audio, so
  // the catalog is seeded in voice-catalog.ts. Models with no seed keep the
  // generic static description (and skip dispatcher voice validation).
  if (filtered.some(t => t.name === 'tts_create')) {
    try {
      const audioModel = getEffectiveAudioGenModel();
      const catalog = audioModel
        ? getModelVoiceCatalog(audioModel.modelId) ?? defaultVoiceCatalogFor(audioModel.apiModelId)
        : null;
      if (catalog && catalog.length > 0) {
        const list = formatVoiceCatalog(catalog);
        filtered = filtered.map(t => {
          if (t.name !== 'tts_create') return t;
          return {
            ...t,
            description: `${t.description}\n\nVOICES for the configured model, pass one of these ids in \`voice\`, picking the closest when the user asks for a specific sound (e.g. "a deep male voice" -> onyx): ${list}. The voice id only sets the base timbre. For character, accent, age, or emotion (gravelly, elderly, excited, pirate, etc.), keep a base voice id AND write the delivery style into the \`text\` as natural narration, the id alone cannot produce it. A voice id not in this list is rejected.`,
          };
        });
      }
    } catch { /* best-effort enrichment, fall back to the static description */ }
  }

  // ── Google Workspace tools (access-level gated) ──
  const isPrimary = isPrimaryAgent(agentId);
  const isPM = isPMAgent(agentId);

  const googleAccess = getAgentGoogleAccessLevel(agentId, isPrimary, isPM);
  // Path B: a kind's tools belong in the index if ANY of that kind's connected
  // accounts has the service enabled, not just the position-1 row. Without
  // this, a half-connected kind leaves a broken tool surface visible to the
  // agent (calls return "Not authenticated"); the agent burns tokens trying
  // the wrong tool, then has to recover.
  const agentKindConnected = isAnyGoogleAccountConnected('agent');
  const userKindConnected = isAnyGoogleAccountConnected('user');

  // FA-TS1 (tier 1): precompute per-(kind, service) enabled flags ONCE, one
  // google_accounts read per kind, instead of a full SELECT per tool inside
  // isToolEnabledByService (which ran ~109 times). Same fact door, identical
  // results; the memo above then reuses this across the whole tool loop.
  const googleServiceFlags = {
    agent: getGoogleServiceFlagsForKind('agent'),
    user: getGoogleServiceFlagsForKind('user'),
  } as const;

  // Service-to-tool-prefix mapping for filtering by enabled service.
  const serviceToolPrefixes: Record<string, string[]> = {
    gmail: ['gmail_'],
    calendar: ['calendar_'],
    drive: ['drive_'],
    docs: ['docs_'],
    sheets: ['sheets_'],
    slides: ['slides_'],
    forms: ['forms_'],
  };

  /**
   * Two filters in one: (1) is this tool's kind connected (any account)?
   * (2) does any connected account of that kind have the underlying service
   * enabled? Both must pass.
   *
   * `user_*` tools route through the user kind; everything else through the
   * agent kind. The check strips `user_` to find the service prefix so
   * `user_gmail_inbox` correctly maps to the Gmail service (not the catch-all
   * "always allowed" branch).
   */
  function isToolEnabledByService(toolName: string): boolean {
    const isUserKind = toolName.startsWith('user_');
    const canonical = isUserKind ? toolName.slice('user_'.length) : toolName;
    const kind = isUserKind ? 'user' : 'agent';
    if (!(isUserKind ? userKindConnected : agentKindConnected)) return false;
    for (const [service, prefixes] of Object.entries(serviceToolPrefixes)) {
      if (prefixes.some(p => canonical.startsWith(p))) {
        return googleServiceFlags[kind][service as Parameters<typeof isGoogleServiceEnabledForKind>[1]];
      }
    }
    return true; // tools not matching any service are always enabled when the kind is connected
  }

  if (googleAccess === 'full') {
    // Primary agent: all read + write tools, filtered by per-slot connection AND enabled services.
    const allGoogleTools = [...googleReadToolDefinitions, ...googleWriteToolDefinitions, ...slidesToolDefinitions, ...formsToolDefinitions];
    filtered.push(...allGoogleTools.filter(t => isToolEnabledByService(t.name)));
  } else if (googleAccess === 'read') {
    // Read-only agents (Ronin/Apprentice): read-only tools for Gmail/Calendar/
    // Drive/Docs/Sheets, PLUS the full Slides toolkit, because slides decks
    // are a standalone creative output that's safe for sub-agents to produce.
    // They still cannot send email, edit docs, or modify Drive files directly.
    filtered.push(...googleReadToolDefinitions.filter(t => isToolEnabledByService(t.name)));
    filtered.push(...slidesToolDefinitions.filter(t => isToolEnabledByService(t.name)));
    // Forms is gated tighter than Slides because forms collect responses from
    // external people (durable real-world impact). Sub-agents get the read
    // tools (forms_get, forms_list_responses), they can summarize survey
    // results, but not the create/edit tools. Primary owns those.
    filtered.push(
      ...formsToolDefinitions
        .filter(t => t.name === 'forms_get' || t.name === 'forms_list_responses')
        .filter(t => isToolEnabledByService(t.name)),
    );
    // drive_upload is also exposed because it's the only way to get a local
    // file (e.g. an Imaginer-generated image) into a deck via
    // slides_add_image_from_drive. Without it the Slides toolkit is half
    // broken for any deck that needs an inline image. The upload goes into
    // the dojo owner's Drive, same account these read-tier agents already
    // have read access to, so the trust delta is small.
    filtered.push(
      ...googleWriteToolDefinitions
        .filter(t => t.name === 'drive_upload')
        .filter(t => isToolEnabledByService(t.name)),
    );
  }
  // googleAccess === 'none': no Google tools added

  // ── Microsoft 365 tools (access-level gated) ──
  const msAccess = getAgentMicrosoftAccessLevel(agentId, isPrimary, isPM);
  const agentSlotMsConnected = isAnyMicrosoftAccountConnected('agent');
  const userSlotMsConnected = isAnyMicrosoftAccountConnected('user');

  // FA-TS1 (tier 1): precompute per-(kind, service) MS flags ONCE (one
  // microsoft_accounts read per kind) instead of a full SELECT per tool inside
  // isMsToolEnabledByService (which ran ~76 times). Same fact door.
  const msServiceFlags = {
    agent: getMsServiceFlagsForKind('agent'),
    user: getMsServiceFlagsForKind('user'),
  } as const;

  const msServiceToolPrefixes: Record<string, string[]> = {
    outlook: ['outlook_'],
    calendar: ['calendar_agenda_ms', 'calendar_search_ms', 'calendar_list_ms', 'calendar_create_ms', 'calendar_update_ms', 'calendar_delete_ms', 'calendar_respond_invite_ms', 'calendar_share_invites_ms', 'calendar_accept_share_ms', 'calendar_freebusy_ms'],
    onedrive: ['onedrive_', 'sharepoint_'],
    teams: ['teams_', 'online_meeting_'],
    contacts: ['contacts_'],
    onenote: ['onenote_'],
    tasks: ['tasks_'],
  };

  /** Same two-stage gate as the Google version, multi-account aware: the kind
   *  must have a connected account AND some connected account of that kind must
   *  have the service enabled. */
  function isMsToolEnabledByService(toolName: string): boolean {
    const isUserKind = toolName.startsWith('user_');
    const canonical = isUserKind ? toolName.slice('user_'.length) : toolName;
    const kind = isUserKind ? 'user' : 'agent';
    if (!(isUserKind ? userSlotMsConnected : agentSlotMsConnected)) return false;
    for (const [service, patterns] of Object.entries(msServiceToolPrefixes)) {
      if (patterns.some(p => canonical.startsWith(p) || canonical === p)) {
        return msServiceFlags[kind][service as Parameters<typeof isMsServiceEnabledForKind>[1]];
      }
    }
    return true;
  }

  if (msAccess === 'full') {
    const allMsTools = [...microsoftReadToolDefinitions, ...microsoftWriteToolDefinitions];
    filtered.push(...allMsTools.filter(t => isMsToolEnabledByService(t.name)));
  } else if (msAccess === 'read') {
    filtered.push(...microsoftReadToolDefinitions.filter(t => isMsToolEnabledByService(t.name)));
  }
  // msAccess === 'none': no Microsoft tools added

  // ── F4: unified email_search (merged read across every connected mailbox) ──
  // Available whenever at least one MAIL-capable account is connected on a slot
  // the agent can read (Gmail on any connected Google account, or Outlook on any
  // connected Microsoft account). The merged calendar_agenda ships as part of the
  // Google read set above; email_search is registered here because it is a NEW,
  // cross-provider tool with no provider array of its own. It deliberately gets
  // no user_ twin and no `account` param (it spans every mailbox at once).
  const googleMailCapable = googleAccess !== 'none'
    && ((agentKindConnected && googleServiceFlags.agent.gmail) || (userKindConnected && googleServiceFlags.user.gmail));
  const msMailCapable = msAccess !== 'none'
    && ((agentSlotMsConnected && msServiceFlags.agent.outlook) || (userSlotMsConnected && msServiceFlags.user.outlook));
  if (googleMailCapable || msMailCapable) {
    filtered.push(EMAIL_SEARCH_TOOL);
  }

  // The merged `calendar_agenda` lives in googleReadToolDefinitions (so the
  // user_ generator + registration loops find it), and the Google filter above
  // already added it when the AGENT's Google calendar is enabled. But the merged
  // view spans every provider, so it must also be available on a Microsoft-only
  // or owner-Google-only box. Surface it whenever ANY connected calendar exists
  // and it isn't already present (the guard prevents a double-push).
  const calendarCapable =
    (googleAccess !== 'none' && ((agentKindConnected && googleServiceFlags.agent.calendar) || (userKindConnected && googleServiceFlags.user.calendar)))
    || (msAccess !== 'none' && ((agentSlotMsConnected && msServiceFlags.agent.calendar) || (userSlotMsConnected && msServiceFlags.user.calendar)));
  if (calendarCapable && !filtered.some(t => t.name === 'calendar_agenda')) {
    const mergedAgenda = googleReadToolDefinitions.find(t => t.name === 'calendar_agenda');
    if (mergedAgenda) filtered.push(mergedAgenda);
  }

  // ── Office document tools ──
  // Three tiers of gating:
  //   - CREATE tools (Word / Excel / PowerPoint generation) write to disk
  //     under ~/.dojo/uploads/<agentId>/ when Microsoft isn't connected,
  //     just like pdf_create. Exposed to every agent with the npm packages.
  //   - LOCAL EDIT/READ tools (Word: append/insert/replace/delete/outline/read;
  //     Excel: get/write range, append rows, add/delete sheet) operate on a
  //     LOCAL path too, so they're granted alongside the creates, otherwise a
  //     local-only setup could create docs/workbooks but not edit them, forcing
  //     wasteful full-file regeneration. Two honestly-named arrays (Word +
  //     Excel) so neither can silently hide the other's membership.
  //   - The remaining EDIT/READ tools (PowerPoint slide ops) genuinely need the
  //     Graph connection, gated behind 'full'.
  if (areOfficePackagesInstalled()) {
    filtered.push(...officeCreateToolDefinitions);
    filtered.push(...officeWordEditToolDefinitions);
    filtered.push(...officeExcelEditToolDefinitions);
  }
  if (msAccess === 'full' && areOfficePackagesInstalled()) {
    filtered.push(...officeEditToolDefinitions);
  }

  // ── Plaud (meeting recordings) ──
  // Read-only across the board. No slot model (single account per Dojo
  // install) and no service-level toggles, if the user connected Plaud,
  // every agent that has integration access sees the full tool set.
  if (isPlaudConnected()) {
    filtered.push(...plaudReadToolDefinitions);
  }

  // ── Agent credentials vault ──
  // Always available to every agent. Storage for credentials agents
  // collect while building techniques (third-party API keys, tokens).
  // Separate from secrets.yaml (platform-managed) and vault entries
  // (knowledge that decays). Encrypted at rest with a master key in
  // secrets.yaml.
  filtered.push(...credentialsToolDefinitions);

  // ── Multi-account description annotation ──
  // Every Google/Microsoft tool gets its description prefixed with
  // "[Routes to <email>, <slot> <provider>]" so the agent never has
  // to guess which account a tool hits. Without this the agent reads
  // descriptions like "the user's connected account" generically and
  // can't name the email in chat without a tool call. Office document
  // tools and pure-utility tools (slides/forms when not user-facing)
  // aren't annotated, they don't have a slot to disambiguate.
  //
  // Pull fresh emails from config here (not at module load) so a
  // reconnect to a different account updates the annotations on the
  // very next agent turn, no server restart needed.
  const agentGoogleEmail = agentKindConnected ? getGoogleWorkspaceConfig('agent').accountEmail : null;
  const userGoogleEmail = userKindConnected ? getGoogleWorkspaceConfig('user').accountEmail : null;
  const agentMsEmail = agentSlotMsConnected ? getMicrosoftWorkspaceConfig('agent').accountEmail : null;
  const userMsEmail = userSlotMsConnected ? getMicrosoftWorkspaceConfig('user').accountEmail : null;

  const googleToolNames = new Set([
    ...googleReadToolDefinitions.map(t => t.name),
    ...googleWriteToolDefinitions.map(t => t.name),
    ...slidesToolDefinitions.map(t => t.name),
    ...formsToolDefinitions.map(t => t.name),
  ]);
  const microsoftToolNames = new Set([
    ...microsoftReadToolDefinitions.map(t => t.name),
    ...microsoftWriteToolDefinitions.map(t => t.name),
  ]);

  const annotated = filtered.map(t => {
    // F4: `calendar_agenda` is the MERGED cross-account view, not routed to a
    // single email — skip the "[Routes to <email>, agent's Google account]"
    // prefix that would be misleading here. Its user_ variant stays annotated.
    if (t.name === 'calendar_agenda') return t;
    const isUserSlot = t.name.startsWith('user_');
    let routesTo: string | null = null;
    let label: string = '';
    if (googleToolNames.has(t.name)) {
      routesTo = isUserSlot ? userGoogleEmail : agentGoogleEmail;
      label = isUserSlot ? "user's Google" : "agent's Google";
    } else if (microsoftToolNames.has(t.name)) {
      routesTo = isUserSlot ? userMsEmail : agentMsEmail;
      label = isUserSlot ? "user's Microsoft" : "agent's Microsoft";
    }
    if (!routesTo) return t;
    return {
      ...t,
      description: `[Routes to ${routesTo}, ${label} account] ${t.description}`,
    };
  });

  return annotated;
}

// ── Tool Schemas for Anthropic API ──

// ── Tool definitions: the type is the LEAF now (PHASE-5 T1) ──
//
// `ToolDefinition` moved to `agent/tools/types.ts`, a module with zero imports,
// because fifteen modules type-imported it from HERE and this file statically
// imports eleven of them straight back (§T0-PINS P8). Those eleven cycles are
// why `applyTextPagination` had to be fetched through `await import()` at
// runtime from two of them. The re-export below keeps every consumer outside
// the toolbox working unchanged; new code should import from the leaf.
export type { ToolDefinition, ToolEffect, EffectKind, ToolFieldDeclaration } from './tools/types.js';
// The pagination leaf's two helpers keep their old public home so the six
// former `await import('../agent/tools.js')` call sites are the only movers.
export { applyTextPagination, coerceNumberArg } from './tools/pagination.js';

// Membership sets for dispatch routing. The Google/Microsoft definition arrays
// already include the user_* slot variants (the generators push them at module
// load), so these sets cover base + user_ tools uniformly. executeTool routes
// by membership (in the default case) rather than a hand-maintained switch list,
// which silently dropped newer base tools and most user_* variants into
// "Unknown tool" even when the account was connected.
const GOOGLE_WRITE_TOOL_NAMES = new Set(googleWriteToolDefinitions.map(t => t.name));
const GOOGLE_READ_TOOL_NAMES = new Set(googleReadToolDefinitions.map(t => t.name));
const MS_WRITE_TOOL_NAMES = new Set(microsoftWriteToolDefinitions.map(t => t.name));
const MS_READ_TOOL_NAMES = new Set(microsoftReadToolDefinitions.map(t => t.name));

export const toolDefinitions: ToolDefinition[] = [
  {
    name: 'approve_destructive_action',
    description: 'Decide a destructive-action approval request (primary agent only). The engine holds non-primary agents\' destructive tool calls (file deletion, destructive shell commands) and sends you a request with a token. Approve only when the action clearly serves the assigned work; use your judgment about checking with the owner first. Approval is one-shot and expires in 60 minutes.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        token: { type: 'string', description: 'The approval token from the request message' },
        decision: { type: 'string', enum: ['approve', 'deny'], description: 'approve or deny' },
      },
      required: ['token', 'decision'],
    },
  },
  {
    name: 'load_tool_docs',
    description: 'Load the full documentation for one or more tools before using them. Call this when you need to review a tool\'s parameters or usage details. After loading, the tools become callable on subsequent turns. Your always-loaded tools are already available without needing this.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        tools: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of tool names to load documentation for (e.g., ["gmail_send", "calendar_create"])',
        },
      },
      required: ['tools'],
    },
  },
  {
    name: 'exec',
    description: 'Run ONE program directly and return its output, with NO shell. `argv` is an array: the first element is the program, every other element is one literal argument. Because there is no shell, characters like | > < * $ ` && ; are ordinary text — they do NOT pipe, redirect, glob or substitute. Use the `shell` tool when you need any of those. Has a 30-second default timeout. **Before reaching for exec, scan the tool index for a purpose-built tool**, there are dedicated tools for reading files (file_read), writing files (file_write), patching files (file_patch), web fetch (web_fetch), calendar, drive, forms, office docs, tracker, vault, scheduling, sending messages, and more. Use exec only when no purpose-built tool fits. If the task is "look at the chat / recall what was said," call recall_recent_thread instead of digging through files. Example: exec({ argv: ["ls", "-la", "~/projects"] }). Returns stdout and stderr.',
    effects: [{ kind: 'proc', from: 'args.argv' }],
    input_schema: {
      type: 'object',
      properties: {
        argv: {
          type: 'array',
          items: { type: 'string' },
          description: 'The program and its arguments, one per element. E.g. ["git","status","--short"]. NOT a shell command line — do not put a whole command in one string, and do not use pipes or redirection here.',
        },
        cwd: {
          type: 'string',
          description: 'Absolute directory to run in (optional; defaults to the agent workspace).',
        },
        timeout: {
          type: 'number',
          description: 'Timeout in milliseconds (default: 30000, max: 120000)',
        },
      },
      required: ['argv'],
    },
    concurrency: 'serial',
    // v2.7.2, was 4000. Logs, grep output, and JSON dumps frequently
    // exceed that, forcing the agent to re-run with `| head -N` workarounds
    // that mask real signal. Modern models have 100K+ context; a 32K cap
    // is "let the LLM see what actually came out of the command" without
    // letting a pathological 10MB log dump nuke the context.
    maxResultTokens: 32000,
  },
  {
    name: 'shell',
    description: 'Run a shell SCRIPT under /bin/zsh and return its output — this is the tool for pipes, redirection, globbing, variables, command substitution, `&&`/`;` chains and for/while/if loops. Requires shell access; if you only need to run one program with plain arguments, use exec({argv:[...]}) instead, which is safer and always available to you if exec is. The whole script text is recorded. Has a 30-second default timeout. Example: shell({ script: "ls -la ~/projects | grep report | wc -l" }). Returns stdout and stderr.',
    effects: [{ kind: 'shell', from: 'args.script' }],
    input_schema: {
      type: 'object',
      properties: {
        script: {
          type: 'string',
          description: 'The shell script to run under /bin/zsh. May contain pipes, redirects, loops and substitution.',
        },
        cwd: {
          type: 'string',
          description: 'Absolute directory to run in (optional; defaults to the agent workspace).',
        },
        timeout: {
          type: 'number',
          description: 'Timeout in milliseconds (default: 30000, max: 120000)',
        },
      },
      required: ['script'],
    },
    concurrency: 'serial',
    maxResultTokens: 32000,
  },
  {
    name: 'file_read',
    description: 'Read the contents of a file at the given absolute path. For text files, returns line-numbered content. Use optional offset (line number, 0-indexed) and limit (line count, default 5000) to paginate when a file is genuinely huge, for typical documents (code files, transcripts, briefs, reports) you should not need to paginate at all. Per-call cap is ~60K tokens, which covers ~120 pages of text. For images (PNG, JPEG, GIF, WEBP) and PDFs, returns content for vision (paging not applicable). Example: file_read({ path: "/Users/me/foo.html" }).',
    effects: [{ kind: 'fs_read', from: 'args.path' }],
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute path to the file to read',
        },
        offset: {
          type: 'number',
          description: 'Line number to start reading from (0-indexed). Default 0. Only needed when paginating a file larger than the per-call cap.',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of lines to return. Default 5000. Combined with a per-call cap (~60K tokens), large lines may produce fewer.',
        },
      },
      required: ['path'],
    },
    concurrency: 'safe',
    // v2.7.2, was 8000 tokens (~30KB). Pushed to 60000 (~240KB, ~120
    // pages of text). Rationale: model context windows are 128K–200K+
    // routinely now. Holding file_read to a fraction of that meant agents
    // got truncated mid-document on anything beyond a long blog post, then
    // either gave up, started over, or tried to "summarize" what they'd
    // half-read. The new cap lets a typical document land in one call.
    // Pagination via offset/limit still exists for the genuinely
    // outsized cases (whole books, sprawling logs).
    maxResultTokens: 60000,
  },
  {
    name: 'file_write',
    description: 'Write content to a file at the given absolute path. Creates parent directories if they do not exist. Overwrites existing files. Returns a download URL that works from anywhere (including remote access). Share the download URL with the user so they can access the file from any device. Example: file_write({ path: "/Users/me/output.txt", content: "Hello world" }).',
    effects: [{ kind: 'fs_write', from: 'args.path' }],
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute path to the file to write',
        },
        content: {
          type: 'string',
          description: 'Content to write to the file',
        },
      },
      required: ['path', 'content'],
    },
    // Writing an EMPTY file is a real thing agents do (truncating a log, laying
    // down a placeholder). Required, but "" is a legitimate value.
    fields: { content: { allowEmpty: true } },
  },
  {
    name: 'file_append',
    description: 'Append content to the end of a file at the given absolute path. Creates the file (and parent directories) if they do not exist. Use this for incremental writes, accumulating output across multiple turns, building a long doc one section at a time, logging progress to a scratchpad, instead of `file_write` (which overwrites everything) or the read-modify-rewrite cycle. The latter fills your context with the file\'s existing contents every time you want to add to it; `file_append` does not. Returns bytes appended, total file size, and a download URL.\n\nExample: file_append({ path: "/Users/me/notes.md", content: "\\n## Section 5\\nNew content here." }).\n\nBy default a leading newline is added if the existing file doesn\'t already end in one (so appended sections don\'t smush into the prior line). Set ensure_newline=false to append the exact bytes verbatim.',
    effects: [{ kind: 'fs_write', from: 'args.path' }],
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the file. Created if it does not exist.' },
        content: { type: 'string', description: 'Content to append.' },
        ensure_newline: { type: 'boolean', description: 'When true (default), prepend a newline to `content` if the existing file does not already end with one. Avoids accidentally concatenating two sections into one line.' },
      },
      required: ['path', 'content'],
    },
    // Same as file_write: an empty append is a no-op the caller may legitimately
    // ask for, and refusing it would be a new refusal.
    fields: { content: { allowEmpty: true } },
  },
  {
    name: 'file_patch',
    description: 'Surgically edit an existing file in place by find-and-replace, without rewriting the whole thing. Use this when you want to change a specific section of a file you have ALREADY read, the agent equivalent of opening a file, ctrl-F replacing a few strings, and saving. Strongly preferred over file_write for edits, because file_write requires you to reconstruct the entire file from memory and routinely drops content the model didn\'t explicitly type back.\n\nEach patch is `{ search, replace, replace_all? }`. The tool reads the file, applies every patch in order against the in-memory copy, and only writes to disk if every search string matched. If any patch\'s search string is not found, the call FAILS with a hard error and the file on disk is not touched, there is no silent no-op. Patches apply sequentially, so a later patch sees the result of earlier patches.\n\nExamples:\n  • Rename a heading: file_patch({ path: "/Users/me/site.html", patches: [{ search: "<h1>Old Title</h1>", replace: "<h1>New Title</h1>" }] })\n  • Replace every occurrence: file_patch({ path: "/Users/me/style.css", patches: [{ search: "color: red", replace: "color: var(--brand)", replace_all: true }] })\n  • Multiple edits at once: file_patch({ path: "...", patches: [{ search: "...", replace: "..." }, { search: "...", replace: "..." }] })\n  • Preview without writing: pass dry_run=true to see what would change without touching disk.\n\nWorks on any text file (encoding stays as-is on disk; the in-memory edit is utf-8). Refuses files that look binary. Refuses empty search strings.',
    effects: [{ kind: 'fs_read', from: 'args.path' }, { kind: 'fs_write', from: 'args.path' }],
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute path to the file to edit. Must already exist.',
        },
        patches: {
          type: 'array',
          description: 'Ordered list of find/replace operations. Each is applied against the current in-memory state of the file, so a later patch can match content produced by an earlier one. If any patch\'s search string is not found, the whole call fails and nothing is written.',
          items: {
            type: 'object',
            properties: {
              search: {
                type: 'string',
                description: 'Exact string to find. Whitespace and line endings count. Empty strings rejected.',
              },
              replace: {
                type: 'string',
                description: 'String to substitute in. Use empty string to delete the matched span.',
              },
              replace_all: {
                type: 'boolean',
                description: 'When true, replace every occurrence of search; default false (replace only the first).',
              },
            },
            required: ['search', 'replace'],
          },
        },
        dry_run: {
          type: 'boolean',
          description: 'When true, validate the patches and report what would change without writing to disk. Default false.',
        },
      },
      required: ['path', 'patches'],
    },
    fields: {
      patches: {
        requiredNotEnforced:
          'the handler rejects a missing/empty patches list with a SHAPE message the generic one would lose ' +
          '("patches must be a non-empty array of { search, replace } objects.") — see the file_patch case in executeToolInner',
      },
    },
    maxResultTokens: 2000,
  },
  {
    name: 'scratchpad_set',
    description: '**Use this INSIDE a tracker step, not instead of one.** Scratchpad is your in-flight working memory for the CURRENT iteration of work, which sources you\'ve read so far, what\'s left, decisions you\'ve made on this step. The engine re-injects it at the top of your context regardless of compaction, so it survives within a session.\n\n**Critical distinction**: scratchpad survives compaction but does NOT survive session reset, and is invisible to the user and PM. Only the tracker survives reset and is visible. **If you\'re using scratchpad without an open tracker project for non-trivial work, you\'ve made the wrong call**, the work will silently vanish on the next reset with no way to resume. For any work involving a deliverable, multiple steps, or more than ~3 tool calls, open `work_open(kind="project")` FIRST, then use scratchpad for the in-flight thinking inside each step.\n\nThe scratchpad is a single string; calling `scratchpad_set` REPLACES the current contents (it does not append). To make a small edit, copy the current scratchpad from the YOUR SCRATCHPAD block in your context, modify, and call this with the full new text. Cap is 8000 characters, if you\'re approaching that, move detail into a real file and keep the scratchpad as a high-level index. Clears automatically on session reset. Use `scratchpad_clear` to empty it mid-session.\n\nExample (in-flight research on step 2 of a tracker project):\n  scratchpad_set({ content: "## Current tracker step: Step 2, Cover sources A-D\\n\\n## Sources covered so far\\n- [x] /Users/me/notes/a.md (covered in §1)\\n- [x] /Users/me/notes/b.md (covered in §2)\\n- [ ] /Users/me/notes/c.md\\n- [ ] /Users/me/notes/d.md\\n\\n## Open questions\\n- Does Y depend on Z or vice-versa? (check c.md)" }).',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Full new scratchpad content. Replaces previous. Max 8000 chars.' },
      },
      required: ['content'],
    },
    // Setting the pad to "" is how an agent empties it without scratchpad_clear.
    fields: { content: { allowEmpty: true } },
  },
  {
    name: 'scratchpad_clear',
    description: 'Empty your scratchpad. Use when the task it was tracking is complete and the outline is no longer relevant. Scratchpad also auto-clears on session reset, so manual clear is mostly for "I finished, but the session keeps going" cases.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'file_list',
    description: 'List the contents of a directory at the given absolute path. Returns file names, sizes, and types. Example: file_list({ path: "~/projects" }).',
    effects: [{ kind: 'fs_read', from: 'args.path' }],
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute path to the directory to list',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'share_file',
    description: 'Get a download URL for an existing file so the user can access it from any device. Use this when the user asks for a link to a file, wants to download something, or you need to share a file that already exists on disk. Returns a full clickable URL. IMPORTANT: Give the user the URL exactly ONCE as plain text. Do NOT repeat it, do NOT wrap it in markdown, do NOT add extra formatting.',
    effects: [{ kind: 'fs_read', from: 'args.path' }],
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute path to the file to share (use ~ for home directory)',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'recall_recent_thread',
    description: '**Call this when you genuinely feel disoriented and the active context is not enough.** Common triggers: you just saw a `── Memory Compacted ──` divider and you\'re mid-task with no clear sense of what was just done; you switched models and lost reasoning state; you\'re about to start something and want to confirm what the user actually asked for; you suspect you might double-process work that was already done.\n\n**v2.7.10 note (IMPORTANT):** the engine no longer auto-runs this for you after compaction. Earlier versions secretly executed recall + injected the result as a system message on your next significant tool call; that caused context spirals (each compaction → auto-recall → bigger fresh tail → faster next compaction → bigger re-injection → ...). Now compaction is silent except for the divider, and YOU decide whether to call this. If you are confidently executing a scheduled task or a clear next step, DON\'T call it, your tracker tasks, equipped techniques, and active directives already carry the state you need. Calling unnecessarily wastes tokens and re-introduces stale content.\n\nReturns a clean transcript of the recent conversation read directly from your messages table (same data shown on the dashboard chat), regardless of what the assembler put in your active context. By default the last 8 user→assistant exchanges with tool *call* lines (file_read path=…, exec command=…). To recover **actual content** the agent saw earlier (file contents, web fetch bodies, search results), set `include_tool_results: true`, that switches on "wordy mode" which includes tool RESULTS up to a per-result char cap (default 1500). User/assistant message text is also capped per message (default 1500 chars, raise via `truncate_message_chars` up to 8000), anything truncated ends with a history_get pointer so you can fetch the full body. For longer lookback, paginate with `before_id` (the response footer tells you which id to pass). Cheap, read-only, safe to call anytime.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        turn_count: {
          type: 'number',
          description: 'How many of the most recent user→assistant exchanges to include. Default 8, max 30.',
        },
        include_tool_calls: {
          type: 'boolean',
          description: 'When true, include a one-line summary of each tool CALL ("[called: file_read path=…]"). Note: this only shows the call args, not the result. For tool RESULTS, set include_tool_results=true. Default true.',
        },
        include_tool_results: {
          type: 'boolean',
          description: '"Wordy mode", include tool RESULTS (file contents, web fetch bodies, exec stdout, etc.) up to truncate_tool_result_chars per result. Use this when you need to recover specific content the agent saw earlier. Default false (results omitted to keep transcript tight).',
        },
        truncate_tool_result_chars: {
          type: 'number',
          description: 'Per-tool-result character cap when include_tool_results=true. Default 1500, max 4000. Each truncated result ends with a history_get pointer for the full body.',
        },
        truncate_message_chars: {
          type: 'number',
          description: 'Per-message character cap for user/assistant text. Default 1500, max 8000. Each truncated message ends with a history_get pointer for the full body. Raise this when you need to read longer messages in full instead of paginating through history_get.',
        },
        before_id: {
          type: 'string',
          description: 'Pagination cursor, return turns OLDER than the message with this id. The response footer tells you which id to pass for the next slice. Omit on the first call to get the most recent turns.',
        },
        since: {
          type: 'string',
          description: 'Optional ISO timestamp, only include messages on or after this time. Useful for "show me everything since 2pm today" style lookbacks.',
        },
        scope: {
          type: 'string',
          enum: ['conversation', 'all'],
          description: 'Default "conversation", recall is limited to the conversation you are currently in (the person/thread this turn is about), so an unrelated task\'s output does not bleed in. Pass "all" only when you genuinely need to look across every recent conversation (e.g. "what have I been doing across everything?").',
        },
      },
      required: [],
    },
    maxResultTokens: 4000,
  },
  {
    name: 'history_search',
    description: 'Search through conversation history and memory summaries using full-text search or pattern matching. Returns matching messages and summaries with context. Example: history_search({ pattern: "budget meeting", limit: 10 }).\n\nResult format: each line starts with `[id=<short> <timestamp>] (role) <snippet>`. When a snippet is truncated, the line ends with `[snippet only, call history_get(id="…") for full N-char message]`, DO this rather than retrying history_search with a different pattern. Repeating history_search with variations of the same query when the snippet is already present will be loop-blocked. Use history_get to get the FULL message body once you have a hit.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'The search string. Canonical, preferred arg.',
        },
        // `query` is a declared alias for `pattern`, not a stray arg: the
        // executor honors it via `args.pattern ?? args.query` (case
        // 'history_search'). Declaring it here is what keeps the unknown-arg
        // detector from warning "silently ignored" about an arg we actually
        // honor, so schema and behavior tell the same story.
        query: {
          type: 'string',
          description: 'Alias for `pattern` (accepted for convenience; prefer `pattern`). Pass exactly one of the two.',
        },
        mode: {
          type: 'string',
          enum: ['full_text', 'regex'],
          description: 'Search mode: full_text (FTS5) or regex (LIKE fallback). Default: full_text',
        },
        scope: {
          type: 'string',
          enum: ['messages', 'summaries', 'both'],
          description: 'What to search: messages, summaries, or both. Default: both',
        },
        since: {
          type: 'string',
          description: 'Only search messages after this ISO timestamp',
        },
        before: {
          type: 'string',
          description: 'Only search messages before this ISO timestamp',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results to return (default: 20)',
        },
      },
      // Not ['pattern']: `pattern` is canonical but `query` is an accepted
      // alternate, so requiring pattern at the schema level would contradict the
      // executor, which accepts pattern-or-query and enforces "at least one
      // non-empty" itself (case 'history_search').
      required: [],
    },
    concurrency: 'safe',
    maxResultTokens: 4000,
  },
  {
    name: 'history_get',
    description: 'Look up the full content of a stored item by its ID. Accepts THREE id types:\n  - Summary IDs (sum_*), returns full summary text + metadata\n  - Large file IDs (file_*), returns the exploration summary + metadata\n  - Raw message UUIDs, returns the full message body\n\nUse this AFTER history_search when a snippet is truncated and you need the full message. history_search emits a ready-to-copy hint at the end of each truncated result line: `[snippet only, call history_get(id="…") for full N-char message]`. Copy the full UUID from inside those quotes, the short `id=<8chars>` shown at the start of the result line is for visual scanning only and is NOT enough.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'A summary ID (sum_*), large file ID (file_*), or full message UUID (from the parens in history_search\'s expand hint).',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'history_expand',
    description: 'Deep recall: walks the summary DAG to retrieve original source messages, optionally uses an LLM to synthesize an answer from expanded material. Use when summaries lack detail.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Optional search query to find relevant summaries to expand',
        },
        summary_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of specific summary IDs to expand',
        },
        prompt: {
          type: 'string',
          description: 'The question or instruction for the expansion, what you want to recall or understand',
        },
      },
      required: ['prompt'],
    },
  },
  // C27: memory_search (a self-described convenience wrapper around
  // history_search / former memory_grep) was DELETED; it is now a hidden alias
  // that routes to history_search with {query} -> {pattern}. See tools/aliases.ts.
  // ── Web Tools ──
  {
    name: 'web_search',
    description: 'Search the web using Brave Search. Returns up to 10 results with titles, URLs, and snippets. Requires a Brave Search API key to be configured.',
    effects: [{ kind: 'net', from: 'fixed:api.search.brave.com' }],
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query',
        },
        count: {
          type: 'number',
          description: 'Number of results to return (default: 5, max: 20)',
        },
      },
      required: ['query'],
    },
    concurrency: 'safe',
    maxResultTokens: 3000,
  },
  {
    name: 'web_fetch',
    description:
      'Fetch a URL and extract focused content matching your prompt. The tool fetches the page and uses a fast model to return ONLY what you asked for (~1-2K tokens), not the raw page (which can be 50K+). The `prompt` is REQUIRED, be specific. Requires network_domains permission.\n\nExamples:\n  web_fetch({ url: "https://...", prompt: "the main argument and 3 supporting points" })\n  web_fetch({ url: "https://...", prompt: "all pricing tiers and their dollar amounts" })\n  web_fetch({ url: "https://...", prompt: "the API endpoint table" })',
    effects: [{ kind: 'net', from: 'args.url' }],
    input_schema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The URL to fetch',
        },
        prompt: {
          type: 'string',
          description:
            'What to extract from the page. REQUIRED, be specific. The more focused the prompt, the more useful the extract.',
        },
      },
      required: ['url', 'prompt'],
    },
    fields: {
      prompt: {
        requiredNotEnforced:
          'the handler refuses a missing prompt with the message that TEACHES the parameter (an example call plus the ' +
          'reason — a prompt keeps the result ~1-2K tokens instead of dumping a 50K page); the generic message would drop it',
      },
    },
    concurrency: 'safe',
    maxResultTokens: 2000,
  },
  // ── Right Dock (shared workspace) ──
  {
    name: 'canvas_render',
    description:
      'Open a canvas in the user\'s right dock, a side panel where you and the user look at a working document together. The dojo interface slides left to make room and the canvas renders on the right. Use this to show the user something you have produced or have on disk: an HTML page, a Markdown doc, a plain-text/code file, a report, a chart, a mockup, or a Word / Excel / PDF document (these render as a formatted preview).\n\nNOTE: any canvas-renderable file already opens in the canvas automatically the moment you create it, writing one with file_write (HTML, Markdown, text, code, JSON, CSV, SVG, ...) and creating a Word / Excel / PDF document all auto-open. You usually do NOT need to call canvas_render at all. Use canvas_render to (re)show an existing file, or to render inline `html` / a `url`.\n\nThree ways to fill it (use ONE):\n  • `path`, the absolute path to a file on disk you wrote with file_write (e.g. "/Users/.../uploads/<agent-id>/report.md"). BEST for documents you will keep editing: HTML renders, Markdown renders formatted, text/code shows monospaced, and the canvas gets a download button. After you call canvas_render({path}), any later file_write / file_patch / file_append to that SAME path auto-refreshes the canvas, you do NOT need to call canvas_render again. For HTML, relative asset paths resolve against the file\'s own folder, so reference local images as <img src="photo.png"> with the image saved next to the .html file and it will render.\n  • `html`, inline HTML markup to render directly (runs sandboxed); no file needed. Inline markup cannot reference local files, embed images as data: URIs or write a file with the image beside it instead.\n  • `url`, content already hosted at a URL (a file_write download URL also works).\n\nExamples:\n  • canvas_render({ title: "Spec", path: "/Users/me/uploads/<agent-id>/spec.md" })\n  • canvas_render({ title: "Q3", html: "<h1>Q3</h1><p>...</p>" })',
    effects: [{ kind: 'fs_read', from: 'args.path' }, { kind: 'net', from: 'args.url' }],
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute path to a file on disk to show (html, markdown, text, code, image, or pdf). Preferred for documents you will keep editing, edits to this path auto-refresh the canvas. Provide ONE of path / html / url.',
        },
        html: {
          type: 'string',
          description: 'Inline HTML markup to render in the canvas. A full document or a fragment. Runs sandboxed (scripts allowed). Provide ONE of path / html / url.',
        },
        url: {
          type: 'string',
          description: 'A URL to load in the canvas (for example a file_write download URL). Provide ONE of path / html / url.',
        },
        title: {
          type: 'string',
          description: 'Optional short label shown in the canvas header.',
        },
      },
      required: [],
    },
    concurrency: 'safe',
  },
  {
    name: 'screen_broadcast',
    description:
      "Show the user THIS Mac's screen, live, in their right-dock canvas. Use this whenever the user wants to SEE your screen or control this Mac, phrasings like \"show me your screen\", \"let me see your screen\", \"share your screen\", \"can I see what you're doing\", \"open your screen so I can click something\".\n\nUse it proactively whenever you need a HUMAN to do something on THIS Mac that you can't do yourself: approve a macOS permission/confirmation dialog, hit OK on a prompt, or complete a sign-in / re-authenticate an account (e.g. a Google or Microsoft re-auth, which opens a login window in the browser on this Mac). The flow is: kick off the action that needs them (so the dialog or sign-in window appears on this Mac), then open the screen with this tool so they can take control and finish it. Judge local vs remote first: if the user is sitting AT this Mac, just ask them to do it on their screen directly, no need to share. If they're remote (over the tunnel) and can't reach the Mac, that's exactly when to open the screen. (One caveat to relay if it comes up: a few highly-secured macOS dialogs, like granting Accessibility/Screen Recording permissions, may refuse remote clicks and need someone physically at the Mac.)\n\nIt opens view-only. The user clicks \"Take control\" at the top of the canvas to use the mouse and keyboard, and enters the screen-sharing (VNC) password to connect, that's their second factor, on top of being logged in.\n\nThis only works if the user has turned the feature on in Settings > Integrations > Screen Sharing (it's disabled by default; one-time setup needs approval on the Mac). If it's off, calling this returns step-by-step setup instructions, relay them and offer to walk the user through enabling it. So if the user asks how to set up screen sharing, or you think it would help, just call this tool: when it's off you'll get the exact steps to guide them. Takes no required arguments.",
    effects: [{ kind: 'proc', from: 'derived:screen-share manager (osascript, admin)' }],
    input_schema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Optional short label shown in the canvas header (e.g. "Approve this dialog").',
        },
      },
      required: [],
    },
    concurrency: 'safe',
  },
  {
    name: 'open_browser',
    description:
      'Open a live website in the user\'s right dock so you and the user can view it together. The dojo interface slides left and the page loads in a resizable frame on the right with refresh and close controls. Use this for showing a real, working website at a URL (not your own generated markup, for that use canvas_render). Note: some sites refuse to load inside a frame; if a page comes up blank the site has blocked embedding. Example: open_browser({ url: "https://example.com", title: "Example" }).',
    effects: [{ kind: 'net', from: 'args.url' }],
    input_schema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The URL of the website to open in the dock.',
        },
        title: {
          type: 'string',
          description: 'Optional short label shown in the frame header.',
        },
      },
      required: ['url'],
    },
    concurrency: 'safe',
  },
  {
    name: 'canvas_read',
    description:
      'Look at what is currently shown in the user\'s right-dock canvas, use this when the user asks you to look at / read / check / review what is on the canvas. It views whatever you most recently opened there (with canvas_render or open_browser): an HTML page or website is screenshotted and described, an image is examined directly, and a markdown/text/code file is returned as text. Works even if your own model cannot see images (it falls back to the configured vision model). Pass an optional `prompt` to ask something specific (e.g. "does the chart axis start at zero?", "summarize the page", "is the header centered?"). To read a specific file/URL/HTML, open it first with canvas_render (or open_browser), then call canvas_read.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'Optional. What to look for or answer about the canvas. Omit for a general description.',
        },
      },
      required: [],
    },
    concurrency: 'safe',
  },
  // ── Multi-Agent Tools ──
  {
    name: 'spawn_agent',
    description: 'Create a new sub-agent to work on a task. This is THE tool for spawning sub-agents, do NOT try to create agents by writing files or inserting into the database. BEFORE spawning, call list_agents to check whether an agent with that name already exists and is still running; if so, use send_to_agent instead of spawning a duplicate. Returns the new agent ID for tracking.\n\nTIMEOUT (you own it): non-ronin sub-agents REQUIRE `timeout_minutes`, the number of minutes the sub-agent may run before YOU (its creator) are asked to decide. There is no default. When the timeout is reached the engine does NOT kill it, it notifies you and the sub-agent keeps running until you call spawn_timeout_decision(action="extend"|"terminate"). Size timeout_minutes to the task (a quick lookup ~5, a longer build ~30-60). For open-ended/scheduled work that should have no timeout, use classification="ronin" (ronin has no timeout and is dismissed only by the user).\n\nSQUADS (mandatory): every agent you spawn lands in a squad, so the owner can see which spawned agents belong to which work. If you pass a `task_id` linked to a project, the sub-agent joins (or the engine auto-creates) a squad NAMED AFTER THAT PROJECT and stamps the squad on the project; later spawns for the same project auto-join it. With no project link, pass `group_id` for a squad you own, or the engine auto-creates one named after you. The tool result names the squad it landed in. You can only dismiss squads you created (delete_group); user-created squads are dismissed only from the dashboard.\n\nTASK LINKAGE, IMPORTANT: if the apprentice is meant to do work tracked in the tracker, you MUST link the task to the agent OR the agent\'s work won\'t update the task on completion. Two valid patterns:\n  1. Pass `task_id` here at spawn time → the agent.task_id is set AND the task is REASSIGNED to the spawned agent (assigned_to = new agent), because you are delegating the work; complete_task then auto-marks the task complete. Pass keep_assignment=true to keep the task assigned to yourself.\n  2. After spawning, call work_open(kind="task") (or work_update(action="reassign")) with `assigned_to=<this agent_id>` → completeAgent\'s fallback finds the task by assignment.\nIf you create tasks before spawning the apprentices, those tasks default to assigned_to=YOU (the parent); passing task_id at spawn now hands the task off to the apprentice for you. Always one of: assign the task to the apprentice, or pass task_id at spawn.',
    effects: [{ kind: 'spawn', from: 'derived:sub-agent manifest (args.permissions, args.tools)' }],
    input_schema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'A regular human first name for the sub-agent (e.g. Dana, Marcus, Priya). Name it like you would name a person. Do NOT use a functional label such as "Cleaner", "File Remover", "Scraper", or "Worker"; pick an ordinary first name even for a throwaway one-shot helper.',
        },
        system_prompt: {
          type: 'string',
          description: 'The system prompt that defines the sub-agent\'s role and instructions',
        },
        model_id: {
          type: 'string',
          description: 'Model ID for the sub-agent. Call list_models first to see available IDs and capabilities. Pick based on task needs: cheaper/faster models for simple tasks, expensive ones for complex reasoning, vision-capable models for image work. Use "auto" for smart routing. Defaults to parent agent\'s model if omitted.',
        },
        permissions: {
          type: 'object',
          description: 'Optional permission manifest overrides for the sub-agent',
        },
        tools: {
          type: 'object',
          description: 'Optional tool access policy',
          properties: {
            allow: {
              type: 'array',
              items: { type: 'string' },
              description: 'Tool names to allow',
            },
            deny: {
              type: 'array',
              items: { type: 'string' },
              description: 'Tool names to deny',
            },
          },
        },
        timeout_minutes: {
          type: 'number',
          description: 'REQUIRED for non-ronin sub-agents: how many minutes this sub-agent may run before YOU (its creator) are asked to extend it or let it stop. There is no default. When it is reached the sub-agent is NOT killed, you are notified and must call spawn_timeout_decision. Size it to the task (a quick lookup ~5, a longer build ~30-60). Omit only for classification="ronin", which has no timeout and is dismissed only by the user.',
        },
        task_id: {
          type: 'string',
          description: 'Optional tracker task ID to associate with this agent. By default, linking a task here also REASSIGNS that task to the new agent (assigned_to = the spawned agent), because you are delegating the work to it, so the task tracks the agent actually doing it. Pass keep_assignment=true to keep the task assigned to you.',
        },
        keep_assignment: {
          type: 'boolean',
          description: 'Only meaningful with task_id. If true, the linked task stays assigned to YOU (the caller) instead of being reassigned to the spawned agent. Default false: spawning with a task_id hands that task off to the new agent. Use true when you are the one who will finish the task and the sub-agent is only a helper.',
        },
        context_hints: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional search terms to pull relevant context from parent memory into the sub-agent',
        },
        persist: {
          type: 'boolean',
          description: 'If true, agent stays alive after completing work, goes to idle instead of terminating, and is exempt from the timeout. Use for agents that need to handle multiple tasks or wait for scheduled tasks. Default: false.',
        },
        initial_message: {
          type: 'string',
          description: 'Custom initial message to send to the agent instead of the default task instructions. Use when you want full control over what the agent sees first.',
        },
        classification: {
          type: 'string',
          enum: ['apprentice', 'ronin'],
          description: 'How this agent is managed over its life. Choose deliberately:\n  - "apprentice" (default): short, throwaway sub-work that finishes in one push. It dies at its timeout (default 15 min), is cascade-killed when its parent stops, and can be terminated by other agents. This is the right, safe pick for ordinary work.\n  - "ronin": long-running, persistent, or scheduled work. It has NO timeout, survives its parent, and only the owner can dismiss it from the dashboard. Pick this deliberately when the job should outlive the 15-minute reap (a scheduled task, a long build, an agent that waits for future events). Do NOT set a timeout to work around a reap; use ronin instead.\n  - "sensei" is reserved platform staff and is not spawnable here.\nWhen in doubt, leave it as apprentice.',
        },
        share_user_profile: {
          type: 'boolean',
          description: 'If true, the sub-agent receives the user profile (USER.md) in its context, so it knows about the platform owner. Default: false.',
        },
        group_id: {
          type: 'string',
          description: 'Add this agent to an existing group by group ID.',
        },
        techniques: {
          type: 'array',
          items: { type: 'string' },
          description: 'Technique IDs to equip on this agent. Equipped techniques are pre-loaded into the agent\'s context so it can follow them without calling use_technique. Example: ["website-uptime-check"]',
        },
        always_loaded_tools: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional custom always-loaded tool list for this sub-agent. Saves round-trips when you know exactly which tools the agent will need. Example: for a web research agent: ["web_search", "web_fetch", "vault_remember"]. Omit to use sensible role-based defaults.',
        },
        auto_start: {
          type: 'boolean',
          description: 'If false, the agent is created but does NOT start working, it stays idle until something else wakes it (a task assignment, send_to_agent, etc.). Use this when you need to set up state across several apprentices before any of them runs (e.g. building a squad, customising prompts). Default: true.',
        },
      },
      required: ['name', 'system_prompt'],
    },
  },
  {
    name: 'kill_agent',
    description: 'Terminate, kill, delete, or remove a sub-agent immediately. This is THE tool for ending a sub-agent\'s life, do NOT try to delete database rows or kill processes manually. Also terminates any of its children. Use when a sub-agent is stuck, no longer needed, or misbehaving.\n\nOWNERSHIP: you can only kill sub-agents YOU created. Agents created by the user (from the dashboard) are dismissed only by the user; kill_agent refuses them. Ronin and sensei agents are also protected.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        agent_id: {
          type: 'string',
          description: 'The ID of the agent to terminate',
        },
      },
      required: ['agent_id'],
    },
  },
  {
    name: 'spawn_timeout_decision',
    description: 'Decide what happens to a sub-agent YOU spawned that reached its timeout. When a sub-agent hits its timeout the engine does NOT kill it, it notifies you (its creator) and keeps the sub-agent running until you decide here. Only the sub-agent\'s creator may call this (the user decides from the dashboard). Two actions:\n  - action="extend": give the sub-agent more time. Pass extend_minutes (a positive number). The timeout is reset and you will be asked again if it runs out.\n  - action="terminate": let the sub-agent stop. It is torn down cleanly and any in-progress tasks it held are auto-paused for reassignment.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        agent_id: {
          type: 'string',
          description: 'The ID of the sub-agent whose timeout you are deciding (the one named in the timeout notice you received).',
        },
        action: {
          type: 'string',
          enum: ['extend', 'terminate'],
          description: '"extend" to give it more time (requires extend_minutes), or "terminate" to let it stop.',
        },
        extend_minutes: {
          type: 'number',
          description: 'Only with action="extend": how many more minutes to give the sub-agent (a positive number). Ignored for terminate.',
        },
      },
      required: ['agent_id', 'action'],
    },
  },
  {
    name: 'send_to_agent',
    description: '**USE THIS TOOL when responding to any inbound message that starts with `[A2A:` or `[SOURCE: AGENT MESSAGE FROM`.** Other agents CANNOT see your chat, they only see what you send via this tool. If you write a chat reply instead of calling send_to_agent on an inter-agent turn, the originating agent gets nothing and the engine will nudge you to retry. The pattern: do the work, call send_to_agent once with the right intent on the same thread_id, end your turn. Do not also write a chat summary, it\'s invisible to the originator and gets suppressed by the engine.\n\nSend a structured message to another agent. Every message MUST specify an intent, there is no default. The intent controls whether the receiver wakes to act. **Default to a wake intent unless you are certain the receiver has nothing to do with the message.** Wake intents (receiver wakes): QUESTION, ASSIGN, BLOCK (open thread, response expected); ANSWER, DELIVERABLE (close thread but receiver still wakes because they were waiting); COMPLETE, FAIL (close thread and wake, receiver almost always needs to react to your work being done or failed: forward, notify, decide next step). No-wake intents (ambient context only, receiver does NOT wake): FYI, STATUS. Use FYI/STATUS only when the content is genuinely just for awareness and requires no action. Messages are grouped by thread_id, omit to start a new thread, or include the thread_id from the inbound message to reply on that thread. Silence is a valid response. Do not acknowledge acknowledgements.\n\nTracker integration: when you use intent="ASSIGN", the DOJO automatically creates a tracker task assigned to the receiver. You do NOT need to call work_open, the task is structurally created at delivery time. The tool result returns the task ID so you can track progress with work_update(action="get"). The receiver gets the task ID in their incoming message and is told to close it with work_update(action="status") when done. This means PM can spot stalled assignments automatically. Use ASSIGN whenever the work is multi-step; use QUESTION or BLOCK for one-shot exchanges that don\'t need tracking.',
    effects: [{ kind: 'send', from: 'args.agent' }, { kind: 'fs_read', from: 'args.attach_paths[]' }],
    input_schema: {
      type: 'object',
      properties: {
        agent: {
          type: 'string',
          description: 'Agent ID or agent name to send the message to',
        },
        intent: {
          type: 'string',
          enum: ['QUESTION', 'ASSIGN', 'ANSWER', 'DELIVERABLE', 'FYI', 'STATUS', 'COMPLETE', 'FAIL', 'BLOCK'],
          description: 'REQUIRED. Choose by asking: does the receiver need to act on this message? If yes → QUESTION (you need an answer), ASSIGN (you are handing off work), BLOCK (you are stuck), ANSWER (replying to a prior question with the content they need to continue), or DELIVERABLE (here is the thing they asked for). If no → FYI (informational), STATUS (progress update), COMPLETE (you finished your part), FAIL (you could not). When in doubt and the receiver is waiting on you for something, use a wake intent.',
        },
        payload: {
          type: 'string',
          description: 'The message content',
        },
        thread_id: {
          type: 'string',
          description: 'Thread ID to continue a conversation. Omit to start a new thread. Use the same thread_id from a received message to reply on that thread.',
        },
        requires_response: {
          type: 'boolean',
          description: 'Optional override. By default the intent decides: QUESTION/ASSIGN/BLOCK/ANSWER/DELIVERABLE wake the receiver, FYI/STATUS/COMPLETE/FAIL do not. Only override when you have a specific reason, usually you should just pick the right intent.',
        },
        attach_paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional file paths to attach (images, PDFs).',
        },
      },
      required: ['agent', 'intent', 'payload'],
    },
    fields: {
      intent: {
        requiredNotEnforced:
          'the handler refuses a missing/invalid intent with the full WAKE-INTENT ENUMERATION and what each one means — ' +
          'the message exists because a silent FYI default once left wake-needing messages dead on arrival',
      },
      payload: {
        requiredNotEnforced:
          'the handler accepts `message` as an ALIAS for `payload` (args.payload ?? args.message), which the schema ' +
          'cannot express — enforcing `payload` here would REFUSE a call that works today',
      },
    },
  },
  {
    name: 'broadcast_to_group',
    description: 'Send a message to every agent in a group at once. This is THE tool for group-wide announcements, status updates, or coordinating a squad. Each member receives it as if via send_to_agent. Like send_to_agent, intent is REQUIRED, choose carefully because broadcasting a wake intent will wake every member of the group.',
    effects: [{ kind: 'send', from: 'args.group_id' }],
    input_schema: {
      type: 'object',
      properties: {
        group_id: {
          type: 'string',
          description: 'The group ID to broadcast to',
        },
        intent: {
          type: 'string',
          enum: ['QUESTION', 'ASSIGN', 'ANSWER', 'DELIVERABLE', 'FYI', 'STATUS', 'COMPLETE', 'FAIL', 'BLOCK'],
          description: 'REQUIRED. Same semantics as send_to_agent. Wake intents (QUESTION/ASSIGN/BLOCK/ANSWER/DELIVERABLE) wake EVERY member of the group, use sparingly. Most broadcasts should be FYI or STATUS.',
        },
        message: {
          type: 'string',
          description: 'The message to send to all group members',
        },
      },
      required: ['group_id', 'intent', 'message'],
    },
    fields: {
      intent: {
        requiredNotEnforced:
          'same as send_to_agent — the handler refuses a missing/invalid intent with the enumeration and the ' +
          'wake-everyone warning that the generic message would lose',
      },
      message: {
        requiredNotEnforced:
          'the handler reads args.payload ?? args.message, so a broadcast passing `payload` (the send_to_agent spelling) ' +
          'works today; enforcing `message` here would REFUSE it — an ALIAS the schema cannot express',
      },
    },
  },
  {
    name: 'complete_task',
    description: 'Signal that the current agent has finished its assigned work. This terminates the agent and delivers the `summary` field to the parent agent for internal consumption. **The summary IS your report, do not write a parallel user-facing chat message announcing completion.** Closeouts are silent. After this call returns, just stop; do not write "Done", "Task complete", "All set" or any similar wrap-up line. Only use when you are a sub-agent that has completed its task.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['complete', 'fallen', 'blocked'],
          description: 'Completion status',
        },
        summary: {
          type: 'string',
          description: 'A summary of what was accomplished or why it failed/blocked',
        },
        results: {
          type: 'string',
          description: 'Optional detailed results or output data',
        },
      },
      required: ['status', 'summary'],
    },
  },
  // ── Work Tools (PHASE-2 T8V: 24 verbs collapsed onto six) ──
  // Every operation the retired twenty-four performed is still reachable; each
  // verb selects one by a discriminator, and `tools/work-verbs.ts` is the single
  // place a (name, args) pair is turned back into that operation. The weak-model
  // training the retired defs carried — status synonyms, 8-char-prefix AND title
  // resolution, same-status NO-OP, absorb-don't-refuse, the END-OF-TURN DECISION
  // MATRIX, and the recurring-schedule integrity gate — is LIFTED here verbatim,
  // not rewritten. Old names still route (tools/aliases.ts) for one release.
  {
    name: 'work_open',
    description: 'Open a new piece of work. `kind` picks what: "project" (multi-step work with tasks), "task" (a single piece of work, optionally scheduled or recurring), "reminder" (something to tell the user at a time), "commitment" (a promise you just made).\n\n**Open a project or task BEFORE starting any work that has a deliverable, requires multiple steps, or takes more than ~3 tool calls.** The work board is your durable plan, it survives compaction, session resets, and agent restarts; your context does not. Source files you read get summarized; work rows do not. For anything beyond a one-shot Q&A, this is your safety net against losing the plan halfway through.\n\nDon\'t try to predict whether you\'ll finish in one push, you usually can\'t, and the failure mode is silent context loss followed by writing the deliverable from your own summarized memory (i.e. confabulating). The cost of opening an entry you didn\'t end up needing is zero. The cost of NOT opening one for work that turns out to be multi-step is 30+ minutes of stalled work, PM pokes, and lost context.\n\n**Cheap to open, just a title and a level is enough.** You don\'t need to know every task upfront. Add tasks incrementally with `work_open(kind="task", project_id=…)` as you discover the shape of the work. If you\'re unsure whether to open one, open one.\n\nASSIGNMENT MATTERS (read once, internalize): nested tasks default `assigned_to=YOU` (the calling agent) when not specified. If apprentices will do the work, either spawn them FIRST and pass their agent_id in each task\'s `assigned_to`, or spawn them with `task_id` pointing at tasks already created here. If neither happens, apprentice work won\'t close out the tasks.\n\n**kind="task"** can run immediately, at a scheduled time, or on a repeating schedule. To schedule: set scheduled_start to an ISO8601 datetime (e.g., "2026-03-20T22:35:00Z"). To repeat: also set repeat_interval and repeat_unit (e.g., repeat_interval=2, repeat_unit="hours" for every 2 hours). Use repeat_end_type="after_count" with repeat_end_value="3" to stop after 3 runs. Use get_current_time to find the current time, then add minutes/hours for the start time. Tasks without scheduled_start run immediately when assigned.\n\n**kind="reminder"** sets a reminder for the user. When the scheduled time arrives, you (the agent) will be woken with the reminder text and should deliver it to the user as a single short chat message in your normal voice, no preamble like "Reminder:" or "Here\'s your reminder", just say the thing. **If the user did not specify a time, call this WITHOUT `when`.** The tool will return an instruction telling you to ask the user. Get their answer, then call `get_current_time` to resolve relative phrases ("in 5 minutes", "tomorrow at 8am"), and re-call with `when` set to the resolved ISO 8601 datetime. Do not invent a time, always ask. Use kind="reminder" whenever the user asks to be reminded of something, NOT kind="task": reminders get a lighter scheduler prompt that produces a natural one-line message instead of the generic "[Scheduled Task, Run #1]" boilerplate.\n\n**kind="commitment"** records a promise you just made, at the moment you make it. When you tell someone "I\'ll do X", "I\'ll send that after Y", or "I\'ll get back to you on this", call this straight away with what you promised in `description`, in your own words. It becomes a tracked item you still owe, shown back to you in the "OPEN WORK" block until it is delivered or dropped. This is bookkeeping, do NOT write a user-facing message about it, and do NOT use it for work you have already finished this turn. Use kind="task" instead when the promise is a piece of project work that belongs on the board.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['project', 'task', 'reminder', 'commitment'],
          description: 'What to open. Omit and the engine infers it from the fields you passed (`what` → reminder, `tasks`/`level` → project, `description` with no title → commitment, otherwise task).',
        },
        title: workProp('title', 'Project or task title.'),
        description: workProp('description', 'Project/task description. For kind="commitment": what you promised, in one line, in your own words (e.g. "email Bob the roof quote after the site visit").'),
        level: { type: 'number', description: 'Project only. Importance level: 1 (routine), 2 (important), 3 (critical).' },
        tasks: {
          type: 'array',
          description: 'Project only. REQUIRED for kind="project": at least one task. The engine refuses project creation with zero tasks, a project with nothing to do can\'t be poked, completed, or audited, and silently strands work. If you don\'t know every task upfront, that\'s fine, just put down the FIRST concrete thing you\'ll do (e.g. "scope the deliverable", "draft outline", "pull source data"). Add more later with work_open(kind="task", project_id=…) as the shape clarifies.',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              description: { type: 'string' },
              assigned_to: { type: 'string' },
              priority: { type: 'string', enum: ['high', 'normal', 'low'] },
              step_number: { type: 'number' },
              depends_on: { type: 'array', items: { type: 'string' } },
              phase: { type: 'number' },
            },
            required: ['title'],
          },
        },
        project_id: workProp('project_id', 'Task only. Optional project ID to attach this task to.'),
        assigned_to: workProp('assigned_to', 'Task only. Agent ID or name to assign this task to.'),
        assigned_to_group: workProp('assigned_to_group', `Task only. ${WORK_FIELD_TEXT.assigned_to_group.canonical}`),
        // The one structural divergence of the 17 (see work-verb-schema.ts): work_open
        // constrains priority to an enum and work_update does not. Applied HERE, named
        // rather than harmonised — closing it would add a constraint work_update's wire
        // does not carry today.
        priority: workProp('priority', 'Task priority (default: normal).', { enum: [...WORK_PRIORITY_ENUM] }),
        step_number: workProp('step_number', 'Step number for ordered execution.'),
        depends_on: workProp('depends_on', 'Task IDs that must complete before this task can start.'),
        phase: workProp('phase', 'Phase number for phased execution.'),
        goal: workProp('goal', 'The definition of done. PM compares the close-out result against it.'),
        what: {
          type: 'string',
          description: 'Reminder only. What to remind the user about, in their own words. ("go get coffee", "call mom", "stand up and stretch")',
        },
        when: {
          type: 'string',
          description: 'Reminder only. ISO 8601 datetime for when the reminder should fire (e.g. "2026-05-19T14:35:00Z"). Omit if the user did not specify a time, the tool will tell you to ask them. Call get_current_time first to resolve relative phrases like "in 5 minutes".',
        },
        scheduled_start: workProp('scheduled_start', `Task only. ${WORK_FIELD_TEXT.scheduled_start.canonical}`),
        repeat_interval: workProp('repeat_interval', WORK_FIELD_TEXT.repeat_interval.canonical),
        repeat_unit: workProp('repeat_unit', WORK_FIELD_TEXT.repeat_unit.canonical),
        repeat_days_of_week: workProp('repeat_days_of_week', WORK_FIELD_TEXT.repeat_days_of_week.canonical),
        repeat_end_type: workProp('repeat_end_type', 'When to stop repeating. For repeating work that should stop after N runs, set repeat_end_type="after_count" and repeat_end_value="N". If omitted, it repeats forever.'),
        repeat_end_value: workProp('repeat_end_value', WORK_FIELD_TEXT.repeat_end_value.canonical),
        anchor_time: workProp('anchor_time', WORK_FIELD_TEXT.anchor_time.canonical),
        allow_duplicate: {
          type: 'boolean',
          description: 'Set true to bypass the near-duplicate guard. The engine refuses creation if you already opened a similarly-titled project in the last 60 minutes (task: 5 minutes) — it catches the post-compaction "I forgot I already opened this" failure mode and runaway loops where an error causes duplicates instead of recovery. Only override when the new work is genuinely unrelated work that happens to share keywords.',
        },
      },
      required: [],
    },
  },
  {
    name: 'work_update',
    description: 'Update, read, or close existing work. `action` picks what: "status" (change a task\'s status), "edit" (change structural fields on a task or project), "reassign", "complete_step" (finish a step and start the next), "close_project" (close a whole project and its open tasks), "list" (see active work), "get" (full detail on one item).\n\n**action="status" — END-OF-TURN DECISION MATRIX** - before you end any turn with an in_progress task assigned to you, pick exactly one:\n\n  1. **You finished the task** → status="complete" (or use action="complete_step" if multi-step project, auto-advances to the next step).\n  2. **You\'ll take the next action on this same turn** → leave status="in_progress", just call the next tool now. Do not end the turn.\n  3. **You are waiting on the USER to do something they already know about** (you just asked them, e.g., "please reboot the ESP", "send me the file", "approve X") → status="paused" with notes explaining what you\'re waiting for. **Paused tasks are INVISIBLE to the PM agent, no pokes, no nags, ever.** The user resumes the task by replying or by manually flipping the status. This is the right call for ALL "I asked the user and now I\'m waiting" situations.\n  4. **You are blocked by something the user does NOT know about yet** (missing API key, external service down, you need a decision the user hasn\'t been asked about) → status="blocked" with notes. **This escalates**, the PM surfaces it to the primary user as a BLOCKED issue. Use this for "someone needs to know something is wrong."\n  5. **The whole project is no longer relevant** → use action="close_project" with reason. Not a status change.\n\n**Difference between paused and blocked:** paused = "user has the ball, I\'m on standby, no escalation needed." blocked = "this needs attention." When in doubt with a user-facing question already asked, pick paused.\n\n**NEVER leave a task in_progress when you go idle UNLESS option 2 applies.** If you go idle with status=in_progress, the PM will poke you after ~2 minutes assuming you stalled, and you\'ll get nudged to either pause/block or close it out. Skip the noise by transitioning correctly at end of turn.\n\nFor recurring tasks: if you completed ALL iterations in a single run, set `complete_all_runs=true` to stop the schedule entirely.\n\n**For multi-step projects, prefer action="complete_step" over action="status"**, it auto-advances to the next step so you don\'t accidentally leave the project with no task in_progress. Marks this task "complete" and moves the next step (by step_number) to "in_progress", and checks whether the entire project is now complete. Using status=complete to mark a step complete leaves the project with no in_progress task and is the most common cause of "agent finished a batch but the next batch never started." Call it the moment you finish a step, don\'t batch up multiple completions.\n\n**Close-outs are silent, ALWAYS, not just for scheduler-triggered tasks.** After a status change to complete (or paused/blocked/fallen), and after every step completion, do NOT write a trailing user-facing message about it ("Task closed", "All done", "Marked complete", "All set", "Smoke test passed", "All three cleared", "You\'re set", "Step closed", "Moving to next step"). The tool result is the only acknowledgment needed; the board shows the change directly. The user already saw your work above; a closeout line is noise. This applies to every kind of work, assigned by the user, auto-created from a chat message, scheduler-triggered, wakeup-triggered, manually created.\n\n**action="edit"** changes any structural field on a task, title, description, dependencies, step ordering, schedule (including the day-of-week list for "specific_days" recurrence), priority, notes. Pass any subset. Editing any schedule field automatically recomputes next_run_at so the scheduler picks up the change. Pass `project_id` instead of `task_id` to rename a project or change its description — use that when a project was auto-named badly (the engine\'s multi-step classifier names projects with a slice of the user prompt, which often reads poorly on the kanban) or when scope shifts and the title no longer describes the work. Use action="status" for status changes, action="reassign" for assignee changes, and work_schedule for pause/resume, those have side-effects edit intentionally skips.\n\n**action="close_project"** closes an entire project AND every open task on it in one call. Use it when you want to abandon a project, when you discover a duplicate, when scope changed and the work is no longer relevant, or when every remaining task has genuinely been completed but is still showing as open. Pass status="cancelled" for abandoned/duplicate/scope-change cases (the default, leaves a "cancelled" marker on each task) and status="complete" only when all the work was actually done. `reason` is required and gets appended as a note on every task closed, this is the audit trail for whoever sees the kanban next. Far better than looping action="status" one task at a time, and the only correct response when the engine tells you a project of yours is stranded (open tasks left behind on an abandoned project).\n\n**action="list"** lists active projects and tasks with their status, assignee, and priority. Default returns compact rows (no descriptions); pass verbose=true for descriptions on every result. **action="get"** returns the full details of ONE task or project, including description/instructions, notes, dependencies, step number, assigned agent, and timestamps — use it to read the instructions for any task. Accepts a full UUID or an 8+ char prefix from a list, as `id`, `task_id`, or `project_id` (all accepted).',
    effects: [],
    nonEffects: {
      'evidence[].pointer': 'RULING (T1): a polymorphic locator — file path, audit-log timestamp, URL or free text — STORED on the evidence row for a human PM to open, never dereferenced by the platform. Declares no effect today; if a reader is ever added that fetches or opens it, that reader declares the effect here',
    },
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'edit', 'reassign', 'complete_step', 'close_project', 'list', 'get'],
          description: 'Which update to perform. Omit and the engine infers it from the fields you passed (`status` → status, `assigned_to` → reassign, a `project_id` with a `reason` → close_project, editable fields → edit, a bare id → get, nothing → list).',
        },
        task_id: { type: 'string', description: 'The task ID (full UUID or 8+ char prefix). For action="complete_step", the step you just completed.' },
        project_id: workProp('project_id', 'The project ID (full UUID or 8+ char prefix). Used by action="edit" (rename a project), "close_project", and "get".'),
        id: { type: 'string', description: 'Alias for task_id / project_id on action="get".' },
        status: {
          type: 'string',
          enum: ['on_deck', 'in_progress', 'complete', 'blocked', 'fallen', 'paused', 'cancelled'],
          description: 'action="status": the new status. Quick reference: "in_progress" = actively working / about to take an action this turn. "complete" = done. "paused" = waiting on the user (already asked them), PM ignores entirely, no pokes. "blocked" = needs escalation/attention, PM surfaces this to the primary user. "on_deck" = queued, not yet started. "fallen" = abandoned/dropped, kept for history. action="close_project": the terminal status for the project and every open task, "complete" | "cancelled" (default "cancelled").',
        },
        notes: {
          type: 'string',
          description: 'For paused (min 15 chars, names a specific external trigger) or blocked (min 15 chars, names the obstacle). On complete, use the `result` field instead, not notes. On action="edit", REPLACES the notes field (to append instead, use work_note). On action="complete_step", notes about what was done in this step.',
        },
        result: { type: 'string', description: 'Required when status="complete". Non-empty string describing what was accomplished. PM compares this to the goal.' },
        evidence: {
          type: 'array',
          description: 'Required when status="complete". Non-empty array of text-only evidence records. Each entry is {kind, claim, pointer?}. Supported kinds: claim, file_modified, file_read, tool_call_ref, output_paste, external_action, quote. Engine enforces structure; PM reads content and judges substance. Example: [{kind:"file_modified", claim:"updated 12 routes", pointer:"packages/server/src/gateway/routes/"}, {kind:"tool_call_ref", claim:"18 file_edit calls succeeded"}].',
          items: {
            type: 'object',
            properties: {
              kind: { type: 'string', description: 'One of: claim, file_modified, file_read, tool_call_ref, output_paste, external_action, quote.' },
              claim: { type: 'string', description: 'Non-empty text statement of what this evidence shows.' },
              pointer: { type: 'string', description: 'Optional: file path, audit-log timestamp, URL, or other locator PM can use to verify.' },
            },
            required: ['kind', 'claim'],
          },
        },
        resume_at: {
          type: 'string',
          description: 'For paused tasks only: ISO 8601 datetime when the task should auto-resume (e.g., "2026-04-20T15:00:00"). The system will automatically restore the task to its pre-pause status at this time. Omit for an indefinite pause (resume manually). Always call get_current_time first to establish the current time before setting this.',
        },
        complete_all_runs: {
          type: 'boolean',
          description: 'For recurring tasks only: if true, marks ALL remaining runs as complete and stops the schedule. Use when you handled all iterations in a single run.',
        },
        reason: { type: 'string', description: 'Required for action="close_project". A short sentence on why you are closing the project. Gets appended as a note on every closed task, this is the audit trail for the user.' },
        assigned_to: workProp('assigned_to', 'action="reassign": agent ID to assign to (use this OR assigned_to_group, not both).'),
        assigned_to_group: workProp('assigned_to_group', WORK_FIELD_TEXT.assigned_to_group.onUpdate),
        title: workProp('title', 'action="edit": new title.'),
        description: workProp('description', 'action="edit": new description/instructions. Pass an empty string to clear.'),
        goal: workProp('goal', 'action="edit": edit the definition of done. Both the prior and new goal are logged so PM can see the history when validating. Editing the goal narrower after work started will be flagged by PM as goalpost-moving.'),
        depends_on: workProp('depends_on', 'action="edit": replace the dependency list with these task IDs. Pass [] to clear all dependencies.'),
        step_number: workProp('step_number', 'action="edit": new step number within the project (1-indexed).'),
        phase: workProp('phase', 'action="edit": new phase number within the project.'),
        // No enum here, deliberately — see work-verb-schema.ts. work_open constrains this
        // field and work_update never has; adding the enum would change what the wire
        // carries and what a strict provider accepts, which is not S2's scope.
        priority: workProp('priority', 'Priority: "high" | "normal" | "low".'),
        scheduled_start: workProp('scheduled_start', WORK_FIELD_TEXT.scheduled_start.onUpdate),
        repeat_interval: workProp('repeat_interval', WORK_FIELD_TEXT.repeat_interval.onUpdate),
        repeat_unit: workProp('repeat_unit', WORK_FIELD_TEXT.repeat_unit.onUpdate),
        repeat_days_of_week: workProp('repeat_days_of_week', WORK_FIELD_TEXT.repeat_days_of_week.onUpdate),
        repeat_end_type: workProp('repeat_end_type', 'action="edit": how the recurrence ends.'),
        repeat_end_value: workProp('repeat_end_value', WORK_FIELD_TEXT.repeat_end_value.onUpdate),
        anchor_time: workProp('anchor_time', WORK_FIELD_TEXT.anchor_time.onUpdate),
        filter: { type: 'string', enum: ['all', 'mine', 'blocked', 'overdue'], description: 'action="list": filter to apply (default: all).' },
        verbose: { type: 'boolean', description: 'action="list": if true, include each task\'s description (truncated to 200 chars). Default false (compact rows).' },
      },
      required: [],
    },
    maxResultTokens: 3000,
  },
  {
    name: 'work_note',
    description: 'APPEND a timestamped note to a task. Preserves all prior notes - each call adds a new `[ISO timestamp] <your text>` line. Good for progress logs and issue trails. **Does NOT replace the existing notes.** To replace the entire notes field with new content, call work_update({action:"edit", task_id, notes}).\n\n**CRITICAL - this is a checkpoint, NOT a stopping point.** Adding a note does not pause your work. If the task is still in_progress after you write the note, CONTINUE EXECUTING the project on the same turn - call the next tool, do the next step, do not just end the turn. Only end your turn when (a) you have completed a meaningful chunk that needs user acknowledgement, OR (b) you have hit a genuine blocker. In either case, your final assistant message must explicitly say WHY you stopped ("completed step 3, waiting on user input about X", "blocked - can\'t proceed without Y"). A silent stop after a note leaves the user staring at idle progress with no idea what is happening.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'The task ID to append notes to.' },
        notes: { type: 'string', description: 'The note text to append (will be prefixed with a timestamp).' },
      },
      required: ['task_id', 'notes'],
    },
  },
  {
    name: 'work_close_request',
    description: 'Ask for a close you cannot make yourself (Key 1 of the two-key close). `action` picks which ask:\n\n**action="override"** queues an explicit ask for the PM (or the user via dashboard) to force a status change that the engine\'s hard gate refused, OR that you believe the PM\'s last rejection got wrong. Auto-fired by the engine when the hard-gate circuit-breaker trips after 3 consecutive same-task hard-gate rejections by you (in which case you do NOT need to call this yourself, the engine queued it on your behalf). `justification` must be at least 30 characters explaining concretely why the engine/PM was wrong. Rate limit: at most one pending request per (task, you) at a time. Auto-denied after 12 hours if PM does not resolve.\n\n**action="user_verdict"** is only callable on tasks where the engine has flagged a stalemate (after revert_count crossed the per-priority threshold of high=2/normal=3/low=5). It composes a user-facing message describing the stalemate and routes it to the user (direct chat if you are primary, A2A relay through primary otherwise). The user\'s reply becomes the final verdict, applied via work_validate({action:"apply_user_verdict"}).\n\n**action="commitment"** closes an item from the OPEN WORK block once you have actually delivered it, or drops it when it is no longer owed. Call it with the id in [brackets] exactly as shown. Use disposition "kept" the moment you deliver the thing — that only works if the message or file really went out this turn, because a promise is kept by delivering it, not by saying so. Use disposition "dropped" when the person told you to forget it or it no longer applies. If you are unsure whether it is truly done, leave it open — an unfulfilled promise is meant to survive until it is actually fulfilled.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['override', 'user_verdict', 'commitment'],
          description: 'Which ask. Omit and the engine infers it (a `disposition` or a `cmt:` id → commitment, `status_requested` → user_verdict, otherwise override).',
        },
        task_id: { type: 'string', description: 'Task ID for action="override" / "user_verdict".' },
        requested_status: { type: 'string', description: 'action="override": the status you want the task to land in (e.g. "complete", "blocked").' },
        justification: { type: 'string', description: 'action="override": at least 30 characters. Why was the engine/PM wrong? Be specific.' },
        status_requested: { type: 'string', description: 'action="user_verdict": the status you believe is correct (presented as your ask to the user).' },
        agent_summary: { type: 'string', description: 'action="user_verdict": at least 30 characters. One-paragraph recap of what you did.' },
        pm_rejection_summary: { type: 'string', description: 'action="user_verdict": at least 20 characters. One-paragraph recap of PM\'s stated objections.' },
        id: { type: 'string', description: 'action="commitment": the id shown in [brackets] in the OPEN WORK block, e.g. "cmt:1a2b3c4d5e6f".' },
        disposition: {
          type: 'string',
          enum: ['kept', 'dropped'],
          description: 'action="commitment": "kept" = you delivered it this turn. "dropped" = it is no longer owed.',
        },
        note: { type: 'string', description: 'action="commitment": short note on how it was resolved or why it was dropped (for the log; not shown to the user).' },
      },
      required: [],
    },
  },
  {
    name: 'work_validate',
    description: '**PM AGENT ONLY** (the owner reaches these through the dashboard). Key 2 of the two-key close: adjudicate somebody else\'s claim. `action` picks which:\n\n**action="validate"** adjudicates an agent\'s status claim. Pass `kind`:\n  - "pause": is the pause legitimate? valid=true if the reason names a real, specific external trigger the agent actually requested (e.g. "waiting for user to reboot ESP", "waiting for vendor tracking number"); valid=false if vague, complains about the PM, or is really a block. (Call for every UNVALIDATED_PAUSE in the situation report.)\n  - "complete": does the goal match the result + evidence? Read the file/audit-log/output named in evidence first, do NOT validate on prose alone. valid=false when the evidence does not demonstrate the goal.\n  - "blocked": is the block real and external (no workaround the agent could try)? valid=false when the agent has not attempted the work, has not asked a question they could ask, or the "block" is confusion.\nOn valid=true the status stands (per-kind side effects: complete fires the dependency cascade / archives a recurring per-run and resets to on_deck; blocked notifies the primary to investigate). On valid=false the task reverts to target_status (default in_progress) and the assigned agent gets the one-sentence directive in reject_reason.\n\n**action="retask"** sends a task back to its assigned agent with explicit corrective instructions. Use when the agent\'s outcome is wrong (work skipped, wrong channel, evidence doesn\'t match goal, claim doesn\'t match actual artifact) and you want them to redo it, instead of just confirming a pause or rejecting a complete. Works from any non-terminal status. Resets validation flags, increments revert_count, delivers the directive over A2A. `directive` must be at least 30 chars and concrete (what they did wrong + what to do instead). Distinct from validate(kind="pause", valid=false): that\'s reactive (adjudicating an existing pause); retask is proactive (redirecting the agent\'s effort). PROTECTED: if the task\'s work was already delivered to the user (a Key-1 close request is filed awaiting validation, or a legacy delivered flag), retask REFUSES unless you pass allow_regenerate=true, so delivered work is not silently regenerated and overwritten.\n\n**action="override"** resolves a queued OVERRIDE_REQUEST. Approve forces the requested status through (bypassing the engine hard gate); deny notifies the agent the engine was right. Distinct from a bare status change: override is for resolving an explicit pending request.\n\n**action="apply_user_verdict"** — call ONLY when a task is awaiting a user verdict. Apply the user\'s reply to that stalemate. Quote the user\'s exact words in user_quote for the audit log. The status flips immediately with the user as the authority, the validation flag for that status is set, revert_count resets, and the stalemate flag clears. The user\'s authority is supreme, PM is told not to revisit.\n\n**action="apply_user_validation"** — call ONLY when the user replied to a "[VALIDATION CHECK]" message in chat. The engine asks the user about a task that has been sitting unvalidated for 5 minutes. The user\'s reply tells us whether the work was actually done. validated=true confirms it (clears the bug icon). validated=false reverts the task to in_progress and pings the assigned agent with any feedback the user provided. Quote the user\'s exact reply in user_quote for audit.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['validate', 'retask', 'override', 'apply_user_verdict', 'apply_user_validation'],
          description: 'Which adjudication. Omit and the engine infers it (`directive` → retask, `override_request_id` → override, `validated` → apply_user_validation, `user_quote` → apply_user_verdict, otherwise validate).',
        },
        task_id: { type: 'string', description: 'Task ID (full or 8-char prefix).' },
        kind: { type: 'string', enum: ['pause', 'complete', 'blocked'], description: 'action="validate": which claim to adjudicate.' },
        valid: { type: 'boolean', description: 'action="validate": true = the claim stands; false = rejected and reverted.' },
        reject_reason: { type: 'string', description: 'action="validate": required when valid=false. One-sentence directive for the agent.' },
        target_status: { type: 'string', enum: ['in_progress', 'on_deck', 'blocked'], description: 'Where to send the task on rejection or after a retask. Default in_progress. Use blocked if a rejected pause was really a block.' },
        directive: { type: 'string', description: 'action="retask": at least 30 characters. Tell the agent concretely what they did wrong and what to do instead (e.g. "you posted the brief in chat but the task specifies email delivery; call send_email with the same content").' },
        allow_regenerate: { type: 'boolean', description: 'action="retask": set true ONLY when the deliverable was already delivered to the user AND you have judged it genuinely misses the goal, so the assignee should redo and overwrite it. Without this, retask refuses to protect delivered work. Default false.' },
        override_request_id: { type: 'string', description: 'action="override": the OVERRIDE_REQUEST id (full or 8-char prefix).' },
        approve: { type: 'boolean', description: 'action="override": true = force the status through; false = deny and notify the agent.' },
        reason: { type: 'string', description: 'action="override": one sentence on why you approved or denied.' },
        status: { type: 'string', description: 'action="apply_user_verdict": the status the user chose. Typically complete, blocked, paused, in_progress, or on_deck.' },
        validated: { type: 'boolean', description: 'action="apply_user_validation": true = user confirmed the work is done. false = user said it is NOT done.' },
        user_quote: { type: 'string', description: 'The user\'s exact reply for the audit trail. Required for both user-verdict actions.' },
        feedback: { type: 'string', description: 'action="apply_user_validation", when validated=false: any feedback to relay to the assigned agent (e.g. "the file is empty, rerun").' },
      },
      required: [],
    },
  },
  {
    name: 'work_schedule',
    description: '**Scheduled/recurring tasks ONLY.** `action` picks what:\n\n**action="pause"** pauses a recurring task\'s schedule so it stops firing. **DO NOT use this to "finish" a non-recurring task**, for a one-shot task you completed, call `work_update({action:"status", status:"complete"})` instead. Pausing a one-shot task strands it forever (it sits in the Paused column, cannot be completed without unpausing, and PM monitoring ignores it). If the recurring task\'s remaining runs are no longer needed, set mark_complete=true to stop the schedule AND mark the task complete in one call.\n\n**action="resume"** resumes a paused recurring task.\n\n**action="resolve_missed"** resolves a "missed runs" alert from the scheduler. When a recurring task is overdue by more than one full interval (typically because the platform was offline or the task was paused longer than expected), the scheduler auto-pauses the task and asks the assigned agent how to proceed. Pass `resolution` as one of three: "run_now" (fire ONE catch-up run now, then resume normal anchor schedule, best when work is cumulative like "summarize what happened since last run"), "skip" (skip all missed slots, resume from the NEXT future anchor, best when each scheduled run is independent and stale, like "post today\'s reminder"), or "pause" (leave paused; the human user will resume via the dashboard). Only valid when the task is currently in the missed-runs paused state.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['pause', 'resume', 'resolve_missed'],
          description: 'Which schedule operation. Omit and the engine infers it (a `resolution` → resolve_missed, otherwise pause).',
        },
        task_id: { type: 'string', description: 'The task ID.' },
        mark_complete: { type: 'boolean', description: 'action="pause": if true, also mark the task as complete (use when the work is already done and remaining runs are unnecessary).' },
        resolution: {
          type: 'string',
          enum: ['run_now', 'skip', 'pause'],
          description: 'action="resolve_missed": how to resolve. REQUIRED for that action. See the tool description for guidance on which to pick.',
        },
      },
      required: ['task_id'],
    },
  },
  // ── Healer Tools ──
  {
    name: 'healer_log_action',
    description: 'Log an auto-fix action taken by the Healer agent. Used to record what was fixed and whether it succeeded.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        category: { type: 'string', description: 'Category code (e.g., STUCK_AGENT, ORPHANED_TASK)' },
        description: { type: 'string', description: 'What was done, in plain language' },
        agent_id: { type: 'string', description: 'Which agent was affected (if applicable)' },
        result: { type: 'string', enum: ['success', 'failed', 'partial'], description: 'Outcome of the fix' },
      },
      required: ['category', 'description', 'result'],
    },
  },
  {
    name: 'healer_propose',
    description: 'Create a proposal for the user to approve or deny in the dashboard. Use this for fixes that change configuration, switch models, or grant permissions, anything you are less than 70% confident about.\n\nEvery proposal MUST include an `evidence` field listing the specific things you actually observed this cycle: tool results, audit_log entries, file contents, vault entries you read. The user sees this proposal in their dashboard and acts on it, if the evidence is invented (vault IDs you didn\'t read, "known bugs" you can\'t cite, file paths you didn\'t open) you will mislead them into approving a fix for a problem that doesn\'t exist. If you can\'t produce concrete evidence, do not propose, log with `healer_log_action` instead.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short title for the dashboard (e.g., "Switch X to Claude Haiku"). Use the agent\'s role label, not invented "known bug" framing.' },
        description: { type: 'string', description: 'Full explanation of the problem in neutral terms based on what you actually observed. Avoid speculation about platform-level bugs unless you can cite the evidence for them in the evidence field below.' },
        proposed_fix: { type: 'string', description: 'What you want to do (plain language). Scope it narrowly to the specific agent or row in question, avoid "rules that apply to all agents" unless every persistent and non-persistent agent in the dojo would be safe under that rule (very rare; usually they are not).' },
        evidence: {
          type: 'array',
          items: { type: 'string' },
          description: 'REQUIRED. One short bullet per observation that backs the proposal. Each bullet should be specific enough that a reader could verify it, name the tool call you made, the agent_id you inspected, the file path you read, the audit_log code you saw, the vault entry id you found. Example: ["read messages table for agent abc12345, last assistant message was 2026-06-04T04:00Z", "vault_search returned no prior healer notes about this agent", "audit_log shows 3 model_call errors with code RATE_LIMIT in the last 24h for agent abc12345"]. Do not include references to identifiers you have not actually read in this cycle. If your evidence list would be empty or vague ("the diagnostic says X is broken"), do not propose, log instead.',
        },
        confidence: { type: 'number', description: 'Your confidence in this fix (0-100). If your evidence list is thin, your confidence should be too.' },
        severity: { type: 'string', enum: ['critical', 'warning', 'info'], description: 'How urgent is this?' },
        category: { type: 'string', description: 'Category (model_switch, config_change, permission_grant, etc.)' },
        agent_id: { type: 'string', description: 'Which agent this concerns (if applicable). Required if the proposal targets a specific agent. This is how the stale-proposal sweep knows the proposal is still relevant, so always include it when the fix is about one agent.' },
        diagnostic_code: { type: 'string', description: 'The diagnostic CODE of the anomaly this proposal addresses, exactly as it appears in the diagnostic (e.g. AGENT_PAUSED, TRACKER_STALE, HIGH_ERROR_RATE, BUDGET_HIGH). Supply it when the fix responds to a specific diagnostic finding. It is how a future cycle knows the underlying issue has (or has not) cleared, without it, and without an agent_id, the proposal can only be closed by an age cap. If you leave it blank but set agent_id, the engine will fill it from the current diagnostic when it can.' },
      },
      required: ['title', 'description', 'proposed_fix', 'evidence', 'confidence', 'severity', 'category'],
    },
    fields: {
      evidence: {
        requiredNotEnforced:
          'the EVIDENCE GATE is stricter than "present and non-empty" — it filters the array to non-blank strings and ' +
          'refuses with worked examples, so a healer can never propose a fix backed by nothing (see migration 055)',
      },
    },
  },
  {
    name: 'healer_recent_actions',
    description: 'Get a tight summary of recent Healer actions, timestamp, category, agent, and result only. Use BEFORE proposing a fix to check whether you (or a previous cycle) already tried something similar. The full description of any specific action is available via healer_action_detail(action_id). Output is capped, you cannot pull all history; pick a reasonable limit and look-back window.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max number of rows to return (default 20, max 50)' },
        since_hours: { type: 'number', description: 'Look back this many hours (default 24, max 168 = 7 days)' },
      },
      required: [],
    },
  },
  {
    name: 'healer_action_detail',
    description: 'Get the full description of ONE specific Healer action by its ID (from healer_recent_actions). Use to drill into the why/what of a past action without pulling the whole log. Description is capped at ~1500 chars.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        action_id: { type: 'string', description: 'The ID of the action to look up.' },
      },
      required: ['action_id'],
    },
  },
  {
    name: 'healer_mark_applied',
    description: 'Record that you have actually carried out an approved proposal. Call this AFTER you have executed the proposed fix (model switch, config change, etc.). The proposal then transitions from "approved" to "applied" in the Vitals dashboard so the user sees the work is done. Without this, an approved proposal sits visible forever with no indication of whether the fix actually happened.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        proposal_id: { type: 'string', description: 'The ID of the proposal you carried out. Available in the diagnostic message you received.' },
        notes: { type: 'string', description: 'Brief note about what you actually did (e.g., "Switched the PM agent to Claude Haiku 4.5 via API"). Stored alongside the timestamp for the audit trail.' },
      },
      required: ['proposal_id'],
    },
  },
  {
    name: 'get_current_time',
    description: 'Get the current date and time in UTC and local. Returns utc (ISO 8601), local (human-readable), and timezone. ALWAYS use the utc value when setting scheduled_start on tasks.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'convert_time',
    description: '**Disambiguate a timestamp from any source.** Whenever you encounter a time and the format does NOT include both a timezone abbreviation (PT, ET, UTC, etc.) AND a UTC ISO string, call this tool first instead of guessing. Misreading timezones is the #1 cause of agent errors in emails, briefs, reminders, and scheduled tasks.\n\nUse this for: times from web pages, email bodies, scraped content, calendar tools whose output you find ambiguous, raw unix epoch values, or any timestamp where you want to be 100% sure what moment you\'re talking about.\n\nReturns the dual-format string "<weekday>, <month day, year>, <h:mm AM/PM> <TZ> (<UTC ISO>)". The local part is the time-of-day in `to_tz` (defaults to the agent host\'s system timezone); the UTC ISO is the absolute moment in time. Both refer to the same instant, pick whichever the user needs.\n\nAccepts these input formats:\n  - ISO 8601 with offset/Z: "2026-05-20T19:00:00Z", "2026-05-20T12:00:00-07:00"\n  - ISO 8601 without offset: "2026-05-20T19:00:00" → set `from_tz` so the tool knows how to interpret it (Microsoft Graph returns this format as UTC; many email/web sources are local)\n  - Unix epoch milliseconds: "1747681200000" or 1747681200000 (Plaud uses this)\n  - Unix epoch seconds: 1747681200\n  - RFC 2822: "Wed, 20 May 2026 19:00:00 +0000"\n  - Other formats JS Date can parse',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        input: {
          type: 'string',
          description: 'The timestamp to convert. Any of the formats listed above.',
        },
        from_tz: {
          type: 'string',
          description: 'IANA timezone (e.g. "UTC", "America/Los_Angeles") to interpret the input as IF the input has no explicit offset and you know the source\'s convention. Use "UTC" for raw Microsoft Graph datetimes. Ignored when the input already carries an explicit offset.',
        },
        to_tz: {
          type: 'string',
          description: 'IANA timezone to render the local part in (e.g. "America/Los_Angeles", "America/New_York", "Europe/London"). Defaults to the agent host\'s system timezone.',
        },
      },
      required: ['input'],
    },
  },
  // ── Presence ──
  // ── Tunnel (Remote Access) ──
  {
    name: 'tunnel',
    description: 'Manage the Cloudflare tunnel for remote access. Pass `action`:\n  - "status": get the current tunnel status + public URL (use when the user asks for the dojo URL or whether remote access is running). The `url` field is what to share; `mode` tells you quick (trycloudflare.com) vs named (custom domain).\n  - "start": start the tunnel (only when the user explicitly asks to start/enable it). Optional `mode`: "quick" for a random URL, "named" for the configured persistent tunnel; defaults to the saved config.\n  - "stop": stop the tunnel (only when the user explicitly asks to stop/disable remote access).\n  - "restart": restart it (useful when stuck or the user wants a fresh URL).',
    effects: [{ kind: 'proc', from: 'derived:cloudflared (spawn; brew install on first use)' }],
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'start', 'stop', 'restart'], description: 'The tunnel operation to perform.' },
        mode: { type: 'string', enum: ['quick', 'named'], description: 'Optional, only for action="start": "quick" for a random URL, "named" for a configured persistent tunnel. Defaults to the saved config.' },
      },
      required: ['action'],
    },
  },
  {
    name: 'set_user_presence',
    description: 'Set whether the user is "in the dojo" (at their computer, using the dashboard) or "away" (not at the computer, route messages via iMessage). Only use this when the user explicitly asks you to mark them as away or back.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['in_dojo', 'away'],
          description: '"in_dojo" = user is at the dashboard, "away" = route messages through iMessage',
        },
      },
      required: ['status'],
    },
  },
  // ── Session Management ──
  {
    name: 'reset_session',
    description: 'Wipe a sub-agent\'s (or your own) conversation context and start fresh. This is THE tool for clearing an agent\'s memory when it\'s stuck in a loop, confused, or when the user explicitly asks for a clean slate. Archives the existing conversation to the vault first so nothing is lost.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'REQUIRED. The agent ID or name of the agent to reset. Pass a sub-agent\'s ID/name to reset them, or pass your own ID to reset yourself.' },
      },
      required: ['agent_id'],
    },
  },
  {
    name: 'update_agent',
    description: 'Change another sub-agent\'s configuration: name, system prompt, model, permissions, and/or tool policy in one call. This is THE tool for editing a sub-agent, do NOT modify files, SOUL.md, or the database directly. Provide agent_id plus at least one field to change; omitted fields are left untouched. Mirrors spawn_agent\'s parameters. Conversation history, tracker tasks, and group membership are always preserved; changes take effect on the agent\'s next turn. Cannot change the identity (name/system_prompt) of the primary agent (edit its SOUL.md via Settings instead). Changing `permissions` or `tools` requires the caller to have can_assign_permissions. Pair with get_agent_profile to read current values before rewriting.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'The agent ID or name to update.' },
        name: { type: 'string', description: 'New name for the agent. Omit to keep the current name.' },
        system_prompt: { type: 'string', description: 'New system prompt (role, personality, instructions). REPLACES the existing prompt entirely, include everything you want kept. Omit to keep the current prompt.' },
        model_id: { type: 'string', description: 'New model ID to assign, or "auto" for auto-routing. Call list_models for valid IDs. Omit to keep the current model.' },
        permissions: { type: 'object', description: 'Permission fields to MERGE (only include what changes): file_read/file_write ("*" or path array), file_delete, exec_allow/exec_deny (command arrays), network_domains ("*"|"none"|array), max_processes, can_spawn_agents, can_assign_permissions, system_control (array of "mouse"/"keyboard"/"screen"/"applescript"/"web_browse" or ["*"]). Requires can_assign_permissions.' },
        tools: { type: 'object', description: 'Tool-access policy to MERGE: { allow?: string[], deny?: string[] } of tool names. Requires can_assign_permissions.' },
      },
      required: ['agent_id'],
    },
  },
  {
    name: 'get_agent_profile',
    description: 'Read another agent\'s current identity: name, system prompt, model, tools policy, permissions, classification, group, status, and parent. Use this to audit what a sub-agent is currently set up as, or to read the existing system prompt before calling update_agent (which fully REPLACES the prompt, without reading first you can\'t append). Read-only, no side effects.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'The agent ID or name to read' },
      },
      required: ['agent_id'],
    },
    concurrency: 'safe',
    maxResultTokens: 4000,
  },
  // ── Group Tools (Phase 6) ──
  {
    name: 'create_agent_group',
    description: 'Create a new group of sub-agents around a shared purpose (a team, a squad, a project crew). This is THE tool for making a new agent group, do NOT try to insert rows into the database. The group description is injected into every member agent\'s system prompt as shared context.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Group name' },
        description: { type: 'string', description: 'Group purpose and context' },
      },
      required: ['name', 'description'],
    },
  },
  {
    name: 'update_group',
    description: 'Change an agent group\'s name or description (the shared context all members see). This is THE tool for editing a group, do NOT try to delete and recreate it. Provide at least one of name or description. Description changes appear in every member agent\'s context on their next turn.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        group_id: { type: 'string', description: 'The group ID to update' },
        name: { type: 'string', description: 'New group name. Omit to keep the current name.' },
        description: { type: 'string', description: 'New group purpose/description. Appears in every member agent\'s context. Omit to keep the current description.' },
      },
      required: ['group_id'],
    },
  },
  {
    name: 'assign_to_group',
    description: 'Add a sub-agent to a group, or remove a sub-agent from its current group. This is THE tool for moving agents between groups, do NOT try to update the database directly. Pass null as group_id to remove the agent from any group and leave it ungrouped.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'Agent ID to assign' },
        group_id: { type: 'string', description: 'Group ID to assign to, or null to remove the agent from its current group' },
      },
      required: ['agent_id', 'group_id'],
    },
  },
  // ── Agent & Group Visibility Tools ──
  {
    name: 'list_agents',
    description: 'List every active sub-agent, name, ID, status, classification, group. Default returns compact rows. For full detail (activity timestamps, dormant flags, last error snippets) on every result, pass verbose=true; for full detail on ONE agent, use get_agent_profile(agent_id).',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        include_terminated: { type: 'boolean', description: 'Include terminated agents (default: false)' },
        verbose: { type: 'boolean', description: 'If true, include activity timestamps, dormant detection, and last-error snippets per agent. Default false (compact rows).' },
      },
      required: [],
    },
    concurrency: 'safe',
    maxResultTokens: 2000,
  },
  {
    name: 'list_models',
    description: 'List all enabled models with name, ID, provider, cost, capabilities (vision, tools, thinking), context window, and max output tokens. ALWAYS call this before spawn_agent if you need to choose a model, it shows which models support vision, tool use, extended thinking, and their cost/performance trade-offs.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
    concurrency: 'safe',
    maxResultTokens: 3000,
  },
  {
    name: 'delete_group',
    description: 'Delete an agent group (squad) entirely. This is THE tool for removing a group, do NOT try to update the database directly. By default, member agents are moved to ungrouped (not terminated). Pass terminate_members=true to also kill every member in the group as part of the cleanup. Cannot delete the System group.\n\nOWNERSHIP: you can only delete squads YOU created. Squads created by the user (from the dashboard) are dismissed only by the user; delete_group refuses them.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        group_id: { type: 'string', description: 'The group ID to delete' },
        terminate_members: { type: 'boolean', description: 'If true, also terminate all non-permanent member agents before deleting the group. Default: false.' },
      },
      required: ['group_id'],
    },
  },
  {
    name: 'list_groups',
    description: 'List every agent group with its name, ID, and member count. Default returns compact rows. For full detail (description per group) on every result, pass verbose=true; for full detail on ONE group (members, settings, timestamps), use get_group_detail(group_id).',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        verbose: { type: 'boolean', description: 'If true, include each group\'s description. Default false (compact rows).' },
      },
      required: [],
    },
    concurrency: 'safe',
    maxResultTokens: 2000,
  },
  {
    name: 'get_group_detail',
    description: 'Get full details on one agent group, name, description, member roster (with each member\'s id, name, classification, status), creation metadata. Use this to drill in after list_groups.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        group_id: { type: 'string', description: 'Group ID or name (case-insensitive)' },
      },
      required: ['group_id'],
    },
    concurrency: 'safe',
    maxResultTokens: 2000,
  },
  // C27: update_agent_permissions merged into update_agent({permissions}) above.
  // ── Public file sharing ──
  {
    name: 'share_publicly',
    description: 'Publish a file (or a small directory of files) to a publicly-accessible URL and return that URL. Use this when the user wants to view or share something outside the DOJO, e.g. an HTML page another agent built, a PDF report, an image, a static website. The DOJO copies the source into ~/.dojo/out/<slug>/ and exposes it at /share/<slug>/<filename> (no auth). If the DOJO has a Cloudflare tunnel running, the URL works from anywhere on the internet; otherwise it falls back to localhost (only viewable on the same machine). Use the returned URL directly, do NOT try to construct one yourself.\n\nHTML asset handling: when sharing a single .html file, the engine automatically scans it for linked local assets (`<img src>`, `<link href>`, `<script src>`, `url(…)` in inline CSS) and copies each one into the share directory so the page renders correctly at the public URL. Refs starting with http(s)://, data:, etc. are left alone. The tool result reports how many assets were copied. For multi-file sites or when you need precise control, point source_path at the directory and pass entry_filename.\n\nExamples:\n  • Share a single HTML page (linked assets auto-copied): share_publicly({ source_path: "/Users/.../uploads/<agent-id>/report.html" })\n  • Share a directory site: share_publicly({ source_path: "/Users/.../uploads/<agent-id>/site/", entry_filename: "index.html" })\n  • Share an image: share_publicly({ source_path: "/Users/.../uploads/<agent-id>/chart.png" })',
    effects: [
      { kind: 'fs_read', from: 'args.source_path' },
      { kind: 'fs_write', from: 'derived:the public share directory ~/.dojo/out/<slug>' },
    ],
    nonEffects: {
      'entry_filename': 'names a file WITHIN args.source_path, which the fs_read above already resolves; it never names a path of its own',
    },
    input_schema: {
      type: 'object',
      properties: {
        source_path: {
          type: 'string',
          description: 'Absolute path to the file or directory to share. Must already exist on disk.',
        },
        entry_filename: {
          type: 'string',
          description: 'Optional. When sharing a directory, the filename inside it the URL should point to (e.g. "index.html"). If omitted, defaults to index.html when present, otherwise the directory root.',
        },
      },
      required: ['source_path'],
    },
  },
  // ── Show files to user ──
  {
    name: 'show_to_user',
    description: 'Display one or more IMAGES (and short audio/video clips) to the user IN THE CHAT as inline thumbnails, as part of your reply. Use this for a picture you want the user to actually look at right in the conversation, a slide PNG a sub-agent sent you, a Drive image you downloaded, a photo from your uploads folder. WITHOUT this tool, "take a look at this image" is a lie, the file is on disk but the user sees no thumbnail.\n\nDOCUMENTS GO IN THE CANVAS, NOT HERE. A PDF, Word/Excel/PowerPoint, Markdown, text, or code file passed to show_to_user is REJECTED, those render as a real formatted preview in the canvas. Canvas-renderable files auto-open the moment you write them (file_write, or creating a Word/Excel/PDF); use canvas_render({ path }) to (re)open one. Reserve show_to_user for images/media.\n\nThis tool inserts an assistant-role message into your chat with the files attached and your `caption` as the bubble text. The user sees: your caption + thumbnails. After calling, end your turn (or continue with more tool calls if needed).\n\nExample (forwarding a slide preview a sub-agent sent):\n  show_to_user({ file_paths: ["/Users/.../uploads/<your-agent-id>/draft_slide_preview.png"], caption: "Sub-agent finished a draft of the title slide. Looks good to me, anything you want changed?" })\n\nFile paths must already exist (typically under ~/.dojo/uploads/<your-agent-id>/ or wherever a sub-agent delivered them). Files outside the uploads dir are copied in.',
    effects: [{ kind: 'fs_read', from: 'args.file_paths[]' }],
    input_schema: {
      type: 'object',
      properties: {
        file_paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Absolute paths to the files to display. Images render as thumbnails; PDFs render as document chips. Up to 10 files per call.',
        },
        caption: {
          type: 'string',
          description: 'Your message text accompanying the files. This becomes the bubble content (e.g., "Here\'s the slide, looks good?"). Keep it natural; this is your reply to the user.',
        },
      },
      required: ['file_paths'],
    },
  },
  // ── Channel Safe-Sender Management ──
  {
    name: 'add_safe_sender',
    description: 'Add a person to one of the channel safe-sender allowlists so the agent can auto-reply when they message back. **Call this ONLY when the user explicitly asks you to start a conversation with someone (e.g., "email Sarah about Q4", "text Mike a heads-up", "start a Teams chat with Priya"). Do NOT call this preemptively, and do NOT call it because someone happened to email or text you without the user asking.**\n\nThe `user_request_quote` parameter is required and must contain the user\'s actual words asking for this. If you cannot quote a real user request, because no one asked, do NOT call this tool. The quote is audit-logged and reviewed by the user.\n\nThe allowlist controls AUTO-REPLY: once a person is on the channel\'s list, when they reply back (e.g., a Re: email or a Teams DM back), the engine routes the agent\'s response automatically. People NOT on the list can still send the agent messages; the agent just decides whether to surface them to the user instead of auto-replying.\n\nChannels:\n- `imessage`, iMessage contacts (no slot)\n- `gmail`, email senders, PER-SLOT (`agent` or `user`); the slot you add to must have "Allow sending email" enabled on that account, or the call is refused\n- `outlook`, same as gmail, per-slot\n- `teams`, Teams DM senders (Entra accounts only, no slot)\n\nThe `slot` parameter is REQUIRED for `gmail` and `outlook` (decides which mailbox\'s list to add to) and IGNORED for `imessage` and `teams`. If the user doesn\'t specify the slot, infer from context: the agent\'s own account is the `agent` slot; the user\'s personal account is the `user` slot. If unsure, ask the user before calling.\n\nSharing levels:\n- `open_book`, no restrictions, treat like the owner (use for the owner\'s alternate addresses, household members the user trusts fully)\n- `dont_overshare`, default for new contacts; share what is asked, do not volunteer extra details\n- `cautious`, answer only what is asked, briefly, high-level only\n- `project_only`, discuss only the specific project named in description (description is required for this level)\n\nIf the user asks you to start a conversation with someone but does not specify a sharing level, default to `dont_overshare`.\n\nIdempotent: if the address is already on the target list, the call succeeds without modifying anything.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        channel: {
          type: 'string',
          enum: ['imessage', 'gmail', 'outlook', 'teams'],
          description: 'Which channel\'s safe-sender list to add to.',
        },
        address: {
          type: 'string',
          description: 'For iMessage: phone number or email/Apple ID. For gmail/outlook: email address. For teams: email or UPN.',
        },
        slot: {
          type: 'string',
          enum: ['agent', 'user'],
          description: 'REQUIRED for gmail/outlook: which mailbox slot\'s safe-sender list to add to. `agent` = the agent\'s own account (the bot\'s mailbox). `user` = the user\'s personal account. The slot must have "Allow sending email" enabled in Settings → that integration card, or this call is refused. Ignored for imessage and teams.',
        },
        user_request_quote: {
          type: 'string',
          description: 'REQUIRED. Quote the user\'s actual words asking you to start this conversation or add this person. Pull verbatim from a recent user message in this thread, do not paraphrase, do not invent. If you cannot quote a real user request, do NOT call this tool. The quote is persisted to the audit log and the user can review it.',
        },
        name: {
          type: 'string',
          description: 'Display name for this contact (e.g., "Sarah Chen"). Optional but strongly recommended; defaults to the address if omitted.',
        },
        sharing_level: {
          type: 'string',
          enum: ['open_book', 'dont_overshare', 'cautious', 'project_only'],
          description: 'How much info the agent should share with this person. Defaults to "dont_overshare" if omitted.',
        },
        description: {
          type: 'string',
          description: 'Optional note about who this person is. Required when sharing_level=project_only, name the specific project.',
        },
        is_agent: {
          type: 'boolean',
          description: 'Set true ONLY when this contact is another AI agent / Dojo assistant (not a human). Lets the engine skip work-acks and damp content-free courtesy volleys on machine-to-machine iMessage threads. Defaults false. iMessage only.',
        },
      },
      required: ['channel', 'address', 'user_request_quote'],
    },
  },
  // ── iMessage Tools ──
  {
    name: 'imessage_list_contacts',
    reachesPeople: true,
    description: 'List ALL of YOUR iMessage contacts. The DOJO iMessage bridge is YOUR own iMessage account (not the user\'s phone) - these are the people YOU are authorized to text from your account. Call this whenever the user asks you to text, message, iMessage, or shoot a message to someone and you do not already know that person\'s address. Returns every contact with name, address, description (who they are), sharing_level, and whether they are the primary user. Pick the most likely match yourself based on the user\'s phrasing, your memory of who is who, and the description field. If two contacts plausibly fit (e.g. the user said "text Alex" and there are two Alexes), ask the user to clarify before sending.',
    effects: [{ kind: 'proc', from: 'derived:iMessage bridge (osascript)' }],
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'imessage_send',
    reachesPeople: true,
    description: 'Send an iMessage from YOUR OWN iMessage account (the DOJO bridge). **As of v2.7.23, replies to inbound iMessages auto-route via the engine, you do NOT need to call this tool to reply. Just write your reply text; engine delivers it.**\n\n**DEFAULT-CHANNEL RULE, When the primary user is actively talking to you on dashboard, the default is "reply in dashboard."** Do NOT additionally text them on iMessage to "also share on their phone" or "make sure they see it." Their reply belongs in the dashboard they are looking at.\n\n**Exceptions where you SHOULD call imessage_send even though the user is in dashboard:**\n\n- **The user explicitly named iMessage in this turn\'s request.** e.g. "text me the meeting list," "iMessage me when that finishes," "send the summary to my phone." The user choosing the channel overrides the default-channel rule.\n- **A task you are working on explicitly specifies iMessage as the delivery channel.** Tasks frequently encode delivery preferences in their goal or notes ("when this completes, iMessage the owner with the result," "deliver via iMessage, not chat"). The task directive is the authoritative source for that work item; the default-channel rule is for the absence of a task directive, not in addition to it.\n- **The recipient is someone OTHER than the primary user.** Texting the user\'s spouse, a colleague, a third-party contact on the safe-sender list, the default-channel rule is only about the primary user.\n\n**Beyond those exceptions, this tool is for:**\n\n- **PROACTIVE outreach** = the turn was NOT triggered by a user message at all. Examples: a scheduled task fires and you decide to text the user, a watchdog event needs surfacing while the user is offline, a long-running job you started yesterday completes and you let the user know.\n- **RICH actions** = sending with attachments (image, PDF, etc.). The text rides with the first file via the imsg CLI. Use only when an attachment is genuinely needed; sending a link as a "rich action" does not qualify.\n\nVOICE: write like an actual text message. No markdown, no headers, no bullet lists. Short and conversational.\n\nRecipient rule: pass `recipient` explicitly when proactively messaging someone or when sending to a non-default address. The value MUST exactly match a safe-sender address. If you only know the person by name (e.g. user said "text <contact-name>"), call `imessage_list_contacts` first to look up the address. Passing an unknown address is refused. For attachments, pass any local path (e.g. ~/.dojo/uploads/<agent-id>/photo.jpg).',
    effects: [
      { kind: 'send', from: 'args.recipient' },
      { kind: 'fs_read', from: 'args.attachments[]' },
      { kind: 'proc', from: 'derived:iMessage bridge (osascript)' },
    ],
    input_schema: {
      type: 'object',
      properties: {
        recipient: {
          type: 'string',
          description: 'Phone number or Apple ID of a configured safe sender. OMIT to default to the inbound sender (when replying) or the starred contact (when proactive). Refused if not in the safe-sender allowlist.',
        },
        message: {
          type: 'string',
          description: 'The message text to send. May be empty string if you only want to send attachments.',
        },
        attachments: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional array of absolute local file paths to send as iMessage attachments (images, PDFs, etc.). The message text rides with the first file; additional files arrive as separate bubbles.',
        },
      },
      required: ['message'],
    },
  },
  {
    name: 'sms_send',
    reachesPeople: true,
    description: 'Send a text message via Twilio SMS. **Replies to inbound SMS auto-route via the engine - you do NOT need to call this tool to reply. Just write your reply text; the engine delivers it.**\n\n**DEFAULT-CHANNEL RULE - When the primary user is actively talking to you on dashboard, the default is "reply in dashboard."** Do NOT also text them via SMS to "make sure they see it."\n\n**Exceptions where you SHOULD call sms_send even when the user is in dashboard:**\n\n- **The user explicitly named SMS / text in this turn\'s request** (e.g. "text Sarah that the meeting moved," "SMS me when that finishes").\n- **A task you are working on explicitly specifies SMS delivery.**\n- **The recipient is someone OTHER than the primary user** (texting a family member, colleague, vendor contact on the safe-sender list).\n\n**Beyond those, this tool is for:**\n\n- **PROACTIVE outreach** = the turn was NOT triggered by a user message at all (scheduled task, watchdog event, long-running job completion).\n\nVOICE: write like an actual text message. No markdown, no headers, no bullet lists. Short and conversational.\n\nRecipient rule: pass `to` as a phone number in E.164 format (e.g. `+15551234567`). The recipient MUST be on the Twilio SMS safe-sender allowlist - sending to an unknown number is refused. Per-number `from` argument is optional; defaults to the configured default Twilio number.\n\nLimits: 1600 character maximum per send (carrier limit). Personal Twilio accounts have throughput caps; high-volume sends may be deferred or rejected by Twilio.',
    effects: [{ kind: 'send', from: 'args.to' }],
    input_schema: {
      type: 'object',
      properties: {
        to: {
          type: 'string',
          description: 'Recipient phone number in E.164 format (+15551234567). Must be on the Twilio SMS safe-sender allowlist.',
        },
        body: {
          type: 'string',
          description: 'The text message body. Max 1600 characters.',
        },
        from: {
          type: 'string',
          description: 'Optional. Specific Twilio number to send from (must be one the owner has configured). Defaults to the configured default number.',
        },
      },
      required: ['to', 'body'],
    },
  },
  {
    name: 'voice_call',
    reachesPeople: true,
    description: 'Place a phone call via Twilio. The agent (you) holds the call: the caller speaks, Twilio streams audio to the dojo, your STT transcribes, you generate a reply, your TTS speaks back over the same call. **Use sparingly**, voice calls are real-time, costly, and demand immediate attention. Prefer SMS or iMessage unless the user asked for a phone call or the situation needs it (urgent, complex back-and-forth, hands-free).\n\nThe recipient MUST be on the Twilio Voice safe-caller allowlist; sending to an unknown number is refused. Personal Twilio accounts only, no robocalls, no campaign sends. The active Cloudflare tunnel must be running so Twilio can connect the audio back to the dojo.\n\n**HOW THE CALL OPENS, IMPORTANT.** When you place an outbound call, the called party answers and speaks FIRST (usually "Hello?"). That is normal human phone etiquette. You wait, hear their hello, and THEN identify yourself and state your purpose on the very next turn (the dojo will give you a turn the moment they speak). **Do NOT pass `opening_message`** in the standard case, it gets spoken the instant the call connects, before they say anything, which makes you sound like a robocall. Leaving silence on the line until they say "Hello?" is the right move. Real people do this on every outbound call.\n\nThe `opening_message` arg is reserved for unusual cases where you really do need audio queued up at connect time, for example, when you know the recipient has asked you to leave a voicemail directly, or when answering machine detection has already resolved to "voicemail" and you are dropping a pre-composed message. In normal person-to-person calling, leave it blank.\n\n`purpose` is a short string describing why you are calling (e.g. "scheduling the Tuesday demo", "following up on the buyer meeting"). It is shown to you in the system prompt on each turn of the call so you can stay on track, and it shapes your opening self-ID once the callee says hello. Provide it for any outbound call with a specific reason.\n\nMax call duration is capped (Settings → Integrations → Twilio → Voice). Calls exceeding the cap are hung up automatically.',
    effects: [{ kind: 'send', from: 'args.to' }],
    input_schema: {
      type: 'object',
      properties: {
        to: {
          type: 'string',
          description: 'Recipient phone number in E.164 format (+15551234567). Must be on the Voice safe-caller allowlist.',
        },
        opening_message: {
          type: 'string',
          description: 'OPTIONAL and usually OMITTED. Text spoken the instant the call connects, before the recipient says anything. In normal person-to-person calling this is wrong: the recipient says "Hello?" first and YOU respond after. Only set this when you specifically need pre-composed audio at connect time (known voicemail drop, etc.). Leave blank for standard calls.',
        },
        purpose: {
          type: 'string',
          description: 'Short, specific reason for the call (e.g. "scheduling the Tuesday demo", "following up on the buyer meeting"). Surfaced to you in the phone-mode system prompt on every turn so you stay on track, and used in your self-ID when the callee picks up. Strongly recommended on any outbound call with a defined goal.',
        },
        from: {
          type: 'string',
          description: 'Optional. Specific Twilio number to call from. Defaults to the configured default number.',
        },
      },
      required: ['to'],
    },
  },
  {
    name: 'voice_call_end',
    reachesPeople: true,
    description: 'Hang up an active phone call you initiated (or are participating in). Use after the conversation has reached a natural conclusion or when the call needs to be terminated (recipient ended verbally but didn\'t hang up, escalating off-topic, etc.). Returns whether the hang-up succeeded.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        call_id: {
          type: 'string',
          description: 'The Twilio Call SID returned from voice_call or shown in voice_call_status.',
        },
        reason: {
          type: 'string',
          description: 'Optional short reason string for the call log.',
        },
      },
      required: ['call_id'],
    },
  },
  {
    name: 'voice_call_status',
    reachesPeople: true,
    description: 'Check the status of an active phone call, or list all active calls when no call_id is given. Useful for orienting if you\'re unsure whether a call you placed is still active.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        call_id: {
          type: 'string',
          description: 'Optional. Specific Twilio Call SID to look up. Omit to list all active calls.',
        },
      },
      required: [],
    },
  },
  // ── Image Generation Tools ──
  {
    name: 'image_create',
    description: 'Generate an image from a text description. The engine handles the ENTIRE delivery flow, DO NOT write any user-facing text around this tool. When you call it, the engine immediately posts a short acknowledgment ("On it.") to the chat. 10-60 s later when the image is ready, the engine posts the image directly with a short caption ("Here you go."). You do NOT need a second turn. Just call this tool and end your turn, anything you write will duplicate what the engine already posted. Do NOT mention the image generation model or any internal system to the user.',
    effects: [{ kind: 'fs_write', from: 'derived:the calling agent uploads directory' }],
    input_schema: {
      type: 'object',
      properties: {
        description: {
          type: 'string',
          description: 'A detailed plain-English description of what you want the image to show. Include subject, setting, composition, mood, style, lighting, colors, and any specific details. The more specific you are, the better the result. Example: "A cozy coffee shop interior at sunset, warm golden light streaming through large windows, vintage leather chairs, exposed brick walls, steam rising from a latte on a wooden table in the foreground, cinematic lighting, photorealistic". Do NOT use image-model flags like "--ar 16:9", just describe what you want.',
        },
        title: {
          type: 'string',
          description: 'A short, descriptive title for the image, 2 to 6 words that summarize the subject. Used as the file name when the user downloads it. Examples: "coffee shop sunset", "golden retriever puppy", "fantasy castle at dusk". Plain words only, no extensions, no quotes, no special characters. Strongly recommended; if omitted, the file name will fall back to a generic id.',
        },
        aspect_ratio: {
          type: 'string',
          enum: ['1:1', '16:9', '9:16', '4:3', '3:4'],
          description: 'Aspect ratio. 1:1 square, 16:9 landscape, 9:16 portrait/vertical, 4:3 standard, 3:4 portrait standard. Defaults to 1:1 if omitted.',
        },
        style_hint: {
          type: 'string',
          description: 'Optional style override like "photorealistic", "illustration", "watercolor", "3D render", "pixel art", "line drawing". If omitted, the image model picks the best style for the description.',
        },
      },
      required: ['description'],
    },
  },
  // ── Audio Transcription Tool ──
  {
    name: 'transcribe_audio',
    description: 'Convert speech in an audio file to text. Pass ONE of: attachment_id (the fileId from a recent chat attachment, preferred when the user just shared the file), path (an absolute local path inside ~/.dojo/uploads/), or url (https only). Common input formats: mp3, wav, m4a, opus, webm, ogg, aac. Returns the transcribed text inline (no new attachment is created). The platform posts a short acknowledgment automatically; you do not need to announce that you are transcribing.',
    effects: [{ kind: 'fs_read', from: 'args.path' }, { kind: 'net', from: 'args.url' }],
    input_schema: {
      type: 'object',
      properties: {
        attachment_id: {
          type: 'string',
          description: 'The fileId of an audio attachment from a recent chat message. Preferred when the user just shared a file in chat (the file pointer was surfaced to you as `[Audio attached: ..., fileId: ...]`).',
        },
        path: {
          type: 'string',
          description: 'Absolute local path to an audio file. Must be inside ~/.dojo/uploads/. Use this only when you have a path but no fileId.',
        },
        url: {
          type: 'string',
          description: 'An https URL pointing directly at an audio file. Use this when the user gave you a link. Max 50 MB; non-https URLs are rejected.',
        },
        language: {
          type: 'string',
          description: 'Optional 2-letter ISO language hint (e.g. "en", "es", "ja"). Improves accuracy on non-English audio. If omitted, the engine auto-detects.',
        },
      },
      required: [],
    },
  },
  // ── Text-to-Speech Tool ──
  // (Music / sound-effect generation is a different operation and will
  // get its own `music_create` tool when implemented.)
  {
    name: 'tts_create',
    description: 'Generate spoken audio from text, text-to-speech (TTS). The engine handles delivery, DO NOT write any user-facing text around this tool. When you call it, the engine posts a short acknowledgment immediately. ~2-10 s later the engine delivers the audio file directly to the chat with an inline player. Just call this tool and end your turn. Do NOT mention the TTS model or any internal system to the user. This tool reads text aloud verbatim, it does NOT compose music or sound effects.',
    effects: [{ kind: 'fs_write', from: 'derived:the calling agent uploads directory' }],
    input_schema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'The text to read aloud. Plain prose. The engine will speak it verbatim, so write what you want the user to HEAR, no stage directions, no bracketed asides. Punctuation guides pacing.',
        },
        voice: {
          type: 'string',
          description: 'Optional voice id. The valid ids depend on the configured TTS model and are listed in this tool description under VOICES (with each voice\'s character) when known. Pick the closest match to what the user asked for. If omitted, the model uses its default. Pass only when the user requested a specific voice or the conversation established one.',
        },
        title: {
          type: 'string',
          description: 'A short, descriptive title for the audio, 2 to 6 words that summarize what was said. Used as the file name when the user downloads it. Examples: "weekly recap", "rude grocery joke", "good morning". Plain words only, no extensions, no quotes, no special characters. Strongly recommended; if omitted, the file name falls back to a generic id.',
        },
      },
      required: ['text'],
    },
  },
  // ── Music Generation Tool ──
  {
    name: 'music_create',
    description: 'Compose original music or a sound piece from a text description. This is NOT text-to-speech (use tts_create to read words aloud). music_create generates an instrumental/musical composition from a creative brief. The engine handles the ENTIRE flow: when you call it, the engine posts a brief acknowledgment to the user and returns immediately. ~10-40 s later when the track is ready, the engine posts the audio file directly to the chat with an inline player. You do NOT get a second turn, just call this tool once and end your turn. Do NOT call it again to check progress. Do NOT mention the music model or any internal system to the user.',
    effects: [{ kind: 'fs_write', from: 'derived:the calling agent uploads directory' }],
    input_schema: {
      type: 'object',
      properties: {
        description: {
          type: 'string',
          description: 'A detailed plain-English description of the music: genre, mood, instrumentation, tempo, structure, and any reference style. Example: "An upbeat lo-fi hip-hop beat with a mellow Rhodes piano, soft vinyl crackle, a relaxed boom-bap drum groove around 85 BPM, and a warm sub bass. Chill and nostalgic." The more specific, the better. Do NOT include lyrics unless you want them sung.',
        },
        title: {
          type: 'string',
          description: 'A short, descriptive title, 2 to 6 words summarizing the track. Used as the file name when the user downloads it. Examples: "lofi study beat", "epic battle theme". Plain words only, no extensions or special characters. Strongly recommended; if omitted, the file name falls back to a generic id.',
        },
      },
      required: ['description'],
    },
  },
  // ── Video Generation Tool ──
  {
    name: 'video_create',
    description: 'Generate a short video from a text description. Video generation is SLOW, it runs asynchronously in the background and usually takes 1 to 10 minutes. The engine handles the ENTIRE flow: when you call this tool it posts a brief acknowledgment to the user ("I\'ve started the video, I\'ll send it when it\'s ready") and returns immediately. When the video finishes, the engine posts it directly to the chat with an inline player, you do NOT get a second turn and you do NOT need to write anything. Just call this tool once and end your turn. Do NOT call it again to check progress, the user can watch progress via the indicator next to the chat input. Do NOT mention the video model or any internal system to the user.',
    effects: [{ kind: 'fs_write', from: 'derived:the calling agent uploads directory' }],
    input_schema: {
      type: 'object',
      properties: {
        description: {
          type: 'string',
          description: 'A detailed plain-English description of the video: subject, action, setting, camera movement, mood, lighting, style. Example: "A golden retriever puppy running across a sunlit meadow in slow motion, camera tracking alongside, warm afternoon light, shallow depth of field, cinematic". The more specific, the better. Do NOT use model flags like "--ar 16:9".',
        },
        title: {
          type: 'string',
          description: 'A short, descriptive title, 2 to 6 words summarizing the clip. Used as the file name when the user downloads it. Examples: "puppy in meadow", "city timelapse". Plain words only, no extensions or special characters. Strongly recommended.',
        },
        duration_seconds: {
          type: 'number',
          description: 'REQUIRED. Clip length in seconds. If the user named a length (e.g. "a 2 second clip"), pass that exact number here, do NOT bury it in the description. Different models accept different lengths; if your value is out of range the engine tells you the valid options so you can re-pick. Keep it short unless the user asks for longer (longer = costlier and slower).',
        },
        aspect_ratio: {
          type: 'string',
          enum: ['16:9', '9:16', '1:1'],
          description: 'REQUIRED. Frame shape. 16:9 landscape, 9:16 vertical/portrait (good for phones / social), 1:1 square. Pick what suits the request; default to 16:9 if unspecified.',
        },
        resolution: {
          type: 'string',
          enum: ['480p', '720p', '1080p'],
          description: 'REQUIRED. Output resolution. Higher is sharper but costlier and slower. Default to 720p if the user did not specify. Not every model supports every resolution; the engine tells you the valid options if yours is unsupported.',
        },
        ref_image_attachment_id: {
          type: 'string',
          description: 'Optional. The fileId of an image attachment to use as the first frame / reference for the video. Use when the user wants the video to start from or match a specific image they shared.',
        },
      },
      required: ['description', 'duration_seconds', 'aspect_ratio', 'resolution'],
    },
  },
  // ── System Control Tools (Phase 5A) ──
  {
    name: 'mouse_click',
    description: 'Move the mouse to coordinates and click. Use after screen_screenshot to identify target positions.',
    effects: [{ kind: 'proc', from: 'derived:cliclick' }],
    input_schema: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'X coordinate (pixels from left)' },
        y: { type: 'number', description: 'Y coordinate (pixels from top)' },
        click_type: { type: 'string', enum: ['left', 'right', 'double'], description: 'Click type (default: left)' },
      },
      required: ['x', 'y'],
    },
  },
  {
    name: 'mouse_move',
    description: 'Move the mouse without clicking. Useful for hovering to reveal tooltips or menus.',
    effects: [{ kind: 'proc', from: 'derived:cliclick' }],
    input_schema: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'X coordinate' },
        y: { type: 'number', description: 'Y coordinate' },
      },
      required: ['x', 'y'],
    },
  },
  {
    name: 'keyboard_type',
    description: 'Type text or press key combinations. Use for filling forms, entering commands, or keyboard shortcuts.',
    effects: [{ kind: 'proc', from: 'derived:cliclick' }],
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to type' },
        key_combo: { type: 'string', description: 'Special key combination: cmd+c, cmd+v, cmd+tab, cmd+shift+3, return, escape, tab, delete, arrow-up, arrow-down, arrow-left, arrow-right' },
      },
      required: [],
    },
  },
  {
    name: 'screen_screenshot',
    description: 'Take a screenshot and describe what is visible using a vision model, this is for YOU to perceive the screen (then act, e.g. before mouse_click to find targets). Returns a text description with approximate coordinates for interactive elements. Pass `query` to focus the description on what you\'re looking for (recommended).\n\nIMPORTANT, do NOT use this to "show the user the screen." If the user wants to SEE your live screen, watch what you are doing, or take control of this Mac remotely (common when they\'re away and need to click/approve something here), use `screen_broadcast` instead, it opens a live, interactive viewer in their canvas. screen_screenshot only gives YOU a still snapshot; it shows the user nothing.',
    effects: [
      { kind: 'proc', from: 'derived:screencapture' },
      { kind: 'fs_write', from: 'derived:the screenshot temp directory' },
    ],
    input_schema: {
      type: 'object',
      properties: {
        region: {
          type: 'object',
          description: 'Capture a specific region instead of full screen',
          properties: {
            x: { type: 'number' },
            y: { type: 'number' },
            width: { type: 'number' },
            height: { type: 'number' },
          },
        },
        query: { type: 'string', description: 'Specific question about the screen, e.g., "where is the Submit button?". Strongly recommended, without it the description is generic and longer.' },
      },
      required: [],
    },
    concurrency: 'special',
    maxResultTokens: 2000,
  },
  {
    name: 'applescript_run',
    description: 'Run an AppleScript command. Use for macOS automation: opening apps, controlling windows, running Shortcuts, interacting with system features.',
    effects: [{ kind: 'applescript', from: 'args.script' }],
    input_schema: {
      type: 'object',
      properties: {
        script: { type: 'string', description: 'The AppleScript code to execute' },
      },
      required: ['script'],
    },
    concurrency: 'serial',
    maxResultTokens: 4000,
  },
  // ── Headless Browser Tool (Phase 5B) ──
  {
    name: 'web_browse',
    description:
      'Open a headless browser to interact with web pages. Can navigate, take screenshots, click elements, fill forms, and extract content. Use for pages that require JavaScript rendering or interaction. The browser session persists across calls, navigate first, then interact.\n\nFor the `extract` action, ALWAYS pass a `goal` describing what you\'re looking for, the tool returns a focused extract (~1-2K tokens) instead of the raw page (often 30K+).',
    effects: [{ kind: 'net', from: 'args.url' }],
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['navigate', 'screenshot', 'click', 'type', 'scroll', 'extract', 'close'],
          description: 'The browser action to perform',
        },
        url: { type: 'string', description: 'URL to navigate to (for "navigate" action)' },
        selector: { type: 'string', description: 'CSS selector for click/type targets' },
        text: { type: 'string', description: 'Text to type (for "type" action)' },
        scroll_direction: { type: 'string', enum: ['up', 'down'], description: 'Scroll direction' },
        scroll_amount: { type: 'number', description: 'Pixels to scroll (default: 500)' },
        goal: {
          type: 'string',
          description:
            'For the `extract` action: what to extract from the page. Be specific. The tool will return a focused summary, not the raw page. Example: "the article headline and first paragraph", "all link URLs in the navigation menu", "the form fields and their current values".',
        },
      },
      required: ['action'],
    },
    concurrency: 'special',
    maxResultTokens: 3000,
  },
  // ── Technique Tools ──
  {
    name: 'save_technique',
    description: '**TRAINER AGENT ONLY.** Save a reusable technique to the dojo. Other agents calling this get refused with a redirect to the trainer.\n\nThe trainer owns techniques because techniques are SHAREABLE: when one user exports a technique to another user, every support file, dependency, and external resource has to travel with it. A technique whose TECHNIQUE.md references `~/Documents/random.py` (a file the main agent dropped somewhere arbitrary) is broken on every other machine. Centralizing creation in the trainer is what keeps techniques portable by construction.\n\nWhen you (as another agent) want a technique built, send the trainer a message describing what you want, with the contents of any custom files inline. They\'ll create the technique correctly.\n\n**File-reference validation runs at save time.** Every path TECHNIQUE.md references must EITHER exist inside the technique\'s support directory (pass it in `files`) OR be declared in `dependencies` as a repo / asset / manual step that the importing trainer will fetch. References that don\'t resolve cause a structured refusal.\n\n**Drafts vs publish:** techniques save as DRAFT by default. Drafts can\'t be loaded with `use_technique`. Pass publish=true whenever the user expects it usable right away.',
    effects: [
      { kind: 'fs_write', from: 'args.files[].path' },
      { kind: 'net', from: 'args.dependencies.repos[].url' },
      { kind: 'fs_write', from: 'args.dependencies.repos[].install_to' },
      { kind: 'net', from: 'args.dependencies.models_or_assets[].url' },
      { kind: 'fs_write', from: 'args.dependencies.models_or_assets[].destination' },
    ],
    nonEffects: {
      'dependencies.language_packages[].install_in': 'a package-manager working directory recorded in the manifest for the importing trainer to act on later; this call writes nothing there',
    },
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short name (lowercase, hyphens ok, used as directory name)' },
        display_name: { type: 'string', description: 'Human-readable name' },
        description: { type: 'string', description: 'One-line description of what this technique does' },
        instructions: { type: 'string', description: 'Full TECHNIQUE.md content, detailed step-by-step instructions for how to execute this technique, written for other agents to follow. Every file path referenced here must either exist in `files` or be declared in `dependencies`.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags for categorization' },
        files: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Relative path within the technique directory (e.g. "server.py", "templates/brief.md")' },
              content: { type: 'string', description: 'File content' },
            },
          },
          description: 'Supporting files to include in the technique directory. Every custom script, template, config, or data file the technique needs MUST be passed here, files referenced in TECHNIQUE.md that aren\'t included and aren\'t in dependencies will refuse the save.',
        },
        dependencies: {
          type: 'object',
          description: 'External dependencies that aren\'t support files. The importing trainer reads this to set up the technique on the receiving machine. Omit if the technique has none.',
          properties: {
            system_packages: { type: 'array', description: 'OS-level packages (brew, apt, etc.).', items: { type: 'object', properties: { manager: { type: 'string', description: 'e.g. "brew", "apt", "choco"' }, package: { type: 'string' }, version: { type: 'string' }, note: { type: 'string' } }, required: ['manager', 'package'] } },
            language_packages: { type: 'array', description: 'Language-runtime packages (npm, pip, gem, etc.).', items: { type: 'object', properties: { manager: { type: 'string', description: 'e.g. "npm", "pip"' }, package: { type: 'string' }, version: { type: 'string' }, install_in: { type: 'string' }, note: { type: 'string' } }, required: ['manager', 'package'] } },
            repos: { type: 'array', description: 'Git repos to clone.', items: { type: 'object', properties: { url: { type: 'string' }, ref: { type: 'string' }, install_to: { type: 'string', description: 'Relative path inside technique dir to clone into' }, note: { type: 'string' } }, required: ['url'] } },
            models_or_assets: { type: 'array', description: 'Files to download (model weights, datasets, binaries).', items: { type: 'object', properties: { url: { type: 'string' }, destination: { type: 'string', description: 'Relative path inside technique dir to save to' }, sha256: { type: 'string' }, note: { type: 'string' } }, required: ['url', 'destination'] } },
            manual_steps: { type: 'array', items: { type: 'string' }, description: 'Free-text steps the importing trainer must walk the user through (signups, hardware setup, etc.).' },
          },
        },
        publish: { type: 'boolean', description: 'TRUE = save and publish immediately so other agents can use_technique it. FALSE (default) = save as draft, only usable after a separate publish_technique call. Pass TRUE whenever the user expects the technique to be usable now.' },
      },
      required: ['name', 'display_name', 'description', 'instructions'],
    },
    fields: {
      display_name: {
        requiredNotEnforced:
          'executeSaveTechnique refuses with one message naming all four fields at once ' +
          '("name, display_name, description, and instructions are all required."), which the per-field message would split',
      },
    },
  },
  {
    name: 'use_technique',
    description: 'Activate and load a technique. Prefer technique_read for browsing/searching, use_technique now returns an outline (sections + supporting files + sizes), and you call technique_read action="section" to read specific parts. Big techniques no longer truncate.\n\nWhen you load a technique, apply its actual steps rather than skipping back to cached memory. You MAY optionally call technique_acknowledge(name, summary) to record that you engaged with it, but it is not required and no tools are blocked either way.',
    effects: [{ kind: 'fs_read', from: 'derived:the technique directory named by args.name' }],
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Technique ID (the short name) to load' },
      },
      required: ['name'],
    },
  },
  {
    name: 'technique_acknowledge',
    description: 'OPTIONAL. Note that you have engaged with a technique after reading it. This is not required and nothing is blocked without it (the old acknowledgement gate was removed). Pass the technique\'s slug (or display name) and a short paraphrase of its key steps. Use it only when you want to record that you processed the material before applying it; otherwise just go straight to the work.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Technique slug/id or display name (must match the technique you just read).' },
        summary: { type: 'string', description: 'Your own short paraphrase of the technique\'s key steps. Minimum 100 characters. Doesn\'t need to be exhaustive, just enough to demonstrate you processed the content.' },
      },
      required: ['name', 'summary'],
    },
  },
  {
    name: 'technique_read',
    description: 'Read a technique with surgical precision instead of slurping the whole thing. Five actions: (1) outline [default], returns headings, line ranges, char counts, and supporting files; never truncates; ALWAYS your first call when consulting a technique. (2) section, read one section by section_name="<title>" (case-insensitive substring match) or lines="start-end"; oversize sections require explicit line ranges. (3) search, query="<term>" greps TECHNIQUE.md AND all supporting files, returns matches with file + line number + surrounding context; best path through a huge technique. (4) list_files, list the technique\'s supporting files. (5) read_file, read one supporting file by file="<path>", optional lines="start-end".\n\nWhen you read a technique, apply what it says rather than falling back to cached memory (agents used to read techniques and then ignore them). You MAY optionally call technique_acknowledge afterward to record that you engaged, but it is not required and no tools are blocked. Pattern: technique_read (one or more times to load what you need), then do the work.',
    effects: [
      { kind: 'fs_read', from: 'args.file' },
      { kind: 'fs_read', from: 'derived:the technique directory named by args.name' },
    ],
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Technique ID, slug, or display name.' },
        action: { type: 'string', enum: ['outline', 'section', 'search', 'list_files', 'read_file'], description: 'Which read to perform. Default: outline.' },
        section_name: { type: 'string', description: 'For action="section": the heading title (case-insensitive substring match, e.g. "Stage 1" matches "## Stage 1, Brief").' },
        lines: { type: 'string', description: 'For action="section" or action="read_file": line range like "100-200" (inclusive, 1-indexed).' },
        query: { type: 'string', description: 'For action="search": text to find (case-insensitive substring).' },
        include_files: { type: 'boolean', description: 'For action="search": include supporting files in the search. Default true.' },
        file: { type: 'string', description: 'For action="read_file": relative path inside the technique directory (e.g. "templates/brief.md").' },
      },
      required: ['name'],
    },
    concurrency: 'safe',
  },
  {
    name: 'list_techniques',
    description: 'List available techniques. Default returns compact rows (name + id + tags + state). For descriptions and usage counts on every result, pass verbose=true; for the full instructions of ONE technique, use use_technique(name).',
    effects: [{ kind: 'fs_read', from: 'derived:the techniques directory' }],
    input_schema: {
      type: 'object',
      properties: {
        tag: { type: 'string', description: 'Filter by tag' },
        include_drafts: { type: 'boolean', description: 'Include draft techniques (Sensei only)' },
        verbose: { type: 'boolean', description: 'If true, include description and usage count per technique. Default false (compact rows).' },
      },
      required: [],
    },
    concurrency: 'safe',
    maxResultTokens: 2000,
  },
  {
    name: 'publish_technique',
    description: 'Publish a draft technique, making it available to all agents. **Trainer agent only**, non-trainer callers get refused with a redirect.',
    effects: [{ kind: 'fs_write', from: 'derived:the technique directory named by args.name' }],
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Technique ID to publish' },
      },
      required: ['name'],
    },
  },
  {
    name: 'update_technique',
    description: 'Update a technique\'s display name, description, instructions, files, or dependency manifest. Instruction changes create a version snapshot; metadata-only changes (display_name / description / dependencies) do not. **Trainer agent only**, non-trainer callers get refused with a redirect.\n\nFile-reference validation runs the same way as save_technique: if `instructions` references a path that isn\'t in the support dir AND isn\'t declared in dependencies, the update is refused.',
    effects: [
      { kind: 'fs_write', from: 'args.files[].path' },
      { kind: 'net', from: 'args.dependencies.repos[].url' },
      { kind: 'fs_write', from: 'args.dependencies.repos[].install_to' },
      { kind: 'net', from: 'args.dependencies.models_or_assets[].url' },
      { kind: 'fs_write', from: 'args.dependencies.models_or_assets[].destination' },
    ],
    nonEffects: {
      'dependencies.language_packages[].install_in': 'a package-manager working directory recorded in the manifest for the importing trainer to act on later; this call writes nothing there',
    },
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Technique ID (slug) to update, NOT the new display name. Use display_name to rename.' },
        display_name: { type: 'string', description: 'New human-readable name shown in the UI. Slug/ID does not change.' },
        description: { type: 'string', description: 'New description text.' },
        instructions: { type: 'string', description: 'Updated TECHNIQUE.md content. Bumps the version. Validated against the technique\'s support files + dependency manifest.' },
        files: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } }, description: 'Files to add or update inside the technique directory.' },
        dependencies: {
          type: 'object',
          description: 'Replace the technique\'s dependency manifest. Pass the FULL manifest (read the existing one first with technique_read action="read_file" file="dependencies.json" if you only want to add an entry, this overwrites).',
          properties: {
            system_packages: { type: 'array', items: { type: 'object', properties: { manager: { type: 'string' }, package: { type: 'string' }, version: { type: 'string' }, note: { type: 'string' } }, required: ['manager', 'package'] } },
            language_packages: { type: 'array', items: { type: 'object', properties: { manager: { type: 'string' }, package: { type: 'string' }, version: { type: 'string' }, install_in: { type: 'string' }, note: { type: 'string' } }, required: ['manager', 'package'] } },
            repos: { type: 'array', items: { type: 'object', properties: { url: { type: 'string' }, ref: { type: 'string' }, install_to: { type: 'string' }, note: { type: 'string' } }, required: ['url'] } },
            models_or_assets: { type: 'array', items: { type: 'object', properties: { url: { type: 'string' }, destination: { type: 'string' }, sha256: { type: 'string' }, note: { type: 'string' } }, required: ['url', 'destination'] } },
            manual_steps: { type: 'array', items: { type: 'string' } },
          },
        },
        change_summary: { type: 'string', description: 'Brief description of what changed.' },
      },
      required: ['name', 'change_summary'],
    },
    fields: {
      change_summary: {
        requiredNotEnforced:
          'executeUpdateTechnique DEFAULTS it (`args.change_summary as string || "Updated by agent"`), so an update ' +
          'without one succeeds today — enforcing it here would be a new refusal that removes a working call',
      },
    },
  },
  {
    name: 'submit_technique_for_review',
    description: 'Mark a draft technique as ready for Sensei review.',
    effects: [{ kind: 'fs_write', from: 'derived:the technique directory named by args.name' }],
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Technique ID to submit for review' },
      },
      required: ['name'],
    },
  },
  {
    name: 'delete_technique',
    description: 'Permanently delete a technique and all its files. **Trainer agent only**, non-trainer callers get refused with a redirect. Only use when the user explicitly asks to delete. Cannot be undone.',
    effects: [{ kind: 'fs_delete', from: 'derived:the technique directory named by args.name' }],
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Technique ID (slug) to delete' },
      },
      required: ['name'],
    },
  },
  {
    name: 'technique_list_versions',
    description: 'List the on-disk version history of a technique. Returns each version\'s number, change summary, who made it, when, and the absolute file path you can `file_read` to inspect the prior content. Use this when you (the Trainer) need to look at how a technique evolved or restore a prior version. The current TECHNIQUE.md is always the latest version; older versions live in <technique-dir>/versions/TECHNIQUE_v{N}.md.',
    effects: [{ kind: 'fs_read', from: 'derived:the technique version directory named by args.name' }],
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Technique ID (slug) to list versions for' },
      },
      required: ['name'],
    },
    concurrency: 'safe',
    maxResultTokens: 2000,
  },
  {
    name: 'technique_set_placeholder',
    description: 'Fill in a {{NEEDS_FROM_USER:LABEL}} placeholder across an imported technique\'s files with a value the user provided. Use this during the setup conversation that follows a technique import: read the IMPORT_MANIFEST.json + README.md in the technique\'s directory, ask the user for each placeholder one at a time, then call this tool with the answer. After every placeholder is filled, call technique_finalize.',
    effects: [{ kind: 'fs_write', from: 'derived:every file of the technique directory named by args.technique' }],
    fields: {
      'value': { secret: true },
    },
    input_schema: {
      type: 'object',
      properties: {
        technique: { type: 'string', description: 'Technique ID (slug) being set up' },
        label: { type: 'string', description: 'Placeholder label (UPPER_SNAKE_CASE), must match one listed in the manifest' },
        value: { type: 'string', description: 'The actual value (API key, token, URL, etc.) the user provided' },
      },
      required: ['technique', 'label', 'value'],
    },
  },
  {
    name: 'technique_finalize',
    description: 'Finalize an imported technique once every placeholder has been filled in. Removes the staged IMPORT_MANIFEST.json and flips the technique\'s state from needs_setup → draft so it can be published. Only valid after every technique_set_placeholder call has been made; will refuse if any markers remain.',
    effects: [
      { kind: 'fs_write', from: 'derived:the technique directory named by args.technique' },
      { kind: 'fs_delete', from: 'derived:the staged IMPORT_MANIFEST.json of that technique directory' },
    ],
    input_schema: {
      type: 'object',
      properties: {
        technique: { type: 'string', description: 'Technique ID (slug) to finalize' },
      },
      required: ['technique'],
    },
  },

  // ── Vault (Long-Term Memory) ──

  {
    name: 'vault_remember',
    description: 'Save an important piece of knowledge to the dojo\'s long-term memory vault. Saved immediately and visible to all agents.\n\n**NEVER store credentials, API keys, tokens, passwords, secrets, or any other authentication material in the vault.** Those go in `credential_add`, they live in a separate encrypted store that never decays, never appears in vault_search or Dreamer summaries, and is read on-demand at API-call time via `credential_get`. The engine will refuse vault entries that look like credentials.\n\nWHEN THE USER EXPLICITLY ASKS YOU TO REMEMBER SOMETHING, phrases like "remember that…", "I want you to remember…", "always do X", "never do Y", "from now on, …", "make sure you always…", call this tool with `verbatim: true` and `pin: true`. Pass the user\'s instruction word-for-word in `content`. Do NOT paraphrase or compress; the user\'s exact wording is the point.\n\nFor everything else (facts you observed, decisions made, preferences inferred), write a tight summary and let the DOJO handle filler-stripping.\n\nExample (user-explicit): vault_remember({ content: "Always confirm with the user before pushing to main.", type: "preference", verbatim: true, pin: true }).\nExample (observed): vault_remember({ content: "Tunnel: Cloudflare named.", type: "fact" }).\n\nWhen a fact came from a URL, a file, or a document, pass its location in source_ref (and source_page / source_section when you know them) so you can cite it and re-open the original later. Example (with source): vault_remember({ content: "Cardiologist cleared patient for surgery.", type: "fact", source_ref: "doctor-report-2026.pdf", source_page: 3 }).',
    effects: [],
    nonEffects: {
      'source_ref': 'RULING (T1): a polymorphic locator — a URL or a file/document reference — STORED as provenance on the vault entry, never dereferenced by the platform. Declares no effect today; a future reader that fetches it declares the effect here',
    },
    input_schema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The knowledge to remember. Write a tight summary unless verbatim=true, in which case pass the user\'s exact words.' },
        type: { type: 'string', enum: ['fact', 'preference', 'decision', 'procedure', 'relationship', 'event', 'note'], description: 'Type of knowledge' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags for categorization' },
        pin: { type: 'boolean', description: 'If true, this memory is always included in context regardless of relevance. Set true when the user explicitly tells you to remember something.' },
        permanent: { type: 'boolean', description: 'If true, this fact never decays over time (use for definitionally stable truths like names, relationships, birth dates).' },
        verbatim: { type: 'boolean', description: 'If true, the DOJO preserves your content exactly, no bloat-phrase stripping, no date prefix, no compression. Use when capturing the user\'s explicit memory instruction word-for-word ("remember that…", "always X", "never Y", "from now on…").' },
        distinct: { type: 'boolean', description: 'Set true ONLY after a near-duplicate bounce, when the new fact is genuinely DIFFERENT from the existing entry it resembles (not a correction of it). This tells the engine to save it as a separate entry even though it reads similar. If instead your new fact corrects or replaces the existing one, do NOT set distinct, call vault_update(entry_id=…) on that entry.' },
        source_ref: { type: 'string', description: 'Optional. Where this fact came from: a URL (https://...) or a file / document path (e.g. "doctor-report-2026.pdf"). Pass it whenever the fact was read from a specific source, so it can be cited and reopened later. Does not count against entry length.' },
        source_page: { type: 'number', description: 'Optional. Page number within source_ref, when the fact came from a specific page of a document (e.g. 3).' },
        source_section: { type: 'string', description: 'Optional. Section or heading within source_ref, when known (e.g. "Assessment").' },
      },
      required: ['content', 'type'],
    },
    fields: {
      type: {
        requiredNotEnforced:
          'executeVaultRemember refuses a missing type by NAMING the seven valid kinds (fact, preference, decision, ' +
          'procedure, relationship, event, note) — the generic message would send the model guessing',
      },
    },
  },
  {
    name: 'vault_search',
    description: 'Search the dojo\'s long-term memory vault. Two modes: `semantic` (default) uses embedding similarity, great for conceptual recall like "what does the user prefer about commit messages?". `exact` does substring matching on entry content, use when you need to find a literal string, e.g. debugging memory poisoning, finding entries that mention a specific name/phrase/typo verbatim, or auditing what got saved. Semantic search is blind to exact spelling (a query for "corp erp" returns concepts about email domains, not the literal string), so reach for `exact` whenever the question is "is this specific text anywhere in my memory?". Use vault_get(entry_id) for full content of a match, vault_update to fix incorrect entries in place, vault_forget to mark obsolete.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to search for' },
        mode: { type: 'string', enum: ['semantic', 'exact'], description: 'semantic (default): embedding similarity. exact: substring LIKE match on content.' },
        type: { type: 'string', enum: ['fact', 'preference', 'decision', 'procedure', 'relationship', 'event', 'note'], description: 'Filter by memory type (optional)' },
        limit: { type: 'number', description: 'Max results (default 5)' },
      },
      required: ['query'],
    },
    concurrency: 'safe',
    maxResultTokens: 2000,
  },
  {
    name: 'vault_get',
    description: 'Get the full content of a specific vault entry by ID. Pairs with vault_search, search returns short snippets; expand returns the full entry when you need details.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        entry_id: { type: 'string', description: 'Vault entry ID (from vault_search results)' },
      },
      required: ['entry_id'],
    },
    concurrency: 'safe',
    maxResultTokens: 4000,
  },
  {
    name: 'vault_refresh',
    description:
      'Re-load the session-start vault snapshot mid-conversation: pinned entries + entries tagged `session_context`. Use when the long-term memory has changed (you or the user just added/edited an important entry) and you want it reflected immediately without waiting for the next session reset. Returns the freshly-loaded entries as a snapshot.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
    concurrency: 'safe',
    maxResultTokens: 4000,
  },
  {
    name: 'vault_forget',
    description: 'Mark a vault entry as obsolete. Use when information is no longer accurate or relevant. The entry is soft-deleted, not destroyed. Sensei agents only.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        entry_id: { type: 'string', description: 'The vault entry ID to mark as obsolete' },
        reason: { type: 'string', description: 'Why this is no longer accurate' },
      },
      required: ['entry_id', 'reason'],
    },
    fields: {
      reason: {
        requiredNotEnforced:
          'executeVaultForget refuses a missing reason with what the reason is FOR ("explain why this is no longer ' +
          'accurate") — the audit value of the field is in that sentence',
      },
    },
  },
  {
    name: 'vault_update',
    description: 'Replace the content of an existing vault entry in place. Use this instead of vault_forget + vault_remember when you need to CORRECT an entry, the existing entry ID stays stable, embedding gets regenerated, and there is no window where two contradictory versions co-exist. Common case: an entry contains a factual error, an outdated fact, or a self-defeating "DON\'T do X" warning that is now reinforcing the bad behavior. Rewrite it as the positive correct form. Required `reason` is logged for audit.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        entry_id: { type: 'string', description: 'The vault entry ID to update (from vault_search results)' },
        new_content: { type: 'string', description: 'The replacement content. Should be the corrected fact stated positively, do not include the wrong form as a "don\'t" reminder, because future you will re-read it and get poisoned again.' },
        reason: { type: 'string', description: 'Brief audit note: what changed and why (e.g., "corrected misspelling that was causing the agent to reproduce the typo").' },
      },
      required: ['entry_id', 'new_content', 'reason'],
    },
  },
  {
    name: 'vault_discard_archives',
    description: 'Permanently delete one or more conversation archives from vault_conversations WITHOUT extracting any vault entries from them. Use when the conversations are junk (test runs, error spam, repetitive nonsense, ephemeral chatter) that does not need to be remembered. Unlike complete_task on a Dreamer batch (which marks archives as processed because real work was done), this tool throws the archives away unread. Returns the number of archives actually deleted. Dreamer-only.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        archive_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Archive IDs to discard. Get IDs from your cycle message\'s "Full archive list" or from the batch text.',
        },
        reason: {
          type: 'string',
          description: 'Brief explanation for the audit log (e.g., "test conversation, no meaningful content").',
        },
      },
      required: ['archive_ids', 'reason'],
    },
  },

  // ── DOJO Contacts (v2.9.16) ──
  // DOJO-native person records, separate from Microsoft/Google contact
  // directories. Agents write to this store as they learn about people
  // the owner interacts with; the owner can read and edit through the
  // dashboard's Vault → Contacts tab.
  {
    name: 'contact_remember',
    description: 'Record or update a contact in the DOJO contacts store. Upserts: if any provided email/phone/imessage handle (or display_name) matches an existing record, the new fields APPEND to that record - emails/phones/handles/tags merge with dedup; notes get timestamped and appended. If no match, a new contact is created (display_name required in that case). Use this whenever you learn something about a person the owner interacts with: "introduced by Marcus 2026-06-05", "prefers iMessage over email", "works at Acme as the buyer", a new email address, etc. Different from vault_remember because contacts is structured person-as-entity storage; use vault_remember for general facts and decisions that aren\'t about a specific person.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        contact_id: { type: 'string', description: 'Existing contact ID (full or 8-char prefix). Optional - if omitted, the tool matches on email/phone/imessage/display_name.' },
        display_name: { type: 'string', description: 'Full name. Required when creating a new contact.' },
        preferred_name: { type: 'string', description: 'Nickname / short form / what the owner actually calls them.' },
        emails: { type: 'array', items: { type: 'string' }, description: 'Email addresses. Merge-appended on existing records.' },
        phones: { type: 'array', items: { type: 'string' }, description: 'Phone numbers. Merge-appended on existing records.' },
        imessage_handles: { type: 'array', items: { type: 'string' }, description: 'iMessage handles (typically a phone or Apple ID email). Merge-appended on existing records.' },
        company: { type: 'string', description: 'Organization / company.' },
        role: { type: 'string', description: 'Title or relationship label ("buyer", "neighbor", "agent\'s contact at vendor X").' },
        notes: { type: 'string', description: 'Freeform observation. On an existing record this is appended with a timestamp; on a new record it is the initial notes body.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Short tags like "family", "client", "vendor", "personal". Merge-appended on existing records.' },
      },
      required: [],
    },
  },
  {
    name: 'contact_search',
    description: 'Search the DOJO contacts store by partial match across name, preferred_name, company, role, emails, phones, imessage_handles, tags, and notes. Returns a compact one-line-per-contact list; call contact_get for the full record. Empty query returns the most recently updated contacts.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search term. Matched case-insensitively across all searchable fields.' },
        limit: { type: 'number', description: 'Maximum results (default 20, capped at 200).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'contact_list',
    description: 'List contacts in the DOJO store. Sort options: "updated" (default, newest activity first), "name" (display_name A-Z), "company". Useful for browsing rather than targeted lookup; for lookup prefer contact_search.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        sort_by: { type: 'string', enum: ['updated', 'name', 'company'], description: 'Sort key. Default "updated".' },
        limit: { type: 'number', description: 'Page size (default 50).' },
        offset: { type: 'number', description: 'Skip this many records (for pagination).' },
      },
      required: [],
    },
  },
  {
    name: 'contact_get',
    description: 'Fetch a single contact\'s full record: all addresses, tags, notes, and provenance. Pass the contact_id from contact_search or contact_list (full UUID or 8-char prefix).',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        contact_id: { type: 'string', description: 'Contact ID (full or 8-char prefix).' },
      },
      required: ['contact_id'],
    },
  },
  {
    name: 'contact_update',
    description: 'Explicit field-level edit of a contact, distinct from the upsert-semantics of contact_remember. Pass mode="replace" (default) to overwrite list fields and notes with the new values, or mode="append" to merge into the existing values (same merge semantics as contact_remember).',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        contact_id: { type: 'string', description: 'Contact ID (full or 8-char prefix).' },
        display_name: { type: 'string' },
        preferred_name: { type: 'string' },
        emails: { type: 'array', items: { type: 'string' } },
        phones: { type: 'array', items: { type: 'string' } },
        imessage_handles: { type: 'array', items: { type: 'string' } },
        company: { type: 'string' },
        role: { type: 'string' },
        notes: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        mode: { type: 'string', enum: ['replace', 'append'], description: 'Default "replace". Use "append" when adding to existing lists/notes without losing what was there.' },
      },
      required: ['contact_id'],
    },
  },
  {
    name: 'contact_forget',
    description: 'Delete a contact from the DOJO store. Irreversible. Use only when the owner has explicitly asked to drop a contact, or for cleanup of a record you mistakenly created.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        contact_id: { type: 'string', description: 'Contact ID (full or 8-char prefix).' },
      },
      required: ['contact_id'],
    },
  },
  {
    name: 'contacts_overview',
    description: 'Quick orientation: how many contacts the DOJO has on file, the top tags, and the top companies. Cheap, no args.',
    effects: [],
    input_schema: { type: 'object', properties: {}, required: [] },
  },

  // ── Squad Coordination (Phase 7 / Part X) ──
  // Shared memory for agents in the same group_id. Faster than A2A messages
  // for handing structured context between squad members.
  {
    name: 'squad_share',
    description: 'Write a piece of knowledge into your squad\'s shared memory so other members can recall it. Squad-scoped (only visible to agents in the same group_id). Use for handoffs, coordination notes, shared findings, things teammates need that don\'t belong in your personal vault. Example: squad_share({ content: "Customer prefers phone calls before 5pm PT.", tags: ["customer", "comms"] }).',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The shared knowledge.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags for filtering on recall.' },
      },
      required: ['content'],
    },
  },
  {
    name: 'squad_recall',
    description: 'Search your squad\'s shared memory for relevant entries written by you or other members. Returns short snippets, call vault_get(entry_id) for full content if needed. Example: squad_recall({ query: "customer comms" }).',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords to search for. Pass an empty string to list recent entries regardless of content.' },
        tag: { type: 'string', description: 'Filter to entries with this tag (optional).' },
        limit: { type: 'number', description: 'Max results (default 5).' },
      },
      required: [],
    },
    concurrency: 'safe',
    maxResultTokens: 2000,
  },
  {
    name: 'dreamer_run_now',
    description: 'THE tool for running a dream cycle on demand. Do NOT send_to_agent the Dreamer to ask it to dream, the Dreamer agent is reactive, not self-starting; only this tool kicks the actual extraction pipeline (process unprocessed conversation archives → extract memories into the vault → write a dream_reports row). Use whenever the user says "run the dreamer", "process my recent conversations", "consolidate memories", "wind things down", or anything similar. The cycle runs in the background and takes 30s–3min. Returns whether the cycle started + the Dreamer agent ID. Primary agent only.',
    effects: [],
    input_schema: { type: 'object', properties: {}, required: [] },
    concurrency: 'serial',
    maxResultTokens: 1000,
  },
  {
    name: 'cost_summary',
    description: 'Get a quick spend report: today\'s total cost across all agents and the top 3 spenders by agent and by model. Use this when the user asks "what has the DOJO cost today" or similar. Primary agent only.',
    effects: [],
    input_schema: { type: 'object', properties: {}, required: [] },
    concurrency: 'safe',
    maxResultTokens: 1500,
  },
  {
    name: 'channel_inspect',
    description: 'Snapshot of every communication channel you have active right now: which mailboxes you monitor, which you can send from, which the owner uses personally, iMessage/Teams reachability, safe-sender counts, account types. Call this when you need to answer "what mailbox should I send from?" or "do I have access to <channel>?" or when the per-turn [Channel landscape] block from a non-dashboard trigger isn\'t enough detail. Cheap, no args. On dashboard turns the landscape block is omitted to save tokens, so this is the way to look up the same info on demand.',
    effects: [],
    input_schema: { type: 'object', properties: {}, required: [] },
    concurrency: 'safe',
    maxResultTokens: 1500,
  },
  {
    name: 'open_settings',
    description: 'Open the dashboard Settings panel to a specific tab (and optionally scroll to a section) on the user\'s screen. Use when the user asks where a setting lives or asks you to take them to it ("where do I change my voice?", "open my channel settings", "take me to where I add a provider"). This only moves the UI for a user who has the dashboard open; it changes no settings on its own. Pick the tab that holds what they asked about: platform (Dojo capacity, Ollama, system model, remote access, web search, migration, restart), providers (LLM provider API keys), models (enable models, pricing, and the image/video/TTS/music/vision/transcription model pickers), router (model routing + test), profile (your name, about-you), security (dashboard password), sensei (dreamer + healer schedules), channels (iMessage, Twilio/SMS, Google + Microsoft accounts), integrations (Plaud), voice (TTS/STT voice, speed, wake word), update (version + software update). Optionally pass `section` as the heading of the specific card to scroll to (e.g. "Hands-free wake word", "Playback speed", "Twilio", "Remote Access"), it best-effort matches a section title within the tab. To actually CHANGE a capability model yourself, prefer set_capability_model; use this when the user wants to see/change it themselves.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        tab: {
          type: 'string',
          enum: ['platform', 'providers', 'models', 'router', 'profile', 'security', 'sensei', 'channels', 'integrations', 'voice', 'update'],
          description: 'Which settings tab to open.',
        },
        section: {
          type: 'string',
          description: 'Optional. The heading of the specific section/card to scroll to within the tab (e.g. "Hands-free wake word", "Twilio", "Web Search Provider"). Best-effort match against the section titles on that tab.',
        },
      },
      required: ['tab'],
    },
    concurrency: 'safe',
    maxResultTokens: 300,
  },
  {
    name: 'dashboard_navigate',
    description: 'Navigate the user\'s dashboard to a top-level page. Use when the user asks you to take them somewhere ("show me the cost dashboard", "open the tracker", "pull up my agents"). Only moves the UI for a user who has the dashboard open; changes nothing on its own. For the Settings page use open_settings instead. Pages: chat (main conversation), agents (agent roster), techniques (saved workflows), tracker (tasks + projects), memory (vault + memories), costs (spend dashboard), health (system health).',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        page: {
          type: 'string',
          enum: ['chat', 'agents', 'techniques', 'tracker', 'memory', 'costs', 'health'],
          description: 'Which page to open.',
        },
      },
      required: ['page'],
    },
    concurrency: 'safe',
    maxResultTokens: 300,
  },
  {
    name: 'set_capability_model',
    description: 'Change which model the DOJO uses for a media/perception capability, on the user\'s behalf ("use Flux for image generation", "switch the video model to Veo", "use the on-device whisper for transcription"). Do this yourself with this tool when asked, don\'t tell the user to go change it in Settings. The model must already be added and enabled in Settings → Models and actually have that capability, if it isn\'t, this changes nothing and returns the list of valid models so you can pick correctly. Capabilities: image (the image_create tool), video (video_create), tts (tts_create / spoken audio), music (music_create), vision (the fallback model that reads images + screenshots), transcription (speech-to-text; also accepts local:whisper or local:moonshine for the on-device engines). NOTE: this is only for the platform capability models, to change the PRIMARY agent\'s own chat model, use update_agent instead.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        capability: {
          type: 'string',
          enum: ['image', 'video', 'tts', 'music', 'vision', 'transcription'],
          description: 'Which capability\'s model to set.',
        },
        model_id: {
          type: 'string',
          description: 'The model id to use (must be enabled and have the capability). For transcription you may also pass local:whisper or local:moonshine. Use list_models to find the right id if unsure.',
        },
      },
      required: ['capability', 'model_id'],
    },
    concurrency: 'serial',
    maxResultTokens: 1500,
  },
  {
    name: 'check_for_update',
    description: 'Check whether a newer version of the DOJO platform is available, comparing the installed version against the latest release ON THE USER\'S SELECTED UPDATE CHANNEL. The dojo has two channels (set in Settings → Update): "Stable" (normal releases, the default) and "Preflight" (pre-release/test builds, versioned like 3.1.8-preflight.2). This tool reports whichever the user is on, the result states the channel, so relay it: never present a Preflight build as a normal stable release. Read-only: reports the installed version, the latest version, whether an update is available, the release notes (what changed), the channel, and when the check was last run. Reads a snapshot the engine refreshes once a day, so it answers instantly without hitting the network (the timestamp tells you how fresh it is). Use when the user asks "is there an update?", "am I on the latest version?", "what\'s in the new version?", or as a precursor to apply_update so you can tell them what they\'d be getting. If the user has set up a recurring task to check for updates, this is the tool that task calls.',
    effects: [{ kind: 'net', from: 'fixed:the GitHub release feed for the selected channel' }],
    input_schema: { type: 'object', properties: {}, required: [] },
    concurrency: 'safe',
    maxResultTokens: 1500,
  },
  {
    name: 'apply_update',
    description: 'Download and install the latest DOJO platform update FROM THE USER\'S SELECTED CHANNEL (Stable or Preflight, see check_for_update), then restart the server. If the user is on Preflight this installs a pre-release/test build; if they ask to update but you suspect they want a normal release, confirm the channel first. Do this ONLY when the user explicitly asks you to update ("update the dojo", "install the new version", "go ahead and update"). The DOJO will be briefly unavailable while it restarts (a few seconds under normal supervision), so let the user know it\'s restarting. Only works on production installs, not a dev server. If already up to date it just says so. Prefer calling check_for_update first so you can confirm what\'s changing.',
    effects: [
      { kind: 'net', from: 'fixed:the release archive of the selected channel' },
      { kind: 'proc', from: 'derived:unzip, rsync and npm install over the running install' },
      { kind: 'fs_write', from: 'derived:the running install directory' },
    ],
    input_schema: { type: 'object', properties: {}, required: [] },
    concurrency: 'serial',
    maxResultTokens: 1000,
  },
  {
    name: 'set_voice',
    description: 'Change the voice you speak with and/or its playback speed, on the user\'s behalf ("use the Bella voice", "switch to a British voice", "slow your voice down", "talk a bit faster"). Do this yourself with this tool when asked, don\'t tell the user to change it in Settings. The voice name is matched against the on-device Kokoro voices (built-in + any the user imported) first, then the Hume cloud library if cloud voice is set up; if nothing matches it returns some valid voice names instead of changing anything. Speed is 0.5–2 where 1 is normal. Provide a voice, a speed, or both. Changes take effect the next time voice mode starts.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        voice: {
          type: 'string',
          description: 'A voice name or id (e.g. "Bella", "am_michael"). Matched against on-device then cloud voices.',
        },
        speed: {
          type: 'number',
          description: 'Playback speed, 0.5–2 (1 = normal). Optional.',
        },
      },
      required: [],
    },
    concurrency: 'serial',
    maxResultTokens: 1000,
  },
  {
    name: 'set_channel',
    description: 'Turn a communication channel on or off on the user\'s behalf ("turn on the iMessage bridge", "disable SMS", "enable Twilio voice calls"). This is something you DO for the user with this tool, do NOT tell them to go flip it in the dashboard themselves; that is exactly what this tool is for. Channels: imessage (the iMessage bridge, needs a bridge recipient already configured in Settings → Channels), twilio (the Twilio integration master switch, needs Twilio credentials configured), sms (Twilio text messaging), voice_calls (Twilio phone calls). If a prerequisite is missing it tells you what to set up first rather than half-enabling a broken channel. To add someone to a channel\'s allowed-sender list, use add_safe_sender instead.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        channel: {
          type: 'string',
          enum: ['imessage', 'twilio', 'sms', 'voice_calls'],
          description: 'Which channel to toggle.',
        },
        enabled: {
          type: 'boolean',
          description: 'true to enable, false to disable.',
        },
      },
      required: ['channel', 'enabled'],
    },
    concurrency: 'serial',
    maxResultTokens: 1000,
  },
];

// Phase 3 (2026-05-04), register definition-level concurrency overrides
// with the v2 partitioner. Tools that omit `concurrency` fall through to
// the hardcoded TOOL_CATEGORY map in concurrency.ts (no behavior change
// for tools that haven't been migrated).
//
// Phase 3.5 (2026-05-04), also register `maxResultTokens` so the cross-file
// registry covers tools beyond agent/tools.ts (Google, MS, Slides, Office).
// `applyMaxResultTokensCap` consults the registry first, then this file's
// `toolDefinitions` array as a backup.
import { registerConcurrency, registerMaxResultTokens, getRegisteredMaxResultTokens } from './v2/classifiers/concurrency.js';
for (const def of toolDefinitions) {
  if (def.concurrency) registerConcurrency(def.name, def.concurrency);
  if (def.maxResultTokens) registerMaxResultTokens(def.name, def.maxResultTokens);
}

// ── Path Resolution ──
// resolvePath / SENSITIVE_BASENAMES / isSensitivePath moved to
// agent/path-guards.ts (PHASE-0 T10) so the case-fold and the share gate have
// one home. Imported at the top of this file; behaviour is unchanged here.


// The exec sensitive-file scan MOVED to `agent/brokers/proc.ts` at PHASE-5 T2.
// It answered "may this command run" from inside the string-exec handler, i.e. from the
// handler, while the ladder answered the same question at the door — two places,
// one question, which is the shape this phase exists to delete. The broker now
// asks it, with the refusal message carried verbatim on the verdict so nothing
// an agent reads changed.

// ── Tool Execution ──

// PHASE-5 T4: `auditLog` and its AUDIT_ACTION_MAP moved to
// `agent/tools/util.ts`. A relocated handler cannot import this file (that is
// the cycle the split is undoing), and two copies of an audit writer is exactly
// the disease — so there is ONE, imported by both surfaces.

// ════════════════════════════════════════════════════════════════════════════
// THE TWO EXEC DOORS (PHASE-5 T3 Step 1).
//
// WHAT STOOD HERE. One function — the string-exec entry point — which took
// `args.command as string` and handed it to `execAsync(command, { shell:
// '/bin/zsh' })`. It is DELETED — not flag-disabled, not renamed — and its
// identifier is grep-zero. Everything that made it dangerous was structural: the
// tool's schema said *"the shell command to execute"*, so the model composed
// shell syntax, and the gate in front of it could only ever inspect a program
// NAME inside a line the shell was about to re-parse.
//
// WHAT STANDS HERE INSTEAD:
//   `executeArgv`        `exec({argv})` — `execFile`, no shell at all. The
//                        program is argv[0], every other element is one literal
//                        argument, and the shell's metacharacters are inert.
//   `executeShellScript` `shell({script})` — `/bin/zsh -c <script>`, the same
//                        interpreter with the same semantics as before, behind
//                        its OWN grant class, with the FULL script text audited.
//
// ⚠ `executeShellScript` IS NOT THE DELETED ENTRY POINT RENAMED, and the
// difference is worth stating because a reviewer should be able to check it: the
// old function read `args.command`, was gated by a check that saw only a base
// command, and audited `command` as its target with no record of what the shell
// then did with it. This one reads `args.script`, is gated by the `shell` grant
// rows through the same seam the approval gate uses, and writes the whole script
// to the audit row. The owner's EXEC-LOOP ruling (2026-07-28) rides here intact:
// an agent with shell access runs loops, pipes and redirects as it did yesterday.
//
// The RUNNING — the per-stream 16K caps, the `stdout_truncated:true` flags, the
// `command_failed:` header, the ENOENT/SIGTERM translation — moved verbatim to
// `agent/tools/process-run.ts` so both doors share one body by construction.
// ════════════════════════════════════════════════════════════════════════════

/** Both doors write the same audit shape the deleted entry point wrote. */
function processAuditFor(agentId: string): ProcessAudit {
  return (target, result, detail) => auditLog(agentId, 'exec', target, result, detail);
}

/**
 * `exec({argv})` — ONE program, literal arguments, NO shell.
 *
 * The authority question was already answered at the door (`gates.ts` row 3 →
 * `authorizeExecShapedCall` → `authorizeArgv`), including the global denies, the
 * shell-interpreter refusal and the tokenized sensitive-read scan. What is left
 * here is running it, which is the shape a handler should have.
 */
async function executeArgv(agentId: string, args: Record<string, unknown>): Promise<string> {
  const resolved = resolveArgvArg(args.argv);
  if (!resolved.ok) {
    return `Error: ${resolved.reason}. exec takes an argv ARRAY: exec({argv:["ls","-la","/tmp"]}). For pipes, redirection, globbing or loops use the shell tool instead: shell({script:"..."}).`;
  }
  const { cwd, note } = resolveProcessCwd(args.cwd);
  const timeout = processTimeout(args.timeout);
  logger.info('Executing program', { argv: resolved.value.argv, timeout, cwd }, agentId);
  return runProcess({
    auditTarget: resolved.value.display,
    file: resolved.value.program,
    argv: [...resolved.value.argv.slice(1)],
    timeout, cwd, note,
    audit: processAuditFor(agentId),
  });
}

/**
 * `shell({script})` — `/bin/zsh -c <script>`, the pipe/loop/redirect door.
 *
 * `execFile('/bin/zsh', ['-c', script])` is what `execAsync(cmd,{shell:'/bin/zsh'})`
 * did internally, so the SEMANTICS an agent depends on are unchanged to the byte.
 * The difference is that the script arrives as one named argument at a door whose
 * grant is named `shell`, and the audit row carries the whole of it.
 */
async function executeShellScript(agentId: string, args: Record<string, unknown>): Promise<string> {
  const script = typeof args.script === 'string' ? args.script : '';
  if (script.trim().length === 0) {
    return 'Error: shell requires a non-empty `script` string, e.g. shell({script:"ls -la | wc -l"}).';
  }
  const { cwd, note } = resolveProcessCwd(args.cwd);
  const timeout = processTimeout(args.timeout);
  // The FULL script text, not a base command — auditing what the shell was
  // actually handed is the point of giving it its own door.
  logger.info('Executing shell script', { script, timeout, cwd }, agentId);
  return runProcess({
    auditTarget: script,
    file: '/bin/zsh',
    argv: ['-c', script],
    timeout, cwd, note,
    audit: processAuditFor(agentId),
  });
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
const PDF_EXTENSIONS = new Set(['.pdf']);
const IMAGE_MEDIA_TYPES: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp',
};
// Max file size for vision injection (20MB)
const MAX_VISION_FILE_SIZE = 20 * 1024 * 1024;

// Shape of a persisted attachment row (messages.attachments JSON array).
// See db/migrations/011_attachments.sql. All fields optional here because the
// column is model/route-fed and we parse it defensively.
interface StoredAttachment {
  fileId?: string;
  filename?: string;
  mimeType?: string;
  size?: number;
  path?: string;
}

// FN-5 assist for a known model-floor miss. With an image attached, the
// correctness-floor model sometimes calls file_read on a FABRICATED path, the
// original filename WITHOUT the stored timestamp prefix, and hits a dead-end
// "File not found". This looks back over the agent's recent attachments and,
// on a name match, hands back the exact stored Path so the retry can correct
// itself. It returns ONLY a path string that was already disclosed to the
// model in the attachment pointer (chat.ts), never file content; a retry with
// the corrected path still runs every permission check (absolute-path,
// sensitive-path block, etc.). Uploads are stored as
// <timestamp>_<sanitizedOriginalName> (gateway/routes/upload.ts).
function findAttachmentByName(agentId: string, requested: string): StoredAttachment | null {
  const wantBase = path.basename(requested).toLowerCase();
  // Mirror the upload sanitizer (gateway/routes/upload.ts:100).
  const sanitize = (s: string): string => s.replace(/[^a-zA-Z0-9._-]/g, '_');
  const wantSanitized = sanitize(path.basename(requested)).toLowerCase();

  let rows: Array<{ attachments: string | null }>;
  try {
    rows = getDb().prepare(
      `SELECT attachments FROM messages
       WHERE agent_id = ? AND attachments IS NOT NULL AND attachments != '[]'
       ORDER BY rowid DESC LIMIT 30`,
    ).all(agentId) as Array<{ attachments: string | null }>;
  } catch {
    return null;
  }

  for (const row of rows) {
    if (!row.attachments) continue;
    let list: unknown;
    try {
      list = JSON.parse(row.attachments);
    } catch {
      continue; // skip unparseable rows
    }
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      const att = item as StoredAttachment;
      if (typeof att.path !== 'string' || att.path === '') continue;
      const attName = typeof att.filename === 'string' ? att.filename : '';
      const attPathBase = path.basename(att.path);
      const attNameLower = attName.toLowerCase();
      const attPathBaseLower = attPathBase.toLowerCase();
      const matches =
        (attNameLower !== '' && attNameLower === wantBase) ||
        (attPathBaseLower === wantBase) ||
        (attNameLower !== '' && sanitize(attName).toLowerCase() === wantSanitized) ||
        (attPathBaseLower === wantSanitized);
      if (matches) return att;
    }
  }
  return null;
}

// Tail appended to a file_read miss when findAttachmentByName hits. Carries the
// already-disclosed stored Path plus the timestamp-prefix reminder; the vision
// note discourages redundant re-reads of image attachments already provided
// via vision or caption.
function attachmentPathHint(att: StoredAttachment): string {
  return ` A recent attachment matches this name. Its stored path is: ${att.path}. Attachments are stored with a timestamp prefix; use the exact Path from the attachment pointer. Note: image attachments are already provided to you via vision or caption; re-reading the image file is usually unnecessary.`;
}

async function executeFileRead(
  agentId: string,
  args: Record<string, unknown>,
): Promise<string | { text: string; contentBlocks: Array<{ type: string; [key: string]: unknown }> }> {
  const filePath = resolvePath(args.path as string);

  if (!path.isAbsolute(filePath)) {
    // The absolute-path requirement stays. But a non-absolute path is exactly
    // the shape of the fabricated-filename miss (bare original name, no stored
    // prefix), so try the attachment assist before the plain refusal.
    const att = findAttachmentByName(agentId, filePath);
    if (att) {
      auditLog(agentId, 'file_read', filePath, 'error', 'Path must be absolute; attachment-name hint returned');
      return `Error: Path must be absolute. Use ~ for home directory or provide a full path.${attachmentPathHint(att)}`;
    }
    auditLog(agentId, 'file_read', filePath, 'error', 'Path must be absolute (use ~ for home directory)');
    return 'Error: Path must be absolute. Use ~ for home directory or provide a full path.';
  }

  // Block reads of secrets / SSH keys / cloud credentials. See isSensitivePath
  // up top for the full list. The result must never enter messages, the
  // CLAUDE.md secrets-out-of-memory rule applies at every entry point.
  if (isSensitivePath(filePath)) {
    auditLog(agentId, 'file_read', filePath, 'denied', 'sensitive path block list');
    return `[BLOCKED] file_read refused: ${filePath} is on the sensitive-files block list (secrets.yaml, .env files, SSH keys, cloud credentials). The DOJO never echoes secret files into the conversation. If you need a value from this file, ask the user, those values live in process memory only.`;
  }

  try {
    const stat = await fs.promises.stat(filePath).catch(() => null);
    if (!stat) {
      // Self-correcting assist: the model may have dropped the stored timestamp
      // prefix off an attachment name. Hand back the exact stored Path if a
      // recent attachment matches (the sensitive-path block above already ran;
      // a retry with the corrected path re-runs every check).
      const att = findAttachmentByName(agentId, filePath);
      if (att) {
        auditLog(agentId, 'file_read', filePath, 'error', 'File not found; attachment-name hint returned');
        return `Error: File not found: ${filePath}.${attachmentPathHint(att)}`;
      }
      auditLog(agentId, 'file_read', filePath, 'error', 'File not found');
      return `Error: File not found: ${filePath}`;
    }

    if (stat.isDirectory()) {
      auditLog(agentId, 'file_read', filePath, 'error', 'Path is a directory');
      return 'Error: Path is a directory, use file_list instead';
    }

    const ext = path.extname(filePath).toLowerCase();

    // ── Image files: return as vision content block ──
    // The model sees the actual image via its vision capabilities,
    // same as when a user attaches an image to a chat message.
    if (IMAGE_EXTENSIONS.has(ext)) {
      if (stat.size > MAX_VISION_FILE_SIZE) {
        auditLog(agentId, 'file_read', filePath, 'error', `Image too large: ${stat.size} bytes`);
        return `Error: Image is too large (${(stat.size / 1024 / 1024).toFixed(1)}MB). Max is 20MB.`;
      }
      const data = await fs.promises.readFile(filePath);
      const base64 = data.toString('base64');
      const mediaType = IMAGE_MEDIA_TYPES[ext] ?? 'image/png';

      auditLog(agentId, 'file_read', filePath, 'success', `image ${stat.size} bytes`);

      return {
        text: `Image loaded: ${filePath} (${(stat.size / 1024).toFixed(0)}KB, ${mediaType})`,
        contentBlocks: [
          { type: 'text', text: `Image: ${path.basename(filePath)} (${(stat.size / 1024).toFixed(0)}KB)` },
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
        ],
      };
    }

    // ── PDF files: return as document content block ──
    if (PDF_EXTENSIONS.has(ext)) {
      if (stat.size > MAX_VISION_FILE_SIZE) {
        auditLog(agentId, 'file_read', filePath, 'error', `PDF too large: ${stat.size} bytes`);
        return `Error: PDF is too large (${(stat.size / 1024 / 1024).toFixed(1)}MB). Max is 20MB.`;
      }
      const data = await fs.promises.readFile(filePath);
      const base64 = data.toString('base64');

      auditLog(agentId, 'file_read', filePath, 'success', `pdf ${stat.size} bytes`);

      return {
        text: `PDF loaded: ${filePath} (${(stat.size / 1024).toFixed(0)}KB)`,
        contentBlocks: [
          { type: 'text', text: `PDF: ${path.basename(filePath)} (${(stat.size / 1024).toFixed(0)}KB)` },
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 }, title: path.basename(filePath) },
        ],
      };
    }

    // ── Text files: return as text ──
    const content = await fs.promises.readFile(filePath, 'utf-8');
    const allLines = content.split('\n');
    const totalLines = allLines.length;

    // Phase 3.5 offset/limit support, when an agent explicitly paginates,
    // we return exactly the requested range with line numbers and a stub
    // telling them how to read more. This is also the path that bypasses
    // the v1 large-files interception (so an agent can ALWAYS get raw
    // content of a large file by paginating, even on v1).
    // Phase 3.5 fix, defensive coerce. DeepSeek emits these as strings even
    // when schema says number; without coerce pagination silently no-ops.
    const offsetNum = coerceNumberArg(args.offset);
    const limitNum = coerceNumberArg(args.limit);
    const offset = offsetNum !== null ? Math.max(0, Math.floor(offsetNum)) : null;
    const limit = limitNum !== null ? Math.max(1, Math.floor(limitNum)) : null;

    // Pagination path with line numbers + clear stub on truncation. The v1
    // raw-string fallback (with large-files.ts interception) was removed in
    // Phase 9 Stage 2, paginated read is now the only path.
    {
      const startLine = offset ?? 0;
      // v2.7.2, default line count bumped 2000 → 5000 to match the
      // expanded cap below. Most documents the agent reads (briefs,
      // transcripts, code files) fit in a single call now.
      const requestedCount = limit ?? 5000;
      const endLine = Math.min(startLine + requestedCount, totalLines);

      // v2.7.2, cap raised from 30_000 chars (~7.5K tokens) to 240_000
      // (~60K tokens). The old cap was 5-7% of a typical model's context
      // window, so agents kept truncating mid-document, restarting the
      // task, and giving up. Modern model contexts are 128K-200K+; a
      // ~60K cap lets a 120-page document land in one call. The friendly
      // pagination trailer still fires when the file is bigger than the
      // cap, and the per-tool maxResultTokens (also 60000) keeps any
      // edge cases from blowing the runtime cap. Leaves headroom for
      // the trailer text itself.
      const MAX_CHARS = 240_000;
      // Per-line cap: protects against files where a single line is huge, 
      // e.g. an HTML file with embedded `<img src="data:image/png;base64,...">`.
      // Without this, the whole-file cap below was bypassed via the
      // `slice.length > 0` clause (we always included the first line, no
      // matter how big), and a 5.9MB single-line file blew the entire model
      // context window.
      const MAX_LINE_CHARS = 4_000;
      const truncateLine = (line: string): string =>
        line.length > MAX_LINE_CHARS
          ? `${line.slice(0, MAX_LINE_CHARS)} … [line truncated; original ${line.length} chars, likely contains base64/binary data. Use grep/exec to inspect specific patterns.]`
          : line;
      const slice: string[] = [];
      let chars = 0;
      let actualEnd = startLine;
      for (let i = startLine; i < endLine; i++) {
        const line = truncateLine(allLines[i] ?? '');
        if (chars + line.length + 1 > MAX_CHARS && slice.length > 0) break;
        slice.push(`${i + 1}\t${line}`);
        chars += line.length + 1;
        actualEnd = i + 1;
      }

      const linesShown = actualEnd - startLine;
      const lineWidth = String(actualEnd).length;
      // Re-format with right-aligned line numbers like Read tool does
      const formatted = slice
        .map((s) => {
          const [num, ...rest] = s.split('\t');
          return `${num.padStart(lineWidth)}\t${rest.join('\t')}`;
        })
        .join('\n');

      let result = formatted;
      if (actualEnd < totalLines) {
        const remaining = totalLines - actualEnd;
        result += `\n\n[Read lines ${startLine}-${actualEnd - 1} of ${totalLines} total. ${remaining} more lines remain.\n` +
          ` To continue: file_read(path="${filePath}", offset=${actualEnd}, limit=${Math.min(remaining, 5000)}).\n` +
          ` To search for specific content: use grep instead.]`;
      } else if (startLine > 0) {
        result += `\n\n[End of file. Read lines ${startLine}-${actualEnd - 1} of ${totalLines} total.]`;
      }

      auditLog(agentId, 'file_read', filePath, 'success', `${stat.size} bytes (lines ${startLine}-${actualEnd}/${totalLines})`);
      return result;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    auditLog(agentId, 'file_read', filePath, 'error', msg);
    return `Error reading file: ${msg}`;
  }
}

// Correctness-floor: the weak model sometimes hands file_write a DIRECTORY path
// where a file path is expected (the workspace folder, no filename). Writing to
// a directory throws EISDIR. Build the corrective, NON-crashing guidance that
// tells the model to include a filename, used both by the up-front check and
// the EISDIR catch fallback so a raw EISDIR is never surfaced as an is_error.
function directoryTargetGuidance(dirPath: string): string {
  const base = dirPath.replace(/[/\\]+$/, '');
  const example = path.join(base, 'brief.md');
  return (
    `That path is a directory, not a file, so nothing was written. ` +
    `Pass a full file path that includes a filename and extension, for example: ${example} ` +
    `(pick a name and extension that fit what you are saving), then call file_write again with that path.`
  );
}

async function executeFileWrite(agentId: string, args: Record<string, unknown>): Promise<string> {
  const filePath = resolvePath(args.path as string);
  const content = args.content as string;

  if (!path.isAbsolute(filePath)) {
    auditLog(agentId, 'file_write', filePath, 'error', 'Path must be absolute (use ~ for home directory)');
    return 'Error: Path must be absolute. Use ~ for home directory or provide a full path.';
  }

  // Directory target detection: an existing directory, or a trailing-separator
  // path that signals directory intent before the folder even exists. Return
  // corrective guidance (not an is_error) rather than letting writeFile throw
  // EISDIR at the weak model.
  const trailingSep = /[/\\]\s*$/.test(String(args.path ?? '')) || /[/\\]$/.test(filePath);
  let existingDir = false;
  try { existingDir = (await fs.promises.stat(filePath)).isDirectory(); } catch { /* not present yet */ }
  if (existingDir || trailingSep) {
    auditLog(agentId, 'file_write', filePath, 'error', 'target is a directory, not a file (no filename supplied)');
    return directoryTargetGuidance(filePath);
  }

  try {
    const dir = path.dirname(filePath);
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(filePath, content, 'utf-8');
    auditLog(agentId, 'file_write', filePath, 'success', `${content.length} bytes written`);

    const downloadUrl = registerSharedFile(agentId, filePath);
    // P6b-2: record the minted link as a keyed artifact row so the
    // never-drop-the-link backstop reads rows, not result prose.
    if (downloadUrl) queueLinkArtifact(agentId, downloadUrl, filePath);
    // Auto-open documents (html/markdown/text) in the canvas; refresh if already shown.
    const canvas = syncCanvasAfterWrite(agentId, filePath, downloadUrl);
    const canvasNote = canvas.opened
      ? '\nThis document is now open in the canvas, the user can see it. No need to call canvas_render; just tell them what you did.'
      : '';
    return `File written successfully: ${filePath} (${content.length} bytes)${canvasNote}${downloadUrl ? `\nDownload: ${downloadUrl}\nWhen you give this file to the user (or hand it to another agent), share the Download link above by default; mention the local path only if asked where it is on disk.` : ''}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    auditLog(agentId, 'file_write', filePath, 'error', msg);
    // Belt-and-suspenders: if a directory (or dir-valued path component) slipped
    // past the pre-check, translate the raw EISDIR into the same corrective
    // guidance instead of a bare is_error crash the weak model can't recover from.
    if ((err as NodeJS.ErrnoException)?.code === 'EISDIR') {
      return directoryTargetGuidance(filePath);
    }
    return `Error writing file: ${msg}`;
  }
}

async function executeFileAppend(agentId: string, args: Record<string, unknown>): Promise<string> {
  const filePath = resolvePath(args.path as string);
  const content = (args.content as string) ?? '';
  const ensureNewline = args.ensure_newline !== false; // default true

  if (!path.isAbsolute(filePath)) {
    auditLog(agentId, 'file_write', filePath, 'error', 'Path must be absolute (use ~ for home directory)');
    return 'Error: Path must be absolute. Use ~ for home directory or provide a full path.';
  }

  // Same directory-target guard as file_write: a directory path has no filename
  // to append to and would throw EISDIR. Return corrective guidance, not a crash.
  const trailingSep = /[/\\]\s*$/.test(String(args.path ?? '')) || /[/\\]$/.test(filePath);
  let existingDir = false;
  try { existingDir = (await fs.promises.stat(filePath)).isDirectory(); } catch { /* not present yet */ }
  if (existingDir || trailingSep) {
    auditLog(agentId, 'file_write', filePath, 'error', 'target is a directory, not a file (no filename supplied)');
    return directoryTargetGuidance(filePath);
  }

  try {
    const dir = path.dirname(filePath);
    await fs.promises.mkdir(dir, { recursive: true });

    let leading = '';
    if (ensureNewline) {
      // Peek at the existing trailing byte (if any) to decide whether we
      // need a separator. fs.stat is cheaper than reading the file.
      let existingSize = 0;
      try {
        const stat = await fs.promises.stat(filePath);
        existingSize = stat.size;
      } catch { /* file doesn't exist, append creates it, no leading newline needed */ }
      if (existingSize > 0) {
        const fh = await fs.promises.open(filePath, 'r');
        try {
          const buf = Buffer.alloc(1);
          await fh.read(buf, 0, 1, existingSize - 1);
          if (buf[0] !== 0x0a) leading = '\n'; // not LF, add one
        } finally {
          await fh.close();
        }
      }
    }

    const payload = leading + content;
    await fs.promises.appendFile(filePath, payload, 'utf-8');
    const stat = await fs.promises.stat(filePath);
    auditLog(agentId, 'file_write', filePath, 'success', `${payload.length} bytes appended (total ${stat.size})`);

    const downloadUrl = registerSharedFile(agentId, filePath);
    if (downloadUrl) queueLinkArtifact(agentId, downloadUrl, filePath);
    // W3 fix loop (run bmr5bymntm5): same refresh-or-AUTO-OPEN treatment as
    // file_write. Pre-fix this only pinged an already-open canvas, so "edit
    // this doc and show me" surfaced or not depending on whether the model
    // happened to pick file_write (auto-open) or file_append (nothing), the
    // canvas outcome must not hinge on the model's tool choice.
    const canvas = syncCanvasAfterWrite(agentId, filePath, downloadUrl);
    const canvasNote = canvas.opened
      ? '\nThis document is now open in the canvas, the user can see it. No need to call canvas_render; just tell them what you did.'
      : '';
    return `Appended ${payload.length} bytes to ${filePath}. Total size: ${stat.size} bytes.${canvasNote}${downloadUrl ? `\nDownload: ${downloadUrl}\nWhen you give this file to the user (or hand it to another agent), share the Download link above by default; mention the local path only if asked where it is on disk.` : ''}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    auditLog(agentId, 'file_write', filePath, 'error', msg);
    if ((err as NodeJS.ErrnoException)?.code === 'EISDIR') {
      return directoryTargetGuidance(filePath);
    }
    return `Error appending to file: ${msg}`;
  }
}

// ── file_patch ──
//
// Surgical in-place edit. Reads the file, applies every patch in sequence
// against the in-memory copy, refuses to write if any search string isn't
// found, writes via temp-file + rename for atomicity. Binary files are
// rejected (we only deal with text). Sensitive paths (secrets.yaml, .env,
// SSH keys, cloud credentials) are blocked the same way file_read is.

interface FilePatch {
  search: string;
  replace: string;
  replace_all?: boolean;
}

export async function executeFilePatch(
  agentId: string,
  args: Record<string, unknown>,
): Promise<string> {
  const filePath = resolvePath(args.path as string);
  const patches = args.patches as FilePatch[];
  const dryRun = args.dry_run === true;

  if (!path.isAbsolute(filePath)) {
    auditLog(agentId, 'file_patch', filePath, 'error', 'Path must be absolute');
    return 'Error: Path must be absolute. Use ~ for home directory or provide a full path.';
  }

  if (isSensitivePath(filePath)) {
    auditLog(agentId, 'file_patch', filePath, 'denied', 'sensitive path block list');
    return `[BLOCKED] file_patch refused: ${filePath} is on the sensitive-files block list (secrets.yaml, .env files, SSH keys, cloud credentials). The DOJO never lets agents rewrite secret files.`;
  }

  // Validate every patch up front so we fail fast before reading the file.
  for (let i = 0; i < patches.length; i++) {
    const p = patches[i];
    if (!p || typeof p !== 'object') {
      return `Error: patches[${i}] must be an object with { search, replace }.`;
    }
    if (typeof p.search !== 'string' || p.search.length === 0) {
      return `Error: patches[${i}].search must be a non-empty string. An empty search would match everywhere.`;
    }
    if (typeof p.replace !== 'string') {
      return `Error: patches[${i}].replace must be a string (use "" to delete the matched span).`;
    }
  }

  let stat: import('node:fs').Stats;
  try {
    stat = await fs.promises.stat(filePath);
  } catch {
    auditLog(agentId, 'file_patch', filePath, 'error', 'File not found');
    return `Error: File not found: ${filePath}. file_patch only edits files that already exist, use file_write to create new ones.`;
  }
  if (stat.isDirectory()) {
    return `Error: ${filePath} is a directory, not a file.`;
  }

  let original: string;
  try {
    const buf = await fs.promises.readFile(filePath);
    // Binary detection: text files don't contain NUL bytes. Sample first
    // 8KB so we don't scan a 20MB HTML for every patch call.
    const sample = buf.subarray(0, Math.min(8192, buf.length));
    if (sample.includes(0)) {
      auditLog(agentId, 'file_patch', filePath, 'error', 'binary file');
      return `Error: ${filePath} appears to be binary (contains null bytes). file_patch only operates on text files.`;
    }
    original = buf.toString('utf-8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    auditLog(agentId, 'file_patch', filePath, 'error', `read failed: ${msg}`);
    return `Error reading file: ${msg}`;
  }

  // Apply each patch in sequence. Track replacement counts. If ANY patch
  // fails to find its search string, abort with a clear error, never a
  // silent zero-replacement success.
  let working = original;
  const counts: number[] = [];
  for (let i = 0; i < patches.length; i++) {
    const p = patches[i];
    if (!working.includes(p.search)) {
      const preview = p.search.length > 120 ? p.search.slice(0, 120) + '…' : p.search;
      auditLog(agentId, 'file_patch', filePath, 'error', `patch ${i + 1} not found`);
      return (
        `Error: patch ${i + 1} of ${patches.length} did not match. Search string was not found in the file:\n` +
        `  search: ${JSON.stringify(preview)}\n` +
        `No changes have been written. Read the file again to confirm the exact text, whitespace, line endings, and case all matter.`
      );
    }
    if (p.replace_all) {
      // Use split/join to count and replace every occurrence safely (no regex
      // escaping pitfalls with `.replaceAll`'s string overload? It uses
      // string-mode but we'd need a stable count anyway).
      const parts = working.split(p.search);
      counts.push(parts.length - 1);
      working = parts.join(p.replace);
    } else {
      const idx = working.indexOf(p.search);
      working = working.slice(0, idx) + p.replace + working.slice(idx + p.search.length);
      counts.push(1);
    }
  }

  const summary = patches
    .map((p, i) => {
      const tag = p.replace_all ? 'replace_all' : 'replace';
      const sPreview = p.search.length > 60 ? p.search.slice(0, 60) + '…' : p.search;
      return `  patch ${i + 1}: ${counts[i]} replacement${counts[i] === 1 ? '' : 's'} (${tag}, search=${JSON.stringify(sPreview)})`;
    })
    .join('\n');

  if (dryRun) {
    const beforeBytes = Buffer.byteLength(original, 'utf-8');
    const afterBytes = Buffer.byteLength(working, 'utf-8');
    auditLog(agentId, 'file_patch', filePath, 'success', `dry_run: ${counts.reduce((a, b) => a + b, 0)} total replacements`);
    return (
      `[Dry run, no changes written.]\n` +
      `${filePath} (${beforeBytes} → ${afterBytes} bytes)\n${summary}`
    );
  }

  // Atomic write: temp file in the same dir, then rename. fs.rename is
  // atomic on the same filesystem, so a crash mid-write either leaves the
  // original intact or commits the new content, never a half file.
  const tmpName = `.${path.basename(filePath)}.patch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp`;
  const tmpPath = path.join(path.dirname(filePath), tmpName);
  try {
    await fs.promises.writeFile(tmpPath, working, 'utf-8');
    await fs.promises.rename(tmpPath, filePath);
  } catch (err) {
    // Best-effort tmp cleanup, then return the error.
    try { await fs.promises.unlink(tmpPath); } catch { /* ignore */ }
    const msg = err instanceof Error ? err.message : String(err);
    auditLog(agentId, 'file_patch', filePath, 'error', `write failed: ${msg}`);
    return `Error writing patched file: ${msg}`;
  }

  const beforeBytes = Buffer.byteLength(original, 'utf-8');
  const afterBytes = Buffer.byteLength(working, 'utf-8');
  const totalReplacements = counts.reduce((a, b) => a + b, 0);
  auditLog(agentId, 'file_patch', filePath, 'success', `${totalReplacements} replacements across ${patches.length} patches`);
  const patchDownloadUrl = registerSharedFile(agentId, filePath);
  // W3 fix loop: refresh-or-AUTO-OPEN, same rationale as file_append above,
  // the canvas outcome must not depend on which write tool the model picked.
  const patchCanvas = syncCanvasAfterWrite(agentId, filePath, patchDownloadUrl);
  const patchCanvasNote = patchCanvas.opened
    ? '\nThis document is now open in the canvas, the user can see it. No need to call canvas_render; just tell them what you did.'
    : '';
  return (
    `Patched ${filePath} (${beforeBytes} → ${afterBytes} bytes, ${totalReplacements} total replacements)${patchCanvasNote}\n${summary}`
  );
}

async function executeFileList(agentId: string, args: Record<string, unknown>): Promise<string> {
  const dirPath = resolvePath(args.path as string);

  if (!path.isAbsolute(dirPath)) {
    auditLog(agentId, 'file_read', dirPath, 'error', 'Path must be absolute (use ~ for home directory)');
    return 'Error: Path must be absolute. Use ~ for home directory or provide a full path.';
  }

  try {
    const stat = await fs.promises.stat(dirPath).catch(() => null);
    if (!stat) {
      auditLog(agentId, 'file_read', dirPath, 'error', 'Directory not found');
      return `Error: Directory not found: ${dirPath}`;
    }

    if (!stat.isDirectory()) {
      auditLog(agentId, 'file_read', dirPath, 'error', 'Path is not a directory');
      return 'Error: Path is not a directory, use file_read instead';
    }

    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    const lines = await Promise.all(entries.map(async entry => {
      const type = entry.isDirectory() ? 'dir' : entry.isSymbolicLink() ? 'link' : 'file';
      try {
        const entryPath = path.join(dirPath, entry.name);
        const entryStat = await fs.promises.stat(entryPath);
        const size = entry.isDirectory() ? '-' : formatBytes(entryStat.size);
        return `${type}\t${size}\t${entry.name}`;
      } catch {
        return `${type}\t-\t${entry.name}`;
      }
    }));

    auditLog(agentId, 'file_read', dirPath, 'success', `${entries.length} entries`);
    return `Directory: ${dirPath}\n\n` + lines.join('\n');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    auditLog(agentId, 'file_read', dirPath, 'error', msg);
    return `Error listing directory: ${msg}`;
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}G`;
}

// ── Public API ──

// User-mailbox banner. Whenever the agent reads from the user's own
// email account (via the user_* variants of gmail / outlook read tools),
// prepend a framing line that names the mailbox owner and reminds the
// model: this is the USER's mailbox, the emails inside it were not
// addressed to you, and you should not act on their contents unless
// the user explicitly tells you to in chat.
//
// Background: agents with user-mailbox access were observed taking
// action on emails the user had sent to themselves (e.g. self-sent
// instructions for a side project), treating them as direct prompts.
// The engine framing here makes the audience explicit at every read
// so the model doesn't infer a directive from inbox content alone.
// PHASE-5 T4: `USER_MAILBOX_READ_TOOLS` + `prependUserMailboxBanner` moved to
// `agent/tools/provider/mailbox-banner.ts`, with the TEST that holds the
// behaviour — the explicit Google and Microsoft read handlers both banner, the
// default membership branch below banners Google reads and not Microsoft ones,
// and that asymmetry is now a measured, tested fact rather than a comment.

// PHASE-5 T4: `normalizeRepeatDaysOfWeek` + `REPEAT_DAY_NAME_MAP` moved to
// `agent/tools/cat/tracker.ts` with the three work-verb handlers that were
// their only callers.

// P6a: one tool call = one execution context. Everything below records against
// `toolCall.id` through getCurrentToolCallId, so the identity is attached here,
// at the single door every dispatch path goes through (the loop's parallel and
// serial batches, the loop's auto-delivery sends, and a2a-transport's parked-call
// resumes), rather than in a shared slot the concurrent batch overwrites. See the
// AsyncLocalStorage note in turn-state.ts.
export async function executeTool(agentId: string, toolCall: ToolCall): Promise<ToolOutcome> {
  // PHASE-4 T1 cluster 3: the door classifies. Everything below still speaks
  // `ToolResult`; the five-way is applied HERE, once, from `isError` + `errorCode` and
  // never from the prose — so a caller can tell "the platform refused" from "the tool
  // broke" without reading English, and cannot discard the answer (must-consume).
  return classifyToolResult(await runWithToolCallId(agentId, toolCall.id, () => executeToolInCallContext(agentId, toolCall)));
}

async function executeToolInCallContext(agentId: string, toolCall: ToolCall): Promise<ToolResult> {
  // C27 hook 2: resolve tool aliases FIRST, so the sim intercept, unknown-arg
  // detection, and every dispatcher case operate on the CANONICAL name. This is
  // the safety net covering every dispatch path (synthetic calls, A2A relay,
  // auto-route) even when the loop-ingestion hook (hook 1) did not run. A
  // tombstoned (removed) tool returns its pointer error immediately; a rename
  // prepends a one-line note so the model learns the new name.
  const resolved = resolveToolAlias(toolCall.name, (toolCall.arguments ?? {}) as Record<string, unknown>);
  if (resolved.tombstone) {
    return { toolCallId: toolCall.id, name: toolCall.name, content: resolved.tombstone, isError: true };
  }
  // PHASE-2 T5: ONE SCOPE PER SEND TOOL CALL, opened at the single door every dispatch path
  // goes through — the same place and the same reasoning as the P6a tool-call identity above.
  // This is what closes the ten unrecorded send paths in one change instead of ten: the tool
  // declares WHO is sending and on which channel, the transport door underneath it records
  // what actually happened, and `writeToolReceipt` links its receipt to that row from inside
  // the same scope. Nothing here decides an outcome, so a tool that refuses before reaching a
  // transport writes no row at all.
  const sendChannel = outboundChannelForTool(resolved.name);
  if (sendChannel !== null) {
    return withOutboundAsyncIfAbsent(
      {
        agentId, tool: resolved.name, channel: sendChannel,
        recipientId: outboundRecipientForTool(resolved.name, resolved.args as Record<string, unknown>),
        conversationId: currentTurnRoot.get(agentId)?.conversationId ?? null,
      },
      () => dispatchResolved(agentId, toolCall, resolved),
    );
  }
  return dispatchResolved(agentId, toolCall, resolved);
}

async function dispatchResolved(
  agentId: string,
  toolCall: ToolCall,
  resolved: { name: string; args: Record<string, unknown>; note?: string | null },
): Promise<ToolResult> {
  if (resolved.name === toolCall.name) {
    return executeToolInner(agentId, toolCall);
  }
  const result = await executeToolInner(agentId, { ...toolCall, name: resolved.name, arguments: resolved.args });
  if (resolved.note) result.content = `${resolved.note}\n${result.content}`;
  return result;
}

async function executeToolInner(agentId: string, toolCall: ToolCall): Promise<ToolResult> {
  const { id, name, arguments: args } = toolCall;

  logger.info('Executing tool', { tool: name, args }, agentId);

  // ── FU-4: executor-side tools_policy.deny enforcement ──
  // computeFilteredTools strips a denied tool from the advertised surface, but
  // that strip is only advisory (Architecture Rule 1: the engine enforces, the
  // model follows). The floor model parses tool calls from free text, so a
  // deny-listed agent (e.g. the technique trainer for the comms-to-people set)
  // can still emit a denied name and reach here. Re-check the SAME deny set (one
  // parser, parseToolsPolicy, backs both the strip and this gate) ahead of any
  // outbound-capture instrumentation, so a denied comms send is never even recorded as
  // captured. `name` is already alias-canonical (executeTool resolves it), and
  // parseToolsPolicy canonicalizes the deny entries, so both sides match.
  if (getAgentDenySet(agentId).has(name)) {
    auditLog(agentId, name, null, 'denied', `${name} is denied by this agent's tools_policy`);
    logger.warn('Blocked tools_policy-denied tool call', { tool: name }, agentId);
    return {
      toolCallId: id,
      name,
      content: `[BLOCKED by engine] ${name} is not available to this agent (denied by policy). The request was not performed. If this needs to happen, escalate to the primary agent with send_to_agent.`,
      isError: true, errorCode: 'PERMISSION_DENIED',
    };
  }

  // ── PM overseer verb enforcement (demolition Phase 1.7) ──
  // The PM is an OVERSEER, not a worker: it validates, overrides, retasks,
  // reassigns, and inspects; it never executes or edits the work itself, and
  // never flips a worker's status directly. computeFilteredTools already strips
  // non-allow-list tools from the PM's advertised surface, but per Architecture
  // Rule 1 that strip is advice only: the floor model can emit a worker verb
  // (a work_update status flip, spawn_agent, an exec/send) from free text and reach
  // here. Re-check the SAME single-source allow-list (`pmMayCall`, owned by
  // tracker/pm-agent.ts, which matches the OPERATION not the verb name — see the
  // T8V note there) at the executor and refuse anything outside it,
  // naming the overseer verbs so the PM redirects instead of doing the work.
  if (isPMAgent(agentId) && !pmMayCall(name, args)) {
    auditLog(agentId, name, null, 'denied', `${name} is outside the PM overseer allow-list`);
    logger.warn('Blocked PM tool call outside overseer allow-list', { tool: name }, agentId);
    return {
      toolCallId: id,
      name,
      content: `[BLOCKED by engine] You are the project manager (overseer), so "${name}" is not available to you. You do NOT execute or edit work; you oversee it. Your overseer verbs are: work_validate (bless or reject a close-out with action="validate", send work back with action="retask", adjudicate with action="override" / "apply_user_verdict"), work_update(action="reassign") to hand work to another agent, work_schedule (pause / resume), plus read-only inspection (work_update with action="get" or "list", file_read/file_list, history_search, vault_search) and messaging (send_to_agent, broadcast_to_group). If a worker needs to do "${name}", direct the assigned agent to do it via send_to_agent or work_validate(action="retask").`,
      isError: true,
    };
  }

  let content: string = '';
  let isError = false;
  // PHASE-4 T1 cluster 3: the door's own refusals say so STRUCTURALLY. The guard
  // branches below assign `content`/`isError` and `break` rather than returning, so
  // they need a place to record "the platform refused" that survives to the single
  // result below — otherwise the classifier reads them as `crashed`, which is a lie
  // about a guard that worked. Prose-matching `[BLOCKED]` is the banned alternative.
  let errorCode: ToolErrorCode | undefined;

  // ── v2.3.19 (Scenario 18 finding), unknown-arg detection ──
  // Pre-spec, an agent could call e.g. work_open(kind="task") with
  // schedule_cron="every fortnight" and the engine silently dropped the
  // unknown arg. Net result: the agent thought it scheduled a task and
  // it didn't, with no feedback. Now we detect args not in the tool's
  // declared schema and prepend a warning to the tool result so the
  // agent (and through it, the user) finds out.
  let unknownArgsWarning: string | null = null;
  try {
    const def = toolDefinitions.find((t) => t.name === name);
    if (def && def.input_schema && typeof def.input_schema === 'object') {
      const schema = def.input_schema as { properties?: Record<string, unknown> };
      const declared = new Set(Object.keys(schema.properties ?? {}));
      const extras = Object.keys(args ?? {}).filter(
        (k) => !k.startsWith('__') && !declared.has(k),
      );
      if (extras.length > 0) {
        // A tool the handler is ABOUT to refuse as not-available must not lead
        // with schema advice: the warning's "check the spelling with
        // load_tool_docs" reads to a floor model as "this tool exists for you,
        // fix the args and retry", which directly contradicts the refusal's
        // steering (observed: a persistent agent ping-ponged complete_task ->
        // schema warning -> load_tool_docs -> permission error). The FN-8
        // availability refusal carries its own redirect; let it speak alone.
        const refusalWillSpeak = name === 'complete_task' && !agentCanSelfCompleteById(agentId);
        if (!refusalWillSpeak) {
          const declaredList = [...declared].join(', ') || '(none)';
          unknownArgsWarning =
            `[Engine warning: "${name}" was called with arg(s) not in its schema, ${extras.map((e) => `"${e}"`).join(', ')}. These were silently ignored. Declared args: ${declaredList}. If you meant a different param, check the spelling with load_tool_docs(tools=["${name}"]).]`;
        }
        logger.warn('Unknown tool args ignored', {
          tool: name, extras, declared: [...declared],
        }, agentId);
      }
    }
  } catch { /* best effort */ }

  // ── Malformed tool call arguments ──
  // If the model produced invalid JSON for tool arguments, model.ts flags it
  // with __malformed_args. Return a clear error so the model can retry.
  if (args.__malformed_args) {
    const rawSnippet = String(args.__malformed_args).slice(0, 300);
    content = `Error: Your tool call arguments for "${name}" were malformed JSON and could not be parsed.\n\nThe raw text was:\n${rawSnippet}\n\nPlease retry this tool call with valid JSON arguments. Call load_tool_docs(tools=["${name}"]) to see the expected parameter schema.`;
    logger.warn('Rejecting tool call with malformed arguments', { tool: name, rawSnippet }, agentId);
    return { toolCallId: id, name, content, isError: true, errorCode: 'PARSE_ERROR' as const };
  }

  // ── THE GATE LOOP (PHASE-5 T2 Step 3) ─────────────────────────────────────
  // What stood here was a run of FIFTEEN `if (name === …)` branches of four
  // different kinds — six calling `checkPermission`, three testing the caller's
  // identity, two reading `created_by` out of the database, two reading the
  // manifest's `system_control` in place, and one (`web_browse`) holding TWO
  // gates that a single `authorize()` call cannot express. §T0-PINS P1 tabled
  // all fifteen with the requirement each one encoded; every requirement is now
  // a DECLARED gate in `agent/tools/gates.ts`, and this loop evaluates them.
  //
  // The point is not that it is shorter. It is that the requirement became a
  // value: `gatesForCall()` can be printed, diffed and tested, whereas fifteen
  // branches could only be read — and the survey found two the reading had
  // already lost (`web_browse`'s second gate, and `web_search`'s gate, which has
  // no argument to key on and is invisible to any scan of the args).
  //
  // RULING P5-R5 — ENFORCEMENT PARITY — is what this loop is measured against:
  // it refuses exactly what the fifteen branches refused, in the same order,
  // with the same words, the same `errorCode` per row, and the same audit rows.
  // A declared effect that no ladder row gated gets NO new refusal here; it is
  // RECORDED (`ungatedEffectKinds`) so the enumeration exists when the owner or
  // a later task decides one of them should gate.
  {
    const gates = gatesForCall(name, args);
    for (const gate of gates) {
      const outcome = await evaluateGate(gate, {
        agentId,
        name,
        args,
        // The two `created_by` rows resolve their target through the SAME
        // resolvers the handlers use; injected rather than imported so the gate
        // module does not have to reach back into this file.
        resolveRef: (entity, ref) => {
          const resolved = entity === 'agent'
            ? resolveAgentRef(ref, 'kill_agent')
            : resolveGroupRef(ref, 'delete_group');
          if (!resolved.ok) return null;
          const table = entity === 'agent' ? 'agents' : 'agent_groups';
          const row = getDb()
            .prepare(`SELECT created_by, name FROM ${table} WHERE id = ?`)
            .get(resolved.id) as { created_by: string | null; name: string | null } | undefined;
          if (!row) return null;
          return { id: resolved.id, createdBy: row.created_by, label: row.name ?? resolved.id };
        },
      });

      const { verdict } = outcome;
      if (verdict.allowed) continue;

      // ── Step 4's staging, and its ONE deliberate narrowing of itself ──
      // `logOnly` is true only for the two refusals T2 ADDS (the `-wal`/`-shm`
      // siblings, the symlink-resolved target on the read tier) and only for a
      // sub-agent. Every parity refusal enforces for every agent, always —
      // staging one of those off would be a capability widening in the
      // dangerous direction, which is the opposite of what a log-only window is
      // for. T5 fixes the sub-agent manifest; T7 deletes this branch.
      if (logOnly(agentId, verdict)) {
        logger.warn('BROKER (log-only, staged for sub-agents): would have refused', {
          tool: name, gateRow: outcome.gate.row, rule: verdict.rule,
          resource: outcome.resource, reason: verdict.reason,
        }, agentId);
        auditLog(agentId, outcome.auditAs || name, outcome.resource, 'denied', `[log-only] ${verdict.reason}`);
        continue;
      }

      auditLog(agentId, outcome.auditAs || name, outcome.resource, 'denied', verdict.reason);
      logger.warn('Blocked by a registry-declared gate', {
        tool: name, gateRow: outcome.gate.row, rule: verdict.rule, reason: verdict.reason,
      }, agentId);
      return {
        toolCallId: id,
        name,
        content: verdict.blockedMessage ?? permissionDeniedMessage(verdict.reason, agentId),
        isError: true,
        ...(outcome.errorCode ? { errorCode: outcome.errorCode as ToolErrorCode } : {}),
      };
    }

    // P5-R5's record-don't-refuse half, at debug so it costs nothing on the hot
    // path and is there the moment somebody asks "what does this tool do that
    // nothing checks?".
    const ungated = ungatedEffectKinds(name, gates);
    if (ungated.length > 0) {
      logger.debug('declared effects with no gate today (recorded, not refused)', {
        tool: name, effects: ungated,
      }, agentId);
    }
  }

  // ── THE ONE SCHEMA-VALIDATION BOUNDARY (PHASE-5 T3 Step 3, RULING P5-R8) ──
  // What stood here was 57 per-tool `checkRequired([...])` arrays inside the
  // dispatch cases below and 8 `validateAgainstSchema(...)` calls inside the
  // provider dispatchers — two mechanisms, one job, each re-stating field names
  // and types the tool's own `input_schema` declares. They are now one compiled
  // validator driven by that schema plus the `fields` sibling that carries what
  // JSON schema cannot say (`allowEmpty`, `requiredNotEnforced`). The four
  // messages are byte-identical to the ones the model has always retried on.
  //
  // POSITION IS DELIBERATE, and it is the ordering the deleted sites had:
  // AFTER the deny set, the PM allow-list and the gate loop, so a call the
  // platform REFUSES still answers "permission denied" rather than grading the
  // arguments of something it was never going to run; and BEFORE dispatch, so a
  // handler never sees a shape it would have crashed on. Alias resolution and
  // the weak-model arg repair both run ahead of this (`resolveToolAlias` at the
  // door, `coerceNumberArg` inside the handlers on OPTIONAL fields) — repair
  // first, then validation, unchanged.
  //
  // SCOPE is RULING P5-R8's: the tools these two mechanisms already covered.
  // Tools that never had a required-field check gain NO refusal here.
  if (isBoundaryValidated(name)) {
    const argsError = validateToolArgs(toolDefinitionsByName().get(name), args);
    if (argsError) {
      logger.warn('Tool call rejected by the schema-validation boundary', { tool: name, error: argsError }, agentId);
      // INVALID_ARGS had no writer before this boundary: a malformed-shape call
      // classified `crashed`, which reads as "the platform broke" when in fact
      // the platform refused a call it understood perfectly well. It says
      // `refused` now, structurally and not from prose.
      return { toolCallId: id, name, content: argsError, isError: true, errorCode: 'INVALID_ARGS' };
    }
  }

  try {
    // ── PDF tools (creation + manipulation, no external auth) ──
    if (pdfToolNames.includes(name)) {
      // T10: pdf_read and friends read a caller-chosen path straight into the
      // model's context. Gate every INPUT path exactly as share_file does.
      for (const rawPdfPath of pdfInputPaths(args)) {
        const pdfGuard = await sharePathGuard(agentId, name, rawPdfPath);
        if (!pdfGuard.allowed) {
          auditLog(agentId, name, pdfGuard.absPath, 'denied', pdfGuard.reason);
          return { toolCallId: id, name, content: pdfGuard.blockedMessage ?? permissionDeniedMessage(pdfGuard.reason, agentId), isError: true, errorCode: 'PERMISSION_DENIED' };
        }
      }
      content = await executePdfTool(name, args, agentId);
      isError = content.startsWith('Error');
      // Auto-open the produced PDF in the canvas (it renders natively). Every
      // PDF tool that writes an output reports it as ".../<file>.pdf"; the
      // read-only tools (pdf_read / pdf_get_info) don't produce a new file, so
      // skip them to avoid re-opening an input the agent was only inspecting.
      const PDF_READ_ONLY = name === 'pdf_read' || name === 'pdf_get_info';
      if (!isError && !PDF_READ_ONLY) {
        const pdfPath = content.match(/(\/\S+\.pdf)\b/i)?.[1];
        if (pdfPath && openFileInCanvas(agentId, pdfPath).opened) {
          content += '\n\nThis PDF is now open in the canvas, the user can see it. No need to call canvas_render, show_to_user, or share_file to show it; just tell them it is on the canvas (share the download link only if they ask to save it).';
        }
      }
      return { toolCallId: id, name, content, isError };
    }

    // ── Google Slides tools (many, dispatched before switch to avoid enumerating every case) ──
    // Available to both primary AND read-level agents (Ronin/Apprentice). PM agents
    // (googleAccess === 'none') are blocked because the tool isn't in their registry
    // at all, so they'd fall through to the unknown-tool path.
    if (slidesToolNames.includes(name)) {
      const slidesAccess = getAgentGoogleAccessLevel(agentId, isPrimaryAgent(agentId), isPMAgent(agentId));
      if (slidesAccess === 'none') {
        content = 'Permission denied: this agent does not have Google Slides access.';
        isError = true;
        auditLog(agentId, name, null, 'denied', 'Google Slides tool blocked: no Google access');
      } else {
        const agentRow = getDb().prepare('SELECT name FROM agents WHERE id = ?').get(agentId) as { name: string } | undefined;
        content = await executeGoogleSlidesTool(name, args, agentId, agentRow?.name ?? agentId);
        isError = content.startsWith('Error');
      }
      return { toolCallId: id, name, content, isError };
    }

    // ── Google Forms tools (mirror of slides dispatch). Read tools are
    // available to read-level agents; write tools are primary-only (enforced
    // by the tool-filtering step above, write tools won't appear in a
    // read-level agent's registry, so they fall through to "unknown tool"). ──
    if (formsToolNames.includes(name)) {
      const formsAccess = getAgentGoogleAccessLevel(agentId, isPrimaryAgent(agentId), isPMAgent(agentId));
      if (formsAccess === 'none') {
        content = 'Permission denied: this agent does not have Google Forms access.';
        isError = true;
        auditLog(agentId, name, null, 'denied', 'Google Forms tool blocked: no Google access');
      } else {
        const agentRow = getDb().prepare('SELECT name FROM agents WHERE id = ?').get(agentId) as { name: string } | undefined;
        content = await executeGoogleFormsTool(name, args, agentId, agentRow?.name ?? agentId);
        isError = content.startsWith('Error');
      }
      return { toolCallId: id, name, content, isError };
    }

    // PHASE-2 T8V: dispatch on the OPERATION, not the raw tool name. For the six
    // work verbs `workOperation` turns (name, args) into `<verb>:<discriminator>`;
    // every other tool keys on its own name exactly as before. Case labels below
    // therefore read `work_update:status` rather than a retired verb name, so
    // nothing in this switch can be mistaken for a tool name and T10's grep-zero
    // over the retired verb list has nothing left to find here.
    const dispatchKey = workOperation(name, args) ?? name;

    // ── THE RELOCATED HANDLERS (PHASE-5 T4) ─────────────────────────────────
    // Categories that have moved out of this file answer from `agent/tools/`
    // instead of from the switch below. A dispatch key is served by ONE of the
    // two, never both — a category's move deletes its cases in the same commit
    // that adds its module — so this is a shrinking switch, not a second
    // dispatcher racing it (roadmap non-negotiable #1). `handler-table.test.ts`
    // asserts the two key sets are disjoint rather than trusting the discipline.
    //
    // The handler answers with the same two values the case bodies assigned, so
    // everything below the switch — the per-tool `maxResultTokens` cap, the
    // unknown-args warning, the try/catch that turns a throw into
    // `Tool execution failed: …` — still applies to it identically.
    const relocated = handlerFor(dispatchKey);
    if (relocated) {
      const outcome = await relocated({ agentId, name, args, callId: id });
      content = outcome.content;
      isError = outcome.isError;
      if (outcome.errorCode) errorCode = outcome.errorCode;
    } else
    switch (dispatchKey) {
      case 'load_tool_docs': {
        const { executeLoadToolDocs } = await import('../tools/tool-docs.js');
        const requestedTools = (args.tools as string[]) ?? [];
        // v2.5.15, Validate the input shape FIRST and emit a precise error
        // so the agent doesn't conflate format problems with permission
        // problems. Previously a permission-stripped request fell through
        // to executeLoadToolDocs([]) which then complained about an
        // "empty array", sending the agent down the wrong rabbit hole.
        if (!Array.isArray(requestedTools)) {
          content = `Error: tools parameter must be an array of tool names. You passed ${typeof args.tools}. Example: load_tool_docs({tools: ["web_fetch", "gmail_send"]}).`;
          isError = true;
          break;
        }
        if (requestedTools.length === 0) {
          content = 'Error: tools parameter must be a non-empty array. Pass at least one tool name. Example: load_tool_docs({tools: ["web_fetch"]}).';
          isError = true;
          break;
        }
        // C27 hook 3: an old (renamed) tool name resolves to the NEW tool's
        // docs; collect a note so the model learns the new name. Tombstoned
        // (removed) tools keep their name and fall through to the blocked path.
        const aliasDocNotes: string[] = [];
        const canonicalRequested = requestedTools.map((t) => {
          const r = resolveToolAlias(t, {});
          if (r.tombstone) return t;
          if (r.name !== t) aliasDocNotes.push(`"${t}" is now "${r.name}"`);
          return r.name;
        });
        // Now intersect with the agent's accessible tools.
        const allowedToolNames = new Set(getFilteredTools(agentId).map(t => t.name));
        const filteredTools = canonicalRequested.filter(t => allowedToolNames.has(t));
        const blockedTools = canonicalRequested.filter(t => !allowedToolNames.has(t));
        if (filteredTools.length === 0) {
          // FN-8: only point at complete_task when this agent actually has it
          // (allowedToolNames already reflects the completability filter).
          const blockedEscalation = allowedToolNames.has('complete_task')
            ? `Ask the user to update this agent's permissions, or call complete_task(status="blocked").`
            : `Ask the user to update this agent's permissions, use send_to_agent to reach an agent with broader permissions, or tell the user you are blocked.`;
          content =
            `Error: none of the requested tools are accessible to this agent. ` +
            `Requested: [${requestedTools.join(', ')}]. ` +
            `This is a permission issue, not a format issue, the tools may exist for other agents but are not on this agent's allow list, or the permission filter is stripping them ` +
            `(e.g. web_search/web_fetch require network_domains != "none", exec requires exec_allow non-empty, file_read requires file_read permission). ` +
            blockedEscalation;
          isError = true;
          break;
        }
        content = executeLoadToolDocs(agentId, filteredTools);
        // C27 hook 3: tell the model which requested names were renamed.
        if (aliasDocNotes.length > 0 && !content.startsWith('Error')) {
          content += `\n\n[Engine note: ${aliasDocNotes.join('; ')}. Docs above are for the new name(s).]`;
        }
        // If some (but not all) of the requested tools were blocked, append
        // a note so the agent knows which ones it didn't get and why.
        if (blockedTools.length > 0 && !content.startsWith('Error')) {
          content +=
            `\n\n[Note: these requested tools were not accessible to this agent and were skipped: ${blockedTools.join(', ')}. ` +
            `Tools may be blocked by tools_policy or by permission filters (network/file/exec/etc.).]`;
        }
        isError = content.startsWith('Error');
        break;
      }
      case 'exec':
        content = await executeArgv(agentId, args);
        isError = content.startsWith('Error');
        break;
      case 'shell':
        content = await executeShellScript(agentId, args);
        isError = content.startsWith('Error');
        break;
      case 'file_read': {
        const fileResult = await executeFileRead(agentId, args);
        if (typeof fileResult === 'string') {
          content = fileResult;
          isError = content.startsWith('Error');
        } else {
          // Structured result with content blocks (images, PDFs)
          content = fileResult.text;
          // Attach the content blocks to the tool result so the runtime
          // can include them in the tool_result sent to the model
          (toolCall as unknown as Record<string, unknown>).__contentBlocks = fileResult.contentBlocks;
        }
        break;
      }
      case 'file_write': {
        content = await executeFileWrite(agentId, args);
        isError = content.startsWith('Error');
        break;
      }
      case 'file_append': {
        content = await executeFileAppend(agentId, args);
        isError = content.startsWith('Error');
        break;
      }
      case 'scratchpad_set': {
        const SCRATCHPAD_MAX_CHARS = 8000;
        const newContent = args.content as string;
        if (newContent.length > SCRATCHPAD_MAX_CHARS) {
          content = `Error: scratchpad content is ${newContent.length} chars; cap is ${SCRATCHPAD_MAX_CHARS}. Move detail into a real file and keep the scratchpad as a high-level index.`;
          isError = true;
          break;
        }
        // Refuse to stash technique content in the scratchpad.
        // Scratchpad survives across turns and gets re-injected at
        // every assembly, exactly the staleness the v2.7.4 freshness
        // enforcement was built to prevent. If the agent wants to
        // remember WHAT THEY DECIDED while following a technique
        // (parameters chosen, paths produced, errors hit), they can
        //, they just can't paste the technique body itself.
        if (newContent.includes(TECHNIQUE_FRESH_SENTINEL)) {   // PHASE-3 T5: was the inline literal
          content =
            'Refused: scratchpad content contains a technique fresh-read banner, looks like a copy-paste of technique_read / use_technique output. Scratchpad is re-injected on every turn, which would re-introduce the staleness the engine prevents on the tool-result side. Vault decisions ("chose path X for reason Y") or step-state ("step 3: writing yaml") in the scratchpad, re-call technique_read whenever you need the actual technique body.';
          isError = true;
          break;
        }
        try {
          const scratchDb = getDb();
          const row = scratchDb.prepare('SELECT config FROM agents WHERE id = ?').get(agentId) as { config: string } | undefined;
          const cfg = row?.config ? JSON.parse(row.config) as Record<string, unknown> : {};
          cfg.scratchpad = newContent;
          scratchDb.prepare("UPDATE agents SET config = ? WHERE id = ?").run(JSON.stringify(cfg), agentId);
          content = `Scratchpad updated (${newContent.length} chars). It will be re-injected at the top of your context on every turn until you clear it or your session resets.`;
        } catch (err) {
          content = `Error setting scratchpad: ${err instanceof Error ? err.message : String(err)}`;
          isError = true;
        }
        break;
      }
      case 'scratchpad_clear': {
        try {
          const scratchDb = getDb();
          const row = scratchDb.prepare('SELECT config FROM agents WHERE id = ?').get(agentId) as { config: string } | undefined;
          const cfg = row?.config ? JSON.parse(row.config) as Record<string, unknown> : {};
          delete cfg.scratchpad;
          scratchDb.prepare("UPDATE agents SET config = ? WHERE id = ?").run(JSON.stringify(cfg), agentId);
          content = 'Scratchpad cleared.';
        } catch (err) {
          content = `Error clearing scratchpad: ${err instanceof Error ? err.message : String(err)}`;
          isError = true;
        }
        break;
      }
      case 'file_patch': {
        if (!Array.isArray(args.patches) || args.patches.length === 0) {
          content = 'Error: patches must be a non-empty array of { search, replace } objects.';
          isError = true;
          break;
        }
        content = await executeFilePatch(agentId, args);
        isError = content.startsWith('Error');
        break;
      }
      case 'file_list': {
        content = await executeFileList(agentId, args);
        isError = content.startsWith('Error');
        break;
      }
      // ── Presence ──
      // ── Tunnel ──
      // C27: tunnel_{status,start,stop,restart} merged into tunnel({action}).
      case 'tunnel': {
        const action = args.action as 'status' | 'start' | 'stop' | 'restart' | undefined;
        if (!action || !['status', 'start', 'stop', 'restart'].includes(action)) {
          content = 'Error: tunnel requires action to be one of: status, start, stop, restart.';
          isError = true;
          break;
        }
        // C27: mutating actions stay primary-only (pre-merge, only tunnel_status
        // was available to non-primary agents); status is open to all.
        if (action !== 'status' && !isPrimaryAgent(agentId)) {
          content = `Permission denied: only the primary agent can ${action} the tunnel. You can still use tunnel({action:"status"}).`;
          isError = true;
          break;
        }
        try {
          const { getTunnelStatus, startTunnel, stopTunnel } = await import('../services/tunnel.js');
          if (action === 'status') {
            const status = getTunnelStatus();
            if (!status.cloudflaredInstalled) {
              content = 'cloudflared is not installed. Install with: brew install cloudflare/cloudflare/cloudflared';
            } else if (status.status === 'active' && status.url) {
              content = `Tunnel is running. Public URL: ${status.url} (mode: ${status.mode})`;
            } else if (status.status === 'starting') {
              content = 'Tunnel is starting up. Check back in a few seconds for the URL.';
            } else if (status.status === 'error') {
              content = `Tunnel error: ${status.error ?? 'unknown'}`;
            } else {
              content = 'Tunnel is not running.';
            }
          } else if (action === 'stop') {
            stopTunnel();
            content = 'Tunnel stopped.';
          } else {
            // start or restart share the poll-for-URL tail; restart stops first.
            const restarting = action === 'restart';
            if (restarting) {
              stopTunnel();
              await new Promise(r => setTimeout(r, 1500));
            }
            const mode = restarting ? undefined : (args.mode as 'quick' | 'named' | undefined);
            const result = startTunnel(mode);
            if (!result.ok) {
              content = `Error ${restarting ? 'restarting' : 'starting'} tunnel: ${result.error ?? 'unknown'}`;
              isError = true;
              break;
            }
            let url: string | null = null;
            for (let i = 0; i < 10; i++) {
              await new Promise(r => setTimeout(r, 1000));
              const s = getTunnelStatus();
              if (s.status === 'active' && s.url) { url = s.url; break; }
              if (s.status === 'error') { content = `Tunnel failed to ${restarting ? 'restart' : 'start'}: ${s.error ?? 'unknown'}`; isError = true; break; }
            }
            if (!isError) {
              content = url
                ? `Tunnel ${restarting ? 'restarted. New public' : 'started. Public'} URL: ${url}`
                : `Tunnel is ${restarting ? 'restarting' : 'starting'}. Check tunnel({action:"status"}) in a moment for the URL.`;
            }
          }
        } catch (err) {
          content = `Error on tunnel ${action}: ${err instanceof Error ? err.message : String(err)}`;
          isError = true;
        }
        break;
      }

      case 'set_user_presence': {
        try {
          const status = args.status as string;
          if (status !== 'in_dojo' && status !== 'away') {
            content = 'Error: status must be "in_dojo" or "away"';
            isError = true;
            break;
          }
          const { setPresence, getPresence } = await import('../services/presence.js');
          const previous = getPresence();
          setPresence(status);
          // STRIP (PHASE-0 T12): dropped an `agent:status` broadcast carrying `presence:<status>` — not an agent status, zero subscribers (PresenceProvider reads GET /system/presence); it only left Agents/Tracker holding it as the agent's status. requirement preserved: setPresence persists config('user_presence'), the fact every reader consults.
          content = status === 'away'
            ? `Done. User marked as away. Messages will be forwarded via iMessage. (Was: ${previous})`
            : `Done. User marked as in the dojo. Messages will go to the dashboard. (Was: ${previous})`;
        } catch (err) {
          content = `Error setting presence: ${err instanceof Error ? err.message : String(err)}`;
          isError = true;
        }
        break;
      }

      // ── Session Management ──
      case 'reset_session': {
        try {
          const db = getDb();
          // Accept both 'agent_id' and 'agent' (models use inconsistent param names)
          const rawTarget = (args.agent_id as string) ?? (args.agent as string) ?? null;

          // Safety: if no target specified, the agent is resetting itself.
          // Require explicit confirmation to prevent accidental self-resets.
          if (!rawTarget) {
            content = 'Error: agent_id is required. To reset your OWN session, pass your own agent ID explicitly. To reset a sub-agent, pass their agent ID or name.';
            isError = true;
            break;
          }

          // Resolve agent reference (UUID, sensei id, or name, case-insensitive)
          const resolveResult = resolveAgentRef(rawTarget, 'reset_session');
          if (!resolveResult.ok) { content = resolveResult.error; isError = true; break; }
          const resolvedId = resolveResult.id;
          const agent = db.prepare('SELECT id, name, status FROM agents WHERE id = ?').get(resolvedId) as { id: string; name: string; status: string };

          // Idempotency: if the target is already terminated, refuse cleanly
          // instead of archiving an empty conversation and confusing the
          // caller. Resetting a terminated agent is almost always a mistake
          //, they have no live state to reset.
          if (agent.status === 'terminated') {
            content = `Agent "${agent.name}" is already terminated, there is no live session to reset. Spawn a new agent if you need a fresh start.`;
            isError = true;
            break;
          }

          // Mid-turn guard: never reset ANOTHER agent while it is genuinely in a
          // live turn. A real in-process run is tracked in activeRuns; a STALE DB
          // status='working' row (a wedged agent whose run is actually gone) is
          // NOT in activeRuns, and healing exactly that wedged case is the whole
          // point of this tool, so we gate on activeRuns, never on the DB status.
          // Without this a genuinely-running target got reset underneath its own
          // turn and its work leaked past the New Session divider. Self-reset is
          // exempt: an agent resetting its OWN session mid-turn is intentional
          // (the boundary + reorient take hold as its current turn winds down).
          const { activeRuns } = await import('./shared-state.js');
          if (resolvedId !== agentId && activeRuns.has(resolvedId)) {
            content = `Agent "${agent.name}" is in the middle of a live turn right now. Resetting it would cut its work off mid-thought and leak that work past the new-session divider. Wait for it to go idle, then reset.`;
            isError = true;
            break;
          }

          // Archive current conversation to vault. force=true so we always create
          // a new archive, without it, an existing unprocessed archive blocks the
          // re-archive and the post-reset conversation is silently lost.
          const { archiveAgentConversation } = await import('../vault/archive.js');
          const archiveId = archiveAgentConversation(resolvedId, true);

          // NOTE: we intentionally do NOT clear context items (summaries).
          // Summaries from before the reset are still valid compressed history
          // of what the agent was working on. Clearing them causes amnesia, 
          // the agent loses all project context with nothing to replace it
          // until compaction runs again (which could be hours).
          // The session_started_at boundary already prevents old raw messages
          // from appearing in the fresh tail, summaries are the ONLY way
          // the agent retains context across a reset.

          // Set session boundary and clear stale continuity brief + session
          // scratchpad. Scratchpad is session-scoped (its own tool docs promise
          // it "auto-clears on session reset"); leaving it behind bleeds the
          // prior task's outline into the fresh session via the assembler.
          const now = new Date();
          const boundary = now.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
          db.prepare("UPDATE agents SET session_started_at = ?, updated_at = ?, config = json_remove(COALESCE(config, '{}'), '$.continuityBrief', '$.scratchpad') WHERE id = ?").run(boundary, boundary, resolvedId);

          // Carry a fired-but-undelivered reminder/scheduler event across the
          // reset boundary so it is not silently lost (all engine-event queries
          // gate created_at >= session_started_at). Narrow scope: unclaimed
          // deliverable engine rows only, never ordinary conversation.
          const { rehomeUnclaimedEngineEvents } = await import('./v2/counterparty.js');
          rehomeUnclaimedEngineEvents(resolvedId, boundary);

          // Insert UI divider. The row's created_at is stamped by the writer at insert
          // time, which is at-or-after `boundary` (computed a few lines up), so the
          // divider still lands inside the new session for every `created_at >=
          // session_started_at` query. The broadcast keeps quoting `boundary` for the UI.
          const markerId = uuidv4();
          insertMessageIfAbsent({ id: markerId, agentId: resolvedId, role: 'system', content: NEW_SESSION_DIVIDER });
          broadcast({ type: 'chat:message', agentId: resolvedId, message: { id: markerId, agentId: resolvedId, role: 'system', content: NEW_SESSION_DIVIDER, tokenCount: null, modelId: null, cost: null, latencyMs: null, createdAt: boundary } });

          // Inject the reorientation prompt. Picks between full reorient
          // (agent has active tasks → pick up where you left off) and
          // fresh-start (no active tasks → don't dredge up old work).
          const { buildSessionResetMessage } = await import('./session-reset.js');
          const reorientId = uuidv4();
          const reorientContent = buildSessionResetMessage(resolvedId);
          insertMessageIfAbsent({ id: reorientId, agentId: resolvedId, role: 'system', content: reorientContent });
          broadcast({ type: 'chat:message', agentId: resolvedId, message: { id: reorientId, agentId: resolvedId, role: 'system', content: reorientContent, tokenCount: null, modelId: null, cost: null, latencyMs: null, createdAt: boundary } });

          // If the agent is in error/paused status, heal it by setting to idle.
          // A session reset clears corrupted context, which is often the root
          // cause of the error. Without this, reset_session clears the context
          // but leaves the agent stuck in error status.
          if (agent.status === 'error' || agent.status === 'paused') {
            db.prepare("UPDATE agents SET status = 'idle', last_error = NULL, last_error_at = NULL, updated_at = datetime('now') WHERE id = ?").run(resolvedId);
            broadcast({ type: 'agent:status', agentId: resolvedId, status: 'idle' });
            // Notify injury recovery that the agent is healed
            try {
              const { onAgentRecovered } = await import('../healer/injury-recovery.js');
              onAgentRecovered(resolvedId);
            } catch { /* module may not be available */ }
          }

          const targetLabel = resolvedId === agentId ? 'your' : `${agent?.name ?? resolvedId}'s`;
          content = `Session reset complete for ${targetLabel} session. Previous conversation archived to vault.${agent.status === 'error' || agent.status === 'paused' ? ' Agent status restored to idle.' : ''}`;
          logger.info('Session reset via tool', { callerAgentId: agentId, targetAgentId: resolvedId, archiveId }, agentId);
        } catch (err) {
          content = `Error resetting session: ${err instanceof Error ? err.message : String(err)}`;
          isError = true;
        }
        break;
      }

      default: {
        // Membership-based routing for Google / Microsoft tools that the
        // explicit cases above don't list, newer base tools (drive_move,
        // gmail_create_label, docs_insert_text, sheets_format, calendar_freebusy,
        // …) and the user_* slot variants (user_calendar_create, user_docs_create,
        // …). Without this they fell through to "Unknown tool" even with the
        // account connected. The executors handle the user_ prefix + slot.
        if (GOOGLE_WRITE_TOOL_NAMES.has(name) || MS_WRITE_TOOL_NAMES.has(name)) {
          if (!isPrimaryAgent(agentId)) {
            content = 'Permission denied: only the primary agent can use Workspace write tools.';
            isError = true;
            auditLog(agentId, name, null, 'denied', 'Workspace write tool restricted to primary agent');
            break;
          }
        }
        const dispatchAgentName =
          (getDb().prepare('SELECT name FROM agents WHERE id = ?').get(agentId) as { name: string } | undefined)?.name ?? agentId;
        if (GOOGLE_WRITE_TOOL_NAMES.has(name)) {
          content = await executeGoogleWriteTool(name, args, agentId, dispatchAgentName);
          isError = content.startsWith('Error');
        } else if (GOOGLE_READ_TOOL_NAMES.has(name)) {
          content = prependUserMailboxBanner(await executeGoogleReadTool(name, args, agentId, dispatchAgentName), name);
          isError = content.startsWith('Error');
        } else if (MS_WRITE_TOOL_NAMES.has(name)) {
          content = await executeMicrosoftWriteTool(name, args, agentId, dispatchAgentName);
          isError = content.startsWith('Error');
        } else if (MS_READ_TOOL_NAMES.has(name)) {
          content = await executeMicrosoftReadTool(name, args, agentId, dispatchAgentName);
          isError = content.startsWith('Error');
        } else {
          content = `Unknown tool: ${name}`;
          isError = true;
          auditLog(agentId, 'tool_call', name, 'error', 'Unknown tool');
        }
        break;
      }
    }
  } catch (err) {
    content = `Tool execution failed: ${err instanceof Error ? err.message : String(err)}`;
    isError = true;
    // PHASE-4 T5: when the throw came from a provider call it carries a status, a structured
    // error type or a transport code, and the door can say WHY structurally instead of
    // handing the classifier a bare `crashed`. A verdict reached from the error's WORDS
    // populates nothing — see `toolErrorCodeForThrow`.
    errorCode = errorCode ?? toolErrorCodeForThrow(err);
    auditLog(agentId, 'tool_call', name, 'error', content);
  }

  // Phase 3.5 (2026-05-04), large-files interception path REMOVED.
  // The v1 pattern (`shouldIntercept` + `interceptLargeFile`) replaced
  // oversized content with an "exploration summary" stub that had no path
  // back to the actual content, agents trying to read a 35K-token HTML
  // file got stuck because the recovery tools (history_get / history_expand)
  // returned metadata, not the real content. The new model is per-tool
  // `maxResultTokens` (Phase 3) + offset/limit pagination on `file_read`
  // (Phase 3.5). The `large_files` table stays for backfill of pre-existing
  // intercepted files in production agent histories.

  // Phase 3 (2026-05-04), per-tool result cap enforcement. If the tool's
  // definition declares maxResultTokens and the content exceeds it, truncate
  // here and append a trailer telling the agent how to paginate. Approximate
  // 1 token ≈ 4 chars (conservative; real ratios are 3-4 for English text).
  // Successful results only, error messages stay intact regardless of size.
  if (!isError) {
    content = applyMaxResultTokensCap(name, content);
  }

  // v2.3.19, prepend the unknown-args warning if one was raised at
  // the top of executeTool. Goes BEFORE the cap so it survives any
  // result truncation. Applied to both success and error results so the
  // agent always sees it.
  if (unknownArgsWarning) {
    content = `${unknownArgsWarning}\n\n${content}`;
  }

  return {
    toolCallId: id,
    name,
    content,
    isError,
    ...(isError && errorCode ? { errorCode } : {}),
  };
}

/**
 * Truncate `content` to the tool's `maxResultTokens` cap if exceeded.
 * Adds a generic trailer so the agent knows it was truncated and can
 * paginate via the tool's own offset/limit/filter parameters.
 *
 * Phase 3 (2026-05-04). Used by `executeTool` for every tool whose
 * definition declares `maxResultTokens`. Char/token conversion is
 * approximate (4 chars ≈ 1 token, conservative); the goal is to keep
 * single tool results from blowing context, not exact metering.
 */

export function applyMaxResultTokensCap(toolName: string, content: string): string {
  // Phase 3.5 (2026-05-04), check the cross-file registry first so tools
  // defined outside agent/tools.ts (Google, Microsoft, Slides, Office) can
  // declare caps too. Falls back to the local toolDefinitions array.
  const registered = getRegisteredMaxResultTokens(toolName);
  const local = toolDefinitions.find((t) => t.name === toolName)?.maxResultTokens;
  const cap = registered ?? local;
  if (!cap) return content;

  const charBudget = cap * 4;
  if (content.length <= charBudget) return content;

  // If the tool already appended its own friendly trailer (file_read's
  // pagination stub, end-of-file marker, etc.), don't re-truncate, that
  // would eat the more-helpful per-tool guidance. The tool already capped
  // itself; the engine just slightly overshot the char budget.
  //
  // EXCEPTION: if the content is way over budget (more than 2x), the tool's
  // self-cap is broken, apply the generic truncation regardless of the
  // trailer. Pre-2026-05-06 fix: file_read's per-line cap was missing, so a
  // single-line 5.9MB HTML file appended a "[End of file]" trailer and then
  // bypassed this entire safety net, blowing the model's context window.
  const HARD_OVERSHOOT_RATIO = 2;
  const isHardOvershoot = content.length > charBudget * HARD_OVERSHOOT_RATIO;
  if (!isHardOvershoot) {
    const TOOL_TRAILER_PATTERNS = [
      /\[Read lines \d+-\d+ of \d+ total\./,
      /\[End of file\. Read lines \d+-\d+ of \d+ total\.\]$/,
      /\[Read chars \d+-\d+ of \d+ total\./,
      /\[End of content\. Read chars \d+-\d+ of \d+ total\.\]$/,
      /\[End of content\. Total: \d+ chars\. Requested offset/,
    ];
    const tail = content.slice(-400);
    if (TOOL_TRAILER_PATTERNS.some((re) => re.test(tail))) {
      return content;
    }
  }

  const approxOriginalTokens = Math.round(content.length / 4);
  // Phase 3.5 fix, tool-aware trailer guidance. Tools that have offset/limit
  // pagination get guided toward it; tools that don't get guided toward
  // narrowing their query/scope. Avoids the "use pagination" advice on tools
  // like web_search / vault_search that don't actually support it.
  const TOOLS_WITH_PAGINATION = new Set([
    'file_read',
    'gmail_read', 'outlook_read',
    'drive_read', 'docs_read', 'sheets_read', 'onedrive_read',
  ]);
  const guidance = TOOLS_WITH_PAGINATION.has(toolName)
    ? "Re-call with offset/limit to read more, or use a more specific query."
    : "Narrow your query, ask for less, or use a more specific tool to fit under the cap.";
  const trailer =
    `\n\n[Truncated by engine: returned ~${cap} tokens of ` +
    `~${approxOriginalTokens} total. ${guidance}]`;
  // Reserve room for the trailer so the final string fits the budget.
  const truncatedBody = content.slice(0, Math.max(0, charBudget - trailer.length));
  return truncatedBody + trailer;
}
