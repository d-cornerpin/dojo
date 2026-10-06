// ════════════════════════════════════════════════════════════════════════════════════════
// WHETHER A DEMOTED NOTE IS DIMMED OR GONE — and the one case where "gone" makes the
// platform silent.
//
// ── WHY THIS IS A LIBRARY MODULE AND NOT A BRANCH IN `Chat.tsx` ──
// This package gained a component runner on 2026-09-26, and the arrangement it does not replace
// is this one: a rule that is a DECISION moves into `dashboard/src/lib/*.ts`, where server-side
// vitest can import it and drive it against the engine that produces the rows — the precedent
// is `lib/dates.ts`, driven from `server/src/__tests__/dashboard-dates.test.ts`. These three
// rules decide whether the owner sees his agent's words at all, so they are exactly that kind
// of rule.
//
// ── THE THREE ARMS, AND WHICH OF THEM IS NEW ──
//
//  R1 — A PLAIN `[working-note] ` ROW RENDERS DIMMED, IN BOTH MODES. **Unchanged** (owner
//     request 2026-07-10, demote-don't-discard: the narration streamed live, so deleting the
//     bubble read as the engine killing the agent mid-thought).
//
//  R2 — AN `[working-note:internal] ` ROW THAT IS THE ONLY THING THE AGENT SAID RENDERS
//     DIMMED INSTEAD OF VANISHING. **NEW, and it is a NARROWING of RC-9, not a reversal.**
//     RC-9 hides the internal arm because a routed-channel note was never delivered to that
//     channel and "would read as a SECOND, CONTRADICTORY reply" (the F-22 shape: the dashboard
//     showing "Not yet, sending now" that never reached iMessage). That reason is a comparison
//     — it needs a first reply to be second to. When the note is the ONLY thing the agent said,
//     there is nothing for it to contradict, and hiding it is not caution: it is the display
//     layer making a turn silent. This is the display twin of the engine's never-silent
//     invariant (`agent/v2/steps/post-call-classify/answer-to-a-live-ask.ts`), and it reaches
//     the case that invariant cannot: the engine's arm fires on a CONTINUATION turn, while this
//     one fires whenever the result is a person who was told nothing, for any cause.
//     ⚠ MEASURED SEVERITY, and it is why this arm was raised at all: the investigation recorded
//     the internal arm as the one that is *hidden by policy, not by dimming*, and the owner's
//     own sighting was the PLAIN arm — the better of the two. The arm he did not see is worse,
//     and on a routed-channel-heavy box it is the DOMINANT one (the dev box has 5 internal rows
//     and almost no routed traffic, so this arm is effectively unexercised there).
//
//  R3 — A NOTE WHOSE TEXT IS ALREADY ON SCREEN AS THE ANSWER IS WORDY-ONLY. **NEW**, and it is
//     the DISPLAY half of one real double-copy: on an ordinary waiting-human turn the engine
//     writes the note AND `finalize/deferred-recovery.ts` may later deliver the same text as an
//     assistant row, so one answer is stored twice — a dimmed note and a bubble, the shape T52
//     described as "shown his answer twice, once collapsed and once for real". The two WRITES
//     are engine-side and are deliberately untouched (see the lane report: removing one means
//     touching five reviewed control clauses). What the display layer can honestly do is stop
//     showing the same sentence twice. Keyed on EXACT trimmed equality with a visible answer in
//     the same run — never a similarity score, because a note that merely resembles the answer
//     is a different sentence and the owner is entitled to both.
//
//  R4 — A NOTE THAT IS THE ONLY THING THE AGENT SAID BACK TO A PERSON IS THE REPLY, AND
//     RENDERS AS ONE. **NEW (t106).** OWNER RULING 2026-10-05 (#7), his words: *"I do not want
//     real replies to collapse."* R2 reached the display layer's silence (a note that vanished
//     now shows); it did not reach the owner's own sighting, which was a note that SHOWED —
//     dimmed, italic, collapsed to one line behind a click — and which was his agent's actual
//     answer to a question he had just asked. Dimming is the collapse he complained about, so
//     "shown" is not the bar; "shown as a reply" is.
//     ⚠ WHAT KEEPS THE 45 CORRECTLY-DEMOTED SCHEDULER NOTES DEMOTED, AND IT IS A COLUMN AND
//     NOT A NAME LIST: `conversation_id` on the run's ANCHOR row. A person's message resolves
//     one at ingest (`gateway/routes/chat.ts` resolveOrCreateConversation, in the same write);
//     every engine-synthetic `role='user'` trigger — the Dreamer's cycle prompt the loudest,
//     stored as a plain user row with `origin_kind` NULL *and no conversation* by
//     `vault/maintenance.ts` wakeupDreamer — carries NULL. So the question "was this a reply to
//     a PERSON?" is answered by the row the engine already wrote, not by matching its text and
//     not by a service-agent roster. A row that does not carry the column at all (a local
//     optimistic bubble, a legacy row) answers NO and keeps the shipped verdict: this arm only
//     ever fires on evidence that a person opened the run.
//     ⚠ AND IT SELF-HEALS RATHER THAN LATCHING. The promotion is a pure function of the rows on
//     screen, so the moment a real answer lands in the same run `answers` is non-empty, R4's
//     guard is false, and the note falls back to R1's dimmed bubble beside it — the 2026-07-10
//     demote-don't-discard behaviour, unchanged. Nothing is stored, no frame is invented, and
//     no engine write moves: this is the display layer stating what the rows already say.
//
// ── "THE ONLY THING THE AGENT SAID" IS SCOPED TO THE PERSON'S OWN UNIT, NOT THE ENGINE'S ──
// The run is `(last user row before this one, next user row after this one)`. That is
// deliberate, and it is NOT an approximation of the engine's turn — it is a better question.
// `ChatMessage` carries no turn number (the history route projects field by field and does not
// send one), but more importantly the person does not experience turns: they experience "I
// asked, and then I saw nothing back". A run that spans several engine turns is exactly the
// silence they are complaining about, and the measured case class — a long task the engine
// re-continues across turns, each one demoting its only words — lives inside ONE such run and
// outside any one turn. Keying on the engine's turn would have split it.
//
// ── WHAT IS DELIBERATELY NOT HERE, AND WHY R4 DID NOT NEED IT ──
// No `promoted: true` frame arm, and no new runtime writer of `messages.retired_at`. Those were
// the two candidate mechanisms the half-done line named, and both are WRITE-SIDE answers to a
// READ-SIDE question: the rows already record everything the verdict needs (who said what, in
// which order, and whether a person opened the run), so inventing a second record of it would
// be the duplication this campaign exists to delete. `chat:workingnote`'s `reclassified` arm
// keeps its one live server caller (`teardown/draft-reclassify.ts`) and gains no twin.
//
// Nor is the ENGINE touched. `post-call-classify/answer-to-a-live-ask.ts` refused predicate A
// (`hasUnansweredUser`) on measured evidence — it turned five reviewed control clauses red,
// because it is true on every ordinary human turn and would have promoted mid-work preamble,
// the branch owner ruling 2026-07-23 deleted. R4 is not that predicate wearing a different hat:
// it is asked at RENDER time, where the one fact the engine seam could not have — *is this the
// only thing the person was shown* — is finally knowable, and where being wrong costs a note
// that un-dims on the next render rather than a duplicate row in the model's own context.
// ════════════════════════════════════════════════════════════════════════════════════════

