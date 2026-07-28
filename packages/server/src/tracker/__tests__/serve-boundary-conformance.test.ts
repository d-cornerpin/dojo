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

  it('the retire helpers reach every home an unserved event has, and never touch claimed rows', () => {
    const cp = read('agent/v2/counterparty.ts');
    for (const fname of ['retireEngineEventsForRun', 'retireEngineEventsForTask']) {
      const fn = cp.slice(cp.indexOf(`export function ${fname}`));
      const body = fn.slice(0, 1200);
      // The requirement, unchanged since P2: a retire helper must reach EVERY home an
      // unserved engine event can live in, and must never yank a live turn's trigger.
      //
      // PHASE-1 T4 expressed the first half as `['m','ia']` — the two-table dispatch.
      // T6 folded the second table's readers away, so an engine event has exactly ONE
      // home (`messages`, lane='events') and the first half is now true BY CONSTRUCTION.
      // Asserting the old literal would keep a demolished mechanism alive; asserting
      // nothing would drop the guard. So it is re-expressed as what can still go wrong:
      // the helper retires through the SINGLE WRITER (never a hand-rolled UPDATE) and
      // never re-introduces a table name at the call site.
      expect(body, `${fname} must retire by referent through the single writer`).toMatch(/sweepByReferent\(/);
      expect(body, `${fname} must not spell a table name — the writer owns the target`)
        .not.toMatch(/\binter_agent_messages\b|\bFROM messages\b|\bUPDATE messages\b/);
    }
    const store = read('memory/message-store.ts');
    const sweep = store.slice(store.indexOf('export function sweepByReferent'));
    expect(sweep.slice(0, 600), 'sweepByReferent must not yank a live turn\'s trigger')
      .toMatch(/conv_key IS NULL AND swept_at IS NULL/);
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
    // PHASE-1 T4: same requirement, new addresses. The loop must still stamp
    // served_by_turn at every claim site and stamp the answer at teardown; both are
    // now calls into the single writer, and the statements they resolve to are
    // asserted in memory/message-store.ts so the SQL itself is still pinned
    // somewhere. Three claim sites: the human trigger, the engine event, the
    // terminal A2A wake.
    const loop = read('agent/v2/loop.ts');
    expect((loop.match(/markServedByRowid\(/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(loop).toMatch(/setAnswerMessageId\(\{/);
    const store = read('memory/message-store.ts');
    expect(store).toMatch(/SET served_by_turn = \? WHERE rowid = \?/);
    expect(store).toMatch(/SET answer_message_id = @answerMessageId[\s\S]{0,200}served_by_turn = @servedByTurn/);
    const cp = read('agent/v2/counterparty.ts');
    expect(cp).toMatch(/claimRowByRowid\(\{/);
    expect(store).toMatch(/conv_key = @convKey,[\s\S]{0,80}served_by_turn = COALESCE/);
  });

  it('the scaffold same-turn close keys on origin_turn identity (clock window = pre-spine fallback only)', () => {
    const tools = read('tracker/tools.ts');
    expect(tools).toMatch(/task\.origin_turn !== liveTurn\) return false/);
  });
});

describe('conversations at ingest (P5)', () => {
  // PHASE-1 T4 (2026-07-27) — CONVERTED, as T3's dated note directed.
  //
  // The requirement has not moved an inch: a channel producer must resolve the
  // conversation and hand it to the write ATOMICALLY, in the same statement, so no row
  // can exist without its conversation identity (OR4 — stamped at ingest). What moved
  // is the statement: a converted producer calls `insertMessage({ … conversationId })`
  // instead of spelling `INTO messages … conversation_id`.
  //
  // BOTH shapes are accepted, deliberately, because T4 converts these seven across
  // several cluster commits and a test that only knew the new shape would have gone red
  // on the unconverted ones — which is a false alarm, not a finding. Both shapes are
  // also the honest statement of the invariant: the atomicity is what is asserted, not
  // the syntax. This list is superseded by the 12-file producer union in
  // memory/__tests__/single-writer-conformance.test.ts, whose allowlist Sweep A drives
  // to zero; it survives here because it is the only check that ties a producer's
  // conversation RESOLUTION to its WRITE.
  const ATOMIC_CONVERSATION_STAMP =
    /INTO messages[\s\S]{0,300}conversation_id|insertMessage(?:IfAbsent)?\s*\([\s\S]{0,400}conversationId/;

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
      expect(src, `${rel} must stamp conversation_id in the write itself`).toMatch(ATOMIC_CONVERSATION_STAMP);
    }
    // The eighth producer is peer A2A. T4 made `memory/interagent.ts` a shim over the single
    // writer; T10 DELETED that file and moved the resolve to the site that was calling it, so
    // the assertion follows the requirement to its new address rather than dying with the
    // file. Same property, same shape: resolve the conversation, hand it to the write.
    const a2a = read('agent/a2a-transport.ts');
    expect(a2a, 'agent/a2a-transport.ts must resolve a conversation').toMatch(/resolveOrCreateConversation\(/);
    expect(a2a, 'agent/a2a-transport.ts must stamp conversation_id in the write itself')
      .toMatch(ATOMIC_CONVERSATION_STAMP);
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



