// ════════════════════════════════════════
// PHASE-2 T8V — the verb collapse's liveness proof.
//
// THE FAILURE THIS FILE EXISTS TO CATCH, stated plainly, because it is not the
// obvious one. `tools/aliases.ts` canonicalises every retired verb name at loop
// ingestion, BEFORE any gate or classifier reads the call. That is exactly right
// for the model's calls and exactly why the collapse is dangerous: a classifier
// still watching for `tracker_create_task` does not error, does not warn, and
// does not appear in any diff — it simply stops firing the moment the model
// calls `work_open`. T8b2 measured ~20 engine behaviours in that position and
// stopped the collapse on the number.
//
// So this file is not a unit test of a helper. It is a CANARY PER BEHAVIOUR: for
// each engine behaviour that used to decide something by matching a tool NAME,
// it holds the new operation-keyed predicate against the retired names the
// behaviour used to fire on — in BOTH directions, because a set that quietly
// gains `work_update` fires on everything (a board LIST would satisfy the
// close-out gate) and a set that quietly loses an op fires on nothing.
//
// A failure here reads as "behaviour X went dark", which is the sentence the
// next battery would otherwise have had to guess at.
// ════════════════════════════════════════
import { describe, it, expect } from 'vitest';
import {
  WORK_VERBS,
  WORK_OPS,
  isWorkVerb,
  isWorkOp,
  workOperation,
  toolOpKey,
  isTrackerFamilyCall,
  isCommitmentOp,
  isWorkReadOp,
  CLOSING_WORK_OPS,
  PROGRESS_WORK_OPS,
  SATISFYING_WORK_OPS,
  CLOSE_OUT_WORK_OPS,
  DISARMING_WORK_OPS,
  CLOSE_OPS_WITH_TASK_ID,
} from '../work-verbs.js';
import { TOOL_ALIASES, resolveToolAlias, isTombstone } from '../aliases.js';
import { STRUCTURING_OPS } from '../../agent/v2/classifiers/hoarding.js';
import { WORK_OP_CONCURRENCY } from '../../agent/v2/classifiers/concurrency.js';
import { PM_ALLOWED_WORK_OPS, PM_ONLY_WORK_OPS, PRIMARY_ONLY_WORK_OPS, PM_ALLOWED_TOOLS } from '../../tracker/pm-agent.js';
import { classifyTool } from '@dojo/shared';

// ────────────────────────────────────────────────────────────────────────────
// The 24 retired verbs, each with a REPRESENTATIVE CALL — the shape a model
// actually sent before the collapse. This table is the spine of every test
// below: it is what lets a canary say "tracker_close_project" instead of
// "work_update:close_project", which is the name a reader of the old code and
// of PINNED §6's retired-verb list will be looking for.
// ────────────────────────────────────────────────────────────────────────────
const RETIRED: Array<{ name: string; args: Record<string, unknown>; op: string }> = [
  { name: 'tracker_create_project', args: { title: 'Roof', level: 2, tasks: [{ title: 'scope' }] }, op: 'work_open:project' },
  { name: 'tracker_create_task', args: { title: 'Pull the quotes' }, op: 'work_open:task' },
  { name: 'reminder_create', args: { what: 'go get coffee', when: '2026-07-29T18:00:00Z' }, op: 'work_open:reminder' },
  { name: 'commitment_open', args: { description: 'email Bob the roof quote' }, op: 'work_open:commitment' },
  { name: 'tracker_update_status', args: { task_id: 'abc12345', status: 'complete', result: 'done', evidence: [] }, op: 'work_update:status' },
  { name: 'tracker_edit_task', args: { task_id: 'abc12345', title: 'Renamed' }, op: 'work_update:edit' },
  { name: 'tracker_edit_project', args: { project_id: 'proj1234', title: 'Renamed' }, op: 'work_update:edit' },
  { name: 'tracker_reassign_task', args: { task_id: 'abc12345', assigned_to: 'maddy' }, op: 'work_update:reassign' },
  { name: 'tracker_complete_step', args: { task_id: 'abc12345', notes: 'step done' }, op: 'work_update:complete_step' },
  { name: 'tracker_close_project', args: { project_id: 'proj1234', reason: 'superseded' }, op: 'work_update:close_project' },
  { name: 'tracker_list_active', args: { filter: 'mine' }, op: 'work_update:list' },
  { name: 'tracker_get_status', args: { id: 'abc12345' }, op: 'work_update:get' },
  { name: 'tracker_add_notes', args: { task_id: 'abc12345', notes: 'still working' }, op: 'work_note' },
  { name: 'tracker_request_override', args: { task_id: 'abc12345', requested_status: 'complete', justification: 'x'.repeat(40) }, op: 'work_close_request:override' },
  { name: 'tracker_request_user_verdict', args: { task_id: 'abc12345', status_requested: 'complete', agent_summary: 'x'.repeat(40), pm_rejection_summary: 'y'.repeat(30) }, op: 'work_close_request:user_verdict' },
  { name: 'commitment_resolve', args: { id: 'cmt:1a2b3c4d5e6f', disposition: 'kept' }, op: 'work_close_request:commitment' },
  { name: 'tracker_validate', args: { kind: 'complete', task_id: 'abc12345', valid: true }, op: 'work_validate:validate' },
  { name: 'tracker_retask', args: { task_id: 'abc12345', directive: 'd'.repeat(40) }, op: 'work_validate:retask' },
  { name: 'tracker_override', args: { override_request_id: 'ovr12345', approve: true, reason: 'ok' }, op: 'work_validate:override' },
  { name: 'tracker_apply_user_verdict', args: { task_id: 'abc12345', status: 'complete', user_quote: 'yes it is done' }, op: 'work_validate:apply_user_verdict' },
  { name: 'tracker_apply_user_validation', args: { task_id: 'abc12345', validated: true, user_quote: 'yep' }, op: 'work_validate:apply_user_validation' },
  { name: 'tracker_pause_schedule', args: { task_id: 'abc12345' }, op: 'work_schedule:pause' },
  { name: 'tracker_resume_schedule', args: { task_id: 'abc12345' }, op: 'work_schedule:resume' },
  { name: 'tracker_resolve_missed_runs', args: { task_id: 'abc12345', action: 'run_now' }, op: 'work_schedule:resolve_missed' },
];

