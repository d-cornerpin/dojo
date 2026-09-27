// ════════════════════════════════════════════════════════════════════════════
// THE FEED ASKS THE VISIBILITY RULE — THE DOM HALF OF LANE 6 / THE VISIBILITY LANE.
//
// ── THE DIVISION OF LABOUR, AND WHY THIS IS NOT A SECOND COPY ──
// `lib/working-note-visibility.ts` owns the three rules (R1 dimmed, R2 the
// narrowed RC-9 arm, R3 the duplicate) and is driven by 23 clauses in the server
// suite — because when it was written this package had no runner. Those clauses
// prove the VERDICT. They cannot prove that `pages/Chat.tsx` ASKS: the feed has
// two separate note arms (a prefixed `role='system'` row and a re-classified
// `role='assistant'` row with `displayKind='working-note'`), and a future edit
// that drops the call from one of them keeps every one of those 23 clauses green
// while the owner loses exactly what lane 6 measured — his agent's only words.
//
// So this file asks the QUESTION lane 6's investigation had to answer by reading
// code ("whether the dashboard dims or fully hides `working-note`: DETERMINED…
// Read off `pages/Chat.tsx`'s render") — and it asks it of the render.
//
// ── THE MARKERS ARE IMPORTED, NEVER TYPED ──
// `marker-ownership.test.ts` names `@dojo/shared` the owner of both prefixes and
// allows exactly ONE client-side copy. A fixture that typed them would be a
// second, and a drifted marker in a test is worse than no test: it would render
// as raw text and quietly assert nothing.
// ════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactElement } from 'react';
import { WORKING_NOTE_PREFIX, INTERNAL_WORKING_NOTE_PREFIX } from '@dojo/shared';
import { resetFrames } from './helpers/frames';

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../lib/api');
  const stub: Record<string, unknown> = {};
  for (const key of Object.keys(actual)) {
    stub[key] = typeof actual[key] === 'function' ? vi.fn(async () => ({ ok: true, data: [] })) : actual[key];
  }
  stub.getToken = vi.fn(() => null);
  stub.clearToken = vi.fn(() => undefined);
  return stub;
});
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
import { Chat } from '../pages/Chat';
import { ActiveAgentProvider } from '../components/ActiveAgentProvider';
import { RightDockProvider } from '../components/RightDockProvider';
import { TechniqueSessionProvider } from '../components/TechniqueSessionProvider';
import { OrbProvider } from '../components/orb/OrbProvider';
import { ThemeProvider } from '../themes/ThemeProvider';

const ASKED = 'Please take a look at the thing.';
const NOTE_TEXT = 'Sending the reply to the channel now.';
const ANSWER = 'Done — the thing is fixed.';

type Row = {
  id: string; role: 'user' | 'assistant' | 'system' | 'tool';
  content: string; createdAt: string; displayKind?: string | null;
};

let seq = 0;
const at = () => `2020-01-01T00:00:${String(10 + seq++).padStart(2, '0')}.000Z`;
const user = (content: string): Row => ({ id: `u${seq}`, role: 'user', content, createdAt: at() });
const assistant = (content: string): Row => ({ id: `a${seq}`, role: 'assistant', content, createdAt: at() });
const systemNote = (text: string, internal: boolean): Row => ({
  id: `s${seq}`, role: 'system',
  content: `${internal ? INTERNAL_WORKING_NOTE_PREFIX : WORKING_NOTE_PREFIX}${text}`,
  createdAt: at(),
});
const reclassified = (content: string): Row => ({
  id: `r${seq}`, role: 'assistant', content, createdAt: at(), displayKind: 'working-note',
});

/**
 * The DIMMED NOTE BUBBLES on screen carrying this text.
 *
 * `WorkingNoteBubble` is an `aria-expanded` button (collapsed one-liner, click to
 * open), and its PRESENCE is what every rule in `working-note-visibility.ts`
 * decides. Counting bubbles rather than counting the sentence is deliberate: an
 * answer's text legitimately appears on other surfaces of this page, so a text
 * count measures the chrome and moves when the chrome moves.
 */
const noteBubbles = (root: HTMLElement, text: string): Element[] =>
  Array.from(root.querySelectorAll('button[aria-expanded]'))
    // EXACT match against the bubble's collapsed one-liner, never `includes`: the page
    // has outer `aria-expanded` buttons that CONTAIN the feed, and `includes` counted
    // every one of them (measured: 15 matches for one note).
    .filter((b) => (b.textContent ?? '').replace(/\s+/g, ' ').trim() === text.replace(/\s+/g, ' ').trim());

