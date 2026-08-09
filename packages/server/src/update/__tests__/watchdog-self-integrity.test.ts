// ════════════════════════════════════════════════════════════════════════════
// WATCHDOG SELF-INTEGRITY (M9) — SWEEP-F T5, SWEEP CORE-2 item 6.
//
// Three clauses of T5's "failing tests first" list live here. The D-F truth
// table is next door in `update-cannot-brick.test.ts`.
//
//   1. `update-state.json` single-writer discipline — two-process RMW dies.
//   2. async `'error'` events cannot kill the daemon.
//   3. the alert dedup / recovery ledger is persisted — a restart loses no
//      recovery message, and neither does an unreadable DB.
//
// ── WHY REAL CHILD PROCESSES ────────────────────────────────────────────────
// Two of the three are PROCESS properties. A lost update between the platform
// and the watchdog cannot be reproduced with two function calls in one event
// loop, and "the daemon is still alive" is not a claim a mocked emitter can
// make. So those clauses fork real `node`/`tsx` children against a scratch
// HOME. No live restart of the real server is involved and nothing outside the
// temp directory is touched — the plan's "fixture-driven" requirement, met
// without pretending a single-process test proves a two-process property.
// ════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../../../..');
const TSX = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx');

let home: string;
let statePath: string;

function scratchHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-si-'));
  fs.mkdirSync(path.join(dir, '.dojo'), { recursive: true });
  return dir;
}

/** Write a child program. `.mts` so esbuild emits ESM (top-level await) wherever
 *  the file happens to live — the scratch HOME carries no package.json. */
function childFile(source: string, at = home): string {
  const file = path.join(at, `child-${Math.random().toString(36).slice(2)}.mts`);
  fs.writeFileSync(file, source);
  return file;
}

/** Run a snippet in a REAL child process with HOME pointed at the fixture.
 *  `os.homedir()` honours $HOME on POSIX, which is what makes both modules
 *  resolve `~/.dojo/update-state.json` inside the scratch directory. */
