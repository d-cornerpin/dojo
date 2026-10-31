// A briefing that could not be read is not "no briefing": Retry, not Generate. A late answer for another
// agent never lands, an edit names the briefing it was built on, and Regenerate asks first when the owner
// edited the text.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

const getBriefing = vi.hoisted(() => vi.fn());
const updateBriefing = vi.hoisted(() => vi.fn());
const regenerateBriefing = vi.hoisted(() => vi.fn());
vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../lib/api');
  return { ...actual, getBriefing, updateBriefing, regenerateBriefing };
});

import { BriefingView } from '../components/BriefingView';

const brief = (id: string, content: string, editedByOwner = false) => ({
  ok: true, data: { id, agentId: 'x', content, tokenCount: 3, generatedAt: '2026-01-01T00:00:00Z', editedByOwner },
});

beforeEach(() => { getBriefing.mockReset(); updateBriefing.mockReset(); regenerateBriefing.mockReset(); vi.restoreAllMocks(); });

describe('the briefing view', () => {
  it('a failed read offers Retry, never Generate', async () => {
    getBriefing.mockResolvedValue({ ok: false, error: 'down' });
    render(<BriefingView agentId="a" />);
    await screen.findByText('Retry');
    expect(screen.queryByText('Generate Briefing')).toBeNull();
    expect(regenerateBriefing).not.toHaveBeenCalled();
  });

  it('only a successful empty answer offers Generate', async () => {
    getBriefing.mockResolvedValue({ ok: true, data: null });
    render(<BriefingView agentId="a" />);
    await screen.findByText('Generate Briefing');
  });

  it('a late answer for the old agent never lands', async () => {
    let resolveA!: (v: unknown) => void;
    getBriefing.mockImplementation((id: string) => id === 'a' ? new Promise((r) => { resolveA = r; }) : Promise.resolve(brief('b1', 'B-TEXT')));
    const { rerender } = render(<BriefingView agentId="a" />);
    rerender(<BriefingView agentId="b" />);
    await screen.findByText('B-TEXT');
    await act(async () => { resolveA(brief('a1', 'A-TEXT')); await Promise.resolve(); });
    expect(screen.queryByText('A-TEXT')).toBeNull();
    expect(screen.getByText('B-TEXT')).toBeTruthy();
  });

  it('an edit names the briefing it was built on', async () => {
    getBriefing.mockResolvedValue(brief('b1', 'TEXT'));
    updateBriefing.mockResolvedValue({ ok: true, data: undefined });
    render(<BriefingView agentId="a" />);
    fireEvent.click(await screen.findByText('Edit'));
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(updateBriefing).toHaveBeenCalled());
    expect(updateBriefing.mock.calls[0]).toEqual(['a', 'TEXT', 'b1']);
  });

  it('Regenerate asks before discarding the owner edits, and does nothing on No', async () => {
    getBriefing.mockResolvedValue(brief('b1', 'MINE', true));
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<BriefingView agentId="a" />);
    fireEvent.click(await screen.findByText('Regenerate'));
    expect(confirm).toHaveBeenCalled();
    expect(regenerateBriefing).not.toHaveBeenCalled();
  });
});
