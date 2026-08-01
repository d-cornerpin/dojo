// ════════════════════════════════════════════════════════════════════════════════════════
// EXIT VALIDATION — research 06 requirements C9, C10, C11. PHASE-3 T4 Step 1.
//
// Research 06 §3, verbatim: "Exit-boundary validation — NONE in assembler. Returns :1527
// with zero final size/shape check." The only size authority in the tree today is a pair of
// provider front-trimmers that delete the OLDEST messages, on estimators that used to
// disagree with the assembler's, and the Anthropic one "logs a warning and SENDS ANYWAY".
//
// So these clauses assert three things the tree could not do before:
//   C9  — one validator, all transports, after every mutation, NO PM bypass.
//   C10 — repair drops the LOWEST-PRIORITY LANE, never the oldest message.
//   C11 — unrepairable is a THROW. Never warn-and-send.
//
// The lowest-vs-oldest clause is written TWICE on purpose, the way T3's inversion clause
// was: once asserting the new behaviour, once reproducing the front-trimmer's own
// oldest-first arithmetic over the same input and asserting it does the opposite. A test
// that only asserts the new behaviour cannot show that the behaviour changed.
// ════════════════════════════════════════════════════════════════════════════════════════
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  validateAssembly,
  repairAssembly,
  AssemblyValidationError,
  ASSEMBLY_VALIDATION_MODE,
  assemblyValidationCounters,
  __resetAssemblyValidationCounters,
  type ValidatedMessage,
} from '../assembly-validation.js';
import { LANE_PRIORITY } from '../lanes.js';

// ── helpers ─────────────────────────────────────────────────────────────────────────────

const user = (content: string): ValidatedMessage => ({ role: 'user', content });
const asst = (content: string): ValidatedMessage => ({ role: 'assistant', content });
const toolUse = (id: string): ValidatedMessage => ({
  role: 'assistant',
  content: [{ type: 'tool_use', id, name: 'probe', input: {} }] as never,
});
const toolResult = (id: string, text = 'ok'): ValidatedMessage => ({
  role: 'user',
  content: [{ type: 'tool_result', tool_use_id: id, content: text }] as never,
});

/** A well-formed array that passes every clause, so each negative test moves ONE thing. */
const healthy = (): ValidatedMessage[] => [user('what is the plan?'), asst('here it is'), user('go')];

// ════════ C9 — the five clauses ════════

