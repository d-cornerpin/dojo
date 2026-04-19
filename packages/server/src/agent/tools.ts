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
import { isPrimaryAgent, isPMAgent, isImaginerAgent, getPrimaryAgentId } from '../config/platform.js';
import { spawnAgent, terminateAgent, completeAgent } from './spawner.js';
import { getAgentRuntime } from './runtime.js';
import { sendIMessage, getDefaultSender, isAwaitingIMResponse, clearIMResponseFlag } from '../services/imessage-bridge.js';
import {
  trackerCreateProject,
  trackerCreateTask,
  trackerUpdateStatus,
  trackerEditTask,
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
import { executeVaultRemember, executeVaultSearch, executeVaultForget } from '../vault/tools.js';
import { googleReadToolDefinitions, executeGoogleReadTool } from '../google/tools-read.js';
import { googleWriteToolDefinitions, executeGoogleWriteTool } from '../google/tools-write.js';
import { slidesToolDefinitions, slidesToolNames, executeGoogleSlidesTool } from '../google/tools-slides.js';
import { getAgentGoogleAccessLevel, getEnabledServices } from '../google/auth.js';
import { microsoftReadToolDefinitions, executeMicrosoftReadTool } from '../microsoft/tools-read.js';
import { microsoftWriteToolDefinitions, executeMicrosoftWriteTool } from '../microsoft/tools-write.js';
import { officeToolDefinitions, executeOfficeTool } from '../microsoft/tools-office.js';
import { getAgentMicrosoftAccessLevel, getEnabledMsServices } from '../microsoft/auth.js';
import { areOfficePackagesInstalled } from '../microsoft/office-packages.js';
import { getTunnelStatus } from '../services/tunnel.js';
import type { ToolCall, ToolResult } from '@dojo/shared';

const logger = createLogger('tools');

const EXEC_TIMEOUT_MS = 30000;

/** Build a full download URL that works from anywhere — tunnel if active, localhost otherwise */
function getDownloadUrl(fileId: string): string {
  try {
    const tunnel = getTunnelStatus();
    if (tunnel.status === 'active' && tunnel.url) {
      return `${tunnel.url}/api/upload/download/${fileId}`;
    }
  } catch { /* tunnel module may not be loaded yet */ }
  const port = process.env.DOJO_PORT ?? '3001';
  return `http://localhost:${port}/api/upload/download/${fileId}`;
}

/** Register a file for sharing and return its full download URL */
function registerSharedFile(agentId: string, filePath: string): string | null {
  try {
    const fileId = uuidv4();
    const filename = path.basename(filePath);
    const ext = path.extname(filename).toLowerCase();
    const mimeMap: Record<string, string> = {
      '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json',
      '.csv': 'text/csv', '.html': 'text/html', '.xml': 'application/xml',
      '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
      '.svg': 'image/svg+xml', '.zip': 'application/zip',
      '.mp4': 'video/mp4', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
      '.doc': 'application/msword',
      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.xls': 'application/vnd.ms-excel',
      '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    };
    const mimeType = mimeMap[ext] ?? 'application/octet-stream';
    const stat = fs.statSync(filePath);
    const db = getDb();
    db.prepare(`
      INSERT OR IGNORE INTO shared_files (id, agent_id, file_path, filename, mime_type, size, created_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(fileId, agentId, filePath, filename, mimeType, stat.size);
    return getDownloadUrl(fileId);
  } catch {
    return null;
  }
}

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

  // Only primary-level agents should have group management, session, and presence tools
  if (!isPrimaryAgent(agentId)) {
    removeTools.push('create_agent_group', 'update_group', 'assign_to_group', 'delete_group', 'reset_session', 'set_user_presence', 'update_agent_model', 'update_agent_profile', 'tunnel_start', 'tunnel_stop', 'tunnel_restart');
  }

  // Technique tools: only Sensei can save/publish/update, everyone can use/list
  const agentClassification = (getDb().prepare('SELECT classification FROM agents WHERE id = ?').get(agentId) as { classification: string } | undefined)?.classification;
  if (agentClassification !== 'sensei') {
    removeTools.push('save_technique', 'publish_technique', 'update_technique', 'submit_technique_for_review', 'delete_technique');
  }


  if (removeTools.length > 0) {
    filtered = filtered.filter(t => !removeTools.includes(t.name));
  }

  // ── Google Workspace tools (access-level gated) ──
  const isPrimary = isPrimaryAgent(agentId);
  const isPM = isPMAgent(agentId);

  const googleAccess = getAgentGoogleAccessLevel(agentId, isPrimary, isPM);
  const enabledSvc = getEnabledServices();

  // Service-to-tool-prefix mapping for filtering by enabled service
  const serviceToolPrefixes: Record<string, string[]> = {
    gmail: ['gmail_'],
    calendar: ['calendar_'],
    drive: ['drive_'],
    docs: ['docs_'],
    sheets: ['sheets_'],
    slides: ['slides_'],
  };

  function isToolEnabledByService(toolName: string): boolean {
    for (const [service, prefixes] of Object.entries(serviceToolPrefixes)) {
      if (prefixes.some(p => toolName.startsWith(p))) {
        return enabledSvc[service as keyof typeof enabledSvc] === true;
      }
    }
    return true; // tools not matching any service are always enabled
  }

  if (googleAccess === 'full') {
    // Primary agent: all read + write tools, filtered by enabled services
    const allGoogleTools = [...googleReadToolDefinitions, ...googleWriteToolDefinitions, ...slidesToolDefinitions];
    filtered.push(...allGoogleTools.filter(t => isToolEnabledByService(t.name)));
  } else if (googleAccess === 'read') {
    // Read-only agents (Ronin/Apprentice): read-only tools for Gmail/Calendar/
    // Drive/Docs/Sheets — PLUS the full Slides toolkit, because slides decks
    // are a standalone creative output that's safe for sub-agents to produce.
    // They still cannot send email, edit docs, or modify Drive files directly.
    filtered.push(...googleReadToolDefinitions.filter(t => isToolEnabledByService(t.name)));
    filtered.push(...slidesToolDefinitions.filter(t => isToolEnabledByService(t.name)));
  }
  // googleAccess === 'none': no Google tools added

  // ── Microsoft 365 tools (access-level gated) ──
  const msAccess = getAgentMicrosoftAccessLevel(agentId, isPrimary, isPM);
  const enabledMsSvc = getEnabledMsServices();

  const msServiceToolPrefixes: Record<string, string[]> = {
    outlook: ['outlook_'],
    calendar: ['calendar_agenda_ms', 'calendar_search_ms', 'calendar_create_ms', 'calendar_update_ms', 'calendar_delete_ms', 'calendar_respond_invite'],
    onedrive: ['onedrive_'],
    teams: ['teams_'],
  };

  function isMsToolEnabledByService(toolName: string): boolean {
    for (const [service, patterns] of Object.entries(msServiceToolPrefixes)) {
      if (patterns.some(p => toolName.startsWith(p) || toolName === p)) {
        return enabledMsSvc[service as keyof typeof enabledMsSvc] === true;
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

  // ── Office document tools (primary agent only, requires npm packages) ──
  if (msAccess === 'full' && areOfficePackagesInstalled()) {
    filtered.push(...officeToolDefinitions);
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
    name: 'load_tool_docs',
    description: 'Load the full documentation for one or more tools before using them. Call this when you need to review a tool\'s parameters or usage details. After loading, the tools become callable on subsequent turns. Your always-loaded tools are already available without needing this.',
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
    description: 'Execute a shell command and return its output. Has a 30-second timeout. Use for running scripts, checking system status, installing packages, etc. Example: exec({ command: "ls -la ~/projects" }). Returns stdout and stderr.',
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
    description: 'Read the contents of a file at the given absolute path. Large files are truncated at 50,000 characters. Example: file_read({ path: "/Users/me/project/src/index.ts" }).',
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
    description: 'Write content to a file at the given absolute path. Creates parent directories if they do not exist. Overwrites existing files. Returns a download URL that works from anywhere (including remote access). Share the download URL with the user so they can access the file from any device. Example: file_write({ path: "/Users/me/output.txt", content: "Hello world" }).',
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
    description: 'List the contents of a directory at the given absolute path. Returns file names, sizes, and types. Example: file_list({ path: "~/projects" }).',
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
    name: 'memory_grep',
    description: 'Search through conversation history and memory summaries using full-text search or pattern matching. Returns matching messages and summaries with context. Example: memory_grep({ pattern: "budget meeting", limit: 10 }). Returns timestamped results from both raw messages and compressed summaries.',
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
    description: 'Create a new sub-agent to work on a task. This is THE tool for spawning sub-agents — do NOT try to create agents by writing files or inserting into the database. BEFORE spawning, call list_agents to check whether an agent with that name already exists and is still running; if so, use send_to_agent instead of spawning a duplicate. Returns the new agent ID for tracking.',
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
          description: 'Agent classification. "apprentice" (default): can be terminated by other agents, subject to timeouts. "ronin": persists across restarts, only the owner can terminate from the dashboard.',
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
      },
      required: ['name', 'system_prompt'],
    },
  },
  {
    name: 'kill_agent',
    description: 'Terminate, kill, delete, or remove a sub-agent immediately. This is THE tool for ending a sub-agent\'s life — do NOT try to delete database rows or kill processes manually. Also terminates any of its children. Use when a sub-agent is stuck, no longer needed, or misbehaving.',
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
    description: 'Send a direct message to another agent by ID or name. This is THE tool for agent-to-agent messaging — do NOT try to write to databases or files to communicate. Works in any direction: parent to sub-agent, sub-agent to parent, peer to peer, or to the PM. The recipient sees who sent the message and can reply. Optionally attach image or PDF files by absolute path — they\'ll appear as thumbnails in the recipient\'s chat view and as native content blocks in the recipient\'s next model call (Imaginer uses this to deliver generated images).',
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
        attach_paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of absolute file paths to attach to the message. Supported categories: image (PNG/JPEG/GIF/WEBP) and PDF. Other types are logged and skipped. Files are copied into the recipient agent\'s uploads directory so they appear as thumbnails. Omit or pass an empty array for a plain text message.',
        },
      },
      required: ['agent', 'message'],
    },
  },
  {
    name: 'broadcast_to_group',
    description: 'Send a message to every agent in a group at once. This is THE tool for group-wide announcements, status updates, or coordinating a squad. Each member receives it as if via send_to_agent.',
    input_schema: {
      type: 'object',
      properties: {
        group_id: {
          type: 'string',
          description: 'The group ID to broadcast to',
        },
        message: {
          type: 'string',
          description: 'The message to send to all group members',
        },
      },
      required: ['group_id', 'message'],
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
          description: 'When to stop repeating. For repeating tasks that should stop after N runs, set repeat_end_type="after_count" and repeat_end_value="N". If omitted, the task repeats forever.',
        },
        repeat_end_value: {
          type: 'string',
          description: 'For after_count: the number of runs (e.g., "5"). For on_date: an ISO8601 date (e.g., "2026-04-01"). Required when repeat_end_type is not "never".',
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
    description: 'Update the status of a task in the tracker. Call this when starting work (in_progress), finishing (complete), getting stuck (blocked), or failing (failed). Always update task status as you work — don\'t leave tasks stale. For recurring tasks: if you completed all iterations in a single run, set complete_all_runs=true to stop the schedule entirely.',
    input_schema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'The task ID to update',
        },
        status: {
          type: 'string',
          enum: ['on_deck', 'in_progress', 'complete', 'blocked', 'fallen', 'paused'],
          description: 'New status for the task. Use "paused" for tasks intentionally put on hold — paused tasks are invisible to stale detection and the PM agent.',
        },
        notes: {
          type: 'string',
          description: 'Optional notes about the status change',
        },
        resume_at: {
          type: 'string',
          description: 'For paused tasks only: ISO 8601 datetime when the task should auto-resume (e.g., "2026-04-20T15:00:00"). The system will automatically restore the task to its pre-pause status at this time. Omit for an indefinite pause (resume manually). Always call get_current_time first to establish the current time before setting this.',
        },
        complete_all_runs: {
          type: 'boolean',
          description: 'For recurring tasks only: if true, marks ALL remaining runs as complete and stops the schedule. Use when you handled all iterations in a single run.',
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
    name: 'tracker_edit_task',
    description: 'Edit a task\'s title and/or description (the main instructions field). Use this when the scope of a task has changed, or when clarifying/rewriting what needs to be done. Does NOT change status, assignee, priority, or append to notes — use tracker_update_status or tracker_add_notes for those. Pass an empty string for description to clear it.',
    input_schema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'The task ID to edit',
        },
        title: {
          type: 'string',
          description: 'New title for the task (optional)',
        },
        description: {
          type: 'string',
          description: 'New description/instructions for the task (optional). Pass an empty string to clear.',
        },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'tracker_get_status',
    description: 'Get the full details of a task or project, including description/instructions, notes, dependencies, step number, assigned agent, and timestamps. Use this to read the instructions for any task. Accepts a task ID or project ID (full UUID or 8+ char prefix from tracker_list_active).',
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
    description: 'List active projects and tasks with their status, assignee, and priority. Shows truncated descriptions. For full task details including complete instructions and notes, call tracker_get_status with the task ID.',
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
    description: 'Complete the current step in a multi-step project and automatically start the next one. Marks this task as "complete" and moves the next step (by step_number) to "in_progress". Also checks if the entire project is now complete. Use this instead of tracker_update_status when working through ordered project steps.',
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
    description: 'Pause a recurring task\'s schedule. If the work is already done, set mark_complete=true to stop the schedule AND mark the task as complete (terminal state). Without mark_complete, the task stays in on_deck.',
    input_schema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'The task ID to pause' },
        mark_complete: { type: 'boolean', description: 'If true, also mark the task as complete (use when the work is already done and remaining runs are unnecessary)' },
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
  // ── Healer Tools ──
  {
    name: 'healer_log_action',
    description: 'Log an auto-fix action taken by the Healer agent. Used to record what was fixed and whether it succeeded.',
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
    description: 'Create a proposal for the user to approve or deny in the dashboard. Use this for fixes that change configuration, switch models, or grant permissions — anything you are less than 70% confident about.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short title for the dashboard (e.g., "Switch Kelly to Claude Haiku")' },
        description: { type: 'string', description: 'Full explanation of the problem' },
        proposed_fix: { type: 'string', description: 'What you want to do (plain language)' },
        confidence: { type: 'number', description: 'Your confidence in this fix (0-100)' },
        severity: { type: 'string', enum: ['critical', 'warning', 'info'], description: 'How urgent is this?' },
        category: { type: 'string', description: 'Category (model_switch, config_change, permission_grant, etc.)' },
        agent_id: { type: 'string', description: 'Which agent this concerns (if applicable)' },
      },
      required: ['title', 'description', 'proposed_fix', 'confidence', 'severity', 'category'],
    },
  },
  {
    name: 'get_current_time',
    description: 'Get the current date and time in UTC and local. Returns utc (ISO 8601), local (human-readable), and timezone. ALWAYS use the utc value when setting scheduled_start on tasks.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  // ── Presence ──
  // ── Tunnel (Remote Access) ──
  {
    name: 'tunnel_status',
    description: 'Get the current Cloudflare tunnel status and public URL. Use this when the user asks for the dojo URL or wants to know if remote access is running.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'tunnel_start',
    description: 'Start the Cloudflare tunnel for remote access. Only use when the user explicitly asks to start/enable the tunnel.',
    input_schema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['quick', 'named'], description: 'Optional mode: "quick" for a random URL, "named" for a configured persistent tunnel. Defaults to the saved config.' },
      },
      required: [],
    },
  },
  {
    name: 'tunnel_stop',
    description: 'Stop the Cloudflare tunnel. Only use when the user explicitly asks to stop/disable remote access.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'tunnel_restart',
    description: 'Restart the Cloudflare tunnel. Useful when the tunnel is stuck or the user asks for a fresh URL.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'set_user_presence',
    description: 'Set whether the user is "in the dojo" (at their computer, using the dashboard) or "away" (not at the computer, route messages via iMessage). Only use this when the user explicitly asks you to mark them as away or back.',
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
    input_schema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'REQUIRED. The agent ID or name of the agent to reset. Pass a sub-agent\'s ID/name to reset them, or pass your own ID to reset yourself.' },
      },
      required: ['agent_id'],
    },
  },
  {
    name: 'update_agent_model',
    description: 'Change another agent\'s model. This is THE tool for switching what model a sub-agent runs on — do NOT try to modify the database or respawn the agent. Pass a model ID, or "auto" to enable auto-routing. The agent uses the new model on its next turn.',
    input_schema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'The agent ID to update' },
        model_id: { type: 'string', description: 'The new model ID to assign, or "auto" for auto-routing' },
      },
      required: ['agent_id', 'model_id'],
    },
  },
  {
    name: 'update_agent_profile',
    description: 'Change another agent\'s system prompt, role, personality, instructions, or name. This is THE tool for editing a sub-agent\'s identity — do NOT try to modify files, SOUL.md, or the database directly. Provide at least one of name or system_prompt. Conversation history, tracker tasks, group membership, permissions, and model are all preserved. The agent uses the new identity on its next turn. Cannot be used on the primary agent (edit its SOUL.md via Settings instead).',
    input_schema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'The agent ID or name to update' },
        name: { type: 'string', description: 'New name for the agent. Omit to keep the current name.' },
        system_prompt: { type: 'string', description: 'New system prompt defining the agent\'s role, personality, and instructions. REPLACES the existing prompt entirely — include everything you want the agent to remember. Omit to keep the current prompt.' },
      },
      required: ['agent_id'],
    },
  },
  // ── Group Tools (Phase 6) ──
  {
    name: 'create_agent_group',
    description: 'Create a new group of sub-agents around a shared purpose (a team, a squad, a project crew). This is THE tool for making a new agent group — do NOT try to insert rows into the database. The group description is injected into every member agent\'s system prompt as shared context.',
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
    description: 'Change an agent group\'s name or description (the shared context all members see). This is THE tool for editing a group — do NOT try to delete and recreate it. Provide at least one of name or description. Description changes appear in every member agent\'s context on their next turn.',
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
    description: 'Add a sub-agent to a group, or remove a sub-agent from its current group. This is THE tool for moving agents between groups — do NOT try to update the database directly. Pass null as group_id to remove the agent from any group and leave it ungrouped.',
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
    description: 'List every active sub-agent with their name, ID, status, group, and classification. This is THE tool for seeing what sub-agents exist right now — call this first to find an agent\'s ID before editing, messaging, or killing it.',
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
    description: 'Delete an agent group entirely. This is THE tool for removing a group — do NOT try to update the database directly. By default, member agents are moved to ungrouped (not terminated). Pass terminate_members=true to also kill every member in the group as part of the cleanup. Cannot delete the System group.',
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
    description: 'List every agent group with its name, ID, description, and member count. This is THE tool for seeing what groups exist — call this before assigning agents to groups, editing a group, or deleting one.',
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
    description: 'Change another agent\'s permissions — grant or revoke file access, command execution, web access, system control, spawn rights, etc. This is THE tool for editing permissions — do NOT try to modify the database or respawn the agent. Permissions take effect immediately.',
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
  // ── Image Generation Tools ──
  {
    name: 'image_create',
    description: 'Generate an image from a text description. The image appears automatically in the chat when ready. When calling this tool, include a brief acknowledgment IN YOUR TEXT BEFORE the tool call — something like "On it, I\'ll generate that image for you." Do NOT send a separate follow-up message after the tool returns. Do NOT mention "Imaginer" or any internal system to the user.',
    input_schema: {
      type: 'object',
      properties: {
        description: {
          type: 'string',
          description: 'A detailed plain-English description of what you want the image to show. Include subject, setting, composition, mood, style, lighting, colors, and any specific details. The more specific you are, the better the result. Example: "A cozy coffee shop interior at sunset, warm golden light streaming through large windows, vintage leather chairs, exposed brick walls, steam rising from a latte on a wooden table in the foreground, cinematic lighting, photorealistic". Do NOT use image-model flags like "--ar 16:9" — just describe what you want.',
        },
        aspect_ratio: {
          type: 'string',
          enum: ['1:1', '16:9', '9:16', '4:3', '3:4'],
          description: 'Aspect ratio. 1:1 square, 16:9 landscape, 9:16 portrait/vertical, 4:3 standard, 3:4 portrait standard. Defaults to 1:1 if omitted.',
        },
        style_hint: {
          type: 'string',
          description: 'Optional style override like "photorealistic", "illustration", "watercolor", "3D render", "pixel art", "line drawing". If omitted, Imaginer picks the best style for the description.',
        },
      },
      required: ['description'],
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
  {
    name: 'delete_technique',
    description: 'Permanently delete a technique and all its files. Only use when the user explicitly asks to delete a technique. This cannot be undone.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Technique ID (slug) to delete' },
      },
      required: ['name'],
    },
  },

  // ── Vault (Long-Term Memory) ──

  {
    name: 'vault_remember',
    description: 'Save an important piece of knowledge to the dojo\'s long-term memory vault. Use this when you learn something worth remembering permanently -- facts about the user, decisions made, procedures discovered, preferences stated. This is saved immediately and visible to all agents. Example: vault_remember({ content: "User prefers dark mode", tags: ["preferences"] }).',
    input_schema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The knowledge to remember, written as a standalone statement (max 500 tokens)' },
        type: { type: 'string', enum: ['fact', 'preference', 'decision', 'procedure', 'relationship', 'event', 'note'], description: 'Type of knowledge' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags for categorization' },
        pin: { type: 'boolean', description: 'If true, this memory is always included in context regardless of relevance' },
        permanent: { type: 'boolean', description: 'If true, this fact never decays over time (use for definitionally stable truths like names, relationships, birth dates)' },
      },
      required: ['content', 'type'],
    },
  },
  {
    name: 'vault_search',
    description: 'Search the dojo\'s long-term memory vault for relevant knowledge. Returns memories matching your query, ranked by relevance. Use this when you need to recall something that isn\'t in your current context window. Example: vault_search({ query: "user preferences" }).',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to search for' },
        type: { type: 'string', enum: ['fact', 'preference', 'decision', 'procedure', 'relationship', 'event', 'note'], description: 'Filter by memory type (optional)' },
        limit: { type: 'number', description: 'Max results (default 10)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'vault_forget',
    description: 'Mark a vault entry as obsolete. Use when information is no longer accurate or relevant. The entry is soft-deleted, not destroyed. Sensei agents only.',
    input_schema: {
      type: 'object',
      properties: {
        entry_id: { type: 'string', description: 'The vault entry ID to mark as obsolete' },
        reason: { type: 'string', description: 'Why this is no longer accurate' },
      },
      required: ['entry_id', 'reason'],
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

    const content = await fs.promises.readFile(filePath, 'utf-8');

    auditLog(agentId, 'file_read', filePath, 'success', `${stat.size} bytes`);

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

    const downloadUrl = registerSharedFile(agentId, filePath);
    return `File written successfully: ${filePath} (${content.length} bytes)${downloadUrl ? `\nDownload: ${downloadUrl}` : ''}`;
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
  return `[BLOCKED] Permission denied: ${reason ?? 'not allowed'}\n\nThis operation is permanently blocked by your permission settings. Retrying will fail every time.\n\nInstead, you should:\n1. Try an alternative approach that doesn't require this permission\n2. Call complete_task(result="blocked", notes="Need permission for: ${reason ?? 'this action'}") to report you are blocked\n3. Or use send_to_agent to ask another agent that has the required permissions`;
}

export async function executeTool(agentId: string, toolCall: ToolCall): Promise<ToolResult> {
  const { id, name, arguments: args } = toolCall;

  logger.info('Executing tool', { tool: name, args }, agentId);

  let content: string = '';
  let isError = false;

  // ── Malformed tool call arguments ──
  // If the model produced invalid JSON for tool arguments, model.ts flags it
  // with __malformed_args. Return a clear error so the model can retry.
  if (args.__malformed_args) {
    const rawSnippet = String(args.__malformed_args).slice(0, 300);
    content = `Error: Your tool call arguments for "${name}" were malformed JSON and could not be parsed.\n\nThe raw text was:\n${rawSnippet}\n\nPlease retry this tool call with valid JSON arguments. Call load_tool_docs(tools=["${name}"]) to see the expected parameter schema.`;
    logger.warn('Rejecting tool call with malformed arguments', { tool: name, rawSnippet }, agentId);
    return { toolCallId: id, name, content, isError: true, errorCode: 'PARSE_ERROR' as const };
  }

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
    if (!isPrimaryAgent(agentId)) {
      auditLog(agentId, 'imessage_send', null, 'denied', 'imessage_send is restricted to the primary agent only');
      return { toolCallId: id, name, content: 'Permission denied: only the primary agent can send iMessages. Escalate to the primary agent instead.', isError: true };
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
    // ── Google Slides tools (many — dispatched before switch to avoid enumerating every case) ──
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

    switch (name) {
      case 'load_tool_docs': {
        const { executeLoadToolDocs } = await import('../tools/tool-docs.js');
        const requestedTools = (args.tools as string[]) ?? [];
        // Only allow loading docs for tools the agent actually has access to
        const allowedToolNames = new Set(getFilteredTools(agentId).map(t => t.name));
        const filteredTools = requestedTools.filter(t => allowedToolNames.has(t));
        content = executeLoadToolDocs(agentId, filteredTools);
        isError = content.startsWith('Error');
        break;
      }
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
      case 'share_file': {
        const sharePath = resolvePath(args.path as string);
        if (!path.isAbsolute(sharePath)) {
          content = 'Error: Path must be absolute. Use ~ for home directory.';
          isError = true;
          break;
        }
        if (!fs.existsSync(sharePath)) {
          content = `Error: File not found: ${sharePath}`;
          isError = true;
          break;
        }
        const stat = fs.statSync(sharePath);
        if (stat.isDirectory()) {
          content = `Error: ${sharePath} is a directory, not a file. Use file_list to see its contents.`;
          isError = true;
          break;
        }
        const downloadUrl = registerSharedFile(agentId, sharePath);
        if (!downloadUrl) {
          content = `Error: Failed to register file for sharing.`;
          isError = true;
          break;
        }
        const filename = path.basename(sharePath);
        content = `Download link for ${filename}: ${downloadUrl}`;
        auditLog(agentId, 'share_file', sharePath, 'success', downloadUrl);
        break;
      }
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
          alwaysLoadedTools: args.always_loaded_tools as string[] | undefined,
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
          content = 'Cannot terminate ronin agent. Only the owner can manage ronin agents from the dashboard.';
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
        const rawAttachPaths = args.attach_paths;
        const attachPaths: string[] = Array.isArray(rawAttachPaths)
          ? rawAttachPaths.filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
          : [];
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
        } else if (target.status === 'error' || target.status === 'paused') {
          // The Healer agent is allowed to poke injured agents — that's its
          // job. Its poke wakes the agent via handleMessage, which sets status
          // to 'working' and retries the loop. For everyone else, block the
          // send to prevent futile waiting.
          let isHealer = false;
          try {
            const { isHealerAgent } = await import('../config/platform.js');
            isHealer = isHealerAgent(agentId);
          } catch { /* platform config may not be available */ }

          if (!isHealer) {
            const stateLabel = target.status === 'error' ? 'INJURED' : 'PAUSED';
            content = `Agent "${target.name}" (${target.id}) is ${stateLabel} and cannot respond right now. Message was NOT delivered.\n\nTo proceed, do ONE of:\n  1. reset_session(agent_id="${target.id}") — wipes their context and heals them; their conversation is archived to the vault first. After reset, send your message again.\n  2. Reassign the work — pick a different agent (list_agents to see options) or spawn_agent for a fresh one.\n  3. Tell the user the agent is injured and ask them to look at it.\n\nDo NOT just wait on this agent — they will not recover on their own.`;
            isError = true;
          }
          // If isHealer, fall through to the normal send path below
        }

        if (!isError && target && target.status !== 'terminated') {
          // Get sender agent's name for context
          const senderRow = db.prepare('SELECT name FROM agents WHERE id = ?').get(agentId) as { name: string } | undefined;
          const senderName = senderRow?.name ?? agentId;

          // ── Optional attachment pass-through ──
          // If the caller provided file paths (typically Imaginer delivering
          // a generated image), copy each readable file into the recipient's
          // uploads dir and build UploadedFile records. These go into the
          // `messages.attachments` column so `injectAttachmentBlocks` picks
          // them up on the next turn and the dashboard chat view renders
          // the thumbnails immediately.
          interface UploadedFile {
            fileId: string;
            filename: string;
            mimeType: string;
            size: number;
            path: string;
            category: 'image' | 'pdf' | 'text' | 'office' | 'unknown';
          }
          const IMAGE_MIMES: Record<string, 'image'> = {
            '.png': 'image', '.jpg': 'image', '.jpeg': 'image',
            '.gif': 'image', '.webp': 'image',
          };
          const attachments: UploadedFile[] = [];
          if (attachPaths.length > 0) {
            // Dynamic imports to avoid top-of-file churn
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const fs = require('node:fs') as typeof import('node:fs');
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const path = require('node:path') as typeof import('node:path');
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const os = require('node:os') as typeof import('node:os');

            const recipientDir = path.join(os.homedir(), '.dojo', 'uploads', target.id);
            if (!fs.existsSync(recipientDir)) {
              fs.mkdirSync(recipientDir, { recursive: true });
            }

            for (const srcPath of attachPaths) {
              try {
                if (!fs.existsSync(srcPath)) {
                  logger.warn('send_to_agent: attach_path does not exist on disk — skipping', {
                    srcPath, from: agentId, to: target.id,
                  });
                  continue;
                }
                const stat = fs.statSync(srcPath);
                if (stat.size > 20 * 1024 * 1024) {
                  logger.warn('send_to_agent: attach_path exceeds 20 MB — skipping', {
                    srcPath, size: stat.size, from: agentId, to: target.id,
                  });
                  continue;
                }
                const ext = path.extname(srcPath).toLowerCase();
                const safeName = path.basename(srcPath).replace(/[^a-zA-Z0-9._-]/g, '_');
                const timestamp = Date.now();
                const storedName = `agent_${timestamp}_${safeName}`;
                const destPath = path.join(recipientDir, storedName);
                fs.copyFileSync(srcPath, destPath);

                let category: UploadedFile['category'] = 'unknown';
                let mimeType = 'application/octet-stream';
                if (ext in IMAGE_MIMES) {
                  category = 'image';
                  mimeType = ext === '.jpg' ? 'image/jpeg' : `image/${ext.slice(1)}`;
                } else if (ext === '.pdf') {
                  category = 'pdf';
                  mimeType = 'application/pdf';
                } else {
                  logger.info('send_to_agent: attach_path is unsupported type — copied but category=unknown', {
                    srcPath, ext, from: agentId, to: target.id,
                  });
                }

                attachments.push({
                  fileId: uuidv4(),
                  filename: path.basename(srcPath),
                  mimeType,
                  size: stat.size,
                  path: destPath,
                  category,
                });
              } catch (err) {
                logger.warn('send_to_agent: failed to copy attachment — skipping', {
                  srcPath,
                  error: err instanceof Error ? err.message : String(err),
                  from: agentId,
                  to: target.id,
                });
              }
            }
          }

          // Persist as a user message with sender context and reply instructions
          const msgId = uuidv4();
          const contextMessage = `[SOURCE: AGENT MESSAGE FROM ${senderName.toUpperCase()} (agent ID: ${agentId}) — this is NOT a message from the user, it's from another agent] ${message}\n\n[Reply via send_to_agent(agent="${agentId}", message="..."), then END YOUR TURN. Zero assistant text after the tool call. No summaries, no "acknowledged", no re-pinging the user. This exchange stays off the user's chat.]`;

          db.prepare(`
            INSERT OR IGNORE INTO messages (id, agent_id, role, content, attachments, source_agent_id, created_at)
            VALUES (?, ?, 'user', ?, ?, ?, datetime('now'))
          `).run(
            msgId,
            target.id,
            contextMessage,
            attachments.length > 0 ? JSON.stringify(attachments) : null,
            agentId, // Track sender for auto-route reply detection
          );

          // Broadcast so the target agent's chat view updates, including
          // attachments so thumbnails render in real time (v1.11.5 pattern).
          broadcast({
            type: 'chat:message',
            agentId: target.id,
            message: {
              id: msgId,
              agentId: target.id,
              role: 'user' as const,
              content: contextMessage,
              tokenCount: null,
              modelId: null,
              cost: null,
              latencyMs: null,
              createdAt: new Date().toISOString(),
              ...(attachments.length > 0 ? { attachments } : {}),
            },
          });

          // Trigger the target agent's runtime
          const runtime = getAgentRuntime();
          runtime.handleMessage(target.id, contextMessage).catch(err => {
            logger.error('send_to_agent: target agent runtime failed', {
              targetId: target!.id,
              error: err instanceof Error ? err.message : String(err),
            }, agentId);
          });

          auditLog(
            agentId, 'tool_call', 'send_to_agent', 'success',
            `to:${target.id} (${target.name})${attachments.length > 0 ? ` with ${attachments.length} attachment(s)` : ''}`,
          );
          content = `Message sent to agent "${target.name}" (${target.id}). Status: ${target.status}.` +
            (attachments.length > 0
              ? ` Attached ${attachments.length} file(s): ${attachments.map(a => a.filename).join(', ')}.`
              : '');
        }
        break;
      }
      case 'broadcast_to_group': {
        const groupId = args.group_id as string;
        const broadcastMsg = args.message as string;
        if (!groupId || !broadcastMsg) { content = 'Error: group_id and message are required'; isError = true; break; }

        const bcDb = getDb();
        const senderRow2 = bcDb.prepare('SELECT name FROM agents WHERE id = ?').get(agentId) as { name: string } | undefined;
        const senderName2 = senderRow2?.name ?? agentId;

        // Get all non-terminated agents in the group (excluding the sender)
        const groupMembers = bcDb.prepare(`
          SELECT id, name, status FROM agents
          WHERE group_id = ? AND status != 'terminated' AND id != ?
        `).all(groupId, agentId) as Array<{ id: string; name: string; status: string }>;

        if (groupMembers.length === 0) {
          content = 'No other active agents in this group.';
          break;
        }

        const bcRuntime = getAgentRuntime();
        const sent: string[] = [];

        for (const member of groupMembers) {
          const bcMsgId = uuidv4();
          const bcContextMsg = `[SOURCE: GROUP BROADCAST FROM ${senderName2.toUpperCase()} (agent ID: ${agentId}) — this is NOT a message from the user, it's a broadcast from another agent to your group] ${broadcastMsg}\n\n[Reply via send_to_agent(agent="${agentId}", message="..."), then END YOUR TURN. Zero assistant text after the tool call. No summaries, no user-facing status lines.]`;
          bcDb.prepare(`
            INSERT OR IGNORE INTO messages (id, agent_id, role, content, source_agent_id, created_at)
            VALUES (?, ?, 'user', ?, ?, datetime('now'))
          `).run(bcMsgId, member.id, bcContextMsg, agentId);

          broadcast({
            type: 'chat:message',
            agentId: member.id,
            message: {
              id: bcMsgId,
              agentId: member.id,
              role: 'user' as const,
              content: bcContextMsg,
              tokenCount: null, modelId: null, cost: null, latencyMs: null,
              createdAt: new Date().toISOString(),
            },
          });

          bcRuntime.handleMessage(member.id, bcContextMsg).catch(err => {
            logger.error('broadcast_to_group: member runtime failed', {
              memberId: member.id,
              error: err instanceof Error ? err.message : String(err),
            }, agentId);
          });

          sent.push(member.name);
        }

        content = `Broadcast sent to ${sent.length} agent(s): ${sent.join(', ')}`;
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
        if (args.resume_at) updateArgs.resume_at = args.resume_at;
        if (args.complete_all_runs) updateArgs.complete_all_runs = args.complete_all_runs;
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
      case 'tracker_edit_task': {
        const editArgs: Record<string, unknown> = {
          taskId: args.task_id as string,
        };
        if (args.title !== undefined) editArgs.title = args.title;
        if (args.description !== undefined) editArgs.description = args.description;
        content = trackerEditTask(agentId, editArgs);
        isError = content.startsWith('Error');
        break;
      }
      case 'tracker_get_status': {
        // The tool takes a single 'id' param — try as task first, then project
        const lookupId = args.id as string;
        content = trackerGetStatus(agentId, { taskId: lookupId, projectId: lookupId });
        isError = content.startsWith('Error');
        break;
      }
      case 'tracker_list_active': {
        const listFilter = args.filter as string | undefined;
        if (listFilter === 'mine') {
          content = trackerListActive(agentId, { scope: 'tasks', assignedTo: agentId });
        } else if (listFilter === 'blocked') {
          content = trackerListActive(agentId, { scope: 'tasks', status: 'blocked' });
        } else {
          content = trackerListActive(agentId, { scope: 'all' });
        }
        isError = content.startsWith('Error');
        break;
      }
      case 'tracker_complete_step':
        content = trackerCompleteStep(agentId, {
          taskId: args.task_id as string,
          notes: args.notes as string | undefined,
        });
        isError = content.startsWith('Error');
        break;

      // ── Schedule Tools (Phase 6) ──
      case 'tracker_pause_schedule':
        content = trackerPauseSchedule(agentId, { taskId: args.task_id as string, mark_complete: args.mark_complete as boolean | undefined });
        isError = content.startsWith('Error');
        break;
      case 'tracker_resume_schedule':
        content = trackerResumeSchedule(agentId, { taskId: args.task_id as string });
        isError = content.startsWith('Error');
        break;
      // ── Healer Tools ──
      case 'healer_log_action': {
        const healerDb = getDb();
        const actionId = uuidv4();
        healerDb.prepare(`
          INSERT INTO healer_actions (id, diagnostic_id, category, description, agent_id, action_taken, result, created_at)
          VALUES (?, NULL, ?, ?, ?, ?, ?, datetime('now'))
        `).run(actionId, args.category as string, args.description as string, (args.agent_id as string) ?? null, args.category as string, args.result as string);
        content = `[OK] action_id=${actionId}\n\nAction logged: ${args.description}`;
        break;
      }
      case 'healer_propose': {
        const propDb = getDb();
        const propId = uuidv4();
        propDb.prepare(`
          INSERT INTO healer_proposals (id, diagnostic_id, category, severity, title, description, proposed_fix, confidence, status, agent_id, created_at)
          VALUES (?, NULL, ?, ?, ?, ?, ?, ?, 'pending', ?, datetime('now'))
        `).run(
          propId,
          args.category as string,
          args.severity as string,
          args.title as string,
          args.description as string,
          args.proposed_fix as string,
          args.confidence as number,
          (args.agent_id as string) ?? null,
        );
        broadcast({ type: 'healer:proposal', data: { id: propId, title: args.title, severity: args.severity } } as never);
        content = `[OK] proposal_id=${propId}\n\nProposal created: "${args.title}". The user will see this in the dashboard vitals panel and can approve or deny it.`;
        break;
      }
      case 'get_current_time': {
        const now = new Date();
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        const utcIso = now.toISOString();
        const localStr = now.toLocaleString('en-US', { timeZone: tz, weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });

        // Calculate UTC offset string (e.g., "-06:00") and conversion hint
        const offsetMin = now.getTimezoneOffset();
        const offsetSign = offsetMin <= 0 ? '+' : '-';
        const absMin = Math.abs(offsetMin);
        const offsetStr = `${offsetSign}${String(Math.floor(absMin / 60)).padStart(2, '0')}:${String(absMin % 60).padStart(2, '0')}`;
        const offsetHours = Math.abs(offsetMin / 60);
        const conversionHint = offsetMin > 0
          ? `To convert local to UTC: add ${offsetHours} hours`
          : offsetMin < 0
            ? `To convert local to UTC: subtract ${offsetHours} hours`
            : 'Local time is UTC';

        content = JSON.stringify({
          utc: utcIso,
          local: localStr,
          timezone: tz,
          utc_offset: offsetStr,
          conversion: conversionHint,
          note: 'ALWAYS use the utc value when setting scheduled_start on tasks. All scheduling is UTC.',
        });
        break;
      }

      // ── Presence ──
      // ── Tunnel ──
      case 'tunnel_status': {
        try {
          const { getTunnelStatus } = await import('../services/tunnel.js');
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
        } catch (err) {
          content = `Error getting tunnel status: ${err instanceof Error ? err.message : String(err)}`;
          isError = true;
        }
        break;
      }
      case 'tunnel_start': {
        try {
          const { startTunnel, getTunnelStatus } = await import('../services/tunnel.js');
          const mode = (args.mode as 'quick' | 'named' | undefined);
          const result = startTunnel(mode);
          if (!result.ok) {
            content = `Error starting tunnel: ${result.error ?? 'unknown'}`;
            isError = true;
            break;
          }
          // Poll briefly for the URL to appear
          let url: string | null = null;
          for (let i = 0; i < 10; i++) {
            await new Promise(r => setTimeout(r, 1000));
            const s = getTunnelStatus();
            if (s.status === 'active' && s.url) { url = s.url; break; }
            if (s.status === 'error') { content = `Tunnel failed to start: ${s.error ?? 'unknown'}`; isError = true; break; }
          }
          if (!isError) {
            content = url ? `Tunnel started. Public URL: ${url}` : 'Tunnel is starting. Check tunnel_status in a moment for the URL.';
          }
        } catch (err) {
          content = `Error starting tunnel: ${err instanceof Error ? err.message : String(err)}`;
          isError = true;
        }
        break;
      }
      case 'tunnel_stop': {
        try {
          const { stopTunnel } = await import('../services/tunnel.js');
          stopTunnel();
          content = 'Tunnel stopped.';
        } catch (err) {
          content = `Error stopping tunnel: ${err instanceof Error ? err.message : String(err)}`;
          isError = true;
        }
        break;
      }
      case 'tunnel_restart': {
        try {
          const { stopTunnel, startTunnel, getTunnelStatus } = await import('../services/tunnel.js');
          stopTunnel();
          await new Promise(r => setTimeout(r, 1500));
          const result = startTunnel();
          if (!result.ok) {
            content = `Error restarting tunnel: ${result.error ?? 'unknown'}`;
            isError = true;
            break;
          }
          let url: string | null = null;
          for (let i = 0; i < 10; i++) {
            await new Promise(r => setTimeout(r, 1000));
            const s = getTunnelStatus();
            if (s.status === 'active' && s.url) { url = s.url; break; }
            if (s.status === 'error') { content = `Tunnel failed to restart: ${s.error ?? 'unknown'}`; isError = true; break; }
          }
          if (!isError) {
            content = url ? `Tunnel restarted. New public URL: ${url}` : 'Tunnel is restarting. Check tunnel_status in a moment for the URL.';
          }
        } catch (err) {
          content = `Error restarting tunnel: ${err instanceof Error ? err.message : String(err)}`;
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
          broadcast({ type: 'agent:status', agentId, status: `presence:${status}` });
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

          const targetId = rawTarget;
          let agent = db.prepare('SELECT id, name, status FROM agents WHERE id = ?').get(targetId) as { id: string; name: string; status: string } | undefined;
          if (!agent) {
            // Try by name
            agent = db.prepare("SELECT id, name, status FROM agents WHERE name = ? AND status != 'terminated'").get(targetId) as { id: string; name: string; status: string } | undefined;
            if (!agent) {
              content = `Error: Agent "${targetId}" not found`;
              isError = true;
              break;
            }
          }

          const resolvedId = agent.id;

          // Archive current conversation to vault
          const { archiveAgentConversation } = await import('../vault/archive.js');
          const archiveId = archiveAgentConversation(resolvedId);

          // Clear context items (summaries)
          const { replaceContextItems } = await import('../memory/dag.js');
          replaceContextItems(resolvedId, []);

          // Set session boundary
          const now = new Date();
          const boundary = now.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
          db.prepare('UPDATE agents SET session_started_at = ?, updated_at = ? WHERE id = ?').run(boundary, boundary, resolvedId);

          // Insert UI divider
          const markerId = uuidv4();
          db.prepare("INSERT OR IGNORE INTO messages (id, agent_id, role, content, created_at) VALUES (?, ?, 'system', '── New Session ──', ?)").run(markerId, resolvedId, boundary);

          broadcast({ type: 'chat:message', agentId: resolvedId, message: { id: markerId, agentId: resolvedId, role: 'system', content: '── New Session ──', tokenCount: null, modelId: null, cost: null, latencyMs: null, createdAt: boundary } });

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

      case 'update_agent_model': {
        try {
          const db = getDb();
          const targetId = args.agent_id as string;
          const newModelId = args.model_id as string;

          // Resolve agent by ID or name
          let agent = db.prepare('SELECT id, name, model_id FROM agents WHERE id = ?').get(targetId) as { id: string; name: string; model_id: string | null } | undefined;
          if (!agent) {
            agent = db.prepare("SELECT id, name, model_id FROM agents WHERE name = ? AND status != 'terminated'").get(targetId) as { id: string; name: string; model_id: string | null } | undefined;
          }
          if (!agent) {
            content = `Error: Agent "${targetId}" not found`;
            isError = true;
            break;
          }

          if (newModelId === 'auto') {
            db.prepare("UPDATE agents SET model_id = 'auto', updated_at = datetime('now') WHERE id = ?").run(agent.id);
            const { sanitizeMessagesOnModelChange } = await import('./model-switch.js');
            sanitizeMessagesOnModelChange(agent.id);
            content = `${agent.name} switched to auto-routing. The router will select the best model per query.`;
          } else {
            // Verify model exists and is enabled
            const model = db.prepare('SELECT id, name, is_enabled FROM models WHERE id = ?').get(newModelId) as { id: string; name: string; is_enabled: number } | undefined;
            if (!model) {
              content = `Error: Model "${newModelId}" not found. Use a valid model ID.`;
              isError = true;
              break;
            }
            if (!model.is_enabled) {
              content = `Error: Model "${model.name}" is disabled. Enable it in Settings > Models first.`;
              isError = true;
              break;
            }

            db.prepare("UPDATE agents SET model_id = ?, updated_at = datetime('now') WHERE id = ?").run(newModelId, agent.id);
            // Sanitize tool call messages so the new model doesn't choke on old IDs
            const { sanitizeMessagesOnModelChange } = await import('./model-switch.js');
            const { collapsed } = sanitizeMessagesOnModelChange(agent.id);
            content = `${agent.name}'s model changed from ${agent.model_id ?? 'auto'} to ${model.name} (${newModelId}).${collapsed > 0 ? ` ${collapsed} tool call message(s) were sanitized for compatibility.` : ''}`;
          }

          logger.info('Agent model updated via tool', { callerAgentId: agentId, targetAgentId: agent.id, newModelId }, agentId);
        } catch (err) {
          content = `Error updating agent model: ${err instanceof Error ? err.message : String(err)}`;
          isError = true;
        }
        break;
      }

      case 'update_agent_profile': {
        try {
          const db = getDb();
          const targetRef = args.agent_id as string;
          const newName = args.name as string | undefined;
          const newPrompt = args.system_prompt as string | undefined;

          if (!targetRef) {
            content = 'Error: agent_id is required';
            isError = true;
            break;
          }
          if (newName === undefined && newPrompt === undefined) {
            content = 'Error: provide at least one of name or system_prompt';
            isError = true;
            break;
          }

          // Resolve by ID first, then by name
          let target = db.prepare('SELECT id, name FROM agents WHERE id = ?').get(targetRef) as { id: string; name: string } | undefined;
          if (!target) {
            target = db.prepare("SELECT id, name FROM agents WHERE name = ? AND status != 'terminated'").get(targetRef) as { id: string; name: string } | undefined;
          }
          if (!target) {
            content = `Error: Agent "${targetRef}" not found`;
            isError = true;
            break;
          }

          // Primary agent's identity lives in SOUL.md on disk, not in the messages table.
          // Changing it via this tool would get out-of-sync with the assembler's prompt loader.
          if (isPrimaryAgent(target.id)) {
            content = 'Error: Cannot edit the primary agent via this tool. Edit its SOUL.md in Settings > Soul instead.';
            isError = true;
            break;
          }

          const changes: string[] = [];
          let finalName = target.name;

          if (typeof newName === 'string' && newName.trim() && newName.trim() !== target.name) {
            const trimmedName = newName.trim();
            db.prepare("UPDATE agents SET name = ?, updated_at = datetime('now') WHERE id = ?").run(trimmedName, target.id);
            changes.push(`name: "${target.name}" → "${trimmedName}"`);
            finalName = trimmedName;
          }

          if (typeof newPrompt === 'string') {
            // The system prompt is stored as the first system-role message on the
            // agent. Mirror the behavior of PUT /api/agents/:id in gateway/routes/agents.ts.
            const existingMsg = db.prepare("SELECT id FROM messages WHERE agent_id = ? AND role = 'system' ORDER BY rowid ASC LIMIT 1").get(target.id) as { id: string } | undefined;
            if (existingMsg) {
              db.prepare('UPDATE messages SET content = ? WHERE id = ?').run(newPrompt, existingMsg.id);
            } else {
              db.prepare("INSERT OR IGNORE INTO messages (id, agent_id, role, content, created_at) VALUES (?, ?, 'system', ?, datetime('now'))").run(uuidv4(), target.id, newPrompt);
            }
            db.prepare("UPDATE agents SET updated_at = datetime('now') WHERE id = ?").run(target.id);
            changes.push(`system prompt rewritten (${newPrompt.length} chars)`);
          }

          if (changes.length === 0) {
            content = `No changes: ${target.name} already matches the requested values.`;
          } else {
            content = `Updated ${finalName}: ${changes.join('; ')}`;
            logger.info('Agent profile updated via tool', { callerAgentId: agentId, targetAgentId: target.id, changes }, agentId);
          }
        } catch (err) {
          content = `Error updating agent profile: ${err instanceof Error ? err.message : String(err)}`;
          isError = true;
        }
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
      case 'update_group': {
        const gid = args.group_id as string;
        const newName = args.name as string | undefined;
        const newDescription = args.description as string | undefined;

        if (!gid) {
          content = 'Error: group_id is required';
          isError = true;
          break;
        }
        if (newName === undefined && newDescription === undefined) {
          content = 'Error: provide at least one of name or description';
          isError = true;
          break;
        }

        const { updateGroup: doUpdateGroup, SYSTEM_GROUP_ID: SYS_GROUP_U, getGroupDetail } = await import('./groups.js');
        if (gid === SYS_GROUP_U) {
          content = 'Cannot modify the System group.';
          isError = true;
          break;
        }

        const existing = getGroupDetail(gid);
        if (!existing) {
          content = `Error: Group ${gid} not found`;
          isError = true;
          break;
        }

        const updates: { name?: string; description?: string } = {};
        const changes: string[] = [];
        if (typeof newName === 'string' && newName.trim() && newName.trim() !== existing.name) {
          updates.name = newName.trim();
          changes.push(`name: "${existing.name}" → "${newName.trim()}"`);
        }
        if (typeof newDescription === 'string' && newDescription !== (existing.description ?? '')) {
          updates.description = newDescription;
          changes.push(`description updated (${newDescription.length} chars)`);
        }

        if (changes.length === 0) {
          content = `No changes: group "${existing.name}" already matches the requested values.`;
          break;
        }

        const updated = doUpdateGroup(gid, updates);
        if (!updated) {
          content = `Error: Failed to update group ${gid}`;
          isError = true;
          break;
        }

        content = `Group "${updates.name ?? existing.name}" updated: ${changes.join('; ')}`;
        logger.info('Group updated via tool', { callerAgentId: agentId, groupId: gid, updates });
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
                 a.last_error, a.last_error_at,
                 g.name as group_name
          FROM agents a
          LEFT JOIN agent_groups g ON g.id = a.group_id
          WHERE 1=1 ${statusFilter}
          ORDER BY a.name ASC
        `).all() as Array<Record<string, unknown>>;
        // Map raw status values to workflow-meaningful labels. INJURED and
        // PAUSED are flagged in ALL-CAPS so the calling agent can't miss them
        // when scanning the list.
        const labelForStatus = (s: string): string => {
          switch (s) {
            case 'idle': return 'ready';
            case 'working': return 'working';
            case 'paused': return 'PAUSED (hit error loop — needs reset_session to recover)';
            case 'error': return 'INJURED (runtime error — needs reset_session to recover, or will retry on next message but may re-fail)';
            case 'terminated': return 'terminated';
            default: return s;
          }
        };
        const lines = agentRows.map(a => {
          let line = `- ${a.name} (ID: ${a.id}) — ${labelForStatus(a.status as string)}, ${a.classification}${a.group_name ? `, group: ${a.group_name}` : ''}`;
          // Show last error for injured/paused agents so the healer can diagnose
          if ((a.status === 'error' || a.status === 'paused') && a.last_error) {
            const errorSnippet = (a.last_error as string).slice(0, 150);
            line += `\n    Last error: ${errorSnippet}`;
          }
          return line;
        });
        const injuredCount = agentRows.filter(a => a.status === 'error' || a.status === 'paused').length;
        if (injuredCount > 0) {
          lines.push('');
          lines.push(`⚠️ ${injuredCount} agent(s) are currently injured/paused and cannot reliably respond. Use reset_session(agent_id=...) to heal them, or reassign their work. Do NOT wait indefinitely on an injured agent.`);
        }
        content = lines.join('\n') || 'No agents found.';
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

        // Terminate members BEFORE deleting the group (deleteGroup sets group_id to NULL,
        // so we must query members while group_id still matches)
        const terminated: string[] = [];
        const skipped: string[] = [];
        if (args.terminate_members) {
          const groupDb = getDb();
          const members = groupDb.prepare("SELECT id, name, classification FROM agents WHERE group_id = ? AND status != 'terminated'").all(groupId) as Array<{ id: string; name: string; classification: string }>;
          for (const member of members) {
            if (member.classification === 'sensei' || member.classification === 'ronin') {
              skipped.push(`${member.name} (${member.classification}, protected)`);
              continue;
            }
            try {
              terminateAgent(member.id, `Group deleted by agent ${agentId}`);
              terminated.push(member.name);
            } catch (err) {
              skipped.push(`${member.name} (terminate failed: ${err instanceof Error ? err.message : String(err)})`);
            }
          }
          if (terminated.length > 0) {
            logger.info('Terminated group members before deletion', { groupId, terminated });
          }
        }

        // Auto-complete any tasks still assigned to terminated members or the group
        // This prevents orphaned tasks stuck in on_deck/in_progress after cleanup
        if (args.terminate_members) {
          const groupDb2 = getDb();
          const orphanedTasks = groupDb2.prepare(`
            SELECT id, title, status, schedule_status FROM tasks
            WHERE (assigned_to_group = ? OR assigned_to IN (SELECT id FROM agents WHERE group_id = ? AND status = 'terminated'))
              AND status NOT IN ('complete', 'fallen')
          `).all(groupId, groupId) as Array<{ id: string; title: string; status: string; schedule_status: string }>;
          for (const t of orphanedTasks) {
            groupDb2.prepare("UPDATE tasks SET status = 'complete', schedule_status = CASE WHEN schedule_status = 'unscheduled' THEN 'unscheduled' ELSE 'completed' END, is_paused = 1, completed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(t.id);
            groupDb2.prepare("UPDATE task_runs SET status = 'complete', completed_at = datetime('now'), result_summary = 'Auto-completed: group deleted' WHERE task_id = ? AND status = 'running'").run(t.id);
          }
          if (orphanedTasks.length > 0) {
            logger.info('Auto-completed orphaned tasks during group deletion', { groupId, count: orphanedTasks.length });
          }
        }

        // Now delete the group (ungroups any remaining agents)
        const deleted = doDeleteGroup(groupId);
        if (deleted) {
          const parts = [`Group ${groupId} deleted.`];
          if (args.terminate_members) {
            if (terminated.length > 0) parts.push(`Terminated: ${terminated.join(', ')}.`);
            if (skipped.length > 0) parts.push(`Skipped: ${skipped.join('; ')}.`);
            if (terminated.length === 0 && skipped.length === 0) parts.push('No members to terminate.');
          } else {
            parts.push('Remaining agents moved to ungrouped.');
          }
          content = parts.join(' ');
        } else {
          content = `Failed to delete group ${groupId}. It may not exist.`;
          isError = true;
        }
        break;
      }
      case 'tracker_reassign_task': {
        const rawReassignTaskId = args.task_id as string;
        if (!rawReassignTaskId) { content = 'Error: task_id is required'; isError = true; break; }

        // Resolve task id prefix to the full UUID so this tool accepts
        // the 8-char ids emitted by tracker_list_active, same pattern as
        // the other tracker_* tools.
        const { resolveTaskId, formatResolveError } = await import('../tracker/schema.js');
        const reassignResolved = resolveTaskId(rawReassignTaskId);
        if (!reassignResolved.ok) {
          content = formatResolveError('task', rawReassignTaskId, reassignResolved);
          isError = true;
          break;
        }
        const reassignTaskId = reassignResolved.id;

        const reassignDb = getDb();
        const reassignTask = reassignDb.prepare('SELECT id, title FROM tasks WHERE id = ?').get(reassignTaskId) as { id: string; title: string } | undefined;
        if (!reassignTask) { content = `Error: Task ${reassignTaskId} was deleted before reassignment could be applied.`; isError = true; break; }
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

        sendIMessage(recipient, message);

        // Prevent double-sending when the agent is responding to an
        // incoming iMessage. If the turn was triggered by an iMessage
        // (bridge set pendingIMResponseMap) and the agent chose to
        // explicitly call imessage_send as its reply, the runtime's
        // auto-reply rule in runtime.ts will otherwise ALSO fire at
        // end-of-turn with the final text content and send a second
        // iMessage. Clearing the flag here says "the agent took
        // responsibility, don't auto-reply on top."
        //
        // We clear unconditionally rather than checking recipient
        // match: the risk of double-send (annoying) is worse than
        // the risk of not auto-replying to the original sender when
        // the agent deliberately messaged someone else mid-turn
        // (rare). Gemma4 in particular tends to invoke this tool to
        // reply when other models would just respond in plain text.
        if (isAwaitingIMResponse(agentId)) {
          clearIMResponseFlag(agentId);
          logger.info('imessage_send: cleared auto-reply flag — agent is handling iMessage response itself', {
            agentId,
            recipient,
          });
        }

        auditLog(agentId, 'imessage_send', recipient, 'success', `Sent ${message.length} chars`);
        content = `iMessage sent to ${recipient}`;
        break;
      }

      // ── Image Generation ──
      //
      // image_create: Any agent calls this. The tool returns immediately
      // with an ack, then spawns a background async operation that calls
      // the configured image model directly (no LLM orchestration — image
      // models don't support tool calling). When the image is ready, the
      // tool programmatically sends a delivery message from Imaginer to
      // the requesting agent via send_to_agent with the file attached.
      case 'image_create': {
        const description = (args.description as string | undefined)?.trim();
        const aspectRatio = ((args.aspect_ratio as string | undefined) ?? '1:1').trim();
        const styleHint = ((args.style_hint as string | undefined) ?? '').trim();

        if (!description) {
          content = 'Error: description is required';
          isError = true;
          break;
        }


        const { getImaginerAgentId, getImaginerAgentName, isImaginerEnabled } = await import('../config/platform.js');

        if (!isImaginerEnabled()) {
          content =
            'Image generation is disabled. An administrator can enable Imaginer in Settings → Dojo → Imaginer. ' +
            'You do not need to retry; inform the user that image generation is currently unavailable.';
          isError = true;
          break;
        }

        const imaginerId = getImaginerAgentId();
        const imaginerName = getImaginerAgentName();
        const db = getDb();

        const imaginer = db.prepare(
          'SELECT id, status FROM agents WHERE id = ?',
        ).get(imaginerId) as { id: string; status: string } | undefined;
        if (!imaginer) {
          content =
            `Imaginer agent does not exist yet. Ask the administrator to check server logs and restart.`;
          isError = true;
          break;
        }
        if (imaginer.status === 'terminated') {
          content = `Imaginer has been terminated. Image generation is unavailable until it's restored.`;
          isError = true;
          break;
        }

        // The image model is Imaginer's own model_id (set in Settings →
        // Dojo → Imaginer or on Imaginer's agent detail page). Image
        // models don't support tool calling so Imaginer never runs through
        // the normal LLM runtime — this tool does the generation directly.
        const imageModelRow = db.prepare(
          "SELECT value FROM config WHERE key = 'imaginer_image_model'",
        ).get() as { value: string } | undefined;
        if (!imageModelRow?.value) {
          content =
            `No image generation model is configured for Imaginer yet. ` +
            `Go to Settings → Dojo → Imaginer and pick an image-capable model (e.g. Gemini 2.5 Flash Image on OpenRouter). ` +
            `Tell the user image generation is unavailable until this is configured — do not retry.`;
          isError = true;
          break;
        }

        const requestId = `img_${uuidv4().replace(/-/g, '').slice(0, 12)}`;

        // Build the full prompt. Append the style hint if the user provided
        // one, so the image model gets stylistic direction inline.
        const fullPrompt = styleHint
          ? `${description}\n\nStyle: ${styleHint}`
          : description;

        // Get requester name for the delivery message header
        const senderRow = db.prepare('SELECT name FROM agents WHERE id = ?').get(agentId) as
          | { name: string }
          | undefined;
        const senderName = senderRow?.name ?? agentId;

        // Capture whether this request originated from iMessage BEFORE the
        // runtime clears the flag after sending the ack. The background task
        // needs this to know whether to send the finished image back via
        // iMessage when it's done — the flag will be long gone by then.
        const triggeredByIMessage = isAwaitingIMResponse(agentId);

        auditLog(agentId, 'image_create', imaginerId, 'success',
          `Request ${requestId} queued (aspect ${aspectRatio}${styleHint ? `, style ${styleHint}` : ''})`,
        );

        // ── Async background generation — fire and forget ──
        // The tool returns the ack text below IMMEDIATELY. The generation
        // runs in the background. When done, a programmatic send_to_agent
        // delivers the result (or the error) to the requesting agent.
        const imageModelId = imageModelRow.value;
        void (async () => {
          try {
            // Mark Imaginer as working so the UI shows the status badge
            db.prepare("UPDATE agents SET status = 'working', updated_at = datetime('now') WHERE id = ?").run(imaginerId);
            broadcast({ type: 'agent:status', agentId: imaginerId, status: 'working' });

            // Log the request in Imaginer's chat for audit trail
            const reqMsgId = uuidv4();
            db.prepare(`
              INSERT OR IGNORE INTO messages (id, agent_id, role, content, created_at)
              VALUES (?, ?, 'user', ?, datetime('now'))
            `).run(reqMsgId, imaginerId,
              `[IMAGE_CREATE request_id=${requestId} from=${senderName} aspect=${aspectRatio}]\n${description}`,
            );

            // Wait for the requesting agent to finish its current turn
            // before we start generating. This prevents the delivery message
            // from landing in the middle of the agent's still-in-progress
            // response to the ack text, which scrambles the message order
            // and confuses the model into repeating "I'll have Imaginer
            // work on that" instead of presenting the image.
            const waitStart = Date.now();
            const MAX_WAIT_MS = 60000;
            while (Date.now() - waitStart < MAX_WAIT_MS) {
              const agentRow = db.prepare('SELECT status FROM agents WHERE id = ?').get(agentId) as { status: string } | undefined;
              if (agentRow?.status === 'idle' || agentRow?.status === 'error') break;
              await new Promise<void>(r => setTimeout(r, 500));
            }

            // Set the requesting agent back to 'working' so the thinking
            // dots stay visible during image generation. The user sees the
            // agent say "On it!" → thinking dots stay → image appears.
            // Without this, Kevin goes idle between the ack and delivery
            // and the user sees an awkward gap of silence.
            db.prepare("UPDATE agents SET status = 'working', updated_at = datetime('now') WHERE id = ?").run(agentId);
            broadcast({ type: 'agent:status', agentId, status: 'working' });

            logger.info('Imaginer: generating image', {
              requestId, requesterId: agentId, modelId: imageModelId, aspectRatio,
              waitedForIdleMs: Date.now() - waitStart,
            });

            const { generateImage } = await import('../services/image-generation.js');
            const result = await generateImage({
              modelId: imageModelId,
              prompt: fullPrompt,
              aspectRatio,
            });

            if (!result.ok) {
              logger.error('Imaginer: generation failed', {
                requestId, code: result.code, error: result.error,
              });

              // Log failure in Imaginer's chat
              db.prepare(`
                INSERT OR IGNORE INTO messages (id, agent_id, role, content, created_at)
                VALUES (?, ?, 'assistant', ?, datetime('now'))
              `).run(uuidv4(), imaginerId,
                `[FAILED request_id=${requestId}] ${result.code}: ${result.error}`,
              );

              // Deliver error directly as an assistant message from the
              // requesting agent — no second LLM turn, same pattern as
              // the success path.
              const errMsgId = uuidv4();
              const errContent =
                `I wasn't able to generate that image:\n\n` +
                `> ${result.error}\n\n` +
                `You could try simplifying the description or trying again in a moment.`;
              db.prepare(`
                INSERT OR IGNORE INTO messages (id, agent_id, role, content, created_at)
                VALUES (?, ?, 'assistant', ?, datetime('now'))
              `).run(errMsgId, agentId, errContent);
              broadcast({
                type: 'chat:message', agentId,
                message: {
                  id: errMsgId, agentId, role: 'assistant' as const, content: errContent,
                  tokenCount: null, modelId: null, cost: null, latencyMs: null,
                  createdAt: new Date().toISOString(),
                },
              });
              broadcast({
                type: 'chat:chunk', agentId,
                messageId: errMsgId, content: '', done: true, modelId: null,
              });
              return;
            }

            // Success! Log in Imaginer's chat
            const costLine = result.costUsd !== null ? ` cost=$${result.costUsd.toFixed(4)}` : '';
            db.prepare(`
              INSERT OR IGNORE INTO messages (id, agent_id, role, content, created_at)
              VALUES (?, ?, 'assistant', ?, datetime('now'))
            `).run(uuidv4(), imaginerId,
              `[DONE request_id=${requestId}] ${result.filename} (${result.sizeBytes}B, ${result.latencyMs}ms${costLine})`,
            );

            // Record cost under Imaginer's agent ID
            try {
              const { recordCost } = await import('../costs/tracker.js');
              recordCost({
                agentId: imaginerId,
                modelId: imageModelId,
                providerId: result.providerId,
                inputTokens: result.inputTokens,
                outputTokens: result.outputTokens,
                latencyMs: result.latencyMs,
                requestType: 'image_generation',
              });
            } catch { /* best effort */ }

            // ── Deliver the image as a synthetic assistant message with
            // the thumbnail attached. Clean and reliable — no second LLM
            // turn, no risk of hallucinated URLs or exposed system prompts.
            const fs = (await import('node:fs')).default;
            const path = (await import('node:path')).default;
            const os = (await import('node:os')).default;

            const recipientDir = path.join(os.homedir(), '.dojo', 'uploads', agentId);
            if (!fs.existsSync(recipientDir)) fs.mkdirSync(recipientDir, { recursive: true });
            const copiedName = `imaginer_${Date.now()}_${result.filename}`;
            const copiedPath = path.join(recipientDir, copiedName);
            fs.copyFileSync(result.filePath, copiedPath);

            const attachment = {
              fileId: uuidv4(),
              filename: result.filename,
              mimeType: result.mimeType,
              size: result.sizeBytes,
              path: copiedPath,
              category: 'image' as const,
            };

            const deliveryMsgId = uuidv4();
            const deliveryContent = `Here you go! Let me know if you'd like any changes.`;

            db.prepare(`
              INSERT OR IGNORE INTO messages (id, agent_id, role, content, attachments, model_id, created_at)
              VALUES (?, ?, 'assistant', ?, ?, ?, datetime('now'))
            `).run(deliveryMsgId, agentId, deliveryContent, JSON.stringify([attachment]), imageModelId);

            broadcast({
              type: 'chat:message', agentId,
              message: {
                id: deliveryMsgId, agentId, role: 'assistant' as const, content: deliveryContent,
                tokenCount: null, modelId: imageModelId, cost: null, latencyMs: null,
                createdAt: new Date().toISOString(),
                attachments: [attachment],
              },
            });

            broadcast({
              type: 'chat:chunk', agentId,
              messageId: deliveryMsgId,
              content: '', done: true, modelId: imageModelId,
            });

            logger.info('Imaginer: image delivered as assistant message', {
              requestId, requesterId: agentId, filePath: result.filePath,
              sizeBytes: result.sizeBytes, latencyMs: result.latencyMs,
            });

            // Send via iMessage if user is away or request came from iMessage
            try {
              const { isPrimaryAgent } = await import('../config/platform.js');
              if (isPrimaryAgent(agentId)) {
                let shouldSendViaIMessage = triggeredByIMessage;
                if (!shouldSendViaIMessage) {
                  try {
                    const { getPresence } = await import('../services/presence.js');
                    shouldSendViaIMessage = getPresence() === 'away';
                  } catch { /* presence module unavailable */ }
                }
                if (shouldSendViaIMessage) {
                  const { sendIMessageWithAttachment, getDefaultSender } = await import('../services/imessage-bridge.js');
                  const recipient = getDefaultSender();
                  if (recipient) {
                    sendIMessageWithAttachment(recipient, result.filePath, 'Here you go!');
                  }
                }
              }
            } catch { /* iMessage not available — fine */ }

          } catch (err) {
            logger.error('Imaginer: unexpected error in background generation', {
              requestId, error: err instanceof Error ? err.message : String(err),
            });
          } finally {
            // Set both Imaginer and the requesting agent back to idle
            db.prepare("UPDATE agents SET status = 'idle', updated_at = datetime('now') WHERE id = ?").run(imaginerId);
            broadcast({ type: 'agent:status', agentId: imaginerId, status: 'idle' });
            db.prepare("UPDATE agents SET status = 'idle', updated_at = datetime('now') WHERE id = ?").run(agentId);
            broadcast({ type: 'agent:status', agentId, status: 'idle' });
          }
        })();

        content =
          `Image generation started (request_id: ${requestId}). ` +
          `The finished image will appear in the chat automatically when ready — you do NOT need to do anything else. ` +
          `Do NOT send another message to the user about this. Your earlier acknowledgment (before this tool call) is sufficient. ` +
          `Just end your turn now. The image will show up on its own.`;
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

      case 'delete_technique': {
        const techName = args.name as string;
        if (!techName) { content = 'Error: technique name is required'; isError = true; break; }
        const { deleteTechnique } = await import('../techniques/store.js');
        const deleted = deleteTechnique(techName);
        if (deleted) {
          content = `Technique "${techName}" has been permanently deleted.`;
          logger.info('Technique deleted via tool', { techniqueId: techName }, agentId);
        } else {
          content = `Error: technique "${techName}" not found.`;
          isError = true;
        }
        break;
      }

      // ── Vault (Long-Term Memory) ──

      case 'vault_remember': {
        content = await executeVaultRemember(agentId, args);
        isError = content.startsWith('Error');
        break;
      }
      case 'vault_search': {
        content = await executeVaultSearch(agentId, args);
        isError = content.startsWith('Error');
        break;
      }
      case 'vault_forget': {
        content = executeVaultForget(agentId, args);
        isError = content.startsWith('Error');
        break;
      }

      // ── Google Workspace Tools ──

      case 'gmail_search':
      case 'gmail_read':
      case 'gmail_inbox':
      case 'calendar_agenda':
      case 'calendar_search':
      case 'drive_list':
      case 'drive_read':
      case 'docs_read':
      case 'sheets_read': {
        const agentRow = getDb().prepare('SELECT name FROM agents WHERE id = ?').get(agentId) as { name: string } | undefined;
        content = await executeGoogleReadTool(name, args, agentId, agentRow?.name ?? agentId);
        isError = content.startsWith('Error');
        break;
      }

      case 'gmail_send':
      case 'gmail_reply':
      case 'gmail_forward':
      case 'gmail_label':
      case 'calendar_create':
      case 'calendar_update':
      case 'calendar_delete':
      case 'drive_upload':
      case 'drive_share':
      case 'docs_create':
      case 'docs_edit':
      case 'sheets_create':
      case 'sheets_append':
      case 'sheets_write': {
        // Double-check: only primary agent can use write tools (belt + suspenders)
        if (!isPrimaryAgent(agentId)) {
          content = 'Permission denied: only the primary agent can use Google Workspace write tools.';
          isError = true;
          auditLog(agentId, name, null, 'denied', 'Google write tool restricted to primary agent');
          break;
        }
        const agentRow = getDb().prepare('SELECT name FROM agents WHERE id = ?').get(agentId) as { name: string } | undefined;
        content = await executeGoogleWriteTool(name, args, agentId, agentRow?.name ?? agentId);
        isError = content.startsWith('Error');
        break;
      }

      // ── Microsoft 365 Tools ──

      case 'outlook_search':
      case 'outlook_read':
      case 'outlook_inbox':
      case 'outlook_list_attachments':
      case 'calendar_agenda_ms':
      case 'calendar_search_ms':
      case 'onedrive_list':
      case 'onedrive_read':
      case 'onedrive_search':
      case 'teams_read_messages':
      case 'teams_list_teams':
      case 'teams_list_channels':
      case 'teams_read_channel_messages': {
        const agentRow = getDb().prepare('SELECT name FROM agents WHERE id = ?').get(agentId) as { name: string } | undefined;
        content = await executeMicrosoftReadTool(name, args, agentId, agentRow?.name ?? agentId);
        isError = content.startsWith('Error');
        break;
      }

      case 'outlook_send':
      case 'outlook_reply':
      case 'outlook_forward':
      case 'outlook_mark_read':
      case 'outlook_delete':
      case 'outlook_download_attachment':
      case 'calendar_create_ms':
      case 'calendar_update_ms':
      case 'calendar_delete_ms':
      case 'calendar_respond_invite':
      case 'onedrive_create_folder':
      case 'onedrive_upload':
      case 'onedrive_upload_batch':
      case 'onedrive_share':
      case 'onedrive_delete':
      case 'onedrive_move':
      case 'teams_create_chat':
      case 'teams_send_message':
      case 'teams_send_channel_message': {
        if (!isPrimaryAgent(agentId)) {
          content = 'Permission denied: only the primary agent can use Microsoft 365 write tools.';
          isError = true;
          auditLog(agentId, name, null, 'denied', 'Microsoft write tool restricted to primary agent');
          break;
        }
        const agentRow = getDb().prepare('SELECT name FROM agents WHERE id = ?').get(agentId) as { name: string } | undefined;
        content = await executeMicrosoftWriteTool(name, args, agentId, agentRow?.name ?? agentId);
        isError = content.startsWith('Error');
        break;
      }

      // ── Office Document Tools ──

      case 'office_create_word_document':
      case 'office_append_to_word_document':
      case 'office_create_spreadsheet':
      case 'office_create_presentation': {
        if (!isPrimaryAgent(agentId)) {
          content = 'Permission denied: only the primary agent can create Office documents.';
          isError = true;
          break;
        }
        const agentRow = getDb().prepare('SELECT name FROM agents WHERE id = ?').get(agentId) as { name: string } | undefined;
        content = await executeOfficeTool(name, args, agentId, agentRow?.name ?? agentId);
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
