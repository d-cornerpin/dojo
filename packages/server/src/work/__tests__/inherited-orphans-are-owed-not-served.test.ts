// ════════════════════════════════════════════════════════════════════════════════════════
// AN ORPHANED ASK INHERITED FROM AN OLDER VERSION IS OWED AND SHOWN, NEVER AUTO-SERVED.
//
// Review B2 on proof-fix-f, coordinator ruling 2026-11-01. Since t93 (v3.3.0) every restart
// mid-turn has stranded an ask `claimed`, and older builds never handed them back. With no
// window, the first boot of this build would hand back that whole backlog and the re-drain
// would serve it, message after message — texts to contacts about weeks-old asks.
//
// THE SIGNAL IS THE VERSION BOUNDARY, NEVER A CLOCK OR A CAP:
//   * asks stranded by the process that JUST died (its turn closed `terminated` by this boot)
//     are handed back exactly as before;
//   * on the first boot of this build (the release step `orphaned-ask-backlog` is owed), the
//     backlog an older version left goes to `blocked` — owed and shown, not auto-served — and
//     each affected agent gets ONE notice, a deliverable engine event (shown whole on the turn it
//     drives), listing each message: who it is from, the conversation, its age and a snippet.
//     The agent judges what still matters and acts. The engine texts nobody.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };

vi.mock('../../db/connection.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-inherited-orphans', 'dojo.db'),
  };
});
vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn() }));

import { runMigrations } from '../../db/migrations.js';
import { askIdForMessage, claimAsk, stampClaimingTurn, abandonUnservableAsks } from '../store.js';
import { reconcileOrphanedClaims } from '../orphaned-claims.js';
import { inheritedOwedListFor } from '../inherited-backlog.js';
import { sweepBootStaleness } from '../work-reaper.js';
import { resetWorkingAgentsToIdleAtBoot } from '../../agent/agent-status.js';
import { insertMessage } from '../../memory/message-store.js';
import { getWaitingHumanConversations, getPendingEngineEvent } from '../../agent/v2/counterparty.js';
import { RELEASE_STEPS, stepsInGap, runReleaseSteps, RELEASE_STEPS_VERSION_KEY, releaseStepOwed } from '../../release/release-steps.js';
import { VERSION_UNREADABLE } from '../../gateway/routes/update.js';
import { FX, FXID } from '../../../../../deploy/checks/fixture-vocabulary.mjs';

const AGENT = FXID.n4;
const db = (): Database.Database => mockDb.current!;
const stateOf = (m: string): string =>
  (db().prepare('SELECT state FROM work WHERE id = ?').get(askIdForMessage(m)) as { state: string }).state;
const owedNotices = (): string[] =>
  (db().prepare("SELECT content FROM messages WHERE agent_id = ? AND lane = 'events' AND origin_intent = 'owed_messages_inherited' ORDER BY seq")
    .all(AGENT) as Array<{ content: string }>).map((r) => r.content);

function ask(id: string, content: string, who: { channel: string; senderId: string; conv: string; relation: string }): void {
  insertMessage({
    id, agentId: AGENT, role: 'user', content, lane: 'owner', channel: who.channel, senderId: who.senderId,
    authorized: true, conversationId: who.conv,
    inboundMeta: JSON.stringify({ channel: who.channel, relation: who.relation, sender: who.senderId, authorized: true }),
  } as never);
}
const OWNER = { channel: 'dashboard', senderId: 'owner', conv: 'conv-owner', relation: 'owner' };
const CONTACT = { channel: 'imessage', senderId: '+15550100', conv: 'conv-contact', relation: 'known_contact' };

/** An ask an OLDER build stranded: claimed by a turn a previous boot closed `terminated`, weeks ago. */
function inheritedStrandedAsk(id: string, content: string, who: typeof OWNER, turn: number, daysAgo: number): void {
  ask(id, content, who);
  const at = Date.now() - daysAgo * 86_400_000;
  db().prepare('UPDATE messages SET created_at = ? WHERE id = ?').run(at, id);
  db().prepare('UPDATE work SET opened_at = ?, updated_at = ? WHERE id = ?').run(at, at, askIdForMessage(id));
  claimAsk(askIdForMessage(id), AGENT);
  stampClaimingTurn(askIdForMessage(id), turn);
  db().prepare(
    `INSERT INTO turns (agent_id, turn_number, kind, root_kind, root_id, started_at, ended_at, exit_reason, answered)
     VALUES (?, ?, 'user', 'ask', ?, datetime('now', '-${daysAgo} days'), datetime('now', '-${daysAgo} days'), 'terminated', 0)`,
  ).run(AGENT, turn, id);
}

