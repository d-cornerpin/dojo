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
import { engineText, engineFileWithBoth } from '../../agent/v2/__tests__/engine-sources.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8');

// PHASE-6 T9b: THE ENGINE'S SOURCE — the driver plus every step package under
// `agent/v2/steps/`. The turn record's finalize and the per-ask answer stamp left
// `loop.ts` for `agent/v2/steps/teardown/` when the ninth tranche was cut, and the two
// clauses below went red. Their requirement was never "these calls live in loop.ts"; it
// is "every turn start records its subject and root, and every exit finalizes." Reading
// the engine rather than one file covers the seven tranches still to come as well.
//
// PHASE-6 GUARD-AUDIT 2026-08-04: this file's own hand-rolled copy of that walk is gone —
// the derivation is `agent/v2/__tests__/engine-sources.ts`, shared by every guard that
// scans the engine, because six copies of a corpus is six places for it to drift.
const engine = (): string => engineText();

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
    // PHASE-2 T9: the serve boundary is `served_by_turn`, the real serve edge, not the
    // `conv_key` sentinel that used to stand in for it. The REQUIREMENT is unchanged and is
    // what this clause pins: a retire helper must never yank a live turn's trigger. Only the
    // column that answers "has a turn taken this" changed, and it changed to the one that
    // already meant it. (T6 named T9 the owner of this rekey; T10 drops `conv_key`.)
    expect(sweep.slice(0, 600), 'sweepByReferent must not yank a live turn\'s trigger')
      .toMatch(/served_by_turn IS NULL AND swept_at IS NULL/);
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
    // PHASE-2 T10F — RE-EXPRESSED, NOT WEAKENED. This clause used to pin the literal
    // `SELECT status FROM task_runs WHERE id = ?`, and `task_runs` is gone. What it protects
    // is unchanged and is what is asserted now: BOTH referents are read LIVE at sweep time,
    // never carried on the trigger row. The run's referent is the occurrence row, asked
    // through the module that owns it (`occurrenceRunStatus`), so the read cannot drift from
    // the writer the way a hand-copied SQL string can.
    expect(body, 'the run referent must be read live, not taken off the trigger')
      .toMatch(/occurrenceRunStatus\(ev\.run_id\)/);
    // ...and it is a FUNCTION CALL, not a status cached on the message row — the property the
    // old literal was standing for. A negative control on the whole class of regression.
    expect(body, 'no run status may be read from the trigger row itself')
      .not.toMatch(/ev\.run_status|m\.run_status/);
    // PHASE-2 T8b: the live referent is a `work` row, read through the tracker's own scope.
    expect(body).toMatch(/AS status, w\.is_paused AS is_paused FROM work w/);
  });
});

