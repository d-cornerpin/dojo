// ════════════════════════════════════════════════════════════════════════════════════════
// THE VISIBILITY HALF OF THE COLLAPSING COMPLAINT — the display layer may not make a turn
// silent.
//
// ── WHY A SERVER TEST DRIVES A DASHBOARD MODULE ──
// `packages/dashboard` has no test runner. The house's standing answer is that every rule worth
// testing moves into `dashboard/src/lib/*.ts` and server-side vitest imports it — the precedent
// is `lib/dates.ts`, driven from `__tests__/dashboard-dates.test.ts`, which this file copies.
//
// ── THE THREE RULES UNDER TEST, AND WHAT MOVED ──
//  R1 a plain `[working-note] ` row renders DIMMED in both modes — UNCHANGED (2026-07-10).
//  R2 an `[working-note:internal] ` row renders DIMMED when it is the ONLY thing the agent said
//     since the person last spoke, and stays wordy-only whenever a real answer is beside it.
//     **NEW.** RC-9 hides the internal arm because it "would read as a SECOND, CONTRADICTORY
//     reply" — a comparison, which needs a first reply to be second to. With no reply beside it
//     there is nothing to contradict, and hiding it is the DISPLAY layer making the turn silent.
//     The measured sting: the owner's own grey sighting was the PLAIN arm; this one, which he
//     did not see, vanished outright, and on a routed-channel box it is the dominant arm.
//  R3 a note whose text is already on screen as the answer is wordy-only. **NEW** — the display
//     half of the double-copy the engine lane recorded and deliberately did not touch.
//
// ── THE SCOPE THE RULES ARE KEYED ON, ASSERTED RATHER THAN ASSUMED ──
// "The only thing the agent said" is scoped to the PERSON'S unit — after the last thing they
// said, up to the next — not to the engine's turn. `ChatMessage` carries no turn number, and
// more to the point the person does not experience turns: the measured class is a long task the
// engine re-continues, whose consecutive demoted turns all sit inside ONE such unit. A clause
// below drives exactly that shape, because keying on the engine's turn would have split it and
// left the second turn looking "answered" by the first.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import {
  conversationalRun, noteOn, showsWorkingNote, visibleAgentText, workingNoteVerdict,
  type NoteRow,
} from '../../../dashboard/src/lib/working-note-visibility';

const PLAIN = '[working-note] ';
const INTERNAL = '[working-note:internal] ';

const user = (content: string): NoteRow => ({ role: 'user', content });
const answer = (content: string): NoteRow => ({ role: 'assistant', content });
const plainNote = (text: string): NoteRow => ({ role: 'system', content: PLAIN + text });
const internalNote = (text: string): NoteRow => ({ role: 'system', content: INTERNAL + text });
/** The turn-boundary arm: an assistant row whose STORED KIND moved, bytes untouched. */
const reclassified = (content: string): NoteRow =>
  ({ role: 'assistant', content, displayKind: 'working-note' });
const toolRow = (name: string): NoteRow => ({
  role: 'assistant',
  content: JSON.stringify([{ type: 'tool_use', id: 'c1', name, input: {} }]),
});

/** The investigation's own row, seq 76946. */
const THE_STATUS = "I'm continuing the organization work — the project is already on the board, "
  + 'so I will not create a duplicate.';