/** The ask the process that just died was serving: its turn is still open at boot. */
function freshlyStrandedAsk(id: string, content: string, turn: number): void {
  ask(id, content, OWNER);
  claimAsk(askIdForMessage(id), AGENT);
  stampClaimingTurn(askIdForMessage(id), turn);
  db().prepare(
    `INSERT INTO turns (agent_id, turn_number, kind, root_kind, root_id, started_at, answered) VALUES (?, ?, 'user', 'ask', ?, datetime('now'), 0)`,
  ).run(AGENT, turn, id);
  db().prepare("UPDATE agents SET status = 'working' WHERE id = ?").run(AGENT);
}

function boot(inheritedBacklog: boolean): void {
  resetWorkingAgentsToIdleAtBoot();
  sweepBootStaleness();
  abandonUnservableAsks();
  reconcileOrphanedClaims({ inheritedBacklog });
}

beforeEach(() => {
  const d = new Database(':memory:');
  d.pragma('foreign_keys = ON');
  mockDb.current = d;
  runMigrations();
  d.pragma('foreign_keys = ON');
  d.prepare(`INSERT INTO agents (id, name, status, session_started_at) VALUES (?, '${FX.n4}', 'idle', '1970-01-01')`).run(AGENT);
  d.prepare(`INSERT INTO conversations (id, agent_id, channel, counterparty_id) VALUES ('conv-owner', ?, 'dashboard', 'owner'), ('conv-contact', ?, 'imessage', '+15550100')`).run(AGENT, AGENT);
  inheritedStrandedAsk('m-old-owner', 'Can you find the warranty card for the dishwasher?', OWNER, 5, 20);
  inheritedStrandedAsk('m-old-contact', 'Are we still on for the garden party on Saturday?', CONTACT, 6, 9);
  freshlyStrandedAsk('m-fresh', 'Please check the roof quote.', 7);
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('the first boot of this build', () => {
  it('parks the inherited backlog OWED (blocked), hands back only what the process that just died stranded', () => {
    boot(true);
    expect(stateOf('m-old-owner')).toBe('blocked');
    expect(stateOf('m-old-contact')).toBe('blocked');
    expect(stateOf('m-fresh'), 'the just-died process\'s ask is handed back as before').toBe('open');
    const waiting = getWaitingHumanConversations(AGENT).map((w) => w.workId);
    expect(waiting, 'nothing inherited is auto-served').toEqual([askIdForMessage('m-fresh')]);
  });

  it('an open turn months older than the process that just died is never taken for its work: its request is parked', () => {
    // An older version left this turn open and its request claimed; the dead process's own turn holds the roof quote.
    ask('m-ancient', 'Did the plumber ever call back?', OWNER);
    claimAsk(askIdForMessage('m-ancient'), AGENT);
    stampClaimingTurn(askIdForMessage('m-ancient'), 4);
    db().prepare(`INSERT INTO turns (agent_id, turn_number, kind, root_kind, root_id, started_at, answered)
      VALUES (?, 4, 'user', 'ask', 'm-ancient', datetime('now', '-60 days'), 0)`).run(AGENT);
    resetWorkingAgentsToIdleAtBoot(Date.now() - 3_600_000);   // the dead process started an hour ago, by its boot stamp
    sweepBootStaleness();
    abandonUnservableAsks();
    reconcileOrphanedClaims({ inheritedBacklog: true });
    expect(stateOf('m-ancient'), 'parked as inherited backlog, never served in a burst').toBe('blocked');
    expect(stateOf('m-fresh'), 'the dead process\'s own request is handed back').toBe('open');
  });

  it('tells the agent ONCE, listing each owed message: who, which conversation, its age, a snippet', () => {
    boot(true);
    const n = owedNotices();
    expect(n).toHaveLength(1);
    // The stored row names the asks by id only (review R3-3); the list is rendered for the turn it drives.
    expect(n[0]).not.toContain('dishwasher');
    const text = inheritedOwedListFor(n[0]) ?? '';
    expect(text).toContain('dishwasher');
    expect(text).toContain('garden party');
    expect(text).toContain('+15550100');
    expect(text).toMatch(/dashboard/);
    expect(text).toMatch(/imessage/);
    expect(text).toContain('20 days');
    expect(text).toContain('9 days');
    expect(text, 'the handed-back fresh ask is not on the list').not.toContain('roof quote');
    expect(n[0], 'the engine texts nobody: the agent decides').toMatch(/decide/i);
  });

  it('the notice is a deliverable: it drives the agent\'s own turn, where it is shown whole', () => {
    boot(true);
    db().prepare("UPDATE messages SET next_attempt_at = ? WHERE origin_intent = 'owed_messages_inherited'").run(Date.now() - 1000);   // its three-minute wait is over
    const pending = getPendingEngineEvent(AGENT);
    expect(pending?.content ?? '').toContain(askIdForMessage('m-old-owner'));
  });

  it('is idempotent across repeated boots at the same boundary: no second notice, nothing moves', () => {
    boot(true);
    boot(true);
    expect(owedNotices()).toHaveLength(1);
    expect(stateOf('m-old-owner')).toBe('blocked');
  });

  it('a later boot (past the boundary) parks nothing and tells nobody', () => {
    boot(false);
    expect(owedNotices()).toHaveLength(0);
    expect(stateOf('m-old-owner'), 'past the boundary every dead claim is handed back, as before').toBe('open');
  });
});

describe('the boundary is a declared release step, run once per version boundary', () => {
  it('a box arriving from 3.4.1 owes it; a box already past it does not', () => {
    const ids = (from: string | null, to: string): string[] => stepsInGap(RELEASE_STEPS, { from, to }).map((s) => s.id);
    expect(ids('3.4.1', '3.5.0')).toContain('orphaned-ask-backlog');
    expect(ids('3.5.0', '3.5.1')).not.toContain('orphaned-ask-backlog');
    expect(ids('3.4.1', '3.5.0-preflight.1'), 'a preflight build of the release owes it too').toContain('orphaned-ask-backlog');
  });
});

describe('the marker moves only when the boot pass completed (review R3-2)', () => {
  const marker = (): string | undefined => (db().prepare('SELECT value FROM config WHERE key = ?').get(RELEASE_STEPS_VERSION_KEY) as { value: string } | undefined)?.value;
  const step = RELEASE_STEPS.find((s) => s.id === 'orphaned-ask-backlog')!;

  it('a pass that parked every inherited orphan lets the step report, and the marker is recorded', async () => {
    boot(true);
    const r = await step.run();
    expect(r).toMatchObject({ examined: 2, flagged: 2 });
    await runReleaseSteps({ currentVersion: '3.5.0' });
    expect(marker()).toBe('3.5.0');
  });

  it('a pass that did not complete makes the step throw, so the marker stays and the next boot parks again', async () => {
    // One park fails part-way (the row refuses the move): the pass is not complete.
    db().exec(`CREATE TRIGGER refuse_one BEFORE UPDATE OF state ON work
               WHEN NEW.state = 'blocked' AND OLD.id = '${askIdForMessage('m-old-contact')}'
               BEGIN SELECT RAISE(ABORT, 'refused for the test'); END;`);
    try { boot(true); } catch { /* the boot step is non-fatal in index.ts */ }
    await expect(Promise.resolve().then(() => step.run())).rejects.toThrow(/did not complete/);
    const report = await runReleaseSteps({ currentVersion: '3.5.0' });
    expect(report.failed.map((f) => f.id)).toContain('orphaned-ask-backlog');
    expect(marker(), 'the step stays owed').toBeUndefined();
    expect(stateOf('m-old-contact'), 'never handed back: still claimed for the next owed boot').toBe('claimed');
  });

  it('run() never parks by itself: with no boot pass it throws and moves nothing', async () => {
    await expect(Promise.resolve().then(() => step.run())).rejects.toThrow(/did not complete/);
    expect(stateOf('m-old-owner')).toBe('claimed');
  });
});

describe('owed by every install whose last-run version predates the first build carrying this code (review R3-4)', () => {
  const setMarker = (v: string | null): void => {
    db().prepare('DELETE FROM config WHERE key = ?').run(RELEASE_STEPS_VERSION_KEY);
    if (v !== null) db().prepare("INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))").run(RELEASE_STEPS_VERSION_KEY, v);
  };
  const owed = (from: string | null, to: string): boolean => { setMarker(from); return releaseStepOwed('orphaned-ask-backlog', to); };

  it('3.4.1 -> 3.5.0-preflight.1 owes it (the first preflight carrying it)', () => expect(owed('3.4.1', '3.5.0-preflight.1')).toBe(true));
  it('3.5.0-preflight.1 -> 3.5.0-preflight.2 does not (that box already ran it)', () => expect(owed('3.5.0-preflight.1', '3.5.0-preflight.2')).toBe(false));
  it('3.5.0-preflight.2 -> 3.5.0 does not', () => expect(owed('3.5.0-preflight.2', '3.5.0')).toBe(false));
  it('3.4.1 -> 3.5.0 owes it, and so would a 3.4.2 hotfix box (any last-run below every 3.5.0 prerelease)', () => {
    expect(owed('3.4.1', '3.5.0')).toBe(true);
    expect(owed('3.4.2', '3.5.0-preflight.1')).toBe(true);
  });
  it('an unreadable installed version fails toward PARKING, never toward serving', () => {
    expect(owed('3.5.0', VERSION_UNREADABLE)).toBe(true);
    expect(owed('not-a-version', '3.5.0')).toBe(true);
  });
});