// THE MARKERS ARE NOT DECLARED HERE, AND THAT IS A CENSUS RULE, NOT TASTE.
// `server/src/__tests__/marker-ownership.test.ts` names `@dojo/shared` the OWNER of
// `WORKING_NOTE_PREFIX` / `INTERNAL_WORKING_NOTE_PREFIX` / `parseWorkingNote`, with exactly one
// allowed client-side copy (`pages/Chat.tsx`, pending SWEEP-E). A second copy in this file would
// fail that census — correctly: copies of a marker drift, and a drifted marker here means the
// note is silently unrecognised and the row renders as raw `[working-note] …` text at the owner.
import { parseWorkingNote } from '@dojo/shared';

/** Which demotion wrote the row. `internal` is RC-9's routed-channel arm. */
export type WorkingNoteArm = 'plain' | 'internal';

/** `answer` = an ordinary agent bubble, never dimmed (R4). `dimmed` = the expandable note
 *  bubble, in both modes. `wordyOnly` = hidden in regular mode. */
export type NoteVerdict = 'answer' | 'dimmed' | 'wordyOnly';

/** What `Chat.tsx` does with the row. One question, asked once, at each of the feed's two note
 *  arms — so a future edit cannot teach one arm the answer and leave the other behind. */
export type NoteRender = 'hide' | 'note' | 'answer';

