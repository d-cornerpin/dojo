// ════════════════════════════════════════════════════════════════════════════════════════
// WHAT A SESSION RESET HIDES, AND WHAT IT DOES NOT — the axis is CONSENT, not the file.
//
// ── WHY THIS FILE EXISTS: AN ASSESSMENT THAT CAME BACK "NOT A DEFECT" ──
// BACKLOG line 42, verbatim: "the investigation's Option-B rejection row citing
// memory/recall.ts:287 as unbounded is WRONG (it binds at HEAD :241-244) — the real unbounded
// recovery path is memory/retrieval.ts; assess whether retrieval.ts wants the same
// session-boundary respect (it was not in Option A's four reads)."
//
// Re-derived at HEAD. THE FIRST HALF IS RIGHT: `memory/recall.ts` does bind the boundary, and the
// investigation doc's two rows that read otherwise were about CONVERSATION scope, not time. THE
// SECOND HALF DOES NOT SURVIVE, on two independent grounds, and the full measurement with its
// commands is appended to `.superpowers/sdd/BACKLOG-CAMPAIGN/conversation-identity-investigation.md`:
//
//   1. `memory/retrieval.ts` IS BOUNDED. t89 rebuilt it against `memory/search-bounds.ts`; every
//      scanning read carries a rowid/seq window ON TOP of its LIMIT, which is the distinction the
//      file's own headers labour ("The LIMIT bounded the ANSWER and said nothing about the WORK").
//   2. IT IS NOT A RECOVERY PATH. All four exports are INVOKED — three are agent tool calls, one
//      is a dashboard search box, and the single non-tool caller (`agent/spawner.ts`'s spawn-time
//      context hints) passes text the spawning agent typed, capped at five results.
//
// ── SO NOTHING WAS CHANGED, AND THIS IS WHY A CLAUSE STILL EARNS ITS PLACE ──
// The verdict rests on a DISTINCTION, and a distinction with no clause is a convention that drifts.
// The axis is not which module a read lives in; it is whether anybody asked for the content:
//
//   AUTOMATIC re-injection of prior content, which the agent did not ask for → MUST bind the
//   boundary, because a reset is a DECISION TO FORGET and re-feeding across it silently overrides
//   the user's decision. Three such paths exist and all three bind.
//
//   An INVOKED SEARCH OF HISTORY → must NOT bind it. `history_search` that stopped at the last
//   reset would answer "nothing" to every question about last week. That is the feature.
//
// What would make this a real defect later is a FOURTH automatic path arriving without a binding,
// or one of the three quietly losing it. Both are what the clauses below refuse.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_SRC = path.resolve(HERE, '../..');
const read = (rel: string): string => fs.readFileSync(path.join(SERVER_SRC, rel), 'utf-8');
/** Comments stripped (G4): a boundary "respected" only in the prose above a query is not bound. */
const code = (rel: string): string => read(rel)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter(l => !/^\s*(\/\/|\*)/.test(l)).join('\n');

/**
 * THE AUTOMATIC PATHS — every read that puts prior content in front of the model without the
 * agent having asked for it. Each must both READ the boundary and APPLY it to a query.
 */
const AUTOMATIC_PATHS = [
  {
    rel: 'memory/recall.ts',
    boundaryVar: 'sessionBoundary',
    what: 'the recall lane: prior turns injected into the assembled prompt',
  },
  {
    // ⚠ NAMED, not discovered. `memory/assembler.ts` holds TWO boundary reads for two different
    // consumers — `boundary` (the tail window, :170-173) and `sessionBoundary` (the
    // empty-context recovery, :1574-1576, whose own comment is this file's rule: "CRITICAL:
    // respect session_started_at — recovering a pre-reset message makes the model…"). A clause
    // that took "the first boundary variable in the file" would pin the tail window and leave the
    // RECOVERY path free to lose its binding, so the recovery one is named here.
    rel: 'memory/assembler.ts',
    boundaryVar: 'sessionBoundary',
    what: 'empty-context recovery of the last user message at assembly time',
  },
  {
    rel: 'memory/directive.ts',
    boundaryVar: 'sessionStart',
    what: "the owner's standing directives",
  },
] as const;

/** The INVOKED searches — a tool call or a search box. Reaching history is their purpose. */
const INVOKED_SEARCH = 'memory/retrieval.ts';

