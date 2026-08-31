// ════════════════════════════════════════════════════════════════════════════════════════
// PHASE-3 T3 Step 1 — PRIORITY AS DATA, and the inversion killed. Written RED-first.
//
// Every clause below fails at T3's base commit (`8f36cdb`) because `memory/lanes.ts` does
// not exist and there is no priority data structure anywhere in the assembler. What stood
// there instead, re-derived by reading at that commit (§T0-B):
//
//   twelve independent admission gates, each `if (usedTokens + X < maxTokens)`, each with
//   NO else and NO record, consumed in build order:
//
//     :767  briefing      ← tested FIRST, against a full budget
//     :820  vault
//     :860  summaries     (no gate at all — `usedTokens +=` after an unconditional push)
//     :875  relevant memory
//     :914  attempt ledger (double gate: < 800 AND < remaining)
//     :971  active tasks
//     :1012 continuity brief
//     :1037 scratchpad
//     :1098 directive     ← tested LAST, against a budget nine sections already ate
//     :1120 combined ack  (no gate at all)
//     :1215 EVENTS        (no gate, no add, no test)
//
//   and the ack at :1118 told the model, in the same array, that the order was the exact
//   reverse: "directive > scratchpad > live conversation > tasks > continuity > vault >
//   briefing". The declared priority existed only as prose the model read.
//
// THE HEADLINE CLAUSE is `under a forced 8K budget the DIRECTIVE survives and the BRIEFING
// drops first`. It is written twice on purpose: once against the new allocator (it passes)
// and once as an explicit statement of what the OLD build-order arithmetic produced from
// the same inputs (the directive dropped and the briefing survived). A test that only
// asserts the new behaviour cannot show that the behaviour changed.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import {
  fitLanes,
  renderScaffoldingAck,
  truncateTextLane,
  truncateWrappedText,
  renderTokens,
  laneLimit,
  LANE_PRIORITY,
  LANE_LIMITS,
  LANE_SECTION_LABEL,
  LANE_LADDER_LABEL,
  LANE_TRUNCATION_MARKER,
  MIN_TRUNCATION_TOKENS,
  POST_BUDGET_LANES,
  POST_BUDGET_RESERVE_TOKENS,
  SCAFFOLDING_ACK_RESERVE_TOKENS,
  type Lane,
  type LaneCandidate,
  type LaneRender,
} from '../lanes.js';
import { estimateTokens } from '../budget.js';

// ── A lane built from a declaration, for the arithmetic clauses ──
function textLane(id: string, priority: number, slot: number, opts: Partial<Lane> = {}): Lane {
  return {
    id,
    slot,
    priority,
    minTokens: opts.minTokens ?? 0,
    maxTokens: opts.maxTokens ?? Infinity,
    mandatoryFloor: opts.mandatoryFloor ?? false,
    render: () => null,
    truncate: truncateTextLane,
  };
}

function body(tokens: number): string {
  // 4 chars per token, the canonical divisor. `x` repeated, so the content is inert.
  return 'x'.repeat(tokens * 4);
}

function candidate(lane: Lane, tokens: number): LaneCandidate {
  const content = body(tokens);
  const messages = [{ role: 'user' as const, content }];
  const render: LaneRender = { messages, tokens: renderTokens(messages) };
  return { lane, render };
}

