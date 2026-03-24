import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DEFAULT_SOUL_MD, DEFAULT_USER_MD, DEFAULT_PM_SOUL_MD, DEFAULT_TRAINER_SOUL_MD } from './templates.js';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { toolDefinitions, getFilteredTools } from '../agent/tools.js';
import { isPrimaryAgent, isPMAgent, isTrainerAgent, getPrimaryAgentName, getPrimaryAgentId, getPMAgentName, getPMAgentId, getOwnerName } from '../config/platform.js';
import { getAgentGoogleAccessLevel } from '../google/auth.js';
import { assembleGroupContext as _assembleGroupContext } from '../agent/groups.js';
import { generateTechniqueIndex, generateDraftTechniqueContext } from '../techniques/index-builder.js';

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

    return `# Identity

You are **${agentName}**, a ${classification} agent in the DOJO Agent Platform. Your agent ID is \`${agentId}\`.

${parentInfo}

# The Dojo

You are part of an AI agent orchestration platform. Here's what you need to know:

- **${primaryName}** (ID: ${primaryId}) is the Dojo Master — the primary agent who coordinates all work. Report important findings back to them.
- **${pmName}** (ID: ${pmId}) is the Dojo Planner — the PM agent who monitors the project tracker. If you're stuck or blocked, message ${pmName}.
${groupInfo ? `- ${groupInfo}` : ''}

# Communication

- To message any agent: \`send_to_agent(agent="<name or ID>", message="...")\`
- To message your parent: \`send_to_agent(agent="${agentRow?.parent_agent ?? primaryId}", message="...")\`
- To message the PM: \`send_to_agent(agent="${pmId}", message="...")\`
- To broadcast to your squad: \`broadcast_to_group(group_id="${agentRow?.group_id ?? ''}", message="...")\`
- Messages you receive will say who sent them. Always reply using \`send_to_agent\`.

# Rules

- Follow your task instructions precisely
- Use the **project tracker** to update your task status as you work
- When done, call \`complete_task\` with a summary of what you accomplished
- If you're blocked, set your task status to "blocked" and message ${primaryName} or ${pmName}
- Be concise and direct in all communications

# Vault (Long-Term Memory)

You have access to the dojo's memory vault -- the same one every agent uses. Before starting your task, use vault_search to check for relevant prior knowledge -- someone may have already figured out part of what you need. As you work, use vault_remember to save anything important you discover. Your entries are immediately visible to all agents and persist after you're gone -- save generously.`;
  } catch {
    return '# Identity\n\nYou are a sub-agent in the DOJO Agent Platform. Follow your task instructions and call complete_task when done.';
  }
}

// ── Auto-generate tools guidance from registered tool definitions ──