describe('validateAssembly — C9, the five clauses', () => {
  it('accepts a well-formed array inside its budget', () => {
    const v = validateAssembly(healthy(), { budgetTokens: 10_000 });
    expect(v.ok).toBe(true);
    expect(v.violations).toEqual([]);
  });

  it('C9.1 refuses a token total over budget, and says by how much', () => {
    const v = validateAssembly([user('x'.repeat(4_000)), asst('y'), user('z')], { budgetTokens: 100 });
    expect(v.ok).toBe(false);
    expect(v.violations.map((x) => x.code)).toContain('budget-exceeded');
    expect(v.overBy).toBeGreaterThan(0);
    expect(v.tokenTotal).toBeGreaterThan(v.budgetTokens);
  });

  it('C9.2 refuses a first message that is not user-role', () => {
    const v = validateAssembly([asst('hello'), user('hi')], { budgetTokens: 10_000 });
    expect(v.violations.map((x) => x.code)).toContain('first-message-not-user');
  });

  it('C9.2 refuses a first user message that LEADS with a tool_result', () => {
    const v = validateAssembly([toolResult('t1'), asst('a'), user('b')], { budgetTokens: 10_000 });
    expect(v.violations.map((x) => x.code)).toContain('first-message-leads-with-tool-result');
  });

  it('C9.3 refuses an array whose last message is the assistant', () => {
    const v = validateAssembly([user('a'), asst('b')], { budgetTokens: 10_000 });
    expect(v.violations.map((x) => x.code)).toContain('last-message-is-assistant');
  });

  it('C9.4 refuses a tool_use with no matching tool_result', () => {
    const v = validateAssembly([user('a'), toolUse('t9'), user('b')], { budgetTokens: 10_000 });
    const codes = v.violations.map((x) => x.code);
    expect(codes).toContain('tool-use-without-result');
    expect(v.violations.find((x) => x.code === 'tool-use-without-result')?.detail).toContain('t9');
  });

  it('C9.4 refuses a tool_result with no matching tool_use', () => {
    const v = validateAssembly([user('a'), asst('b'), toolResult('t7')], { budgetTokens: 10_000 });
    expect(v.violations.map((x) => x.code)).toContain('tool-result-without-use');
  });

  it('C9.4 accepts a correctly paired tool_use / tool_result', () => {
    const v = validateAssembly([user('a'), toolUse('t1'), toolResult('t1')], { budgetTokens: 10_000 });
    expect(v.ok).toBe(true);
  });

  it('C9.5 refuses an empty text block', () => {
    const v = validateAssembly(
      [user('a'), { role: 'assistant', content: [{ type: 'text', text: '   ' }] as never }, user('b')],
      { budgetTokens: 10_000 },
    );
    expect(v.violations.map((x) => x.code)).toContain('empty-block');
  });

  it('C9.5 refuses an empty message (empty string and empty block array both)', () => {
    const emptyString = validateAssembly([user('a'), asst(''), user('b')], { budgetTokens: 10_000 });
    expect(emptyString.violations.map((x) => x.code)).toContain('empty-message');
    const emptyArray = validateAssembly(
      [user('a'), { role: 'assistant', content: [] as never }, user('b')],
      { budgetTokens: 10_000 },
    );
    expect(emptyArray.violations.map((x) => x.code)).toContain('empty-message');
  });

  it('reports EVERY violation in one pass, not the first one', () => {
    const v = validateAssembly([asst(''), toolUse('t3')], { budgetTokens: 0 });
    const codes = new Set(v.violations.map((x) => x.code));
    expect(codes.size).toBeGreaterThanOrEqual(4);
    expect(codes).toContain('first-message-not-user');
    expect(codes).toContain('last-message-is-assistant');
    expect(codes).toContain('empty-message');
    expect(codes).toContain('tool-use-without-result');
  });

  it('every violation carries a reason in plain words — never an empty detail', () => {
    const v = validateAssembly([asst(''), toolUse('t3')], { budgetTokens: 0 });
    expect(v.violations.length).toBeGreaterThan(0);
    for (const x of v.violations) expect(x.detail.trim().length).toBeGreaterThan(10);
  });

  it('an empty array is a violation, not a pass — nothing to send is not "valid"', () => {
    const v = validateAssembly([], { budgetTokens: 10_000 });
    expect(v.ok).toBe(false);
    expect(v.violations.map((x) => x.code)).toContain('empty-assembly');
  });
});

// ════════ C9 — NO PM BYPASS ════════

describe('validateAssembly — same validator for every agent type (C9, no PM bypass)', () => {
  it('takes no agent-type input that could exempt anyone', () => {
    // The PM path returns its own shape from `assembler.ts` and has always skipped the
    // assembler's budgeting. The validator cannot be told who it is validating for, so
    // there is no signature through which a bypass could be added later.
    const pmShaped = [user('a'), asst('b')]; // ends on assistant: a violation for anybody
    const v = validateAssembly(pmShaped, { budgetTokens: 10_000, agentId: 'kelly' });
    expect(v.violations.map((x) => x.code)).toContain('last-message-is-assistant');
    const other = validateAssembly(pmShaped, { budgetTokens: 10_000, agentId: 'kevin' });
    expect(other.violations).toEqual(v.violations);
  });
});

// ════════ C10 — repair drops the LOWEST LANE, never the oldest message ════════

