// RC-19 conformance guard.
//
// The engine may only steer the model through a channel the model can actually
// see. The memory assembler strips role='system' rows from model context, so a bare
// role='system' INSERT that tells the agent to DO or STOP something is
// "dashboard-only theater": it fires in logs and the dashboard while the model never
// receives it. The rule (from the thrash-gate comment in loop.ts) is that any such
// directive must also set `pendingNudge`. The recurrence history (F-18, the F-7
// recurrences) is a PROCESS failure: the lesson lived as a comment plus a list of
// corrected sites, so nothing stopped the next engineer from writing a new bare
// steer. This test converts the lesson into a build-enforced invariant.
//
// Two assertions:
//   1. persistEngineSteer does BOTH writes (the role='system' row AND pendingNudge).
//   2. Source-scan of loop.ts: no raw role='system' INSERT whose surrounding block
//      carries imperative-to-agent text may exist without a paired delivery
//      (pendingNudge / persistEngineSteer) or an explicit `engine-steer-exempt`
//      sentinel documenting why it is not a model-visible steer (an enforced gate,
//      a terminal note, an informational marker). A NEW bare imperative steer that
//      copies the old raw-INSERT pattern fails CI here.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WsEvent } from '@dojo/shared';
import { persistEngineSteer } from '../engine-steer.js';
import { initState, type AgentTurnState } from '../state.js';

function freshState(): AgentTurnState {
  return initState({
    agentId: 'test-agent',
    contextWindow: 200000,
    isAutoRouted: false,
    configuredModelId: 'claude-sonnet-4-6',
    turnNumber: 3,
    triggeredByIMessage: false,
    triggeredByA2AReplyIntent: null,
    imFlagSetAtRunStart: false,
    lastUserMessageContent: null,
  });
}

describe('persistEngineSteer: does both writes', () => {
  it('inserts a role=system row AND sets pendingNudge on the returned state', () => {
    // PHASE-1 T4: the row is written through the single writer module, not a raw
    // statement on an injected connection, so the seam moved from `deps.db` to
    // `deps.insertRow`. The REQUIREMENT is unchanged and is what is asserted below:
    // a persisted role='system' row carrying the steer's content, AND pendingNudge.
    // Asserting on SQL text would now only prove which string literal we typed.
    let written: { role?: string; content?: string; agentId?: string; turnNumber?: number | null } | null = null;
    const events: WsEvent[] = [];
    const deps = {
      insertRow(m: { role?: string; content?: string; agentId?: string; turnNumber?: number | null }) {
        written = m;
        return null;
      },
      broadcast(event: WsEvent) {
        events.push(event);
      },
    } as unknown as Parameters<typeof persistEngineSteer>[2];

    const before = freshState();
    const content = '[System: STOP and call tracker_create_project.]';
    const after = persistEngineSteer(before, { agentId: 'a1', content, turnNumber: 7 }, deps);

    // Dashboard row: a role='system' message carrying the content, for this turn.
    expect(written).not.toBeNull();
    expect(written!.role).toBe('system');
    expect(written!.content).toBe(content);
    expect(written!.agentId).toBe('a1');
    expect(written!.turnNumber).toBe(7);

    // Dashboard broadcast: chat:message with the content.
    const chatMsg = events.find((e) => e.type === 'chat:message');
    expect(chatMsg).toBeTruthy();
    if (chatMsg && chatMsg.type === 'chat:message') {
      expect(chatMsg.message.role).toBe('system');
      expect(chatMsg.message.content).toBe(content);
    }

    // Model-visible delivery: pendingNudge set on the returned state.
    expect(after.pendingNudge).toBe(content);
    expect(before.pendingNudge).toBeNull(); // input not mutated
  });

  it('merges extra one-shot flags into the same advance', () => {
    const deps = {
      insertRow: () => null,
      broadcast: () => undefined,
    } as unknown as Parameters<typeof persistEngineSteer>[2];
    const after = persistEngineSteer(
      freshState(),
      { agentId: 'a1', content: 'x', turnNumber: 1, extra: { nudgedForTrackerThisTurn: true } },
      deps,
    );
    expect(after.nudgedForTrackerThisTurn).toBe(true);
    expect(after.pendingNudge).toBe('x');
  });

  it('still sets pendingNudge even if the dashboard row write throws (delivery is load-bearing)', () => {
    const deps = {
      insertRow: () => {
        throw new Error('db down');
      },
      broadcast: () => undefined,
    } as unknown as Parameters<typeof persistEngineSteer>[2];
    const after = persistEngineSteer(freshState(), { agentId: 'a1', content: 'y', turnNumber: 1 }, deps);
    expect(after.pendingNudge).toBe('y');
  });
});

