import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);
import fs from 'node:fs';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { broadcast } from '../gateway/ws.js';
import { memoryGrep, memoryDescribe, memoryExpand, memorySearch } from '../memory/retrieval.js';
import { shouldIntercept, interceptLargeFile } from '../memory/large-files.js';
import { checkPermission, getAgentPermissions } from './permissions.js';
import { isPrimaryAgent, isPMAgent, getPrimaryAgentId } from '../config/platform.js';
import { spawnAgent, terminateAgent, completeAgent } from './spawner.js';
import { getAgentRuntime } from './runtime.js';
import { sendIMessage, getDefaultSender, getApprovedSenders } from '../services/imessage-bridge.js';
import {
  trackerCreateProject,
  trackerCreateTask,
  trackerUpdateStatus,
  trackerAddNotes,
  trackerGetStatus,
  trackerListActive,
  trackerCompleteStep,
  trackerPauseSchedule,
  trackerResumeSchedule,
} from '../tracker/tools.js';
import { webSearch, webFetch } from './web-tools.js';
import { mouseClick, mouseMove, keyboardType, screenRead, applescriptRun } from './system-control.js';
import { executeWebBrowse } from './browser.js';
import { createGroup, assignAgentToGroup } from './groups.js';
import type { ToolCall, ToolResult } from '@dojo/shared';

const logger = createLogger('tools');

const MAX_FILE_READ_CHARS = 50000;
const EXEC_TIMEOUT_MS = 30000;

// ── Filtered tools per agent (based on permissions + tools policy) ──

export function getFilteredTools(agentId: string): ToolDefinition[] {
  const manifest = getAgentPermissions(agentId);

  // Get tools policy from DB
  const db = getDb();
  const agentRow = db.prepare('SELECT tools_policy FROM agents WHERE id = ?').get(agentId) as { tools_policy: string } | undefined;
  let toolsPolicy: { allow: string[]; deny: string[] } = { allow: [], deny: [] };
  if (agentRow?.tools_policy) {
    try {
      const parsed = JSON.parse(agentRow.tools_policy);
      if (parsed.allow) toolsPolicy.allow = parsed.allow;
      if (parsed.deny) toolsPolicy.deny = parsed.deny;
    } catch { /* ignore */ }
  }

  let filtered = [...toolDefinitions];

  // 1. Tools policy deny list — remove denied tools
  if (toolsPolicy.deny.length > 0) {
    filtered = filtered.filter(t => !toolsPolicy.deny.includes(t.name));
  }

  // 2. Tools policy allow list — if non-empty, only include allowed tools
  if (toolsPolicy.allow.length > 0) {
    filtered = filtered.filter(t => toolsPolicy.allow.includes(t.name));
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
  if (!hasFileWrite) removeTools.push('file_write');
  if (!hasExec) removeTools.push('exec');
  if (!hasNetwork) removeTools.push('web_search', 'web_fetch');
  if (!hasSysControl) removeTools.push('mouse_click', 'mouse_move', 'keyboard_type', 'screen_read', 'applescript_run');
  if (!hasWebBrowse) removeTools.push('web_browse');
  if (!manifest.can_spawn_agents) removeTools.push('spawn_agent', 'kill_agent');

  // Only agents with can_assign_permissions get permission management tools
  if (!manifest.can_assign_permissions) {
    removeTools.push('update_agent_permissions');
  }

  // Only primary-level agents should have group management tools
  if (!isPrimaryAgent(agentId)) {
    removeTools.push('create_agent_group', 'assign_to_group', 'delete_group');
  }

  // Technique tools: only Sensei can save/publish/update, everyone can use/list
  const agentClassification = (getDb().prepare('SELECT classification FROM agents WHERE id = ?').get(agentId) as { classification: string } | undefined)?.classification;
  if (agentClassification !== 'sensei') {
    removeTools.push('save_technique', 'publish_technique', 'update_technique', 'submit_technique_for_review');
  }

  if (removeTools.length > 0) {
    filtered = filtered.filter(t => !removeTools.includes(t.name));
  }

  return filtered;
}

// ── Tool Schemas for Anthropic API ──

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
  };
}

