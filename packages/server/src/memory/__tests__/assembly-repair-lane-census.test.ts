// ════════════════════════════════════════════════════════════════════════════════════════
// THE PRIORITY REPAIR READS **BOTH** LANE TABLES — PHASE-6 T13 (the tail-append lane gap).
//
// ── THE DEFECT THESE CLAUSES WERE WRITTEN AGAINST ───────────────────────────────────────
// `repairAssembly` refuses when the lane map carries an id "no lane table declares" (C10:
// dropping content whose priority is unknown is a guess). It read exactly ONE table —
// `LANE_PRIORITY`, the twelve ALLOCATOR lanes — while the tree declares TWO: the allocator's
// and `POST_BUDGET_LANES`, the content added AFTER the budget decision, each entry with its
// own reserve.
//
// PHASE-3 T6 (F23) then tagged every injection at emission, which is what closed the trap:
// from that commit on, a real engine assembly reaching the boundary carries ids such as
// `msg.turn-context` and `msg.current-time` — declared in the post-budget table and in the
// prompt registry, absent from `LANE_PRIORITY`. So the FIRST thing `repairAssembly` did with
// a real over-budget engine assembly was REFUSE it, before reaching the droppable loop at
// all. Measured, both arms, at `2b20977`:
//
//   tail TAGGED (production shape)   -> throws "carries lane id(s) no lane table declares:
//                                       msg.current-time"
//   tail UNTAGGED (pre-T6 shape)     -> repairs: drops `lane.briefing`, keeps the tail
//
// `c4680c9` (2026-08-01) flipped the mode to `'repair'` and DELETED both provider
// front-trimmers in the same commit, so on the engine's own path there is no backstop
// underneath: an over-budget assembly is a thrown turn where the design says drop the
// lowest-priority lane and proceed. Requirement C10 has therefore never repaired a real
// engine assembly.
//
// ── WHY "RECOGNISED BUT NEVER DROPPED" IS THE RESTORATION, NOT A NEW CHOICE ─────────────
// `assembly-validation.ts`'s own header names the case: "a message no lane claims (that is
// the loop's tail-append — the thing that just arrived, and the FIRST CASUALTY of every
// oldest-first trimmer this replaces)". Protecting the tail is the design; the tag turned
// protection into refusal. These clauses assert the design, and the last one asserts that
// protection did NOT become warn-and-send: when the protected content alone will not fit,
// C11's loud throw still fires.
//
// ── THE CENSUS ─────────────────────────────────────────────────────────────────────────
// A declared list drifts the moment somebody registers a new injection. So the membership
// is held BOTH WAYS against the registry AT RUNTIME (a census that greps is a census that
// lies — T0C), and the three engine-side literals are censused against their own source.
// A new untagged-and-undeclared injection still hits the refusal, which is the guard's
// remaining job.
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect } from 'vitest';
import {
  repairAssembly,
  AssemblyValidationError,
  type ValidatedMessage,
} from '../assembly-validation.js';
import { LANE_PRIORITY, POST_BUDGET_LANES, POST_BUDGET_ENTRY_LANE, isProtectedLaneId } from '../lanes.js';
import { tagMessageLane, collectMessageLaneIds } from '../message-lane-tag.js';
// The engine's own corpus, DERIVED — never a hand-rolled path into `agent/v2/steps`.
// `guard-corpus-census.test.ts` refuses a second copy of that walk, and it refused this
// file's first draft: the injection sites move with their tranche, and a guard that reads
// them by path goes QUIET rather than red when they do.
import { engineFileContaining } from '../../agent/v2/__tests__/engine-sources.js';

const user = (c: string): ValidatedMessage => ({ role: 'user', content: c });
const asst = (c: string): ValidatedMessage => ({ role: 'assistant', content: c });

/**
 * A realistic over-budget assembly: a fat allocator lane (droppable), a live tail, and one
 * post-budget message tagged with `tailId`. 500 tokens of budget against ~4,500 spent.
 */
const overBudget = (tailId: string): ValidatedMessage[] => [
  tagMessageLane(user('briefing '.repeat(2_000)), 'lane.briefing'),
  tagMessageLane(asst('understood'), 'lane.fresh-tail'),
  tagMessageLane(user('the live question'), 'lane.fresh-tail'),
  tagMessageLane(user('CURRENT TIME: 2026-08-04T20:00:00Z'), tailId),
];

const repair = (messages: ValidatedMessage[], budgetTokens = 500) =>
  repairAssembly(messages, { budgetTokens, laneIds: collectMessageLaneIds(messages), agentId: 'kevin' });

