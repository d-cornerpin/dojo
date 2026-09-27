// ════════════════════════════════════════════════════════════════════════════
// THE DUPLICATE QUESTION IS A QUESTION (DOJO-REPORT T7 §6, MIGRATED OUT OF PROSE).
//
// T7 §6, verbatim:
//
//   | **Unheld, and honestly so:** the card's JSX wiring for the duplicate panel
//   | (three buttons, three handlers) has no DOM runner, exactly like the rest of
//   | the card. The DECIDABLE half (`duplicateQuestion`, `parsePostChoice`, the
//   | route's three answers) is driven from the server suite; what is not driven
//   | is that pressing "Add to it" in a browser calls
//   | `handlePost({addToExisting})`.
//
// Pressing a button in a browser is what this file does. The reason it matters is
// the panel's own header: NOTHING HAS BEEN POSTED while this is on screen and the
// approval has been handed back, so all three answers are live decisions — and
// the one thing that must never happen is a button that publishes the wrong
// answer, or an answer nobody gave.
//
// `duplicateQuestion`'s sentence is not copied here; it is computed from the
// module the server's suite already drives.
// ════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { duplicateQuestion, type DuplicateMatch } from '../lib/report-edits';
import { resetFrames } from './helpers/frames';

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

const REPORT_ID = 'r-0002';
const MATCH: DuplicateMatch = {
  number: 41, url: 'https://example.invalid/a-scratch-org/a-scratch-repo/issues/41',
  title: 'The same problem, already filed',
};

const row = (): api.ReportRow => ({
  id: REPORT_ID, agentId: 'a-0001', status: 'awaiting_approval', lane: 'chat',
  signature: 'sig-0002',
  brief: {
    title: 'A title', whatHappened: 'What happened', whatShouldHaveHappened: 'What should have',
    whyItWentWrong: 'Why', fixIdeas: 'Ideas',
  },
  telemetry: null, bundlePath: null,
  createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z',
  approvedAt: null, postedAt: null, issueUrl: null, issueNumber: null, exportPath: null,
});

const mocked = () => vi.mocked(api);

/** Get to the duplicate panel the way an owner does: press Post and be asked. */
const askTheQuestion = async () => {
  mocked().listOpenReports.mockResolvedValue({ ok: true, data: [row()], destinationRepo: 'a-scratch-org/a-scratch-repo' });
  mocked().getGithubStatus.mockResolvedValue({
    ok: true,
    data: {
      connected: true, login: 'an-example-account', scope: 'public_repo', connectedAt: null,
      lastOkAt: null, lastError: null, reauthRequired: false, clientIdConfigured: true,
      loginInProgress: false, userCode: null, verificationUri: null,
    },
  });
  mocked().approveReport.mockResolvedValue({
    ok: true,
    data: { status: 'duplicate', issueUrl: null, issueNumber: null, exportPath: null, duplicate: MATCH },
  });
  render(<ReportPreviewCard />);
  await screen.findByText('A title');
  fireEvent.click(screen.getByRole('button', { name: 'Post' }));
  await screen.findByText(duplicateQuestion(MATCH));
  expect(mocked().approveReport).toHaveBeenCalledTimes(1);
};

beforeEach(() => { resetFrames(); });
afterEach(() => { vi.resetAllMocks(); });

describe('the duplicate question, answered in a browser', () => {
  it('asks before it posts, and links the issue it found', async () => {
    await askTheQuestion();
    const link = screen.getByRole('link', { name: 'Read it first' });
    expect(link.getAttribute('href')).toBe(MATCH.url);
    // The FIRST press carried no choice: the question is a question.
    expect(mocked().approveReport).toHaveBeenCalledWith(REPORT_ID, undefined);
  });

  it('"Add to it" sends the number of the issue it showed', async () => {
    await askTheQuestion();
    fireEvent.click(screen.getByRole('button', { name: 'Add to it' }));
    await waitFor(() => expect(mocked().approveReport).toHaveBeenCalledTimes(2));
    expect(mocked().approveReport).toHaveBeenLastCalledWith(REPORT_ID, { addToExisting: MATCH.number });
  });

  it('"Post separately" sends that, and never a number', async () => {
    await askTheQuestion();
    fireEvent.click(screen.getByRole('button', { name: 'Post separately' }));
    await waitFor(() => expect(mocked().approveReport).toHaveBeenCalledTimes(2));
    expect(mocked().approveReport).toHaveBeenLastCalledWith(REPORT_ID, { postSeparately: true });
  });

  it('"Not now" posts nothing at all and leaves the report waiting', async () => {
    await askTheQuestion();
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    // Back to the preview, with the report still on the card…
    expect(await screen.findByText('A title')).toBeDefined();
    // …and no second trip through the one door.
    expect(mocked().approveReport).toHaveBeenCalledTimes(1);
  });
});