describe('the lane table declares priority as data, independent of position', () => {
  it('every lane in the ladder has a priority, a label, and they agree on the set', () => {
    const priorityIds = Object.keys(LANE_PRIORITY).filter((id) => id !== 'lane.scaffolding-ack');
    for (const id of priorityIds) {
      expect(LANE_LADDER_LABEL[id], `${id} has no ladder label`).toBeTruthy();
    }
    // Every section the ack can name is a lane with a priority.
    for (const id of Object.keys(LANE_SECTION_LABEL)) {
      expect(LANE_PRIORITY[id], `${id} names a section but declares no priority`).toBeGreaterThan(0);
    }
  });

  it("keeps the owner-facing ladder the ack has always printed, in that exact order", () => {
    // research 06 §2 quotes it verbatim from `assembler.ts:1118`.
    // T67b §7: `'lane.directive'` LEFT this list with the lane. Its rung read 10 — the top —
    // and a priority rung is a statement about what to DROP under budget pressure; the pin is
    // a post-budget tail lane now (`MessageSlot.ActiveDirectiveTail = 1890`) with a reserve
    // off the top, which is a stronger guarantee than any priority, because a reserve cannot
    // be outbid. Same exit `lane.relevant-memory` made at CORE-2 item 4. The ladder the ack
    // prints is unchanged for every rung that remains, in the same relative order.
    const prose = [
      'lane.scratchpad',
      'lane.fresh-tail',
      'lane.active-tasks',
      'lane.continuity',
      'lane.vault',
      'lane.briefing',
    ];
    const measured = [...prose].sort((a, b) => LANE_PRIORITY[a] - LANE_PRIORITY[b]);
    expect(measured).toEqual(prose);
  });

  it('separates priority from position — the briefing is emitted first and drops first', () => {
    // Emission (slot) order and survival (priority) order are OPPOSITE for these two,
    // which is exactly the separation that could not be expressed before. T67b swapped the
    // low-priority end of the pair from `lane.directive` (which left the fit entirely) to
    // `lane.scratchpad`, which is the highest-priority scaffolding lane now; the property
    // being pinned is the separation itself and it is untouched.
    expect(LANE_PRIORITY['lane.briefing']).toBeGreaterThan(LANE_PRIORITY['lane.scratchpad']);
  });
});

describe('every lane implements truncate() — no all-or-nothing drops', () => {
  it('the default text truncator reduces a block and marks that it did', () => {
    const text = `═══ BRIEFING ═══\n${'word '.repeat(400)}\n═══ END BRIEFING ═══`;
    const cut = truncateWrappedText(text, 100);
    expect(estimateTokens(cut)).toBeLessThanOrEqual(100);
    expect(cut.startsWith('═══ BRIEFING ═══')).toBe(true);
    expect(cut.endsWith('═══ END BRIEFING ═══')).toBe(true);
    expect(cut).toContain(LANE_TRUNCATION_MARKER.trim());
  });

  it('a truncated lane is shortened, never emptied', () => {
    const lane = textLane('lane.briefing', LANE_PRIORITY['lane.briefing'], 100);
    const c = candidate(lane, 500);
    const shrunk = lane.truncate(c.render as LaneRender, MIN_TRUNCATION_TOKENS);
    expect(shrunk.messages.length).toBe(1);
    expect(shrunk.tokens).toBeGreaterThan(0);
    expect(shrunk.tokens).toBeLessThan(500);
  });

  it('the allocator truncates rather than dropping when a partial grant is possible', () => {
    const big = textLane('lane.summaries', LANE_PRIORITY['lane.summaries'], 300);
    const { report } = fitLanes([candidate(big, 4000)], 1000);
    const g = report.grants.find((x) => x.id === 'lane.summaries')!;
    expect(g.status).toBe('truncated');
    expect(g.granted).toBeGreaterThan(0);
    expect(g.granted).toBeLessThanOrEqual(1000);
    expect(g.reason).toMatch(/shortened from 4000 to \d+ tokens/);
  });
});

