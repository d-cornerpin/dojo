// ════════════════════════════════════════════════════════════════════════════════════
// t114 (CENSUS U14) — A SLOW BOX IS NOT UN-UPDATABLE.
//
// THE DEFECT, and it is the one that cuts against the owner's update-integrity standard (a
// release gate, not a preference): `curl` on a ~200 MB release zip and `npm install --omit=dev`
// were each given a FLAT 120-second total, handed to `exec`'s own `timeout` option, which SIGTERMs
// the child at that mark whatever it is doing.
//
//   * On a slow home line the download cannot finish inside two minutes, so every attempt dies at
//     the same wall and the box becomes PERMANENTLY un-updatable. "Updates never fail" is the
//     standing ruling; this made failure the ordinary outcome for exactly the boxes least able to
//     recover.
//   * The `npm install` wall is worse, because that leg runs AFTER the new tree has been rsynced
//     over `PLATFORM_DIR`. A kill there leaves new files with half-written dependencies — a
//     platform whose `node_modules` does not match its `package.json` — and the error it threw
//     said nothing at all about the state it left behind.
//
// Neither case is distinguishable from a wedge by a clock alone, because both produce output the
// whole way through: curl writes its progress meter, npm writes its phases.
//
// WHAT IS UNDER TEST. The bound is `attachIdleBound` (`child-idle-bound.ts`), shared with the exec
// door and the installers, so it is driven here with REAL child processes at second scale — the
// mechanism is the fact, and a mocked child would prove nothing about SIGTERM or stream timing.
// The route's own wiring is read as source shape, because standing up a real update would mean
// downloading a release.
//
//   §1 healthy-but-slow work driven through the window SURVIVES (both shapes: steady output, and
//      output on stderr only, which is where curl's progress meter actually goes)
//   §2 dead work driven in is STILL killed, and the reason names SILENCE rather than a work budget
//   §3 the ceiling still exists, so the re-arm is not an unbounded renewal
//   §4 the route is wired to it, and the install failure is now legible
// ════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachIdleBound, CHILD_MAX_BUFFER_BYTES, type ChildRunFailure } from '../child-idle-bound.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function stripped(rel: string): string {
  const raw = fs.readFileSync(path.join(SRC, rel), 'utf8');
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n');
}

/** Run a shell script under the idle bound, the way the updater's `execIdleBounded` does. */
function runBounded(script: string, idleMs: number, ceilingMs = 60_000) {
  return attachIdleBound(spawn('/bin/sh', ['-c', script]), { idleMs, ceilingMs });
}

describe('§1 a slow-but-talking transfer survives its window', () => {
  it('THE RED: a 3-second job under a 1-second idle bound completes — the download is not killed', async () => {
    // Six chunks half a second apart: TOTAL ~3s against a 1,000ms bound. This is the download's
    // shape in miniature — every gap is well inside the bound, the total is multiples of it. The
    // flat clock killed exactly this.
    const { stdout } = await runBounded(
      'for i in 1 2 3 4 5 6; do echo "received chunk $i"; sleep 0.5; done',
      1_000,
    );

    expect(stdout, 'the transfer ran to completion').toContain('received chunk 6');
    expect(stdout, 'and nothing it reported on the way was lost').toContain('received chunk 1');
  }, 20_000);

  it('progress on STDERR keeps it alive — which is where curl\'s progress meter goes', async () => {
    // Load-bearing: curl writes its meter to stderr, so a bound that only watched stdout would
    // have killed every download regardless.
    const { stderr } = await runBounded(
      'for i in 1 2 3; do echo "  12.3%" 1>&2; sleep 0.5; done; echo done',
      800,
    );

    expect(stderr, 'stderr writes re-arm the bound exactly as stdout writes do').toContain('12.3%');
  }, 20_000);

  it('an `npm install`-shaped run that prints phases slowly is not killed', async () => {
    const { stdout } = await runBounded(
      'echo "added 1 package"; sleep 0.6; echo "added 40 packages"; sleep 0.6; echo "found 0 vulnerabilities"',
      1_000,
    );

    expect(stdout).toContain('found 0 vulnerabilities');
  }, 20_000);
});

describe('§2 a genuinely stuck leg is still killed, and says why', () => {
  it('THE OTHER DIRECTION: no output for longer than the bound is still a SIGTERM', async () => {
    const err = await runBounded('sleep 5', 700).catch((e: ChildRunFailure) => e);

    expect((err as ChildRunFailure).killed, 'a leg that proves nothing is still ended').toBe(true);
    expect((err as ChildRunFailure).signal).toBe('SIGTERM');
  }, 20_000);

  it('the reason names SILENCE, not a work budget the command never had', async () => {
    const err = await runBounded('sleep 5', 700).catch((e: ChildRunFailure) => e);

    expect((err as ChildRunFailure).message, 'what was measured was the absence of output')
      .toMatch(/no output for/i);
  }, 20_000);

  it('a leg that goes quiet AFTER talking still dies on the gap, keeping what it printed', async () => {
    // Proves the re-arm buys one more window and never immunity — the npm-install-wedges-halfway
    // case, which must still be caught or the tree is left mismatched with nobody told.
    const err = await runBounded('echo "added 1 package"; sleep 5', 700)
      .catch((e: ChildRunFailure) => e);

    expect((err as ChildRunFailure).stdout, 'the partial output is preserved for the log')
      .toContain('added 1 package');
    expect((err as ChildRunFailure).message).toMatch(/no output for/i);
  }, 20_000);
});

