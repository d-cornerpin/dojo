// ════════════════════════════════════════════════════════════════════════════
// THE TASK DETAIL SPEAKS PLAIN WORDS: the Activity log printed engine words
// ("[user]", "user_verdict_request", "on_deck → in_progress"), a "Phase:" line,
// and "Legacy notes (pre-Phase B.0)". Each row now names who and what in words,
// the states carry the board's own words, the Phase line is gone and the old
// notes are "Earlier notes".
// ════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { Task, AgentDetail } from '@dojo/shared';

// The permissive factory the smoke floor uses — every exported FUNCTION answers
// `{ ok: true, data: [] }`, every exported constant stays real — so the panel
// mounts on its own terms (its task_log feed included) and the door this file is
// about is the only override.
vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../lib/api');
  const stub: Record<string, unknown> = {};
  for (const key of Object.keys(actual)) {
    stub[key] = typeof actual[key] === 'function'
      ? vi.fn(async () => ({ ok: true, data: [] }))
      : actual[key];
  }
  stub.getToken = vi.fn(() => null);
  stub.clearToken = vi.fn(() => undefined);
  return stub;
});

import * as api from '../lib/api';
vi.mock('../hooks/useWebSocket', async () => {
  const { fakeUseWebSocket } = await import('./helpers/frames');
  return { useWebSocket: fakeUseWebSocket };
});
import { ToastProvider } from '../hooks/useToast';
import { Dojo3Notifications } from '../components/Dojo3Notifications';
import { TaskDetailPanel } from '../pages/Tracker';

const task = {
  id: 't1',
  title: 'Write the guide',
  status: 'on_deck',
  priority: 'normal',
  assignedTo: '',
  evidence: [],
  dependsOn: [],
  phase: 'build',
  notes: 'Old words from before.',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  scheduledStart: null,
  repeatInterval: null,
  repeatUnit: null,
  repeatEndType: 'never',
  repeatEndValue: null,
  repeatDaysOfWeek: null,
  anchorTime: null,
  scheduleStatus: 'unscheduled',
  nextRunAt: null,
  isPaused: false,
  runCount: 0,
} as unknown as Task;

const LOG = [
  { id: '1', taskId: 't1', fromEntity: 'user', entryKind: 'user_verdict_request', fromStatus: 'on_deck', toStatus: 'in_progress', reason: null, actionTaken: null, note: null, evidenceJson: null, createdAt: '2026-01-01T00:00:00.000Z' },
  { id: '2', taskId: 't1', fromEntity: 'agent:a1', entryKind: 'transition', fromStatus: 'in_progress', toStatus: 'paused', reason: null, actionTaken: null, note: null, evidenceJson: null, createdAt: '2026-01-01T00:01:00.000Z' },
];
const agents = [{ id: 'a1', name: 'Kite' }] as unknown as AgentDetail[];

beforeEach(() => { vi.mocked(api.getTaskLog).mockResolvedValue({ ok: true, data: LOG } as never); });
afterEach(() => { vi.clearAllMocks(); });

const renderPanel = () => render(
  <ToastProvider>
    <TaskDetailPanel task={task} agents={agents} allTasks={[]} onClose={() => {}} onUpdate={() => {}} />
  </ToastProvider>,
);

describe('the task detail speaks plain words', () => {
  it('names who and what in words, and the states in the board\'s words', async () => {
    renderPanel();
    expect(await screen.findByText('Asked you to decide')).toBeTruthy();
    expect(screen.getByText('You')).toBeTruthy();
    // The agent's name also sits in the Assignee select as an <option>; this reads the log row's span.
    expect(screen.getByText('Kite', { selector: 'span' })).toBeTruthy();
    expect(screen.getByText('Open → Working')).toBeTruthy();
    expect(screen.getByText('Working → Paused')).toBeTruthy();
    expect(screen.queryByText('user_verdict_request')).toBeNull();
    expect(screen.queryByText('[user]')).toBeNull();
  });
  it('has no Phase line and calls the old notes Earlier notes', async () => {
    renderPanel();
    await screen.findByText('Asked you to decide');
    expect(screen.queryByText(/Phase:/)).toBeNull();
    expect(screen.getByText('Earlier notes')).toBeTruthy();
    expect(screen.queryByText(/Legacy notes/)).toBeNull();
  });
});