/** Canonicalise a retired call exactly as loop-ingestion hook 1 does, then read its op. */
function opAfterAlias(name: string, args: Record<string, unknown>): string {
  const r = resolveToolAlias(name, args);
  expect(isTombstone(TOOL_ALIASES[name] ?? { to: '' }), `${name} must be a rename, not a tombstone`).toBe(false);
  return toolOpKey(r.name, r.args);
}

describe('T8V — the collapse is total and reversible at the boundary', () => {
  it('all 24 retired verbs are gone from the public surface and all six new ones exist', () => {
    expect([...WORK_VERBS]).toHaveLength(6);
    for (const { name } of RETIRED) {
      expect(isWorkVerb(name), `${name} must not be a public verb any more`).toBe(false);
    }
  });

  it('every retired verb has an alias row that lands on its verb', () => {
    for (const { name } of RETIRED) {
      const entry = TOOL_ALIASES[name];
      expect(entry, `${name} has no alias row — a model still holding this name gets "unknown tool"`).toBeDefined();
      expect(isTombstone(entry!), `${name} must route, not tombstone`).toBe(false);
      expect(WORK_VERBS as readonly string[]).toContain((entry as { to: string }).to);
      expect((entry as { added?: string }).added, `${name}'s alias row needs an added: stamp for SWEEP-F T7`).toBeTruthy();
    }
  });

  it('THE ROUND TRIP: every retired call reaches the operation it always did', () => {
    // This is the single strongest "nothing went dark" proof. Old name + the
    // arguments a model actually sent, through the real alias resolver, must land
    // on the one operation that name used to be.
    const wrong: string[] = [];
    for (const { name, args, op } of RETIRED) {
      const got = opAfterAlias(name, args);
      if (got !== op) wrong.push(`${name} -> ${got} (expected ${op})`);
    }
    expect(wrong, 'a retired verb no longer reaches its operation').toEqual([]);
  });

  it('the 24 retired verbs cover all 23 operations, and every operation is reachable', () => {
    const covered = new Set(RETIRED.map((r) => r.op));
    expect([...WORK_OPS].filter((op) => !covered.has(op)), 'an operation no retired verb maps to').toEqual([]);
    expect([...covered].filter((op) => !isWorkOp(op)), 'a phantom operation id in the retired table').toEqual([]);
    expect(WORK_OPS).toHaveLength(23); // 24 verbs, two edits share one op
  });

  it('the missed-runs discriminator collision is broken, not papered over', () => {
    // `tracker_resolve_missed_runs` had its OWN parameter called `action`, and one
    // of its values was "pause" — the same word as a work_schedule action. Without
    // the transform, resolving a missed-runs alert with "pause" would silently
    // become "pause the schedule", a different operation.
    const r = resolveToolAlias('tracker_resolve_missed_runs', { task_id: 'abc12345', action: 'pause' });
    expect(toolOpKey(r.name, r.args)).toBe('work_schedule:resolve_missed');
    expect(r.args.resolution).toBe('pause');
    // and a genuine schedule pause is still a schedule pause
    expect(opAfterAlias('tracker_pause_schedule', { task_id: 'abc12345' })).toBe('work_schedule:pause');
  });
});