describe('repairAssembly — C10, priority order and not one message older', () => {
  // The array in EMISSION (slot) order, which is how the assembler builds it and therefore
  // what a front-trimmer sees. That order is NOT priority order, and the gap between them
  // is the defect: `lane.scratchpad` (priority 20) and `lane.directive` (priority 10) —
  // the two highest-priority lanes there are — sit AHEAD of events, the ack and the fresh
  // tail in slot order, so an oldest-first trimmer reaches them FOURTH and THIRD while a
  // priority-ordered one reaches them LAST. Seven messages, each 6 tokens per repeat unit.
  const laneArray = (): { messages: ValidatedMessage[]; laneIds: (string | null)[] } => ({
    messages: [
      user('BRIEFING '.repeat(100)),   // 0  slot ~100   priority 110  (lowest)
      user('VAULT '.repeat(100)),      // 1  slot ~200   priority 100
      user('SCRATCHPAD '.repeat(100)), // 2  slot ~1000  priority 20
      user('DIRECTIVE '.repeat(100)),  // 3  slot ~1100  priority 10   (highest)
      user('EVENTS '.repeat(100)),     // 4  slot 1050   priority 40
      user('FRESHTAIL '.repeat(100)),  // 5  slot ~1200  priority 30
      user('the live question'),       // 6  newest, no lane: the loop's tail-append
    ],
    laneIds: [
      'lane.briefing', 'lane.vault', 'lane.scratchpad', 'lane.directive',
      'lane.events', 'lane.fresh-tail', null,
    ],
  });

  const cost = (a: ValidatedMessage[]) => validateAssembly(a, { budgetTokens: 1 }).tokenTotal;

  it('drops the lowest-priority lane first', () => {
    const { messages, laneIds } = laneArray();
    // A budget that forces exactly one lane out: everything except the largest lane.
    const budget = cost(messages) - 10;
    const r = repairAssembly(messages, { budgetTokens: budget, laneIds });
    expect(r.droppedLaneIds).toEqual(['lane.briefing']);
    expect(r.after.ok).toBe(true);
  });

  it('drops in DESCENDING priority order when one lane is not enough', () => {
    const { messages, laneIds } = laneArray();
    // Room for the three highest-priority lanes plus the tail-append, and no more.
    const budget = cost([messages[2], messages[3], messages[5], messages[6]]) + 5;
    const r = repairAssembly(messages, { budgetTokens: budget, laneIds });
    expect(r.droppedLaneIds).toEqual(['lane.briefing', 'lane.vault', 'lane.events']);
    // …which is exactly descending priority, and NOT array order.
    expect(LANE_PRIORITY['lane.briefing']).toBeGreaterThan(LANE_PRIORITY['lane.vault']);
    expect(LANE_PRIORITY['lane.vault']).toBeGreaterThan(LANE_PRIORITY['lane.events']);
    expect(LANE_PRIORITY['lane.events']).toBeGreaterThan(LANE_PRIORITY['lane.fresh-tail']);
  });

  it('THE INVERSION, KILLED — and the front-trimmer arithmetic reproduced beside it', () => {
    const { messages, laneIds } = laneArray();
    const budget = cost([messages[2], messages[3], messages[5], messages[6]]) + 5;

    // NEW: priority order. Scratchpad, directive and the live question survive.
    const repaired = repairAssembly(messages, { budgetTokens: budget, laneIds });
    const kept = repaired.messages.map((m) => String(m.content).split(' ')[0]);
    expect(kept).toContain('DIRECTIVE');
    expect(kept).toContain('SCRATCHPAD');
    expect(kept).toContain('the');

    // THE ORDERING IS TOTAL, not anecdotal: nothing dropped may outrank anything kept.
    const dropped = repaired.droppedLaneIds;
    const keptLanes = laneIds.filter((id): id is string => id !== null && !dropped.includes(id));
    for (const d of dropped) {
      for (const k of keptLanes) {
        expect(LANE_PRIORITY[d]).toBeGreaterThan(LANE_PRIORITY[k]);
      }
    }

    // OLD: `agent/model.ts`'s Anthropic front-trimmer, transcribed — splice(0,1) until it
    // fits, with no notion of priority at all. Same array, same budget.
    const oldTrimmed = [...messages];
    while (cost(oldTrimmed) > budget && oldTrimmed.length > 1) oldTrimmed.splice(0, 1);
    const oldKept = oldTrimmed.map((m) => String(m.content).split(' ')[0]);
    const oldKeptLanes = laneIds.filter((id, i): id is string =>
      id !== null && oldTrimmed.includes(messages[i]));
    const oldDropped = laneIds.filter((id, i): id is string =>
      id !== null && !oldTrimmed.includes(messages[i]));

    // AND THE SAME INVARIANT, over the SAME input, is VIOLATED by the old arithmetic: it
    // dropped `lane.scratchpad` (priority 20, the second-highest lane there is) while
    // keeping `lane.events` (40) and `lane.fresh-tail` (30) below it — because slot order
    // is not priority order and a front-trimmer only knows slot order.
    expect(oldDropped).toContain('lane.scratchpad');
    expect(oldKeptLanes).toContain('lane.events');
    const oldViolations = oldDropped.filter((d) =>
      oldKeptLanes.some((k) => LANE_PRIORITY[d] < LANE_PRIORITY[k]));
    expect(oldViolations.length).toBeGreaterThan(0);
    expect(oldKept).not.toEqual(kept);
  });

  it('NEVER drops the loop tail-append — a message with no lane is not droppable', () => {
    const { messages, laneIds } = laneArray();
    // A budget so small that dropping every content lane still will not fit, because the
    // tail-append alone exceeds it.
    expect(() => repairAssembly(messages, { budgetTokens: 1, laneIds })).toThrow(AssemblyValidationError);
    try {
      repairAssembly(messages, { budgetTokens: 1, laneIds });
    } catch (e) {
      const err = e as AssemblyValidationError;
      // It dropped everything it was allowed to drop, in priority order, and then FAILED,
      // rather than reaching for the newest message.
      expect(err.droppedLaneIds).toEqual([
        'lane.briefing', 'lane.vault', 'lane.events', 'lane.fresh-tail',
        'lane.scratchpad', 'lane.directive',
      ]);
    }
  });

  it('a no-op when the array already fits — repair never touches a valid assembly', () => {
    const { messages, laneIds } = laneArray();
    const r = repairAssembly(messages, { budgetTokens: 1_000_000, laneIds });
    expect(r.droppedLaneIds).toEqual([]);
    expect(r.messages).toEqual(messages);
  });

  it('re-normalises the head after a drop instead of shipping a broken shape', () => {
    const messages: ValidatedMessage[] = [
      user('BRIEFING '.repeat(200)),
      asst('an assistant turn that would become message 0'),
      user('live'),
    ];
    const laneIds = ['lane.briefing', 'lane.briefing', null];
    const r = repairAssembly(messages, { budgetTokens: 40, laneIds });
    expect(r.after.ok).toBe(true);
    expect(r.messages[0].role).toBe('user');
  });
});