describe('§3 the bounds are still bounds', () => {
  it('CONTROL: the ceiling does NOT re-arm — a chatty runaway is still stopped', async () => {
    // The trap the stream watchdog's own header refuses: if every chunk bought unlimited further
    // time, a process printing for ever would never be cut. Output every 50ms, ceiling 600ms.
    const err = await runBounded(
      'while true; do echo tick; sleep 0.05; done',
      10_000,   // idle bound it never trips, because it keeps talking
      600,      // the ceiling is what must end it
    ).catch((e: ChildRunFailure) => e);

    expect((err as ChildRunFailure).killed, 'a permanently chatty process is still bounded').toBe(true);
    expect((err as ChildRunFailure).message, 'and the reason distinguishes the ceiling from silence')
      .toMatch(/ceiling/i);
  }, 20_000);

  it('CONTROL: an ordinary failure still reports its exit code, not a timeout', async () => {
    const err = await runBounded('echo nope 1>&2; exit 3', 3_000).catch((e: ChildRunFailure) => e);

    expect((err as ChildRunFailure).code, 'a non-zero exit is unchanged').toBe(3);
    expect((err as ChildRunFailure).killed, 'and it is not reported as a kill').toBeUndefined();
  }, 20_000);

  it('CONTROL: the output buffer is still capped', () => {
    expect(CHILD_MAX_BUFFER_BYTES, 'the 1MB maxBuffer the buffered primitive had is carried')
      .toBe(1024 * 1024);
  });
});

describe('§4 the updater is wired to it, and the install failure is legible', () => {
  it('THE RED: neither the download nor the install carries a flat 120s total any more', () => {
    const src = stripped('gateway/routes/update.ts');

    expect(
      /execAsync\(`curl[^`]*`, \{ timeout: 120000 \}\)/.test(src),
      'the flat download wall is the defect',
    ).toBe(false);
    expect(
      /execAsync\('npm install --omit=dev', \{ cwd: PLATFORM_DIR, timeout: 120000, env \}\)/.test(src),
      'the flat install wall is the worse half of it',
    ).toBe(false);
    expect(/execIdleBounded\(|spawnIdleBounded\(/.test(src), 'both legs run under the idle bound').toBe(true);
  });

  it('curl is given its OWN stall detector, which is a measured fact about the transfer', () => {
    const src = stripped('gateway/routes/update.ts');

    // `--speed-time`/`--speed-limit` aborts only when the transfer sits below a floor for a whole
    // window — curl measuring its own liveness, rather than us guessing how long a file should
    // take. `--connect-timeout` bounds the one phase that has no bytes to measure.
    // Review minor 3: the download is ARGV now, not a shell string, so the flags are array
    // elements. The property is unchanged — curl is given its own stall detector — and the shape
    // is strictly better: a release URL is data handed to `execve`, never text in a `/bin/sh -c`
    // command line.
    expect(/'--speed-limit', '\d+', '--speed-time', '\d+'/.test(src)).toBe(true);
    expect(/'--connect-timeout', '\d+'/.test(src)).toBe(true);
    expect(/spawnIdleBounded\('curl', curlDownloadArgv\(/.test(src), 'and no shell is involved').toBe(true);
  });

  it('an install that fails after the rsync says so, and names the backup to restore', () => {
    const raw = fs.readFileSync(path.join(SRC, 'gateway/routes/update.ts'), 'utf8');

    // The old error said nothing about the state it left behind, which is what made this a
    // silent integrity failure rather than a loud one.
    expect(raw, 'it states the tree was already swapped').toContain('Update halted after the files were swapped');
    expect(raw, 'and that the dependency tree is the part that is wrong').toContain('node_modules is');
    expect(raw, 'it says the tree must not be booted as-is').toMatch(/must not be booted as-is/);
    expect(raw, 'and it names the intact previous version').toMatch(/previous version is intact at/);
  });

  it('CONTROL: both apply paths got the treatment, not just the first', () => {
    const src = stripped('gateway/routes/update.ts');
    // The route has two download->swap->install sequences (apply and reinstall/rollback). Fixing
    // one and leaving the other is the shape that made this defect survive its own review.
    const installs = src.match(/execIdleBounded\('npm install --omit=dev'/g) ?? [];
    expect(installs.length, 'both install legs are bounded').toBe(2);
    const downloads = src.match(/spawnIdleBounded\('curl', curlDownloadArgv\(/g) ?? [];
    expect(downloads.length, 'both download legs are bounded').toBe(2);
  });
});