describe('drive boundary (P2)', () => {
  it('no stand-down machinery survives: the ladder always drives in_progress work', () => {
    const pm = read('tracker/pm-agent.ts');
    // The deliverable_shown redirect (validate_deliverable pokes that stood
    // the ladder down) is demolished; only comments may reference the name.
    //
    // ── PHASE-2 T8c item 2 — DELIBERATE DISPOSITION, NAMED (T0 concern adjudication 1).
    // This is one of the two green conformance clauses PINNED §12 warns "die with the
    // column". T8c KEPT it as a forward guard with a named incident: the P2 yacht-research
    // silent hour happened because a hidden flag stood the ladder down, and nothing may
    // re-acquire that predicate in this file. T8c's note ended "It becomes genuinely
    // untestable only when T10 drops the column, and T10 retires it THEN, on purpose."
    //
    // ── PHASE-2 T10F: THE COLUMN IS DROPPED (`145`) AND THE HALVES PART COMPANY.
    // The `validate_deliverable` ban SURVIVES UNCHANGED — it is about a POKE KIND, not the
    // column, and it is still both reachable and load-bearing. Only the column half is
    // retired, and it is re-expressed against the schema rather than deleted: the predicate
    // cannot be re-acquired if the column it read is not there.
    //
    // MEASURED, and worth recording: this clause did NOT go red when the column went, because
    // it is a source scan and not a schema read. It would have kept passing forever against a
    // column that no longer existed. That is why the schema assertion replaces it rather than
    // sitting beside it as decoration.
    const code = pm.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
    expect(code).not.toMatch(/validate_deliverable/);
    const migDir = path.join(SRC, 'db', 'migrations');
    const migs = fs.readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort();
    const dropped = migs.some((f) =>
      /ALTER\s+TABLE\s+work\s+DROP\s+COLUMN\s+deliverable_shown/i.test(
        fs.readFileSync(path.join(migDir, f), 'utf8')));
    expect(dropped, 'the stand-down flag must be gone from the schema, not merely unread').toBe(true);
    // ...and the predicate itself is still banned in this file, which catches a re-add and a
    // re-acquired reader landing in one commit.
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
  // PHASE-6 GUARD-AUDIT: the once-guard sits at the executor choke point, which is inside
  // the `execute` tranche — it MOVES. The requirement was never "the guard lives in
  // loop.ts"; it is "the engine refuses a non-idempotent duplicate". Read the engine.
  it('non-idempotent duplicates are refused at the executor choke point', () => {
    const loop = engine();
    expect(loop).toMatch(/onceGuardExecuted = new Map/);
    expect(loop).toMatch(/onceGuardExecuted\.has\(loopCheck\.signature\)/);
    expect(loop).toMatch(/Already executed in this response/);
    // Both non-idempotent families are covered: fire-and-forget generation
    // and the whole people-channel send surface (sensei's canonical list).
    expect(loop).toMatch(/FIRE_AND_FORGET_GEN_TOOLS\.has\(tc\.name\) \|\| SEND_TO_PEOPLE_SET\.has\(tc\.name\)/);
  });

  it('the guard registers ONLY successful executions (a failed call may retry)', () => {
    // A PROXIMITY clause, not a presence one: the `.set` must sit within 200 chars of the
    // success test. Across a concatenated corpus that distance would be measured over a
    // file join, so the pair is pinned to ONE engine file first — and a tranche that ever
    // splits them fails loudly here instead of quietly matching across the seam.
    const home = engineFileWithBoth('toolResult.isError !== true', 'onceGuardExecuted.set');
    expect(home.text).toMatch(/toolResult\.isError !== true[\s\S]{0,200}onceGuardExecuted\.set/);
  });

  it('the engine-scaffold duplicate-project guard keys on ROOT equality first', () => {
    const tools = read('tracker/tools.ts');
    expect(tools).toMatch(/origin_kind = 'engine_scaffold'[\s\S]{0,80}source_message_id = \?/);
  });
});

describe('turn record (P4)', () => {
  it('every turn start records its subject and root; every exit finalizes', () => {
    const loop = engine();
    // PHASE-2 T2: identity is ALLOCATED at start (startTurn returns the number) and the
    // exit records why it ended AND whether the person heard from us, as two facts.
    expect(loop).toMatch(/return startTurn\(\{/);
    expect(loop).toMatch(/finalizeTurn\(\s*agentId, turnNumber, exitReason, answerRow !== undefined/);
    const rec = read('agent/v2/recovery.ts');
    // The recovery site closes THIS turn, by number — not "every open turn for the agent".
    expect(rec).toMatch(/markTurnDied\(agentId, state\.turnNumber\)/);
  });

  it('claimed asks carry forward links (served_by_turn at every claim site, answers stamped at teardown)', () => {
    // PHASE-1 T4: same requirement, new addresses. The loop must still stamp
    // served_by_turn at every claim site and stamp the answer at teardown; both are
    // now calls into the single writer, and the statements they resolve to are
    // asserted in memory/message-store.ts so the SQL itself is still pinned
    // somewhere. Three claim sites: the human trigger, the engine event, the
    // terminal A2A wake.
    //
    // PHASE-2 T9: the ENGINE EVENT's site is `claimEngineEventByRowid` rather than a bare
    // `markServedByRowid`, because with the `conv_key='engine'` sentinel gone that stamp IS
    // the atomic claim and its `.changes` has to be read. Still three sites, still the same
    // column; the clause counts both spellings so it keeps its whole subject.
    const loop = engine();
    const claimSites = (loop.match(/markServedByRowid\(/g) ?? []).length
      + (loop.match(/claimEngineEventByRowid\(/g) ?? []).length;
    expect(claimSites).toBeGreaterThanOrEqual(3);
    expect(loop).toMatch(/setAnswerMessageId\(\{/);
    const store = read('memory/message-store.ts');
    expect(store).toMatch(/SET served_by_turn = \? WHERE rowid = \?/);
    expect(store).toMatch(/SET answer_message_id = @answerMessageId[\s\S]{0,200}served_by_turn = @servedByTurn/);
    const cp = read('agent/v2/counterparty.ts');
    expect(cp).toMatch(/recordServingTurnByRowid\(\{/);
    // PHASE-2 T10I: `claimRowByRowid` SHRANK into `recordServingTurnByRowid` — it no longer
    // writes the conversation identity, because a sibling USER row's `conversation_id` was
    // already resolved by its own producer at ingest and a second writer for one fact is the
    // disease. The serve edge — the thing THIS clause is about — is unchanged, and the
    // assertion is now strictly about it rather than about it plus a co-written column.
    expect(store).toMatch(/export function recordServingTurnByRowid/);
    expect(store).toMatch(/UPDATE messages SET served_by_turn = COALESCE\(@servedByTurn, served_by_turn\)/);
  });

  // ── RETIRED DELIBERATELY (PHASE-2 T8c item 3), and replaced by the demolition it now
  // guards. This clause pinned `closeEngineScaffoldSameTurn`'s P4 rekey: "created within
  // this turn" must be turn IDENTITY (`origin_turn === liveTurn`), not a five-minute clock
  // window, because a slow turn silently failed the clock version. The FUNCTION is gone —
  // it died with the empty-project machine that created the danglers it cleaned up
  // (PHASE-2.md Task T8 Step 4: "`closeEngineScaffoldSameTurn` dies with the scaffold").
  //
  // Retiring the clause without a replacement would leave nothing saying the path is
  // supposed to be absent, and #15 is explicit that an absence is a question, not an
  // answer. So the clause is INVERTED into a tombstone: the engine's one privileged
  // close must stay gone, and if it ever comes back it comes back with its identity gate.
  it('TOMBSTONE: the engine has no privileged same-turn close any more', () => {
    const tools = read('tracker/tools.ts');
    expect(tools).not.toMatch(/export async function closeEngineScaffoldSameTurn/);
    // ⚠ PHASE-6 GUARD-AUDIT 2026-08-04 — THIS CLAUSE WAS THE QUIET SHAPE, EXACTLY.
    // A NEGATIVE assertion over a SINGLE-FILE corpus passes for two different reasons and
    // cannot tell them apart: because the call is absent, or because the corpus stopped
    // containing the place it would live. `loop.ts` is being drained into step packages,
    // so a re-introduced privileged close landing in `steps/<name>/` was invisible here —
    // a tombstone that cannot see the grave. The negative control below reads
    // `pm-agent.ts`, which is NOT in the engine corpus, so it never covered this gap.
    const loop = engine();
    expect(loop).not.toMatch(/closeEngineScaffoldSameTurn\(/);
    // NEGATIVE CONTROL of the same shape: the OTHER engine close — the PM ladder's
    // strike-2 receipt close — must still be here, or this clause would pass by the
    // engine losing every close rather than just the ungated one.
    const pm = read('tracker/pm-agent.ts');
    expect(pm).toMatch(/strike2Delivery/);
    expect(pm).toMatch(/delivery-receipt close \(strike 2\)/);
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
  // PHASE-5 T9 (2026-08-03) — THE WRITE THIS CLAUSE READS GAINED A THIRD SPELLING, and
  // the assertion follows the requirement to its new address exactly as it already did
  // for `memory/interagent.ts` -> `agent/a2a-transport.ts` above. Decision D4 made the
  // ask ticket's title something the system model writes, which must be asked BEFORE the
  // write opens, so the seven channel producers now reach the single writer through
  // `insertInboundMessageIfAbsent` — the same synchronous write with the title already
  // resolved. **NOTHING ABOUT THE REQUIREMENT MOVED:** `conversationId` must still appear
  // inside the write statement, and the window is unchanged at 400 characters. Seen to
  // bite after the edit: removing `conversationId` from one producer's call fails this
  // clause, naming that producer.
  const ATOMIC_CONVERSATION_STAMP =
    /INTO messages[\s\S]{0,300}conversation_id|insert(?:Inbound)?Message(?:IfAbsent)?\s*\([\s\S]{0,400}conversationId/;

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



