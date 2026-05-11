import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DEFAULT_SOUL_MD, DEFAULT_USER_MD, DEFAULT_PM_SOUL_MD, DEFAULT_TRAINER_SOUL_MD } from './templates.js';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { toolDefinitions, getFilteredTools } from '../agent/tools.js';
import { isPrimaryAgent, isPMAgent, isTrainerAgent, getPrimaryAgentName, getPrimaryAgentId, getPMAgentName, getPMAgentId, getOwnerName } from '../config/platform.js';
import { getAgentGoogleAccessLevel } from '../google/auth.js';
import { getAgentMicrosoftAccessLevel, getMsAccountType, getMicrosoftWorkspaceConfig } from '../microsoft/auth.js';
import { assembleGroupContext as _assembleGroupContext } from '../agent/groups.js';
import { generateTechniqueIndex, generateDraftTechniqueContext } from '../techniques/index-builder.js';
import { getContextWindow } from '../agent/model.js';
import { isIMBridgeRunning } from '../services/imessage-bridge.js';

// Prompt complexity tiers based on model context window
type PromptTier = 'full' | 'standard' | 'compact' | 'minimal';
function getPromptTier(contextWindow: number): PromptTier {
  if (contextWindow >= 200000) return 'full';
  if (contextWindow >= 32000) return 'standard';
  if (contextWindow >= 8000) return 'compact';
  return 'minimal';
}
import { generateToolIndex, generateToolIndexCompact } from '../tools/categories.js';
import { getAgentAlwaysLoadedTools } from '../tools/tool-docs.js';
// (getRuntimeVersion import removed in Phase 9 Stage 2 — single-track v2)

const logger = createLogger('prompt-assembler');
const PROMPTS_DIR = path.join(os.homedir(), '.dojo', 'prompts');

function ensurePromptsDir(): void {
  if (!fs.existsSync(PROMPTS_DIR)) {
    fs.mkdirSync(PROMPTS_DIR, { recursive: true });
  }
}