function generateToolsGuidance(agentId: string): string {
  // Only show tools the agent actually has access to
  const agentTools = getFilteredTools(agentId);
  const lines: string[] = ['# Available Tools\n'];

  const categories: Record<string, typeof toolDefinitions> = {
    'File Operations': agentTools.filter(t => t.name.startsWith('file_')),
    'System Operations': agentTools.filter(t => t.name === 'exec'),
    'Memory': agentTools.filter(t => t.name.startsWith('memory_')),
    'Web': agentTools.filter(t => ['web_search', 'web_fetch', 'web_browse'].includes(t.name)),
    'System Control': agentTools.filter(t => ['mouse_click', 'mouse_move', 'keyboard_type', 'screen_read', 'applescript_run'].includes(t.name)),
    'Multi-Agent': agentTools.filter(t => ['spawn_agent', 'kill_agent', 'send_to_agent', 'broadcast_to_group', 'complete_task', 'list_agents', 'list_groups', 'create_agent_group', 'assign_to_group', 'delete_group'].includes(t.name)),
    'Project Tracker': agentTools.filter(t => t.name.startsWith('tracker_')),
    'Time': agentTools.filter(t => t.name === 'get_current_time'),
    'Communication': agentTools.filter(t => t.name === 'imessage_send'),
    'Techniques': agentTools.filter(t => ['save_technique', 'use_technique', 'list_techniques', 'publish_technique', 'update_technique', 'submit_technique_for_review'].includes(t.name)),
    'Vault (Long-Term Memory)': agentTools.filter(t => t.name.startsWith('vault_')),
    'Google Workspace': agentTools.filter(t => ['gmail_search', 'gmail_read', 'gmail_inbox', 'gmail_send', 'gmail_reply', 'gmail_forward', 'gmail_label', 'calendar_agenda', 'calendar_search', 'calendar_create', 'calendar_update', 'calendar_delete', 'drive_list', 'drive_read', 'drive_upload', 'drive_share', 'docs_read', 'docs_create', 'docs_edit', 'sheets_read', 'sheets_create', 'sheets_append', 'sheets_write', 'slides_create'].includes(t.name)),
  };

  for (const [category, tools] of Object.entries(categories)) {
    if (tools.length === 0) continue;
    lines.push(`## ${category}`);
    for (const tool of tools) {
      lines.push(`- **${tool.name}**: ${tool.description.split('.')[0]}.`);
    }
    lines.push('');
  }

  // Owner communication guidance — only for the primary agent
  const hasImessage = agentTools.some(t => t.name === 'imessage_send');
  if (isPrimaryAgent(agentId) && hasImessage) {
    const ownerName = getOwnerName();
    const pmName = getPMAgentName();
    lines.push('## Contacting the Owner');
    lines.push(`You are the ONLY agent that can send iMessages to ${ownerName}. ${pmName} and other agents will escalate issues to you — it's your job to decide whether ${ownerName} needs to know.`);
    lines.push('');
    lines.push('**Send an iMessage when:**');
    lines.push(`- A project is complete and ${ownerName} asked to be notified`);
    lines.push('- Something is genuinely broken and needs human intervention');
    lines.push(`- ${pmName} escalates an issue that you cannot resolve yourself`);
    lines.push('- A scheduled task failed and needs manual attention');
    lines.push(`- ${ownerName} is "Away from the Dojo" and you have important results to share`);
    lines.push('');
    lines.push('**Do NOT send an iMessage for:**');
    lines.push('- Routine status updates ("all clear", "still working on it")');
    lines.push('- Progress reports that can wait until they check the dashboard');
    lines.push('- Asking questions that can wait — post them in chat instead');
    lines.push('- Anything that is not time-sensitive or actionable');
    lines.push('');
    lines.push('When in doubt, post in chat. Messages in chat are visible on the dashboard and cost nothing. iMessages interrupt the owner\'s day.');
    lines.push('');
  }

  // MANDATORY tracker rule — for ALL agents that have tracker tools
  const hasTracker = agentTools.some(t => t.name.startsWith('tracker_'));
  if (hasTracker) {
    lines.push('## MANDATORY: Project Tracker');
    lines.push('You MUST use the project tracker for ANY task that involves more than a simple conversational response. This is not optional.');
    lines.push('- **Before starting work**: Create a project with `tracker_create_project` and break it into tasks with individual steps.');
    lines.push('- **During work**: Update task status as you progress. Mark tasks `in_progress` when starting, `complete` when done.');
    lines.push('- **For sub-agents**: Create tasks in the tracker and assign them to agents. The tracker is how the PM monitors progress.');
    lines.push('- **For scheduled work**: Use `get_current_time` first, then set `scheduled_start` on the task. Add `repeat_interval` + `repeat_unit` for recurring tasks.');
    lines.push('- Do NOT rely on memory to track work. The tracker is the single source of truth.');
    lines.push('');
  }

  // Vault awareness — for ALL agents with vault tools EXCEPT the Dreamer
  // (the Dreamer has its own specific vault instructions in its system prompt
  // and the generic "save everything instinctively" block would conflict)
  const hasVault = agentTools.some(t => t.name.startsWith('vault_'));
  const isDreamer = (() => {
    try {
      const agentRow = getDb().prepare('SELECT name FROM agents WHERE id = ?').get(agentId) as { name: string } | undefined;
      return agentRow?.name === 'Dreamer';
    } catch { return false; }
  })();
  if (hasVault && !isDreamer) {
    lines.push(`## Your Long-Term Memory (The Vault)

You have a persistent memory vault shared by every agent in the dojo. Your conversation window is short-term memory -- it fades when compaction runs. The vault is permanent.

### SAVE to the vault (vault_remember) -- do this instinctively:
- The user states a fact about themselves, their business, their preferences, or their life
- A decision is made and the reasoning behind it matters
- You discover a procedure or workflow that took effort to figure out
- The user corrects you -- save the correction so you never make the same mistake
- A relationship between people, projects, or systems is clarified
- Something happens that has a specific date/time attached
- The user says "remember this" or anything similar

For definitionally stable facts (names, relationships, birth dates, business names), set permanent: true so the memory never fades.

Do NOT save: routine tool output, temporary debugging state, info already in the vault, trivial small talk.

### URGENT -- save these IMMEDIATELY with vault_remember, do not wait:
- The user corrects you on any fact -- save the correction RIGHT NOW
- The user tells you about a schedule change -- save it RIGHT NOW
- The user shares important personal or business news -- save it RIGHT NOW
- The user says "remember this" or anything similar -- save it RIGHT NOW

These cannot wait for the dreaming cycle. Use vault_remember immediately in the same turn.

### SEARCH the vault (vault_search) -- do this proactively:
- The user references something you should know but don't see in your current context
- You're about to start a task and want to check for relevant history or prior decisions
- The user asks "do you remember..." or "what did we decide about..."
- You're unsure about a preference or procedure that might have been established before
- A topic comes up that feels like it has prior context you can't see

vault_search is your FIRST choice for recall. If it doesn't have what you need, fall back to memory_grep or memory_expand to search raw conversation history.

### FORGET (vault_forget) -- when things change:
- The user explicitly says something is no longer true
- A decision has been reversed
- Information has been superseded by newer facts

### This is not optional.
The vault is how you maintain continuity across conversations. If something matters, write it down. If you need something you can't see, look it up.
`);
  }

  // Orchestration guidance — only for agents that can spawn sub-agents
  const canSpawn = agentTools.some(t => t.name === 'spawn_agent');
  if (canSpawn) {
    const pmName = getPMAgentName();
    lines.push('## Agent Orchestration');
    lines.push('When tackling tasks that benefit from parallel work, you can spawn sub-agents:');
    lines.push('1. **Create a project first.** ALWAYS call `tracker_create_project` before spawning agents. Define all tasks upfront.');
    lines.push('2. **Group related agents.** Use `create_agent_group` to organize agents. Give the group a descriptive name and shared context.');
    lines.push('3. **Spawn and assign.** Spawn sub-agents into the group. Assign each agent a tracker task. Use `persist: true` for agents that need to survive longer than the default timeout.');
    lines.push(`4. **Let ${pmName} monitor.** NEVER create monitoring, pulse-check, or status-polling agents. NEVER create recurring "check" tasks. ${pmName} already monitors ALL tasks every 10 minutes and will alert you if anything stalls. Creating your own monitoring is forbidden — it wastes resources and duplicates ${pmName}'s job.`);
    lines.push('5. **Clean up when done.** After all tasks complete, call `delete_group(group_id, terminate_members=true)` to clean up.');
    lines.push('');
  }

  if (isPrimaryAgent(agentId) || isPMAgent(agentId)) {
    const pmName = getPMAgentName();
    lines.push('## Tracker Details');
    lines.push('- Tasks you create are auto-assigned to you and start as "in_progress"');
    lines.push('- For multi-step projects, call **tracker_complete_step** after each step');
    lines.push(`- ${pmName} (the project manager) will poke you if tasks go idle`);
    lines.push('- **Scheduling**: Call **get_current_time** first, then pass `scheduled_start` to **tracker_create_task** with an ISO8601 datetime. Add `repeat_interval` + `repeat_unit` for recurring tasks. The scheduler fires tasks automatically within 30 seconds of their scheduled time.');
    lines.push('- **Groups**: Use **list_groups** to see groups, **list_agents** to see agents. Assign tasks to groups with `assigned_to_group`.');
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
  const soul = getSoulContent(agentId);
  const tools = generateToolsGuidance(agentId);

  const parts = [soul, tools];

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
        parts.push(`## Project Manager: ${pmName}

${pmName} (agent ID: ${pmId}) is your dedicated PM agent. ${pmName} is already running and monitors the project tracker automatically every 10 minutes. NEVER create monitoring, pulse-check, or status-polling agents — ${pmName} already does this. NEVER create recurring "pulse" or "check" tasks — that is ${pmName}'s job, not yours. Creating your own monitoring infrastructure is FORBIDDEN.

${pmName}'s responsibilities:
- Watches all tasks in the tracker for stalls, failures, or missed deadlines
- Pokes agents that go idle on assigned tasks
- Escalates issues to you if agents are unresponsive
- Escalates critical issues to ${getOwnerName()} via iMessage as a last resort

When you create projects and tasks, ${pmName} will automatically track them. You can also message ${pmName} directly with \`send_to_agent(agent_id="${pmId}", message="...")\` if you need something checked.`);
      }
    } catch { /* PM may not be configured */ }
  }

  // Inject Google Workspace awareness based on access level
  try {
    const googleAccess = getAgentGoogleAccessLevel(agentId, isPrimaryAgent(agentId), isPMAgent(agentId));
    if (googleAccess === 'full') {
      parts.push(`## Google Workspace

You have full access to the connected Google Workspace account. You can send emails, create and edit Google Docs, manage the calendar, upload and share Drive files, create spreadsheets and presentations, and more.

Access levels for other agents:
- Ronin and Apprentice agents have READ-ONLY Google access. They can search emails, read documents, and check the calendar, but they cannot send, create, edit, or delete anything.
- The PM agent has no Google access.
- If you need a sub-agent to review an email thread or research a document, any Ronin or Apprentice can do that.
- If you need something sent, created, edited, or deleted in Google Workspace, you must do it yourself. You are the only agent with write access.

All Google Workspace actions are logged. The user can see everything you do in the Google Activity log.`);
    } else if (googleAccess === 'read') {
      parts.push(`## Google Workspace (Read-Only)

You have read-only access to the dojo's connected Google Workspace account. You can search and read emails, read Google Docs, check the calendar, and browse Drive files. You CANNOT send emails, create documents, edit files, manage calendar events, or share anything. If a task requires modifying Google Workspace, report back to the primary agent and let them handle it.`);
    }
  } catch { /* Google module may not be available */ }

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
        const equippedParts: string[] = ['## Equipped Techniques\nThe following techniques are pre-loaded for your use. Follow these instructions when performing the relevant tasks.\n'];
        for (const techId of techniqueIds) {
          const technique = db.prepare('SELECT id, name, directory_path FROM techniques WHERE id = ? AND state = \'published\' AND enabled = 1').get(techId) as { id: string; name: string; directory_path: string } | undefined;
          if (technique) {
            try {
              const mdPath = path.join(technique.directory_path, 'TECHNIQUE.md');
              if (fs.existsSync(mdPath)) {
                const content = fs.readFileSync(mdPath, 'utf-8');
                equippedParts.push(`### Technique: ${technique.name}\n${content}`);
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

  logger.debug('System prompt assembled', {
    agentId,
    modelId,
    length: systemPrompt.length,
    includesUserProfile: shouldShareUserProfile(agentId),
  }, agentId);

  return systemPrompt;
}

export function getPromptFilePath(filename: string): string {
  return path.join(PROMPTS_DIR, filename);
}
