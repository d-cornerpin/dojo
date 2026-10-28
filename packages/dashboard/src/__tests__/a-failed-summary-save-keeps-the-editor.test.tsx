// A failed summary save keeps the editor: the error renders INSIDE the panel,
// not by replacing it, so the text the owner typed survives a failed save.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import * as api from '../lib/api';
import { SummaryDetail } from '../components/SummaryDetail';

const detail = {
  id: 's1',
  agentId: 'a',
  depth: 0,
  kind: 'leaf',
  content: 'original text',
  tokenCount: 5,
  earliestAt: '2026-01-01 00:00:00',
  latestAt: '2026-01-01 00:00:00',
  descendantCount: 1,
  createdAt: '2026-01-01 00:00:00',
  parentIds: [],
  childIds: [],
  sourceMessageIds: [],
};

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../lib/api');
  return {
    ...actual,
    getSummaryDetail: vi.fn(),
    updateSummary: vi.fn(),
  };
});

const editAndSave = async (onUpdated: () => void) => {
  render(<SummaryDetail summaryId="s1" agentId="a" onDeleted={() => {}} onUpdated={onUpdated} onSelect={() => {}} />);
  await waitFor(() => expect(screen.getByText('original text')).toBeTruthy());
  fireEvent.click(screen.getByRole('button', { name: /edit/i }));
  fireEvent.change(screen.getByRole('textbox') as HTMLTextAreaElement, { target: { value: 'my edit' } });
  fireEvent.click(screen.getByRole('button', { name: /save/i }));
};

beforeEach(() => {
  vi.mocked(api.getSummaryDetail).mockResolvedValue({ ok: true, data: detail } as never);
});

describe('a failed summary save', () => {
  it('shows the error inside the panel and keeps the editor with the typed text', async () => {
    vi.mocked(api.updateSummary).mockResolvedValue({ ok: false, error: 'locked by another writer' } as never);
    await editAndSave(() => {});
    await waitFor(() => expect(screen.getByText('locked by another writer')).toBeTruthy());
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('my edit');
    expect(screen.getByRole('button', { name: /save/i })).toBeTruthy();
  });

  it('a successful save closes the editor as before', async () => {
    vi.mocked(api.updateSummary).mockResolvedValue({ ok: true, data: { ...detail, content: 'my edit' } } as never);
    const onUpdated = vi.fn();
    await editAndSave(onUpdated);
    await waitFor(() => expect(onUpdated).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull());
  });
});
