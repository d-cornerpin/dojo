import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const request = vi.fn();
const toastError = vi.fn();
vi.mock('../lib/api', () => ({
  request: (...a: unknown[]) => request(...a),
  requestForm: vi.fn(),
}));
vi.mock('../hooks/useWebSocket', () => ({
  useWebSocket: () => ({ subscribe: () => () => undefined, reconnectCount: 0 }),
}));
const toastStub = { error: toastError, info: vi.fn(), warning: vi.fn(), success: vi.fn() };
vi.mock('../hooks/useToast', () => ({ useToast: () => toastStub }));

import { Techniques } from '../pages/Techniques';

const tech = (id: string, tags: string[]) => ({
  id, name: `Tech ${id}`, description: 'd', state: 'published', tags, authorAgentName: 'A',
  enabled: true, usageCount: 0, lastUsedAt: null, version: 1, createdAt: '2026-01-01T00:00:00Z',
});
const ALL = [tech('t1', ['x']), tech('t2', ['y'])];

function serve(opts: { putOk?: boolean } = {}) {
  request.mockImplementation(async (path: string, init?: { method?: string }) => {
    if (init?.method === 'PUT') return opts.putOk === false ? { ok: false, error: 'refused' } : { ok: true, data: {} };
    const q = new URLSearchParams(path.split('?')[1] ?? '');
    const tag = q.get('tag'); const search = q.get('search');
    let rows = ALL;
    if (tag) rows = rows.filter((t) => t.tags.includes(tag));
    if (search) rows = rows.filter((t) => t.name.includes(search));
    return { ok: true, data: rows };
  });
}
const view = () => render(<MemoryRouter><Techniques /></MemoryRouter>);

beforeEach(() => { request.mockReset(); toastError.mockReset(); });

describe('Techniques page tells the truth', () => {
  it('a refused toggle leaves the switch as it was and shows the error', async () => {
    serve({ putOk: false });
    view();
    const sw = (await screen.findAllByRole('button', { name: 'Enabled' }))[0];
    expect(sw.className).toContain('is-on');
    fireEvent.click(sw);
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('refused'));
    expect(screen.getAllByRole('button', { name: 'Enabled' })[0].className).toContain('is-on');
  });

  it('an accepted toggle flips the switch', async () => {
    serve();
    view();
    fireEvent.click((await screen.findAllByRole('button', { name: 'Enabled' }))[0]);
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Enabled' })[0].className).not.toContain('is-on'));
  });

  it('with one tag chosen the other tags are still offered', async () => {
    serve();
    view();
    const select = (await screen.findByLabelText('Tag filter')) as HTMLSelectElement;
    await waitFor(() => expect(select.options.length).toBe(3));
    fireEvent.change(select, { target: { value: 'x' } });
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Enabled' })).toHaveLength(1));
    const after = screen.getByLabelText('Tag filter') as HTMLSelectElement;
    expect([...after.options].map((o) => o.value)).toContain('y');
  });

  it('a search that matches nothing says so and Clear filters restores the list', async () => {
    serve();
    view();
    await screen.findAllByRole('button', { name: 'Enabled' });
    fireEvent.change(screen.getByLabelText('Search techniques'), { target: { value: 'nomatch' } });
    expect(await screen.findByText('No techniques match these filters.')).toBeTruthy();
    expect(screen.queryByText('No techniques yet')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Enabled' })).toHaveLength(2));
  });

  it('no filters and nothing yet still says "No techniques yet"', async () => {
    request.mockResolvedValue({ ok: true, data: [] });
    view();
    expect(await screen.findByText('No techniques yet')).toBeTruthy();
  });
});
