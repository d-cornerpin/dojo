// The technique Files/Usage/Versions tabs must tell the truth: the latest click
// wins, a failed read never shows another file's text, and a failed load is not
// an honest-looking empty record.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

type Answer = { ok: boolean; data?: unknown; error?: string };
const server = vi.hoisted(() => ({
  pending: new Map<string, (a: unknown) => void>(),
  fixed: new Map<string, unknown>(),
}));
vi.mock('../lib/api', () => ({
  request: vi.fn((path: string) => {
    if (server.fixed.has(path)) return Promise.resolve(server.fixed.get(path));
    return new Promise((resolve) => { server.pending.set(path, resolve); });
  }),
}));

import { FilesTab, UsageTab, VersionsTab } from '../components/TechniqueDetailTabs';

const technique = {
  id: 't1',
  files: [
    { path: 'a.md', size: 1, isDirectory: false },
    { path: 'b.md', size: 1, isDirectory: false },
  ],
};
const answer = (path: string, a: Answer) => server.pending.get(`/techniques${path}`)!(a);

beforeEach(() => { server.pending.clear(); server.fixed.clear(); });

describe('technique tabs tell the truth', () => {
  it('shows the latest click even when the older read answers last', async () => {
    render(<FilesTab technique={technique} />);
    fireEvent.click(screen.getByText(/a\.md/));
    fireEvent.click(screen.getByText(/b\.md/));
    answer('/t1/files/b.md', { ok: true, data: { content: 'TEXT OF B' } });
    await screen.findByText('TEXT OF B');
    answer('/t1/files/a.md', { ok: true, data: { content: 'TEXT OF A' } });
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText('TEXT OF A')).toBeNull();
    expect(screen.getByText('TEXT OF B')).toBeTruthy();
  });

  it('a failed read shows the error, not the previous file', async () => {
    render(<FilesTab technique={technique} />);
    fireEvent.click(screen.getByText(/a\.md/));
    answer('/t1/files/a.md', { ok: true, data: { content: 'TEXT OF A' } });
    await screen.findByText('TEXT OF A');
    fireEvent.click(screen.getByText(/b\.md/));
    answer('/t1/files/b.md', { ok: false, error: 'disk gone' });
    await screen.findByText(/disk gone/);
    expect(screen.queryByText('TEXT OF A')).toBeNull();
  });

  it('a failed usage load says so with Retry, not "No usage recorded yet."', async () => {
    server.fixed.set('/techniques/t1/usage', { ok: false, error: 'db busy' });
    render(<UsageTab techniqueId="t1" />);
    await screen.findByText(/Could not load usage: db busy/);
    expect(screen.getByText('Retry')).toBeTruthy();
    expect(screen.queryByText('No usage recorded yet.')).toBeNull();
  });

  it('a failed versions load says so with Retry', async () => {
    server.fixed.set('/techniques/t1/versions', { ok: false, error: 'db busy' });
    render(<VersionsTab techniqueId="t1" />);
    await screen.findByText(/Could not load versions: db busy/);
    expect(screen.getByText('Retry')).toBeTruthy();
  });

  it('Retry asks again and shows the rows', async () => {
    server.fixed.set('/techniques/t1/usage', { ok: false, error: 'db busy' });
    render(<UsageTab techniqueId="t1" />);
    await screen.findByText(/db busy/);
    server.fixed.set('/techniques/t1/usage', { ok: true, data: [{ id: 'u1', agentId: 'abcdefghij', agentName: 'Worker', usedAt: '2026-10-27T00:00:00.000Z', success: true, notes: null }] });
    fireEvent.click(screen.getByText('Retry'));
    await waitFor(() => expect(screen.getByText('Worker')).toBeTruthy());
  });
});