// ── Source-scan invariant ──────────────────────────────────────────────────────

const LOOP_TS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../loop.ts');

// A role='system' message write, in EITHER of the two shapes this codebase has.
//
// PHASE-1 T4 (2026-07-27): the guard's target moved and the guard had to move with it,
// or it would have kept passing while matching nothing — the exact silent-vacuity
// failure the "scan actually finds something" tests below exist to catch. Every raw
// `INSERT ... VALUES (?, ?, 'system'` is being re-pointed onto the single writer
// module, cluster by cluster, so BOTH forms are matched: the legacy statement (still
// live in the clusters not yet converted, and in any file a future phase resurrects)
// and the writer-module call. The RC-19 REQUIREMENT is untouched — a system row whose
// text tells the model to act must pair a model-visible delivery.
const SYSTEM_INSERT_SQL = /VALUES\s*\(\s*\?,\s*\?,\s*'system'/;
const SYSTEM_INSERT_CALL = /insertMessage(?:IfAbsent)?\s*\(\s*\{[\s\S]{0,400}?role:\s*'system'/g;

/** 0-based line indices of every role='system' message write in `src`, either shape. */
function systemInsertLines(src: string): number[] {
  const lines = src.split('\n');
  const hits = new Set<number>();
  lines.forEach((l, i) => { if (SYSTEM_INSERT_SQL.test(l)) hits.add(i); });
  SYSTEM_INSERT_CALL.lastIndex = 0;
  for (const m of src.matchAll(SYSTEM_INSERT_CALL)) {
    hits.add(src.slice(0, m.index).split('\n').length - 1);
  }
  return [...hits].sort((a, b) => a - b);
}

// Imperative-to-agent shapes. Case-sensitive on purpose: prose "must"/"do not"
// (lowercase) is fine; the SHOUTED forms are the directive tells. Covers the three
// named RC-19 violators (STOP + call tracker_ for the tracker steer, KEEP GOING for
// the add-notes-stop nudge, "Never tell the user" for the claimed-delivery guard)
// plus the general MUST / Do NOT / call tracker_ shapes.
const IMPERATIVE = /\bSTOP\b|\bMUST\b|\bDo NOT\b|call tracker_|KEEP GOING|Never tell the user/;

// A site is compliant if its block pairs the row with a real delivery or is an
// explicitly documented non-steer.
const PAIRED = /pendingNudge|persistEngineSteer|engine-steer-exempt/;

function isCommentLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

describe('RC-19: no bare-system imperative steer in loop.ts (build-enforced invariant)', () => {
  it('every role=system INSERT with imperative content pairs a model-visible delivery or is documented exempt', () => {
    const src = fs.readFileSync(LOOP_TS, 'utf8');
    const lines = src.split('\n');
    const violations: string[] = [];

    systemInsertLines(src).forEach((i) => {
      // Window: content literals sit ABOVE the INSERT (built into a variable),
      // pendingNudge / persistEngineSteer / exempt sentinels sit just below or above.
      const start = Math.max(0, i - 40);
      const end = Math.min(lines.length, i + 20);
      const window = lines.slice(start, end);

      // Imperative detection ignores comment lines so a doc mention of a shape
      // (or a nearby unrelated comment) can't trip it. Content lives in code
      // (template strings), so real steer text is still seen.
      const codeText = window.filter((l) => !isCommentLine(l)).join('\n');
      if (!IMPERATIVE.test(codeText)) return;

      // Pairing / exemption may live in a comment (the sentinel) or code, so scan
      // the raw window.
      if (PAIRED.test(window.join('\n'))) return;

      violations.push(`loop.ts:${i + 1} | bare role='system' imperative steer (no pendingNudge / persistEngineSteer / engine-steer-exempt in block)`);
    });

    // If this fails: route the steer through persistEngineSteer (so it reaches the
    // model via pendingNudge, not just the dashboard), or, if the row is genuinely
    // NOT a model-visible directive (an enforced gate, a terminal status note, an
    // informational marker), add an `engine-steer-exempt: <reason>` comment in the
    // block documenting why. See engine-steer.ts and RC-19.
    expect(violations).toEqual([]);
  });

  it('loop.ts actually routes engine steers through persistEngineSteer (guards against the scan silently matching nothing)', () => {
    const src = fs.readFileSync(LOOP_TS, 'utf8');
    const helperCalls = (src.match(/persistEngineSteer\(/g) ?? []).length;
    // The three named RC-19 violators plus the additional same-turn steers found in
    // the audit sweep are all routed through the helper.
    expect(helperCalls).toBeGreaterThanOrEqual(6);
  });
});

// ── Source-scan invariant: tracker + scheduler subsystems (Phase 0.5) ───────────
//
// The same dead-channel rule the loop.ts scan enforces applies to the tracker and
// scheduler subsystems. Model-directed text from those subsystems must ride the
// VISIBLE awareness NOTICE (postAgentNotice, role='user' origin_kind='engine') or an
// engine steer, never a bare role='system' row (stripped by the model-context
// builder). A NEW bare role='system' INSERT carrying imperative model-directed text
// in tracker/*.ts or scheduler/*.ts fails CI here, the same way loop.ts is guarded.

const SERVER_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

// For these subsystems the sanctioned model-visible channel is the awareness NOTICE
// (postAgentNotice), in addition to the loop-level steer helpers / exempt sentinel.
const SUBSYSTEM_PAIRED = /postAgentNotice|persistEngineSteer|pendingNudge|engine-steer-exempt/;

function subsystemFiles(dir: string): string[] {
  const abs = path.join(SERVER_SRC, dir);
  return fs
    .readdirSync(abs)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'))
    .map((f) => path.join(abs, f));
}

function scanBareImperativeSystemInserts(file: string, paired: RegExp): string[] {
  const rel = `${path.basename(path.dirname(file))}/${path.basename(file)}`;
  const src = fs.readFileSync(file, 'utf8');
  const lines = src.split('\n');
  const found: string[] = [];
  systemInsertLines(src).forEach((i) => {
    // Same window + comment-filtering rules as the loop.ts scan: content literals
    // sit above the INSERT; the NOTICE / steer / exempt sentinel sits nearby.
    const start = Math.max(0, i - 40);
    const end = Math.min(lines.length, i + 20);
    const window = lines.slice(start, end);
    const codeText = window.filter((l) => !isCommentLine(l)).join('\n');
    if (!IMPERATIVE.test(codeText)) return;
    if (paired.test(window.join('\n'))) return;
    found.push(`${rel}:${i + 1} | bare role='system' imperative steer (no postAgentNotice / persistEngineSteer / pendingNudge / engine-steer-exempt in block)`);
  });
  return found;
}

describe('RC-19: no bare-system imperative steer in tracker/ + scheduler/ (build-enforced invariant)', () => {
  const files = [...subsystemFiles('tracker'), ...subsystemFiles('scheduler')];

  it('every role=system INSERT with imperative content pairs a visible NOTICE / steer or is documented exempt', () => {
    const violations = files.flatMap((f) => scanBareImperativeSystemInserts(f, SUBSYSTEM_PAIRED));
    // If this fails: route the model-directed text through postAgentNotice (the
    // visible awareness NOTICE) or persistEngineSteer, or, if the row is genuinely
    // NOT a model-visible directive (an owner-only heads-up, an agent's own system
    // prompt, a task-update notification), add an `engine-steer-exempt: <reason>`
    // comment in the block documenting why. See engine-steer.ts and RC-19.
    expect(violations).toEqual([]);
  });

  it('the scan actually finds role=system INSERTs across the subsystems (guards against silently matching nothing)', () => {
    let systemInsertCount = 0;
    for (const f of files) {
      systemInsertCount += systemInsertLines(fs.readFileSync(f, 'utf8')).length;
    }
    // Known non-imperative role='system' writers still present after Phase 0:
    // pm-agent.ts (PM soul prompt, x2), tools.ts (task-update notification),
    // runner.ts (skipped-reminder owner heads-up). If this regex ever stops matching
    // them, the imperative scan above would silently pass. Lower this floor only if a
    // future phase legitimately migrates those sites off role='system'.
    expect(systemInsertCount).toBeGreaterThanOrEqual(3);
  });
});

// ── PHASE-1 T1 (2026-07-27): the DELIVERY half of the same channel ─────────────
//
// persistEngineSteer's contract above is "both writes happen". T1 found the other
// half was broken: the write landed, and the delivery never did. `pendingNudge` is
// drained into the outgoing messages array by loop.ts, and that drain was gated on
// the assembled tail being role='assistant'. memory/assembler.ts:301 APPENDS a
// user-role engine line whenever the tail is an assistant message (so a provider is
// never handed a trailing assistant turn), which makes that gate structurally
// unsatisfiable: the tail is always either that appended user line or a tool-result
// carrier. Every engine steer written after a tool call was therefore logged as sent
// and never received, from 2026-07-10 until this fix (research 22; reproduced live
// on five floor-model drives by dojo-test-kit/checks/check-steer-delivery.mjs).
//
// The behavioral proof lives in agent/v2/__tests__/integration.test.ts ("T1: engine
// steer delivery"), which drives runV2Turn against a tool-result-carrier tail and
// asserts on what callModel actually received. These are the build-enforced source
// invariants that stop the shape gate being reintroduced.

describe('T1: the pendingNudge drain is not gated on the assembled tail shape', () => {
  it('the drain injects msg.pending-nudge with no test on the last message role', () => {
    const lines = fs.readFileSync(LOOP_TS, 'utf8').split('\n');
    const drainIdx = lines.findIndex((l) => l.includes("injectRegistryMessage('msg.pending-nudge'"));
    // Guards against the scan silently matching nothing if the site is renamed.
    expect(drainIdx).toBeGreaterThan(0);

    // The enclosing gate sits just above the injection.
    const gate = lines
      .slice(Math.max(0, drainIdx - 4), drainIdx + 1)
      .filter((l) => !isCommentLine(l))
      .join('\n');
    expect(gate).toMatch(/if \(state\.pendingNudge/);
    // If this fails: a tail-shape condition has been put back on the drain. It
    // cannot ever be true — assembler.ts:301 guarantees the assembled tail is a
    // user-role message — so it silently kills every post-tool-call steer.
    expect(gate).not.toMatch(/messages\[messages\.length - 1\]\.role/);
  });

  it('the drain clears pendingNudge ONLY when the injection actually landed', () => {
    const src = fs.readFileSync(LOOP_TS, 'utf8');
    // The clear must be guarded by the injection's own return value, so a steer
    // that did not reach the outgoing array survives to the next boundary instead
    // of being silently dropped.
    expect(src).toMatch(
      /if \(injectRegistryMessage\('msg\.pending-nudge'[^\n]*\)[\s\S]{0,120}?pendingNudge: null/,
    );
  });
});

// ── STRIP (PHASE-3 T7 Step 2, 2026-08-01) — the reachability clause dies with its subject. ──
// It asserted that `const SETTLED_HINT =` was guarded by `state.loopCount === 1` rather than
// the statically-unreachable `=== 0` that made the block dead for months. There is no
// SETTLED_HINT any more (scar-tissue ledger: "STRIP. Requirement: a turn acts only on its
// root; assembly scopes by id, so there is nothing to warn about"), so a clause scanning for
// its declaration would fail on a CORRECT tree — which is the coin-flip a test must never be.
//
// requirement preserved, and note it is TWO requirements, both still held:
//   * the hint's own requirement — see the STRIP note in loop.ts: structurally by
//     `scopeToHumanConversation`, deterministically by the now-wired
//     `checks/check-reanswer-ghost.mjs`, behaviourally by `settled-work-stays-settled`;
//   * THE UNREACHABLE-GUARD LESSON, which is the more valuable half and is NOT about the
//     hint at all — the clause immediately below ("no state.loopCount === 0 test survives
//     anywhere in loop.ts") is the general form and it stays. It would have caught the
//     original defect without knowing the hint existed, and it still guards every sibling
//     first-iteration guard in the file.
describe('T1: no first-iteration guard uses the unreachable loopCount === 0', () => {

  it('no state.loopCount === 0 test survives anywhere in loop.ts (statically unreachable inside the turn loop)', () => {
    const src = fs.readFileSync(LOOP_TS, 'utf8');
    // loopCount is incremented at the FIRST statement of the only `while` body in
    // runV2Turn, so inside that body it is >= 1 on every iteration including the
    // first; `=== 0` can never be true and the codebase's own first-iteration idiom
    // is `=== 1` (five sibling sites). If a legitimate PRE-loop use of `=== 0` is
    // ever added outside the while body, scope this scan to the loop body rather
    // than deleting it.
    const hits = src.split('\n')
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => /state\.loopCount === 0/.test(l) && !isCommentLine(l))
      .map(({ l, i }) => `loop.ts:${i + 1} | ${l.trim()}`);
    expect(hits).toEqual([]);
  });
});
