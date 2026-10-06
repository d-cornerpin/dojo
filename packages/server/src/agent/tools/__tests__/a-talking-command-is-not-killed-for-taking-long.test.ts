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

import { describe, it, expect, vi } from 'vitest';

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

const audits: Array<{ target: string; status: string; detail: string }> = [];
const audit = (target: string, status: string, detail: string): void => {
  audits.push({ target, status, detail });
};

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
  it('THE RED: a 3-second command under a 1-second idle bound completes, with all its output', async () => {
    // Six chunks, ~0.5s apart: TOTAL ~3s against a 1,000ms bound. Every GAP is half the bound,
    // so a gap-shaped clock survives this and the old total-duration clock cannot — this is a
    // build's exact shape, printing steadily for longer than any single pause.
    const out = await shell(
      'for i in 1 2 3 4 5 6; do echo "step $i"; sleep 0.5; done',
      1_000,
    );

    expect(out, 'the command ran to completion').toContain('step 6');
    expect(out, 'and nothing it printed on the way was lost').toContain('step 1');
    expect(out, 'a completed command is not reported as stopped').not.toMatch(/SIGTERM|timed out|stopped:/i);
  }, 20_000);

  it('output on STDERR counts as life too — a build that logs to stderr is not silence', async () => {
    const out = await shell(
      'for i in 1 2 3; do echo "progress $i" 1>&2; sleep 0.5; done; echo done',
      800,
    );

    expect(out, 'stderr writes re-arm the bound exactly as stdout writes do').toContain('done');
    expect(out).not.toMatch(/SIGTERM/i);
  }, 20_000);
});

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
