// The side canvas must not vanish because a status read failed, and a failed close/re-open post
// must not leave the screen saying something the server does not.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act, waitFor } from '@testing-library/react';

let currentAgent = 'a-1';
vi.mock('../components/ActiveAgentProvider', () => ({
  useActiveAgent: () => ({ agentId: currentAgent }),
}));
vi.mock('../lib/api', () => ({ getCanvas: vi.fn(), setCanvasStatus: vi.fn() }));

import * as api from '../lib/api';
import { RightDockProvider, useRightDock, type RightDockApi } from '../components/RightDockProvider';

let dockApi: RightDockApi;
const Probe = () => { dockApi = useRightDock(); return null; };
const tree = () => <RightDockProvider><Probe /></RightDockProvider>;
const persisted = (status: 'open' | 'collapsed') =>
  ({ ok: true, data: { status, state: { kind: 'canvas', html: '<p>doc</p>', title: 'Doc' } } }) as never;
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });

beforeEach(() => {
  currentAgent = 'a-1';
  vi.mocked(api.getCanvas).mockReset();
  vi.mocked(api.setCanvasStatus).mockReset();
});

describe('right dock and failed canvas calls', () => {
  it('(a) a failed canvas load leaves the open canvas on screen', async () => {
    vi.mocked(api.getCanvas).mockResolvedValue(persisted('open'));
    const view = render(tree());
    await waitFor(() => expect(dockApi.dock).not.toBeNull());
    vi.mocked(api.getCanvas).mockResolvedValue({ ok: false, error: 'blip' } as never);
    currentAgent = 'a-2';
    view.rerender(tree());
    await flush();
    expect(dockApi.dock, 'the open canvas vanished on a failed load').not.toBeNull();
  });

  it('(a2) a successful empty answer still clears the dock', async () => {
    vi.mocked(api.getCanvas).mockResolvedValue(persisted('open'));
    const view = render(tree());
    await waitFor(() => expect(dockApi.dock).not.toBeNull());
    vi.mocked(api.getCanvas).mockResolvedValue({ ok: true, data: null } as never);
    currentAgent = 'a-2';
    view.rerender(tree());
    await waitFor(() => expect(dockApi.dock).toBeNull());
  });

  it('(b) close() whose status post fails puts the canvas back', async () => {
    vi.mocked(api.getCanvas).mockResolvedValue(persisted('open'));
    vi.mocked(api.setCanvasStatus).mockResolvedValue({ ok: false, error: 'blip' } as never);
    render(tree());
    await waitFor(() => expect(dockApi.dock).not.toBeNull());
    act(() => { dockApi.close(); });
    await flush();
    expect(dockApi.dock, 'the screen says closed but the server says open').not.toBeNull();
    expect(dockApi.collapsed).toBeNull();
  });

  it('(c) reopen() whose status post fails goes back to the handle', async () => {
    vi.mocked(api.getCanvas).mockResolvedValue(persisted('collapsed'));
    vi.mocked(api.setCanvasStatus).mockResolvedValue({ ok: false, error: 'blip' } as never);
    render(tree());
    await waitFor(() => expect(dockApi.collapsed).not.toBeNull());
    act(() => { dockApi.reopen(); });
    await flush();
    expect(dockApi.dock, 'the screen says open but the server says collapsed').toBeNull();
    expect(dockApi.collapsed).not.toBeNull();
  });

  it('(d) a successful close stays closed', async () => {
    vi.mocked(api.getCanvas).mockResolvedValue(persisted('open'));
    vi.mocked(api.setCanvasStatus).mockResolvedValue({ ok: true, data: null } as never);
    render(tree());
    await waitFor(() => expect(dockApi.dock).not.toBeNull());
    act(() => { dockApi.close(); });
    await flush();
    expect(dockApi.dock).toBeNull();
    expect(dockApi.collapsed).not.toBeNull();
  });
});