describe('the two-pass fit reserves minimums by priority, then distributes the remainder', () => {
  it('pass 1 gives a high-priority lane its floor even when a bigger lane rendered first', () => {
    const briefing = textLane('lane.briefing', LANE_PRIORITY['lane.briefing'], 100);
    // T67b: the high-priority stand-in is `lane.scratchpad` (20) — the top of the fit now
    // that the directive is a reserved tail lane. The mechanic being pinned is unchanged:
    // a lane RENDERED SECOND still gets its floor reserved FIRST.
    const directive = textLane('lane.scratchpad', LANE_PRIORITY['lane.scratchpad'], 800, { minTokens: 64 });
    // Deliberately in BUILD order (briefing first) — the order the old arithmetic consumed.
    const { report } = fitLanes([candidate(briefing, 900), candidate(directive, 200)], 1000);
    expect(report.reservedTokens).toBe(64);
    const d = report.grants.find((g) => g.id === 'lane.scratchpad')!;
    expect(d.status).toBe('admitted');
    expect(d.granted).toBe(200);
  });

  it('pass 2 never spends a reservation still owed to a lane below it', () => {
    const tail = textLane('lane.fresh-tail', LANE_PRIORITY['lane.fresh-tail'], 1100, { minTokens: 64 });
    const directive = textLane('lane.scratchpad', LANE_PRIORITY['lane.scratchpad'], 800, { minTokens: 64 });
    // The higher-priority lane is greedy (cost 5,000) but must leave the tail its 64-token floor.
    const { report } = fitLanes([candidate(directive, 5000), candidate(tail, 5000)], 1000);
    const t = report.grants.find((g) => g.id === 'lane.fresh-tail')!;
    expect(t.granted).toBeGreaterThanOrEqual(64);
    expect(report.spentTokens).toBeLessThanOrEqual(1000 + MIN_TRUNCATION_TOKENS);
  });

  it('honours a declared lane ceiling even when the budget could afford more', () => {
    const ledger = textLane('lane.attempt-ledger', LANE_PRIORITY['lane.attempt-ledger'], 500, {
      maxTokens: laneLimit('lane.attempt-ledger', 'tokens', 'cap'),
    });
    const { report } = fitLanes([candidate(ledger, 5000)], 100000);
    const g = report.grants.find((x) => x.id === 'lane.attempt-ledger')!;
    expect(g.status).toBe('truncated');
    expect(g.granted).toBeLessThanOrEqual(800);
  });

  it('records a decision for every lane, including the rejected ones', () => {
    const lanes = [
      candidate(textLane('lane.briefing', LANE_PRIORITY['lane.briefing'], 100), 4000),
      candidate(textLane('lane.vault', LANE_PRIORITY['lane.vault'], 200), 4000),
      candidate(textLane('lane.scratchpad', LANE_PRIORITY['lane.scratchpad'], 800, { minTokens: 64 }), 100),
    ];
    const { report } = fitLanes(lanes, 500);
    expect(report.grants).toHaveLength(3);
    for (const g of report.grants) {
      expect(g.reason, `${g.id} has no reason`).toBeTruthy();
      expect(['admitted', 'truncated', 'rejected', 'empty']).toContain(g.status);
    }
    // A rejected lane is a RECORD, not an absence: before this, a dropped section produced
    // a byte-identical context to a section that never existed (research 06 §8).
    expect(report.grants.some((g) => g.status === 'rejected')).toBe(true);
  });

  it('tells "did not render" apart from "was dropped"', () => {
    const absent: LaneCandidate = { lane: textLane('lane.vault', 100, 200), render: null };
    const { report } = fitLanes([absent], 1000);
    expect(report.grants[0].status).toBe('empty');
    expect(report.grants[0].requested).toBe(0);
  });

  // ════════════════════════════════════════
  // PHASE-4 T1 Step 2b — A THROWN LANE IS A THIRD FACT
  //
  // `lanes.ts:572-574` states the requirement two lines above the defect: "Lanes that
  // rendered nothing are recorded as `empty`, never omitted: 'the briefing did not
  // exist' and 'the briefing was dropped' are different facts and the receipt must be
  // able to tell them apart (research 06 §8)."
  //
  // A lane whose `render` THROWS is a THIRD fact, and the receipt asserted the FIRST
  // one about it: `assembler.ts` caught the throw, logged a warning, and pushed the
  // candidate with `render: null`, from which `fitLanes` was byte-identical to
  // "nothing to say". Found by KITFIX-PREFIX's own planted fault, which is why its
  // shape is the positive control here.
  // ════════════════════════════════════════

  it('T1 2b POSITIVE: a lane whose render THREW is `failed`, never `empty`', () => {
    const threw: LaneCandidate = {
      lane: textLane('lane.briefing', 100, 200),
      render: null,
      renderError: 'TypeError: Cannot read properties of undefined (reading \'rows\')',
    };
    const { report } = fitLanes([threw], 1000);
    expect(report.grants[0].status).toBe('failed');
    // The receipt carries WHY, so the reader does not have to go looking in a log that
    // rotates. The error text is the grant's reason, not a generic word.
    expect(report.grants[0].reason).toContain('threw');
    expect(report.grants[0].reason).toContain('Cannot read properties of undefined');
    expect(report.grants[0].requested).toBe(0);
    expect(report.grants[0].granted).toBe(0);
  });

  it('T1 2b NEGATIVE CONTROL: a genuinely empty lane still reads `empty`', () => {
    // Without this the fix would be indistinguishable from renaming the arm.
    const absent: LaneCandidate = { lane: textLane('lane.vault', 100, 200), render: null };
    const { report } = fitLanes([absent], 1000);
    expect(report.grants[0].status).toBe('empty');
    expect(report.grants[0].reason).toBe('lane rendered no content on this turn');
  });

  it('T1 2b NEGATIVE CONTROL: a lane that rendered ZERO messages is `empty`, not `failed`', () => {
    // "rendered nothing" has two shapes — a null render and an empty message list — and
    // BOTH are the first fact, not the third.
    const nothing: LaneCandidate = {
      lane: textLane('lane.vault', 100, 200),
      render: { messages: [], tokens: 0 },
    };
    const { report } = fitLanes([nothing], 1000);
    expect(report.grants[0].status).toBe('empty');
  });

  it('emits in SLOT order while spending in PRIORITY order', () => {
    const lanes = [
      candidate(textLane('lane.scratchpad', LANE_PRIORITY['lane.scratchpad'], 800), 50),
      candidate(textLane('lane.briefing', LANE_PRIORITY['lane.briefing'], 100), 50),
      candidate(textLane('lane.vault', LANE_PRIORITY['lane.vault'], 200), 50),
    ];
    const { emitted } = fitLanes(lanes, 100000);
    expect(emitted.map((e) => e.id)).toEqual(['lane.briefing', 'lane.vault', 'lane.scratchpad']);
  });
});

