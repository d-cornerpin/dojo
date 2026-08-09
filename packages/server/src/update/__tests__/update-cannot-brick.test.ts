// ════════════════════════════════════════════════════════════════════════════
// `update-cannot-brick` — THE D-F TRUTH TABLE, AND THE PROPERTY IT EXISTS FOR.
// SWEEP-F T5 / SWEEP CORE-2 item 6.
//
// ── WHAT THIS SUITE IS ──────────────────────────────────────────────────────
// A self-update swaps the running install and hands the box to launchd. If the
// new build does not come up, the ONLY thing between the owner and a dead Mac
// mini is `decideAutoRollback` — a pure gate in an independent package, reading
// a JSON marker two processes write. Until this file existed the gate had ZERO
// tests: `grep -rn "decideAutoRollback" --include='*.test.ts'` returned nothing
// at `9d982a8`, and the platform-side writers that produce its input had none
// either. The last line of defense was the least defended component, exactly as
// SWEEP-F's goal line says.
//
// ── FIXTURE-DRIVEN, AND WHY THAT IS THE HONEST SHAPE ────────────────────────
// The plan requires "no live restarts". That is not a convenience: the gate's
// whole point is deciding correctly on a box that will not boot, and a suite
// that could only be run by bricking a real machine would never be run. So the
// marker is a real file under a scratch HOME, the writers are the real writers,
// and the only thing simulated is the passage of time (`nowMs` is a parameter).
//
// ── THE ORACLE IS WRITTEN FROM THE OWNER'S DECISION, NOT FROM THE CODE ──────
// `expectedAction()` below is a second, independent statement of the 2026-07-06
// ruling (rollback restores CODE ONLY; a migration means escalate loudly; at
// most one automatic rollback per episode). It is deliberately NOT a copy of
// `decideAutoRollback`'s structure — a table whose oracle is the implementation
// proves only that the implementation is itself.
//
// ── RELEASE-GATED, AND THE BINDING IS CHECKED HERE ──────────────────────────
// SWEEP-F T5 requires this suite to be release-gated alongside Phase 5's
// artifact signature check. Both are vitest files under `packages/server/src`,
// so both ride the `unit-suite` release gate (`deploy/checks/gate-manifest.mjs`),
// which release.sh runs and which is "never skippable". A clause below reads
// that manifest and fails if the gate is downgraded, removed, or retiered — so
// "release-gated" is a checked fact rather than a sentence in a report.
// ════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  decideAutoRollback,
  toRolledBack,
  toFailedPermanently,
  readMarker as watchdogReadMarker,
  writeMarker as watchdogWriteMarker,
  FAIL_BOOT_ATTEMPTS,
  FAIL_WALL_CLOCK_MS,
  MAX_AUTO_ROLLBACKS,
  type UpdateMarker,
  type UpdatePhase,
  type RollbackDecision,
} from '../../../../../watchdog/src/auto-rollback.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../../../..');

// ── fixture marker ──────────────────────────────────────────────────────────

const T0 = Date.parse('2026-08-09T12:00:00.000Z');

function marker(over: Partial<UpdateMarker> = {}): UpdateMarker {
  return {
    phase: 'booting-new',
    targetVersion: '3.1.18',
    previousVersion: '3.1.17',
    backupDir: '/tmp/backup',
    bootAttempts: 0,
    firstBootAt: null,
    lastBootAt: null,
    confirmedHealthyAt: null,
    rollbackCount: 0,
    migrationsRanDuringEpisode: false,
    failedReason: null,
    writeSeq: 0,
    updatedAt: new Date(T0).toISOString(),
    ...over,
  } as UpdateMarker;
}

