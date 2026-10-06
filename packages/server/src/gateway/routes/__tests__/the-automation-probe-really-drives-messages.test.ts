// ════════════════════════════════════════════════════════════════════════════════════════
// THE AUTOMATION PROBE ASKS MESSAGES, AND ANSWERS WHAT IT LEARNED (t115).
//
// ── THE TWO DEFECTS THIS FILE STANDS BETWEEN ──
//
//   t96:  `osascript -e "return 1"` drove no application, so it needed no Automation grant and
//         reported `granted` on a box where sending was blocked. A FALSE GREEN.
//   t113: the probe returned `unknown` unconditionally, which was honest but answered nothing.
//
// The owner ruled (2026-10-06) that the check becomes the real probe and the macOS consent
// dialog is accepted. So the clauses here hold BOTH edges: the probe must classify a real
// success as `granted` and macOS's real refusal as `denied` (t113's blanket `unknown` reds), and
// it must not claim either from a run that established neither (t96's false green reds).
//
// ── THE EXEC SEAM IS MOCKED, DELIBERATELY ──
// Nothing here drives the real Messages app. The dev box's TCC state is not a fixture: it would
// make `granted` and `denied` depend on which machine ran the suite, and on a granted box the
// suite would launch Messages. `setAutomationProbeSpawn` hands in the three outcomes instead,
// which is also the only way to drive the slow-dialog path at all.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import {
  automationPermissionStatus, classifyAutomationProbe,
  setAutomationProbeSpawn, resetAutomationProbeForTests,
  lastCompletedAutomationStatus,
  MESSAGES_READ_ONLY_PROBE, OSASCRIPT_PATH, PROBE_SETTLE_MS, PROBE_CEILING_MS,
  type AutomationProbeChild,
} from '../automation-probe.js';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../../../../..');
const PROBE_SRC = path.join(REPO_ROOT, 'packages/server/src/gateway/routes/automation-probe.ts');
const ROUTE_SRC = path.join(REPO_ROOT, 'packages/server/src/gateway/routes/setup-deps.ts');
const read = (p: string): string => fs.readFileSync(p, 'utf-8');

/** Comments blanked, line structure kept (G4): a clause that reads prose tests the prose. */
const stripComments = (s: string): string => s
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1: string) => p1 + ' '.repeat(m.length - p1.length));

/** A probe that finishes at once with the given exit. */
const settlesWith = (code: number | null, stderr = ''): AutomationProbeChild => ({
  settled: Promise.resolve({ code, stderr }),
  kill: () => { /* already finished */ },
});

beforeEach(() => { resetAutomationProbeForTests(); });
afterEach(() => { resetAutomationProbeForTests(); vi.useRealTimers(); });

describe('the three outcomes, classified honestly', () => {
  it('⚠ GRANTED — the AppleEvent landed, which is the thing the permission governs', async () => {
    // This is the clause t113's unconditional `unknown` cannot pass, and it is the whole
    // point of the ruling: a real success is reported as a real grant.
    setAutomationProbeSpawn(() => settlesWith(0, ''));
    await expect(automationPermissionStatus()).resolves.toBe('granted');
  });

  it('⚠ DENIED — macOS\'s own refusal, by number and by sentence', async () => {
    // -1743 is `errAEEventNotPermitted`: what a "Don't Allow" is recorded as, and what every
    // later call gets, because the dialog does not come back. Both forms are matched because
    // osascript's wording and its numeric tail have each moved across releases, and either
    // alone is one release away from silently demoting a denial to `unknown`.
    const forms = [
      'execution error: Not authorized to send Apple events to Messages. (-1743)',
      'execution error: something else entirely (-1743)',
      'execution error: Not authorized to send Apple events to Messages.',
    ];
    for (const stderr of forms) {
      resetAutomationProbeForTests();
      setAutomationProbeSpawn(() => settlesWith(1, stderr));
      await expect(automationPermissionStatus(), stderr).resolves.toBe('denied');
    }
  });

  it('⚠ UNKNOWN — no Messages to drive is not a denial', async () => {
    // Reporting `denied` here would accuse the owner of refusing something they were never
    // asked, and would send them to a pane with no row in it.
    const absent = [
      'execution error: Can’t get application "Messages". (-1728)',
      '34:48: execution error: An error of type -10814 has occurred.',
      'execution error: Application isn’t running. (-600)',
      'ENOENT spawn /usr/bin/osascript ENOENT',
    ];
    for (const stderr of absent) {
      resetAutomationProbeForTests();
      setAutomationProbeSpawn(() => settlesWith(1, stderr));
      await expect(automationPermissionStatus(), stderr).resolves.toBe('unknown');
    }
  });

  it('⚠ an UNRECOGNISED failure is unknown, not denied — t96\'s lesson, reversed', async () => {
    // t96's defect was asserting a state the run had not established. That is a defect in
    // either direction: a failure we cannot read must not be reported as a refusal.
    setAutomationProbeSpawn(() => settlesWith(2, 'execution error: who knows (-9999)'));
    await expect(automationPermissionStatus()).resolves.toBe('unknown');
  });

  it('classification is reachable on its own, with no clock involved', () => {
    expect(classifyAutomationProbe({ code: 0, stderr: '' })).toBe('granted');
    expect(classifyAutomationProbe({ code: 1, stderr: '(-1743)' })).toBe('denied');
    expect(classifyAutomationProbe({ code: 1, stderr: '(-1728)' })).toBe('unknown');
    expect(classifyAutomationProbe({ code: null, stderr: '' })).toBe('unknown');
  });
});

