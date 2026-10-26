// The ONE reading of a task status word, pinned.
//
// `task-status-words.ts` is the single place a status word is folded into the canonical
// seven, and BOTH the status door (`tracker/tools.ts`) and the measured-close door
// (`agent/tools/cat/measure-door.ts`) call `normalizeTaskStatus` so they cannot disagree.
// A synonym dropped or mis-mapped here quietly changes what an agent's "done" means — with
// no test to notice — so this pins the mapping, the synonym table, the null contract and the
// canonical set. Pure: the module it imports has no dependencies, so nothing cold is pulled
// in inside a clause.
import { describe, it, expect } from 'vitest';
import { normalizeTaskStatus, CANONICAL_TASK_STATUSES } from '../task-status-words.js';

describe('§1 the clear synonyms fold to their canonical word', () => {
  it('the eight words a weak model reaches for read as their status', () => {
    expect(normalizeTaskStatus('In Progress')).toBe('in_progress');
    expect(normalizeTaskStatus('on-hold')).toBe('paused');
    expect(normalizeTaskStatus('DONE')).toBe('complete');
    expect(normalizeTaskStatus('  Canceled ')).toBe('cancelled');
    expect(normalizeTaskStatus('wontfix')).toBe('cancelled');
    expect(normalizeTaskStatus('to do')).toBe('on_deck');
    expect(normalizeTaskStatus('stuck')).toBe('blocked');
    expect(normalizeTaskStatus('failed')).toBe('fallen');
  });
});

describe('§2 every canonical word maps to itself', () => {
  it('a status that is already canonical is unchanged', () => {
    for (const status of CANONICAL_TASK_STATUSES) {
      expect(normalizeTaskStatus(status), status).toBe(status);
    }
  });
});

describe('§3 every spelled-out synonym lands inside the canonical set', () => {
  // The table is not exported, so the words are named here: any one that escapes the
  // canonical set is a synonym that silently stopped being a status.
  const SYNONYMS = [
    'done', 'finished', 'completed', 'working', 'active', 'doing', 'started', 'wip',
    'todo', 'queued', 'backlog', 'pending', 'pause', 'hold', 'waiting', 'parked',
    'block', 'stalled', 'fail', 'cancel', 'abandoned', 'dropped',
  ] as const;

  it('no synonym falls outside the canonical seven', () => {
    for (const word of SYNONYMS) {
      const folded = normalizeTaskStatus(word);
      expect(folded, word).not.toBeNull();
      expect(CANONICAL_TASK_STATUSES, `${word} → ${folded}`).toContain(folded);
    }
  });
});

describe('§4 an unrecognized word or a non-string is refused as null', () => {
  it('unknown and non-string inputs give null, not a guess', () => {
    for (const raw of ['nope', '', 5, null, undefined, {}] as unknown[]) {
      expect(normalizeTaskStatus(raw), JSON.stringify(raw)).toBeNull();
    }
  });
});

describe('§5 the canonical set is exactly the seven, named in order', () => {
  it('no more, no fewer, and in the order the doors share', () => {
    expect(CANONICAL_TASK_STATUSES.length).toBe(7);
    expect(CANONICAL_TASK_STATUSES).toEqual([
      'on_deck', 'in_progress', 'paused', 'complete', 'blocked', 'fallen', 'cancelled',
    ]);
  });
});