describe('R2 — an internal note that is the only thing the agent said is DIMMED, not gone', () => {
  it('the owner asked, the agent only demoted an internal note: it renders in regular mode', () => {
    const rows = [user('did that send?'), internalNote(THE_STATUS)];
    expect(workingNoteVerdict(rows, 1)).toBe('dimmed');
    expect(showsWorkingNote(rows, 1, false)).toBe(true);
  });

  it('BEFORE this lane that row returned null in regular mode — the regression control', () => {
    // The shipped rule was a flat `if (note.internal && !wordyMode) return null;`. This clause
    // exists so a revert to it is RED here rather than invisible: the old predicate cannot
    // distinguish these two rows, and this lane's whole point is that they differ.
    const alone = [user('did that send?'), internalNote(THE_STATUS)];
    const beside = [user('did that send?'), answer('Sent — all twelve went out.'), internalNote(THE_STATUS)];
    expect(showsWorkingNote(alone, 1, false)).toBe(true);
    expect(showsWorkingNote(beside, 2, false)).toBe(false);
  });

  it('RC-9 IS INTACT: with a real answer beside it, the internal note stays wordy-only', () => {
    // F-22's shape — the dashboard showing "Not yet, sending now" that never reached iMessage.
    // There IS a reply for it to contradict, so it is hidden exactly as before.
    const rows = [
      user('can you text her the address?'),
      internalNote('Not yet, sending now'),
      answer('Sent her the address.'),
    ];
    expect(workingNoteVerdict(rows, 1)).toBe('wordyOnly');
    expect(showsWorkingNote(rows, 1, false)).toBe(false);
    expect(showsWorkingNote(rows, 1, true)).toBe(true);
  });

  it('a tool-only assistant row is NOT an answer, so the note is still all that was said', () => {
    // The whole defect class is text that rode with a tool call: the row beside the note holds
    // `tool_use` blocks and no text. Counting it as a reply would re-hide the note and put the
    // silence straight back.
    const rows = [user('organize my mail'), toolRow('work_update'), internalNote(THE_STATUS)];
    expect(visibleAgentText(toolRow('work_update'))).toBe('');
    expect(workingNoteVerdict(rows, 2)).toBe('dimmed');
  });

  it('an answer to a DIFFERENT question does not silence this one', () => {
    // The run is bounded by the person's own rows, so a reply in the previous exchange cannot
    // pay for silence in this one.
    const rows = [
      user('first thing'), answer('here you go'),
      user('second thing'), internalNote(THE_STATUS),
    ];
    expect(conversationalRun(rows, 3)).toEqual({ start: 3, end: 4 });
    expect(workingNoteVerdict(rows, 3)).toBe('dimmed');
  });
});

describe('the measured class: consecutive demoted turns inside ONE thing the person asked', () => {
  it('two notes, no answer between them, both render — the unit is the ask, not the turn', () => {
    // seq 76946 / 76953: turns 61 and 62 on one long task. Keyed on the engine's turn the second
    // note would look "answered" by the first; keyed on the person's unit neither is.
    const rows = [
      user('Go through the last 2 weeks of email in my mailbox and get it organized.'),
      internalNote(THE_STATUS),
      internalNote('I will continue the organization — it is genuinely multi-step work.'),
    ];
    expect(workingNoteVerdict(rows, 1)).toBe('dimmed');
    expect(workingNoteVerdict(rows, 2)).toBe('dimmed');
  });

  it('and once the real answer lands, both fall back to wordy-only', () => {
    const rows = [
      user('Go through the last 2 weeks of email in my mailbox and get it organized.'),
      internalNote(THE_STATUS),
      internalNote('I will continue the organization — it is genuinely multi-step work.'),
      answer('Done — 214 threads filed under six labels.'),
    ];
    expect(showsWorkingNote(rows, 1, false)).toBe(false);
    expect(showsWorkingNote(rows, 2, false)).toBe(false);
  });
});

describe('R1 — the plain arm is UNCHANGED, in both modes (owner request 2026-07-10)', () => {
  it('a plain note renders dimmed even with the answer beside it', () => {
    const rows = [user('organize my mail'), plainNote('Let me check the labels.'), answer('Done.')];
    expect(workingNoteVerdict(rows, 1)).toBe('dimmed');
    expect(showsWorkingNote(rows, 1, false)).toBe(true);
    expect(showsWorkingNote(rows, 1, true)).toBe(true);
  });

  it('a plain note alone renders dimmed too — nothing about this arm moved', () => {
    const rows = [user('organize my mail'), plainNote('Let me check the labels.')];
    expect(workingNoteVerdict(rows, 1)).toBe('dimmed');
  });

  it('SCHEDULER CYCLES KEEP THEIR BEHAVIOUR: a service-agent cycle note is a PLAIN note', () => {
    // The 45 correctly-demoted dreamer/healer rows. The engine writes the internal prefix only
    // on a ROUTED-HUMAN counterparty (`isRoutedHumanCounterparty`), and a cycle is not one — so
    // a cycle's narration is a PLAIN note and was never in the hidden arm at all. R2 cannot
    // reach it, which is why the exclusion needs no name list on this side either.
    const rows = [user('═══ DREAM CYCLE ═══'), plainNote('Two issues to address tonight.')];
    expect(noteOn(rows[1])!.arm).toBe('plain');
    expect(workingNoteVerdict(rows, 1)).toBe('dimmed');
  });
});

