// ════════════════════════════════════════════════════════════════════════════════════
// t114 (CENSUS U2) — THE EXEC CLOCK BOUNDS SILENCE, NOT WORK.
//
// `processTimeout` capped every exec/shell call at `EXEC_TIMEOUT_MAX_MS = 120000` —
// `Math.min(coerced ?? 30s, 120s)` — and handed that number to `execFile`'s own `timeout`
// option, which SIGTERMs the child at that wall-clock mark whatever it is doing. The agent could
// not opt out: asking for more was silently clamped back down. `shell({script:"npm install"})`, a
// `pytest` suite, a `docker build`, a large `git clone` all routinely run past two minutes while
// healthily producing output, and all were killed mid-stride. The census called it the
// highest-frequency flat kill in the tree by raw call count.
//
// It also named why nobody could have fixed it with a bigger number: the door used the BUFFERED
// `execFileAuthorized`, so there was structurally no per-chunk signal that could extend a clock.
// Pinned by a test? Only `agent/v2/__tests__/errors.test.ts:39`, which pins the error STRING
// ('tool timed out after 30s') — the reporting, not the bound. Unregistered in the census.
//
// THE BACKWARDS LIFECYCLE, both directions, at second scale with real processes:
//
//   §1 HEALTHY WORK DRIVEN THROUGH THE WINDOW SURVIVES. A command that runs for several times its
//      idle bound while printing steadily — exactly a build's shape — completes, and every line
//      it printed comes back. This is the clause the defect fails.
//
//   §2 DEAD WORK IS STILL KILLED, LOUDLY AND HONESTLY. A command that produces nothing for longer
//      than the bound is still SIGTERMed, and the reason now says SILENCE is what ended it rather
//      than implying the command was given that much work time.
//
//   §3 CONTROLS: the absolute ceiling still exists so the idle bound is not an unbounded
//      renewal, a failing command still reports its exit code, and the cap still clamps — what
//      the cap now bounds is how much silence may be tolerated, which cannot kill healthy work.
// ════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, afterEach } from 'vitest';

// Real child processes are spawned here, so the capability facade has to answer rather than
// refuse. Nothing about the capability is under test in this file — the facade's own contract
// suite owns that — so it is answered at its narrowest: the authorization check becomes a no-op
// and the genuine `spawn` runs underneath it.
vi.mock('../../effects/capability.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  requireAuthorized: () => undefined,
}));

import {
  runProcess, processTimeout, EXEC_TIMEOUT_MAX_MS, EXEC_ABSOLUTE_CEILING_MS,
} from '../process-run.js';
import { attachIdleBound, type WatchableChild } from '../../../child-idle-bound.js';

const audits: Array<{ target: string; status: string; detail: string }> = [];
const audit = (target: string, status: string, detail: string): void => {
  audits.push({ target, status, detail });
};

// ── t127 — THE SURVIVAL CLAIM MOVES OFF THE WALL CLOCK ──
//
// §1 BET AND LOST, on a full-suite merge gate: a real child sleeping 0.5s six times against a
// 1,000ms idle bound — a ratio of two. The suite has grown ~600 tests since this file was written,
// and a descheduled child's `sleep 0.5` stretches past 1,000ms under contention, so the bound
// fired and the clause redded while the product was correct. My own t121 sweep flagged this exact
// file as "the same bet at 3x margin"; the margin was 2x and 1.6x, and it came due.
//
// A real child against a fixed wall-clock bound is an IRREDUCIBLE bet: the bound is real time, the
// child's scheduling is not under the test's control, and no margin fixes that — it only moves the
// odds, which is what this campaign refuses to do in the product and should refuse here.
//
// So the two claims are separated and each is proven where it can be proven exactly:
//
//   THE MECHANISM — "ticks inside the bound keep it alive, for a total far beyond the bound" — is
//   driven against `attachIdleBound` with a STUB CHILD and FAKE TIMERS. `WatchableChild` is a
//   structural type precisely because this module watches a child rather than creating one, so a
//   stub is not a workaround; it is the seam. The test owns the clock, so the total can be twenty
//   times the bound with zero wall-clock risk.
//
//   THE INTEGRATION — "the real door really spawns, streams and collects every chunk" — stays on a
//   real child, with the ticks driven BY THE TEST over stdin so the gap is causal (the next tick is
//   written when the previous echo is observed) instead of a sleep racing the bound.
//
// NO MARGIN WAS RAISED. Every bound in this file is the number it was.

