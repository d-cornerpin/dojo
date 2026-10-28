// A system prompt section whose `when` or `render` throws is contained (skipped)
// by assembleSystemFromRegistry — right, one bad entry must not fail the turn.
// But on v35 it vanished with NO log line anywhere: the only symptom was an
// agent that looked like it had lost an instruction, with nothing in the log to
// explain it. This pins the missing half: the surviving sections assemble
// byte-identically to before, and the first failure of a given entry id says so
// once per process — a section that fails every turn logs once, not per turn.

import { describe, it, expect, beforeAll, vi } from 'vitest';

const warn = vi.hoisted(() => vi.fn());
vi.mock('../../../logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn, error: vi.fn() }),
}));

// assembler.ts imports a heavy graph (db, platform, capabilities, router, the
// legacy assembler, the engine-message channel, and the real entries via a
// side-effect import). Mock every runtime name it imports — this test only
// needs the walker + the real registry.
vi.mock('../entries.js', () => ({}));
vi.mock('../../../db/connection.js', () => ({ getDb: vi.fn() }));
vi.mock('../../../config/platform.js', () => ({
  isPrimaryAgent: vi.fn(),
  isPMAgent: vi.fn(),
  getOwnerName: vi.fn(),
}));
vi.mock('../../../services/capabilities.js', () => ({ getModelCapabilities: vi.fn() }));
vi.mock('../../../router/router-window.js', () => ({ agentTurnWindow: vi.fn() }));
vi.mock('../../assembler.js', () => ({
  resolveInboundContext: vi.fn(),
  resolveTtsEngine: vi.fn(),
}));
vi.mock('../../../agent/v2/engine-message.js', () => ({ pushEngineMessage: vi.fn() }));

import { assembleSystemFromRegistry, type RegistrySystemResult } from '../assembler.js';
import { register, __resetRegistryForTests } from '../registry.js';
import { SystemSlot } from '../types.js';

let first: RegistrySystemResult;
let second: RegistrySystemResult;

beforeAll(() => {
  __resetRegistryForTests();
  register({
    id: 't.boom',
    target: 'system',
    slot: SystemSlot.Identity,
    reason: 'test entry whose render throws',
    render: () => {
      throw new Error('boom text');
    },
  });
  register({
    id: 't.when-boom',
    target: 'system',
    slot: SystemSlot.Tools,
    reason: 'test entry whose when throws',
    when: () => {
      throw new Error('when text');
    },
    render: () => 'NEVER-RENDERED',
  });
  register({
    id: 't.ok',
    target: 'system',
    slot: SystemSlot.UserProfile,
    reason: 'test entry that renders fine',
    render: () => 'OK-SECTION',
  });
  // Two turns' worth of assembly: the failures repeat, the warning must not.
  first = assembleSystemFromRegistry({} as never);
  second = assembleSystemFromRegistry({} as never);
});

describe('assembleSystemFromRegistry — a failed section is contained and said', () => {
  it('the surviving sections assemble exactly as before', () => {
    expect(first.text).toBe('OK-SECTION');
    expect(first.entryIds).toEqual(['t.ok']);
    expect(second.text).toBe('OK-SECTION');
    expect(second.entryIds).toEqual(['t.ok']);
  });

  it('warns once per failing entry id, not once per turn', () => {
    const boom = warn.mock.calls.filter(([, meta]) => (meta as { entryId?: string })?.entryId === 't.boom');
    const whenBoom = warn.mock.calls.filter(([, meta]) => (meta as { entryId?: string })?.entryId === 't.when-boom');
    expect(boom).toHaveLength(1);
    expect(boom[0][0]).toBe('a system prompt section failed to render and was left out of the prompt');
    expect(boom[0][1]).toEqual({ entryId: 't.boom', error: 'boom text' });
    expect(whenBoom).toHaveLength(1);
    expect(whenBoom[0][1]).toEqual({ entryId: 't.when-boom', error: 'when text' });
    // Nothing else warned — the healthy entry stays silent.
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