describe('THE INVERSION, killed and pinned: a forced 8K budget', () => {
  // The nine content lanes at realistic sizes. The briefing is the biggest thing the
  // assembler ever admitted first; the directive is the smallest thing it tested last.
  const SIZES: Array<[string, number, number, number]> = [
    // id, slot, cost, minTokens
    ['lane.briefing', 100, 4000, 0],
    ['lane.vault', 200, 3000, 0],
    ['lane.summaries', 300, 6000, 0],
    // SWEEP CORE-2 item 4: `['lane.relevant-memory', 400, 1200, 0]` LEFT this fixture with the
    // lane. It is not a `fitLanes` candidate any more — it is post-budget at slot 1870
    // (`memory/recall-lane.ts`), reserved off the top and never ranked — so keeping a row for
    // it here would test a ladder rung that no longer exists and, worse, would read
    // `LANE_PRIORITY['lane.relevant-memory']` as `undefined` in the comparison below, where
    // every `undefined >= n` is silently FALSE. The nine-lane inversion this block pins is
    // unchanged for the eight that remain.
    ['lane.attempt-ledger', 500, 800, 0],
    ['lane.active-tasks', 600, 900, 0],
    ['lane.continuity', 700, 1500, 0],
    // T67b §7: `['lane.directive', 900, 200, 64]` LEFT this fixture with the lane, for the
    // same reason the recall lane's row left it above — it is post-budget at slot 1890 now,
    // reserved off the top and never ranked, so a row here would test a rung that does not
    // exist and would read `LANE_PRIORITY['lane.directive']` as `undefined`. `lane.scratchpad`
    // (priority 20) is the smallest-and-highest-priority lane the fit still ranks, so it
    // carries the floor this fixture uses to pin the inversion.
    ['lane.scratchpad', 800, 400, 64],
    ['lane.fresh-tail', 1100, 5000, 64],
  ];
  const FORCED_BUDGET = 8000;

  function build(): LaneCandidate[] {
    return SIZES.map(([id, slot, cost, min]) =>
      candidate(textLane(id, LANE_PRIORITY[id], slot, { minTokens: min }), cost),
    );
  }

  it('the SMALLEST, HIGHEST-PRIORITY lane survives (it was the directive; T67b made it the scratchpad)', () => {
    const { report } = fitLanes(build(), FORCED_BUDGET);
    const d = report.grants.find((g) => g.id === 'lane.scratchpad')!;
    expect(d.status).toBe('admitted');
    expect(d.granted).toBe(400);
    expect(report.admittedIds).toContain('lane.scratchpad');
  });

  it('the BRIEFING drops first', () => {
    const { report } = fitLanes(build(), FORCED_BUDGET);
    const b = report.grants.find((g) => g.id === 'lane.briefing')!;
    expect(b.status).toBe('rejected');
    expect(report.admittedIds).not.toContain('lane.briefing');
    // And it says WHY, in words, naming its own priority.
    expect(b.reason).toContain('priority 110');
  });

  it('drops in declared priority order, worst first', () => {
    const { report } = fitLanes(build(), FORCED_BUDGET);
    const rejected = report.grants.filter((g) => g.status === 'rejected').map((g) => g.id);
    const admitted = report.admittedIds;
    // Nothing rejected may outrank anything admitted.
    for (const r of rejected) {
      for (const a of admitted) {
        expect(
          LANE_PRIORITY[r] >= LANE_PRIORITY[a],
          `${r} (priority ${LANE_PRIORITY[r]}) was dropped while ${a} (priority ${LANE_PRIORITY[a]}) survived`,
        ).toBe(true);
      }
    }
  });

  it('THE OLD ARITHMETIC, stated for the record: build order gave the opposite answer', () => {
    // This is not the allocator. It is `assembler.ts`'s twelve gates at `8f36cdb`, in their
    // own build order, over the SAME inputs — reproduced here so the change is visible and
    // not merely asserted.
    let used = 0;
    const max = FORCED_BUDGET;
    const admitted: string[] = [];
    for (const [id, , cost] of SIZES) {
      if (used + cost < max) { admitted.push(id); used += cost; }
    }
    expect(admitted).toContain('lane.briefing');        // survived, at priority 110
    expect(admitted).not.toContain('lane.scratchpad');  // dropped, at priority 20
  });
});