const shell = (page: ReactElement) => (
  <MemoryRouter>
    <ThemeProvider>
      <OrbProvider>
        <ActiveAgentProvider>
          <RightDockProvider>
            <TechniqueSessionProvider>{page}</TechniqueSessionProvider>
          </RightDockProvider>
        </ActiveAgentProvider>
      </OrbProvider>
    </ThemeProvider>
  </MemoryRouter>
);

/** Mount the feed with exactly these rows, in the viewer's mode. */
const feed = async (rows: Row[], wordyMode: boolean) => {
  localStorage.setItem('dojo_wordy_mode', String(wordyMode));
  // CURSOR-AWARE, and it has to be: `Chat.tsx` pages BACKWARDS through history
  // (`getChatHistory(agent, 200, oldestId, wordy)`) until a page comes back short. A
  // mock that answers the same rows for every call feeds that loop forever — measured:
  // one note bubble became fifteen inside a one-second `waitFor`. The real door answers
  // nothing past the oldest row, so this one does too.
  vi.mocked(api.getChatHistory).mockImplementation((async (
    _agentId: string, _limit?: number, before?: string,
  ) => ({ ok: true, data: before === undefined ? rows : [] })) as never);
  vi.mocked(api.getAgent).mockResolvedValue({ ok: true, data: { id: 'a-0001', name: 'the agent', status: 'idle' } } as never);
  const view = render(shell(<Chat />));
  await waitFor(() => expect(api.getChatHistory).toHaveBeenCalled());
  // The question the person asked is the anchor: once it is on screen the feed has
  // rendered this run. (`textContent`, not a query — a user bubble nests its text.)
  await waitFor(() => expect(view.container.textContent).toContain(ASKED));
  return view;
};

beforeEach(() => {
  resetFrames();
  // The feed's own rows are the subject; nothing here may reach a server.
  vi.stubGlobal('fetch', () => Promise.resolve(new Response('{"ok":false}', { status: 503, headers: { 'content-type': 'application/json' } })));
});
afterEach(() => { vi.clearAllMocks(); seq = 0; });

describe('the feed asks the visibility rule, on both note routes', () => {
  it('R2: an internal note that is the ONLY thing the agent said is SHOWN in regular mode', async () => {
    // This is the arm the owner never saw: before the visibility lane it was `return null`,
    // so a routed-channel turn whose narration was all there was rendered as silence.
    const { container } = await feed([user(ASKED), systemNote(NOTE_TEXT, true)], false);
    await waitFor(() => expect(noteBubbles(container, NOTE_TEXT)).toHaveLength(1));
  });

  it('RC-9 intact: the same internal note is HIDDEN in regular mode when a real answer is beside it', async () => {
    const { container } = await feed([user(ASKED), systemNote(NOTE_TEXT, true), assistant(ANSWER)], false);
    await waitFor(() => expect(container.textContent).toContain(ANSWER));
    expect(noteBubbles(container, NOTE_TEXT), 'the undelivered note was shown beside the reply').toHaveLength(0);
  });

  it('…and is shown again in wordy mode, where the viewer asked for everything', async () => {
    const { container } = await feed([user(ASKED), systemNote(NOTE_TEXT, true), assistant(ANSWER)], true);
    await waitFor(() => expect(noteBubbles(container, NOTE_TEXT)).toHaveLength(1));
  });

  it('R1: a plain note is dimmed rather than hidden, in regular mode', async () => {
    const { container } = await feed([user(ASKED), systemNote(NOTE_TEXT, false), assistant(ANSWER)], false);
    await waitFor(() => expect(noteBubbles(container, NOTE_TEXT)).toHaveLength(1));
  });

  it('R3: the OTHER note route — a re-classified row repeating the answer draws no bubble', async () => {
    const { container } = await feed([user(ASKED), reclassified(ANSWER), assistant(ANSWER)], false);
    await waitFor(() => expect(container.textContent).toContain(ANSWER));
    // The answer is on screen ONCE, as the answer — and not a second time as a note.
    expect(noteBubbles(container, ANSWER), 'the same sentence was shown twice').toHaveLength(0);
  });

  it('R3 boundary: a re-classified note that says something ELSE is still shown', async () => {
    const { container } = await feed([user(ASKED), reclassified(NOTE_TEXT), assistant(ANSWER)], false);
    await waitFor(() => expect(container.textContent).toContain(ANSWER));
    expect(noteBubbles(container, NOTE_TEXT), 'a note saying something else was swallowed').toHaveLength(1);
  });
});
