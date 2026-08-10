// ════════════════════════════════════════════════════════════════════════════════════════
// FA-T2's ONE HOLE, PINNED. `ADVANCING_STATUS_ARGS` (`work-status.ts`) decides whether a
// `work_update(action="status")` call DISARMS the end-of-turn tracker floor, and its own
// header states the asymmetry that makes it safe:
//
//   > mis-reading an advancing synonym as non-advancing only defers to the DB … only wrongly
//   > reading a CLOSING status as advancing would be a real disarm hole, and this set never
//   > contains a terminal value.
//
// That last clause was a sentence, not a check. UX-REPAIR ROUND 3 T18 adds a NEW terminal
// word to the tracker's vocabulary (`cancelled`, plus `dropped`/`wontfix`/`abandoned` routing
// to it), and the set's header says it is "kept in sync with STATUS_SYNONYMS in
// tracker/tools.ts" — a hand-maintained mirror, which is precisely the shape that goes wrong
// quietly. So the promise is executable now: no word that closes a task may ever be read as
// one that advances it.
//
// It lives in the step package's own `__tests__` rather than beside the T18 suite because a
// guard that reaches into `agent/v2/steps` by path from outside is the drift the guard-corpus
// census (`__tests__/guard-corpus-census.test.ts`) exists to refuse.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import { isAdvancingStatusArg } from '../work-status.js';

describe('the end-of-turn floor is never disarmed by a closing status', () => {
  it('no terminal word — old or new — reads as advancing', () => {
    const terminal = [
      // failure words (owner decision 2026-07-04, unchanged by T18)
      'fallen', 'failed', 'fail',
      // user-choice words (T18: these now reach the spine's `abandoned`, not `failed`)
      'cancelled', 'canceled', 'cancel', 'dropped', 'wontfix', 'abandoned',
      // success words
      'complete', 'completed', 'done', 'finished',
      // and the two non-terminal-but-non-advancing classes, for the same reason
      'paused', 'on_hold', 'blocked', 'stuck',
    ];
    for (const w of terminal) {
      expect(isAdvancingStatusArg(w), `"${w}" must not disarm the floor`).toBe(false);
      expect(isAdvancingStatusArg(w.toUpperCase()), `"${w}" upper-cased`).toBe(false);
      expect(isAdvancingStatusArg(w.replace(/_/g, ' ')), `"${w}" spaced`).toBe(false);
    }
  });

  it('the genuinely advancing words still advance — the set is not vacuous', () => {
    for (const w of ['in_progress', 'in progress', 'working', 'doing', 'started', 'wip',
      'on_deck', 'todo', 'queued', 'backlog', 'pending']) {
      expect(isAdvancingStatusArg(w), `"${w}" should advance`).toBe(true);
    }
  });

  it('a non-string, or an unrecognized word, is not advancing', () => {
    expect(isAdvancingStatusArg(undefined)).toBe(false);
    expect(isAdvancingStatusArg(42)).toBe(false);
    expect(isAdvancingStatusArg('flumped')).toBe(false);
  });
});
