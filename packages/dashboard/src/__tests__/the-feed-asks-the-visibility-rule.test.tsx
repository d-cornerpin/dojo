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
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactElement } from 'react';
import { WORKING_NOTE_PREFIX, INTERNAL_WORKING_NOTE_PREFIX } from '@dojo/shared';
import { emitFrame, resetFrames } from './helpers/frames';

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
  conversationId?: string | null;
};

let seq = 0;
const at = () => `2020-01-01T00:00:${String(10 + seq++).padStart(2, '0')}.000Z`;
const user = (content: string): Row => ({ id: `u${seq}`, role: 'user', content, createdAt: at() });
/** A PERSON asking, as `gateway/routes/chat.ts` stores and now broadcasts it: with the
 *  conversation it resolved. The bare `user()` above keeps NO conversation and so keeps
 *  standing for every engine-synthetic trigger, which is what R4's control arm needs. */
const person = (content: string): Row => ({ ...user(content), conversationId: 'owner' });
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

// ════════════════════════════════════════════════════════════════════════════
// R4 IN THE DOM — OWNER RULING 2026-10-05 (#7): a real reply never collapses.
//
// The verdict is proven 20 ways in the server suite. What only the DOM can prove is that the
// feed DRAWS a promoted note as a reply instead of as a collapsed button — both arms of it —
// because a `renderWorkingNote` call whose 'answer' branch was dropped at one arm keeps every
// one of those clauses green while the owner looks at the same grey box he reported.
// ════════════════════════════════════════════════════════════════════════════
describe('R4 in the DOM — the reply is drawn as a reply, at both note arms', () => {
  const REPLY = 'Yes — the sync finished and the queue is empty.';

  it("the system-note arm: the agent's only words to a person draw NO collapsed button", async () => {
    const { container } = await feed([person(ASKED), systemNote(REPLY, false)], false);
    await waitFor(() => expect(container.textContent).toContain(REPLY));
    expect(noteBubbles(container, REPLY), "the owner's own reply was collapsed again").toHaveLength(0);
  });

  it('the internal arm promotes the same way', async () => {
    const { container } = await feed([person(ASKED), systemNote(REPLY, true)], false);
    await waitFor(() => expect(container.textContent).toContain(REPLY));
    expect(noteBubbles(container, REPLY)).toHaveLength(0);
  });

  it('the turn-boundary arm: a re-classified row that is all there was draws no button either', async () => {
    const { container } = await feed([person(ASKED), reclassified(REPLY)], false);
    await waitFor(() => expect(container.textContent).toContain(REPLY));
    expect(noteBubbles(container, REPLY)).toHaveLength(0);
  });

  it('CONTROL — an engine-synthetic trigger anchors its OWN run, so its note stays collapsed', async () => {
    // The 45 correctly-demoted scheduler/service rows, in the DOM. The cycle row is faithful:
    // `vault/maintenance.ts` stores the Dreamer's cycle prompt as a plain user row with NO
    // conversation resolved, and it is the NEAREST user row before the note — so the person's
    // real ask above it cannot be borrowed to promote engine narration.
    const { container } = await feed(
      [person(ASKED), assistant(ANSWER), user('═══ DREAM CYCLE ═══'), systemNote(NOTE_TEXT, false)], false,
    );
    await waitFor(() => expect(noteBubbles(container, NOTE_TEXT)).toHaveLength(1));
  });

  it('CONTROL — once a real answer is beside it, the note is a collapsed button again', async () => {
    const { container } = await feed([person(ASKED), systemNote(NOTE_TEXT, false), assistant(ANSWER)], false);
    await waitFor(() => expect(container.textContent).toContain(ANSWER));
    expect(noteBubbles(container, NOTE_TEXT), 'the self-healing fallback to R1 did not happen').toHaveLength(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// THE LIVE WINDOW — THE OWNER'S OWN CASE, WITHOUT A REFRESH.
//
// Every clause above seeds history and mounts, which is the RELOADED feed. The owner's
// sighting happened in the live window, and the live window has one more step in it: the
// message he typed exists first as an OPTIMISTIC `temp-` bubble with no conversation (only the
// server resolves one), and the server's own broadcast is then MERGED INTO that bubble rather
// than appended. A reconcile that drops the frame's `conversationId` leaves R4's anchor row
// conversation-less for the whole live window — so the fix would appear to work on every
// reload-shaped clause and still fail the man who reported it until he refreshed.
//
// So this clause drives the real sequence and never remounts: type → send → the server's user
// frame arrives and reconciles → the turn's only utterance arrives as a demoted note.
// ════════════════════════════════════════════════════════════════════════════
describe('R4 in the live window — no refresh, no remount', () => {
  const LIVE_ASK = 'you good now?';
  const LIVE_REPLY = 'Yes — the sync finished and the queue is empty.';

  it("the reply to a message typed THIS SESSION renders as a reply, with no reload", async () => {
    // A prior exchange, so the feed has rendered and the helper's anchor is on screen. Its user
    // row deliberately carries NO conversation, so it cannot stand in for the typed one.
    const view = await feed([user(ASKED), assistant(ANSWER)], false);
    // The agent id the component is actually using, read off its own first call — never
    // guessed, because the frame handler drops anything whose agentId does not match.
    const agentId = vi.mocked(api.getChatHistory).mock.calls[0]?.[0] as string;

    const box = view.container.querySelector('textarea');
    expect(box, 'the composer textarea is the live path; without it this clause proves nothing').not.toBeNull();
    fireEvent.change(box as HTMLTextAreaElement, { target: { value: LIVE_ASK } });
    fireEvent.keyDown(box as HTMLTextAreaElement, { key: 'Enter' });
    // The OPTIMISTIC bubble: on screen, and carrying no conversation of its own.
    await waitFor(() => expect(view.container.textContent).toContain(LIVE_ASK));

    // The server stored the row and broadcast it WITH the conversation it resolved. This frame
    // reconciles into the optimistic bubble; it does not append a second one.
    emitFrame('chat:message', { agentId, message: {
      id: 'u-live-1', agentId, role: 'user', content: LIVE_ASK, createdAt: at(),
      conversationId: 'owner',
    } });
    // Then the turn's only utterance, demoted on co-occurrence with a tool call.
    emitFrame('chat:message', { agentId, message: {
      id: 's-live-1', agentId, role: 'system',
      content: `${WORKING_NOTE_PREFIX}${LIVE_REPLY}`, createdAt: at(),
    } });

    await waitFor(() => expect(view.container.textContent).toContain(LIVE_REPLY));
    expect(noteBubbles(view.container, LIVE_REPLY),
      "the owner's live reply was collapsed — the reconcile dropped the conversation").toHaveLength(0);
    // And the reconcile did its original job: one bubble for the typed message, not two.
    expect((view.container.textContent ?? '').split(LIVE_ASK).length - 1).toBe(1);
  });

  it('CONTROL — the same live sequence with NO conversation on the frame keeps the collapsed note', async () => {
    // A background/engine-triggered row broadcast live carries no conversation, and must not be
    // promoted just because it arrived in the live window.
    const view = await feed([user(ASKED), assistant(ANSWER)], false);
    const agentId = vi.mocked(api.getChatHistory).mock.calls[0]?.[0] as string;
    emitFrame('chat:message', { agentId, message: {
      id: 'u-live-2', agentId, role: 'user', content: '═══ DREAM CYCLE ═══', createdAt: at(),
    } });
    emitFrame('chat:message', { agentId, message: {
      id: 's-live-2', agentId, role: 'system',
      content: `${WORKING_NOTE_PREFIX}${NOTE_TEXT}`, createdAt: at(),
    } });
    await waitFor(() => expect(noteBubbles(view.container, NOTE_TEXT)).toHaveLength(1));
  });
});
