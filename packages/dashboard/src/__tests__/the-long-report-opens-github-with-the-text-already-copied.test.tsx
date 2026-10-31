// 916: a report too long for a link is copied AND GitHub opened by one click.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../lib/api');
vi.mock('../lib/clipboard', () => ({ copyTextToClipboard: vi.fn() }));

import type * as api from '../lib/api';
import { copyTextToClipboard } from '../lib/clipboard';
import { DeliveredPanel } from '../components/ReportDeliveryPanel';

const TEXT = 'A made-up long report body.\nSecond line.';
const URL_NEW = 'https://example.invalid/issues/new?title=t';
const delivery = (over: Partial<api.ReportDelivery> = {}): api.ReportDelivery => ({
  status: 'posted', issueUrl: null, issueNumber: null, exportPath: null,
  newIssueUrl: URL_NEW, bodyWasTrimmed: true, reportText: TEXT, ...over,
});

let openSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.mocked(copyTextToClipboard).mockReset().mockResolvedValue(true);
  openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
});
afterEach(() => { openSpy.mockRestore(); });

describe('one click copies the long report and opens GitHub', () => {
  it('copies the report text, opens the new-issue page once, and says to paste', async () => {
    render(<DeliveredPanel delivery={delivery()} onDone={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy the report and open GitHub' }));
    expect(copyTextToClipboard).toHaveBeenCalledWith(TEXT);
    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(openSpy).toHaveBeenCalledWith(URL_NEW, '_blank', 'noopener,noreferrer');
    expect(await screen.findByText('The report is copied. Paste it into the new issue.')).toBeDefined();
  });

  it('when the copy fails GitHub still opens and the text stays selectable', async () => {
    vi.mocked(copyTextToClipboard).mockResolvedValue(false);
    render(<DeliveredPanel delivery={delivery()} onDone={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy the report and open GitHub' }));
    expect(openSpy).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByDisplayValue(/A made-up long report body/)).toBeDefined());
    expect(screen.queryByText('The report is copied. Paste it into the new issue.')).toBeNull();
  });

  it('a report that fit in the link has no such button', () => {
    render(<DeliveredPanel delivery={delivery({ bodyWasTrimmed: false })} onDone={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Copy the report and open GitHub' })).toBeNull();
  });
});
