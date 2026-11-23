// ════════════════════════════════════════════════════════════════════════════════
// t90 D2 — WHAT THE OWNER IS TOLD WHEN A DELEGATION DOES NOT COME BACK.
// (live-test report #3)
//
// *"The messaging tool returned success both times … Within roughly thirty to sixty seconds of
// each send, the platform flipped the associated work rows to a terminal failed state and told the
// user, in the platform's own voice, that the delegated work had never come back, that every
// delegated piece had come back empty, failed or abandoned. Nothing in that window had refused or
// errored: the receiving agent simply had not replied yet. The notice also named nothing, not what
// had been delegated, not to whom, not how long it had been waiting."*
//
// ── WHAT THE TRACE FOUND, AND WHAT IT RULED OUT ──
// Two hypotheses died on the way here and both are worth keeping dead:
//
//   * `settleAsk` does NOT terminalise a delivered-but-unanswered PARENT ask. It holds it —
//     `joinOutstanding(ask)` is an explicit arm and the module's "THE RULE, STATED ONCE" header
//     declares it. The split the report asks for already exists at that level.
//   * There is no seconds-scale TIMER anywhere on the delegation path. The shortest declared
//     window is five minutes; `JOIN_TTL_MINUTES` is 60.
//
// What actually fires is a chain of TURN boundaries, which is why it reads as 30-60 seconds: the
// recipient is given dedicated A2A turns, each failed one counts against `MAX_A2A_TURN_RETRIES`,
// the turns are queued back to back, and at the cap the runtime records a SYNTHETIC `ABANDONED`
// reply on the recipient's behalf and settles the asker's piece. The countdown hits zero and the
// fail-closed notice is minted.
//
// ── SO THE DEFECT IS THE SENTENCE ──
// The settlement is defensible; the claim built from it is not. "Came back empty, failed or
// abandoned" asserts a reply. These clauses pin the three states apart, and pin the notice naming
// who / what / how long — the half of the report about not being able to judge a retry.
// ════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));

import {
  tallyPieces, joinFailureReason, joinFailureNotice, joinOpenedAt,
} from '../join-failure-notice.js';
import type { JoinPiece } from '../../work/store.js';

const piece = (state: string, content: string | null = null, who = 'peer'): JoinPiece => ({
  childId: `c-${state}-${Math.random().toString(36).slice(2, 7)}`,
  threadId: 't', state: state as JoinPiece['state'], content,
  resultDeliveryId: null, assigneeAgent: who,
});

