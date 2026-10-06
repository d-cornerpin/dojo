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
  askedByAPerson, conversationalRun, noteOn, renderWorkingNote, showsWorkingNote,
  visibleAgentText, workingNoteVerdict,
  type NoteRow,
} from '../../../dashboard/src/lib/working-note-visibility';

const PLAIN = '[working-note] ';
const INTERNAL = '[working-note:internal] ';

const user = (content: string): NoteRow => ({ role: 'user', content });
/**
 * A PERSON speaking, as the engine actually stores it: `gateway/routes/chat.ts` resolves a
 * conversation for the row and writes it in the same statement, so a dashboard/iMessage/phone
 * message always carries one. The bare `user()` above keeps NO conversation and therefore keeps
 * standing for the rows that genuinely have none — every synthetic trigger, and every legacy or
 * locally-built row whose column never reached the client.
 */
const person = (content: string, conversationId = 'owner'): NoteRow =>
  ({ role: 'user', content, conversationId });
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

// ════════════════════════════════════════════════════════════════════════════════════════
// R4 — OWNER RULING 2026-10-05 (#7): *"I do not want real replies to collapse."*
//
// THE SHAPE HE SAW, in his own words on the line that opened this: *"his actual reply to 'you
// good now?' rendered collapsed/greyed as if it were noise."* R2 fixed the arm that VANISHED;
// this is the arm that was on screen and dimmed, which is the one he actually reported. The bar
// is therefore not "shown" — a dimmed, italic, one-line-behind-a-click bubble IS shown — it is
// "shown as a reply".
// ════════════════════════════════════════════════════════════════════════════════════════
describe("R4 — a real reply never collapses (the owner's own sighting, reproduced)", () => {
  const ASK = 'you good now?';
  const REPLY = "Yes — the sync finished and the queue is empty.";

  it('THE REPRODUCTION: the agent answers a direct question, the text rode with a tool call, and the feed collapsed it', () => {
    // The row the engine wrote for that turn: `terminal-text.ts` demoted the model's answer on
    // CO-OCCURRENCE with a tool call, so the only thing on screen for this ask is a note.
    const rows = [person(ASK), plainNote(REPLY)];
    expect(workingNoteVerdict(rows, 1)).toBe('answer');
    expect(renderWorkingNote(rows, 1, false)).toBe('answer');
    // And it is a reply in wordy mode too — wordy mode only ever ADDS rows.
    expect(renderWorkingNote(rows, 1, true)).toBe('answer');
  });

  it('the internal arm — the one he never saw, and the worse one — promotes identically', () => {
    const rows = [person('did that send?'), internalNote(THE_STATUS)];
    expect(workingNoteVerdict(rows, 1)).toBe('answer');
  });

  it('the turn-boundary arm promotes too: a re-classified row that is all there was is the reply', () => {
    // `draft-reclassify.ts` fails closed on a turn that recorded no answer, so a turn whose
    // ledger key never got written leaves its one bubble stamped `working-note` and nothing else.
    const rows = [person(ASK), reclassified(REPLY)];
    expect(workingNoteVerdict(rows, 1)).toBe('answer');
    expect(renderWorkingNote(rows, 1, false)).toBe('answer');
  });

  it('a tool-only row beside it is still not an answer, so the note is still the reply', () => {
    const rows = [person('organize my mail'), toolRow('work_update'), plainNote(THE_STATUS)];
    expect(workingNoteVerdict(rows, 2)).toBe('answer');
  });

  it('the measured class — consecutive demoted turns on ONE ask — promotes every one of them', () => {
    const rows = [
      person('Go through the last 2 weeks of email in my mailbox and get it organized.'),
      internalNote(THE_STATUS),
      internalNote('I will continue the organization — it is genuinely multi-step work.'),
    ];
    expect(workingNoteVerdict(rows, 1)).toBe('answer');
    expect(workingNoteVerdict(rows, 2)).toBe('answer');
  });

  it('IT SELF-HEALS: once the real answer lands, the note falls back to 2026-07-10 dimming', () => {
    // The promotion is a pure function of the rows, so nothing has to be un-done. This is the
    // property that makes promoting eagerly safe: being early costs a bubble that re-dims, not
    // a stored row anyone has to reverse.
    const rows = [person(ASK), plainNote('Let me check the queue.'), answer(REPLY)];
    expect(workingNoteVerdict(rows, 1)).toBe('dimmed');
    expect(renderWorkingNote(rows, 1, false)).toBe('note');
  });

  it('and an internal note falls back to RC-9 wordy-only, F-22 intact', () => {
    const rows = [person('can you text her the address?'), internalNote('Not yet, sending now'), answer('Sent her the address.')];
    expect(workingNoteVerdict(rows, 1)).toBe('wordyOnly');
    expect(renderWorkingNote(rows, 1, false)).toBe('hide');
  });

  it('R3 still beats it — the same sentence is not promoted into a second copy of the answer', () => {
    const rows = [person('did it work?'), plainNote(THE_STATUS), answer(THE_STATUS)];
    expect(workingNoteVerdict(rows, 1)).toBe('wordyOnly');
  });

  it("an answer to a DIFFERENT question does not promote this one's note either way", () => {
    // The run boundary is unchanged by R4: the previous exchange's reply is outside it, so this
    // note is still the only thing said HERE — and still a reply.
    const rows = [person('first thing'), answer('here you go'), person('second thing'), plainNote(THE_STATUS)];
    expect(conversationalRun(rows, 3)).toEqual({ start: 3, end: 4 });
    expect(workingNoteVerdict(rows, 3)).toBe('answer');
  });
});