// ── the oracle: the owner's ruling, restated ────────────────────────────────
//
//  1. The watchdog acts ONLY on a proven self-update episode. A box that is
//     merely down is a generic outage and is somebody else's problem.
//  2. A build that confirmed itself healthy is not failing, whatever else the
//     marker says.
//  3. "Failing" means the crash-exit counter tripped OR the wall clock ran out.
//  4. If the failed build changed the DATABASE, a code-only rollback could
//     brick the box on a schema the old code cannot read → ESCALATE (loud).
//     This outranks everything else.
//  5. Otherwise, one automatic rollback per episode. A spent one → ESCALATE.
//  6. Otherwise, roll back.
function expectedAction(m: UpdateMarker | null, nowMs: number): RollbackDecision {
  if (!m) return { action: 'none' };
  const inEpisode = m.phase === 'booting-new' || m.phase === 'rolled-back';
  if (!inEpisode) return { action: 'none' };
  if (m.confirmedHealthyAt) return { action: 'none' };

  const crashLoop = m.bootAttempts >= FAIL_BOOT_ATTEMPTS;
  const anchor = m.firstBootAt ? Date.parse(m.firstBootAt) : NaN;
  const clockOut = Number.isFinite(anchor) && nowMs - anchor >= FAIL_WALL_CLOCK_MS;
  if (!crashLoop && !clockOut) return { action: 'none' };

  if (m.migrationsRanDuringEpisode) return { action: 'escalate', reason: 'migration' };
  if (m.rollbackCount >= MAX_AUTO_ROLLBACKS) return { action: 'escalate', reason: 'exhausted' };
  return { action: 'rollback' };
}

const ALL_PHASES: UpdatePhase[] = [
  'idle', 'pending-update', 'booting-new', 'healthy', 'rolled-back', 'failed-permanently',
];