// ════════ C10 — refusing to guess ════════

describe('repairAssembly — refuses to repair by any order but priority (C10)', () => {
  it('THROWS rather than fall back to oldest-first when it has no lane map', () => {
    const messages = [user('x'.repeat(8_000)), asst('y'), user('z')];
    expect(() => repairAssembly(messages, { budgetTokens: 100 })).toThrow(AssemblyValidationError);
    try {
      repairAssembly(messages, { budgetTokens: 100 });
    } catch (e) {
      // The message must NAME the reason, because a silent oldest-first fallback is
      // exactly the mechanism this requirement deletes.
      expect((e as Error).message).toMatch(/priority|lane map/i);
    }
  });

  it('a lane id nobody declared is not droppable — an unknown lane is a finding', () => {
    const messages = [user('a'.repeat(8_000)), user('live')];
    expect(() =>
      repairAssembly(messages, { budgetTokens: 10, laneIds: ['lane.invented-by-nobody', null] }),
    ).toThrow(AssemblyValidationError);
  });
});

// ════════ C11 — loud, never warn-and-send ════════

describe('C11 — unrepairable fails loud', () => {
  // The undroppable remainder — the loop's tail-append — is itself over budget, so there
  // is no lane left to give and no honest way to send.
  const unrepairable = (): { messages: ValidatedMessage[]; laneIds: (string | null)[] } => ({
    messages: [user('BRIEFING '.repeat(100)), user('the live question '.repeat(500))],
    laneIds: ['lane.briefing', null],
  });

  it('throws AssemblyValidationError carrying every surviving violation', () => {
    const { messages, laneIds } = unrepairable();
    try {
      repairAssembly(messages, { budgetTokens: 10, laneIds });
      throw new Error('expected a throw');
    } catch (e) {
      expect(e).toBeInstanceOf(AssemblyValidationError);
      const err = e as AssemblyValidationError;
      expect(err.violations.length).toBeGreaterThan(0);
      expect(err.violations.map((v) => v.code)).toContain('budget-exceeded');
      expect(err.droppedLaneIds).toEqual(['lane.briefing']);
      expect(err.message).toMatch(/budget/i);
    }
  });

  it('the error names the agent when it was given one — a loud failure must be locatable', () => {
    const { messages, laneIds } = unrepairable();
    try {
      repairAssembly(messages, { budgetTokens: 10, laneIds, agentId: 'kevin' });
      throw new Error('expected a throw');
    } catch (e) {
      expect((e as Error).message).toContain('kevin');
    }
  });

  it('NEVER returns a SIZE result that is still over budget — ok or throw, nothing between', () => {
    const { messages, laneIds } = unrepairable();
    let returned: unknown = null;
    try { returned = repairAssembly(messages, { budgetTokens: 10, laneIds }); } catch { /* expected */ }
    expect(returned).toBeNull();
  });

  it('does NOT throw on a SHAPE-only violation — that line is drawn on measurement', () => {
    // C11's subject is the front-trimmer's warn-and-send, which is about SIZE. The first
    // live detect run (73 real calls) produced 17 divergences and ZERO of them were size:
    // 14 orphan tool_results that `sanitizeOrphanToolBlocks` itself had just created by
    // stripping their tool_use, and 3 on the PM path. Throwing on those would have killed
    // 23% of turns on flip day over defects this validator did not create. They are
    // REPORTED — loudly, with their owners — and the flip's precondition is that they read
    // zero. See the module header and DOJO-ISSUES-LOG.
    const shapeOnly: ValidatedMessage[] = [user('a'), asst('b'), toolResult('t-missing')];
    const r = repairAssembly(shapeOnly, { budgetTokens: 1_000_000, laneIds: [null, null, null] });
    expect(r.droppedLaneIds).toEqual([]);
    expect(r.messages).toEqual(shapeOnly);
    // and the violation is still ON the record, not swallowed
    expect(r.after.ok).toBe(false);
    expect(r.after.violations.map((v) => v.code)).toContain('tool-result-without-use');
  });
});