/** A child the test drives by hand. Shaped to `WatchableChild`, which is all the clock reads. */
function stubChild(): {
  child: WatchableChild;
  out(text: string): void;
  err(text: string): void;
  close(code: number, signal?: NodeJS.Signals): void;
  killed: () => NodeJS.Signals | null;
} {
  let outCb: ((c: Buffer | string) => void) | null = null;
  let errCb: ((c: Buffer | string) => void) | null = null;
  let closeCb: ((code: number | null, sig: NodeJS.Signals | null) => void) | null = null;
  let killedWith: NodeJS.Signals | null = null;
  const child: WatchableChild = {
    stdout: { setEncoding: () => undefined, on: (_e, cb) => { outCb = cb; return undefined; } },
    stderr: { setEncoding: () => undefined, on: (_e, cb) => { errCb = cb; return undefined; } },
    on: ((ev: string, cb: never) => {
      if (ev === 'close') closeCb = cb as never;
      return undefined;
    }) as WatchableChild['on'],
    kill: (sig) => { killedWith = sig ?? 'SIGTERM'; return undefined; },
  };
  return {
    child,
    out: (text) => outCb?.(text),
    err: (text) => errCb?.(text),
    // A real child that is SIGTERMed still emits `close`; the clock's verdict is written there.
    close: (code, signal) => closeCb?.(code, signal ?? null),
    killed: () => killedWith,
  };
}

/** Drive the real exec seam with a shell script, the way the `shell` door does. */
async function shell(script: string, idleMs: number): Promise<string> {
  return runProcess({
    auditTarget: script,
    file: '/bin/sh',
    argv: ['-c', script],
    timeout: idleMs,
    cwd: null,
    note: null,
    audit: audit as never,
  });
}

describe('§1 a command that keeps talking is not killed for taking long', () => {
  it('THE RED: twenty ticks inside a 1-second bound keep a 20-second command alive', async () => {
    // THE SUBJECT, unchanged: a gap-shaped clock survives a long command that keeps printing,
    // where the old total-duration clock could not. What changed is WHO OWNS THE CLOCK. The test
    // does, so the total can be 20x the bound instead of 3x and the proof is exact: twenty ticks
    // 800ms apart under a 1,000ms bound is twenty seconds of command, every gap inside the bound,
    // and not one wall-clock race anywhere in it.
    vi.useFakeTimers();
    const k = stubChild();
    const run = attachIdleBound(k.child, { idleMs: 1_000, ceilingMs: 60 * 60_000 });

    for (let i = 1; i <= 20; i += 1) {
      await vi.advanceTimersByTimeAsync(800);   // inside the bound, every time
      k.out(`step ${i}\n`);
    }
    expect(k.killed(), 'a command that keeps talking is never killed').toBeNull();

    k.close(0);
    const { stdout } = await run;
    expect(stdout, 'the command ran to completion').toContain('step 20');
    expect(stdout, 'and nothing it printed on the way was lost').toContain('step 1');
  });

  it('output on STDERR counts as life too — a build that logs to stderr is not silence', async () => {
    // Same treatment, and this clause's margin was the WORSE of the two: three 0.5s sleeps against
    // an 800ms bound, a ratio of 1.6. It had not been seen to red yet; it was next.
    vi.useFakeTimers();
    const k = stubChild();
    const run = attachIdleBound(k.child, { idleMs: 800, ceilingMs: 60 * 60_000 });

    for (let i = 1; i <= 12; i += 1) {
      await vi.advanceTimersByTimeAsync(600);
      k.err(`progress ${i}\n`);               // STDERR only — the stream under test
    }
    expect(k.killed(), 'stderr writes re-arm the bound exactly as stdout writes do').toBeNull();

    k.out('done\n');
    k.close(0);
    const { stdout, stderr } = await run;
    expect(stdout).toContain('done');
    expect(stderr, 'every stderr chunk was collected too').toContain('progress 12');
  });

  it('CONTROL: the stub clock really can kill — silence past the bound still SIGTERMs', async () => {
    // Without this, the two clauses above would pass just as well against a clock that never
    // fires, which is the vacuous shape this lane has been caught by three times.
    vi.useFakeTimers();
    const k = stubChild();
    const run = attachIdleBound(k.child, { idleMs: 1_000, ceilingMs: 60 * 60_000 });

    k.out('starting\n');
    await vi.advanceTimersByTimeAsync(1_500);   // past the bound, with nothing said

    expect(k.killed(), 'the bound fires on silence').toBe('SIGTERM');
    k.close(null as unknown as number, 'SIGTERM');
    const err = await run.catch((e: { message?: string }) => e);
    expect((err as { message?: string }).message, 'and names what it measured').toMatch(/no output for/i);
  });

  it('INTEGRATION: the real door spawns, streams and collects every chunk a child writes', async () => {
    // The half a stub cannot prove — that `runProcess` really spawns, really reads BOTH streams and
    // really assembles what it collects. It WAITS FOR NOTHING: the child writes several chunks to
    // both streams and exits immediately, so every gap is effectively zero and the 1,000ms bound
    // (the number it always was) is never approached. Load can make this slower; it cannot make it
    // wrong, because nothing here is racing anything.
    //
    // Measured correction: the first cut of this clause used `while read line; do …; done` on the
    // assumption that an unattached stdin means instant EOF. It does not — the door gives the
    // child a pipe, the read blocked, and the idle bound correctly killed a genuinely silent
    // command. The clause was wrong; the product was right.
    const out = await shell(
      'echo one; echo two 1>&2; echo three; exit 0',
      1_000,
    );

    expect(out, 'a real child ran and was not killed').not.toMatch(/SIGTERM|no output for/i);
    expect(out, 'stdout was collected').toContain('one');
    expect(out, 'and so was stderr, from the same real spawn').toContain('two');
    expect(out, 'every chunk, not just the first').toContain('three');
  }, 20_000);
});

