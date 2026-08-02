// ════════════════════════════════════════════════════════════════════════════
// RULING P5-R3 (orchestrator, 2026-08-02) — THE APPROVAL SEAM MOVES WITH THE
// SHAPE, IN THE SAME TASK, AND A FAILING TEST LANDS FIRST.
//
// `destructive-gate.ts` carries two couplings to exec's ARGUMENT SHAPE, and its
// own comment declares one of them *"the EXACT call executeTool makes"*:
//
//   1. `isDestructiveCall('exec', args)` reads `String(args.command ?? '')` and
//      matches it against DESTRUCTIVE_EXEC_RE. Under `{argv}` that string is
//      EMPTY, the regex does not match, and **the destructive-approval gate
//      silently stops holding `rm` for approval.** A sub-agent would delete
//      without the primary ever being asked. That is the bigger of the two.
//   2. `manifestPermitsDestructiveCall` calls
//      `checkPermission(agentId,{type:'exec',command:String(args.command ?? '')})`.
//      Under `{argv}` it would authorize the EMPTY STRING — an approval seam
//      evaluating a command nobody typed.
//
// "Exact-call approvals — extend, never regress" is this plan's preserve-verbatim
// constraint (PHASE-5.md Global Constraints, migrations 117/118). This file is
// the extension. It is RED at the HEAD that still speaks `{command}`, by design.
//
// THE THREE THINGS IT LOCKS:
//   · the classifier reads BOTH doors' real shapes (`exec.argv`, `shell.script`)
//     and keeps answering for the legacy `{command}` shape while it exists;
//   · the manifest pre-check binds the EXACT call — same resolution, same
//     broker, same grant as the dispatcher's own gate row;
//   · a SHAPE-MISMATCHED call is REFUSED, never authorized as empty.
// ════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projects = '/tmp/p5-r3-projects';

// `agent-rm` may rm; `agent-norm` may not. That difference is what makes the
// pre-check a real question rather than a formality.
const rmManifest = JSON.stringify({
  file_read: '*', file_write: '*', file_delete: 'none',
  exec_allow: ['rm', 'ls', 'git *'], exec_deny: [], network_domains: 'none',
  max_processes: 3, can_spawn_agents: false, can_assign_permissions: false, system_control: [],
});
const noRmManifest = JSON.stringify({
  file_read: '*', file_write: '*', file_delete: 'none',
  exec_allow: ['ls', 'git *'], exec_deny: [], network_domains: 'none',
  max_processes: 3, can_spawn_agents: false, can_assign_permissions: false, system_control: [],
});

const agentRows: Record<string, { id: string; permissions: string; spawn_depth: number; created_by: string }> = {
  'agent-rm': { id: 'agent-rm', permissions: rmManifest, spawn_depth: 1, created_by: 'agent-parent' },
  'agent-norm': { id: 'agent-norm', permissions: noRmManifest, spawn_depth: 1, created_by: 'agent-parent' },
};

vi.mock('../../db/connection.js', () => ({
  getDb: () => ({
    prepare: (sql: string) => ({
      run: () => ({ changes: 0 }),
      get: (...params: unknown[]) => {
        if (/FROM agents/i.test(sql)) return agentRows[String(params[0])];
        return undefined;
      },
      all: () => [],
    }),
    exec: () => ({}),
    transaction: (fn: (...a: unknown[]) => unknown) => (...a: unknown[]) => fn(...a),
  }),
}));

vi.mock('../../config/platform.js', async () => {
  const actual = await vi.importActual<typeof import('../../config/platform.js')>('../../config/platform.js');
  return { ...actual, isPrimaryAgent: () => false, isHealerAgent: () => false, isTrainerAgent: () => false, getPrimaryAgentId: () => 'agent-primary', getPrimaryAgentName: () => 'Primary' };
});

import { isDestructiveCall, manifestPermitsDestructiveCall } from '../destructive-gate.js';

// ══════════════════════════════════════════════════════════════════════════
describe('P5-R3 §1 — the destructive CLASSIFIER reads both doors\' real shapes', () => {
  it('classifies a destructive `exec({argv})` call — the shape the rebuild introduces', () => {
    expect(isDestructiveCall('exec', { argv: ['rm', '-rf', '/tmp/build-1234'] })).toBe('destructive shell command');
    expect(isDestructiveCall('exec', { argv: ['rm', '-f', `${projects}/x`] })).toBe('destructive shell command');
    expect(isDestructiveCall('exec', { argv: ['dd', 'if=/dev/zero', 'of=/tmp/x'] })).toBe('destructive shell command');
    expect(isDestructiveCall('exec', { argv: ['git', 'reset', '--hard', 'HEAD~3'] })).toBe('destructive shell command');
    expect(isDestructiveCall('exec', { argv: ['git', 'push', '--force', 'origin', 'main'] })).toBe('destructive shell command');
  });

  it('classifies a destructive `shell({script})` call — the second door', () => {
    expect(isDestructiveCall('shell', { script: 'rm -rf /tmp/build-1234' })).toBe('destructive shell command');
    expect(isDestructiveCall('shell', { script: 'for f in a b; do rm -f $f; done' })).toBe('destructive shell command');
  });

  it('does NOT classify ordinary work at either door', () => {
    expect(isDestructiveCall('exec', { argv: ['ls', '-la', '/tmp'] })).toBeNull();
    expect(isDestructiveCall('exec', { argv: ['echo', 'performance'] })).toBeNull();
    expect(isDestructiveCall('exec', { argv: ['npm', 'run', 'format'] })).toBeNull();
    expect(isDestructiveCall('shell', { script: 'ls -la | wc -l' })).toBeNull();
  });

  it('a destructive word in an ARGUMENT is still caught (argv joins for the scan)', () => {
    // `git clean -fd` is destructive whether the model spells it as one string
    // or as five array elements; the classifier must not become spelling-sensitive.
    expect(isDestructiveCall('exec', { argv: ['git', 'clean', '-fd'] })).toBe('destructive shell command');
  });

  it('the legacy `{command}` shape keeps answering for as long as anything sends it', () => {
    // Nothing in the tree should send it after this task, but the classifier
    // costs nothing to keep honest and a silent null here is the incident class.
    expect(isDestructiveCall('exec', { command: 'rm -rf /tmp/x' })).toBe('destructive shell command');
  });

  it('a MALFORMED exec call is not silently non-destructive', () => {
    // No argv, no command: the gate must not conclude "harmless". It is the
    // empty-string read that P5-R3 names, seen from the classifier's side.
    expect(isDestructiveCall('exec', {})).toBe('destructive shell command');
    expect(isDestructiveCall('exec', { argv: 'rm -rf /tmp/x' })).toBe('destructive shell command');
  });
});