describe('R3 — the same sentence is not shown twice', () => {
  it('a note whose text equals a visible answer in the same unit is wordy-only', () => {
    // The engine writes the note AND `finalize/deferred-recovery.ts` may deliver the same text
    // as an assistant row. Two rows, one sentence: "once collapsed and once for real".
    const rows = [user('did it work?'), plainNote(THE_STATUS), answer(THE_STATUS)];
    expect(workingNoteVerdict(rows, 1)).toBe('wordyOnly');
    expect(showsWorkingNote(rows, 1, false)).toBe(false);
    expect(showsWorkingNote(rows, 1, true)).toBe(true);
  });

  it('it beats the plain arm, and it beats the internal arm, in either order', () => {
    const before = [user('q'), answer(THE_STATUS), internalNote(THE_STATUS)];
    const after = [user('q'), internalNote(THE_STATUS), answer(THE_STATUS)];
    expect(workingNoteVerdict(before, 2)).toBe('wordyOnly');
    expect(workingNoteVerdict(after, 1)).toBe('wordyOnly');
  });

  it('EXACT equality only — a note that merely resembles the answer keeps its bubble', () => {
    // A similarity score here would quietly eat a note that said something else. The owner is
    // entitled to both sentences unless they are the same sentence.
    const rows = [user('q'), plainNote(`${THE_STATUS} Also the labels need ids.`), answer(THE_STATUS)];
    expect(workingNoteVerdict(rows, 1)).toBe('dimmed');
  });

  it('whitespace-only difference still counts as the same sentence', () => {
    const rows = [user('q'), plainNote(`  ${THE_STATUS}\n`), answer(THE_STATUS)];
    expect(workingNoteVerdict(rows, 1)).toBe('wordyOnly');
  });

  it('an EMPTY note never matches an empty answer into silence', () => {
    const rows = [user('q'), plainNote('   '), answer('')];
    expect(workingNoteVerdict(rows, 1)).toBe('dimmed');
  });
});

describe('the turn-boundary arm (SWEEP CORE-2 item 7) asks the same question', () => {
  it('a re-classified draft is recognised by its STORED KIND, not by a prefix', () => {
    const row = reclassified('Here is my first pass at the plan.');
    expect(noteOn(row)).toEqual({ text: 'Here is my first pass at the plan.', arm: 'plain' });
  });

  it('it still renders dimmed in both modes — the item-7 behaviour is unchanged', () => {
    const rows = [user('plan it'), reclassified('First pass.'), answer('Final plan: …')];
    expect(workingNoteVerdict(rows, 1)).toBe('dimmed');
    expect(showsWorkingNote(rows, 1, false)).toBe(true);
  });

  it('unless it duplicates the named answer exactly, which is R3 again', () => {
    const rows = [user('plan it'), reclassified('Final plan: A then B.'), answer('Final plan: A then B.')];
    expect(workingNoteVerdict(rows, 1)).toBe('wordyOnly');
  });
});

describe('the controls', () => {
  it('a row that is not a note gets no verdict at all', () => {
    expect(workingNoteVerdict([user('hi')], 0)).toBeNull();
    expect(workingNoteVerdict([answer('hello')], 0)).toBeNull();
    expect(showsWorkingNote([answer('hello')], 0, false)).toBe(false);
  });

  it('a note is never counted as the answer that would hide its neighbour', () => {
    const rows = [user('q'), plainNote('one'), internalNote('two')];
    expect(visibleAgentText(rows[1])).toBe('');
    expect(workingNoteVerdict(rows, 2)).toBe('dimmed');
  });

  it('a system row that is not a note (a divider) is left to its own branch', () => {
    expect(noteOn({ role: 'system', content: '── New Session ──' })).toBeNull();
  });

  it('wordy mode shows every note, whatever the verdict', () => {
    const rows = [user('q'), internalNote('x'), answer('y')];
    expect(showsWorkingNote(rows, 1, true)).toBe(true);
  });

  it('the run is clamped at both ends of the list', () => {
    expect(conversationalRun([plainNote('x')], 0)).toEqual({ start: 0, end: 1 });
  });
});