function readPromptFile(filename: string, defaultContent: string): string {
  ensurePromptsDir();
  const filePath = path.join(PROMPTS_DIR, filename);

  if (fs.existsSync(filePath)) {
    try {
      return fs.readFileSync(filePath, 'utf-8');
    } catch (err) {
      logger.warn('Failed to read prompt file, using default', {
        file: filename,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Write default to disk for future editing
  try {
    fs.writeFileSync(filePath, defaultContent, 'utf-8');
    logger.info('Created default prompt file', { file: filename });
  } catch {
    // Non-fatal: use in-memory default
  }

  return defaultContent;
}

function getSoulContent(agentId: string): string {
  // Primary agent gets SOUL.md
  if (isPrimaryAgent(agentId)) {
    return readPromptFile('SOUL.md', DEFAULT_SOUL_MD);
  }

  // PM agent gets PM-SOUL.md
  if (isPMAgent(agentId)) {
    return readPromptFile('PM-SOUL.md', DEFAULT_PM_SOUL_MD);
  }

  // Trainer agent gets TRAINER-SOUL.md
  if (isTrainerAgent(agentId)) {
    return readPromptFile('TRAINER-SOUL.md', DEFAULT_TRAINER_SOUL_MD);
  }

  // Check for agent-specific soul file
  const agentSoulPath = path.join(PROMPTS_DIR, `${agentId.toUpperCase()}-SOUL.md`);
  if (fs.existsSync(agentSoulPath)) {
    try {
      return fs.readFileSync(agentSoulPath, 'utf-8');
    } catch {
      // Fall through
    }
  }

  // Sub-agents: comprehensive dojo onboarding — NOT the primary agent's SOUL.md
  try {
    const db = getDb();
    const agentRow = db.prepare('SELECT name, group_id, parent_agent, classification FROM agents WHERE id = ?').get(agentId) as { name: string; group_id: string | null; parent_agent: string | null; classification: string } | undefined;
    const agentName = agentRow?.name ?? 'Agent';
    const classification = agentRow?.classification ?? 'apprentice';

    // Get parent agent name
    let parentInfo = '';
    if (agentRow?.parent_agent) {
      const parent = db.prepare('SELECT name FROM agents WHERE id = ?').get(agentRow.parent_agent) as { name: string } | undefined;
      parentInfo = parent ? `Your parent agent is **${parent.name}** (ID: ${agentRow.parent_agent}).` : '';
    }

    // Get group info
    let groupInfo = '';
    if (agentRow?.group_id) {
      const group = db.prepare('SELECT name, description FROM agent_groups WHERE id = ?').get(agentRow.group_id) as { name: string; description: string | null } | undefined;
      if (group) {
        const members = db.prepare("SELECT name, id FROM agents WHERE group_id = ? AND status != 'terminated' AND id != ?").all(agentRow.group_id, agentId) as Array<{ name: string; id: string }>;
        groupInfo = `You are in the squad **"${group.name}"**${group.description ? ` — ${group.description}` : ''}.`;
        if (members.length > 0) {
          groupInfo += ` Your squad members: ${members.map(m => `${m.name} (${m.id})`).join(', ')}.`;
        }
      }
    }

    // Get PM agent info
    const pmName = getPMAgentName();
    const pmId = getPMAgentId();

    // Get primary agent info
    const primaryName = getPrimaryAgentName();
    const primaryId = getPrimaryAgentId();

    // The "Communication" how-to and "Vault" instructional blocks are NOT
    // here — engine enforces A2A intent rules and prefetches vault context
    // at session start, so the prompt only carries structural identity /
    // parent / squad context.
    return `# Identity

You are **${agentName}**, a ${classification} agent in the DOJO Agent Platform. Your agent ID is \`${agentId}\`.

${parentInfo}

# The Dojo

You are part of an AI agent orchestration platform.

- **${primaryName}** (ID: ${primaryId}) is the Dojo Master — primary agent who coordinates work. Report findings back to them.
- **${pmName}** (ID: ${pmId}) is the Dojo Planner — PM agent monitoring the tracker. Message them if blocked.
${groupInfo ? `- ${groupInfo}` : ''}

# Rules

- Follow your task instructions precisely.
- Update your tracker task status as you work; call \`complete_task\` with a summary when done.
- If blocked, set tracker status to "blocked" and message ${primaryName} or ${pmName}.`;
  } catch {
    return '# Identity\n\nYou are a sub-agent in the DOJO Agent Platform. Follow your task instructions and call complete_task when done.';
  }
}

// True when the most recent user message for this agent is an incoming
// iMessage (carries the [SOURCE: IMESSAGE FROM ...] tag). Used to scope
// iMessage-only prompt guidance so dashboard turns don't pay the tokens.
function isIMessageTurn(agentId: string): boolean {
  try {
    const db = getDb();
    const row = db.prepare(
      `SELECT content FROM messages
       WHERE agent_id = ? AND role = 'user'
       ORDER BY created_at DESC, rowid DESC
       LIMIT 1`,
    ).get(agentId) as { content: string } | undefined;
    return !!row?.content?.includes('[SOURCE: IMESSAGE FROM');
  } catch {
    return false;
  }
}

function generateToolsGuidance_v2(agentId: string): string {
  const agentTools = getFilteredTools(agentId);
  const lines: string[] = [];

  // 1. Terseness rules — engine policy, applies to all v2 agents (Part XVIII §D)
  lines.push(`## How You Communicate

Be terse. Lead with the answer. Don't preface ("Sure, I can help with that"). Don't recap what you just did ("I went ahead and read the file and now I'll..."). Don't summarize tool results — the user can see them.

A short, complete answer is always better than a long, padded one. Final responses default to one paragraph; expand only if the task genuinely needs detail.

When you call a tool, use the result in the same turn. Don't quote large tool output back at the user. Don't keep tool output in your prose past the turn that produced it.

When you don't know, say so directly and search the vault. Don't guess.

When something fails, report it once with the cause. Don't apologize repeatedly.
`);
  lines.push('');

  // 2. How tools return content — Phase 3.5 §A summarize-by-default pattern.
  //    Concise overview so agents know about the prompt/goal idiom and
  //    expand-on-demand pairs without reading every tool's docs.
  lines.push(`## How Tools Return Content

Tools default to **compact**: focused summaries, not raw dumps. The engine caps each tool's output and the tool itself returns the smallest useful slice. Patterns to know:

- **Search/list tools** return short snippets per result (subject + sender + ~200 char snippet, etc.). Use the matching expand tool when a snippet isn't enough — \`vault_search\` → \`vault_expand(entry_id)\`.
- **\`web_fetch\`** requires a \`prompt\` parameter — the tool fetches the URL, runs a fast model with your prompt, returns ~1-2K tokens of focused extract. Be specific in the prompt.
- **\`web_browse\`** with \`extract\` action accepts an optional \`goal\` for the same focused-extract pattern. Use it when the page is large.
- **\`file_read\`** returns up to ~8K tokens with line numbers. If the file is bigger you get a clear pagination trailer with the exact \`offset\`/\`limit\` to call next.
- **Most tools self-truncate** with a "[Truncated by engine: returned ~N tokens of ~M total]" trailer when oversized. Adapt: paginate, narrow your query, or use a more specific tool.
`);
  lines.push('');

  // 3. Tool index — compact variant (Phase 5): 60-char descriptions, no
  // per-tool always-loaded marker (enumerated once at top instead).
  // Kevin (primary, ~165 tools) drops from ~2.8K to ~1.4K tokens here.
  const alwaysLoaded = getAgentAlwaysLoadedTools(agentId);
  lines.push(generateToolIndexCompact(agentTools, alwaysLoaded));
  lines.push('');

  // 3. Brief, single-line notes per tool category (the v1 long blocks
  //    are deleted — engine enforces the underlying rules):

  const hasImessage = agentTools.some(t => t.name === 'imessage_send');
  if (hasImessage) {
    const ownerName = getOwnerName();
    // v2.3.19 — proactively tell the agent whether the bridge is on. If
    // it's off, the agent should use the dashboard chat instead of
    // wasting a tool call. (The tool dispatcher also fails loudly if
    // the agent tries anyway — this is just the cheaper signal.)
    let bridgeRunning = false;
    try { bridgeRunning = isIMBridgeRunning(); } catch { /* default: assume off */ }

    if (isPrimaryAgent(agentId)) {
      lines.push(`## iMessage`);
      if (bridgeRunning) {
        lines.push(`Use \`imessage_send\` for proactive outreach to ${ownerName} only. Replies to incoming iMessages are routed automatically — do not call \`imessage_send\` to reply.`);
        if (isIMessageTurn(agentId)) {
          lines.push(`If the message closes the conversation ("goodnight", "thanks", "ok bye"), reply with literal \`[no-reply]\` and nothing else — skips the send. Use it to end loops.`);
        }
      } else {
        lines.push(`iMessage is currently disabled on this server — \`imessage_send\` will fail. Use the dashboard chat for all communication with ${ownerName} until they re-enable it in Settings → iMessage.`);
      }
      lines.push('');
    } else if (!bridgeRunning) {
      // Non-primary agents with the tool — also tell them it's off so
      // they don't try.
      lines.push(`## iMessage`);
      lines.push(`iMessage is currently disabled on this server. \`imessage_send\` will fail; tell ${ownerName} in the dashboard chat instead.`);
      lines.push('');
    }
  }

  const hasSendToAgent = agentTools.some(t => t.name === 'send_to_agent');
  if (hasSendToAgent) {
    lines.push(`## Talking to Other Agents`);
    lines.push(`Other agents can't see your chat. Use \`send_to_agent\` to message them — the DOJO validates intent and threading. Wake intents (QUESTION/ASSIGN/BLOCK/ANSWER/DELIVERABLE) prompt a reply; no-wake intents (FYI/STATUS/COMPLETE/FAIL) don't.`);
    lines.push('');
  }

  const hasTracker = agentTools.some(t => t.name.startsWith('tracker_'));
  if (hasTracker) {
    lines.push(`## Tracker`);
    lines.push(`Use the tracker for multi-step work. The DOJO auto-creates tasks when it sees you're about to make 2+ non-trivial tool calls without one — you can also create tasks explicitly with \`tracker_create_task\`.`);
    lines.push('');
  }

  const hasVault = agentTools.some(t => t.name.startsWith('vault_'));
  if (hasVault) {
    lines.push(`## Vault (Long-Term Memory)`);
    lines.push(`The vault is your permanent shared memory. Use \`vault_search\` before saying "I don't remember." Use \`vault_remember\` to save important facts, decisions, corrections, and personal context. Pinned + relevant entries are auto-loaded at session start.`);
    lines.push('');
  }

  const hasTechniques = agentTools.some(t => t.name === 'use_technique' || t.name === 'list_techniques');
  if (hasTechniques) {
    lines.push(`## Techniques`);
    lines.push(`Curated procedures available via \`list_techniques\` and \`use_technique\`. The DOJO surfaces relevant ones automatically; you can also browse explicitly.`);
    lines.push('');
  }

  const canSpawn = agentTools.some(t => t.name === 'spawn_agent');
  if (canSpawn) {
    lines.push(`## Spawning Sub-Agents`);
    lines.push(`Create a tracker_create_project first, then spawn agents into a group with \`spawn_agent\` and \`create_agent_group\`. Clean up via \`delete_group(terminate_members=true)\`. PM monitors all tasks — don't create your own monitoring agents.`);
    lines.push('');
  }

  return lines.join('\n');
}

// ── Check if agent should receive USER.md ──

function shouldShareUserProfile(agentId: string): boolean {
  // Primary agent and PM always get user profile
  if (isPrimaryAgent(agentId) || isPMAgent(agentId)) return true;

  try {
    const db = getDb();
    const row = db.prepare('SELECT config FROM agents WHERE id = ?').get(agentId) as { config: string } | undefined;
    if (row) {
      const config = JSON.parse(row.config || '{}');
      return config.shareUserProfile === true;
    }
  } catch {
    // Default to not sharing
  }
  return false;
}

// ── Main Assembly ──

export function assembleSystemPrompt(agentId: string, modelId: string): string {
  const contextWindow = getContextWindow(modelId);
  const tier = getPromptTier(contextWindow);
  const soul = getSoulContent(agentId);
  const tools = generateToolsGuidance_v2(agentId);
  void tier; // tier was used by the deleted v1 generateToolsGuidance path

  // Inject current date/time at the top so every agent is temporally anchored
  // from the very first turn — no tool call required.
  const now = new Date();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const localStr = now.toLocaleString('en-US', {
    timeZone: tz,
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
    timeZoneName: 'short',
  });
  const timeHeader = `**Current date/time: ${localStr}**\n\nUse this to judge the age and relevance of any context, vault entries, or summaries you see. Recent information is more reliable than old information.`;

  const parts = [timeHeader, soul, tools];

  // Conditionally include USER.md
  if (shouldShareUserProfile(agentId)) {
    const user = readPromptFile('USER.md', DEFAULT_USER_MD);
    parts.push(user);
  }

  // Inject PM agent awareness for the primary agent
  if (isPrimaryAgent(agentId)) {
    try {
      const pmName = getPMAgentName();
      const pmId = getPMAgentId();
      const db = getDb();
      const pmAgent = db.prepare('SELECT id, status, model_id FROM agents WHERE id = ?').get(pmId) as { id: string; status: string; model_id: string | null } | undefined;
      if (pmAgent && pmAgent.status !== 'terminated') {
        // Trim. The "NEVER create monitoring agents" rule was prompt-side
        // enforcement; the PM agent existing structurally communicates this
        // without a paragraph of FORBIDDEN.
        parts.push(`## Project Manager: ${pmName}\n\n${pmName} (ID: ${pmId}) is the dedicated PM agent — monitors tasks, pokes idle agents, escalates if needed. Don't create monitoring/pulse-check agents yourself; ${pmName} already does that. Message via \`send_to_agent(agent_id="${pmId}", ...)\`.`);
      }
    } catch { /* PM may not be configured */ }
  }

  // Message source awareness — minimal source-tag reference. Routing /
  // separation is engine logic.
  parts.push(`## Message Sources

Each non-user-chat message has a \`[SOURCE: ...]\` tag:
- No tag = direct message from ${getOwnerName()} via dashboard
- \`[SOURCE: IMESSAGE FROM ${getOwnerName().toUpperCase()}]\` = ${getOwnerName()} via iMessage (responses auto-route back)
- \`[SOURCE: GMAIL NOTIFICATION]\` / \`[SOURCE: OUTLOOK NOTIFICATION]\` = a new email just landed in ${getOwnerName()}'s inbox. NOT a request from ${getOwnerName()} themselves, but you SHOULD surface it: send a brief one-line summary ("Email from <sender>: <subject>") to ${getOwnerName()} in your reply (chat if at-desk, iMessage if away). Don't reply to the email or take action on it unless ${getOwnerName()} asks. If multiple arrive, batch into one summary.
- \`[A2A:INTENT thread:ID from:Name]\` = structured agent message — engine validates your reply via \`send_to_agent\`
- \`[SOURCE: AGENT MESSAGE FROM X]\` = legacy agent message
- \`[SOURCE: TEAMS MESSAGE FROM ...]\` = Teams message (reply via \`teams_send_message\` using the chat_id in the note)
- \`[SYSTEM NOTE: ...]\`, \`[Note: ...]\`, \`[Engine ack] ...\` = system context, not requests
- \`[SENT VIA IMESSAGE to ${getOwnerName()}]\` = your prior response went via iMessage. **DO NOT EMIT THIS TAG YOURSELF.** It's a system-generated marker the engine writes automatically after iMessage delivery. Including it in your reply text would send the literal string "[SENT VIA IMESSAGE to ${getOwnerName()}]" to ${getOwnerName()}'s phone — they'd see the routing annotation in their iMessage, which looks broken.`);

  // Engine's ackInjector handles "acknowledge before tools" automatically.
  // The "always report back" guidance lives in the v2 terseness section.

  // Inject Google Workspace awareness based on access level
  try {
    const googleAccess = getAgentGoogleAccessLevel(agentId, isPrimaryAgent(agentId), isPMAgent(agentId));
    if (googleAccess === 'full') {
      // Trimmed: sub-agents can be delegated via send_to_agent; their per-agent
      // tool filter handles what they can/can't do. No 12-line briefing needed.
      parts.push(`## Google Workspace\n\nYou have full Google Workspace access (Gmail, Calendar, Drive, Docs, Sheets, Slides). All actions are logged in the Google Activity log. Sub-agents have read-only access; you're the only agent with write.`);
    } else if (googleAccess === 'read') {
      parts.push(`## Google Workspace (Read + Slides)\n\nYou have read access to Gmail/Calendar/Drive/Docs/Sheets and full Slides access. If a task needs writes outside Slides, report back to the primary agent.`);
    }
  } catch { /* Google module may not be available */ }

  // Inject Microsoft 365 awareness based on access level
  try {
    const msAccess = getAgentMicrosoftAccessLevel(agentId, isPrimaryAgent(agentId), isPMAgent(agentId));
    const msAccountType = getMsAccountType();
    const teamsNote = msAccountType === 'msa'
      ? '\n\nNote: Teams is NOT available with this account. The connected Microsoft account is a personal account (outlook.com/hotmail.com/live.com). Teams requires a Microsoft work/school account (Entra ID). If asked to use Teams, explain this to the user.'
      : '';

    const msEmail = getMicrosoftWorkspaceConfig().accountEmail;

    if (msAccess === 'full') {
      const teamsInboundGuidance = msAccountType !== 'msa' ? `

**CRITICAL — Incoming Teams messages:**
People can send you Microsoft Teams messages directly. When they do, a notification arrives in your conversation tagged \`[SOURCE: TEAMS MESSAGE FROM {name} ({email})]\`. These are real people reaching out via Teams — they are NOT messages from the dashboard user.

When you see a \`[SOURCE: TEAMS MESSAGE FROM ...]\` notification:
1. Read the message and the \`Chat ID\` shown at the bottom of the notification.
2. Reply by calling \`teams_send_message\` with that \`chat_id\` and your reply text.
3. Do NOT reply in plain chat — the person is on Teams, not the dashboard. They will never see a plain chat response.

The \`teams_create_chat\` tool is for starting a new conversation with someone. \`teams_send_message\` is for replying to an existing chat using the \`chat_id\` from the notification.` : '';

      // Trimmed: keep account context + the Teams-inbound rule (that's
      // behavior, not bloat — agents must know to reply on the right channel).
      parts.push(`## Microsoft 365${msEmail ? ` (${msEmail})` : ''}\n\nYou have full Microsoft 365 access (Outlook, Calendar, Word/Excel/PowerPoint, OneDrive${msAccountType !== 'msa' ? ', Teams' : ''}). All actions are logged. Sub-agents have read-only access.${teamsInboundGuidance}${teamsNote}`);
    } else if (msAccess === 'read') {
      parts.push(`## Microsoft 365 (Read-Only)\n\nYou have read access to Outlook/Calendar/OneDrive${msAccountType !== 'msa' ? '/Teams' : ''}. If a task needs writes, report back to the primary agent.${teamsNote}`);
    }
  } catch { /* Microsoft module may not be available */ }

  // Inject group context if agent is in a group
  try {
    const groupCtx = _assembleGroupContext(agentId);
    if (groupCtx) parts.push(groupCtx);
  } catch { /* groups table may not exist yet */ }

  // Inject technique index (published techniques) and draft context (for build squads)
  try {
    const techniqueIndex = generateTechniqueIndex();
    if (techniqueIndex) parts.push(techniqueIndex);

    // Draft technique context for squad members
    const agentRow = getDb().prepare('SELECT group_id FROM agents WHERE id = ?').get(agentId) as { group_id: string | null } | undefined;
    if (agentRow?.group_id) {
      const draftCtx = generateDraftTechniqueContext(agentRow.group_id);
      if (draftCtx) parts.push(draftCtx);
    }
  } catch { /* techniques table may not exist yet */ }

  // Inject equipped techniques (full TECHNIQUE.md content pre-loaded into context)
  try {
    const db = getDb();
    const agentEquipped = db.prepare('SELECT equipped_techniques FROM agents WHERE id = ?').get(agentId) as { equipped_techniques: string | null } | undefined;
    if (agentEquipped?.equipped_techniques) {
      const techniqueIds: string[] = JSON.parse(agentEquipped.equipped_techniques || '[]');
      if (techniqueIds.length > 0) {
        const equippedParts: string[] = ['## Equipped Techniques\nYou have equipped techniques (specialized procedures). When a task matches a technique, follow its steps exactly — do not improvise your own approach.\n'];
        for (const techId of techniqueIds) {
          const technique = db.prepare('SELECT id, name, directory_path FROM techniques WHERE id = ? AND state = \'published\' AND enabled = 1').get(techId) as { id: string; name: string; directory_path: string } | undefined;
          if (technique) {
            try {
              const mdPath = path.join(technique.directory_path, 'TECHNIQUE.md');
              if (fs.existsSync(mdPath)) {
                const content = fs.readFileSync(mdPath, 'utf-8');
                equippedParts.push(`═══ EQUIPPED TECHNIQUE: ${technique.name} ═══\nWhen performing "${technique.name}", follow these steps IN ORDER:\n\n${content}\n═══ END TECHNIQUE ═══`);
              }
            } catch { /* skip unreadable */ }
          }
        }
        if (equippedParts.length > 1) {
          parts.push(equippedParts.join('\n\n'));
        }
      }
    }
  } catch { /* equipped_techniques column may not exist yet */ }

  const runtimeInfo = `
## Runtime Information
- Agent ID: ${agentId}
- Model: ${modelId}
- Current Time: ${new Date().toISOString()}
- Platform: macOS (${os.arch()})
- Host: ${os.hostname()}
`;
  parts.push(runtimeInfo);

  const systemPrompt = parts.join('\n\n---\n\n');

  const estimatedTokens = Math.ceil(systemPrompt.length / 4);
  const promptRatio = estimatedTokens / contextWindow;
  if (promptRatio > 0.3) {
    logger.warn('System prompt exceeds 30% of context window', {
      agentId, modelId, tier,
      estimatedTokens, contextWindow,
      ratio: (promptRatio * 100).toFixed(1) + '%',
    }, agentId);
  }

  logger.debug('System prompt assembled', {
    agentId,
    modelId,
    tier,
    length: systemPrompt.length,
    estimatedTokens,
    includesUserProfile: shouldShareUserProfile(agentId),
  }, agentId);

  return systemPrompt;
}

export function getPromptFilePath(filename: string): string {
  return path.join(PROMPTS_DIR, filename);
}