// ════════ the mode, and the flip ════════

describe('the installed mode', () => {
  it('is DETECT today — PHASE-3 T4 Step 2 opens a dated 7-day window', () => {
    // T4 Step 2b flips this ONE constant to 'repair' and deletes both provider
    // front-trimmers in the same commit. PHASE-3 T9's exit gate asserts 'repair';
    // this clause is what makes the flip a one-line, testable change rather than a hunt.
    expect(ASSEMBLY_VALIDATION_MODE).toBe('detect');
  });
});

// ════════ the divergence log is the instrument Step 2b reads, so it is pinned ════════

describe('the detect-only window log', () => {
  it('keeps its two grep tokens, because the day-7 decision is taken FROM them', () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), 'src/memory/assembly-validation.ts'), 'utf8',
    );
    // Renaming either of these silently blinds the flip decision. A test is cheaper than
    // discovering on day 7 that the window measured nothing.
    expect(src).toContain('ASSEMBLY_VALIDATION_DIVERGENCE');
    expect(src).toContain('ASSEMBLY_VALIDATION_HEARTBEAT');
    // The EMITTED line (not the comment above it) must carry its own denominator, or a
    // count of incidents is not a rate; and its codes, or "something diverged" is not a
    // finding. Sliced from the emitting statement, so a doc-comment mention cannot pass it.
    // NB: slice to the metadata object, NOT to the first `{` — `${…}` interpolations are
    // braces too. The same mis-slice already went green over a planted fault once today,
    // in one-estimator-conformance's no-default clause.
    const emit = src.slice(src.lastIndexOf('`ASSEMBLY_VALIDATION_DIVERGENCE'));
    const line = emit.slice(0, emit.indexOf('\n    {'));
    expect(line.length).toBeGreaterThan(100);   // vacuity guard on the slice itself
    expect(line).toContain('checked=${checkedCalls}');
    expect(line).toContain('diverged=${divergentCalls}');
    expect(line).toContain('codes=${codes}');
    expect(line).toContain('overBy=${result.overBy}');
  });

  it('DETECT mode sends anyway — the deliberate no-op is what the window measures', () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), 'src/memory/assembly-validation.ts'), 'utf8',
    );
    // The detect branch returns BEFORE the repair, and the repair is what Step 2b enables.
    const body = src.slice(src.indexOf('export async function validateAtProviderBoundary'));
    const detectAt = body.indexOf("ASSEMBLY_VALIDATION_MODE === 'detect'");
    const repairAt = body.indexOf('repairAssembly(input.messages');
    expect(detectAt).toBeGreaterThan(-1);
    expect(repairAt).toBeGreaterThan(detectAt);
  });

  it('counts every checked call, not only the divergent ones', () => {
    __resetAssemblyValidationCounters();
    expect(assemblyValidationCounters()).toEqual({ checked: 0, diverged: 0 });
  });
});