export const toolDefinitions: ToolDefinition[] = [
  {
    name: 'exec',
    description: 'Execute a shell command and return its output. Has a 30-second timeout. Use for running scripts, checking system status, installing packages, etc.',
    input_schema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The shell command to execute',
        },
        timeout: {
          type: 'number',
          description: 'Timeout in milliseconds (default: 30000, max: 120000)',
        },
      },
      required: ['command'],
    },
  },
  {
    name: 'file_read',
    description: 'Read the contents of a file at the given absolute path. Large files are truncated at 50,000 characters.',
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute path to the file to read',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'file_write',
    description: 'Write content to a file at the given absolute path. Creates parent directories if they do not exist. Overwrites existing files.',
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
  },
  {
    name: 'file_list',
    description: 'List the contents of a directory at the given absolute path. Returns file names, sizes, and types.',
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
    name: 'memory_grep',
    description: 'Search through conversation history and memory summaries using full-text search or pattern matching. Returns matching messages and summaries with context.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'The search pattern or query string',
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
      required: ['pattern'],
    },
  },
  {
    name: 'memory_describe',
    description: 'Look up details of a summary or large file by its ID. Returns full content, metadata, and navigation hints for summaries (sum_*) and intercepted large files (file_*).',
    input_schema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'The summary ID (sum_*) or large file ID (file_*) to describe',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'memory_expand',
    description: 'Deep recall: walks the summary DAG to retrieve original source messages, optionally uses an LLM to synthesize an answer from expanded material. Use when summaries lack detail.',
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
          description: 'The question or instruction for the expansion — what you want to recall or understand',
        },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'memory_search',
    description: 'Simplified memory search that searches both messages and summaries using full-text search. A convenience wrapper around memory_grep.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results (default: 10)',
        },
      },
      required: ['query'],
    },
  },
  // ── Web Tools ──
  {
    name: 'web_search',
    description: 'Search the web using Brave Search. Returns up to 10 results with titles, URLs, and snippets. Requires a Brave Search API key to be configured.',
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
  },
  {
    name: 'web_fetch',
    description: 'Fetch the content of a web page and return its text. HTML is stripped to plain text. Content is truncated to maxTokens. Requires network_domains permission.',
    input_schema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The URL to fetch',
        },
        maxTokens: {
          type: 'number',
          description: 'Maximum tokens of content to return (default: 8000)',
        },
      },
      required: ['url'],
    },
  },
  // ── Multi-Agent Tools ──
  {
    name: 'spawn_agent',
    description: 'Spawn a new sub-agent to work on a task. BEFORE spawning, check if an agent with that name already exists and is still running — use send_to_agent instead of spawning a duplicate. Returns the new agent ID for tracking.',
    input_schema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'A short, descriptive name for the sub-agent',
        },
        system_prompt: {
          type: 'string',
          description: 'The system prompt that defines the sub-agent\'s role and instructions',
        },
        model_id: {
          type: 'string',
          description: 'Optional model ID to use. Defaults to parent agent\'s model.',
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
        timeout: {
          type: 'number',
          description: 'Auto-termination timeout in seconds. The agent will be killed after this many seconds. Default is 900 (15 min). Set this longer than the expected task duration — if the agent has a scheduled task 10 minutes from now that takes 5 minutes, set timeout to at least 1200 (20 min). Set to 0 or omit for the default. For long-running or scheduled tasks, consider using classification="freelance" instead, which has no timeout.',
        },
        task_id: {
          type: 'string',
          description: 'Optional tracker task ID to associate with this agent',
        },
        context_hints: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional search terms to pull relevant context from parent memory into the sub-agent',
        },
        persist: {
          type: 'boolean',
          description: 'If true, agent stays alive after completing work — goes to idle instead of terminating, and is exempt from the timeout. Use for agents that need to handle multiple tasks or wait for scheduled tasks. Default: false.',
        },
        initial_message: {
          type: 'string',
          description: 'Custom initial message to send to the agent instead of the default task instructions. Use when you want full control over what the agent sees first.',
        },
        classification: {
          type: 'string',
          enum: ['apprentice', 'ronin'],
          description: 'Agent classification. "apprentice" (default): can be terminated by other agents, subject to timeouts. "ronin": persists across restarts, only David can terminate from dashboard.',
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
      },
      required: ['name', 'system_prompt'],
    },
  },
  {
    name: 'kill_agent',
    description: 'Terminate a sub-agent immediately. Also terminates any of its children. Use when a sub-agent is stuck, no longer needed, or misbehaving.',
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
    name: 'send_to_agent',
    description: 'Send a message to an existing running sub-agent by ID or name. Use this to give follow-up instructions, ask for status, or provide additional context to a sub-agent that is already running.',
    input_schema: {
      type: 'object',
      properties: {
        agent: {
          type: 'string',
          description: 'Agent ID or agent name to send the message to',
        },
        message: {
          type: 'string',
          description: 'The message content to send',
        },
      },
      required: ['agent', 'message'],
    },
  },
  {
    name: 'complete_task',
    description: 'Signal that the current agent has finished its assigned work. This terminates the agent and reports results back to the parent. Only use when you are a sub-agent that has completed its task.',
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
  // ── Tracker Tools ──
  {
    name: 'tracker_create_project',
    description: 'Create a new project in the tracker, optionally with initial tasks. Use for multi-step work that needs tracking and accountability.',
    input_schema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Project title',
        },
        description: {
          type: 'string',
          description: 'Project description',
        },
        level: {
          type: 'number',
          description: 'Importance level: 1 (routine), 2 (important), 3 (critical)',
        },
        tasks: {
          type: 'array',
          description: 'Optional initial tasks to create with the project',
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
      },
      required: ['title', 'level'],
    },
  },
  {
    name: 'tracker_create_task',
    description: 'Create a task, optionally with scheduling. Can run immediately, at a scheduled time, or on a repeating schedule. To schedule: set scheduled_start to an ISO8601 datetime (e.g., "2026-03-20T22:35:00Z"). To repeat: also set repeat_interval and repeat_unit (e.g., repeat_interval=2, repeat_unit="hours" for every 2 hours). Use repeat_end_type="after_count" with repeat_end_value="3" to stop after 3 runs. Use get_current_time to find the current time, then add minutes/hours for the start time. Tasks without scheduled_start run immediately when assigned.',
    input_schema: {
      type: 'object',
      properties: {
        project_id: {
          type: 'string',
          description: 'Optional project ID to attach this task to',
        },
        title: {
          type: 'string',
          description: 'Task title',
        },
        description: {
          type: 'string',
          description: 'Task description',
        },
        assigned_to: {
          type: 'string',
          description: 'Agent ID or name to assign this task to',
        },
        priority: {
          type: 'string',
          enum: ['high', 'normal', 'low'],
          description: 'Task priority (default: normal)',
        },
        step_number: {
          type: 'number',
          description: 'Step number for ordered execution',
        },
        depends_on: {
          type: 'array',
          items: { type: 'string' },
          description: 'Task IDs that must complete before this task can start',
        },
        phase: {
          type: 'number',
          description: 'Phase number for phased execution',
        },
        scheduled_start: {
          type: 'string',
          description: 'When to run this task. Use ISO8601 format like "2026-03-20T22:35:00Z". Call get_current_time first to get the current time, then calculate your target time. If omitted, task runs immediately.',
        },
        repeat_interval: {
          type: 'number',
          description: 'How often to repeat. e.g., 2 means every 2 of the repeat_unit. Requires repeat_unit.',
        },
        repeat_unit: {
          type: 'string',
          enum: ['minutes', 'hours', 'days', 'weeks', 'months', 'years'],
          description: 'Unit for repeat interval',
        },
        repeat_end_type: {
          type: 'string',
          enum: ['never', 'after_count', 'on_date'],
          description: 'When to stop repeating',
        },
        repeat_end_value: {
          type: 'string',
          description: 'End after N runs or on a specific ISO8601 date',
        },
        assigned_to_group: {
          type: 'string',
          description: 'Assign this task to a group instead of a specific agent. The PM will pick an available agent from the group at run time.',
        },
      },
      required: ['title'],
    },
  },
  {
    name: 'tracker_update_status',
    description: 'Update the status of a task in the tracker. Call this when starting work (in_progress), finishing (complete), getting stuck (blocked), or failing (failed). Always update task status as you work — don\'t leave tasks stale.',
    input_schema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'The task ID to update',
        },
        status: {
          type: 'string',
          enum: ['on_deck', 'in_progress', 'complete', 'blocked', 'fallen'],
          description: 'New status for the task',
        },
        notes: {
          type: 'string',
          description: 'Optional notes about the status change',
        },
      },
      required: ['task_id', 'status'],
    },
  },
  {
    name: 'tracker_add_notes',
    description: 'Add timestamped notes to a task. Useful for logging progress or issues.',
    input_schema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'The task ID to add notes to',
        },
        notes: {
          type: 'string',
          description: 'The notes to append',
        },
      },
      required: ['task_id', 'notes'],
    },
  },
  {
    name: 'tracker_get_status',
    description: 'Get the current status and details of a task or project.',
    input_schema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Task ID or Project ID to look up',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'tracker_list_active',
    description: 'List active projects and tasks, optionally filtered.',
    input_schema: {
      type: 'object',
      properties: {
        filter: {
          type: 'string',
          enum: ['all', 'mine', 'blocked', 'overdue'],
          description: 'Filter to apply (default: all)',
        },
      },
      required: [],
    },
  },
  {
    name: 'tracker_complete_step',
    description: 'Complete the current step and automatically start the next one. Use this for multi-step projects — it marks the given task as "complete" and moves the next step (by step_number) to "in_progress" in one call.',
    input_schema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'The task ID of the step you just completed',
        },
        notes: {
          type: 'string',
          description: 'Notes about what was done in this step',
        },
      },
      required: ['task_id'],
    },
  },
  // ── Schedule Tools (Phase 6) ──
  {
    name: 'tracker_pause_schedule',
    description: 'Pause a recurring task\'s schedule. It won\'t run again until resumed.',
    input_schema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'The task ID to pause' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'tracker_resume_schedule',
    description: 'Resume a paused recurring task.',
    input_schema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'The task ID to resume' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'get_current_time',
    description: 'Get the current date, time, and timezone. Call this before scheduling tasks so you can calculate the correct scheduled_start time.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  // ── Group Tools (Phase 6) ──
  {
    name: 'create_agent_group',
    description: 'Create a new group for organizing agents around a shared purpose. The group description is injected into all member agents\' prompts.',
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
    name: 'assign_to_group',
    description: 'Add an agent to a group.',
    input_schema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'Agent ID to assign' },
        group_id: { type: 'string', description: 'Group ID to assign to (or null to remove from group)' },
      },
      required: ['agent_id', 'group_id'],
    },
  },
  // ── Agent & Group Visibility Tools ──
  {
    name: 'list_agents',
    description: 'List all active agents with their name, ID, status, group, and classification. Use to find agent IDs for task assignment or messaging.',
    input_schema: {
      type: 'object',
      properties: {
        include_terminated: { type: 'boolean', description: 'Include terminated agents (default: false)' },
      },
      required: [],
    },
  },
  {
    name: 'list_models',
    description: 'List all enabled models with name, ID, provider, and cost per million tokens. Use to pick a model when spawning agents — choose cheaper models for simple tasks, expensive ones for complex reasoning.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'delete_group',
    description: 'Delete an agent group. All member agents are moved to ungrouped (not terminated). Use this after a group has completed its work and agents have been terminated. Cannot delete the System group.',
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
    description: 'List all agent groups with their name, ID, description, and member count.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'tracker_reassign_task',
    description: 'Reassign a task to a different agent or group.',
    input_schema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Task ID to reassign' },
        assigned_to: { type: 'string', description: 'Agent ID to assign to (use this OR assigned_to_group, not both)' },
        assigned_to_group: { type: 'string', description: 'Group ID to assign to — the PM will pick an available agent at run time' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'update_agent_permissions',
    description: 'Change the permissions on an existing agent. Use to grant or revoke capabilities like file access, command execution, web access, system control, etc.',
    input_schema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'The agent ID to update' },
        permissions: {
          type: 'object',
          description: 'Permission fields to set. Only include fields you want to change. Fields: file_read ("*" or path array), file_write ("*" or path array), file_delete ("none" or path array), exec_allow (command array, ["*"] for all), exec_deny (command array), network_domains ("*", "none", or domain array), max_processes (number), can_spawn_agents (boolean), can_assign_permissions (boolean), system_control (array: "mouse","keyboard","screen","applescript","web_browse", or ["*"] for all)',
        },
      },
      required: ['agent_id', 'permissions'],
    },
  },
  // ── iMessage Tool ──
  {
    name: 'imessage_send',
    description: 'Send an iMessage. If recipient is omitted, sends to the default contact. Use for proactive communication, status updates, or escalation.',
    input_schema: {
      type: 'object',
      properties: {
        recipient: {
          type: 'string',
          description: 'Phone number or Apple ID. Omit to use default contact.',
        },
        message: {
          type: 'string',
          description: 'The message text to send',
        },
      },
      required: ['message'],
    },
  },
  // ── System Control Tools (Phase 5A) ──
  {
    name: 'mouse_click',
    description: 'Move the mouse to coordinates and click. Use after screen_read to identify target positions.',
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
    name: 'screen_read',
    description: 'Take a screenshot and describe what is visible using a vision model. Returns a text description with approximate coordinates for interactive elements. Use before mouse_click to find targets.',
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
        query: { type: 'string', description: 'Specific question about the screen, e.g., "where is the Submit button?"' },
      },
      required: [],
    },
  },
  {
    name: 'applescript_run',
    description: 'Run an AppleScript command. Use for macOS automation: opening apps, controlling windows, running Shortcuts, interacting with system features.',
    input_schema: {
      type: 'object',
      properties: {
        script: { type: 'string', description: 'The AppleScript code to execute' },
      },
      required: ['script'],
    },
  },
  // ── Headless Browser Tool (Phase 5B) ──
  {
    name: 'web_browse',
    description: 'Open a headless browser to interact with web pages. Can navigate, take screenshots, click elements, fill forms, and extract content. Use for pages that require JavaScript rendering or interaction. The browser session persists across calls — navigate first, then interact.',
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
      },
      required: ['action'],
    },
  },
  // ── Technique Tools ──
  {
    name: 'save_technique',
    description: 'Save what you learned as a reusable technique for the dojo. Creates a new technique with instructions and optional supporting files. Only Sensei agents can create techniques.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short name (lowercase, hyphens ok, used as directory name)' },
        display_name: { type: 'string', description: 'Human-readable name' },
        description: { type: 'string', description: 'One-line description of what this technique does' },
        instructions: { type: 'string', description: 'Full TECHNIQUE.md content — detailed step-by-step instructions for how to execute this technique, written for other agents to follow' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags for categorization' },
        files: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Relative path within the technique directory' },
              content: { type: 'string', description: 'File content' },
            },
          },
          description: 'Supporting files to include',
        },
        publish: { type: 'boolean', description: 'If true, publish immediately. If false, save as draft.' },
      },
      required: ['name', 'display_name', 'description', 'instructions'],
    },
  },
  {
    name: 'use_technique',
    description: 'Load a technique\'s full instructions into your context so you can follow them. All agents can use published techniques.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Technique ID (the short name) to load' },
      },
      required: ['name'],
    },
  },
  {
    name: 'list_techniques',
    description: 'List all available techniques in the dojo.',
    input_schema: {
      type: 'object',
      properties: {
        tag: { type: 'string', description: 'Filter by tag' },
        include_drafts: { type: 'boolean', description: 'Include draft techniques (Sensei only)' },
      },
      required: [],
    },
  },
  {
    name: 'publish_technique',
    description: 'Publish a draft technique, making it available to all agents. Sensei only.',
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
    description: 'Update a technique\'s instructions or files. Creates a version snapshot. Sensei only.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Technique ID to update' },
        instructions: { type: 'string', description: 'Updated TECHNIQUE.md content' },
        files: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } }, description: 'Files to add or update' },
        change_summary: { type: 'string', description: 'Brief description of what changed' },
      },
      required: ['name', 'change_summary'],
    },
  },
  {
    name: 'submit_technique_for_review',
    description: 'Mark a draft technique as ready for Sensei review.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Technique ID to submit for review' },
      },
      required: ['name'],
    },
  },
];

