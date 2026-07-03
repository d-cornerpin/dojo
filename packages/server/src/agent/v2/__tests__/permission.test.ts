import { describe, it, expect } from 'vitest';
import type { PermissionManifest } from '@dojo/shared';
import { permissionAlternativeFinder } from '../classifiers/permission.js';

const subAgentManifest: PermissionManifest = {
  file_read: ['~/Projects/**', '/tmp/**'],
  file_write: ['~/Projects/**', '/tmp/**'],
  file_delete: 'none',
  exec_allow: ['ls', 'cat', 'grep', 'node'],
  exec_deny: [],
  network_domains: 'none',
  max_processes: 3,
  can_spawn_agents: false,
  can_assign_permissions: false,
  system_control: [],
};

describe('permissionAlternativeFinder', () => {
  it('suggests allowed write paths for denied file_write', () => {
    const r = permissionAlternativeFinder({
      toolName: 'file_write',
      toolArgs: { path: '/etc/passwd' },
      denyReason: 'not allowed',
      manifest: subAgentManifest,
      hasSendToAgent: true,
      hasCompleteTask: true,
    });
    expect(r.suggestions.some((s) => s.includes('~/Projects/**'))).toBe(true);
  });

  it('suggests file_read alternative for denied file_write', () => {
    const r = permissionAlternativeFinder({
      toolName: 'file_write',
      toolArgs: { path: '/etc/passwd' },
      denyReason: 'not allowed',
      manifest: subAgentManifest,
      hasSendToAgent: false,
      hasCompleteTask: false,
    });
    expect(r.suggestions.some((s) => s.includes('file_read'))).toBe(true);
  });

  it('suggests permitted commands for denied exec', () => {
    const r = permissionAlternativeFinder({
      toolName: 'exec',
      toolArgs: { command: 'rm -rf /tmp' },
      denyReason: 'not allowed',
      manifest: subAgentManifest,
      hasSendToAgent: false,
      hasCompleteTask: false,
    });
    expect(r.suggestions.some((s) => s.includes('ls') && s.includes('cat'))).toBe(true);
  });

  it('suggests file_read for cat', () => {
    const denyAllExec: PermissionManifest = { ...subAgentManifest, exec_allow: ['ls'] };
    const r = permissionAlternativeFinder({
      toolName: 'exec',
      toolArgs: { command: 'cat /tmp/foo.txt' },
      denyReason: 'not allowed',
      manifest: denyAllExec,
      hasSendToAgent: false,
      hasCompleteTask: false,
    });
    expect(r.suggestions.some((s) => s.includes('file_read'))).toBe(true);
  });

  it('suggests web_fetch for curl', () => {
    const r = permissionAlternativeFinder({
      toolName: 'exec',
      toolArgs: { command: 'curl https://example.com' },
      denyReason: 'not allowed',
      manifest: { ...subAgentManifest, exec_allow: ['ls'] },
      hasSendToAgent: false,
      hasCompleteTask: false,
    });
    expect(r.suggestions.some((s) => s.includes('web_fetch'))).toBe(true);
  });

  it('suggests history_search / vault_search for grep', () => {
    const r = permissionAlternativeFinder({
      toolName: 'exec',
      toolArgs: { command: 'grep TODO src/' },
      denyReason: 'not allowed',
      manifest: { ...subAgentManifest, exec_allow: ['ls'] },
      hasSendToAgent: false,
      hasCompleteTask: false,
    });
    expect(r.suggestions.some((s) => s.includes('history_search') || s.includes('vault_search'))).toBe(true);
  });

  it('suggests send_to_agent for spawn_agent denial', () => {
    const r = permissionAlternativeFinder({
      toolName: 'spawn_agent',
      toolArgs: { name: 'X' },
      denyReason: 'not allowed',
      manifest: subAgentManifest,
      hasSendToAgent: true,
      hasCompleteTask: false,
    });
    expect(r.suggestions.some((s) => s.includes('send_to_agent'))).toBe(true);
  });

  it('suggests primary escalation for privileged ops', () => {
    const r = permissionAlternativeFinder({
      toolName: 'update_agent',
      toolArgs: {},
      denyReason: 'not allowed',
      manifest: subAgentManifest,
      hasSendToAgent: true,
      hasCompleteTask: true,
    });
    expect(r.suggestions.some((s) => s.includes('primary'))).toBe(true);
  });

  it('always suggests escalation when send_to_agent is available', () => {
    const r = permissionAlternativeFinder({
      toolName: 'file_write',
      toolArgs: { path: '/x' },
      denyReason: 'not allowed',
      manifest: subAgentManifest,
      hasSendToAgent: true,
      hasCompleteTask: false,
    });
    expect(r.suggestions.some((s) => s.includes('intent=BLOCK'))).toBe(true);
  });

  it('always suggests complete_task(blocked) when complete_task is available', () => {
    const r = permissionAlternativeFinder({
      toolName: 'file_write',
      toolArgs: { path: '/x' },
      denyReason: 'not allowed',
      manifest: subAgentManifest,
      hasSendToAgent: false,
      hasCompleteTask: true,
    });
    expect(r.suggestions.some((s) => s.includes('complete_task') && s.includes('blocked'))).toBe(true);
  });

  it('returns empty suggestions when no alternatives are possible', () => {
    const noEscalation: PermissionManifest = { ...subAgentManifest, exec_allow: [] };
    const r = permissionAlternativeFinder({
      toolName: 'mouse_click',
      toolArgs: {},
      denyReason: 'not allowed',
      manifest: noEscalation,
      hasSendToAgent: false,
      hasCompleteTask: false,
    });
    // No tool-specific suggestions for mouse_click; without escalation tools,
    // suggestions should be empty (the agent gets the bare deny reason).
    expect(r.suggestions).toEqual([]);
  });
});
