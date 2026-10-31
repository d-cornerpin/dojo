// The Google and Microsoft activity logs must not keep the old filter's rows when the new load
// fails, and an older answer landing late must not replace the newest one.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';

vi.mock('../lib/api', () => ({ request: vi.fn() }));

import { request } from '../lib/api';
import { GoogleActivityLog } from '../components/GoogleActivityLog';
import { MicrosoftActivityLog } from '../components/MicrosoftActivityLog';

const req = request as unknown as ReturnType<typeof vi.fn>;
const row = (id: string, action: string) => ({
  id, agentId: 'agent-0001', agentName: 'Test Agent', action, actionType: 'read', details: null, success: true, error: null, createdAt: '2026-10-30T10:00:00.000Z',
});
const rows = (...r: Array<[string, string]>) => ({ ok: true, data: r.map(([i, a]) => row(i, a)) });
const later = () => { let res: (v: unknown) => void = () => {}; const p = new Promise((r) => { res = r; }); return { p, res }; };

beforeEach(() => { vi.clearAllMocks(); });

const cases = [
  ['Google', GoogleActivityLog],
  ['Microsoft', MicrosoftActivityLog],
] as const;

describe.each(cases)('%s activity log', (_name, Log) => {
  const select = () => screen.getAllByRole('combobox')[0];

  it('(a) a failed reload under a new filter shows the error and drops the old rows', async () => {
    req.mockResolvedValueOnce(rows(['1', 'list_old_things']));
    render(<Log />);
    await screen.findByText('List Old Things');
    req.mockResolvedValueOnce({ ok: false, error: 'box down' });
    fireEvent.change(select(), { target: { value: 'write' } });
    await screen.findByText(/Could not load activity: box down/);
    expect(screen.queryByText('List Old Things')).toBeNull();
    expect(screen.queryByText('No activity yet.')).toBeNull();
  });

  it('(b) two loads resolved in reverse order: the newest rows win', async () => {
    const first = later();
    const second = later();
    req.mockReturnValueOnce(first.p).mockReturnValueOnce(second.p);
    render(<Log />);
    fireEvent.change(select(), { target: { value: 'write' } });
    await act(async () => { second.res(rows(['2', 'newest_rows'])); });
    await screen.findByText('Newest Rows');
    await act(async () => { first.res(rows(['1', 'older_rows'])); });
    await waitFor(() => expect(screen.queryByText('Newest Rows')).not.toBeNull());
    expect(screen.queryByText('Older Rows')).toBeNull();
  });
});
