// ════════════════════════════════════════════════════════════════════════════
// THE ADVERTISED SURFACE (PHASE-5 T4 — relocated verbatim from `agent/tools.ts`)
//
// Which tools a given agent is TOLD about, and the executor-side deny set that
// re-checks the same policy after the model has spoken. Two questions, one
// parser, deliberately in one module:
//
//   getFilteredTools(agentId)  → the advertised list (permissions manifest,
//                                tools_policy allow/deny, account connectivity,
//                                the FA-TS2 primary-only strip, per-account
//                                description annotation), memoized per agent.
//   getAgentDenySet(agentId)   → the executor's re-check of tools_policy.deny.
//
// ── WHY BOTH LIVE HERE, AND WHY THAT IS THE POINT (FU-4) ──
// Architecture Rule 1 is "the engine enforces, the model follows": the strip is
// ADVICE. The floor model parses tool calls out of free text, so a deny-listed
// agent can emit a denied name and reach `executeTool` anyway. `parseToolsPolicy`
// is therefore the SINGLE parser behind both the strip and the executor gate —
// if they were two parsers they would drift, and the drift would be silent and
// in the permissive direction. The gate itself has NOT moved: it is still the
// first branch of the executor, ahead of the outbound-capture instrument.
//
// ── WHY THIS IS A LEAF, AND WHAT IT MAY NOT IMPORT ──
// `load_tool_docs` needs `getFilteredTools`, and a category module under
// `cat/` may not import `agent/tools.ts` — that rule is the split. So the
// surface machinery moved out ahead of the last dispatch key rather than the
// key being given a licence to reach backwards. This module imports the wire
// array, the definition families and the leaves; it imports no dispatcher and
// no handler.
//
// ── THE MEMOS ARE A MEASUREMENT, NOT A HABIT ──
// `callModel` asks `getFilteredTools` once per tool-loop iteration; before
// FA-TS1 a 20-tool-call turn rebuilt the list ~20 times, each rebuild running
// ~185 synchronous account scans that cannot change mid-turn. Both memos are
// keyed by agentId and validated by the SAME two cheap keys (the global
// tool-config generation + a per-agent row fingerprint), so a policy edit
// self-invalidates without hunting the agents-table write sites.
// ════════════════════════════════════════════════════════════════════════════

import type { ToolDefinition } from './types.js';
import { getDb } from '../../db/connection.js';
import { resolveToolAlias } from '../../tools/aliases.js';
import { getAgentPermissions } from '../permissions.js';
import { PRIMARY_ONLY_TOOLS } from './gates.js';
import { agentCanSelfComplete } from './util.js';
import { toolDefinitions } from './definitions.js';
import { isPrimaryAgent, isPMAgent } from '../../config/platform.js';
import { getToolConfigGeneration } from '../tool-config-generation.js';
import { pdfToolDefinitions } from '../pdf-tools.js';
import { googleReadToolDefinitions } from '../../google/tools-read.js';
import { googleWriteToolDefinitions } from '../../google/tools-write.js';
import { slidesToolDefinitions } from '../../google/tools-slides.js';
import { formsToolDefinitions } from '../../google/tools-forms.js';
import { getAgentGoogleAccessLevel, getGoogleWorkspaceConfig, isAnyGoogleAccountConnected, isGoogleServiceEnabledForKind, getGoogleServiceFlagsForKind } from '../../google/auth.js';
import { microsoftReadToolDefinitions } from '../../microsoft/tools-read.js';
import { microsoftWriteToolDefinitions } from '../../microsoft/tools-write.js';
import { officeCreateToolDefinitions, officeWordEditToolDefinitions, officeExcelEditToolDefinitions, officeEditToolDefinitions } from '../../microsoft/tools-office.js';
import { getAgentMicrosoftAccessLevel, getMicrosoftWorkspaceConfig, isAnyMicrosoftAccountConnected, isMsServiceEnabledForKind, getMsServiceFlagsForKind } from '../../microsoft/auth.js';
import { areOfficePackagesInstalled } from '../../microsoft/office-packages.js';
import { plaudReadToolDefinitions } from '../../plaud/tools-read.js';
import { isPlaudConnected } from '../../plaud/auth.js';
import { credentialsToolDefinitions } from '../../credentials/tools.js';
import { EMAIL_SEARCH_TOOL } from '../../tools/unified-read.js';
import { getEffectiveAudioGenModel } from '../../services/audio-gen-model.js';
import { getModelVoiceCatalog, defaultVoiceCatalogFor, formatVoiceCatalog } from '../../services/voice-catalog.js';

// ── Filtered tools per agent (based on permissions + tools policy) ──

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

export function getAgentDenySet(agentId: string): Set<string> {
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
