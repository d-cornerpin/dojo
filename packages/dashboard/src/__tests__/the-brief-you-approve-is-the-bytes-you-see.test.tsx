// ════════════════════════════════════════════════════════════════════════════
// BYTE-TO-DOM CONSENT (DOJO-REPORT T6 §7, MIGRATED OUT OF PROSE).
//
// Owner ruling D4: *"the user sees the exact text before anything posts. No
// preview, no post."* T6 held every half of that it could reach — the route, the
// store, the exported file, and a static refusal of every renderer name it knew —
// and then wrote this row in its own report:
//
//   | that the brief's five fields actually reach the DOM unescaped-but-
//   | uninterpreted | needs a renderer to observe | **the one worth a DOM
//   | runner.** … nothing observes the pixels.
//
// This file is the renderer observing the pixels. The defect it refuses is
// precise and it is not hypothetical — it is the one `ReportPreviewCard`'s own
// header describes: a `<Markdown>` renderer would show *emphasis* where the text
// says `*emphasis*`, so the owner approves one thing and another is published.
// A static clause can refuse today's renderer imports by NAME; it cannot refuse
// tomorrow's, and it can never prove that the bytes on screen are the bytes in
// the brief.
//
// ── WHAT THIS FILE DELIBERATELY DOES NOT DO ──
// It does not write the consent sentence down. `postTargetSentence` is the one
// owner of that text (`lib/report-edits.ts`, driven by the server's suite), and
// T6's census refuses a second copy in the card; a second copy in the card's
// TEST would be the same claim with the same drift and no reader. So the
// expected sentence is COMPUTED from the real function, and what this file
// asserts is the half only a renderer can: that the card feeds that function the
// destination the LIST DOOR answered with, and puts the result on screen.
// ════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { postTargetSentence, type BriefFields } from '../lib/report-edits';
import { resetFrames, emitFrame, handlerCount } from './helpers/frames';

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

// ── THE FIXTURE: EVERY BYTE A RENDERER WOULD WANT TO EAT ─────────────────────
// Markdown-hostile on purpose, and no personal names anywhere: emphasis markers,
// a heading marker, list markers, a table pipe, a fenced span, an HTML tag, a
// markdown link, a script tag, runs of spaces and hard newlines. If any of it is
// INTERPRETED, the owner is reading something other than what gets published.
const BRIEF: BriefFields = {
  title: 'A *starred* title with <b>markup</b> and a `backtick` span',
  whatHappened: 'First line\nSecond line   with   runs   of   spaces\n# not a heading\n- not a list',
  whatShouldHaveHappened: 'It should show _literally_ this: [a link](https://example.invalid/page)',
  whyItWentWrong: 'A | table | row, and a <script>alert(1)</script> that must stay text',
  fixIdeas: '1. keep **stars** as stars\n2. keep <em>tags</em> as tags',
};

const DESTINATION = 'a-scratch-org/a-scratch-repo';
const ACCOUNT = 'an-example-account';
const REPORT_ID = 'r-0001';

const row = (brief: BriefFields = BRIEF): api.ReportRow => ({
  id: REPORT_ID, agentId: 'a-0001', status: 'awaiting_approval',
  lane: 'chat', signature: 'sig-0001', brief: { ...brief },
  telemetry: { version: '0.0.0-test' }, bundlePath: null,
  createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z',
  approvedAt: null, postedAt: null, issueUrl: null, issueNumber: null, exportPath: null,
});

const githubStatus = (connected: boolean): api.GithubStatus => ({
  connected, login: connected ? ACCOUNT : null, scope: 'public_repo',
  connectedAt: null, lastOkAt: null, lastError: null, reauthRequired: false,
  clientIdConfigured: true, loginInProgress: false, userCode: null, verificationUri: null,
});

const mocked = () => vi.mocked(api);

beforeEach(() => {
  resetFrames();
  mocked().listOpenReports.mockResolvedValue({ ok: true, data: [row()], destinationRepo: DESTINATION });
  mocked().getGithubStatus.mockResolvedValue({ ok: true, data: githubStatus(true) });
});

afterEach(() => { vi.resetAllMocks(); });

/** Every element that promises to render its text verbatim, with its exact bytes. */
const verbatimTexts = (root: HTMLElement): string[] =>
  Array.from(root.querySelectorAll('.whitespace-pre-wrap')).map((e) => e.textContent ?? '');