describe('the bound waits on a human without hanging on one', () => {
  it('⚠ a dialog still up answers `unknown` for now and the child is NOT killed', async () => {
    vi.useFakeTimers();
    const kill = vi.fn();
    // Never settles: the consent dialog is on screen and nobody has clicked.
    setAutomationProbeSpawn(() => ({ settled: new Promise(() => { /* pending */ }), kill }));

    const answer = automationPermissionStatus();
    await vi.advanceTimersByTimeAsync(PROBE_SETTLE_MS + 1);

    expect(await answer, 'the request must not hang on a human').toBe('unknown');
    expect(kill, 'nothing is killed for waiting on the owner').not.toHaveBeenCalled();
  });

  it('⚠ the answer the owner finally gives lands, and the next poll reads it', async () => {
    vi.useFakeTimers();
    let settle!: (r: { code: number | null; stderr: string }) => void;
    const kill = vi.fn();
    setAutomationProbeSpawn(() => ({
      settled: new Promise((res) => { settle = res; }),
      kill,
    }));

    const first = automationPermissionStatus();
    await vi.advanceTimersByTimeAsync(PROBE_SETTLE_MS + 1);
    expect(await first).toBe('unknown');

    // Minutes later, the owner clicks OK. THIS is why the slow child is kept rather than
    // killed: its answer is the answer.
    settle({ code: 0, stderr: '' });
    await vi.advanceTimersByTimeAsync(1);
    expect(lastCompletedAutomationStatus(), 'the late answer has to land somewhere')
      .toBe('granted');

    // And a later poll READS it — even one whose own probe has not come back yet, which is the
    // case that matters: the row goes green on the click, not on the next lucky round trip.
    setAutomationProbeSpawn(() => ({ settled: new Promise(() => {}), kill }));
    const second = automationPermissionStatus();
    await vi.advanceTimersByTimeAsync(PROBE_SETTLE_MS + 1);
    expect(await second).toBe('granted');
  });

  it('⚠ the ceiling is the only thing that ends an unanswered dialog', async () => {
    vi.useFakeTimers();
    const kill = vi.fn();
    setAutomationProbeSpawn(() => ({ settled: new Promise(() => { /* pending */ }), kill }));

    void automationPermissionStatus();
    await vi.advanceTimersByTimeAsync(PROBE_SETTLE_MS + 1);
    expect(kill, 'the settle window must not kill').not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(PROBE_CEILING_MS);
    expect(kill, 'a dialog nobody ever answers ends at the ceiling').toHaveBeenCalledTimes(1);
  });

  it('⚠ SINGLE FLIGHT — polling cannot stack consent dialogs', async () => {
    // The dashboard polls on mount and again five seconds after every "Open Settings". One
    // dialog is accepted; a pile of them is not, and that is the one way an accepted pop-up
    // becomes an unacceptable one.
    vi.useFakeTimers();
    let spawns = 0;
    setAutomationProbeSpawn(() => {
      spawns++;
      return { settled: new Promise(() => { /* pending */ }), kill: () => {} };
    });

    const a = automationPermissionStatus();
    const b = automationPermissionStatus();
    const c = automationPermissionStatus();
    await vi.advanceTimersByTimeAsync(PROBE_SETTLE_MS + 1);
    expect([await a, await b, await c]).toEqual(['unknown', 'unknown', 'unknown']);
    expect(spawns, 'one probe in flight means one dialog').toBe(1);
  });

  it('a settled probe is re-asked, because a `denied` row has to be able to turn green', async () => {
    // Nothing is cached across completed probes: once TCC has decided, the probe is a
    // dialog-free round trip, so re-asking is what makes the light follow the switch.
    let spawns = 0;
    setAutomationProbeSpawn(() => { spawns++; return settlesWith(1, '(-1743)'); });
    await expect(automationPermissionStatus()).resolves.toBe('denied');
    await expect(automationPermissionStatus()).resolves.toBe('denied');
    expect(spawns).toBe(2);
  });
});