describe('the scaffolding ack is GENERATED and BYTE-STABLE', () => {
  it('is a pure function of the admitted lane ids', () => {
    const ids = ['lane.briefing', 'lane.summaries', 'lane.scratchpad'];
    const a = renderScaffoldingAck(ids);
    const b = renderScaffoldingAck([...ids].reverse());
    expect(a).toBe(b);
    expect(renderScaffoldingAck(ids)).toBe(a);
  });

  it('cannot claim a section the budget dropped', () => {
    const ack = renderScaffoldingAck(['lane.scratchpad'])!;
    expect(ack).toContain('scratchpad');
    expect(ack).not.toContain('briefing');
    expect(ack).not.toContain('vault');
    expect(ack).not.toContain('continuity brief');
  });

  it('T67b: the ack no longer names the ACTIVE USER DIRECTIVE at all', () => {
    // The ack closes the SCAFFOLDING BLOCK it sits inside (slot 1000) and the directive is
    // not in that block any more — it is a tail lane at 1890. An ack naming a section that
    // is not there is the exact defect this generator exists to make impossible.
    const ack = renderScaffoldingAck(Object.keys(LANE_SECTION_LABEL))!;
    expect(ack).not.toContain('active user directive');
    expect(LANE_PRIORITY['lane.directive']).toBeUndefined();
    expect(LANE_SECTION_LABEL['lane.directive']).toBeUndefined();
    expect(LANE_LADDER_LABEL['lane.directive']).toBeUndefined();
  });

  it('carries NOTHING volatile — no clock, no counts, no percentages, no ids', () => {
    // The ack sits at slot 1000, AHEAD of the tail boundary. One digit of per-turn state in
    // it re-bills every message after it, on every turn, forever. Research 25 H2 is the
    // planted fault T1 used; this is the structural version of the same assertion.
    const ack = renderScaffoldingAck(Object.keys(LANE_SECTION_LABEL))!;
    // No digit at all — which forbids a clock, a date, a count, a percentage and an id in
    // one clause. (The prose says "for this turn"; that phrase is a constant, not state.)
    expect(ack).not.toMatch(/\d/);
    // And it is byte-identical no matter when or how often it is generated.
    const again = renderScaffoldingAck(Object.keys(LANE_SECTION_LABEL))!;
    expect(again).toBe(ack);
    expect(Buffer.from(again).equals(Buffer.from(ack))).toBe(true);
  });

  it('renders nothing when no scaffolding was admitted', () => {
    expect(renderScaffoldingAck([])).toBeNull();
    expect(renderScaffoldingAck(['lane.fresh-tail'])).toBeNull();
  });

  it('always names the live conversation in the ladder — it is the one lane that cannot be absent', () => {
    const ack = renderScaffoldingAck(['lane.briefing'])!;
    expect(ack).toContain('live conversation below');
  });

  it('prints the ladder in declared priority order', () => {
    const ack = renderScaffoldingAck(['lane.briefing', 'lane.scratchpad', 'lane.vault'])!;
    const ladder = ack.slice(ack.indexOf('Source priority for this turn: '));
    expect(ladder.indexOf('my scratchpad')).toBeLessThan(ladder.indexOf('live conversation'));
    expect(ladder.indexOf('live conversation')).toBeLessThan(ladder.indexOf('vault entries'));
    expect(ladder.indexOf('vault entries')).toBeLessThan(ladder.indexOf('briefing'));
  });

  it('reserves exactly what its own worst case costs — derived, never guessed', () => {
    const worst = renderScaffoldingAck(Object.keys(LANE_SECTION_LABEL))!;
    expect(SCAFFOLDING_ACK_RESERVE_TOKENS).toBe(estimateTokens(worst));
    // Any subset must fit inside the reservation, or the reservation is a lie.
    for (const id of Object.keys(LANE_SECTION_LABEL)) {
      const one = renderScaffoldingAck([id]);
      expect(estimateTokens(one ?? '')).toBeLessThanOrEqual(SCAFFOLDING_ACK_RESERVE_TOKENS);
    }
  });
});