describe('R4 — what KEEPS the 45 correctly-demoted scheduler notes demoted', () => {
  it('THE CONTROL THAT MATTERS: a Dreamer cycle note is NOT a reply to anyone, and stays dimmed', () => {
    // `vault/maintenance.ts` wakeupDreamer stores the cycle prompt as a plain `role='user'` row
    // and resolves NO conversation for it (its own comment records why the lane stamp is absent
    // too). So the column the engine already wrote is what refuses the promotion — not a
    // service-agent name list, which is the thing this platform may not rely on.
    const rows = [user('═══ DREAM CYCLE ═══'), plainNote('Two issues to address tonight.')];
    expect(askedByAPerson(rows, 1)).toBe(false);
    expect(workingNoteVerdict(rows, 1)).toBe('dimmed');
    expect(renderWorkingNote(rows, 1, false)).toBe('note');
  });

  it('an empty / whitespace conversation key is NOT a person — a blank is not evidence', () => {
    expect(askedByAPerson([{ role: 'user', content: 'x', conversationId: '   ' }, plainNote('n')], 1)).toBe(false);
    expect(askedByAPerson([{ role: 'user', content: 'x', conversationId: null }, plainNote('n')], 1)).toBe(false);
  });

  it('a row with NO column at all (a local optimistic bubble, a legacy row) keeps the shipped verdict', () => {
    const rows = [user('did that send?'), internalNote(THE_STATUS)];
    expect(askedByAPerson(rows, 1)).toBe(false);
    expect(workingNoteVerdict(rows, 1)).toBe('dimmed');
  });

  it('a run with no user row before it at all answers NO', () => {
    expect(askedByAPerson([plainNote('x')], 0)).toBe(false);
  });

  it('the NEAREST user row decides, so an engine trigger cannot borrow the person ask before it', () => {
    // A real ask, answered; then the scheduler wakes the agent and its narration is demoted.
    // The anchor for that note is the SYNTHETIC row, which carries no conversation.
    const rows = [
      person('what is on the board?'), answer('Three open items.'),
      user('═══ DREAM CYCLE ═══'), plainNote('Two issues to address tonight.'),
    ];
    expect(askedByAPerson(rows, 3)).toBe(false);
    expect(workingNoteVerdict(rows, 3)).toBe('dimmed');
  });

  it('…and the converse: a person asking AFTER an engine cycle is still a person', () => {
    const rows = [
      user('═══ DREAM CYCLE ═══'), plainNote('Two issues to address tonight.'),
      person('you good now?'), plainNote('Yes — both are filed.'),
    ];
    expect(workingNoteVerdict(rows, 1)).toBe('dimmed');
    expect(workingNoteVerdict(rows, 3)).toBe('answer');
  });

  it('a routed-channel person is a person: the key is non-empty, not the literal "owner"', () => {
    const rows = [person('you good now?', 'imessage:+15550000000'), plainNote('Yes — all sent.')];
    expect(askedByAPerson(rows, 1)).toBe(true);
    expect(workingNoteVerdict(rows, 1)).toBe('answer');
  });

  it('a non-note row still gets no verdict and renders as nothing of this file\'s business', () => {
    expect(renderWorkingNote([person('hi')], 0, false)).toBe('hide');
    expect(renderWorkingNote([answer('hello')], 0, true)).toBe('hide');
  });

  it('showsWorkingNote agrees with the render for every verdict, in both modes', () => {
    // The two exported doors may not disagree: `showsWorkingNote` has 23 clauses behind it and
    // is still what the regression controls above call, so this pins them to one answer.
    const cases: NoteRow[][] = [
      [person('q'), plainNote('only thing said')],
      [user('═══ DREAM CYCLE ═══'), plainNote('cycle narration')],
      [person('q'), plainNote('n'), answer('the real answer')],
      [person('q'), internalNote('n'), answer('the real answer')],
    ];
    for (const rows of cases) {
      for (const wordy of [false, true]) {
        expect(showsWorkingNote(rows, 1, wordy)).toBe(renderWorkingNote(rows, 1, wordy) !== 'hide');
      }
    }
  });
});