describe('the script cannot mutate anything, and the shape is what says so', () => {
  it('⚠ it is a `get` of the application\'s own name, and nothing else', () => {
    expect(MESSAGES_READ_ONLY_PROBE).toBe('tell application "Messages" to get name');
  });

  it('⚠ no mutating verb and no user-data noun appears in it', () => {
    // The two halves of a send are a verb and a target. Neither is present, and this is the
    // clause that reds if someone "improves" the probe into one.
    for (const forbidden of [
      /\bsend\b/i, /\bset\b/i, /\bmake\b/i, /\bdelete\b/i, /\bclose\b/i, /\bsave\b/i,
      /\bbuddy\b/i, /\bchat\b/i, /\bmessage\b(?!s")/i, /\baccount\b/i, /\bfile\b/i,
    ]) {
      expect(MESSAGES_READ_ONLY_PROBE, `the probe must not contain ${forbidden}`)
        .not.toMatch(forbidden);
    }
  });

  it('⚠ nothing is interpolated into it, and no shell can extend it', () => {
    // A constant string is only a constant string while nobody builds it. A template with a
    // `${}` in it, or a `/bin/sh -c`, is the shape that would let a value reach the script.
    const src = stripComments(read(PROBE_SRC));
    expect(src, 'the script is a plain literal, not an assembled one')
      .toMatch(/MESSAGES_READ_ONLY_PROBE = 'tell application "Messages" to get name'/);
    expect(src, 'no shell anywhere in this module').not.toMatch(/\/bin\/sh|shell:\s*true|execSync/);
    expect(src, 'the binary is absolute and the script is one argv entry')
      .toMatch(/spawn\(OSASCRIPT_PATH, \['-e', MESSAGES_READ_ONLY_PROBE\]/);
    expect(OSASCRIPT_PATH).toBe('/usr/bin/osascript');
  });

  it('⚠ the no-op probe t96 found is gone from the module AND from the route', () => {
    // Both halves, because the string could be restored in either place.
    expect(stripComments(read(PROBE_SRC))).not.toMatch(/return 1/);
    expect(stripComments(read(ROUTE_SRC))).not.toMatch(/osascript -e "return 1"/);
  });
});

describe('THE WIRE — the endpoint reports what this module classified', () => {
  it('⚠ /permissions/check awaits the probe, in APPLICATION not merely in import', () => {
    // G4 both ways: importing the function and still returning a hard-coded `unknown` would
    // satisfy a presence-only clause. The automation field must BE the call.
    const src = stripComments(read(ROUTE_SRC));
    expect(src, 'the route imports the probe')
      .toMatch(/import \{ automationPermissionStatus \} from '\.\/automation-probe\.js'/);
    expect(src, 'and the automation field is its awaited result')
      .toMatch(/automation:\s*await automationPermissionStatus\(\)/);
  });

  it('⚠ the sync `checkPermission` switch no longer answers for automation at all', () => {
    // t113's `case 'automation': return 'unknown'` lived here. If it came back it would
    // shadow the real probe silently — the field would read from the switch again.
    const src = stripComments(read(ROUTE_SRC));
    const check = src.slice(src.indexOf('const checkPermission'), src.indexOf('serverExecPath'));
    expect(check, 'no automation case in the no-side-effect switch').not.toMatch(/case 'automation'/);
    expect(check, 'the three cheap probes are untouched')
      .toMatch(/case 'full-disk-access'/);
  });

  it('⚠ the handler is async, which is what makes the real probe possible', () => {
    expect(stripComments(read(ROUTE_SRC)))
      .toMatch(/setupDepsRouter\.get\('\/permissions\/check', async \(c\) =>/);
  });

  it('the request route still only OPENS the pane — the probe is the thing that asks', () => {
    // The asymmetry the dashboard copy is built on: "Open Settings" must not raise a second
    // dialog of its own, because the check already did.
    const src = stripComments(read(ROUTE_SRC));
    const request = src.slice(src.indexOf("permissions/request"));
    const body = request.slice(request.indexOf("case 'automation':"));
    const upToBreak = body.slice(0, body.indexOf('break;'));
    expect(upToBreak).toMatch(/Privacy_Automation/);
    expect(upToBreak, 'the pane opener must not drive an application')
      .not.toMatch(/osascript|tell application|automationPermissionStatus/);
  });
});
