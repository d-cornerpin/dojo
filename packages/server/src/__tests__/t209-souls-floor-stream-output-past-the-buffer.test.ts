// t209 (t200 hand-up) — a command whose output passes the old 1 MiB buffer is NOT killed. Its
// whole output is kept and handed on (the result store keeps it whole). The only bound left is a
// memory-safety ceiling on what is HELD; past it the pipe is still drained, the command still
// finishes, and the result says plainly how much was not kept.

import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { attachIdleBound } from '../child-idle-bound.js';

const run = (script: string, extra: { keepCeilingChars?: number } = {}) =>
  attachIdleBound(spawn('/bin/sh', ['-c', script]), { idleMs: 20_000, ceilingMs: 60_000, ...extra });

describe('output past 1 MiB streams through instead of killing the command', () => {
  it('THE RED: 3 MiB of stdout and a clean exit return all 3 MiB', async () => {
    const { stdout } = await run('head -c 3145728 /dev/zero | tr "\\0" "a"');
    expect(stdout.length).toBe(3 * 1024 * 1024);
  }, 30_000);

  it('stdout and stderr both survive, and the command keeps running after 1 MiB (it finishes its last line)', async () => {
    const { stdout, stderr } = await run('head -c 2000000 /dev/zero | tr "\\0" "b"; echo; echo done-after-the-megabyte; echo oops 1>&2');
    expect(stdout.length).toBeGreaterThan(2_000_000);
    expect(stdout).toContain('done-after-the-megabyte');
    expect(stderr).toContain('oops');
  }, 30_000);

  it('the memory ceiling keeps the command alive, drains the pipe, and says how much was not kept', async () => {
    const { stdout } = await run('head -c 500000 /dev/zero | tr "\\0" "c"; echo tail-line', { keepCeilingChars: 100_000 });
    expect(stdout.startsWith('c'.repeat(1000))).toBe(true);
    expect(stdout.length).toBeLessThan(110_000);
    expect(stdout).toMatch(/not kept/);
  }, 30_000);
});