describe('the priority repair recognises post-budget lanes instead of refusing', () => {
  it('C10.1 an over-budget assembly carrying a loop-tail entry id REPAIRS (it used to refuse)', () => {
    const r = repair(overBudget('msg.current-time'));
    expect(r.droppedLaneIds).toContain('lane.briefing');
    expect(r.after.ok).toBe(true);
  });

  it('C10.2 the tail-append SURVIVES the repair — it is the newest content, never the first casualty', () => {
    const r = repair(overBudget('msg.turn-context'));
    const kept = r.messages.map((m) => String(m.content));
    expect(kept.some((c) => c.startsWith('CURRENT TIME:'))).toBe(true);
    expect(r.droppedLaneIds).not.toContain('msg.turn-context');
  });

  it('C10.3 the same holds for the engine-side injections and for `lane.deliveries`', () => {
    for (const id of ['engine.open-work', 'engine.recent-outbound', 'engine.recently-answered', 'msg.deliveries']) {
      const r = repair(overBudget(id));
      expect(r.after.ok, `${id} should repair`).toBe(true);
      expect(r.droppedLaneIds, `${id} must not be dropped`).not.toContain(id);
    }
  });

  it('C10.4 and for every lane the post-budget table declares, plus the PM tail', () => {
    for (const id of [...POST_BUDGET_LANES.map((l) => l.id), 'lane.pm-tail']) {
      const r = repair(overBudget(id));
      expect(r.after.ok, `${id} should repair`).toBe(true);
      expect(r.droppedLaneIds, `${id} must not be dropped`).not.toContain(id);
    }
  });

  it('C10.5 NEGATIVE CONTROL: a genuinely undeclared id still refuses, by name', () => {
    let msg = '';
    try {
      repair(overBudget('lane.invented-by-nobody'));
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain('no lane table declares');
    expect(msg).toContain('lane.invented-by-nobody');
  });

  it('C11 protection did NOT become warn-and-send: protected content that will not fit still THROWS', () => {
    const messages: ValidatedMessage[] = [
      tagMessageLane(user('briefing '.repeat(200)), 'lane.briefing'),
      tagMessageLane(user('turn context '.repeat(4_000)), 'msg.turn-context'),
    ];
    expect(() => repair(messages, 500)).toThrow(AssemblyValidationError);
    try {
      repair(messages, 500);
    } catch (e) {
      expect((e as Error).message).toContain('STILL over budget');
      expect((e as Error).message).toContain('lane.briefing');
    }
  });

  it('a lane id is EITHER an allocator lane OR protected, never both', () => {
    for (const id of Object.keys(LANE_PRIORITY)) expect(isProtectedLaneId(id), id).toBe(false);
    for (const id of Object.keys(POST_BUDGET_ENTRY_LANE)) expect(LANE_PRIORITY[id], id).toBeUndefined();
    for (const l of POST_BUDGET_LANES) expect(LANE_PRIORITY[l.id], l.id).toBeUndefined();
  });
});

describe('THE CENSUS — the declared membership cannot drift from what actually injects', () => {
  it('every REGISTERED message entry is declared post-budget, and every declared `msg.` key is registered', async () => {
    await import('../../prompt/registry/entries.js');
    const { getMessageEntries } = await import('../../prompt/registry/registry.js');
    const registered = getMessageEntries().map((e) => e.id).sort();
    const declared = Object.keys(POST_BUDGET_ENTRY_LANE).filter((k) => k.startsWith('msg.')).sort();
    expect(registered.length).toBeGreaterThan(0);
    expect(declared).toEqual(registered);
  });

  it('every engine-side `pushEngineMessage` literal is declared, and every declared `engine.` key is injected', () => {
    const site = engineFileContaining("'engine.open-work'");
    expect(site, 'no engine source injects `engine.open-work` — the sites MOVED').not.toBeNull();
    const injected = [...site!.text.matchAll(/pushEngineMessage\([\s\S]*?'(engine\.[a-z0-9-]+)'\s*\)/g)]
      .map((m) => m[1]);
    const found = [...new Set(injected)].sort();
    const declared = Object.keys(POST_BUDGET_ENTRY_LANE).filter((k) => k.startsWith('engine.')).sort();
    expect(found.length).toBeGreaterThan(0);
    expect(declared).toEqual(found);
  });

  it('every entry maps to a lane the post-budget table actually declares', () => {
    const postBudgetIds = new Set(POST_BUDGET_LANES.map((l) => l.id));
    for (const [entry, lane] of Object.entries(POST_BUDGET_ENTRY_LANE)) {
      expect(postBudgetIds.has(lane), `${entry} -> ${lane}`).toBe(true);
    }
  });
});
