// ════════════════════════════════════════
// Serve + drive boundary conformance (lanes & lineage P2, 2026-07-21)
//
// The owner invariant, both directions:
//   serve boundary: "see if it is done": no queued engine event becomes a
//     turn without a premise re-check; work retires its drivers at close.
//   drive boundary: "IN PROGRESS is never ignored": no hidden flag can stand
//     the poke ladder down; statuses are promises the engine enforces.
//
// Source-scan door-locks, same style as two-key-conformance. These pin the
// WIRING (the choke-point calls exist and target the right shapes); behavior
// is verified by the behavioral scenarios trigger-retires-when-work-done and
// stranded-inprogress-redriven.
// ════════════════════════════════════════
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8');

describe('serve boundary (P2)', () => {
  it('getPendingEngineEvent premise-checks before eligibility', () => {
    const cp = read('agent/v2/counterparty.ts');
    const fn = cp.slice(cp.indexOf('export function getPendingEngineEvent'));
    expect(fn.slice(0, 1500)).toMatch(/retireSpentEngineEvents\(agentId\)/);
    // The retire pass runs at THE choke point every consumer funnels through;
    // no second pending-event reader may exist.
    expect(cp.match(/DELIVERABLE_ENGINE_EVENT_WHERE/g)!.length).toBeGreaterThanOrEqual(3);
  });

  it('the retire helpers target BOTH stores and never touch claimed rows', () => {
    const cp = read('agent/v2/counterparty.ts');
    for (const fname of ['retireEngineEventsForRun', 'retireEngineEventsForTask']) {
      const fn = cp.slice(cp.indexOf(`export function ${fname}`));
      const body = fn.slice(0, 1200);
      expect(body, `${fname} must iterate both message stores`).toMatch(/'messages',\s*'inter_agent_messages'/);
      expect(body, `${fname} must not yank a live turn's trigger`).toMatch(/conv_key IS NULL AND swept_at IS NULL/);
    }
  });

  it('run close claims its trigger by key; terminal tasks retire their events by key', () => {
    const runner = read('scheduler/runner.ts');
    expect(runner).toMatch(/retireEngineEventsForRun\(runId\)/);
    const notify = read('tracker/notify.ts');
    const fn = notify.slice(notify.indexOf('export function claimAssignmentNoticeForTerminalTask'));
    expect(fn.slice(0, 1500)).toMatch(/retireEngineEventsForTask\(taskId/);
  });

  it('the spent-premise definitions read LIVE referent state', () => {
    const cp = read('agent/v2/counterparty.ts');
    const fn = cp.slice(cp.indexOf('export function retireSpentEngineEvents'));
    const body = fn.slice(0, 3000);
    expect(body).toMatch(/SELECT status FROM task_runs WHERE id = \?/);
    expect(body).toMatch(/SELECT status, is_paused FROM tasks WHERE id = \?/);
  });
});

describe('drive boundary (P2)', () => {
  it('no stand-down machinery survives: the ladder always drives in_progress work', () => {
    const pm = read('tracker/pm-agent.ts');
    // The deliverable_shown redirect (validate_deliverable pokes that stood
    // the ladder down) is demolished; only comments may reference the name.
    const code = pm.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
    expect(code).not.toMatch(/validate_deliverable/);
    expect(code).not.toMatch(/deliverable_shown\s*===?\s*1/);
  });

  it('pokes never fire mid-turn (working-skip), replacing the restart-counter-prompt class', () => {
    const pm = read('tracker/pm-agent.ts');
    expect(pm).toMatch(/assigneeStatus === 'working'\) continue;/);
    expect(pm).not.toMatch(/continue from EXACTLY where you stopped/i);
  });

  it('the stale-trigger prose confessions are gone (the engine enforces what they begged for)', () => {
    const tools = read('tracker/tools.ts');
    expect(tools).not.toMatch(/STALE trigger/);
    expect(tools).not.toMatch(/Skip it silently/);
    const runner = read('scheduler/runner.ts');
    expect(runner).not.toMatch(/Execute this task ONCE for this run only/);
  });
});
