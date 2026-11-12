// When a tool call is denied, this finder proposes alternatives. The engine
// appends them to the [BLOCKED] tool result so the agent adapts instead of
// retrying the same disallowed call. Enforcement is unchanged: the per-agent
// manifest in permissions.ts stays authoritative, and this is only a layer
// that suggests other approaches once a denial has happened.

import type { PermissionManifest } from '@dojo/shared';
import { execCallText } from '../../brokers/exec-seam.js';

export interface PermissionAlternativeInput {
  /** The tool that was denied. */
  toolName: string;
  /** The argument values from the denied call (e.g., `path`, `command`, `domain`). */
  toolArgs: Record<string, unknown>;
  /** The reason permissions returned. */
  denyReason: string;
  /** The agent's current permission manifest. */
  manifest: PermissionManifest;
  /** Whether the agent has send_to_agent (can escalate to a more privileged agent). */
  hasSendToAgent: boolean;
  /** Whether the agent has complete_task (can mark as blocked). */
  hasCompleteTask: boolean;
}

export interface PermissionAlternativesResult {
  /** Human-readable suggestions for the agent. */
  suggestions: string[];
}

export function permissionAlternativeFinder(
  input: PermissionAlternativeInput,
): PermissionAlternativesResult {
  const suggestions: string[] = [];
  const { toolName, toolArgs, manifest, hasSendToAgent, hasCompleteTask } = input;

  switch (toolName) {
    // 'file_delete' shares the file_write suggestions and is kept for a future
    // scoped-delete tool; today no agent-callable file_delete exists (deletes
    // ride the exec/rm path), so no denied call arrives under this name.
    case 'file_write':
    case 'file_delete': {
      const allowedWrite = Array.isArray(manifest.file_write) ? manifest.file_write : [];
      if (allowedWrite.length > 0) {
        suggestions.push(
          `You CAN write to: ${allowedWrite.join(', ')}. Choose a path inside one of those.`,
        );
      }
      const allowedRead = Array.isArray(manifest.file_read) ? manifest.file_read : [];
      if (manifest.file_read === '*' || allowedRead.length > 0) {
        suggestions.push(
          'If you only need to read this path (not write), use file_read instead.',
        );
      }
      break;
    }

    case 'exec':
    case 'shell': {
      // Read the call's real shape through the one owner of that question:
      // `toolArgs.command` is `undefined` at both rebuilt doors, and a refusal
      // naming `unknown` is one the agent cannot act on.
      const cmd = execCallText(toolName, toolArgs)?.trim().split(/\s+/)[0] ?? 'unknown';
      if (manifest.exec_allow.length > 0 && !manifest.exec_allow.includes('*')) {
        suggestions.push(
          `Your permitted commands are: ${manifest.exec_allow.join(', ')}. ` +
          `\`${cmd}\` is not in that list.`,
        );
      }
      if (cmd === 'rm' || cmd === 'mv' || cmd === 'cp') {
        suggestions.push('File management is restricted, use file_read / file_write through the API instead.');
      }
      if (cmd === 'curl' || cmd === 'wget') {
        suggestions.push('For HTTP fetches use web_fetch (it handles auth, headers, and parses content).');
      }
      if (cmd === 'cat' || cmd === 'less' || cmd === 'head' || cmd === 'tail') {
        suggestions.push('To read a file, use file_read with offset/limit instead of `cat`.');
      }
      if (cmd === 'ls' || cmd === 'find' || cmd === 'tree') {
        suggestions.push('To list a directory, use file_list instead of shell commands.');
      }
      if (cmd === 'grep' || cmd === 'rg' || cmd === 'ag') {
        suggestions.push('To search content, use history_search (conversation history) or vault_search (long-term memory).');
      }
      break;
    }

    case 'spawn_agent': {
      if (hasSendToAgent) {
        suggestions.push('Use send_to_agent to ask an existing agent to do this work for you.');
      }
      break;
    }

    case 'web_search':
    case 'web_fetch':
    case 'web_browse': {
      if (manifest.network_domains === 'none') {
        suggestions.push('Network access is disabled for this agent.');
      } else if (Array.isArray(manifest.network_domains)) {
        suggestions.push(`Allowed domains: ${manifest.network_domains.join(', ')}. Try one of those, or fetch via a more privileged agent.`);
      }
      if (hasSendToAgent) {
        suggestions.push('Ask a more privileged agent (via send_to_agent) to fetch this for you.');
      }
      break;
    }

    case 'update_agent':
    case 'reset_session':
    case 'create_agent_group':
    case 'delete_group':
    case 'assign_to_group':
    case 'kill_agent':
    case 'set_user_presence':
    case 'tunnel': {
      suggestions.push(
        'This tool is restricted to the primary agent. Use send_to_agent to ask the primary to perform this action.',
      );
      break;
    }
  }

  if (hasSendToAgent) {
    suggestions.push('If no alternative works, use send_to_agent with intent=BLOCK to ask for help.');
  }
  if (hasCompleteTask) {
    suggestions.push(
      'If you cannot complete this task with available tools, call complete_task(status="blocked", summary="...") with a clear explanation of what permission you need.',
    );
  }

  return { suggestions };
}
