// ════════════════════════════════════════════════════════════════════════════
// A FORENSIC PURGE TELLS THE OWNER WHAT IT COULD NOT DELETE.
//
// After a purge the panel stores "Purged x of y — k failed" and re-runs the
// search so the table reflects the deletions. That re-search must not wipe the
// stored result: otherwise a purge where some items were locked looks exactly
// like a clean one. A fresh manual search must still clear the line.
// The server is a scripted `request`.
// ════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../lib/api');
  return {
    ...actual,
    request: vi.fn(async (path: string) =>
      path.startsWith('/memory/forensic-search')
        ? {
            ok: true,
            data: {
              query: 'typo',
              total: 2,
              hits: [
                { kind: 'vault', id: 'v1', agentId: 'a', title: 'one', preview: 'typo here', createdAt: null },
                { kind: 'vault', id: 'v2', agentId: 'a', title: 'two', preview: 'typo there', createdAt: null },
              ],
            },
          }
        : {
            ok: true,
            data: {
              deleted: 1,
              total: 2,
              results: [
                { kind: 'vault', id: 'v1', deleted: true },
                { kind: 'vault', id: 'v2', deleted: false, error: 'locked' },
              ],
            },
          },
    ),
  };
});

import { ForensicSearchPanel } from '../components/ForensicSearchPanel';

const searchBox = (): HTMLInputElement => screen.getByPlaceholderText(/exact substring/i) as HTMLInputElement;
const searchButton = (): HTMLElement => screen.getByRole('button', { name: 'Search' });

/** Render, search `typo`, wait for the two hits, select them all, purge them all,
 *  and wait for the re-search that follows the purge to land (the selection is back to none). */
async function searchAndPurgeBoth(): Promise<void> {
  render(<ForensicSearchPanel />);
  fireEvent.change(searchBox(), { target: { value: 'typo' } });
  fireEvent.click(searchButton());
  await screen.findByText('one');
  await screen.findByText('two');
  fireEvent.click(screen.getByRole('button', { name: 'Select all' }));
  fireEvent.click(screen.getByRole('button', { name: 'Purge 2 selected' }));
  await screen.findByRole('button', { name: 'Purge 0 selected' });
}

beforeEach(() => {
  vi.stubGlobal('confirm', () => true);
});

describe('the forensic purge result', () => {
  it('the purge result line survives the re-search that follows the purge', async () => {
    await searchAndPurgeBoth();
    await screen.findByText(/Purged 1 of 2/);
    expect(screen.getByText(/1 failed\./)).toBeTruthy();
  });

  it('a fresh manual search clears the purge result line', async () => {
    await searchAndPurgeBoth();
    fireEvent.click(searchButton());
    await waitFor(() => expect(screen.queryByText(/Purged 1 of 2/)).toBeNull());
  });
});
