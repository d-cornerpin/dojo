// ════════════════════════════════════════════════════════════════════════════
// T198 / E2 — THE REPORT CARD OFFERS "CONNECT GITHUB" AND A COPY BUTTON (GitHub #11 / #15).
//
// On a box with no GitHub connection the card used to say "saved as a file" and hand the owner
// a path to find. Now:
//   * the card offers Connect GitHub (the existing device flow) with one plain sentence about
//     what it grants, and once connected the consent sentence flips and Post files through GitHub;
//   * the delivered panel for a report that left as a link has a Copy button that puts the full
//     text on the clipboard, and shows no file path.
// ════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import * as edits from '../lib/report-edits';
import { postTargetSentence } from '../lib/report-edits';
import { resetFrames, emitFrame } from './helpers/frames';

vi.mock('../lib/api');
vi.mock('../hooks/useWebSocket', async () => {
  const { fakeUseWebSocket } = await import('./helpers/frames');
  return { useWebSocket: fakeUseWebSocket };
});
vi.mock('../hooks/useToast', async () => {
  const { fakeToast } = await import('./helpers/frames');
  const stub = fakeToast();
  return { useToast: () => stub.value };
});

import * as api from '../lib/api';
import { ReportPreviewCard } from '../components/ReportPreviewCard';
import { DeliveredPanel } from '../components/ReportDeliveryPanel';

const REPO = 'a-scratch-org/a-scratch-repo';
const FULL_TEXT = '**Filed from a Dojo**\n\nThe whole report, markdown and all.\n\ndojo-sig: ds2-aaaaaaaaaaaa';
const mocked = () => vi.mocked(api);

const status = (over: Partial<api.GithubStatus> = {}): api.GithubStatus => ({
  connected: false, login: null, scope: null, connectedAt: null, lastOkAt: null, lastError: null,
  reauthRequired: false, clientIdConfigured: true, loginInProgress: false, userCode: null,
  verificationUri: null, ...over,
});

const row = (): api.ReportRow => ({
  id: 'r-0001', agentId: 'a-0001', status: 'awaiting_approval', lane: 'chat', signature: 'ds2-aaaaaaaaaaaa',
  brief: {
    title: 'A title', whatHappened: 'What happened', whatShouldHaveHappened: 'What should have',
    whyItWentWrong: 'Why', fixIdeas: 'Ideas',
  },
  telemetry: null, bundlePath: null, createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z',
  approvedAt: null, postedAt: null, issueUrl: null, issueNumber: null, exportPath: null,
});

const mountCard = async (gh: api.GithubStatus) => {
  mocked().listOpenReports.mockResolvedValue({ ok: true, data: [row()], destinationRepo: REPO });
  mocked().getGithubStatus.mockResolvedValue({ ok: true, data: gh });
  render(<ReportPreviewCard />);
  await screen.findByText('A title');
};

let written: string[] = [];
beforeEach(() => {
  resetFrames();
  written = [];
  Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn(async (t: string) => { written.push(t); }) }, configurable: true,
  });
});
afterEach(() => { vi.resetAllMocks(); });