describe('the post-budget appends are DECLARED lanes with reserved tokens (B7)', () => {
  it('every post-budget lane declares a reserve and where the number came from', () => {
    expect(POST_BUDGET_LANES.length).toBeGreaterThanOrEqual(7);
    for (const l of POST_BUDGET_LANES) {
      expect(l.reserveTokens, `${l.id} reserves nothing`).toBeGreaterThan(0);
      expect(l.measured, `${l.id} has no derivation`).toBeTruthy();
      expect(l.measured.length).toBeGreaterThan(20);
    }
  });

  it('the loop tail-append is one of them, at the volatile boundary', () => {
    const loop = POST_BUDGET_LANES.find((l) => l.id === 'lane.loop-tail')!;
    expect(loop).toBeTruthy();
    expect(loop.slot).toBe(1850); // MessageSlot.TurnContext — the boundary, by declaration
  });

  it('the reserve is the sum of its parts, not a round number somebody liked', () => {
    expect(POST_BUDGET_RESERVE_TOKENS).toBe(
      POST_BUDGET_LANES.reduce((t, l) => t + l.reserveTokens, 0),
    );
  });
});

describe('over-budget is a recorded EVENT, not a shrug (B8)', () => {
  it('honours the fresh tail\'s MANDATORY floor even when the budget cannot cover it', () => {
    const tail = textLane('lane.fresh-tail', LANE_PRIORITY['lane.fresh-tail'], 1100, {
      minTokens: 500, mandatoryFloor: true,
    });
    const first = textLane('lane.directive', LANE_PRIORITY['lane.directive'], 900);
    // 400-token budget, the directive takes all of it, the tail's floor is 500.
    const { report } = fitLanes([candidate(first, 400), candidate(tail, 5000)], 400);
    expect(report.grants.find((g) => g.id === 'lane.fresh-tail')!.granted).toBeGreaterThan(0);
    const ev = report.overBudget.find((e) => e.laneId === 'lane.fresh-tail');
    expect(ev, 'the forced inclusion was not recorded').toBeTruthy();
    expect(ev!.overBy).toBeGreaterThan(0);
    expect(ev!.reason).toContain('MANDATORY');
    expect(ev!.reason).toContain('B8');
  });

  it('a NON-mandatory floor that cannot be covered is a rejection with a reason, not silence', () => {
    const vault = textLane('lane.vault', LANE_PRIORITY['lane.vault'], 200, { minTokens: 500 });
    const first = textLane('lane.directive', LANE_PRIORITY['lane.directive'], 900);
    const { report } = fitLanes([candidate(first, 400), candidate(vault, 5000)], 400);
    const g = report.grants.find((x) => x.id === 'lane.vault')!;
    expect(g.status).toBe('rejected');
    expect(g.reason).toContain('budget exhausted before this lane');
    expect(report.overBudget).toHaveLength(0);
  });
});

