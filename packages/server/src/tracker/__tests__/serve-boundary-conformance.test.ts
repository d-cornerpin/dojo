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

describe('once-per-response guard (P3)', () => {
  it('non-idempotent duplicates are refused at the executor choke point', () => {
    const loop = read('agent/v2/loop.ts');
    expect(loop).toMatch(/onceGuardExecuted = new Map/);
    expect(loop).toMatch(/onceGuardExecuted\.has\(loopCheck\.signature\)/);
    expect(loop).toMatch(/Already executed in this response/);
    // Both non-idempotent families are covered: fire-and-forget generation
    // and the whole people-channel send surface (sensei's canonical list).
    expect(loop).toMatch(/FIRE_AND_FORGET_GEN_TOOLS\.has\(tc\.name\) \|\| SEND_TO_PEOPLE_SET\.has\(tc\.name\)/);
  });

  it('the guard registers ONLY successful executions (a failed call may retry)', () => {
    const loop = read('agent/v2/loop.ts');
    expect(loop).toMatch(/toolResult\.isError !== true[\s\S]{0,200}onceGuardExecuted\.set/);
  });

  it('the engine-scaffold duplicate-project guard keys on ROOT equality first', () => {
    const tools = read('tracker/tools.ts');
    expect(tools).toMatch(/origin_kind = 'engine_scaffold'[\s\S]{0,80}source_message_id = \?/);
  });
});

describe('turn record (P4)', () => {
  it('every turn start records its subject and root; every exit finalizes', () => {
    const loop = read('agent/v2/loop.ts');
    expect(loop).toMatch(/recordTurnStart\(\{/);
    expect(loop).toMatch(/finalizeTurn\(agentId, turnNumber, outcome/);
    const rec = read('agent/v2/recovery.ts');
    expect(rec).toMatch(/markLatestTurnError\(agentId\)/);
  });

  it('claimed asks carry forward links (served_by_turn at every claim site, answers stamped at teardown)', () => {
    const loop = read('agent/v2/loop.ts');
    expect((loop.match(/SET served_by_turn = \?/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(loop).toMatch(/SET answer_message_id = \? WHERE agent_id = \? AND served_by_turn = \?/);
    const cp = read('agent/v2/counterparty.ts');
    expect(cp).toMatch(/conv_key = \?, served_by_turn = COALESCE/);
  });

  it('the scaffold same-turn close keys on origin_turn identity (clock window = pre-spine fallback only)', () => {
    const tools = read('tracker/tools.ts');
    expect(tools).toMatch(/task\.origin_turn !== liveTurn\) return false/);
  });
});

describe('conversations at ingest (P5)', () => {
  it('every channel producer stamps conversation_id ATOMICALLY in its INSERT', () => {
    const producers = [
      'services/imessage-bridge.ts',
      'twilio/sms-inbound.ts',
      'services/gmail-watcher.ts',
      'services/outlook-watcher.ts',
      'services/teams-watcher.ts',
      'twilio/call-session.ts',
      'gateway/routes/chat.ts',
    ];
    for (const rel of producers) {
      const src = read(rel);
      expect(src, `${rel} must resolve a conversation`).toMatch(/resolveOrCreateConversation\(/);
      expect(src, `${rel} must stamp conversation_id in the INSERT itself`).toMatch(/INTO messages[\s\S]{0,300}conversation_id/);
    }
    const ia = read('memory/interagent.ts');
    expect(ia).toMatch(/INTO inter_agent_messages[\s\S]{0,400}conversation_id/);
  });

  it('conversations rows have exactly one writer (the resolver)', () => {
    const files = ['memory/conversations.ts'];
    const resolver = read('memory/conversations.ts');
    expect(resolver).toMatch(/INSERT OR IGNORE INTO conversations/);
    // No other module may INSERT INTO conversations.
    const fs2 = require('node:fs');
    const path2 = require('node:path');
    const walk = (d: string, acc: string[] = []): string[] => {
      for (const e of fs2.readdirSync(d, { withFileTypes: true })) {
        const fp = path2.join(d, e.name);
        if (e.isDirectory()) { if (!fp.includes('__tests__')) walk(fp, acc); }
        else if (e.name.endsWith('.ts')) acc.push(fp);
      }
      return acc;
    };
    const offenders = walk(SRC).filter((f: string) =>
      !f.endsWith('memory/conversations.ts') &&
      fs2.readFileSync(f, 'utf8').includes('INTO conversations'));
    expect(offenders).toEqual([]);
  });

  it('the SMS dedup is keyed on the stored external id (prose scan = legacy fallback only)', () => {
    const sms = read('twilio/sms-inbound.ts');
    expect(sms).toMatch(/external_message_id = \? AND role = 'user'/);
  });
});