/** The only fields any of these rules read. A superset of `Chat.tsx`'s `ChatMessage`. */
export interface NoteRow {
  readonly role: 'user' | 'assistant' | 'system' | 'tool';
  readonly content: string;
  /** `messages.display_kind`, as stored. `'working-note'` on a re-classified assistant row. */
  readonly displayKind?: string | null;
  /**
   * `messages.conversation_id`, as stored. Read on the run's ANCHOR row and nowhere else: a
   * non-empty value is the engine's own record that a PERSON opened this exchange on a real
   * conversation ('owner', 'imessage:…'), resolved by that row's producer at ingest. NULL —
   * or absent, on a locally-built optimistic bubble — is the engine's record that nobody did,
   * which is what every synthetic `role='user'` trigger carries. R4 reads it; nothing else does.
   */
  readonly conversationId?: string | null;
}

/** The owner's match, in this file's vocabulary. One reader, so the arm cannot be re-derived. */
function armOf(content: string): { text: string; arm: WorkingNoteArm } | null {
  const m = parseWorkingNote(content);
  return m === null ? null : { text: m.text, arm: m.internal ? 'internal' : 'plain' };
}

/**
 * The note this row IS, by either of the two routes a note reaches the feed: the mid-turn
 * demotion's prefixed `role='system'` row, and the turn boundary's re-classified
 * `role='assistant'` row (whose content is deliberately byte-unchanged, so it carries no
 * prefix and must be recognised by its STORED KIND — SWEEP CORE-2 item 7's own rule).
 */
export function noteOn(row: NoteRow): { text: string; arm: WorkingNoteArm } | null {
  if (row.role === 'system') return armOf(row.content);
  if (row.role === 'assistant' && row.displayKind === 'working-note') {
    const prefixed = armOf(row.content);
    // A re-classified row keeps its own bytes; a prefix on it would be the engine's, not ours.
    return prefixed ?? { text: row.content, arm: 'plain' };
  }
  return null;
}

/** Text blocks only. A tool-only assistant row has no text and is therefore not an answer. */
function textOf(content: string): string {
  try {
    const parsed: unknown = JSON.parse(content);
    if (Array.isArray(parsed)) {
      return parsed
        .filter((b): b is { type: string; text?: string } =>
          typeof b === 'object' && b !== null && (b as { type?: unknown }).type === 'text')
        .map((b) => b.text ?? '')
        .join('\n\n')
        .trim();
    }
  } catch { /* not JSON — plain text */ }
  return content.trim();
}

/**
 * What the agent SAID here, as the person would count it: '' for anything that is not a
 * user-visible answer. A note is not an answer (that is the whole subject of this file), and
 * neither is a row whose only blocks are `tool_use`.
 */
export function visibleAgentText(row: NoteRow): string {
  if (row.role !== 'assistant') return '';
  if (noteOn(row) !== null) return '';
  return textOf(row.content);
}

/**
 * The person's own conversational unit around `index`: everything after the previous thing THEY
 * said, up to the next thing they say. Half-open `[start, end)`.
 */
export function conversationalRun(
  rows: readonly NoteRow[], index: number,
): { start: number; end: number } {
  let start = 0;
  for (let i = index - 1; i >= 0; i--) {
    if (rows[i]?.role === 'user') { start = i + 1; break; }
  }
  let end = rows.length;
  for (let i = index + 1; i < rows.length; i++) {
    if (rows[i]?.role === 'user') { end = i; break; }
  }
  return { start, end };
}