// t127: the fake clock is per-case. A leaked fake timer would freeze the REAL child clauses below
// and turn them into timeouts — the opposite failure, and a confusing one.
afterEach(() => { vi.useRealTimers(); });

describe('§2 a silent command is still killed, and the reason says so', () => {
  it('THE OTHER DIRECTION: no output for longer than the bound is still a SIGTERM', async () => {
    const out = await shell('sleep 5', 700);

    expect(out, 'a command that proves nothing is still ended').toMatch(/SIGTERM/i);
  }, 20_000);

  it('the kill is HONEST: it names SILENCE, not a work budget the command never had', async () => {
    const out = await shell('sleep 5', 700);

    expect(out, 'the exit reason states what was actually measured').toMatch(/no output for/i);
    // The old wording implied the command had been granted that much RUNNING time. It had not —
    // it had been granted that much silence. A build killed at 120s was told it "timed out after
    // 120s", which is why the bound looked like a work budget to everyone who read it.
    expect(out, 'the misleading old phrasing is gone for this case').not.toMatch(/timed out after 0s/i);
  }, 20_000);

  it('a command that goes quiet AFTER talking is still killed on the gap', async () => {
    // Proves the re-arm is a gap and not a reprieve: output buys one more window, never immunity.
    const out = await shell('echo starting; sleep 5', 700);

    expect(out, 'the early output is still reported').toContain('starting');
    expect(out, 'but the silence that followed still ended it').toMatch(/no output for/i);
  }, 20_000);
});

describe('§3 controls — the bounds still exist and still bite', () => {
  it('CONTROL: a failing command still reports its exit code, not a timeout', async () => {
    const out = await shell('echo nope 1>&2; exit 3', 2_000);

    expect(out, 'an ordinary non-zero exit is unchanged').toMatch(/exit 3/);
    expect(out).not.toMatch(/no output for|SIGTERM/i);
  }, 20_000);

  it('CONTROL: a clean fast command is still just a clean fast command', async () => {
    const out = await shell('echo hello', 2_000);

    expect(out).toContain('hello');
    expect(out).not.toMatch(/SIGTERM|exit [1-9]/);
  }, 20_000);

  it('CONTROL: the absolute ceiling exists, so the idle bound is not an unbounded renewal', () => {
    // A process dribbling one byte a minute would otherwise hold the door open for ever. The
    // ceiling does not re-arm; it is the one bound on total life.
    expect(EXEC_ABSOLUTE_CEILING_MS, 'there is a bound on total life').toBeGreaterThan(0);
    expect(EXEC_ABSOLUTE_CEILING_MS, 'and it is far above any legitimate tool call')
      .toBeGreaterThan(EXEC_TIMEOUT_MAX_MS);
  });

  it('CONTROL: the cap still clamps — what it bounds is tolerated SILENCE, not work', () => {
    // The cap is kept deliberately. Once the number bounds silence rather than runtime it can no
    // longer kill healthy work, so "the agent cannot ask for more than two minutes of silence
    // tolerance" is a defensible bound rather than the defect.
    expect(processTimeout(999_999_999), 'an over-large ask is still clamped').toBe(EXEC_TIMEOUT_MAX_MS);
    expect(processTimeout(5_000), 'a reasonable ask is honoured').toBe(5_000);
  });
});