// ══════════════════════════════════════════════════════════════════════════
describe('P5-R3 §2 — the manifest pre-check binds the EXACT call, and never an empty one', () => {
  it('answers the real argv for an agent that MAY rm', () => {
    expect(manifestPermitsDestructiveCall('agent-rm', 'exec', { argv: ['rm', '-f', '/tmp/x'] })).toBe(true);
  });

  it('answers the real argv for an agent that may NOT rm — the pre-check still discriminates', () => {
    // This is the clause the empty string destroys: `checkPermission(…,{command:''})`
    // answers about nothing, so both agents would look identical.
    expect(manifestPermitsDestructiveCall('agent-norm', 'exec', { argv: ['rm', '-f', '/tmp/x'] })).toBe(false);
  });

  it('answers the real script at the shell door, both ways', () => {
    expect(manifestPermitsDestructiveCall('agent-rm', 'shell', { script: 'rm -f /tmp/x' })).toBe(true);
    expect(manifestPermitsDestructiveCall('agent-norm', 'shell', { script: 'rm -f /tmp/x' })).toBe(false);
  });

  it('REFUSES a shape-mismatched call rather than authorizing an empty command', () => {
    for (const args of [{}, { command: 'rm -f /tmp/x' }, { argv: 'rm -f /tmp/x' }, { argv: [] }, { argv: [1, 2] }]) {
      expect(
        manifestPermitsDestructiveCall('agent-rm', 'exec', args as Record<string, unknown>),
        `expected REFUSAL for exec args ${JSON.stringify(args)}`,
      ).toBe(false);
    }
    for (const args of [{}, { script: '' }, { script: 42 }]) {
      expect(
        manifestPermitsDestructiveCall('agent-rm', 'shell', args as Record<string, unknown>),
        `expected REFUSAL for shell args ${JSON.stringify(args)}`,
      ).toBe(false);
    }
  });

  it('a global deny is refused at the seam for every agent, so no unsatisfiable approval is ever filed', () => {
    expect(manifestPermitsDestructiveCall('agent-rm', 'exec', { argv: ['rm', '-rf', '/'] })).toBe(false);
    expect(manifestPermitsDestructiveCall('agent-rm', 'shell', { script: 'rm -rf /' })).toBe(false);
  });

  it('non-exec destructive kinds still hold exactly as before (FA-P4)', () => {
    expect(manifestPermitsDestructiveCall('agent-norm', 'file_delete', { path: '/tmp/x' })).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// §3 — "the EXACT call executeTool makes" is held by ONE function, proven by
// reading both files. A behavioural equivalence test would pass the day the two
// drifted onto two implementations that happened to agree; this cannot.
describe('P5-R3 §3 — one owner for the seam, not two implementations that agree today', () => {
  const read = (rel: string): string => {
    const srcRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    return fs.readFileSync(path.join(srcRoot, rel), 'utf8');
  };

  it('the approval pre-check answers from the shared exec seam module', () => {
    const gate = read('agent/destructive-gate.ts');
    expect(gate).toMatch(/from '\.\/brokers\/exec-seam\.js'/);
    expect(gate).toMatch(/authorizeExecShaped/);
    // and it must NOT have kept the old empty-string read
    expect(gate).not.toMatch(/type:\s*'exec',\s*command:\s*String\(args\.command/);
  });

  it('the dispatcher\'s own gate row answers from the SAME module', () => {
    const gateEval = read('agent/tools/gate-eval.ts');
    expect(gateEval).toMatch(/authorizeExecShapedCall/);
    // One owner: the wrapper the approval gate calls must delegate to the very
    // function the dispatcher calls, in the same file, not re-implement it.
    const seam = read('agent/brokers/exec-seam.ts');
    const wrapper = seam.slice(seam.indexOf('export function authorizeExecShapedArgs'));
    expect(wrapper).toMatch(/authorizeExecShapedCall\(/);
  });

  it('the seam REFUSES an unresolvable shape rather than defaulting — behaviourally', async () => {
    const { authorizeExecShapedCall } = await import('../brokers/exec-seam.js');
    const { grantForManifest } = await import('../brokers/grants.js');
    const grant = grantForManifest('agent-rm', JSON.parse(rmManifest));
    for (const bad of [undefined, null, 'rm -rf /tmp/x', [], [1, 2], {}]) {
      expect(authorizeExecShapedCall(grant, 'proc', bad).allowed, `proc/${JSON.stringify(bad)}`).toBe(false);
    }
    for (const bad of [undefined, null, '', 42, ['ls']]) {
      expect(authorizeExecShapedCall(grant, 'shell', bad).allowed, `shell/${JSON.stringify(bad)}`).toBe(false);
    }
  });
});