function runInChild(source: string, opts: { home?: string } = {}): { status: number | null; stdout: string; stderr: string } {
  const at = opts.home ?? home;
  const r = spawnSync(TSX, [childFile(source, at)], {
    encoding: 'utf-8',
    env: { ...process.env, HOME: at },
    timeout: 60_000,
    cwd: REPO_ROOT,
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** Start a child and resolve when it exits. Used where the point is that two
 *  processes are genuinely in flight at the same time. */
function startChild(source: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(TSX, [childFile(source)], {
    env: { ...process.env, HOME: home }, cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', (d) => { stdout += String(d); });
  child.stderr.on('data', (d) => { stderr += String(d); });
  return new Promise((resolve) => child.on('close', (code) => resolve({ code, stdout, stderr })));
}

const sleepSrc = 'const sleep = (ms) => new Promise(r => setTimeout(r, ms));';

const PLATFORM_MOD = path.join(REPO_ROOT, 'packages/server/src/update-state.ts');
const WATCHDOG_MOD = path.join(REPO_ROOT, 'watchdog/src/auto-rollback.ts');

beforeEach(() => {
  home = scratchHome();
  statePath = path.join(home, '.dojo', 'update-state.json');
});
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

// ════════════════════════════════════════════════════════════════════════════
// 1. SINGLE-WRITER DISCIPLINE
//
// The marker has TWO writer processes and that is not negotiable: the watchdog
// must be able to write `rolled-back` on a box whose platform will not boot, so
// "one process writes" is impossible by construction. What IS achievable, and
// what this section holds, is that every read-modify-write is SERIALISED and a
// write built on a stale read is REFUSED rather than applied.
//
// The lost update this pins is the brick itself. The watchdog reads the marker,
// decides `rollback` (no migration ran), and writes `toRolledBack`. Between the
// read and the write the platform's boot sentinel runs `markMigrationsRan()`.
// The watchdog's write is built on the stale copy, so it ERASES the flag — and
// the box now believes a code-only rollback is safe on a database the old build
// cannot read. That is exactly the outcome the owner's 2026-07-06 decision
// exists to prevent, arrived at through a race instead of through a bug in the
// gate.
// ════════════════════════════════════════════════════════════════════════════

describe('watchdog self-integrity — update-state.json single-writer discipline', () => {
  it('the enumerated writers are the only ones, and every read-modify-write goes through one door', () => {
    // A census, because the property is "no second RMW path", and a test that
    // only exercises the paths it knows about cannot see a new one.
    const files = [
      'packages/server/src/update-state.ts',
      'watchdog/src/auto-rollback.ts',
      'watchdog/src/index.ts',
      'packages/server/src/index.ts',
      'packages/server/src/gateway/routes/update.ts',
      'packages/server/src/healer/diagnostic.ts',
    ];
    const rmwOutsideTheDoor: string[] = [];
    for (const rel of files) {
      const src = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf-8');
      const lines = src.split('\n');
      lines.forEach((line, i) => {
        const code = line.replace(/\/\/.*$/, '');
        if (/\bwriteMarker\s*\(/.test(code) && !/export function writeMarker/.test(code)) {
          rmwOutsideTheDoor.push(`${rel}:${i + 1}  ${line.trim()}`);
        }
      });
    }
    // `writeMarker` is the raw persist. Every caller that first READ the marker
    // must go through `updateMarker`, which holds the lock and refuses a stale
    // base. The only sanctioned raw callers are inside `update-state.ts` /
    // `auto-rollback.ts` themselves.
    const foreign = rmwOutsideTheDoor.filter(l => !l.startsWith('packages/server/src/update-state.ts:') && !l.startsWith('watchdog/src/auto-rollback.ts:'));
    expect(foreign, 'a read-modify-write outside updateMarker() is a lost update waiting to happen').toEqual([]);
  });

  it('both copies export the serialising door and the write counter (hand-synced contract)', () => {
    for (const rel of ['packages/server/src/update-state.ts', 'watchdog/src/auto-rollback.ts']) {
      const src = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf-8');
      expect(src, `${rel} must export updateMarker`).toMatch(/export function updateMarker\s*\(/);
      expect(src, `${rel} must declare writeSeq on the marker`).toMatch(/writeSeq\s*:\s*number/);
      expect(src, `${rel} must take an exclusive lock (O_CREAT|O_EXCL)`).toMatch(/'wx'/);
    }
  });

  it('the temp file is unique per writer — a shared `.tmp` is a half-written marker waiting to be renamed', () => {
    for (const rel of ['packages/server/src/update-state.ts', 'watchdog/src/auto-rollback.ts']) {
      const src = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf-8');
      // Comments are stripped: both files DOCUMENT the retired shape by name, and
      // a census that cannot tell a description from a live statement would go
      // permanently red on its own explanation.
      const code = src.split('\n').map(l => l.replace(/^\s*\/\/.*$/, '')).join('\n');
      // The defect: `const tmp = \`${statePath}.tmp\`` — one fixed name for BOTH
      // processes, so two concurrent writes clobber each other's temp file and
      // one of them renames a partially-written document over the real marker.
      //
      // Written as "the assignment must be the helper, and the helper must use
      // the pid" rather than "the file must not contain this one string": the
      // first version of this clause only forbade the template-literal spelling
      // and a re-planted `UPDATE_STATE_PATH + '.tmp'` walked straight past it.
      const assigns = [...code.matchAll(/const\s+tmp\s*=\s*([^;]+);/g)].map(m => m[1].trim());
      expect(assigns.length, `${rel} declares no temp path at all`).toBeGreaterThan(0);
      for (const expr of assigns) {
        expect(expr, `${rel}: the temp path must come from tempPath(), not be spelled inline`).toMatch(/^tempPath\(/);
      }
      const helper = /function tempPath\([^)]*\)[^{]*\{([\s\S]*?)\n\}/.exec(code)?.[1] ?? '';
      expect(helper, `${rel}: tempPath() must derive a per-writer name`).toMatch(/process\.pid/);
    }
  });

  it('DRIVEN, TWO REAL PROCESSES: a concurrent migration flag survives the watchdog\'s rollback write', async () => {
    // The platform opens an episode and drives it to failing.
    const setup = runInChild(`
      const m = await import(${JSON.stringify(PLATFORM_MOD)});
      m.markPendingUpdate({ targetVersion: '3.1.18', previousVersion: '3.1.17', backupDir: '/tmp/b' });
      m.markBootingNew();
      m.recordBootAttempt(); m.recordBootAttempt(); m.recordBootAttempt();
      console.log(JSON.stringify(m.readMarker()));
    `);
    expect(setup.status, setup.stderr).toBe(0);
    const opened = JSON.parse(setup.stdout.trim().split('\n').pop()!);
    expect(opened.phase).toBe('booting-new');
    expect(opened.bootAttempts).toBe(3);
    expect(opened.migrationsRanDuringEpisode).toBe(false);

    // Now run BOTH writers at once, for real. The watchdog reads FIRST, waits,
    // and only then applies its transition; the platform stamps the migration
    // inside that window. This is the lost update, staged.
    const watchdog = startChild(`
      ${sleepSrc}
      const w = await import(${JSON.stringify(WATCHDOG_MOD)});
      const stale = w.readMarker();
      await sleep(900);
      // First, the PRE-FIX shape, verbatim: a transition computed from the copy
      // read before the platform moved the file. It must be REFUSED — this is
      // the compare-and-swap being the thing that saves the box, proven
      // independently of whether the caller remembered to use the door.
      console.log('STALE_WRITE_ACCEPTED=' + w.writeMarkerIfUnchanged(stale, w.toRolledBack(stale)));
      w.updateMarker((fresh) => {
        const d = w.decideAutoRollback(fresh, Date.now());
        if (!fresh || d.action === 'none') return null;
        return d.action === 'escalate' ? w.toFailedPermanently(fresh, d.reason) : w.toRolledBack(fresh);
      });
      console.log('watchdog-done');
    `);
    const platform = startChild(`
      ${sleepSrc}
      const m = await import(${JSON.stringify(PLATFORM_MOD)});
      await sleep(400);
      m.markMigrationsRan();
      console.log('platform-done');
    `);
    const [w, p] = await Promise.all([watchdog, platform]);
    expect(p.code, p.stderr).toBe(0);
    expect(w.code, w.stderr).toBe(0);
    expect(w.stdout, 'the stale-base write must be refused').toContain('STALE_WRITE_ACCEPTED=false');

    const after = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    expect(after.migrationsRanDuringEpisode, 'the platform stamped a migration mid-flight; erasing it is the brick').toBe(true);
    // And because the transition re-decides on the FRESH marker inside the lock,
    // the outcome is the escalation the ruling demands, not a code-only rollback.
    expect(after.phase).toBe('failed-permanently');
    expect(after.failedReason).toBe('migration');
    expect(after.rollbackCount).toBe(0);
  }, 90_000);

  it('DRIVEN: a write built on a stale base is REFUSED, and the refusal is visible to the caller', () => {
    const r = runInChild(`
      const m = await import(${JSON.stringify(PLATFORM_MOD)});
      m.markPendingUpdate({ targetVersion: 'v2', previousVersion: 'v1', backupDir: '/tmp/b' });
      const stale = m.readMarker();
      // Somebody else advances the file.
      m.markBootingNew();
      const advanced = m.readMarker();
      // A CAS write anchored on the stale copy must not land.
      const refused = m.writeMarkerIfUnchanged(stale, { ...stale, phase: 'healthy' });
      const now = m.readMarker();
      console.log(JSON.stringify({
        refused, staleSeq: stale.writeSeq, advancedSeq: advanced.writeSeq,
        phase: now.phase, seq: now.writeSeq,
      }));
    `);
    expect(r.status, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout.trim().split('\n').pop()!);
    expect(out.refused).toBe(false);          // the write did NOT happen
    expect(out.advancedSeq).toBeGreaterThan(out.staleSeq);
    expect(out.phase).toBe('booting-new');    // the advanced state survived
    expect(out.seq).toBe(out.advancedSeq);
  }, 60_000);

  it('DRIVEN: writeSeq is monotonic across every writer and across an episode boundary', () => {
    const r = runInChild(`
      const m = await import(${JSON.stringify(PLATFORM_MOD)});
      const seqs = [];
      const grab = () => seqs.push(m.readMarker()?.writeSeq ?? -1);
      m.markPendingUpdate({ targetVersion: 'v2', previousVersion: 'v1', backupDir: '/tmp/b' }); grab();
      m.markBootingNew(); grab();
      m.recordBootAttempt(); grab();
      m.markMigrationsRan(); grab();
      m.confirmHealthy(); grab();
      // A brand-new episode must not rewind the counter — a rewound counter lets a
      // stale write from the previous episode pass the compare-and-swap.
      m.markPendingUpdate({ targetVersion: 'v3', previousVersion: 'v2', backupDir: '/tmp/c' }); grab();
      console.log(JSON.stringify(seqs));
    `);
    expect(r.status, r.stderr).toBe(0);
    const seqs: number[] = JSON.parse(r.stdout.trim().split('\n').pop()!);
    expect(seqs.length).toBe(6);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i], `writeSeq went backwards at step ${i}: ${JSON.stringify(seqs)}`).toBeGreaterThan(seqs[i - 1]);
    }
  }, 60_000);

  it('DRIVEN: a stale lock left by a killed writer is broken, never inherited — the marker path cannot wedge', () => {
    const lock = `${statePath}.lock`;
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(lock, '999999');
    // Age it well past the stale bound.
    const old = new Date(Date.now() - 10 * 60_000);
    fs.utimesSync(lock, old, old);
    const r = runInChild(`
      const m = await import(${JSON.stringify(PLATFORM_MOD)});
      m.markPendingUpdate({ targetVersion: 'v2', previousVersion: 'v1', backupDir: '/tmp/b' });
      console.log(JSON.stringify({ phase: m.readMarker()?.phase ?? null }));
    `);
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout.trim().split('\n').pop()!).phase).toBe('pending-update');
    expect(fs.existsSync(lock), 'the lock must be released, not left behind').toBe(false);
  }, 60_000);
});

// ════════════════════════════════════════════════════════════════════════════
// 2. ASYNC 'error' EVENTS CANNOT KILL THE DAEMON
//
// Node throws an unhandled `'error'` event out of the event loop. There is no
// try/catch that can reach it: `spawn()` returns synchronously and the failure
// arrives on a later tick, so the `try { spawn(...) } catch {}` around every one
// of these call sites catches nothing. An unhandled `'error'` on a ChildProcess
// takes the whole process down — and the two sites that can raise one are
// `spawnRollbackDetached` (raised WHILE a rollback is being performed) and the
// emergency-restart fallback (raised while the platform is already down). The
// watchdog dying at either moment is the last line of defense going out at the
// exact moment it is the only thing left.
// ════════════════════════════════════════════════════════════════════════════

describe('watchdog self-integrity — async errors cannot kill the daemon', () => {
  it('every spawn in watchdog/src attaches an error handler to the child it created (census)', () => {
    const files = ['watchdog/src/index.ts', 'watchdog/src/auto-rollback.ts'];
    const unguarded: string[] = [];
    let spawnSites = 0;
    for (const rel of files) {
      const src = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf-8');
      const lines = src.split('\n');
      lines.forEach((line, i) => {
        if (!/(?:^|[^.\w])spawn\s*\(/.test(line.replace(/\/\/.*$/, ''))) return;
        spawnSites++;
        // The handler must be attached within a short window of the spawn — before
        // any await, and on the same child. 12 lines is generous and readable.
        const window = lines.slice(i, i + 12).join('\n');
        if (!/\.on\(\s*'error'/.test(window)) unguarded.push(`${rel}:${i + 1}  ${line.trim()}`);
      });
    }
    expect(spawnSites, 'the census found no spawn at all — it has stopped measuring anything').toBeGreaterThanOrEqual(2);
    expect(unguarded, 'an unhandled child "error" event kills the daemon; try/catch cannot reach it').toEqual([]);
  });

  it('the daemon installs a process-level net for uncaught errors, and it LOGS rather than exits', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'watchdog/src/index.ts'), 'utf-8');
    expect(src).toMatch(/process\.on\(\s*'uncaughtException'/);
    expect(src).toMatch(/process\.on\(\s*'unhandledRejection'/);
    // A net that exits is not a net. Pull each handler body and refuse a process.exit.
    for (const evt of ['uncaughtException', 'unhandledRejection']) {
      const m = new RegExp(`process\\.on\\(\\s*'${evt}'[\\s\\S]*?\\n\\}\\);`).exec(src);
      expect(m, `${evt} handler not found`).toBeTruthy();
      expect(m![0], `the ${evt} net must keep watching, not exit`).not.toMatch(/process\.exit/);
      expect(m![0]).toMatch(/log\(\s*'error'/);
    }
  });

  it('DRIVEN, REAL PROCESS: a real async spawn error does not kill a process carrying the net', () => {
    const netted = `
      process.on('uncaughtException', () => { console.log('CAUGHT'); });
      process.on('unhandledRejection', () => { console.log('CAUGHT'); });
      const { spawn } = await import('node:child_process');
      const child = spawn('/definitely/not/a/binary/at/all', []);   // ENOENT arrives ASYNCHRONOUSLY
      child.unref();
      setTimeout(() => { console.log('ALIVE'); process.exit(0); }, 400);
    `;
    const a = runInChild(netted);
    expect(a.stdout).toContain('CAUGHT');
    expect(a.stdout, 'the process must still be running after the async error').toContain('ALIVE');
    expect(a.status).toBe(0);

    // NEGATIVE CONTROL: the identical program WITHOUT the net dies, which is what
    // the pre-fix watchdog was. If this arm ever passes, the clause above proves nothing.
    const bare = `
      const { spawn } = await import('node:child_process');
      const child = spawn('/definitely/not/a/binary/at/all', []);
      child.unref();
      setTimeout(() => { console.log('ALIVE'); process.exit(0); }, 400);
    `;
    const b = runInChild(bare);
    expect(b.stdout, 'without a handler the async error must be fatal — otherwise the net is untested').not.toContain('ALIVE');
    expect(b.status).not.toBe(0);
  }, 60_000);

  it('DRIVEN: spawnRollbackDetached reports a missing script instead of throwing, and leaves no listener leak', () => {
    const r = runInChild(`
      const w = await import(${JSON.stringify(WATCHDOG_MOD)});
      const pid = w.spawnRollbackDetached(${JSON.stringify(path.join(home, 'no-such-script.sh'))});
      console.log(JSON.stringify({ pid }));
      setTimeout(() => process.exit(0), 300);
    `);
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout.trim().split('\n')[0]).pid).toBeNull();
  }, 60_000);
});

// ════════════════════════════════════════════════════════════════════════════
// 3. THE ALERT DEDUP / RECOVERY LEDGER
//
// FA-W6 moved this ledger out of process memory and into a watchdog-owned JSON
// file so a KeepAlive restart mid-incident does not re-alert an active issue or
// lose a recovery. That part holds and is DRIVEN below rather than read.
//
// What did NOT hold: the ledger entry was retired BEFORE the recovery message
// had anywhere to go. `markAlertResolved(k)` flips `active` to false and the
// caller then asks for a recipient — so a recovery that lands while the platform
// DB is unreadable (the FA-W2 case, and a very likely one right after an outage)
// is dropped silently and can NEVER be re-sent, because the ledger now says the
// alert was never active. The owner is left holding a "Dojo platform is DOWN"
// text and no "it is back".
// ════════════════════════════════════════════════════════════════════════════

const LEDGER_MOD = path.join(REPO_ROOT, 'watchdog/src/alert-ledger.ts');

describe('watchdog self-integrity — the alert dedup / recovery ledger', () => {
  it('the ledger is a side-effect-free module the daemon imports (so it can be driven at all)', () => {
    expect(fs.existsSync(LEDGER_MOD), 'watchdog/src/alert-ledger.ts must exist').toBe(true);
    const idx = fs.readFileSync(path.join(REPO_ROOT, 'watchdog/src/index.ts'), 'utf-8');
    expect(idx).toMatch(/from '\.\/alert-ledger\.js'/);
  });

  it('DRIVEN ACROSS A RESTART: an active alert is not re-sent, and a recovery is not lost', () => {
    const p = path.join(home, '.dojo', 'watchdog-state.json');
    const first = runInChild(`
      const L = await import(${JSON.stringify(LEDGER_MOD)});
      const s = L.readState(${JSON.stringify(p)});
      console.log(JSON.stringify({ first: L.shouldSendAlert(s, 'platform_down'), second: L.shouldSendAlert(s, 'platform_down') }));
      L.persistState(s, ${JSON.stringify(p)});
    `);
    expect(first.status, first.stderr).toBe(0);
    expect(JSON.parse(first.stdout.trim())).toEqual({ first: true, second: false });

    // A DIFFERENT process — the KeepAlive restart FA-W6 is named for.
    const second = runInChild(`
      const L = await import(${JSON.stringify(LEDGER_MOD)});
      const s = L.readState(${JSON.stringify(p)});
      const resent = L.shouldSendAlert(s, 'platform_down');
      const recovered = L.markAlertResolved(s, 'platform_down');
      const twice = L.markAlertResolved(s, 'platform_down');
      L.persistState(s, ${JSON.stringify(p)});
      console.log(JSON.stringify({ resent, recovered, twice }));
    `);
    expect(second.status, second.stderr).toBe(0);
    expect(JSON.parse(second.stdout.trim())).toEqual({
      resent: false,      // still active across the restart — no spam
      recovered: true,    // the recovery survived the restart
      twice: false,       // and fires exactly once
    });
  }, 60_000);

  it('DRIVEN: the 2h cooldown is honoured, and honoured from the PERSISTED timestamp', () => {
    const p = path.join(home, '.dojo', 'watchdog-state.json');
    const r = runInChild(`
      const L = await import(${JSON.stringify(LEDGER_MOD)});
      const s = L.readState(${JSON.stringify(p)});
      const t0 = 1_000_000_000_000;
      const a = L.shouldSendAlert(s, 'disk_low', t0);
      const b = L.shouldSendAlert(s, 'disk_low', t0 + L.ALERT_COOLDOWN_MS - 1);
      const c = L.shouldSendAlert(s, 'disk_low', t0 + L.ALERT_COOLDOWN_MS + 1);
      L.persistState(s, ${JSON.stringify(p)});
      const reread = L.readState(${JSON.stringify(p)});
      console.log(JSON.stringify({ a, b, c, lastSentAt: reread.alertState.disk_low.lastSentAt, active: reread.alertState.disk_low.active }));
    `);
    expect(r.status, r.stderr).toBe(0);
    const o = JSON.parse(r.stdout.trim());
    expect([o.a, o.b, o.c]).toEqual([true, false, true]);
    expect(o.active).toBe(true);
  }, 60_000);

  it('A RECOVERY IS NEVER RETIRED BEFORE IT HAS SOMEWHERE TO GO (the dropped "it is back" message)', () => {
    const idx = fs.readFileSync(path.join(REPO_ROOT, 'watchdog/src/index.ts'), 'utf-8');
    // Every place that resolves an alert AND texts about it must resolve the
    // ledger only once a recipient has been resolved, so an unreadable DB
    // postpones the recovery instead of destroying it.
    expect(idx).toMatch(/function resolveAndTell\s*\(/);
    const body = /function resolveAndTell[\s\S]*?\n\}/.exec(idx)![0];
    const recipientAt = body.indexOf('getImessageRecipient');
    const resolveAt = body.indexOf('markAlertResolved');
    expect(recipientAt).toBeGreaterThan(-1);
    expect(resolveAt).toBeGreaterThan(-1);
    expect(recipientAt, 'the recipient must be resolved BEFORE the ledger entry is retired').toBeLessThan(resolveAt);

    // And no site may still do it the other way round.
    const lines = idx.split('\n');
    const bad: string[] = [];
    lines.forEach((line, i) => {
      if (!/if\s*\(\s*markAlertResolved\(/.test(line)) return;
      const window = lines.slice(i, i + 8).join('\n');
      if (/sendIMessage|sendSmartAlert/.test(window)) bad.push(`watchdog/src/index.ts:${i + 1}  ${line.trim()}`);
    });
    expect(bad, 'this shape retires the alert and THEN looks for somewhere to send it').toEqual([]);
  });

  it('DRIVEN: a corrupt ledger file starts clean instead of crashing the daemon', () => {
    const p = path.join(home, '.dojo', 'watchdog-state.json');
    fs.writeFileSync(p, '{"alertState": {"platform_down": "not an object"}, "lastHeartbeat":');
    const r = runInChild(`
      const L = await import(${JSON.stringify(LEDGER_MOD)});
      const s = L.readState(${JSON.stringify(p)});
      console.log(JSON.stringify({ keys: Object.keys(s.alertState), hb: s.lastHeartbeat, send: L.shouldSendAlert(s, 'platform_down') }));
    `);
    expect(r.status, r.stderr).toBe(0);
    const o = JSON.parse(r.stdout.trim());
    expect(o.keys).toEqual([]);
    expect(o.hb).toBeNull();
    expect(o.send).toBe(true);
  }, 60_000);
});
