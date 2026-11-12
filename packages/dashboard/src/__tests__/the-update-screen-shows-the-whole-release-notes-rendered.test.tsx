// The update screen shows the release notes whole, rendered as formatted text, and fetches
// no link previews for the links inside them.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../lib/api');
  const stub: Record<string, unknown> = {};
  for (const key of Object.keys(actual)) {
    stub[key] = typeof actual[key] === 'function' ? vi.fn(async () => ({ ok: false, error: 'not in this test' })) : actual[key];
  }
  return stub;
});
vi.mock('../components/DataBackupNotice', () => ({ DataBackupNotice: () => null }));
vi.mock('../components/DiskSpaceNotice', () => ({ DiskSpaceNotice: () => null }));

import * as api from '../lib/api';
import { UpdateTab } from '../components/settings/UpdateTab';

const mocked = () => vi.mocked(api);
const filler = Array.from({ length: 40 }, (_, i) => `- change number ${i} with enough words to fill the notes`).join('\n');
const NOTES = `## What is new\n\nThis release is **faster**, see https://example.com/notes.\n\n${filler}\n\nThe very last line of the notes.`;

beforeEach(() => {
  mocked().getDbBackupStatus.mockResolvedValue({ ok: true, data: { backup: null } } as never);
  mocked().listReleases.mockResolvedValue({ ok: true, data: { currentVersion: '1.0.0', releases: [] } } as never);
  mocked().getUpdateChannel.mockResolvedValue({ ok: true, data: { channel: 'stable' } } as never);
  mocked().checkForUpdates.mockResolvedValue({ ok: true, data: { currentVersion: '1.0.0', latestVersion: '1.1.0', updateAvailable: true, channel: 'stable', releaseNotes: NOTES } } as never);
});

describe('the update screen shows the whole release notes, rendered', () => {
  it('renders headings, lists and bold, keeps the last line, and fetches no preview', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    expect(NOTES.length).toBeGreaterThan(2000);
    render(<UpdateTab />);
    await waitFor(() => expect(screen.getByText('The very last line of the notes.')).toBeTruthy());
    expect(screen.getByRole('heading', { name: 'What is new' })).toBeTruthy();
    expect(screen.getAllByRole('listitem')).toHaveLength(40);
    expect(screen.getByText('faster').tagName).toBe('STRONG');
    expect(document.body.textContent).not.toMatch(/##|\*\*/);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