describe('an AUTOMATIC path binds the session boundary', () => {
  for (const { rel, boundaryVar, what } of AUTOMATIC_PATHS) {
    it(`${rel} reads \`session_started_at\` AND applies it — ${what}`, () => {
      const src = code(rel);
      expect(
        src,
        `${rel} no longer reads agents.session_started_at. It re-injects prior content the agent `
        + 'did not ask for, so a reset would stop hiding anything from it — the user decided to '
        + 'forget and the platform would keep feeding it back.',
      ).toMatch(/session_started_at\s+FROM\s+agents/);
      // THE APPLICATION, not the presence (G4), and specifically not "a time predicate exists
      // SOMEWHERE in this file" — every one of these modules has other time predicates (an
      // `opts.since` filter, a nested conversation-scope subquery), so a clause satisfied by any
      // of them is satisfied by a file that has dropped the boundary entirely. Measured: that
      // weaker clause stayed GREEN with recall.ts's binding deleted.
      //
      // So the BOUNDARY VARIABLE ITSELF must be the parameter bound to the boundary predicate.
      // All three sites share one shape, which is what makes one assertion honest here:
      //
      //     const <var> = sessionRow?.session_started_at ?? null;
      //     if (<var>) {
      //       <clauses>.push('created_at >= (unixepoch(?) * 1000)');
      //       <params>.push(<var>);
      //     }
      expect(
        src,
        `${rel} no longer assigns the boundary to \`${boundaryVar}\`. If the read was renamed or `
        + 'restructured, update this clause\'s declared variable deliberately — the point of naming '
        + 'it is that a file with several boundary readers cannot satisfy the clause with the wrong one.',
      ).toMatch(new RegExp(`const\\s+${boundaryVar}\\s*=\\s*\\w+\\?\\.session_started_at\\s*\\?\\?\\s*null`));
      const bound = new RegExp(
        `if\\s*\\(\\s*${boundaryVar}\\s*\\)\\s*\\{[^}]*?`
        + `push\\(\\s*['"][^'"]*created_at\\s*>=\\s*\\(unixepoch\\(\\?\\)\\s*\\*\\s*1000\\)[^'"]*['"]\\s*\\)[^}]*?`
        + `push\\(\\s*${boundaryVar}\\s*\\)`,
        's',
      );
      expect(
        bound.test(src),
        `${rel} reads the boundary into \`${boundaryVar}\` but never binds it to a `
        + '`created_at >= (unixepoch(?) * 1000)` predicate. The read is then decorative: this path '
        + 're-injects prior content the agent did not ask for, so a reset would stop hiding '
        + 'anything from it.',
      ).toBe(true);
    });
  }

  it('the three are the WHOLE set — a fourth automatic path cannot arrive unnoticed', () => {
    // The both-ways direction. Any module that reads `session_started_at` is making a decision
    // about the boundary, and this list is where that decision is declared. A new reader is either
    // an automatic path (and owes a binding) or a deliberate exception (and owes a line here).
    const declared = new Set<string>([
      ...AUTOMATIC_PATHS.map(p => p.rel),
      // Not re-injection paths; each reads the boundary for its own reason, all argued in place.
      'memory/session-boundary.ts',   // the boundary ITSELF — the shared reader
      'memory/store.ts',              // the boundary reader the lanes share
      'memory/tail-horizon.ts',       // the tail window
      'memory/compaction-brakes.ts',  // a brake keyed on the boundary
      'memory/message-store.ts',      // a comment-level reference to the column's writers
    ]);
    const dir = path.join(SERVER_SRC, 'memory');
    const readers = fs.readdirSync(dir)
      .filter(f => f.endsWith('.ts'))
      .filter(f => /session_started_at/.test(fs.readFileSync(path.join(dir, f), 'utf-8')))
      .map(f => `memory/${f}`);
    for (const r of readers) {
      expect(
        declared.has(r),
        `${r} reads agents.session_started_at and is not declared in this clause. If it is an `
        + 'AUTOMATIC path that re-injects prior content, add it to AUTOMATIC_PATHS and give it a '
        + 'binding; if it reads the boundary for another reason, add it to the exception list with '
        + 'that reason. Either way the decision is made here rather than discovered in an incident.',
      ).toBe(true);
    }
    expect(readers.length, 'no module reads the boundary — the extraction anchor moved')
      .toBeGreaterThanOrEqual(AUTOMATIC_PATHS.length);
  });
});

describe('an INVOKED search does NOT bind it — and that is the answer to BACKLOG line 42', () => {
  it('`memory/retrieval.ts` holds no session-boundary read, deliberately', () => {
    expect(
      /session_started_at/.test(read(INVOKED_SEARCH)),
      'memory/retrieval.ts now binds the session boundary. That is a PRODUCT DECISION, not a fix: '
      + 'its four exports are `history_search`/`history_get`/`history_expand` and the dashboard '
      + 'search box, and a history search that stops at the last reset answers "nothing" to every '
      + 'question about last week. BACKLOG line 42 asked whether it wants this binding and the '
      + 'measured answer was NO, on the invoked-versus-automatic distinction. If that answer has '
      + 'changed, change it HERE, with the reason.',
    ).toBe(false);
  });

  it('it is BOUNDED instead, which is the half of line 42 that t89 closed', () => {
    const src = code(INVOKED_SEARCH);
    // Bounds, not answer-size limits: the rowid/seq window is what bounds the WORK.
    expect(src, 'the shared bounds module is no longer used').toMatch(/from '\.\/search-bounds\.js'/);
    for (const bound of ['boundedRecencyScan', 'ftsCandidateRowidFloor', 'FTS_CANDIDATE_ROWS']) {
      expect(src, `${bound} is gone from the invoked-search path`).toContain(bound);
    }
    // And every scanning LIKE arm carries a rowid window, which is the property a LIMIT does not give.
    expect((src.match(/rowid\s*<=\s*\?/g) ?? []).length,
      'a LIKE scan lost its rowid ceiling; the LIMIT bounds the ANSWER and not the WORK')
      .toBeGreaterThanOrEqual(2);
  });

  it("the spawner's context-hint grep — the one non-tool caller — stays capped", () => {
    // It is the only automatic-LOOKING caller, so it is the one worth pinning: the hints are text
    // the spawning agent typed, and the result count is capped.
    const src = code('agent/spawner.ts');
    expect(src, 'the spawner no longer caps its context-hint grep').toMatch(
      /memoryGrep\([\s\S]{0,200}limit:\s*\d+/);
    const limit = Number(/memoryGrep\([\s\S]{0,200}limit:\s*(\d+)/.exec(src)?.[1] ?? '0');
    expect(limit).toBeGreaterThan(0);
    expect(limit, 'the context-hint cap grew; a spawn prompt is not a place for unbounded history')
      .toBeLessThanOrEqual(10);
  });
});