describe('update-cannot-brick — the D-F truth table', () => {
  it('every row of the full cartesian matches the owner ruling, and the table is not vacuous', () => {
    const now = T0 + 60 * 60_000; // one hour into the episode
    const attemptsAxis = [0, FAIL_BOOT_ATTEMPTS - 1, FAIL_BOOT_ATTEMPTS, FAIL_BOOT_ATTEMPTS + 2];
    const anchorAxis: Array<string | null> = [
      null,                                                  // never booted
      new Date(now - 60_000).toISOString(),                  // inside the window
      new Date(now - FAIL_WALL_CLOCK_MS + 1).toISOString(),  // one ms short
      new Date(now - FAIL_WALL_CLOCK_MS).toISOString(),      // exactly out
      new Date(now - 3 * FAIL_WALL_CLOCK_MS).toISOString(),  // long out
      'not-a-date',                                          // unreadable anchor
    ];
    const healthyAxis: Array<string | null> = [null, new Date(now - 5_000).toISOString()];
    const migrationAxis = [false, true];
    const rollbackAxis = [0, MAX_AUTO_ROLLBACKS, MAX_AUTO_ROLLBACKS + 1];

    const rows: Array<{ m: UpdateMarker; want: RollbackDecision; got: RollbackDecision }> = [];
    for (const phase of ALL_PHASES) {
      for (const bootAttempts of attemptsAxis) {
        for (const firstBootAt of anchorAxis) {
          for (const confirmedHealthyAt of healthyAxis) {
            for (const migrationsRanDuringEpisode of migrationAxis) {
              for (const rollbackCount of rollbackAxis) {
                const m = marker({
                  phase, bootAttempts, firstBootAt, confirmedHealthyAt,
                  migrationsRanDuringEpisode, rollbackCount,
                });
                rows.push({ m, want: expectedAction(m, now), got: decideAutoRollback(m, now) });
              }
            }
          }
        }
      }
    }

    // Vacuity guard: a table that only ever asserts 'none' proves nothing.
    const kinds = new Set(rows.map(r => (r.want.action === 'escalate' ? `escalate:${r.want.reason}` : r.want.action)));
    expect(rows.length).toBe(
      ALL_PHASES.length * attemptsAxis.length * anchorAxis.length * healthyAxis.length * migrationAxis.length * rollbackAxis.length,
    );
    expect([...kinds].sort()).toEqual(['escalate:exhausted', 'escalate:migration', 'none', 'rollback']);

    const mismatched = rows.filter(r => JSON.stringify(r.want) !== JSON.stringify(r.got));
    expect(mismatched.map(r => ({
      phase: r.m.phase, attempts: r.m.bootAttempts, anchor: r.m.firstBootAt,
      healthy: r.m.confirmedHealthyAt, mig: r.m.migrationsRanDuringEpisode, rb: r.m.rollbackCount,
      want: r.want, got: r.got,
    }))).toEqual([]);
  });

  it('a missing marker is never actionable — a generic outage is not this gate\'s business', () => {
    expect(decideAutoRollback(null, T0)).toEqual({ action: 'none' });
  });

  it('MIGRATION RAN ⇒ ESCALATE, and it outranks the rollback budget (the named row)', () => {
    const m = marker({ bootAttempts: FAIL_BOOT_ATTEMPTS, migrationsRanDuringEpisode: true, rollbackCount: 0 });
    expect(decideAutoRollback(m, T0)).toEqual({ action: 'escalate', reason: 'migration' });
    // Precedence: with BOTH triggers true, the reason must be the DB one — an
    // 'exhausted' escalation is allowed to self-recover later and a migration
    // one is the reason confirmHealthy's recovery arm is scoped the way it is.
    const both = marker({ bootAttempts: FAIL_BOOT_ATTEMPTS, migrationsRanDuringEpisode: true, rollbackCount: 5 });
    expect(decideAutoRollback(both, T0)).toEqual({ action: 'escalate', reason: 'migration' });
  });

  it('rollbackCount >= 1 ⇒ ESCALATE, never a second descent (the named row)', () => {
    const m = marker({ bootAttempts: FAIL_BOOT_ATTEMPTS, rollbackCount: MAX_AUTO_ROLLBACKS });
    expect(decideAutoRollback(m, T0)).toEqual({ action: 'escalate', reason: 'exhausted' });
  });

  it('a clean failing episode with no migration and no spent rollback is the ONLY rollback row', () => {
    const m = marker({ bootAttempts: FAIL_BOOT_ATTEMPTS });
    expect(decideAutoRollback(m, T0)).toEqual({ action: 'rollback' });
  });

  it('an unreadable firstBootAt cannot trip the wall clock (NaN must not read as "long ago")', () => {
    const m = marker({ firstBootAt: 'whenever', bootAttempts: 0 });
    expect(decideAutoRollback(m, T0 + 10 * FAIL_WALL_CLOCK_MS)).toEqual({ action: 'none' });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// THE ROLLBACK TRANSITION PRESERVES THE EVIDENCE THE FAILURE GATE READS.
//
// `toRolledBack` opens a FRESH boot window for the restored build so the same
// gate can catch a restored build that also will not boot. That is right. But
// the gate reads six fields, and a transition that clears one the gate needs is
// how a box goes quiet at the exact moment it is failing.
// ════════════════════════════════════════════════════════════════════════════

/** The marker fields `decideAutoRollback` actually consults. Declared here so a
 *  new gate input cannot be added without this suite noticing. */
const GATE_INPUTS = [
  'phase', 'confirmedHealthyAt', 'bootAttempts', 'firstBootAt',
  'migrationsRanDuringEpisode', 'rollbackCount',
] as const;

describe('update-cannot-brick — the rollback transition preserves the gate\'s evidence', () => {
  it('the declared gate-input list is the one the gate reads (source census)', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'watchdog/src/auto-rollback.ts'), 'utf-8');
    const body = /export function decideAutoRollback[\s\S]*?\n}/.exec(src)?.[0] ?? '';
    expect(body).not.toBe('');
    for (const f of GATE_INPUTS) expect(body).toContain(`marker.${f}`);
    // And nothing else off the marker: a seventh input silently added would make
    // every preservation clause below incomplete without failing anything.
    const referenced = new Set([...body.matchAll(/marker\.([A-Za-z_$][\w$]*)/g)].map(m => m[1]));
    expect([...referenced].sort()).toEqual([...GATE_INPUTS].sort());
  });

  it('the DB-safety evidence survives the transition — a rolled-back episode still knows a migration ran', () => {
    const before = marker({ bootAttempts: FAIL_BOOT_ATTEMPTS, migrationsRanDuringEpisode: true });
    const after = toRolledBack(before);
    expect(after.migrationsRanDuringEpisode).toBe(true);
    expect(after.rollbackCount).toBe(before.rollbackCount + 1);
    expect(after.phase).toBe('rolled-back');
    // The restore target must survive too: a rolled-back episode with no
    // previousVersion/backupDir cannot be reasoned about afterwards.
    expect(after.previousVersion).toBe(before.previousVersion);
    expect(after.backupDir).toBe(before.backupDir);
    expect(after.targetVersion).toBe(before.targetVersion);
  });

  it('THE RESTORED BUILD IS STILL ON A CLOCK — a rollback that never boots must still reach the owner', () => {
    // The failure this pins: rollback.sh restores the previous build, launchd
    // relaunches it, and it cannot execute at all — so nothing ever reaches the
    // platform's boot sentinel, `bootAttempts` stays 0 and `firstBootAt` stays
    // whatever the transition left. If the transition left NO anchor, the gate's
    // wall clock has nothing to measure from and `decideAutoRollback` answers
    // 'none' for ever: the update episode never escalates, the owner is never
    // told the update failed, and the marker sits mid-episode indefinitely.
    const failing = marker({ bootAttempts: FAIL_BOOT_ATTEMPTS });
    expect(decideAutoRollback(failing, T0)).toEqual({ action: 'rollback' });

    const restored = toRolledBack(failing);
    // Immediately after: nothing is failing yet, the restored build deserves its window.
    expect(decideAutoRollback(restored, T0)).toEqual({ action: 'none' });

    // Long past the window, with the restored build never having booted once:
    // the gate MUST have an anchor to trip on, and the only honest answer is
    // 'exhausted' (the one allowed rollback is spent and it did not work).
    const wayLater = Date.parse(restored.updatedAt) + 10 * FAIL_WALL_CLOCK_MS;
    expect(decideAutoRollback(restored, wayLater)).toEqual({ action: 'escalate', reason: 'exhausted' });
  });

  it('the fresh window is real — a restored build that boots and crashes three times escalates, never rolls back again', () => {
    const restored = toRolledBack(marker({ bootAttempts: FAIL_BOOT_ATTEMPTS }));
    const crashing = { ...restored, bootAttempts: FAIL_BOOT_ATTEMPTS, firstBootAt: new Date(T0).toISOString() };
    expect(decideAutoRollback(crashing, T0 + 1000)).toEqual({ action: 'escalate', reason: 'exhausted' });
  });

  it('a restored build that confirms healthy stops the gate dead', () => {
    const restored = toRolledBack(marker({ bootAttempts: FAIL_BOOT_ATTEMPTS }));
    const healthy = { ...restored, confirmedHealthyAt: new Date(T0).toISOString() };
    expect(decideAutoRollback(healthy, T0 + 10 * FAIL_WALL_CLOCK_MS)).toEqual({ action: 'none' });
  });

  it('toFailedPermanently is terminal for the gate and carries its reason', () => {
    for (const reason of ['migration', 'exhausted'] as const) {
      const t = toFailedPermanently(marker({ bootAttempts: FAIL_BOOT_ATTEMPTS }), reason);
      expect(t.phase).toBe('failed-permanently');
      expect(t.failedReason).toBe(reason);
      expect(decideAutoRollback(t, T0 + 10 * FAIL_WALL_CLOCK_MS)).toEqual({ action: 'none' });
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// THE PROPERTY THE SUITE IS NAMED FOR: NO REACHABLE EPISODE STATE IS SILENT.
//
// Every failing state must end in exactly one of: recovery (the box comes up),
// a rollback (the box is repaired), or an escalation (the owner is TOLD). A
// state that answers 'none' for ever while the box is down is the brick.
// ════════════════════════════════════════════════════════════════════════════

describe('update-cannot-brick — no failing episode stays silent', () => {
  it('every in-episode marker with an anchor and no health confirmation reaches a verdict', () => {
    const anchor = new Date(T0).toISOString();
    const later = T0 + 10 * FAIL_WALL_CLOCK_MS;
    const verdicts: RollbackDecision[] = [];
    for (const phase of ['booting-new', 'rolled-back'] as UpdatePhase[]) {
      for (const mig of [false, true]) {
        for (const rb of [0, 1, 2]) {
          for (const attempts of [0, 1, FAIL_BOOT_ATTEMPTS]) {
            const d = decideAutoRollback(marker({ phase, firstBootAt: anchor, migrationsRanDuringEpisode: mig, rollbackCount: rb, bootAttempts: attempts }), later);
            verdicts.push(d);
          }
        }
      }
    }
    expect(verdicts.length).toBe(2 * 2 * 3 * 3);
    expect(verdicts.filter(v => v.action === 'none')).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// THE GATE IS RELEASE-GATED, AND SO IS PHASE 5's SIGNATURE CHECK.
// ════════════════════════════════════════════════════════════════════════════

describe('update-cannot-brick — release gating', () => {
  it('rides the never-skippable unit-suite release gate, and so does the artifact integrity check', async () => {
    const manifestPath = path.join(REPO_ROOT, 'deploy/checks/gate-manifest.mjs');
    const { GATES } = await import(/* @vite-ignore */ manifestPath) as { GATES: Array<{ id: string; tier: string; title: string }> };
    const unit = GATES.find(g => g.id === 'unit-suite');
    expect(unit, 'the unit-suite gate must exist — it is what runs this file at release').toBeTruthy();
    expect(unit!.tier).toBe('release-only');

    // Both files must be where that gate can see them (`vitest run` in packages/server).
    for (const rel of [
      'packages/server/src/update/__tests__/update-cannot-brick.test.ts',
      'packages/server/src/update/__tests__/artifact-integrity.test.ts',
    ]) {
      expect(fs.existsSync(path.join(REPO_ROOT, rel)), `${rel} must exist under packages/server so the unit-suite gate runs it`).toBe(true);
    }
  });

  it('the watchdog contract gate still governs both copies of the marker shape', async () => {
    const manifestPath = path.join(REPO_ROOT, 'deploy/checks/gate-manifest.mjs');
    const { GATES } = await import(/* @vite-ignore */ manifestPath) as { GATES: Array<{ id: string; tier: string }> };
    const wd = GATES.find(g => g.id === 'watchdog-contract');
    expect(wd?.tier).toBe('blocking');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// THE MARKER FILE ITSELF: a corrupt or half-written marker can never be the
// reason a box is bricked, and a scratch HOME proves it against the real reader.
// ════════════════════════════════════════════════════════════════════════════

describe('update-cannot-brick — the marker reader never becomes the failure', () => {
  let home: string;
  let statePath: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ucb-'));
    statePath = path.join(home, 'update-state.json');
  });
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

  it('missing / empty / truncated / non-object / unknown-phase markers all fail SAFE', () => {
    expect(watchdogReadMarker(statePath)).toBeNull();

    fs.writeFileSync(statePath, '');
    expect(watchdogReadMarker(statePath)).toBeNull();

    fs.writeFileSync(statePath, '{"phase":"booting-new","bootAtt');
    expect(watchdogReadMarker(statePath)).toBeNull();

    fs.writeFileSync(statePath, '"just a string"');
    expect(watchdogReadMarker(statePath)).toBeNull();

    fs.writeFileSync(statePath, JSON.stringify({ phase: 'wat', bootAttempts: 99 }));
    const clamped = watchdogReadMarker(statePath)!;
    expect(clamped.phase).toBe('idle');
    expect(decideAutoRollback(clamped, T0 + 10 * FAIL_WALL_CLOCK_MS)).toEqual({ action: 'none' });
  });

  it('a marker with hostile field types reads as safe zeroes, never as a failing episode', () => {
    fs.writeFileSync(statePath, JSON.stringify({
      phase: 'booting-new',
      bootAttempts: 'lots', firstBootAt: 12345, rollbackCount: null,
      migrationsRanDuringEpisode: 'yes', confirmedHealthyAt: {},
    }));
    const m = watchdogReadMarker(statePath)!;
    expect(m.bootAttempts).toBe(0);
    expect(m.firstBootAt).toBeNull();
    expect(m.rollbackCount).toBe(0);
    // 'yes' is not `true`: only a real boolean true may arm the DB-safety escalation.
    expect(m.migrationsRanDuringEpisode).toBe(false);
    expect(decideAutoRollback(m, T0)).toEqual({ action: 'none' });
  });

  it('a write followed by a read round-trips every gate input', () => {
    const m = marker({ bootAttempts: 2, firstBootAt: new Date(T0).toISOString(), migrationsRanDuringEpisode: true, rollbackCount: 1 });
    watchdogWriteMarker(m, statePath);
    const back = watchdogReadMarker(statePath)!;
    for (const f of GATE_INPUTS) expect(back[f]).toEqual(m[f]);
  });
});
