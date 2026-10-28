// ════════════════════════════════════════════════════════════════════════════
// DELETING THE LAST CONTACT ON A PAGE STEPS THE PANEL BACK A PAGE.
//
// ── THE DEFECT ──
// The panel pages 50 at a time, and every save or delete reloads the SAME page
// number. The server does not clamp the offset — `LIMIT ? OFFSET ?` answers an
// empty list for an offset past the end — so with 51 contacts and page 2 holding
// the one remaining row, deleting it reloads page 2 and gets `contacts: []` with
// `total` down to exactly one page. The table then draws the "No contacts yet"
// empty state, and the pager — gated on `totalPages > 1` — is gone: the owner
// sees an empty list while 50 contacts still exist, with no control left to go
// back.
//
// The network door and the toast queue are replaced, per this package's runner.
// The list door answers from an in-memory array that the delete door edits, so
// offset, limit and total all move exactly as the real store moves them.
// ════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import type { ContactDto } from '../lib/api';

const store = vi.hoisted(() => ({ all: [] as ContactDto[] }));
const toasts = vi.hoisted(() => ({ info: [] as string[], success: [] as string[], error: [] as string[] }));

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../lib/api');
  return {
    ...actual,
    listContactsApi: vi.fn(async (params: { limit?: number; offset?: number } = {}) => {
      const limit = params.limit ?? 50;
      const offset = params.offset ?? 0;
      const slice = store.all.slice(offset, offset + limit);
      return { ok: true, data: { count: slice.length, total: store.all.length, contacts: slice } };
    }),
    deleteContactApi: vi.fn(async (id: string) => {
      const at = store.all.findIndex(c => c.id === id);
      if (at >= 0) store.all.splice(at, 1);
      return { ok: true, data: { deleted: true } };
    }),
  };
});
vi.mock('../hooks/useToast', () => ({
  useToast: () => ({
    info: (m: string) => { toasts.info.push(m); },
    success: (m: string) => { toasts.success.push(m); },
    error: (m: string) => { toasts.error.push(m); },
  }),
  ToastProvider: ({ children }: { children: ReactElement }) => children,
}));

import * as api from '../lib/api';
import { ContactsPanel } from '../components/ContactsPanel';

const contact = (i: number): ContactDto => ({
  id: 'c' + i,
  display_name: 'Contact ' + i,
  preferred_name: null,
  emails: [],
  phones: [],
  imessage_handles: [],
  company: null,
  role: null,
  tags: [],
  notes: null,
  created_at: '2026-01-01 00:00:00',
  updated_at: '2026-01-01 00:00:00',
  created_by_agent_id: null,
  last_updated_by_agent_id: null,
});

beforeEach(() => {
  store.all.length = 0;
  for (let i = 0; i < 51; i++) store.all.push(contact(i));
  vi.mocked(api.listContactsApi).mockClear();
  toasts.info.length = 0;
  toasts.success.length = 0;
  toasts.error.length = 0;
  vi.stubGlobal('confirm', () => true);
});

describe('a page emptied by a delete', () => {
  it('⚠ deleting the only contact on page 2 steps back to the last page that has rows', async () => {
    render(<ContactsPanel />);
    await waitFor(() => expect(screen.getByText('Contact 0')).toBeTruthy());

    // Page 2 holds the 51st contact alone.
    fireEvent.click(screen.getByRole('button', { name: /Last/ }));
    await waitFor(() => expect(screen.getByText('Contact 50')).toBeTruthy());

    // Open the drawer on that row and delete it.
    fireEvent.click(screen.getByText('Contact 50'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    // Let the reload the delete triggered draw — on either behaviour 'Contact 50'
    // is off screen by now; what differs is WHAT replaced it.
    await waitFor(() => expect(screen.queryByText('Contact 50')).toBeNull());

    expect(screen.queryByText(/No contacts yet/), 'the list is NOT empty — 50 contacts remain')
      .toBeNull();
    expect(screen.getByText('Contact 0'), 'the panel stepped back to page 1').toBeTruthy();
  });

  it('⚠ the reload the delete triggered asks for the last valid page, not the vanished one', async () => {
    render(<ContactsPanel />);
    await waitFor(() => expect(screen.getByText('Contact 0')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Last/ }));
    await waitFor(() => expect(screen.getByText('Contact 50')).toBeTruthy());
    fireEvent.click(screen.getByText('Contact 50'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    // Wait on the deleted row leaving the screen, not on a new page arriving:
    // ask the reload what it asked for the moment it has drawn, long before the
    // panel's own search debounce could fire.
    await waitFor(() => expect(screen.queryByText('Contact 50')).toBeNull());
    const lastParams = vi.mocked(api.listContactsApi).mock.calls.at(-1)?.[0];
    expect(lastParams?.offset).toBe(0);
  });
});