beforeEach(() => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE work (id TEXT PRIMARY KEY, parent_id TEXT, opened_at INTEGER, state TEXT);
    CREATE TABLE work_events (id INTEGER PRIMARY KEY, work_id TEXT, kind TEXT, payload TEXT)`);
  mockDb.current = db;
});

// ════════════════════════════════════════════════════════════════════════════════
// §1 — THE THREE OUTCOMES ARE THREE, NOT ONE
// ════════════════════════════════════════════════════════════════════════════════

describe('§1 the pieces\' own states say which failure happened', () => {
  it('a silent piece, a refusing piece and an empty piece are counted apart', () => {
    expect(tallyPieces([piece('abandoned')])).toEqual({ refused: 0, empty: 0, silent: 1 });
    expect(tallyPieces([piece('failed', 'I cannot do this')])).toEqual({ refused: 1, empty: 0, silent: 0 });
    expect(tallyPieces([piece('done', '')])).toEqual({ refused: 0, empty: 1, silent: 0 });
    // Anything still open is silence too: nothing has come back from it.
    for (const s of ['open', 'claimed', 'blocked']) {
      expect(tallyPieces([piece(s)]).silent, `${s} is not an answer`).toBe(1);
    }
  });

  /**
   * ⚠ THE AUDIT ROW THE REPORT WAS WRITTEN AGAINST. The literal this replaces — "every delegated
   * piece came back empty, failed or abandoned" — went onto the work row AND to the agent, so the
   * record a later session reconstructs the incident from asserted a reply that never existed.
   */
  it('the recorded reason describes what happened, and never claims a reply that did not come', () => {
    const silent = joinFailureReason([piece('abandoned'), piece('abandoned')]);
    expect(silent).toContain('2 never answered');
    expect(silent, 'nothing came back, so nothing may be called a reply').not.toMatch(/empty|FAIL/);
    // FIX ROUND 1 (C1): this clause never sees the owner's SENTENCE — it reads the recorded
    // reason, the other consumer of the same derivation — so the same lie-rejector is stated
    // here too. The row and the notice are minted from one tally on purpose; a reader who
    // tightens one of the two and leaves the other is how the pair comes apart again.
    expect(silent, '⛔ the audit row may not say they answered either (C1)')
      .not.toMatch(/\bthey answered\b|\band answered\b/);

    const mixed = joinFailureReason([piece('abandoned'), piece('failed', 'no'), piece('done', '')]);
    expect(mixed).toContain('1 never answered');
    expect(mixed).toContain('1 replied FAIL');
    expect(mixed).toContain('1 replied with nothing usable');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// §2 — THE NOTICE: WHO, WHAT, HOW LONG
// ════════════════════════════════════════════════════════════════════════════════

describe('§2 the owner-facing notice', () => {
  function seedOpened(parent: string, secondsAgo: number): void {
    mockDb.current!.prepare('INSERT INTO work (id, parent_id, opened_at) VALUES (?, ?, ?)')
      .run(`${parent}-child`, parent, Date.now() - secondsAgo * 1000);
  }

  it('⚠ THE REPORT\'S CASE: nothing came back, and it says only that, without calling it a reply', () => {
    seedOpened('p1', 45);
    const text = joinFailureNotice({
      parentWorkId: 'p1',
      pieces: [piece('abandoned', null, 'ana')],
      names: ['Ana'],
      questionSnippet: 'can you pull the figures',
    });

    expect(text, 'who it went to').toContain('Ana');
    expect(text, 'how long it waited').toMatch(/waited 45 seconds/);
    expect(text, 'what was asked').toContain('can you pull the figures');
    // ⚠ RE-AIMED IN FIX ROUND 1 (review finding C1), AND THIS IS THE CLAUSE THAT LET THE LIE
    // THROUGH. It matched `/answered/`, which the SINGULAR sentence *"…to Ana, and they
    // answered."* satisfied perfectly — the negation had been written into the plural word only,
    // so the one-delegate case (this report's own) asserted the exact opposite of the truth and
    // the clause nodded along. "Judge tests by user expectation": a notice a person would read as
    // "my agent got an answer" is a FAILURE here, however many substrings match. So the clause
    // now demands the negation AND rejects the lie by name — both halves, because either one
    // alone is satisfiable by a sentence that is wrong in the other direction.
    expect(text, 'that no answer came').toMatch(/nothing came back from them/);
    expect(text, '⛔ and silence is never rendered as a reply (C1)')
      .not.toMatch(/\bthey answered\b|\band answered\b/);
    expect(text, 'it claims no delivery or error state the record does not show').not.toMatch(/delivered|errored/);
    expect(text, 'and it must not describe silence as a reply')
      .not.toMatch(/came back empty, failed or abandoned/i);
  });

  it('names several recipients when the work was split', () => {
    seedOpened('p2', 600);
    const text = joinFailureNotice({
      parentWorkId: 'p2',
      pieces: [piece('abandoned'), piece('abandoned')],
      names: ['Ana', 'Bo'],
      questionSnippet: '',
    });
    expect(text).toContain('Ana');
    expect(text).toContain('Bo');
    expect(text, 'ten minutes reads as minutes, not 600 seconds').toMatch(/waited 10 minutes/);
    // FIX ROUND 1 (C1): the PLURAL arity gets the same two halves as the singular one. This arity
    // was the one that happened to be correct, which is exactly why it is pinned — the defect was
    // a negation shared between two arities, and a clause that only watches the arity that broke
    // lets the next edit lose the other one.
    expect(text).toMatch(/nothing came back from any of them/);
    expect(text, '⛔ nor may several silent peers be rendered as having replied (C1)')
      .not.toMatch(/\bthey answered\b|\band answered\b/);
  });

  it('a genuine refusal is reported as a refusal, not as silence', () => {
    seedOpened('p3', 30);
    const text = joinFailureNotice({
      parentWorkId: 'p3',
      pieces: [piece('failed', 'I do not have web access')],
      names: ['Ana'],
      questionSnippet: '',
    });
    expect(text).toMatch(/replied FAIL/);
    expect(text, 'something did come back, so this is not a non-response')
      .not.toMatch(/never answered/);
  });

  it('survives having nothing to say about the clock', () => {
    // No `work` rows for this parent: `joinOpenedAt` is null and the sentence simply omits a wait
    // rather than inventing one or printing NaN.
    expect(joinOpenedAt('absent')).toBeNull();
    const text = joinFailureNotice({
      parentWorkId: 'absent', pieces: [piece('abandoned')], names: ['Ana'], questionSnippet: '',
    });
    expect(text).toContain('Ana');
    expect(text).not.toMatch(/NaN|undefined|null/);
    expect(text).not.toMatch(/waited/);
  });
});
