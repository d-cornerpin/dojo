import { describe, it, expect } from 'vitest';
import type { ToolCall } from '@dojo/shared';
import { trackerEnforcer, trackerStatusUpdater } from '../classifiers/tracker.js';

function tc(name: string): ToolCall {
  return { id: `id_${name}_${Math.random()}`, name, arguments: {} };
}

describe('trackerEnforcer', () => {
  const baseInput = {
    plannedTools: [],
    agentHasTrackerTools: true,
    trackerToolCalledThisTurn: false,
    agentHasInProgressTask: false,
  };

  it('skips when agent has no tracker tools', () => {
    const r = trackerEnforcer({
      ...baseInput,
      agentHasTrackerTools: false,
      plannedTools: [tc('file_write'), tc('exec'), tc('file_write')],
    });
    expect(r.decision).toBe('skip');
    expect(r.reason).toContain('no tracker tools');
  });

  it('skips when agent already has in_progress task', () => {
    const r = trackerEnforcer({
      ...baseInput,
      agentHasInProgressTask: true,
      plannedTools: [tc('file_write'), tc('exec'), tc('file_write')],
    });
    expect(r.decision).toBe('skip');
    expect(r.reason).toContain('in_progress task');
  });

  it('skips when tracker tool already called this turn', () => {
    const r = trackerEnforcer({
      ...baseInput,
      trackerToolCalledThisTurn: true,
      plannedTools: [tc('file_write'), tc('exec')],
    });
    expect(r.decision).toBe('skip');
    expect(r.reason).toContain('already called this turn');
  });

  it('skips when agent calls tracker_create_task themselves', () => {
    const r = trackerEnforcer({
      ...baseInput,
      plannedTools: [tc('tracker_create_task'), tc('file_write')],
    });
    expect(r.decision).toBe('skip');
    expect(r.reason).toContain('themselves');
  });

  it('skips when agent uses any other tracker_* tool (already engaged)', () => {
    const r = trackerEnforcer({
      ...baseInput,
      plannedTools: [tc('tracker_get_status'), tc('file_write')],
    });
    expect(r.decision).toBe('skip');
    expect(r.reason).toContain('engaging with tracker');
  });

  it('skips when only 1 non-trivial tool planned', () => {
    const r = trackerEnforcer({
      ...baseInput,
      plannedTools: [tc('file_read')],
    });
    expect(r.decision).toBe('skip');
    expect(r.reason).toContain('not multi-step');
  });

  it('skips when all calls are trivial', () => {
    const r = trackerEnforcer({
      ...baseInput,
      plannedTools: [tc('get_current_time'), tc('vault_search'), tc('history_search'), tc('load_tool_docs')],
    });
    expect(r.decision).toBe('skip');
  });

  it('CREATES when 2+ non-trivial tools planned without tracker', () => {
    const r = trackerEnforcer({
      ...baseInput,
      plannedTools: [tc('file_write'), tc('exec'), tc('file_write')],
    });
    expect(r.decision).toBe('create');
    expect(r.reason).toContain('non-trivial');
  });

  it('CREATES even when mixed with trivial tools (only counts non-trivial)', () => {
    const r = trackerEnforcer({
      ...baseInput,
      plannedTools: [tc('vault_search'), tc('file_write'), tc('get_current_time'), tc('exec')],
    });
    expect(r.decision).toBe('create');
  });

  it('does not count complete_task as non-trivial', () => {
    const r = trackerEnforcer({
      ...baseInput,
      plannedTools: [tc('file_write'), tc('complete_task')],
    });
    expect(r.decision).toBe('skip');
    expect(r.reason).toContain('1 non-trivial');
  });
});

describe('trackerStatusUpdater', () => {
  it('returns null when no current task', () => {
    const r = trackerStatusUpdater({
      toolName: 'complete_task',
      toolArgs: { status: 'complete' },
      isError: false,
      currentTaskId: null,
    });
    expect(r).toBeNull();
  });

  it('updates to complete on complete_task with status=complete', () => {
    const r = trackerStatusUpdater({
      toolName: 'complete_task',
      toolArgs: { status: 'complete' },
      isError: false,
      currentTaskId: 'task-123',
    });
    expect(r).not.toBeNull();
    expect(r!.taskId).toBe('task-123');
    expect(r!.status).toBe('complete');
  });

  it('updates to blocked on complete_task with status=blocked', () => {
    const r = trackerStatusUpdater({
      toolName: 'complete_task',
      toolArgs: { status: 'blocked' },
      isError: false,
      currentTaskId: 'task-123',
    });
    expect(r!.status).toBe('blocked');
  });

  it('updates to failed on complete_task with status=failed', () => {
    const r = trackerStatusUpdater({
      toolName: 'complete_task',
      toolArgs: { status: 'failed' },
      isError: false,
      currentTaskId: 'task-123',
    });
    expect(r!.status).toBe('failed');
  });

  it('defaults complete_task without status to complete', () => {
    const r = trackerStatusUpdater({
      toolName: 'complete_task',
      toolArgs: {},
      isError: false,
      currentTaskId: 'task-123',
    });
    expect(r!.status).toBe('complete');
  });

  it('returns null for unrelated tool calls', () => {
    const r = trackerStatusUpdater({
      toolName: 'file_write',
      toolArgs: { path: '/x' },
      isError: false,
      currentTaskId: 'task-123',
    });
    expect(r).toBeNull();
  });
});
