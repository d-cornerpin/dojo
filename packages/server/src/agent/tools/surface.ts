// THE ADVERTISED SURFACE: which tools an agent is TOLD about (getFilteredTools); the strip is advice:
// the floor model can emit a denied name from free text, so the executor re-checks. Both read ONE
// parser (agent/access/tools-policy.ts), two would drift; no cat/ module may import agent/tools.ts back.

import type { ToolDefinition } from './types.js';
import { getDb } from '../../db/connection.js';
import { getAgentPermissions } from '../manifest.js'; // the DECLARING manifest module; sudo-claim.ts reads this same one, per the shared-manifest test
import { toolGrantsFor, toolCategoryGranted, mayUsePlaud, holdsCredentialGrant, integrationLevelFor, mayUseChannel } from '../access/read.js';
import { channelForTool } from '../access/channels.js';
import { PRIMARY_ONLY_TOOLS } from './gates.js';
import { agentCanSelfComplete } from './util.js';
import { holdsDojoInspect, DOJO_INSPECT } from '../../inspect/grant.js';
import { toolDefinitions } from './definitions.js';
import { isPrimaryAgent, isPMAgent } from '../../config/platform.js';
import { getSudoPolicy } from '../brokers/sudo-policy.js';
import { agentMayRunAdminCommands, adminCommandsToolSentence } from '../brokers/sudo-claim.js';
import type { SudoPolicy } from '../brokers/sudo-copy.js';
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
import { RESULT_READ_TOOL } from '../../memory/tool-result-view.js';


/** Owner-facing controls; the strip is advice, so executeToolInner re-checks THIS SAME constant, and
 * strip and gate cannot drift. reset_session is stripped separately below, not through this set. */

// Filtered-tools memo: callModel asks once per tool-loop iteration, and each rebuild runs ~185
// synchronous account scans that cannot change mid-turn. Two cheap keys validate the entry: the global
// tool-config generation (bumped by every global surface write) and a per-agent fingerprint.
interface FilteredToolsCacheEntry {
  generation: number;
  fingerprint: string;
  tools: ToolDefinition[];
}
const filteredToolsCache = new Map<string, FilteredToolsCacheEntry>();
// Bound the map: a long-lived server spawns many ephemeral agents, and each would hold one entry
// forever. FIFO (Map keeps insertion order); an evicted agent just recomputes on its next call.
const FILTERED_TOOLS_CACHE_MAX = 512;

/** ONE SELECT of everything AGENT-SPECIFIC getFilteredTools consumes: manifest source, tools
 * policy/group/lifecycle columns and primary/PM identity; any change flips the memo's key. */
