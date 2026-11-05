// ════════════════════════════════════════════════════════════════════════════════════════
// Rulings audit #14 (P1-l, M14, OR-LONG-JOBS). The owner: "I don't want to put hard limits on the dojo." / "the main
// agent owns the Mac they live in and the dojo doesn't limit them." / on a slow agent: "Can we make that a per agent
// setting? That way a user can give an agent they know is slow a longer silent window?"
// The exec/shell door killed a command after 30 s (default) or at most 120 s of no output, and after one hour in total.
// A big `cp`, a quiet build step or a long silent job was killed. Now: the silence a command may keep is the agent's
// own silent window (`agents.silent_window_minutes`, default two hours, the owner's per-agent setting), an agent's own
// explicit `timeout` is its own choice and is not clamped, and there is no total-life cap on the agent's command.
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, vi } from 'vitest';

const silent = vi.hoisted(() => ({ ms: 2 * 60 * 60 * 1000 }));
vi.mock('../../../tracker/silent-window.js', () => ({ silentWindowMs: () => silent.ms }));

import * as run from '../process-run.js';
import { processTimeout } from '../process-run.js';

describe('a quiet command is not killed by a Dojo clock', () => {
  it('with no timeout asked, the silence it may keep is the agent\'s silent window (default two hours)', () => {
    expect(processTimeout(undefined, 'agent-a')).toBe(2 * 60 * 60 * 1000);
  });

  it('a slower agent the owner gave a longer window keeps that window', () => {
    silent.ms = 6 * 60 * 60 * 1000;
    expect(processTimeout(undefined, 'agent-slow')).toBe(6 * 60 * 60 * 1000);
    silent.ms = 2 * 60 * 60 * 1000;
  });

  it('an agent\'s own explicit timeout is its own choice, short or long, never clamped to two minutes', () => {
    expect(processTimeout(5_000, 'agent-a')).toBe(5_000);
    expect(processTimeout(3 * 60 * 60 * 1000, 'agent-a')).toBe(3 * 60 * 60 * 1000);
  });

  it('there is no two-minute maximum and no one-hour total cap left on the agent\'s door', () => {
    expect((run as Record<string, unknown>).EXEC_TIMEOUT_MAX_MS).toBeUndefined();
    expect((run as Record<string, unknown>).EXEC_ABSOLUTE_CEILING_MS).toBeUndefined();
  });
});