// ── Path Resolution ──

import os from 'node:os';

function resolvePath(inputPath: string): string {
  // Expand ~ and ~/ to home directory
  if (inputPath === '~') return os.homedir();
  if (inputPath.startsWith('~/')) return path.join(os.homedir(), inputPath.slice(2));
  if (inputPath.startsWith('~')) return path.join(os.homedir(), '..', inputPath.slice(1));
  return inputPath;
}

// ── Tool Execution ──

// Map tool names to valid audit_log action_type values
const AUDIT_ACTION_MAP: Record<string, string> = {
  file_read: 'file_read',
  file_list: 'file_read',
  file_write: 'file_write',
  file_delete: 'file_write',
  exec: 'exec',
};

function auditLog(agentId: string, actionType: string, target: string | null, result: 'success' | 'denied' | 'error', detail?: string): void {
  try {
    const db = getDb();
    // Normalize action_type to match the CHECK constraint
    const normalizedAction = AUDIT_ACTION_MAP[actionType] ?? 'tool_call';
    db.prepare(`
      INSERT INTO audit_log (id, agent_id, action_type, target, result, detail, created_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(uuidv4(), agentId, normalizedAction, target, result, detail ?? null);
  } catch (err) {
    logger.error('Failed to write audit log', {
      error: err instanceof Error ? err.message : String(err),
    }, agentId);
  }
}

async function executeExec(agentId: string, args: Record<string, unknown>): Promise<string> {
  const command = args.command as string;
  const timeout = Math.min(
    typeof args.timeout === 'number' ? args.timeout : EXEC_TIMEOUT_MS,
    120000,
  );

  logger.info('Executing command', { command, timeout }, agentId);

  try {
    const { stdout, stderr } = await execAsync(command, {
      timeout,
      maxBuffer: 1024 * 1024, // 1MB
      encoding: 'utf-8',
      shell: '/bin/zsh',
    });

    const result = (stdout ?? '').trim();
    if (stderr && stderr.trim()) {
      auditLog(agentId, 'exec', command, 'success', `stdout: ${result.slice(0, 250)} | stderr: ${stderr.trim().slice(0, 250)}`);
    } else {
      auditLog(agentId, 'exec', command, 'success', result.slice(0, 500));
    }
    return result || '(command completed with no output)';
  } catch (err: unknown) {
    const error = err as { stderr?: string; stdout?: string; message?: string; code?: number };
    const stderr = error.stderr ?? error.message ?? 'Unknown error';
    auditLog(agentId, 'exec', command, 'error', String(stderr).slice(0, 500));
    return `Error (exit ${error.code ?? 'unknown'}): ${stderr}`;
  }
}

async function executeFileRead(agentId: string, args: Record<string, unknown>): Promise<string> {
  const filePath = resolvePath(args.path as string);

  if (!path.isAbsolute(filePath)) {
    auditLog(agentId, 'file_read', filePath, 'error', 'Path must be absolute (use ~ for home directory)');
    return 'Error: Path must be absolute. Use ~ for home directory or provide a full path.';
  }

  try {
    const stat = await fs.promises.stat(filePath).catch(() => null);
    if (!stat) {
      auditLog(agentId, 'file_read', filePath, 'error', 'File not found');
      return `Error: File not found: ${filePath}`;
    }

    if (stat.isDirectory()) {
      auditLog(agentId, 'file_read', filePath, 'error', 'Path is a directory');
      return 'Error: Path is a directory, use file_list instead';
    }

    let content = await fs.promises.readFile(filePath, 'utf-8');
    let truncated = false;

    if (content.length > MAX_FILE_READ_CHARS) {
      content = content.slice(0, MAX_FILE_READ_CHARS);
      truncated = true;
    }

    auditLog(agentId, 'file_read', filePath, 'success', `${stat.size} bytes`);

    if (truncated) {
      return content + `\n\n... [TRUNCATED: file is ${stat.size} bytes, showing first ${MAX_FILE_READ_CHARS} characters]`;
    }

    return content;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    auditLog(agentId, 'file_read', filePath, 'error', msg);
    return `Error reading file: ${msg}`;
  }
}

async function executeFileWrite(agentId: string, args: Record<string, unknown>): Promise<string> {
  const filePath = resolvePath(args.path as string);
  const content = args.content as string;

  if (!path.isAbsolute(filePath)) {
    auditLog(agentId, 'file_write', filePath, 'error', 'Path must be absolute (use ~ for home directory)');
    return 'Error: Path must be absolute. Use ~ for home directory or provide a full path.';
  }

  try {
    const dir = path.dirname(filePath);
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(filePath, content, 'utf-8');
    auditLog(agentId, 'file_write', filePath, 'success', `${content.length} bytes written`);
    return `File written successfully: ${filePath} (${content.length} bytes)`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    auditLog(agentId, 'file_write', filePath, 'error', msg);
    return `Error writing file: ${msg}`;
  }
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

function permissionDeniedMessage(reason: string | undefined): string {
  return `Permission denied: ${reason ?? 'not allowed'}. DO NOT retry this operation — your permissions do not allow it. Find an alternative approach or use complete_task to report that you are blocked.`;
}

export async function executeTool(agentId: string, toolCall: ToolCall): Promise<ToolResult> {
  const { id, name, arguments: args } = toolCall;

  logger.info('Executing tool', { tool: name, args }, agentId);

  let content: string;
  let isError = false;

  // ── Permission checks for file/exec tools ──
  if (name === 'file_read' || name === 'file_list') {
    const filePath = args.path as string | undefined;
    if (filePath) {
      const perm = checkPermission(agentId, { type: 'file_read', path: filePath });
      if (!perm.allowed) {
        auditLog(agentId, name, filePath, 'denied', perm.reason);
        return { toolCallId: id, name, content: permissionDeniedMessage(perm.reason), isError: true };
      }
    }
  }

  if (name === 'file_write') {
    const filePath = args.path as string | undefined;
    if (filePath) {
      const perm = checkPermission(agentId, { type: 'file_write', path: filePath });
      if (!perm.allowed) {
        auditLog(agentId, name, filePath, 'denied', perm.reason);
        return { toolCallId: id, name, content: permissionDeniedMessage(perm.reason), isError: true };
      }
    }
  }

  if (name === 'exec') {
    const command = args.command as string | undefined;
    if (command) {
      const perm = checkPermission(agentId, { type: 'exec', command });
      if (!perm.allowed) {
        auditLog(agentId, 'exec', command, 'denied', perm.reason);
        return { toolCallId: id, name, content: permissionDeniedMessage(perm.reason), isError: true };
      }
    }
  }

  if (name === 'spawn_agent') {
    const perm = checkPermission(agentId, { type: 'spawn' });
    if (!perm.allowed) {
      auditLog(agentId, 'spawn', null, 'denied', perm.reason);
      return { toolCallId: id, name, content: permissionDeniedMessage(perm.reason), isError: true };
    }
  }

  if (name === 'web_fetch') {
    const url = args.url as string | undefined;
    if (url) {
      try {
        const domain = new URL(url).hostname;
        const perm = checkPermission(agentId, { type: 'network', domain });
        if (!perm.allowed) {
          auditLog(agentId, 'web_fetch', url, 'denied', perm.reason);
          return { toolCallId: id, name, content: permissionDeniedMessage(perm.reason), isError: true };
        }
      } catch {
        return { toolCallId: id, name, content: `Invalid URL: ${url}`, isError: true };
      }
    }
  }

  if (name === 'web_search') {
    const perm = checkPermission(agentId, { type: 'network', domain: 'api.search.brave.com' });
    if (!perm.allowed) {
      auditLog(agentId, 'web_search', null, 'denied', perm.reason);
      return { toolCallId: id, name, content: permissionDeniedMessage(perm.reason), isError: true };
    }
  }

  if (name === 'imessage_send') {
    if (!isPrimaryAgent(agentId) && !isPMAgent(agentId)) {
      auditLog(agentId, 'imessage_send', null, 'denied', 'imessage_send is restricted to primary and PM agents');
      return { toolCallId: id, name, content: 'Permission denied: imessage_send is restricted', isError: true };
    }
  }

  // web_browse: primary agent only by default, sub-agents need explicit permission
  if (name === 'web_browse') {
    const manifest = (await import('./permissions.js')).getAgentPermissions(agentId);
    const controlPerms = manifest.system_control ?? [];
    const hasAccess = Array.isArray(controlPerms)
      ? controlPerms.includes('*') || controlPerms.includes('web_browse')
      : controlPerms === '*';
    if (!hasAccess) {
      auditLog(agentId, name, null, 'denied', 'web_browse requires system_control permission');
      return { toolCallId: id, name, content: 'Permission denied: web_browse requires system_control permission', isError: true };
    }

    // For sub-agents with web_browse, enforce network_domains on navigate
    if (args.action === 'navigate' && args.url && !isPrimaryAgent(agentId)) {
      try {
        const domain = new URL(args.url as string).hostname;
        const perm = checkPermission(agentId, { type: 'network', domain });
        if (!perm.allowed) {
          auditLog(agentId, 'web_browse', args.url as string, 'denied', perm.reason);
          return { toolCallId: id, name, content: permissionDeniedMessage(perm.reason), isError: true };
        }
      } catch {
        return { toolCallId: id, name, content: `Invalid URL: ${args.url}`, isError: true };
      }
    }
  }

  // System control tools: check system_control permission
  if (['mouse_click', 'mouse_move', 'keyboard_type', 'screen_read', 'applescript_run'].includes(name)) {
    const manifest = (await import('./permissions.js')).getAgentPermissions(agentId);
    const controlPerms = manifest.system_control ?? [];
    const toolCategory = name === 'mouse_click' || name === 'mouse_move' ? 'mouse'
      : name === 'keyboard_type' ? 'keyboard'
      : name === 'screen_read' ? 'screen'
      : name === 'applescript_run' ? 'applescript'
      : name;
    const allowed = Array.isArray(controlPerms)
      ? controlPerms.includes('*') || controlPerms.includes(toolCategory) || controlPerms.includes(name)
      : controlPerms === '*';
    if (!allowed) {
      auditLog(agentId, name, null, 'denied', `system_control permission required: ${toolCategory}`);
      return { toolCallId: id, name, content: `Permission denied: ${name} requires system_control permission`, isError: true };
    }
  }

  try {
    switch (name) {
      case 'exec':
        content = await executeExec(agentId, args);
        isError = content.startsWith('Error');
        break;
      case 'file_read':
        content = await executeFileRead(agentId, args);
        isError = content.startsWith('Error');
        break;
      case 'file_write':
        content = await executeFileWrite(agentId, args);
        isError = content.startsWith('Error');
        break;
      case 'file_list':
        content = await executeFileList(agentId, args);
        isError = content.startsWith('Error');
        break;
      case 'memory_grep':
        content = memoryGrep(agentId, {
          pattern: args.pattern as string,
          mode: args.mode as 'full_text' | 'regex' | undefined,
          scope: args.scope as 'messages' | 'summaries' | 'both' | undefined,
          since: args.since as string | undefined,
          before: args.before as string | undefined,
          limit: args.limit as number | undefined,
        });
        break;
      case 'memory_describe':
        content = memoryDescribe(agentId, { id: args.id as string });
        break;
      case 'memory_expand':
        content = await memoryExpand(agentId, {
          query: args.query as string | undefined,
          summary_ids: args.summary_ids as string[] | undefined,
          prompt: args.prompt as string,
        });
        break;
      case 'memory_search':
        content = await memorySearch(agentId, {
          query: args.query as string,
          limit: args.limit as number | undefined,
        });
        break;

      // ── Web Tools ──
      case 'web_search':
        content = await webSearch(agentId, {
          query: args.query as string,
          count: args.count as number | undefined,
        });
        isError = content.startsWith('Permission denied') || content.startsWith('Web search failed');
        break;
      case 'web_fetch':
        content = await webFetch(agentId, {
          url: args.url as string,
          maxTokens: args.maxTokens as number | undefined,
        });
        isError = content.startsWith('Permission denied') || content.startsWith('Fetch failed');
        break;

      // ── Multi-Agent Tools ──
      case 'spawn_agent': {
        // If the agent is passing custom permissions, check can_assign_permissions
        if (args.permissions) {
          const parentPerms = (await import('./permissions.js')).getAgentPermissions(agentId);
          if (!parentPerms.can_assign_permissions) {
            content = 'Permission denied: this agent cannot assign permissions to sub-agents. Spawn without custom permissions, or ask a user to grant "Assign Permissions" access.';
            isError = true;
            auditLog(agentId, 'spawn_agent', null, 'denied', 'can_assign_permissions is false');
            break;
          }
        }
        const result = await spawnAgent({
          parentId: agentId,
          name: args.name as string,
          systemPrompt: args.system_prompt as string,
          modelId: args.model_id as string | undefined,
          permissions: args.permissions as Parameters<typeof spawnAgent>[0]['permissions'],
          toolsPolicy: args.tools as { allow: string[]; deny: string[] } | undefined,
          timeout: args.timeout as number | undefined,
          taskId: args.task_id as string | undefined,
          contextHints: args.context_hints as string[] | undefined,
          persist: args.persist as boolean | undefined,
          classification: args.classification as 'ronin' | 'apprentice' | undefined,
          shareUserProfile: args.share_user_profile as boolean | undefined,
          groupId: args.group_id as string | undefined,
          initialMessage: args.initial_message as string | undefined,
          equippedTechniques: args.techniques as string[] | undefined,
        });
        content = `Agent spawned successfully.\nAgent ID: ${result.agentId}\nName: ${result.name}\nStatus: ${result.status}\nPersistent: ${result.persist ? 'yes' : 'no'}`;
        break;
      }
      case 'kill_agent': {
        const targetId = args.agent_id as string;
        // Check classification before terminating
        const killDb = getDb();
        const targetAgent = killDb.prepare('SELECT classification FROM agents WHERE id = ?').get(targetId) as { classification: string } | undefined;
        if (targetAgent?.classification === 'sensei') {
          content = 'Cannot terminate sensei agent.';
          isError = true;
          break;
        }
        if (targetAgent?.classification === 'ronin') {
          content = 'Cannot terminate ronin agent. Only David can manage ronin agents from the dashboard.';
          isError = true;
          break;
        }
        terminateAgent(targetId, `Killed by agent ${agentId}`);
        content = `Agent ${targetId} has been terminated.`;
        break;
      }
      case 'send_to_agent': {
        const agentRef = args.agent as string;
        const message = args.message as string;
        const db = getDb();

        // Look up by ID first, then by name
        let target = db.prepare('SELECT id, name, status FROM agents WHERE id = ?').get(agentRef) as { id: string; name: string; status: string } | undefined;
        if (!target) {
          target = db.prepare("SELECT id, name, status FROM agents WHERE name = ? AND status NOT IN ('terminated') ORDER BY created_at DESC LIMIT 1").get(agentRef) as { id: string; name: string; status: string } | undefined;
        }

        if (!target) {
          content = `No agent found with ID or name "${agentRef}". Use spawn_agent to create a new one.`;
          isError = true;
        } else if (target.status === 'terminated') {
          content = `Agent "${target.name}" (${target.id}) is terminated. Use spawn_agent to create a new one.`;
          isError = true;
        } else {
          // Persist as a user message in the target agent's conversation
          const msgId = uuidv4();
          db.prepare(`
            INSERT INTO messages (id, agent_id, role, content, created_at)
            VALUES (?, ?, 'user', ?, datetime('now'))
          `).run(msgId, target.id, message);

          // Broadcast so the target agent's chat view updates
          broadcast({
            type: 'chat:message',
            agentId: target.id,
            message: {
              id: msgId,
              agentId: target.id,
              role: 'user' as const,
              content: message,
              tokenCount: null,
              modelId: null,
              cost: null,
              latencyMs: null,
              createdAt: new Date().toISOString(),
            },
          });

          // Trigger the target agent's runtime
          const runtime = getAgentRuntime();
          runtime.handleMessage(target.id, message).catch(err => {
            logger.error('send_to_agent: target agent runtime failed', {
              targetId: target!.id,
              error: err instanceof Error ? err.message : String(err),
            }, agentId);
          });

          content = `Message sent to agent "${target.name}" (${target.id}). Status: ${target.status}.`;
        }
        break;
      }
      case 'complete_task': {
        await completeAgent(
          agentId,
          args.status as 'complete' | 'fallen' | 'blocked',
          args.summary as string,
          args.results as string | undefined,
        );
        content = `Task completion reported: ${args.status}. Agent will be terminated.`;
        break;
      }

      // ── Tracker Tools ──
      case 'tracker_create_project': {
        const taskInputs = (args.tasks as Array<Record<string, unknown>> | undefined)?.map(t => ({
          title: t.title as string,
          description: t.description as string | undefined,
          assignedTo: (t.assigned_to ?? t.assignedTo) as string | undefined,
          priority: t.priority as 'high' | 'normal' | 'low' | undefined,
          stepNumber: (t.step_number ?? t.stepNumber) as number | undefined,
          dependsOn: (t.depends_on ?? t.dependsOn) as string[] | undefined,
          phase: t.phase as number | undefined,
        }));
        content = trackerCreateProject(agentId, {
          title: args.title as string,
          description: args.description as string | undefined,
          level: args.level as number,
          tasks: taskInputs,
        });
        isError = content.startsWith('Error');
        break;
      }
      case 'tracker_create_task':
        content = trackerCreateTask(agentId, {
          projectId: args.project_id as string | undefined,
          title: args.title as string,
          description: args.description as string | undefined,
          assignedTo: args.assigned_to as string | undefined,
          priority: args.priority as string | undefined,
          stepNumber: args.step_number as number | undefined,
          dependsOn: args.depends_on as string[] | undefined,
          phase: args.phase as number | undefined,
          // Schedule parameters
          scheduled_start: args.scheduled_start as string | undefined,
          repeat_interval: args.repeat_interval as number | undefined,
          repeat_unit: args.repeat_unit as string | undefined,
          repeat_end_type: args.repeat_end_type as string | undefined,
          repeat_end_value: args.repeat_end_value as string | undefined,
          // Group assignment
          assigned_to_group: args.assigned_to_group as string | undefined,
        });
        isError = content.startsWith('Error');
        break;
      case 'tracker_update_status': {
        const updateArgs: Record<string, unknown> = {
          taskId: args.task_id as string,
          status: args.status as string,
        };
        if (args.notes) updateArgs.notes = args.notes;
        content = trackerUpdateStatus(agentId, updateArgs);
        isError = content.startsWith('Error');
        break;
      }
      case 'tracker_add_notes':
        content = trackerAddNotes(agentId, {
          taskId: args.task_id as string,
          notes: args.notes as string,
        });
        isError = content.startsWith('Error');
        break;
      case 'tracker_get_status': {
        // The tool takes a single 'id' param — try as task first, then project
        const lookupId = args.id as string;
        content = trackerGetStatus(agentId, { taskId: lookupId, projectId: lookupId });
        isError = content.startsWith('Error');
        break;
      }
      case 'tracker_list_active':
        content = trackerListActive(agentId, {
          scope: args.filter === 'all' || !args.filter ? 'all' : 'all',
        });
        isError = content.startsWith('Error');
        break;
      case 'tracker_complete_step':
        content = trackerCompleteStep(agentId, {
          taskId: args.task_id as string,
          notes: args.notes as string | undefined,
        });
        isError = content.startsWith('Error');
        break;

      // ── Schedule Tools (Phase 6) ──
      case 'tracker_pause_schedule':
        content = trackerPauseSchedule(agentId, { taskId: args.task_id as string });
        isError = content.startsWith('Error');
        break;
      case 'tracker_resume_schedule':
        content = trackerResumeSchedule(agentId, { taskId: args.task_id as string });
        isError = content.startsWith('Error');
        break;
      case 'get_current_time': {
        const now = new Date();
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        content = JSON.stringify({
          datetime: now.toISOString().replace('Z', '') + (now.toTimeString().match(/([+-]\d{4})/)?.[1] ?? ''),
          timezone: tz,
          utc: now.toISOString(),
          local: now.toLocaleString(),
        });
        break;
      }

      // ── Group Tools (Phase 6) ──
      case 'create_agent_group': {
        const group = createGroup(
          args.name as string,
          args.description as string,
          agentId,
        );
        content = `Group created: "${group.name}" (ID: ${group.id})`;
        break;
      }
      case 'assign_to_group': {
        const assignResult = assignAgentToGroup(args.agent_id as string, args.group_id as string);
        if (!assignResult.ok) {
          content = `Error: ${assignResult.error}`;
          isError = true;
        } else {
          content = `Agent ${args.agent_id} assigned to group ${args.group_id}`;
        }
        break;
      }
      case 'list_agents': {
        const listDb = getDb();
        const includeTerminated = args.include_terminated as boolean | undefined;
        const statusFilter = includeTerminated ? '' : "AND status != 'terminated'";
        const agentRows = listDb.prepare(`
          SELECT a.id, a.name, a.status, a.classification, a.group_id,
                 g.name as group_name
          FROM agents a
          LEFT JOIN agent_groups g ON g.id = a.group_id
          WHERE 1=1 ${statusFilter}
          ORDER BY a.name ASC
        `).all() as Array<Record<string, unknown>>;
        content = agentRows.map(a =>
          `- ${a.name} (ID: ${a.id}) — ${a.status}, ${a.classification}${a.group_name ? `, group: ${a.group_name}` : ''}`
        ).join('\n') || 'No agents found.';
        break;
      }
      case 'list_models': {
        const modelDb = getDb();
        const modelRows = modelDb.prepare(`
          SELECT m.id, m.name, m.api_model_id, p.name as provider_name, p.type as provider_type,
                 m.input_cost_per_m, m.output_cost_per_m, m.context_window
          FROM models m
          JOIN providers p ON p.id = m.provider_id
          WHERE m.is_enabled = 1
          ORDER BY COALESCE(m.input_cost_per_m, 0) ASC
        `).all() as Array<Record<string, unknown>>;
        content = modelRows.map(m => {
          const inputCost = (m.input_cost_per_m as number) ?? 0;
          const outputCost = (m.output_cost_per_m as number) ?? 0;
          const costStr = inputCost === 0 && outputCost === 0
            ? 'FREE (local)'
            : `$${inputCost}/M in, $${outputCost}/M out`;
          const ctx = m.context_window ? `${Math.round((m.context_window as number) / 1000)}k ctx` : '';
          return `- ${m.name} (ID: ${m.id}) — ${m.provider_name} (${m.provider_type}), ${costStr}${ctx ? ', ' + ctx : ''}`;
        }).join('\n') || 'No enabled models found.';
        break;
      }
      case 'list_groups': {
        const { getGroups: listAllGroups } = await import('./groups.js');
        const allGroups = listAllGroups();
        content = allGroups.map(g =>
          `- ${g.name} (ID: ${g.id}) — ${g.memberCount} member(s)${g.description ? `: ${g.description}` : ''}`
        ).join('\n') || 'No groups found.';
        break;
      }
      case 'delete_group': {
        const groupId = args.group_id as string;
        if (!groupId) { content = 'Error: group_id is required'; isError = true; break; }

        const { deleteGroup: doDeleteGroup, SYSTEM_GROUP_ID: SYS_GROUP } = await import('./groups.js');
        if (groupId === SYS_GROUP) {
          content = 'Cannot delete the System group.';
          isError = true;
          break;
        }

        // Optionally terminate all members first
        if (args.terminate_members) {
          const groupDb = getDb();
          const members = groupDb.prepare("SELECT id, name, classification FROM agents WHERE group_id = ? AND status != 'terminated'").all(groupId) as Array<{ id: string; name: string; classification: string }>;
          const terminated: string[] = [];
          for (const member of members) {
            if (member.classification === 'sensei' || member.classification === 'ronin') continue;
            terminateAgent(member.id, `Group deleted by agent ${agentId}`);
            terminated.push(member.name);
          }
          if (terminated.length > 0) {
            logger.info('Terminated group members before deletion', { groupId, terminated });
          }
        }

        const deleted = doDeleteGroup(groupId);
        if (deleted) {
          content = `Group ${groupId} deleted.${args.terminate_members ? ' Member agents terminated.' : ' Remaining agents moved to ungrouped.'}`;
        } else {
          content = `Failed to delete group ${groupId}. It may not exist.`;
          isError = true;
        }
        break;
      }
      case 'tracker_reassign_task': {
        const reassignTaskId = args.task_id as string;
        if (!reassignTaskId) { content = 'Error: task_id is required'; isError = true; break; }
        const reassignDb = getDb();
        const reassignTask = reassignDb.prepare('SELECT id, title FROM tasks WHERE id = ?').get(reassignTaskId) as { id: string; title: string } | undefined;
        if (!reassignTask) { content = `Error: Task not found: ${reassignTaskId}`; isError = true; break; }
        const newAgent = args.assigned_to as string | undefined;
        const newGroup = args.assigned_to_group as string | undefined;
        if (newAgent) {
          reassignDb.prepare("UPDATE tasks SET assigned_to = ?, assigned_to_group = NULL, updated_at = datetime('now') WHERE id = ?").run(newAgent, reassignTaskId);
          // Resolve name for response
          const agentName = (reassignDb.prepare('SELECT name FROM agents WHERE id = ?').get(newAgent) as { name: string } | undefined)?.name ?? newAgent;
          content = `Task "${reassignTask.title}" reassigned to ${agentName}`;
        } else if (newGroup) {
          reassignDb.prepare("UPDATE tasks SET assigned_to = NULL, assigned_to_group = ?, updated_at = datetime('now') WHERE id = ?").run(newGroup, reassignTaskId);
          const groupName = (reassignDb.prepare('SELECT name FROM agent_groups WHERE id = ?').get(newGroup) as { name: string } | undefined)?.name ?? newGroup;
          content = `Task "${reassignTask.title}" reassigned to group "${groupName}" — PM will pick an agent at run time`;
        } else {
          content = 'Error: Provide either assigned_to (agent ID) or assigned_to_group (group ID)';
          isError = true;
        }
        break;
      }

      case 'update_agent_permissions': {
        // Check if caller has can_assign_permissions
        const callerPerms = getAgentPermissions(agentId);
        if (!callerPerms.can_assign_permissions) {
          content = 'Permission denied: you do not have permission to change other agents\' permissions.';
          isError = true;
          break;
        }
        const targetAgentId = args.agent_id as string;
        const newPerms = args.permissions as Record<string, unknown>;
        if (!targetAgentId || !newPerms) {
          content = 'Error: agent_id and permissions are required';
          isError = true;
          break;
        }
        const permDb = getDb();
        // Merge with existing permissions
        const existingPermsRow = permDb.prepare('SELECT permissions FROM agents WHERE id = ?').get(targetAgentId) as { permissions: string } | undefined;
        if (!existingPermsRow) {
          content = `Error: Agent not found: ${targetAgentId}`;
          isError = true;
          break;
        }
        const existingPerms = JSON.parse(existingPermsRow.permissions || '{}');
        const merged = { ...existingPerms, ...newPerms };
        permDb.prepare("UPDATE agents SET permissions = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(merged), targetAgentId);
        const agentNameRow = permDb.prepare('SELECT name FROM agents WHERE id = ?').get(targetAgentId) as { name: string } | undefined;
        content = `Permissions updated for ${agentNameRow?.name ?? targetAgentId}. Changed: ${Object.keys(newPerms).join(', ')}`;
        break;
      }

      // ── System Control Tools (Phase 5A) ──
      case 'mouse_click':
        content = mouseClick(agentId, {
          x: args.x as number,
          y: args.y as number,
          click_type: args.click_type as string | undefined,
        });
        isError = content.startsWith('Error');
        break;
      case 'mouse_move':
        content = mouseMove(agentId, {
          x: args.x as number,
          y: args.y as number,
        });
        isError = content.startsWith('Error');
        break;
      case 'keyboard_type':
        content = keyboardType(agentId, {
          text: args.text as string | undefined,
          key_combo: args.key_combo as string | undefined,
        });
        isError = content.startsWith('Error');
        break;
      case 'screen_read':
        content = await screenRead(agentId, {
          region: args.region as { x: number; y: number; width: number; height: number } | undefined,
          query: args.query as string | undefined,
        });
        isError = content.startsWith('Error');
        break;
      case 'applescript_run':
        content = applescriptRun(agentId, { script: args.script as string });
        isError = content.startsWith('AppleScript error');
        break;

      // ── Headless Browser (Phase 5B) ──
      case 'web_browse':
        content = await executeWebBrowse(agentId, {
          action: args.action as string,
          url: args.url as string | undefined,
          selector: args.selector as string | undefined,
          text: args.text as string | undefined,
          scroll_direction: args.scroll_direction as string | undefined,
          scroll_amount: args.scroll_amount as number | undefined,
        });
        isError = content.startsWith('Error');
        break;

      // ── iMessage Tool ──
      case 'imessage_send': {
        let recipient = args.recipient as string | undefined;
        const message = args.message as string;

        if (!recipient) {
          const defaultSender = getDefaultSender();
          if (!defaultSender) {
            content = 'Error: No default sender configured and no recipient specified';
            isError = true;
            break;
          }
          recipient = defaultSender;
        }

        // PM agent can only send to approved senders
        if (isPMAgent(agentId)) {
          const approved = getApprovedSenders();
          if (!approved.includes(recipient)) {
            auditLog(agentId, 'imessage_send', recipient, 'denied', 'PM agent can only send to approved senders');
            content = `Permission denied: This agent can only send to approved senders. "${recipient}" is not on the approved list.`;
            isError = true;
            break;
          }
        }

        sendIMessage(recipient, message);
        auditLog(agentId, 'imessage_send', recipient, 'success', `Sent ${message.length} chars`);
        content = `iMessage sent to ${recipient}`;
        break;
      }

      // ── Technique Tools ──
      case 'save_technique': {
        const { executeSaveTechnique } = await import('../techniques/tools.js');
        const agentRow = getDb().prepare('SELECT name, classification FROM agents WHERE id = ?').get(agentId) as { name: string; classification: string } | undefined;
        content = executeSaveTechnique(agentId, agentRow?.name ?? agentId, agentRow?.classification ?? 'apprentice', args);
        isError = content.startsWith('Error') || content.startsWith('Only');
        break;
      }
      case 'use_technique': {
        const { executeUseTechnique } = await import('../techniques/tools.js');
        const agentRow2 = getDb().prepare('SELECT name, group_id FROM agents WHERE id = ?').get(agentId) as { name: string; group_id: string | null } | undefined;
        content = executeUseTechnique(agentId, agentRow2?.name ?? agentId, agentRow2?.group_id ?? null, args);
        isError = content.startsWith('Error');
        break;
      }
      case 'list_techniques': {
        const { executeListTechniques } = await import('../techniques/tools.js');
        const agentRow3 = getDb().prepare('SELECT classification FROM agents WHERE id = ?').get(agentId) as { classification: string } | undefined;
        content = executeListTechniques(agentId, agentRow3?.classification ?? 'apprentice', args);
        break;
      }
      case 'publish_technique': {
        const { executePublishTechnique } = await import('../techniques/tools.js');
        const agentRow4 = getDb().prepare('SELECT classification FROM agents WHERE id = ?').get(agentId) as { classification: string } | undefined;
        content = executePublishTechnique(agentId, agentRow4?.classification ?? 'apprentice', args);
        isError = content.startsWith('Error') || content.startsWith('Only');
        break;
      }
      case 'update_technique': {
        const { executeUpdateTechnique } = await import('../techniques/tools.js');
        const agentRow5 = getDb().prepare('SELECT name, classification FROM agents WHERE id = ?').get(agentId) as { name: string; classification: string } | undefined;
        content = executeUpdateTechnique(agentId, agentRow5?.name ?? agentId, agentRow5?.classification ?? 'apprentice', args);
        isError = content.startsWith('Error') || content.startsWith('Only');
        break;
      }
      case 'submit_technique_for_review': {
        const { executeSubmitForReview } = await import('../techniques/tools.js');
        content = executeSubmitForReview(agentId, args);
        isError = content.startsWith('Error');
        break;
      }

      default:
        content = `Unknown tool: ${name}`;
        isError = true;
        auditLog(agentId, 'tool_call', name, 'error', 'Unknown tool');
    }
  } catch (err) {
    content = `Tool execution failed: ${err instanceof Error ? err.message : String(err)}`;
    isError = true;
    auditLog(agentId, 'tool_call', name, 'error', content);
  }

  // Large file interception: replace oversized tool output with exploration summary
  if (!isError && shouldIntercept(content)) {
    const originalPath = name === 'file_read' ? (args.path as string) : undefined;
    const { replacement } = interceptLargeFile(agentId, content, originalPath);
    content = replacement;
  }

  return {
    toolCallId: id,
    name,
    content,
    isError,
  };
}
