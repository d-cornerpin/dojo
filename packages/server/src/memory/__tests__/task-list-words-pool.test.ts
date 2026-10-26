// ════════════════════════════════════════════════════════════════════════════════════════
// THE TASK LIST'S WORD POOL: the primitives that spend one character budget across the list.
//
// `capLabel`, `originLabel`, `spend` and `laterSection` are pure: they take a mutable
// `WordsPool` and the term caps, and print. No DB, no mocks — the functions live in
// `../task-list-words.js` and spend exactly what the pool is handed.
//
// `laterSection` pays the pool NEWEST-WORD-FIRST: each later message is charged for its whole
// rendering in reverse order (the newest message gets the room first), then the section is
// printed in the order the messages were sent. When the pool is spent, the older messages left
// collapse into ONE counted line that names the newest of them.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import { capLabel, originLabel, spend, laterSection } from '../task-list-words.js';
import type { WordsPool, TermCaps, ListedMessage } from '../task-list-words.js';

const CAPS: TermCaps = { title: 10, label: 8, note: 20 };
const cut = (more: number): string => `CUT ${more}`;
const pool = (remaining: number): WordsPool => ({ remaining });

/** One later message: the pool charges it in reverse, then it prints in the order it was sent. */
function later(id: string, words: string | null, extra: Partial<ListedMessage> = {}): ListedMessage {
  return { messageId: id, words, createdAt: '2026-03-01 10:00:00', label: 'Pat (sms)', ...extra };
}

describe('capLabel — one short term capped to its width', () => {
  it('a null raw falls back to the fallback', () => {
    expect(capLabel(null, 'fallback', CAPS)).toBe('fallback');
  });
  it('a label at the cap is whole, not cut', () => {
    expect(capLabel('12345678', 'x', CAPS)).toBe('12345678');
  });
  it('a label one over the cap is sliced and ellipsised', () => {
    expect(capLabel('123456789', 'x', CAPS)).toBe('12345678...');
  });
});

describe('originLabel — "<party> on <channel>" without repeating the channel', () => {
  it('a party and a channel it does not name are joined with "on"', () => {
    expect(originLabel('Alice', 'email')).toBe('Alice on email');
  });
  it('a party whose label already carries the channel is not joined twice', () => {
    expect(originLabel('Alice (email)', 'email')).toBe('Alice (email)');
  });
  it('a missing party falls back to the channel', () => {
    expect(originLabel(null, 'email')).toBe('the email channel');
  });
  it('a missing party and a missing channel is null', () => {
    expect(originLabel(null, null)).toBe(null);
  });
  it('a party with no channel is just the party', () => {
    expect(originLabel('Alice', null)).toBe('Alice');
  });
});

describe('spend — print verbatim up to the pool, then the end marker or the cut line', () => {
  it('a text the pool covers prints whole, the end marker after it', () => {
    const p = pool(50);
    expect(spend('hello', p, 'END', cut)).toBe('hello\nEND');
    expect(p.remaining).toBe(45);
  });
  it('an exact fit ends cleanly on the end marker, the pool spent to zero', () => {
    const p = pool(5);
    expect(spend('hello', p, 'END', cut)).toBe('hello\nEND');
    expect(p.remaining).toBe(0);
  });
  it('a text the pool cannot cover is cut, naming the characters it did not hold', () => {
    const p = pool(5);
    expect(spend('hello world', p, 'END', cut)).toBe('hello\nCUT 6');
    expect(p.remaining).toBe(0);
  });
  it('a pool with nothing left cuts with no leading newline', () => {
    const p = pool(0);
    expect(spend('hello', p, 'END', cut)).toBe('CUT 5');
    expect(p.remaining).toBe(0);
  });
  it('a pool already in debt cuts the whole text and the debt stands', () => {
    const p = pool(-3);
    expect(spend('hello', p, 'END', cut)).toBe('CUT 5');
    expect(p.remaining).toBe(-3);
  });
});

describe('laterSection — the newest later message gets the room first, the older ones collapse', () => {
  it('no later messages is the empty string', () => {
    expect(laterSection([], pool(0), CAPS)).toBe('');
  });
  it('a pool already spent collapses the older messages into one counted line that names the newest', () => {
    const p = pool(0);
    const s = laterSection([later('m1', 'a'), later('m2', 'b')], p, CAPS);
    expect(s).toContain('2 older later messages');
    expect(s).toContain('message m2');
    expect(s).not.toContain('Later message from');
  });
  it('under room pressure the newest message is cut and the older one collapses to one line', () => {
    const p = pool(200);
    const s = laterSection([later('m1', 'older words here'), later('m2', 'x'.repeat(300))], p, CAPS);
    expect(s).toContain('1 older later message sent');
    expect(s).toContain('message m1');
    expect(s).toContain('more characters');
    expect(p.remaining).toBe(0);
  });
  it('a later message that is no longer stored keeps its id and says so', () => {
    const p = pool(1000);
    const s = laterSection([later('m9', null)], p, CAPS);
    expect(s).toContain('m9');
    expect(s).toContain('no longer stored');
  });
  it('a later message already in view is pointed to, its words not repeated', () => {
    const p = pool(1000);
    const s = laterSection([later('m3', 'SECRET WORDS', { inView: true })], p, CAPS);
    expect(s).toContain('message m3');
    expect(s).not.toContain('SECRET WORDS');
  });
});