describe('T8V — absorb-don\'t-refuse (#77): a weak model that omits the discriminator', () => {
  const CASES: Array<[string, Record<string, unknown>, string]> = [
    ['work_open', { title: 'A thing' }, 'work_open:task'],
    ['work_open', { title: 'A project', level: 2, tasks: [] }, 'work_open:project'],
    ['work_open', { what: 'call mom' }, 'work_open:reminder'],
    ['work_open', { description: 'I will send the quote' }, 'work_open:commitment'],
    ['work_update', { task_id: 'a', status: 'complete' }, 'work_update:status'],
    ['work_update', { task_id: 'a', title: 'new' }, 'work_update:edit'],
    // §7.2's named absorb rule: a project_id without a task_id is a project edit.
    ['work_update', { project_id: 'p', title: 'new' }, 'work_update:edit'],
    ['work_update', { project_id: 'p', reason: 'superseded' }, 'work_update:close_project'],
    ['work_update', { task_id: 'a', assigned_to: 'maddy' }, 'work_update:reassign'],
    ['work_update', { task_id: 'a' }, 'work_update:get'],
    ['work_update', {}, 'work_update:list'],
    ['work_close_request', { id: 'cmt:abc', disposition: 'kept' }, 'work_close_request:commitment'],
    ['work_close_request', { task_id: 'a', requested_status: 'complete' }, 'work_close_request:override'],
    ['work_validate', { task_id: 'a', directive: 'd' }, 'work_validate:retask'],
    ['work_validate', { override_request_id: 'o', approve: true }, 'work_validate:override'],
    ['work_validate', { task_id: 'a', validated: false }, 'work_validate:apply_user_validation'],
    ['work_validate', { task_id: 'a', kind: 'pause', valid: true }, 'work_validate:validate'],
    ['work_schedule', { task_id: 'a' }, 'work_schedule:pause'],
    ['work_schedule', { task_id: 'a', resolution: 'skip' }, 'work_schedule:resolve_missed'],
  ];
  for (const [verb, args, op] of CASES) {
    it(`${verb}(${Object.keys(args).join(',') || '—'}) resolves to ${op}`, () => {
      expect(workOperation(verb, args)).toBe(op);
    });
  }

  it('the inference is TOTAL — no verb, in any shape, resolves to null', () => {
    for (const verb of WORK_VERBS) {
      for (const args of [{}, { task_id: 'x' }, { junk: 1 }, { action: 'nonsense' }, { kind: 'nonsense' }]) {
        expect(workOperation(verb, args), `${verb} refused ${JSON.stringify(args)}`).not.toBeNull();
      }
    }
  });

  it('a non-work tool is never claimed by the matcher', () => {
    for (const n of ['file_write', 'exec', 'send_to_agent', 'vault_remember', 'load_tool_docs', 'complete_task']) {
      expect(workOperation(n, {})).toBeNull();
      expect(toolOpKey(n, {})).toBe(n); // and toolOpKey falls back to the plain name
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// THE CANARIES. One per engine behaviour that used to match on a tool NAME.
// `fires` = the retired names the behaviour fired on; `silent` = names that were
// deliberately NOT in the set, which matters just as much (FN-9's read carve-out,
// FA-T2's close carve-out, the PM's status-flip refusal).
// ────────────────────────────────────────────────────────────────────────────
type Canary = {
  behaviour: string;
  where: string;
  test: (name: string, args: Record<string, unknown>) => boolean;
  fires: string[];
  silent: string[];
};

const inSet = (s: ReadonlySet<string>) => (n: string, a: Record<string, unknown>) => s.has(toolOpKey(n, a));

const CANARIES: Canary[] = [
  {
    behaviour: 'B1 close-out / transition detection (transitionedThisTurn, the promise floor\'s transition test, the thrash-gate clear, trackerStatusUpdatedThisTurn, the end-of-turn close detector)',
    where: 'agent/v2/loop.ts via CLOSING_WORK_OPS',
    test: inSet(CLOSING_WORK_OPS),
    fires: ['tracker_update_status', 'tracker_complete_step', 'tracker_close_project'],
    silent: ['tracker_add_notes', 'tracker_list_active', 'tracker_get_status', 'tracker_create_task', 'commitment_resolve'],
  },
  {
    behaviour: 'B2 thrash-counter forward progress',
    where: 'agent/v2/loop.ts via PROGRESS_WORK_OPS',
    test: inSet(PROGRESS_WORK_OPS),
    fires: ['tracker_update_status', 'tracker_complete_step', 'tracker_add_notes'],
    silent: ['tracker_close_project', 'tracker_get_status', 'tracker_list_active'],
  },
  {
    behaviour: 'B3 pre-turn close-out gate SATISFACTION (disengages the gate for the rest of the turn)',
    where: 'agent/v2/loop.ts via SATISFYING_WORK_OPS',
    test: inSet(SATISFYING_WORK_OPS),
    fires: ['tracker_update_status', 'tracker_complete_step', 'tracker_add_notes', 'tracker_close_project'],
    // reads may PASS the gate but must not disengage it
    silent: ['tracker_get_status', 'tracker_list_active', 'tracker_edit_task'],
  },
  {
    behaviour: 'B4 pre-turn close-out gate ALLOWLIST (what an agent with danglers may still call)',
    where: 'agent/v2/loop.ts via CLOSE_OUT_WORK_OPS',
    test: inSet(CLOSE_OUT_WORK_OPS),
    fires: [
      'tracker_update_status', 'tracker_complete_step', 'tracker_add_notes', 'tracker_close_project',
      'tracker_get_status', 'tracker_list_active', 'tracker_edit_task',
      'tracker_pause_schedule', 'tracker_resume_schedule', 'tracker_resolve_missed_runs',
    ],
    silent: ['tracker_create_project', 'tracker_create_task', 'reminder_create', 'commitment_open', 'commitment_resolve', 'tracker_validate'],
  },
  {
    behaviour: 'B5 multi-step floor DISARM (FN-9 / FA-T2 — the worker is tending its own work)',
    where: 'agent/v2/loop.ts via DISARMING_WORK_OPS',
    test: inSet(DISARMING_WORK_OPS),
    fires: ['tracker_create_project', 'tracker_create_task', 'tracker_add_notes', 'tracker_edit_task', 'tracker_edit_project', 'tracker_complete_step'],
    // reads never disarm (FN-9); closes/handoffs never disarm (FA-T2); governance never disarms
    silent: [
      'tracker_get_status', 'tracker_list_active', 'tracker_close_project', 'tracker_reassign_task',
      'tracker_resolve_missed_runs', 'tracker_validate', 'tracker_retask', 'tracker_override',
      'tracker_request_override', 'tracker_request_user_verdict', 'tracker_apply_user_verdict',
      'tracker_apply_user_validation', 'tracker_pause_schedule', 'tracker_resume_schedule',
    ],
  },
  {
    behaviour: 'B6 user-requested-close reply nudge (the close carries a task_id)',
    where: 'agent/v2/loop.ts via CLOSE_OPS_WITH_TASK_ID',
    test: inSet(CLOSE_OPS_WITH_TASK_ID),
    fires: ['tracker_update_status', 'tracker_complete_step'],
    silent: ['tracker_close_project', 'tracker_add_notes'],
  },
  {
    behaviour: 'B7 hoarding brake — structuring tools satisfy the gate',
    where: 'agent/v2/classifiers/hoarding.ts via STRUCTURING_OPS',
    test: inSet(STRUCTURING_OPS),
    fires: ['tracker_create_project', 'tracker_create_task', 'tracker_update_status', 'tracker_complete_step', 'tracker_add_notes', 'tracker_edit_task'],
    // a bare LIST must never satisfy the structuring gate — that is the cheapest
    // escape the v2.5.46 note removed scratchpad_set for
    silent: ['tracker_list_active', 'tracker_get_status', 'reminder_create'],
  },
  {
    behaviour: 'B8 hoarding brake — tracker-family reads are exempt from the heavy-load count (OPEN-2)',
    where: 'agent/v2/classifiers/hoarding.ts via isTrackerFamilyCall',
    test: (n, a) => isTrackerFamilyCall(n, a),
    fires: [
      'tracker_get_status', 'tracker_list_active', 'tracker_create_project', 'tracker_create_task',
      'tracker_update_status', 'tracker_add_notes', 'tracker_edit_task', 'tracker_close_project',
      'tracker_validate', 'tracker_pause_schedule',
    ],
    // the three names that never carried the prefix and so never had the exemption
    silent: ['reminder_create', 'commitment_open', 'commitment_resolve'],
  },
  {
    behaviour: 'B9 concurrency: only the two reads may run in parallel',
    where: 'agent/v2/classifiers/concurrency.ts via WORK_OP_CONCURRENCY',
    test: (n, a) => WORK_OP_CONCURRENCY[toolOpKey(n, a)] === 'safe',
    fires: ['tracker_get_status', 'tracker_list_active'],
    silent: ['tracker_update_status', 'tracker_create_task', 'tracker_add_notes', 'tracker_edit_task', 'tracker_complete_step', 'tracker_close_project', 'tracker_reassign_task'],
  },
  {
    behaviour: 'B10 PM overseer allow-list (the PM oversees; it does not do the work)',
    where: 'tracker/pm-agent.ts via PM_ALLOWED_WORK_OPS',
    test: inSet(new Set<string>(PM_ALLOWED_WORK_OPS)),
    fires: [
      'tracker_list_active', 'tracker_get_status', 'tracker_add_notes',
      'tracker_pause_schedule', 'tracker_resume_schedule',
      'tracker_validate', 'tracker_retask', 'tracker_reassign_task',
      'tracker_override', 'tracker_request_override', 'tracker_apply_user_verdict',
      'tracker_edit_project', 'tracker_edit_task', 'tracker_close_project',
    ],
    // THE ONE THE COLLAPSE ENDANGERS MOST: after the collapse the PM's allowed
    // close and its forbidden status flip are the SAME VERB. A name-keyed gate
    // could not refuse these and would have handed the PM a worker's keyboard.
    silent: ['tracker_update_status', 'tracker_complete_step', 'tracker_create_task', 'tracker_create_project', 'reminder_create', 'tracker_request_user_verdict', 'tracker_apply_user_validation', 'tracker_resolve_missed_runs'],
  },
  {
    behaviour: 'B11 PM-ONLY operations (a worker calling one is refused at the executor)',
    where: 'agent/tools.ts via PM_ONLY_WORK_OPS',
    test: inSet(PM_ONLY_WORK_OPS),
    // ARGUED MOVE (UX-REPAIR round 2 T12): `tracker_apply_user_validation` left `fires` for
    // `silent` and is pinned by B11p below instead. The behaviour did not go dark — it changed
    // WALL. That op transcribes a verdict THE OWNER gave, and it was refused to the primary by
    // this set AND to the PM by its absence from `PM_ALLOWED_WORK_OPS`: a double refusal that
    // made the escalation's own terminal step unexecutable by everyone it addressed.
    fires: ['tracker_validate', 'tracker_retask', 'tracker_override', 'tracker_apply_user_verdict'],
    silent: [
      'tracker_update_status', 'tracker_request_override', 'tracker_create_task', 'tracker_list_active',
      'tracker_apply_user_validation',
    ],
  },
  {
    behaviour: 'B11p PRIMARY-ONLY operations (the owner speaks to the primary, so the primary records his verdict)',
    where: 'agent/tools/gates.ts row 8p via PRIMARY_ONLY_WORK_OPS',
    test: inSet(PRIMARY_ONLY_WORK_OPS),
    fires: ['tracker_apply_user_validation'],
    silent: ['tracker_validate', 'tracker_retask', 'tracker_override', 'tracker_apply_user_verdict', 'tracker_update_status'],
  },
  {
    behaviour: 'B12 the READ carve-out (never disarms, always parallelisable)',
    where: 'tools/work-verbs.ts via isWorkReadOp',
    test: (n, a) => isWorkReadOp(workOperation(n, a)),
    fires: ['tracker_get_status', 'tracker_list_active'],
    silent: ['tracker_update_status', 'tracker_add_notes', 'tracker_create_project'],
  },
  {
    behaviour: 'B13 the obligation (promise) operations stay distinguishable from board work',
    where: 'tools/work-verbs.ts via isCommitmentOp',
    test: (n, a) => isCommitmentOp(workOperation(n, a)),
    fires: ['commitment_open', 'commitment_resolve'],
    silent: ['tracker_create_task', 'tracker_update_status', 'reminder_create'],
  },
  {
    behaviour: 'B14 display class — a work call is hidden bookkeeping, EXCEPT setting a reminder',
    where: 'shared/visibility.ts via classifyTool',
    test: (n, a) => {
      const r = resolveToolAlias(n, a);
      return classifyTool(r.name, r.args) === 'effectful-action';
    },
    fires: ['reminder_create'],
    silent: [
      'tracker_create_project', 'tracker_create_task', 'tracker_update_status', 'tracker_add_notes',
      'tracker_complete_step', 'tracker_close_project', 'tracker_list_active', 'tracker_get_status',
      'commitment_open', 'commitment_resolve', 'tracker_validate',
    ],
  },
];

describe('T8V — LIVENESS: every engine behaviour that matched a tool name still fires', () => {
  const byName = new Map(RETIRED.map((r) => [r.name, r]));

  for (const c of CANARIES) {
    it(`${c.behaviour} — still fires on the ${c.fires.length} call(s) it used to`, () => {
      const dark: string[] = [];
      for (const n of c.fires) {
        const row = byName.get(n);
        expect(row, `${n} is not in the retired table`).toBeDefined();
        const r = resolveToolAlias(n, row!.args);
        if (!c.test(r.name, r.args as Record<string, unknown>)) dark.push(n);
      }
      expect(dark, `WENT DARK in ${c.where}: ${c.behaviour} no longer fires on ${dark.join(', ')}`).toEqual([]);
    });

    it(`${c.behaviour} — still silent on the ${c.silent.length} call(s) it never fired on`, () => {
      const overreach: string[] = [];
      for (const n of c.silent) {
        const row = byName.get(n);
        expect(row, `${n} is not in the retired table`).toBeDefined();
        const r = resolveToolAlias(n, row!.args);
        if (c.test(r.name, r.args as Record<string, unknown>)) overreach.push(n);
      }
      expect(overreach, `OVERREACHED in ${c.where}: ${c.behaviour} now also fires on ${overreach.join(', ')} — the classic "match the bare verb" mistake`).toEqual([]);
    });
  }

  it('no behavioural set names a BARE VERB (which would fire on every one of its operations)', () => {
    const sets: Array<[string, ReadonlySet<string> | readonly string[]]> = [
      ['CLOSING_WORK_OPS', CLOSING_WORK_OPS],
      ['PROGRESS_WORK_OPS', PROGRESS_WORK_OPS],
      ['SATISFYING_WORK_OPS', SATISFYING_WORK_OPS],
      ['CLOSE_OUT_WORK_OPS', CLOSE_OUT_WORK_OPS],
      ['DISARMING_WORK_OPS', DISARMING_WORK_OPS],
      ['CLOSE_OPS_WITH_TASK_ID', CLOSE_OPS_WITH_TASK_ID],
      ['STRUCTURING_OPS', STRUCTURING_OPS],
      ['PM_ALLOWED_WORK_OPS', PM_ALLOWED_WORK_OPS],
      ['PM_ONLY_WORK_OPS', PM_ONLY_WORK_OPS],
      ['WORK_OP_CONCURRENCY', Object.keys(WORK_OP_CONCURRENCY)],
    ];
    const bad: string[] = [];
    for (const [label, s] of sets) {
      for (const member of [...s]) {
        // `work_note` has no discriminator (it is one operation), and non-work
        // names like load_tool_docs are legitimate members.
        if (member === 'work_note' || !member.startsWith('work_')) continue;
        if (!isWorkOp(member)) bad.push(`${label}: ${member}`);
      }
    }
    expect(bad, 'a behavioural set names a verb instead of an operation').toEqual([]);
  });
});

describe('T8V — the advertised surface and the enforced surface cannot drift', () => {
  it('the PM name list is DERIVED from the PM op list, so a policy write can never advertise less', () => {
    const verbsFromOps = new Set(PM_ALLOWED_WORK_OPS.map((op) => op.split(':')[0]));
    for (const v of verbsFromOps) {
      expect(PM_ALLOWED_TOOLS, `${v} is an allowed PM operation but is not advertised`).toContain(v);
    }
  });

  it('every PM-only operation is one the PM itself is allowed (or is deliberately owner-only)', () => {
    const allowed = new Set<string>(PM_ALLOWED_WORK_OPS);
    const ownerOnly = ['work_validate:apply_user_validation']; // the primary applies the owner's chat reply
    for (const op of PM_ONLY_WORK_OPS) {
      if (ownerOnly.includes(op)) continue;
      expect(allowed.has(op), `${op} is PM-only but not in the PM's own allow-list — nobody can call it`).toBe(true);
    }
  });
});
