import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DEFAULT_SOUL_MD, DEFAULT_USER_MD, DEFAULT_PM_SOUL_MD, DEFAULT_TRAINER_SOUL_MD } from './templates.js';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { toolDefinitions, getFilteredTools } from '../agent/tools.js';
import { isPrimaryAgent, isPMAgent, isTrainerAgent, getPMAgentName, getPMAgentId, getOwnerName } from '../config/platform.js';
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
  if (!isPrimaryAgent(agentId)) {
    // Check for agent-specific soul file
    const agentSoulPath = path.join(PROMPTS_DIR, `${agentId.toUpperCase()}-SOUL.md`);
    if (fs.existsSync(agentSoulPath)) {
      try {
        return fs.readFileSync(agentSoulPath, 'utf-8');
      } catch {
        // Fall through
      }
    }
    if (isPMAgent(agentId)) {
      return readPromptFile('PM-SOUL.md', DEFAULT_PM_SOUL_MD);
    }
    if (isTrainerAgent(agentId)) {
      return readPromptFile('TRAINER-SOUL.md', DEFAULT_TRAINER_SOUL_MD);
    }
  }
  return readPromptFile('SOUL.md', DEFAULT_SOUL_MD);
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
    'Multi-Agent': agentTools.filter(t => ['spawn_agent', 'kill_agent', 'send_to_agent', 'complete_task', 'list_agents', 'list_groups', 'create_agent_group', 'assign_to_group', 'delete_group'].includes(t.name)),
    'Project Tracker': agentTools.filter(t => t.name.startsWith('tracker_')),
    'Time': agentTools.filter(t => t.name === 'get_current_time'),
    'Communication': agentTools.filter(t => t.name === 'imessage_send'),
    'Techniques': agentTools.filter(t => ['save_technique', 'use_technique', 'list_techniques', 'publish_technique', 'update_technique', 'submit_technique_for_review'].includes(t.name)),
  };

  for (const [category, tools] of Object.entries(categories)) {
    if (tools.length === 0) continue;
    lines.push(`## ${category}`);
    for (const tool of tools) {
      lines.push(`- **${tool.name}**: ${tool.description.split('.')[0]}.`);
    }
    lines.push('');
  }

  // Orchestration guidance — only for agents that can spawn sub-agents
  const canSpawn = agentTools.some(t => t.name === 'spawn_agent');
  if (canSpawn) {
    const pmName = getPMAgentName();
    lines.push('## Agent Orchestration');
    lines.push('When tackling complex tasks, you can spawn sub-agents to work in parallel:');
    lines.push('1. **Plan first.** Create a tracker project, break work into tasks, identify what can run in parallel.');
    lines.push('2. **Group related agents.** Use `create_agent_group` to organize agents working on the same project. Give the group a descriptive name and set the description to shared context (staging directories, output paths, etc.).');
    lines.push('3. **Spawn and assign.** Spawn sub-agents into the group. Each agent should focus on a specific task — research, analysis, writing, etc. Use `persist: true` for agents that need to survive longer than the default timeout.');
    lines.push(`4. **Let ${pmName} monitor.** Do NOT create your own monitoring, "pulse check", or progress-tracking agents. ${pmName} (the PM agent) is already running and automatically monitors all tasks every 3 minutes. She will alert you if anything stalls, fails, or needs attention. You will also be notified automatically when a project completes.`);
    lines.push('5. **Clean up when done.** After you are notified that all tasks are complete and you are satisfied with the results, call `delete_group(group_id, terminate_members=true)` to terminate all agents and delete the group in one step. Do not leave orphaned groups or idle agents around.');
    lines.push('');
  }


  if (isPrimaryAgent(agentId) || isPMAgent(agentId)) {
    const pmName = getPMAgentName();
    lines.push('## Tracker Notes');
    lines.push('- Tasks you create are auto-assigned to you and start as "in_progress"');
    lines.push('- For multi-step projects, call **tracker_complete_step** after each step');
    lines.push(`- ${pmName} (the project manager) will poke you if tasks go idle`);
    lines.push('- **Scheduling**: To schedule a task for later, call **get_current_time** first, then pass `scheduled_start` to **tracker_create_task** with an ISO8601 datetime. Add `repeat_interval` + `repeat_unit` for recurring tasks. The scheduler fires tasks automatically within 30 seconds of their scheduled time.');
    lines.push('- **Groups**: Use **list_groups** to see groups, **list_agents** to see agents. Assign tasks to groups with `assigned_to_group` — the PM picks an agent at run time.');
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

${pmName} (agent ID: ${pmId}) is your dedicated PM agent. She is already running and monitors the project tracker automatically every 3 minutes. You do NOT need to create a monitoring or "pulse check" agent — ${pmName} handles that.

${pmName}'s responsibilities:
- Watches all tasks in the tracker for stalls, failures, or missed deadlines
- Pokes agents that go idle on assigned tasks
- Escalates issues to you if agents are unresponsive
- Escalates critical issues to ${getOwnerName()} via iMessage as a last resort

When you create projects and tasks, ${pmName} will automatically track them. You can also send her messages directly with \`send_to_agent(agent_id="${pmId}", message="...")\` if you need her to check something specific.`);
      }
    } catch { /* PM may not be configured */ }
  }

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