describe('an unconnected box is offered Connect GitHub on the report card', () => {
  it('shows a Connect button and says plainly what it grants, from the lib', async () => {
    await mountCard(status());
    expect(screen.getByRole('button', { name: 'Connect GitHub' })).toBeDefined();
    const sentence = (edits as unknown as { connectOfferSentence?: () => string }).connectOfferSentence?.();
    expect(sentence, 'the lib has no connect-offer sentence').toBeTypeOf('string');
    expect(screen.getByText(sentence as string)).toBeDefined();
    expect(sentence).toContain('public_repo');
  });

  it('offers nothing to connect when the box has no GitHub app configured', async () => {
    await mountCard(status({ clientIdConfigured: false }));
    expect(screen.queryByRole('button', { name: 'Connect GitHub' })).toBeNull();
  });

  it('is not offered on a box that is already connected', async () => {
    await mountCard(status({ connected: true, login: 'an-example-account', scope: 'public_repo' }));
    expect(screen.queryByRole('button', { name: 'Connect GitHub' })).toBeNull();
  });

  it('pressing it starts the existing sign-in and shows the code to type', async () => {
    await mountCard(status());
    mocked().connectGithub.mockResolvedValue({
      ok: true, data: { userCode: 'ABCD-1234', verificationUri: 'https://example.invalid/device', expiresAt: 0, intervalMs: 5000 },
    });
    mocked().getGithubStatus.mockResolvedValue({
      ok: true, data: status({ loginInProgress: true, userCode: 'ABCD-1234', verificationUri: 'https://example.invalid/device' }),
    });
    fireEvent.click(screen.getByRole('button', { name: 'Connect GitHub' }));
    await waitFor(() => expect(mocked().connectGithub).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('ABCD-1234')).toBeDefined();
    expect(screen.getByRole('link', { name: 'https://example.invalid/device' })).toBeDefined();
  });

  it('once connected the consent sentence flips and Post goes to the one door', async () => {
    await mountCard(status());
    expect(screen.getByText(postTargetSentence({ connected: false, login: null, loginInProgress: false, repo: REPO }))).toBeDefined();
    mocked().getGithubStatus.mockResolvedValue({
      ok: true, data: status({ connected: true, login: 'an-example-account', scope: 'public_repo' }),
    });
    await act(async () => { emitFrame('github:connected', { login: 'an-example-account' }); });
    const flipped = postTargetSentence({ connected: true, login: 'an-example-account', loginInProgress: false, repo: REPO });
    expect(await screen.findByText(flipped)).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Connect GitHub' })).toBeNull();
    mocked().approveReport.mockResolvedValue({
      ok: true, data: { status: 'posted', issueUrl: 'https://example.invalid/issues/1', issueNumber: 1, exportPath: null },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Post' }));
    await waitFor(() => expect(mocked().approveReport).toHaveBeenCalledWith('r-0001', undefined));
  });

  it('a refused sign-in says so instead of spinning', async () => {
    await mountCard(status());
    mocked().connectGithub.mockResolvedValue({ ok: false, error: 'GitHub would not start a sign-in right now.' });
    fireEvent.click(screen.getByRole('button', { name: 'Connect GitHub' }));
    expect(await screen.findByText('GitHub would not start a sign-in right now.')).toBeDefined();
  });
});

describe('a report that left as a link has a Copy button and no file to find', () => {
  const delivery = (over: Partial<api.ReportDelivery> = {}): api.ReportDelivery => ({
    status: 'posted', issueUrl: null, issueNumber: null,
    exportPath: '/an/example/home/dir/reports/r-1/report.md',
    newIssueUrl: 'https://example.invalid/issues/new?title=t', bodyWasTrimmed: true, reportText: FULL_TEXT, ...over,
  });

  it('Copy report writes the full text, byte for byte, to the clipboard', async () => {
    render(<DeliveredPanel delivery={delivery()} onDone={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy report' }));
    await waitFor(() => expect(written).toEqual([FULL_TEXT]));
    expect(await screen.findByText('Copied')).toBeDefined();
  });

  it('does not show the local file path anywhere', () => {
    const { container } = render(<DeliveredPanel delivery={delivery()} onDone={() => {}} />);
    expect(container.textContent).not.toContain('/an/example/home/dir');
    expect(container.textContent?.toLowerCase()).not.toContain('saved on this mac');
  });

  it('still links to the new issue, and a posted report has no Copy button', () => {
    const { unmount } = render(<DeliveredPanel delivery={delivery()} onDone={() => {}} />);
    expect(screen.getByRole('link', { name: 'Open GitHub to paste it' }).getAttribute('href'))
      .toBe('https://example.invalid/issues/new?title=t');
    unmount();
    render(<DeliveredPanel delivery={delivery({ issueUrl: 'https://example.invalid/issues/9', exportPath: null })} onDone={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Copy report' })).toBeNull();
  });
});
