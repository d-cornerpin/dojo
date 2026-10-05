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
// ── WHAT IS DELIBERATELY NOT HERE ──
// No `promoted: true` frame arm. See the lane report: `chat:workingnote`'s `reclassified` arm
// has a live server caller (`teardown/draft-reclassify.ts`); a `promoted` mirror would have
// NONE, because the shipped engine promotion writes no note and broadcasts no dim frame at all
// (asserted by a clause). Building the field now is dead code waiting for a caller, which is
// the habit this campaign exists to break. What it would take when Option A lands: this file's
// verdict type gains nothing, and `Chat.tsx` gains a six-line arm beside the `reclassified` one.
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

/** `dimmed` = the expandable note bubble, in both modes. `wordyOnly` = hidden in regular mode. */
export type NoteVerdict = 'dimmed' | 'wordyOnly';

/** The only fields any of these rules read. A superset of `Chat.tsx`'s `ChatMessage`. */
export interface NoteRow {
  readonly role: 'user' | 'assistant' | 'system' | 'tool';
  readonly content: string;
  /** `messages.display_kind`, as stored. `'working-note'` on a re-classified assistant row. */
  readonly displayKind?: string | null;
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
 * THE VERDICT for the note at `index`, or `null` when that row is not a note at all.
 *
 * Order is load-bearing: R3 is asked FIRST, so a note that merely repeats the answer beside it
 * is quiet whichever arm wrote it — including the internal arm, where R2 would otherwise have
 * to decide whether a duplicate counts as "the only thing said". It does not: the answer is on
 * screen, the person is not in silence, and the second copy is the thing to remove.
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

  // R2 — RC-9, narrowed: hidden only when there is a reply for it to be second to.
  if (note.arm === 'internal') return answers.length > 0 ? 'wordyOnly' : 'dimmed';

  // R1 — unchanged since 2026-07-10.
  return 'dimmed';
}

/** The one question `Chat.tsx` asks per row: render this note, given the viewer's mode? */
export function showsWorkingNote(
  rows: readonly NoteRow[], index: number, wordyMode: boolean,
): boolean {
  const verdict = workingNoteVerdict(rows, index);
  if (verdict === null) return false;
  return wordyMode || verdict === 'dimmed';
}