function computeAgentToolFingerprint(agentId: string, sudoPolicy: string): string {
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
  if (!row) return `none\x00${primary}\x00${pm}\x00${sudoPolicy}`;
  return [
    primary,
    pm,
    sudoPolicy,
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
  // ONE policy read for both the cache key and the computed value: two reads could straddle a
  // flip and store the NEW text under the OLD key, a stale description nothing invalidates.
  const sudoPolicy = getSudoPolicy();
  const fingerprint = computeAgentToolFingerprint(agentId, sudoPolicy);
  const cached = filteredToolsCache.get(agentId);
  if (cached && cached.generation === generation && cached.fingerprint === fingerprint) {
    return cached.tools;
  }
  const tools = computeFilteredTools(agentId, sudoPolicy);
  // Callers treat the list as read-only (audited); freeze outside production so a future
  // in-place mutation of the shared cached array trips loudly, not silently for every agent.
  if (process.env.NODE_ENV !== 'production') Object.freeze(tools);
  filteredToolsCache.delete(agentId); // re-insert at the tail so FIFO stays honest
  filteredToolsCache.set(agentId, { generation, fingerprint, tools });
  if (filteredToolsCache.size > FILTERED_TOOLS_CACHE_MAX) {
    const oldest = filteredToolsCache.keys().next().value;
    if (oldest !== undefined) filteredToolsCache.delete(oldest);
  }
  return tools;
}

// Both sites read policy via the agent's grants (`toolGrantsFor`); an unmigrated box reads the column.

// The advertised strip is only advice: the model can emit a denied name and reach executeToolInner,
// which re-checks this set. Mirrors the filtered-tools memo; the fingerprint holds tools_policy.
interface DenySetCacheEntry {
  generation: number;
  fingerprint: string;
  deny: Set<string>;
}
const agentDenySetCache = new Map<string, DenySetCacheEntry>();

export function getAgentDenySet(agentId: string): Set<string> {
  const generation = getToolConfigGeneration();
  // A FIXED sentinel, not a policy read: deny sets hold tool NAMES the policy can never change.
  const fingerprint = computeAgentToolFingerprint(agentId, 'deny-set');
  const cached = agentDenySetCache.get(agentId);
  if (cached && cached.generation === generation && cached.fingerprint === fingerprint) {
    return cached.deny;
  }
  const deny = new Set(toolGrantsFor(agentId).deny);
  agentDenySetCache.delete(agentId); // re-insert at the tail so FIFO stays honest
  agentDenySetCache.set(agentId, { generation, fingerprint, deny });
  if (agentDenySetCache.size > FILTERED_TOOLS_CACHE_MAX) {
    const oldest = agentDenySetCache.keys().next().value;
    if (oldest !== undefined) agentDenySetCache.delete(oldest);
  }
  return deny;
}


function computeFilteredTools(agentId: string, sudoPolicy: SudoPolicy): ToolDefinition[] {
  const manifest = getAgentPermissions(agentId);

  const db = getDb();
  const agentRow = db.prepare('SELECT tools_policy, group_id, classification, task_id FROM agents WHERE id = ?').get(agentId) as { tools_policy: string; group_id: string | null; classification: string | null; task_id: string | null } | undefined;
  const toolsPolicy = toolGrantsFor(agentId);

  // Base toolkit: static `toolDefinitions` plus the PDF tools: no external auth, safe for every agent.
  let filtered = [...toolDefinitions, ...pdfToolDefinitions];

  if (toolsPolicy.deny.length > 0) {
    filtered = filtered.filter(t => !toolsPolicy.deny.includes(t.name));
  }

  if (toolsPolicy.allow.length > 0) {
    filtered = filtered.filter(t => toolsPolicy.allow.includes(t.name));
  }

  // 2b. Squad coordination stays auto-available to any agent with a group_id, even under a curated
  // allow list, so the squad criterion cannot regress; an explicit deny still wins (step 1).
  if (agentRow?.group_id) {
    const present = new Set(filtered.map(t => t.name));
    const explicitDeny = new Set(toolsPolicy.deny);
    for (const name of ['squad_share', 'squad_recall']) {
      if (present.has(name) || explicitDeny.has(name)) continue;
      const def = toolDefinitions.find(t => t.name === name);
      if (def) filtered.push(def);
    }
  }
  // The pointer reader names the agent's OWN results; every agent holds it, deny still wins.
  const reader = toolDefinitions.find((t) => t.name === RESULT_READ_TOOL);
  if (reader && !filtered.includes(reader) && !toolsPolicy.deny.includes(RESULT_READ_TOOL)) filtered.push(reader);

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

  // update_agent self-gates permissions/tools edits on can_assign_permissions inside its handler.

  // Only primary gets group, session and presence tools: PRIMARY_ONLY_TOOLS, the SAME constant that
  // executeToolInner enforces; update_agent and tunnel self-gate mutations; reset_session strips here only.
  if (!isPrimaryAgent(agentId)) {
    removeTools.push(...PRIMARY_ONLY_TOOLS, 'reset_session');
  }
  if (!holdsDojoInspect(agentId)) removeTools.push(DOJO_INSPECT);   // the main agent, the Healer, and agents whose grant names it

  // Technique tools: only Sensei can save/publish/update, everyone can use/list
  const agentClassification = agentRow?.classification ?? undefined;
  if (agentClassification !== 'sensei') {
    removeTools.push('save_technique', 'publish_technique', 'update_technique', 'submit_technique_for_review', 'delete_technique', 'technique_set_placeholder', 'technique_finalize');
  }

  // complete_task ends the CALLING agent: a SPAWNED-agent lifecycle tool, so agents that must
  // not self-terminate never see it; the handler re-checks the same predicate as enforcement.
  const canSelfComplete = agentRow ? agentCanSelfComplete(agentId, agentRow) : false;
  if (!canSelfComplete) {
    removeTools.push('complete_task');
  }


  if (removeTools.length > 0) {
    filtered = filtered.filter(t => !removeTools.includes(t.name));
  }

  // Permission-aware descriptions carry the agent's real limits so it does not retry a blocked
  // command 20 times. THE SUDO DOOR IS PART OF THE TRUTH: a model believes its tools, so told that
  // other commands are blocked it never issues the call. The door and its words live in
  // brokers/sudo-claim.ts, which the soul capability register also reads: one predicate, two renderings.
  const mayRunAdminCommands = agentMayRunAdminCommands(agentId, sudoPolicy);
  const sudoDoorSentence = (finiteList: boolean): string =>
    (mayRunAdminCommands ? adminCommandsToolSentence(sudoPolicy, finiteList) : '');
  if (hasExec && manifest.exec_allow[0] !== '*') {
    const allowedCmds = manifest.exec_allow.join(', ');
    // Only suggest complete_task(status="blocked") to agents that can actually self-complete.
    const blockedHint = canSelfComplete
      ? 'use send_to_agent to ask an agent with broader permissions, or call complete_task(status="blocked")'
      : 'use send_to_agent to ask an agent with broader permissions, or tell the person you are talking to you are blocked';
    filtered = filtered.map(t => {
      if (t.name !== 'exec') return t;
      return {
        ...t,
        description: `Execute a shell command. You can ONLY run these commands: ${allowedCmds}. Any other command will be blocked.${sudoDoorSentence(true)} If you need a command that's not in this list, ${blockedHint}. Has a 30-second timeout.`,
      };
    });
  } else if (hasExec && sudoDoorSentence(false) !== '') {
    // DEFAULT primary manifest is exec_allow ['*']: the branch above never runs, door sentence appended.
    filtered = filtered.map(t => (t.name === 'exec'
      ? { ...t, description: `${t.description}${sudoDoorSentence(false)}` }
      : t));
  }
  {
    // `shell` is the other road a sudo line travels (authorizeShellScript): same door sentence.
    const shellFinite = ((manifest.shell_allow ?? manifest.exec_allow)[0] ?? '*') !== '*';
    const shellSentence = sudoDoorSentence(shellFinite);
    if (shellSentence !== '') {
      filtered = filtered.map(t => (t.name === 'shell'
        ? { ...t, description: `${t.description}${shellSentence}` }
        : t));
    }
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

  // Inject the configured model's real voice ids so the agent picks one instead of guessing.
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

  const isPrimary = isPrimaryAgent(agentId);
  const isPM = isPMAgent(agentId);

  const googleAccess = getAgentGoogleAccessLevel(agentId, isPrimary, isPM);
  // Service enabled on ANY connected account of the kind, not just the first row: a stricter test
  // hides tools behind live accounts; a looser one advertises tools whose calls die "Not authenticated".
  const agentKindConnected = isAnyGoogleAccountConnected('agent');
  const userKindConnected = isAnyGoogleAccountConnected('user');

  // Flags precomputed ONCE per kind (one accounts read), not a SELECT per tool; same fact door.
  const googleServiceFlags = {
    agent: getGoogleServiceFlagsForKind('agent'),
    user: getGoogleServiceFlagsForKind('user'),
  } as const;

  const serviceToolPrefixes: Record<string, string[]> = {
    gmail: ['gmail_'],
    calendar: ['calendar_'],
    drive: ['drive_'],
    docs: ['docs_'],
    sheets: ['sheets_'],
    slides: ['slides_'],
    forms: ['forms_'],
  };

  /** Both must pass: kind connected AND service enabled; `user_*` strips `user_` to find the service. */
  function isToolEnabledByService(toolName: string): boolean {
    const isUserKind = toolName.startsWith('user_');
    const canonical = isUserKind ? toolName.slice('user_'.length) : toolName;
    const kind = isUserKind ? 'user' : 'agent';
    if (!(isUserKind ? userKindConnected : agentKindConnected)) return false;
    if (integrationLevelFor(agentId, 'google', kind) === 'none') return false;
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
    // Read tier: read tools PLUS all of Slides (decks are safe output); no send, no doc/Drive edits.
    filtered.push(...googleReadToolDefinitions.filter(t => isToolEnabledByService(t.name)));
    filtered.push(...slidesToolDefinitions.filter(t => isToolEnabledByService(t.name)));
    // Forms collects answers from outside people, so read tools only; create/edit stay with the primary.
    filtered.push(
      ...formsToolDefinitions
        .filter(t => t.name === 'forms_get' || t.name === 'forms_list_responses')
        .filter(t => isToolEnabledByService(t.name)),
    );
    // drive_upload rides the read tier: without it slides_add_image_from_drive cannot reach a local file.
    filtered.push(
      ...googleWriteToolDefinitions
        .filter(t => t.name === 'drive_upload')
        .filter(t => isToolEnabledByService(t.name)),
    );
  }

  const msAccess = getAgentMicrosoftAccessLevel(agentId, isPrimary, isPM);
  const agentSlotMsConnected = isAnyMicrosoftAccountConnected('agent');
  const userSlotMsConnected = isAnyMicrosoftAccountConnected('user');

  // MS flags once per kind (one accounts read), not a SELECT per tool; same fact door.
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

  /** Like the Google gate, multi-account: some connected account of the kind with the service enabled. */
  function isMsToolEnabledByService(toolName: string): boolean {
    const isUserKind = toolName.startsWith('user_');
    const canonical = isUserKind ? toolName.slice('user_'.length) : toolName;
    const kind = isUserKind ? 'user' : 'agent';
    if (!(isUserKind ? userSlotMsConnected : agentSlotMsConnected)) return false;
    if (integrationLevelFor(agentId, 'microsoft', kind) === 'none') return false;
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

  // Unified cross-mailbox read: any readable slot with a MAIL-capable account; no user_ twin or param.
  const googleMailCapable = googleAccess !== 'none'
    && ((agentKindConnected && googleServiceFlags.agent.gmail) || (userKindConnected && googleServiceFlags.user.gmail));
  const msMailCapable = msAccess !== 'none'
    && ((agentSlotMsConnected && msServiceFlags.agent.outlook) || (userSlotMsConnected && msServiceFlags.user.outlook));
  if (googleMailCapable || msMailCapable) {
    filtered.push(EMAIL_SEARCH_TOOL);
  }

  // The merged `calendar_agenda` lives in googleReadToolDefinitions so the user_ generator finds it,
  // but it spans every provider: surface it when ANY calendar exists and the Google pass skipped it.
  const calendarCapable =
    (googleAccess !== 'none' && ((agentKindConnected && googleServiceFlags.agent.calendar) || (userKindConnected && googleServiceFlags.user.calendar)))
    || (msAccess !== 'none' && ((agentSlotMsConnected && msServiceFlags.agent.calendar) || (userSlotMsConnected && msServiceFlags.user.calendar)));
  if (calendarCapable && !filtered.some(t => t.name === 'calendar_agenda')) {
    const mergedAgenda = googleReadToolDefinitions.find(t => t.name === 'calendar_agenda');
    if (mergedAgenda) filtered.push(mergedAgenda);
  }

  // Office CREATE + LOCAL Word/Excel edit tools write under the agent's uploads dir (npm only, like
  // pdf_create), so a local-only box edits what it makes; slide ops need Graph: 'full' only.
  if (areOfficePackagesInstalled()) {
    filtered.push(...officeCreateToolDefinitions);
    filtered.push(...officeWordEditToolDefinitions);
    filtered.push(...officeExcelEditToolDefinitions);
  }
  if (msAccess === 'full' && areOfficePackagesInstalled()) {
    filtered.push(...officeEditToolDefinitions);
  }

  // Plaud is read-only, one account per install, no service toggles: connected AND the agent's
  // plaud grant, both required. Without it the PM is offered a full Plaud set it cannot use.
  if (isPlaudConnected() && mayUsePlaud(agentId)) {
    filtered.push(...plaudReadToolDefinitions);
  }

  // The credentials vault (third-party API keys, encrypted at rest) is gated by the agent's
  // credential grant: nothing granted, no vault advertised; a subset keeps the tools, refused per service.
  if (holdsCredentialGrant(agentId)) filtered.push(...credentialsToolDefinitions);

  // [Routes to <email>, <slot> <provider>] prefixes name the exact account; no-slot tools skip it.
  // Emails are read HERE, not at module load, so a reconnect shows up on the next turn, no restart.
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

  // Deliberately the LAST filter: it reads the surface every strip and append above produced and
  // keeps only categories the agent's grants name; a tool in no category is never refused (read.ts).
  filtered = filtered.filter(t => t.name === DOJO_INSPECT || toolCategoryGranted(agentId, t.name));   // dojo_inspect: its grant is its own (strip above)

  // Strip advertised channel tools whose channel grant the agent lacks: nothing executable is removed
  // (the doors already refuse); it stops the prompt and the guidance claiming an unbought capability.
  filtered = filtered.filter(t => {
    const channel = channelForTool(t.name);
    return channel === null || mayUseChannel(agentId, channel);
  });

  const annotated = filtered.map(t => {
    // calendar_agenda is the merged cross-account view, so it skips the misleading [Routes to] prefix.
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