/**
 * DID A PERSON OPEN THIS RUN? — read off the run's ANCHOR row, the nearest `role='user'` row
 * before `index`, and off no other row.
 *
 * The nearest one, deliberately: it is the row `conversationalRun` measures from, so the
 * question this answers is about the same unit the rest of the file is about. An engine-synthetic
 * trigger that interleaves with real traffic therefore anchors its OWN run and cannot borrow the
 * person's, and the person's ask cannot be made to pay for a note the scheduler caused.
 *
 * A run with no user row before it at all (the top of a freshly-truncated history page, a
 * service agent's very first cycle) answers NO. That is the conservative direction: the note
 * keeps the verdict it ships with today.
 */
export function askedByAPerson(rows: readonly NoteRow[], index: number): boolean {
  for (let i = index - 1; i >= 0; i--) {
    const row = rows[i];
    if (row === undefined || row.role !== 'user') continue;
    return typeof row.conversationId === 'string' && row.conversationId.trim() !== '';
  }
  return false;
}

/**
 * THE VERDICT for the note at `index`, or `null` when that row is not a note at all.
 *
 * Order is load-bearing: R3 is asked FIRST, so a note that merely repeats the answer beside it
 * is quiet whichever arm wrote it — including the internal arm, where R2 would otherwise have
 * to decide whether a duplicate counts as "the only thing said". It does not: the answer is on
 * screen, the person is not in silence, and the second copy is the thing to remove.
 *
 * R4 is asked SECOND, ahead of both R2 and R1, and its guard is disjoint from R3's: R3 needs a
 * visible answer in the run and R4 needs there to be none. So the two can never both be true,
 * and the order between them is readability rather than precedence.
 */
export function workingNoteVerdict(rows: readonly NoteRow[], index: number): NoteVerdict | null {
  const note = noteOn(rows[index] as NoteRow);
  if (note === null) return null;
  const { start, end } = conversationalRun(rows, index);

  const answers: string[] = [];
  for (let i = start; i < end; i++) {
    if (i === index) continue;
    const said = visibleAgentText(rows[i] as NoteRow);
    if (said !== '') answers.push(said);
  }

  // R3 — the same sentence is already on screen as the answer.
  const body = note.text.trim();
  if (body !== '' && answers.some((a) => a === body)) return 'wordyOnly';

  // R4 — the person asked and this is all they were shown: it is the reply, so it reads as one.
  // Both arms, because the owner's bar is about what a reply may look like and not about which
  // demotion wrote it. R2's internal-arm `dimmed` answer is subsumed here, not contradicted:
  // that arm's whole finding was that a lone internal note must be VISIBLE, and this says what
  // visible means for it.
  if (answers.length === 0 && askedByAPerson(rows, index)) return 'answer';

  // R2 — RC-9, narrowed: hidden only when there is a reply for it to be second to.
  if (note.arm === 'internal') return answers.length > 0 ? 'wordyOnly' : 'dimmed';

  // R1 — unchanged since 2026-07-10.
  return 'dimmed';
}

/** Is this note on screen at all, given the viewer's mode? `true` for a promoted reply too —
 *  a reply is the most on-screen a row can be. */
export function showsWorkingNote(
  rows: readonly NoteRow[], index: number, wordyMode: boolean,
): boolean {
  const verdict = workingNoteVerdict(rows, index);
  if (verdict === null) return false;
  return wordyMode || verdict !== 'wordyOnly';
}

/** The one question `Chat.tsx` asks per row, at both of its note arms: how does this render? */
export function renderWorkingNote(
  rows: readonly NoteRow[], index: number, wordyMode: boolean,
): NoteRender {
  const verdict = workingNoteVerdict(rows, index);
  if (verdict === null || (verdict === 'wordyOnly' && !wordyMode)) return 'hide';
  // A promoted reply is a reply in wordy mode too. Wordy mode is a DISPLAY FILTER that only
  // ever adds rows (`shared/visibility.ts` says so in its own header); making it also re-dim a
  // row the regular viewer sees as the answer would be the one place it subtracted.
  return verdict === 'answer' ? 'answer' : 'note';
}
