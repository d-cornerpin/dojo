// ════════════════════════════════════════════════════════════════════════════════════════
// A SCHEDULER CYCLE HAS NO CONTINUATION — THE PREMISE LANE 6'S CARVE-OUT RESTS ON
// (sweep review B, finding L6-2)
//
// Lane 6 gave a continued HUMAN task its final words back, and the reviewer confirmed the
// carve-out is structural rather than name-keyed: `isHumanContinuation = waitingConvs.length
// === 0 && !!continuation` (`preflight/turn-trigger.ts:133`). No name list, no dependence on
// `display_kind` — which is exactly what makes it immune to the investigation's Correction 2,
// where all 45 dream/diagnostic notices turned out to be stamped `user-text` and a
// display-kind-keyed fix would have promoted every one of them.
//
// ── THE GAP THE REVIEWER NAMED ──
// A scheduler cycle is excluded ONLY BECAUSE a scheduler trigger has no `continuation` record.
// Nothing in the carve-out or its suite asserted that. So if a scheduler cycle ever gained a
// continuation — one `continuationContext.set` on a background path, added in good faith by
// someone restoring context to a poll — all 45 of those notices would promote to delivered
// answers and NO clause would fire. The fix is not more code; it is this file, which makes the
// premise falsifiable.
//
// Two clauses, and they are deliberately different instruments:
//
//   1. THE WRITER CENSUS. `continuationContext` has exactly ONE writer in the tree, and it is
//      the C3 human-auto-continue stash, guarded by `if (chosenConvKey)` — which is null on a
//      non-human turn. A second writer, anywhere, fails here and has to argue.
//   2. THE EXPRESSION PIN. The predicate still requires a continuation to EXIST. A future edit
//      that promotes a cycle by relaxing that conjunct changes the line this clause reads.
//
// Neither needs a database, a clock or a model: the premise is structural, so the proof is too.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');

/** Comments stripped: prose about the map is not a write to it. */
const codeOf = (rel: string): string =>
  fs.readFileSync(path.join(SRC, rel), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

/** Every production `.ts` under the server's src, tests excluded. */
function walkSources(dir = ''): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(path.join(SRC, dir), { withFileTypes: true })) {
    const rel = dir ? `${dir}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (e.name === '__tests__' || e.name === 'node_modules') continue;
      out.push(...walkSources(rel));
    } else if (e.name.endsWith('.ts') && !e.name.includes('.test.')) {
      out.push(rel);
    }
  }
  return out;
}

describe('the continuation record has one writer, and it is the human path', () => {
  it('exactly one module writes `continuationContext`, and it is the C3 human stash', () => {
    const writers = walkSources().filter(rel => /continuationContext\.set\s*\(/.test(codeOf(rel)));
    expect(
      writers,
      'a second writer of the continuation record appeared. A continuation is what makes a turn '
      + 'count as a human continuation, so writing one on a background path would promote every '
      + 'scheduler/dream/diagnostic notice to a delivered answer — which is the exact defect the '
      + 'lane-6 carve-out is narrow to avoid. Read `turn-trigger.ts:133` before adding one.',
    ).toEqual(['agent/v2/steps/preflight/turn-closures.ts']);
  });

  it('that one write is guarded by a HUMAN conversation being chosen', () => {
    const src = codeOf('agent/v2/steps/preflight/turn-closures.ts');
    const line = src.split('\n').find(l => /continuationContext\.set\s*\(/.test(l)) ?? '';
    expect(line, 'the C3 stash lost its guard').toMatch(/if\s*\(chosenConvKey\)/);
    // Non-vacuity: `chosenConvKey` is the thing that is null on a non-human turn, so the guard
    // is the whole reason a background auto-continue stashes nothing.
    expect(src, 'the guard no longer reads the chosen conversation').toContain('chosenConvKey');
  });

  it('the predicate still REQUIRES a continuation to exist', () => {
    const src = codeOf('agent/v2/steps/preflight/turn-trigger.ts');
    const line = src.split('\n').find(l => l.includes('const isHumanContinuation')) ?? '';
    expect(line, 'the human-continuation predicate vanished').not.toBe('');
    expect(line, 'the predicate stopped requiring a continuation record — a turn with no '
      + 'continuation (every scheduler cycle) can now read as a human continuation')
      .toMatch(/!!\s*continuation/);
    expect(line, 'the predicate stopped requiring an empty waiting set').toMatch(/waitingConvs\.length === 0/);
    // And it is still name-free and display-kind-free, which is what made it immune to the
    // investigation's Correction 2 (all 45 notices are stamped `user-text`).
    expect(line, 'the predicate started keying on a display kind').not.toMatch(/display_kind|displayKind/);
  });
});