describe('the declared numbers (§T0-B clusters C/D/E/F) are lane declarations', () => {
  it('reads a declared limit and refuses an undeclared one', () => {
    expect(laneLimit('lane.attempt-ledger', 'tokens', 'cap')).toBe(800);
    expect(laneLimit('lane.events', 'rows', 'events')).toBe(10);
    expect(laneLimit('lane.events', 'chars', 'gist')).toBe(400);
    expect(() => laneLimit('lane.events', 'rows', 'nope')).toThrow(/not declared/);
  });

  it('B6 reconcile: the recall window is the model-aware fresh-tail count, not a literal 80', () => {
    // §T0-B C `:1748` hardcoded 80 — `getFreshTailCount`'s 200K answer — while the tail
    // itself read 40 on a 32K model. The literal is gone from the declaration table.
    const rm = LANE_LIMITS['lane.relevant-memory'];
    expect(Object.values(rm.rows ?? {})).not.toContain(80);
  });

  it('every declared limit belongs to a lane that exists', () => {
    // The fit-ranked lanes, plus the three that declare limits without a priority: the PM
    // tail and the awareness gist (sub-renders of lanes that DO have one), and PHASE-3 T7's
    // `lane.deliveries`, which is POST-BUDGET — reserved off the top like the other seven in
    // POST_BUDGET_LANES, never ranked by the two-pass fit, because it rides the volatile
    // tail where the cache-prefix law puts per-turn content.
    const known = new Set([
      ...Object.keys(LANE_PRIORITY),
      ...POST_BUDGET_LANES.map((l) => l.id),
      'lane.pm-tail', 'lane.awareness-gist',
    ]);
    for (const id of Object.keys(LANE_LIMITS)) {
      expect(known.has(id), `${id} declares limits but is not a lane`).toBe(true);
    }
  });
});

describe('a zero-cost lane with content is never rejected', () => {
  // FOUND LIVE, not imagined: the kit's golden fixture writes its rows straight to the
  // table with `token_count = 0`, and `msg.tokenCount ?? estimateTokens(...)` returns 0 for
  // them — `0 ?? x` is 0. The whole fresh tail costed nothing, and an allocator that treats
  // "cost 0" as "grant 0" then DROPPED it. Two fixes, both here: `storedRowCost` restores
  // the write path's floor on the read side, and the allocator admits a rendered lane whose
  // measured cost is zero rather than rejecting it.
  it('admits it, with its content intact', () => {
    const lane = textLane('lane.fresh-tail', LANE_PRIORITY['lane.fresh-tail'], 1100, { minTokens: 64 });
    const messages = [{ role: 'user' as const, content: 'a real message' }];
    const c: LaneCandidate = { lane, render: { messages, tokens: 0 } };
    const { emitted, report } = fitLanes([c], 8000);
    const g = report.grants.find((x) => x.id === 'lane.fresh-tail')!;
    expect(g.status).toBe('admitted');
    expect(emitted.map((e) => e.id)).toContain('lane.fresh-tail');
    expect(emitted[0].messages).toEqual(messages);
  });

  it('still rejects a lane that rendered NOTHING — the two are different facts', () => {
    const lane = textLane('lane.vault', LANE_PRIORITY['lane.vault'], 200);
    const { report } = fitLanes([{ lane, render: null }], 8000);
    expect(report.grants[0].status).toBe('empty');
  });
});
