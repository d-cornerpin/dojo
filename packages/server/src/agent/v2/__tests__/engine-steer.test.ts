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
//   1. persistEngineSteer does BOTH writes (the role='system' row AND the queue entry).
//   2. Source-scan of loop.ts: no raw role='system' INSERT whose surrounding block
//      carries imperative-to-agent text may exist without a paired delivery
//      (the steer queue / persistEngineSteer) or an explicit `engine-steer-exempt`
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
import { nextSteer, steerFired, STEER_PRECEDENCE } from '../steer-queue.js';
// PHASE-6 GUARD-AUDIT 2026-08-04: the engine's corpus is DERIVED ONCE, here, instead of
// re-hand-rolled per guard (this file used to carry its own copy of the walk — see the
// deleted `STEPS_DIR` / `stepSources()` below the T3 block). `engineText()` is the driver
// plus every step package joined; `engineSources()` keeps the per-file split so a hit can
// name its real home; `engineFileContaining()` is the order trap's guard rail.
import { engineFileContaining, engineFileWithBoth, engineSources, engineText } from './engine-sources.js';

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
  it('inserts a role=system row AND enqueues the steer on the returned state', () => {
    // PHASE-1 T4: the row is written through the single writer module, not a raw
    // statement on an injected connection, so the seam moved from `deps.db` to
    // `deps.insertRow`. The REQUIREMENT is unchanged and is what is asserted below:
    // a persisted role='system' row carrying the steer's content, AND the queue entry.
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
    const after = persistEngineSteer(
      before, { agentId: 'a1', content, turnNumber: 7, floor: 'tracker-stop-directive', atLoop: 1 }, deps,
    );

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

    // Model-visible delivery: the steer is queued on the returned state, and it is the
    // next one out. PHASE-4 T3: queued is not delivered — the loop's receipt read decides
    // that — so what is asserted here is the CHANNEL, which is what this guard owns.
    expect(nextSteer(after.steerQueue)?.content).toBe(content);
    expect(after.steerQueue.pending.length).toBe(1);
    expect(before.steerQueue.pending).toEqual([]); // input not mutated
  });

  it("sets the floor's one-shot latch in the same advance as the steer", () => {
    // PHASE-4 T3: the `extra` bag this clause used to check is GONE. Every one of its nine
    // production uses was a per-site latch boolean, and the latch is the queue ENTRY now —
    // so the requirement ("the steer and its guard land atomically") is asserted against
    // the mechanism that carries it, and a site can no longer forget to pass its flag.
    const deps = {
      insertRow: () => null,
      broadcast: () => undefined,
    } as unknown as Parameters<typeof persistEngineSteer>[2];
    const after = persistEngineSteer(
      freshState(),
      { agentId: 'a1', content: 'x', turnNumber: 1, floor: 'tracker-stop-directive', atLoop: 1 },
      deps,
    );
    expect(steerFired(after.steerQueue, 'tracker-stop-directive')).toBe(true);
    expect(nextSteer(after.steerQueue)?.content).toBe('x');
  });

  it('still enqueues the steer even if the dashboard row write throws (delivery is load-bearing)', () => {
    const deps = {
      insertRow: () => {
        throw new Error('db down');
      },
      broadcast: () => undefined,
    } as unknown as Parameters<typeof persistEngineSteer>[2];
    const after = persistEngineSteer(
      freshState(), { agentId: 'a1', content: 'y', turnNumber: 1, floor: 'hoarding-advisory', atLoop: 1 }, deps,
    );
    expect(nextSteer(after.steerQueue)?.content).toBe('y');
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
const PAIRED = /enqueueSteer|persistEngineSteer|engine-steer-exempt/;

function isCommentLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

describe('RC-19: no bare-system imperative steer in the engine (build-enforced invariant)', () => {
  it('every role=system INSERT with imperative content pairs a model-visible delivery or is documented exempt', () => {
    // PHASE-6 GUARD-AUDIT 2026-08-04: THE CORPUS IS THE ENGINE — the driver plus every
    // step package under `agent/v2/steps/` — not `loop.ts` alone. This clause is NEGATIVE
    // (`expect(violations).toEqual([])`), which is the shape that goes QUIET rather than
    // red: a tranche that carries a role='system' writer out of the driver would leave this
    // scan reading a file the writer is no longer in, and it would pass having checked
    // nothing. The scan runs PER FILE so every window, and every line number it reports,
    // stays truthful — a window sliced out of a concatenation would straddle file
    // boundaries and pair a steer with a delivery from a different module.
    const violations: string[] = [];

    for (const { rel, text } of engineSources()) {
      const lines = text.split('\n');

      systemInsertLines(text).forEach((i) => {
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

        violations.push(`${rel}:${i + 1} | bare role='system' imperative steer (no enqueueSteer / persistEngineSteer / engine-steer-exempt in block)`);
      });
    }

    // If this fails: route the steer through persistEngineSteer (so it reaches the
    // model via the steer queue, not just the dashboard), or, if the row is genuinely
    // NOT a model-visible directive (an enforced gate, a terminal status note, an
    // informational marker), add an `engine-steer-exempt: <reason>` comment in the
    // block documenting why. See engine-steer.ts and RC-19.
    expect(violations).toEqual([]);
  });

  it('the engine actually routes engine steers through persistEngineSteer (guards against the scan silently matching nothing)', () => {
    // PHASE-6 GUARD-AUDIT 2026-08-04: corpus widened from `loop.ts` to the ENGINE (driver
    // + every step package). This is the NON-VACUITY guard for the scan above, so it has
    // to count over exactly the corpus that scan reads — otherwise a tranche that carries
    // steer sites into `agent/v2/steps/` fails this floor while the scan it protects has
    // moved on. The floor itself is UNCHANGED at 6.
    const src = engineText();
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
const SUBSYSTEM_PAIRED = /postAgentNotice|persistEngineSteer|enqueueSteer|engine-steer-exempt/;

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
    found.push(`${rel}:${i + 1} | bare role='system' imperative steer (no postAgentNotice / persistEngineSteer / enqueueSteer / engine-steer-exempt in block)`);
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

describe('T1: the steer drain is not gated on the assembled tail shape', () => {
  it('the drain injects msg.pending-nudge with no test on the last message role', () => {
    // PHASE-6 GUARD-AUDIT 2026-08-04: this is a LOCALITY clause — it finds a line and then
    // reads the five lines ABOVE it — so it must never run over a concatenated corpus,
    // where "the five lines above" can be the tail of a different file. The corpus is
    // therefore the ONE engine file that holds the drain, found by name across the driver
    // and every step package: the clause follows the site through any tranche, and if the
    // site is ever duplicated `engineFileContaining` throws instead of quietly picking one.
    const drainHome = engineFileContaining("injectRegistryMessage('msg.pending-nudge'");
    expect(drainHome, "the drain site is in no engine file — it was renamed or removed").not.toBeNull();
    const lines = drainHome!.text.split('\n');
    const drainIdx = lines.findIndex((l) => l.includes("injectRegistryMessage('msg.pending-nudge'"));
    // Guards against the scan silently matching nothing if the site is renamed.
    expect(drainIdx).toBeGreaterThan(0);

    // The enclosing gate sits just above the injection. PHASE-4 T3: the gate is now
    // "the queue offered an entry", which is the same requirement — a steer is drained
    // when one exists — expressed against the mechanism that replaced the single slot.
    const gate = lines
      .slice(Math.max(0, drainIdx - 5), drainIdx + 1)
      .filter((l) => !isCommentLine(l))
      .join('\n');
    expect(gate).toMatch(/if \(steerToDeliver\)/);
    // If this fails: a tail-shape condition has been put back on the drain. It
    // cannot ever be true — assembler.ts:301 guarantees the assembled tail is a
    // user-role message — so it silently kills every post-tool-call steer.
    expect(gate).not.toMatch(/messages\[messages\.length - 1\]\.role/);
  });

  it('a steer leaves the queue ONLY on a receipt-confirmed assembly inclusion', () => {
    // PHASE-6 GUARD-AUDIT 2026-08-04: a DISTANCE clause, not a presence one — the first
    // assertion below demands the mark and the lane-id read sit within 200 characters of
    // each other. Over a joined corpus that measurement is meaningless (two needles either
    // side of a file boundary would be "adjacent"), so the clause pins itself to the ONE
    // engine file holding BOTH, across the driver and every step package. If a tranche ever
    // splits the mark from the receipt read, `engineFileWithBoth` throws with both homes
    // named — loudly, which is the point — rather than the regex quietly finding one of the
    // two alternations somewhere in the join. The remaining two assertions run against that
    // same file for the reason the comment below already gives: SAME array, same statement.
    const receiptHome = engineFileWithBoth(
      'markSteerDelivered', "laneIdsForThisCall.includes('msg.pending-nudge')",
    );
    const src = receiptHome.text;
    // PHASE-4 T3, the requirement T1 landed and this task strengthened. T1's version
    // cleared the slot on `injectRegistryMessage` returning true — which proves the steer
    // was PUSHED, not that it survived to the provider. The array is mutated afterwards
    // (capability enforcement, five more injections, the merge/sanitise passes), so the
    // mark now reads the RECEIPT LAYER's own lane ids off the array the provider is
    // handed. A steer that was pushed and then dropped stays queued.
    expect(src).toMatch(
      /markSteerDelivered[\s\S]{0,200}?laneIdsForThisCall\.includes\('msg\.pending-nudge'\)|laneIdsForThisCall\.includes\('msg\.pending-nudge'\)[\s\S]{0,200}?markSteerDelivered/,
    );
    // …and the lane ids are read off the SAME array, in the same statement that feeds the
    // receipt — not off a copy that could disagree with what was sent.
    expect(src).toMatch(/const laneIdsForThisCall = collectMessageLaneIds\(messages\);/);
    expect(src).toMatch(/messageEntryIds: laneIdsForThisCall,/);
  });
});

// ── PHASE-4 T3: THE QUEUE IS THE SOLE STEER WRITER ────────────────────────────────────
//
// The plan's T6 exit gate says "the conformance walk proves the steer queue is the SOLE
// steer writer". It lands HERE, in the task that builds the queue, because a walk written
// three tasks later would be scanning a file nobody can still remember the shape of.
//
// Four clauses, and each one has something to find (a walk that matches nothing passes).

describe('the steer queue is the SOLE steer writer (T6 exit clause, landed early)', () => {
  const loopSrc = () => fs.readFileSync(LOOP_TS, 'utf8');
  const codeLines = (src: string) => src.split('\n').filter((l) => !isCommentLine(l));

  // PHASE-6 T8: THE GUARD'S TARGET MOVED, SO THE GUARD MOVES WITH IT (the same
  // repair PHASE-1 T4 recorded above for the system-row scan). Phase 6 cuts the
  // driver into step packages under `agent/v2/steps/`, and the first cut took
  // three steer floors (`repetition`, `no-results`, `spinning`) out of loop.ts.
  // A scan that reads only loop.ts would have reported those floors as
  // "declared but never used" — which is what it did, before this widened — and
  // worse, it would have stopped seeing their `steerQueue:` writes entirely.
  // The requirement was never "the sites are in loop.ts"; it is "every declared
  // floor has a real site, and every site goes through the module." So the
  // corpus is the ENGINE'S source: the driver, the steer helper, and every step
  // package. The eight tranches behind the first are covered by construction.
  //
  // PHASE-6 GUARD-AUDIT 2026-08-04: that widening was CORRECT and is unchanged in reach —
  // what changed is that the walk implementing it is no longer hand-rolled here. The audit
  // found SIX guards each carrying their own copy of "the driver plus the step packages",
  // and six copies is six places the corpus can drift apart. It now comes from the one
  // derivation, `engine-sources.ts`. Two differences, both in the strict direction: that
  // module recurses into step SUB-modules (RULING P6-R1 made a step a directory) and it
  // THROWS if the driver has moved, where this copy would have returned a driverless corpus
  // and passed. `agent/v2/engine-steer.ts` is appended separately and deliberately: it is
  // the steer helper — this describe's actual subject — and it is not part of the shared
  // engine corpus, which is the driver plus the step packages and nothing else.
  const engineSrc = () =>
    engineText() + '\n' +
    fs.readFileSync(path.join(SERVER_SRC, 'agent/v2/engine-steer.ts'), 'utf8');

  // PHASE-6 GUARD-AUDIT 2026-08-04: "exactly one" is a UNIQUENESS claim, and uniqueness read
  // over one file cannot see a SECOND door opened anywhere else. Counted over the driver
  // alone this went `1` on a tree where a step package had grown its own drain — the count
  // is right about the file and wrong about the engine, which is the quiet direction wearing
  // a passing count. Over the engine it stays exactly one door, wherever the door lives.
  it('ONE DOOR: exactly one drain site in the engine', () => {
    const hits = codeLines(engineText()).filter((l) => l.includes("injectRegistryMessage('msg.pending-nudge'"));
    expect(hits.length).toBe(1);
  });

  it('EVERY steerQueue write goes through the module — no raw literal, no spread', () => {
    // A site that builds a queue by hand would bypass the latch AND the precedence table,
    // which is exactly how 26 sites came to own one string between them.
    const SANCTIONED = /(enqueueSteer|markSteerDelivered|markSteerAttempted|clearSteerQueue|emptySteerQueue)\(/;
    const src = engineSrc();
    // A `steerQueue:` line either NAMES a module function on the same line, or opens a
    // multi-line call whose function is the line above it (`steerQueue: enqueueSteer({`
    // wrapped by the formatter). Both shapes are accepted; a raw object or spread is not.
    const lines = src.split('\n');
    const writes: string[] = [];
    lines.forEach((l, i) => {
      if (isCommentLine(l) || !/steerQueue:\s*/.test(l)) return;
      const window = [l, lines[i + 1] ?? '', lines[i + 2] ?? ''].join('\n');
      if (!SANCTIONED.test(window)) writes.push(`${i + 1}: ${l.trim()}`);
    });
    const total = lines.filter((l) => !isCommentLine(l) && /steerQueue:\s*/.test(l)).length;
    expect(total).toBeGreaterThanOrEqual(20); // the scan finds the real population
    expect(writes).toEqual([]);
  });

  it('the single slot is GONE from the server tree as an IDENTIFIER', () => {
    // #15: this is a POSITIVE enumeration of the replacement, not an argument from absence
    // — the queue above is live and tested; this clause only stops the old channel being
    // resurrected beside it. It is T6's grep-zero, landed early and kept honest by the
    // clause above it.
    //
    // SCOPE, stated: the field, not the WORD. `state.ts` and `steer-queue.ts` carry the
    // demolition's own `requirement preserved:` prose, which names what died — a tombstone
    // is the one place the old name must survive (roadmap #9). What may never come back is
    // a live read or write, so the scan is for a property access or a declaration, in code.
    const IDENT = /\.pendingNudge\b|\bpendingNudge\s*[:=?]/;
    // PRODUCT source: a test file may quote the dead name (this one does, right above).
    const roots = [path.resolve(SERVER_SRC), path.resolve(SERVER_SRC, '../../shared/src')];
    const offenders: string[] = [];
    let scanned = 0;
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== '__tests__' && e.name !== 'node_modules') walk(abs); continue; }
        if (!/\.tsx?$/.test(e.name) || /\.(test|spec)\.tsx?$/.test(e.name)) continue;
        scanned++;
        fs.readFileSync(abs, 'utf8').split('\n').forEach((l, i) => {
          if (!isCommentLine(l) && IDENT.test(l)) offenders.push(`${path.relative(SERVER_SRC, abs)}:${i + 1}`);
        });
      }
    };
    for (const r of roots) if (fs.existsSync(r)) walk(r);
    expect(scanned).toBeGreaterThan(200); // the walk actually read the tree
    expect(offenders).toEqual([]);
  });

  it('every DECLARED floor has a real site, and every site names a declared floor', () => {
    // The vacuity guard that matters most: a precedence table full of ids nobody enqueues
    // is a table that documents nothing. The compiler already refuses an UNDECLARED id
    // (the union is the table's own keys), so what needs proving is the other direction.
    const src = engineSrc();
    const used = new Set([...src.matchAll(/floor: '([a-z0-9-]+)'/g)].map((m) => m[1]));
    const declared = STEER_PRECEDENCE.map((f) => f.id);
    expect(declared.filter((id) => !used.has(id))).toEqual([]);
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
//     anywhere in the engine") is the general form and it stays. It would have caught the
//     original defect without knowing the hint existed, and it still guards every sibling
//     first-iteration guard in the engine (PHASE-6 GUARD-AUDIT 2026-08-04 widened the
//     corpus from the driver to the driver plus its step packages; see the clause).
describe('T1: no first-iteration guard uses the unreachable loopCount === 0', () => {

  it('no state.loopCount === 0 test survives anywhere in the engine (statically unreachable inside the turn loop)', () => {
    // loopCount is incremented at the FIRST statement of the only `while` body in
    // runV2Turn, so inside that body it is >= 1 on every iteration including the
    // first; `=== 0` can never be true and the codebase's own first-iteration idiom
    // is `=== 1` (five sibling sites). If a legitimate PRE-loop use of `=== 0` is
    // ever added outside the while body, scope this scan to the loop body rather
    // than deleting it.
    //
    // PHASE-6 GUARD-AUDIT 2026-08-04: THE CORPUS IS THE ENGINE — the driver plus every
    // step package — because this is the file's purest example of the quiet shape:
    // `expect(hits).toEqual([])` over ONE file passes just as happily when the file no
    // longer contains any first-iteration guard at all. The lesson this clause carries is
    // general ("no unreachable first-iteration guard"), and the sibling guards it protects
    // are exactly what a tranche carries into `agent/v2/steps/`, so pinning it to the
    // driver would retire it one cut at a time without a single red run. Each hit now
    // names the file it came from — `loop.ts:NNN` would be a fabricated citation over a
    // corpus of several files, and a violation report nobody can follow is half a guard.
    const hits = engineSources().flatMap(({ rel, text }) =>
      text.split('\n')
        .map((l, i) => ({ l, i }))
        .filter(({ l }) => /state\.loopCount === 0/.test(l) && !isCommentLine(l))
        .map(({ l, i }) => `${rel}:${i + 1} | ${l.trim()}`));
    expect(hits).toEqual([]);
  });
});