describe('the brief the owner approves is the brief the owner was shown', () => {
  it('puts all five fields in the DOM byte for byte, runs of spaces and newlines included', async () => {
    const { container } = render(<ReportPreviewCard />);
    await screen.findByText(BRIEF.title);

    const texts = verbatimTexts(container as HTMLElement);
    for (const [field, value] of Object.entries(BRIEF)) {
      expect(texts, `${field} must reach the DOM unchanged`).toContain(value);
    }
  });

  it('interprets none of it — no renderer turned a marker into an element', async () => {
    const { container } = render(<ReportPreviewCard />);
    await screen.findByText(BRIEF.title);

    // The markers are present as TEXT…
    expect(container.textContent).toContain('*starred*');
    expect(container.textContent).toContain('<b>markup</b>');
    expect(container.textContent).toContain('<script>alert(1)</script>');
    expect(container.textContent).toContain('[a link](https://example.invalid/page)');

    // …and each field is ONE text node with nothing built inside it. This is the
    // tightest form of the rule: a renderer cannot turn a marker into an element
    // without putting that element in here.
    const nodes = Array.from(container.querySelectorAll('.whitespace-pre-wrap'));
    for (const [field, value] of Object.entries(BRIEF)) {
      const el = nodes.find((n) => n.textContent === value);
      expect(el, `${field} is not rendered verbatim`).toBeDefined();
      expect(el!.querySelectorAll('*').length, `${field} had structure built inside it`).toBe(0);
    }

    // And card-wide, no renderer output at all. (`h3` is NOT in this list on
    // purpose: the card's own "A problem report is waiting for you" header is an
    // h3 by design — chrome the owner's bytes never reach.)
    for (const tag of ['b', 'em', 'strong', 'code', 'script', 'li', 'a']) {
      expect(container.querySelectorAll(tag).length, `a <${tag}> was built from the brief`).toBe(0);
    }
  });

  it('names the destination the LIST DOOR answered with, never a constant', async () => {
    render(<ReportPreviewCard />);
    const expected = postTargetSentence({
      connected: true, login: ACCOUNT, loginInProgress: false, repo: DESTINATION,
    });
    expect(await screen.findByText(expected)).toBeDefined();
  });

  it('says a FILE will be written when the box is not connected — the other consent branch', async () => {
    mocked().getGithubStatus.mockResolvedValue({ ok: true, data: githubStatus(false) });
    render(<ReportPreviewCard />);
    const expected = postTargetSentence({
      connected: false, login: null, loginInProgress: false, repo: DESTINATION,
    });
    expect(await screen.findByText(expected)).toBeDefined();
  });

  it('posts the report it showed, through the one door, once — and sends no choice unasked', async () => {
    mocked().approveReport.mockResolvedValue({
      ok: true,
      data: { status: 'posted', issueUrl: 'https://example.invalid/issues/1', issueNumber: 1, exportPath: null },
    });
    render(<ReportPreviewCard />);
    await screen.findByText(BRIEF.title);

    fireEvent.click(screen.getByRole('button', { name: 'Post' }));

    await waitFor(() => expect(mocked().approveReport).toHaveBeenCalledTimes(1));
    expect(mocked().approveReport).toHaveBeenCalledWith(REPORT_ID, undefined);
    expect(mocked().editReportBrief).not.toHaveBeenCalled();
    expect(mocked().cancelReport).not.toHaveBeenCalled();
  });

  it('sends ONLY the field the owner actually changed, and re-renders the new bytes verbatim', async () => {
    const edited = 'A rewritten reason\nwith its own   spacing and *stars*';
    mocked().editReportBrief.mockResolvedValue({ ok: true, data: row({ ...BRIEF, whyItWentWrong: edited }) });
    const { container } = render(<ReportPreviewCard />);
    await screen.findByText(BRIEF.title);

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const box = screen.getByDisplayValue(BRIEF.whyItWentWrong);
    fireEvent.change(box, { target: { value: edited } });

    // The list door now answers with the saved row, which is what the card re-reads.
    mocked().listOpenReports.mockResolvedValue({
      ok: true, data: [row({ ...BRIEF, whyItWentWrong: edited })], destinationRepo: DESTINATION,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(mocked().editReportBrief).toHaveBeenCalledTimes(1));
    expect(mocked().editReportBrief).toHaveBeenCalledWith(REPORT_ID, { whyItWentWrong: edited });
    // SAVING IS NEVER APPROVING.
    expect(mocked().approveReport).not.toHaveBeenCalled();
    // And what comes back on screen is the edited bytes, not a re-rendered guess.
    await waitFor(() => expect(verbatimTexts(container as HTMLElement)).toContain(edited));
  });

  it('shows the file path and the prefilled link when nothing was posted (T6 §7, the delivery panel)', async () => {
    const exportPath = '/tmp/a-scratch-home/.dojo/reports/r-0001/report.md';
    const newIssueUrl = 'https://example.invalid/a-scratch-org/a-scratch-repo/issues/new?title=a+title';
    mocked().approveReport.mockResolvedValue({
      ok: true,
      data: { status: 'exported', issueUrl: null, issueNumber: null, exportPath, newIssueUrl },
    });
    const { container } = render(<ReportPreviewCard />);
    await screen.findByText(BRIEF.title);

    fireEvent.click(screen.getByRole('button', { name: 'Post' }));

    expect(await screen.findByText(exportPath)).toBeDefined();
    const link = await screen.findByRole('link', { name: 'Open a new issue with this text' });
    expect(link.getAttribute('href')).toBe(newIssueUrl);
    // The row has left the card: the answer is held until the owner dismisses it.
    expect(container.textContent).not.toContain(BRIEF.title);
  });

  it('subscribes to both report frames, refetches on each, and unsubscribes on unmount', async () => {
    const { unmount } = render(<ReportPreviewCard />);
    await screen.findByText(BRIEF.title);
    expect(mocked().listOpenReports).toHaveBeenCalledTimes(1);

    emitFrame('report:pending', { id: REPORT_ID });
    await waitFor(() => expect(mocked().listOpenReports).toHaveBeenCalledTimes(2));
    emitFrame('report:resolved', { id: REPORT_ID });
    await waitFor(() => expect(mocked().listOpenReports).toHaveBeenCalledTimes(3));

    unmount();
    expect(handlerCount('report:pending')).toBe(0);
    expect(handlerCount('report:resolved')).toBe(0);
  });
});
