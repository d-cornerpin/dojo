// A prompt that could not be read is not a blank prompt: the card says so with a Retry, offers no
// Save, and a save names the prompt it was built on. A failed model list is said, not silent.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { ReactElement } from 'react';

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../lib/api');
  const stub: Record<string, unknown> = {};
  for (const key of Object.keys(actual)) {
    stub[key] = typeof actual[key] === 'function' ? vi.fn(async () => ({ ok: true, data: [] })) : actual[key];
  }
  return stub;
});
vi.mock('../hooks/useToast', async () => {
  const { fakeToast } = await import('./helpers/frames');
  const stub = fakeToast();
  return { useToast: () => stub.value, ToastProvider: ({ children }: { children: ReactElement }) => children, ToastContainer: () => null };
});

vi.mock('../hooks/useWebSocket', async () => {
  const { fakeUseWebSocket } = await import('./helpers/frames');
  return { useWebSocket: fakeUseWebSocket, WebSocketProvider: ({ children }: { children: unknown }) => children };
});

import * as api from '../lib/api';
import { AgentConfigPanel } from '../pages/AgentConfigPanel';
import { ActiveAgentProvider } from '../components/ActiveAgentProvider';

const detail = { ok: true, data: { id: 'a', name: 'Agent-One', classification: 'apprentice', status: 'idle', modelId: 'auto', inFlight: { turn: 0, background: 0 } } };
const tree = () => (
  <MemoryRouter initialEntries={['/agents/a']}>
    <ActiveAgentProvider><Routes><Route path="agents/:id" element={<AgentConfigPanel />} /></Routes></ActiveAgentProvider>
  </MemoryRouter>
);
const setup = (prompt: unknown, update?: unknown) => {
  vi.mocked(api).getAgent.mockResolvedValue(detail as never);
  vi.mocked(api).getAgentSystemPrompt.mockResolvedValue(prompt as never);
  if (update) vi.mocked(api).updateAgentConfig.mockResolvedValue(update as never);
};
afterEach(() => { vi.resetAllMocks(); });

describe('the system prompt card', () => {
  it('a failed prompt read says so, offers Retry and no Save Prompt, and sends nothing', async () => {
    setup({ ok: false, error: 'down' });
    render(tree());
    await screen.findByText(/Could not load this agent’s prompt/);
    expect(screen.getByText('Retry')).toBeTruthy();
    expect(screen.queryByText('Save Prompt')).toBeNull();
    expect(vi.mocked(api).updateAgentConfig).not.toHaveBeenCalled();
  });

  it('Retry loads the real prompt, and the save names it as its base', async () => {
    setup({ ok: false, error: 'down' }, { ok: true, data: {} });
    render(tree());
    const retry = await screen.findByText('Retry');
    vi.mocked(api).getAgentSystemPrompt.mockResolvedValue({ ok: true, data: { content: 'REAL' } } as never);
    fireEvent.click(retry);
    const box = await screen.findByDisplayValue('REAL');
    fireEvent.change(box, { target: { value: 'REAL plus' } });
    fireEvent.click(screen.getByText('Save Prompt'));
    await waitFor(() => expect(vi.mocked(api).updateAgentConfig).toHaveBeenCalled());
    expect(vi.mocked(api).updateAgentConfig.mock.calls[0][1]).toMatchObject({ systemPrompt: 'REAL plus', systemPromptBase: 'REAL' });
  });

  it('a failed model list is said, not silently empty', async () => {
    setup({ ok: true, data: { content: 'x' } });
    vi.mocked(api).getModels.mockResolvedValue({ ok: false, error: 'down' } as never);
    render(tree());
    await screen.findByText(/Could not load the model list/);
  });
});

describe('a failed save keeps what the owner typed', () => {
  it('the typed prompt stays in the editor with the error, and the saved version loads only on request', async () => {
    setup({ ok: true, data: { content: 'SAVED' } }, { ok: false, error: 'This prompt changed since you loaded it, so it was not saved.' });
    render(tree());
    const box = await screen.findByDisplayValue('SAVED');
    fireEvent.change(box, { target: { value: 'MY LONG EDIT' } });
    fireEvent.click(screen.getByText('Save Prompt'));
    await waitFor(() => expect(vi.mocked(api).updateAgentConfig).toHaveBeenCalled());
    await screen.findByText('Load the saved version');
    expect(screen.getByDisplayValue('MY LONG EDIT')).toBeTruthy();
    vi.mocked(api).getAgentSystemPrompt.mockResolvedValue({ ok: true, data: { content: 'NEWER' } } as never);
    fireEvent.click(screen.getByText('Load the saved version'));
    await screen.findByDisplayValue('NEWER');
  });
});

describe('loading the saved version on request', () => {
  it('puts the saved text back even when it is unchanged since the first load', async () => {
    setup({ ok: true, data: { content: 'SAVED' } }, { ok: false, error: 'down' });
    render(tree());
    fireEvent.change(await screen.findByDisplayValue('SAVED'), { target: { value: 'TYPED' } });
    fireEvent.click(screen.getByText('Save Prompt'));
    fireEvent.click(await screen.findByText('Load the saved version'));
    await screen.findByDisplayValue('SAVED');
  });
});
