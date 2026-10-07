// ════════════════════════════════════════════════════════════════════════════════════════
// t123 — THE PM KEEPS THE CONVERSATION IT IS HAVING.
//
// The field evidence is one screenshot of the owner's PM chat. Five exchanges: he asks a
// question; the next bubble is a raw `{"advancing": …, "reason": …, "task_id": …}` JSON
// object; he says "that didn't answer my question"; the PM runs two history searches and says
// nothing; he types "Hello?"; and one minute later the PM replies "Hey, I'm here. What's up?"
// — as if the conversation on his screen had never happened.
//
// One defect enabled all of it: while any task awaited validation, the PM sweep hard-DELETED
// the PM agent's entire conversation every sixty seconds. `POKE_INTERVAL_MS` is 60s and the
// sweep DELIBERATELY bypasses its own 10-minute review throttle whenever validation is
// pending, so the delete ran on every tick — against the platform PM, which is the agent the
// owner actually talks to. "Hey, I'm here. What's up?" is the CORRECT answer to the only
// message the assembly still contained.
//
// This file pins the two guarantees the owner's screenshot is the absence of:
//
//   §A  A PM asked a question mid-conversation still has the conversation's PRIOR messages in
//       its assembled window after the 60-second sweep has run across the turn.
//   §B  An internal advancing/reason verdict NEVER persists to a user-visible lane. (The
//       verdict's own wiring — asked for off the turn plumbing, on the non-persisting model
//       path — is pinned behaviourally in `the-pm-reviews-effort-and-rules.test.ts` §4. What
//       is pinned HERE is the census: the shape cannot reach a message row, and the mechanism
//       that used to put it there is gone from the tree.)
//
// ⚠ WHAT §A DRIVES, STATED EXACTLY, because the honest scope matters more than the word
// "integration". It drives the REAL assembler (`assembleContext`) against the REAL migration
// chain, and between the two assemblies it drives the REAL delete door the 60-second sweep
// calls (`deleteAgentDebrisBefore`, via the pruner's own cutoff shape). It does NOT drive
// `runPokeCheck`'s whole body — `runPMReview` is module-private and fire-and-forget, so
// driving it would mean asserting through a promise nobody returns. The deletes ARE the sweep's
// only effect on this conversation, so they are what is driven; §B's source census is what
// catches a re-introduction of the mechanism itself.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
  getDbPath: () => ':memory:',
}));

import { assembleContext } from '../../memory/assembler.js';
import { deleteAgentDebrisBefore } from '../../memory/message-store.js';
import { runMigrations } from '../../db/migrations.js';
import { laneLimit } from '../../memory/lanes.js';

const PM = 'pm';                 // config/platform.ts: `pm_agent_id` defaults to 'pm'
const MODEL = 'pm-wipe-model';

// ⚠ `fileURLToPath`, NEVER `.pathname` — the repo's real path contains spaces, and
// `.pathname` percent-encodes them, which turned a source-reading gate red in v3.2.1 while
// being invisible to every worktree that ran under a space-free scratchpad.
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const readSrc = (rel: string): string => fs.readFileSync(path.join(SRC, rel), 'utf-8');

/** Comments stripped before any source clause matches, so a clause can never be satisfied —
 *  or broken — by the prose above the code. (G4: a clause satisfiable by its own comment is a
 *  clause that tests the comment.) */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => {
      const i = l.indexOf('//');
      return i === -1 ? l : l.slice(0, i);
    })
    .join('\n');
}

function seedModel(): void {
  const db = mockDb.current!;
  db.prepare(
    "INSERT INTO providers (id, name, type, auth_type, base_url) VALUES ('p','P','openai-compatible','api_key','http://x')",
  ).run();
  db.prepare(
    `INSERT INTO models (id, provider_id, api_model_id, name, context_window, max_output_tokens, capabilities)
     VALUES (?, 'p', 'pmwipe', 'PM Wipe', 128000, 4096, '["tools"]')`,
  ).run(MODEL);
}

function seedAgent(id: string, name: string): void {
  mockDb.current!.prepare(
    "INSERT INTO agents (id, name, status, model_id, config) VALUES (?, ?, 'idle', ?, '{}')",
  ).run(id, name, MODEL);
}

let seq = 0;

/** One message row. `lane` is explicit on every call: the whole defect is about which rows are
 *  owner-visible, so a fixture that let the lane default would be testing the default. */
function row(role: string, content: string, turn: number, lane = 'owner'): string {
  seq += 1;
  const id = `wipe-${seq}`;
  const kind = role === 'assistant' ? 'agent-text' : content.startsWith('[{') ? 'tool-turn' : 'user-text';
  mockDb.current!.prepare(
    `INSERT INTO messages (id, agent_id, role, lane, sender_id, content, display_kind, display_tier,
                           turn_number, provenance, authorized, created_at)
     VALUES (?, ?, ?, ?, 'owner', ?, ?, 'user-visible', ?, 'live', 1, ?)`,
  ).run(id, PM, role, lane, content, kind, turn, 1785000000000 + seq * 1000);
  return id;
}

/** The owner's thread, in his own order: a question, a reply, a follow-up, a reply — and then
 *  the engine backlog that piles up ON TOP of it while he waits.
 *
 *  ⚠ BOTH HALVES OF THIS FIXTURE'S SHAPE ARE LOAD-BEARING, and each was found by planting the
 *  defect (M1) and watching the clause stay green:
 *
 *   1. There must be MORE than `PM_MAX_MESSAGES` rows, or the pruner returns early and the
 *      sweep is a no-op — a clause built on a four-row conversation passes with the owner-lane
 *      spare removed and proves nothing.
 *   2. The conversation must be OLDER than the pruner's cutoff, which means the engine backlog
 *      is seeded AFTER it, not before. With the conversation as the newest rows it sits outside
 *      the delete's range no matter what the lane clause says, so the spare is never exercised.
 *      Seeding it this way round is also the true story: he asks a question, and `pm_review`
 *      situation reports then arrive every sixty seconds until his messages are the oldest
 *      rows the agent owns. That is exactly when he needed them kept. */
function seedTheOwnersConversation(engineBacklog = 80): void {
  row('user', 'why does the email project keep getting reassigned?', 1);
  row('assistant', 'Let me look into the assignment history.', 1);
  row('user', 'that did not answer my question', 2);
  row('assistant', 'You are right — I am checking the task log now.', 2);
  for (let i = 0; i < engineBacklog; i += 1) {
    row('user', `pm_review situation report ${i}`, 3, 'events');
  }
}

/** The two `role='system'` rows a dashboard session reset inserts. They RENDER TO NOTHING, and
 *  the whole point of §A2 is that they must therefore not spend a tail slot. */
function seedSessionResetRows(): void {
  row('system', '[New Session]', 3);
  row('system', 'Session boundary: previous conversation archived.', 3);
}

/** What the 60-second sweep actually does to this agent's rows, driven through the REAL doors:
 *  the pruner's cutoff shape, then its delete. This is the sweep "running across the turn". */
function driveTheSixtySecondSweep(): number {
  const db = mockDb.current!;
  // `pruneOldPMMessages`'s own cutoff shape: the Nth-newest row, walked forward off any `tool`
  // row so the kept window cannot open on an orphaned tool result.
  // Read from the product source, never copied: a hardcoded copy that drifted above the real
  // constant would make every clause in this file silently vacuous (the pruner would return
  // early and the sweep would be a no-op), which is the failure M1 already caught once.
  const PM_MAX = Number(/const PM_MAX_MESSAGES = (\d+)/.exec(readSrc('tracker/pm-agent.ts'))![1]);
  const total = (db.prepare('SELECT COUNT(*) AS c FROM messages WHERE agent_id = ?')
    .get(PM) as { c: number }).c;
  if (total <= PM_MAX) return 0;
  const initial = db.prepare(
    `SELECT id FROM messages WHERE agent_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1 OFFSET ?`,
  ).get(PM, PM_MAX) as { id: string } | undefined;
  if (!initial) return 0;
  const cutoff = db.prepare(
    `SELECT id FROM messages WHERE agent_id = ? AND rowid >= (SELECT rowid FROM messages WHERE id = ?)
       AND role != 'tool' ORDER BY rowid ASC LIMIT 1`,
  ).get(PM, initial.id) as { id: string } | undefined;
  if (!cutoff) return 0;
  return deleteAgentDebrisBefore(PM, cutoff.id);
}

const renderedText = (messages: Array<{ content: unknown }>): string =>
  messages.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');

beforeEach(() => {
  seq = 0;
  mockDb.current = new Database(':memory:');
  runMigrations();
  seedModel();
  seedAgent(PM, 'PM');
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

// ════════════════════════════════════════════════════════════════════════════════════════
describe('§A the conversation survives the sweep that used to erase it', () => {
  it('A1 — a PM mid-conversation still has its PRIOR messages after the 60s sweep runs across the turn', async () => {
    // ONE MINUTE, which is the clause's own unit: one `pm_review` situation report arrives per
    // sweep tick. This is deliberately NOT the 80-report backlog A1d uses — the spec is "a
    // minute later", and the wipe this clause is about deleted the conversation unconditionally,
    // at any row count. So the sweep correctly has nothing to prune at this size.
    //
    // ⚠ WHAT THIS CLAUSE IS AND IS NOT, measured rather than claimed. It is a STATE clause: it
    // pins the window the model is handed after the sweep has run across the turn. It is NOT
    // mutation-sensitive to the wipe itself, and that was verified, not assumed — planting the
    // wipe back (M6) leaves it GREEN, because the wipe lived in the module-private, fire-and-
    // forget `runPMReview` and no test can drive it. The pairing that does the work is
    // therefore split and both halves are needed: A3 is the census that guards the DOOR SET
    // (no unscoped conversation delete exists, in the sweep or anywhere in the store), and this
    // clause guards the BEHAVIOUR of the doors that do exist. A re-introduced wipe is caught by
    // A3; a wrongly-scoped surviving delete is caught by A1d and M1.
    seedTheOwnersConversation(1);
    row('user', 'Hello?', 3);                     // the message he sent a minute later

    const before = await assembleContext(PM, MODEL);
    expect(renderedText(before.messages)).toContain('why does the email project keep getting reassigned?');

    // A minute passes. The sweep runs — this is the tick that used to delete everything.
    driveTheSixtySecondSweep();

    const after = await assembleContext(PM, MODEL);
    const text = renderedText(after.messages);

    // The whole thread is still there, in the window the model is handed.
    expect(text, 'the first question is gone — this is the amnesia the owner photographed')
      .toContain('why does the email project keep getting reassigned?');
    expect(text).toContain('that did not answer my question');
    expect(text).toContain('Hello?');

    // Counted the other way, and this is the clause that would have caught the defect: the
    // window must not have collapsed to the newest message. Under the wipe the assembly held
    // exactly one renderable row — "Hello?" — which is why "Hey, I'm here. What's up?" was the
    // model's correct answer to everything it was given.
    expect(after.messages.length, 'the window collapsed to (almost) nothing, which is the defect')
      .toBeGreaterThan(3);
  });

  it('A1b — the sweep running MANY times still cannot reach the conversation', async () => {
    // Twenty minutes of a validation sitting pending: twenty ticks, twenty situation reports.
    // Twenty-four rows against a 40-row lane, so the thread is still inside the window too.
    seedTheOwnersConversation(20);
    for (let i = 0; i < 20; i += 1) driveTheSixtySecondSweep();

    const after = await assembleContext(PM, MODEL);
    expect(renderedText(after.messages)).toContain('why does the email project keep getting reassigned?');
    expect((mockDb.current!.prepare(
      "SELECT COUNT(*) AS c FROM messages WHERE agent_id = ? AND lane = 'owner'",
    ).get(PM) as { c: number }).c).toBe(4);
  });

  it('A1c — CONTROL: the sweep DOES still clear the engine debris it exists to clear', () => {
    // Otherwise A1 would be satisfiable by a sweep that does nothing at all.
    seedTheOwnersConversation();

    const deleted = driveTheSixtySecondSweep();

    expect(deleted, 'the pruner no longer prunes anything — it has become a no-op').toBeGreaterThan(0);
    expect((mockDb.current!.prepare(
      "SELECT COUNT(*) AS c FROM messages WHERE agent_id = ? AND lane = 'events'",
    ).get(PM) as { c: number }).c, 'the engine backlog was left untouched').toBeLessThan(80);
    // …and it STILL did not touch the human conversation while doing so.
    expect((mockDb.current!.prepare(
      "SELECT COUNT(*) AS c FROM messages WHERE agent_id = ? AND lane = 'owner'",
    ).get(PM) as { c: number }).c).toBe(4);
  });

  it('A1d — over a LONG backlog the rows SURVIVE even once the window has scrolled past them', async () => {
    // ⚠ THE HONEST BOUNDARY OF THIS LANE, stated as a clause rather than left for someone to
    // discover. `lane.pm-tail` is a SCROLLING window (40 rows now, 10 before), and the PM's
    // backlog grows by one `pm_review` row every sixty seconds. After ~80 minutes the owner's
    // thread is no longer among the newest 40 rows, so it is NOT in the assembled window — and
    // t123 does not change that, because a scrolling tail is what a tail is.
    //
    // What t123 changes is that the rows are STILL THERE. They used to be hard-DELETED, which
    // is why the owner watched his PM run `history_search` twice and find nothing: a destroyed
    // row is not recoverable by any tool. Now the window has merely moved past them and the
    // PM's own recall tools can reach them again.
    //
    // The remaining gap — guaranteeing the owner's LIVE ask is in the window regardless of what
    // the tail does — is the triage's item 4 (give the PM branch the ACTIVE USER DIRECTIVE pin).
    // It is deliberately NOT in this lane: it adds a prompt-assembly surface, which carries the
    // cache-preservation tenet and wants its own measurement. Recorded in the lane report.
    seedTheOwnersConversation(80);

    const deleted = driveTheSixtySecondSweep();
    expect(deleted, 'the pruner did not fire, so this clause is not testing the delete').toBeGreaterThan(0);

    // The rows survive the pruner…
    expect((mockDb.current!.prepare(
      "SELECT COUNT(*) AS c FROM messages WHERE agent_id = ? AND lane = 'owner'",
    ).get(PM) as { c: number }).c, 'the conversation was destroyed, not merely scrolled past').toBe(4);
    // …and are still readable by content, which is what `history_search` needs.
    expect((mockDb.current!.prepare(
      "SELECT COUNT(*) AS c FROM messages WHERE agent_id = ? AND content LIKE '%keep getting reassigned%'",
    ).get(PM) as { c: number }).c).toBe(1);
  });

  it('A2 — rows that render to nothing do not spend a tail slot', async () => {
    // ⚠ THE ORDER MATTERS AND IS THE WHOLE CLAUSE. A row only steals a slot if it is INSIDE the
    // newest `cap` rows, so the two `role='system'` rows must be RECENT — a reset at the end of
    // a long thread, which is exactly the owner's case: he reset the session and then kept
    // talking. Seeding them as the OLDEST rows (the obvious way to write this) puts them
    // outside the window entirely and the clause passes with the fix removed, proving nothing.
    // Found by planting that defect — M2 — and watching this clause stay green.
    const cap = laneLimit('lane.pm-tail', 'rows', 'tail');
    for (let i = 0; i < cap - 1; i += 1) row('user', `exchange line ${i}`, 4 + i);
    seedSessionResetRows();

    const ctx = await assembleContext(PM, MODEL);
    const text = renderedText(ctx.messages);

    // `cap - 1` renderable rows plus 2 unrenderable ones is `cap + 1` rows total. An unraised
    // ask of `cap` drops the oldest renderable line to make room for two rows that render to
    // nothing. Raised by the unrenderable count, every real message is still in the window.
    expect(text, 'a system row that renders to nothing still evicted a real message')
      .toContain('exchange line 0');
    expect(text, 'the newest line must obviously still be there').toContain(`exchange line ${cap - 2}`);
  });

  it('A3 — the unscoped by-agent conversation wipe is gone from the sweep, and from the tree', () => {
    const pmAgent = stripComments(readSrc('tracker/pm-agent.ts'));
    const store = stripComments(readSrc('memory/message-store.ts'));

    // The call is gone from the sweep…
    expect(pmAgent, 'the PM sweep calls an unscoped conversation wipe again')
      .not.toMatch(/deleteNonSystemForAgent/);
    // …and the door itself is gone from the store, so it cannot be called from anywhere.
    expect(store, 'the unscoped by-agent conversation delete is back in the store')
      .not.toMatch(/deleteNonSystemForAgent/);

    // Counted the other way: a replacement under a different name is the same loaded gun. No
    // delete over `messages` may be scoped by `agent_id` and `role` alone — every one of them
    // must carry a lane, a seq cutoff, or be the whole-agent teardown.
    const deletes = store.match(/DELETE\s+FROM\s+messages[^;`]*/gi) ?? [];
    expect(deletes.length, 'the delete census found nothing — the matcher has gone stale').toBeGreaterThan(0);
    for (const stmt of deletes) {
      const roleScopedOnly = /role\s*(!=|<>)\s*'system'/i.test(stmt)
        && !/lane/i.test(stmt) && !/seq\s*</i.test(stmt);
      expect(roleScopedOnly, `a role-only by-agent conversation delete is back: ${stmt.trim()}`).toBe(false);
    }
  });

  it('A4 — the pruner cannot delete a row the window would have shown', () => {
    // The two numbers were set years apart and nothing made them agree: a pruner that keeps
    // the newest N while the lane asks for M > N can delete rows the assembly was about to
    // render. This clause is what keeps them agreeing.
    const pmAgent = readSrc('tracker/pm-agent.ts');
    const max = /const PM_MAX_MESSAGES = (\d+)/.exec(pmAgent);
    expect(max, 'PM_MAX_MESSAGES is no longer declared where this clause can read it').not.toBeNull();
    expect(Number(max![1])).toBeGreaterThanOrEqual(laneLimit('lane.pm-tail', 'rows', 'tail'));
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
describe('§B the engine\'s private verdict never reaches a user-visible lane', () => {
  // The shape is a PROMPT LITERAL, not a DB type: exactly one non-test site in the tree
  // produces it, so "where could this have come from" has one answer.
  it('B1 — the verdict envelope is asked for in exactly one place, and that place does not drive a turn', () => {
    const pmAgent = stripComments(readSrc('tracker/pm-agent.ts'));

    // The prompt literal is still here (the feature exists)…
    expect(pmAgent).toMatch(/JSON object and nothing else/);

    // …and `runEffortReview` no longer reaches the turn plumbing to ask for it. These three
    // are the mechanism that published it: an events-lane prompt row as the delivery vehicle,
    // a real agent turn, and a read-back of the persisted assistant reply.
    const review = pmAgent.slice(pmAgent.indexOf('export async function runEffortReview'));
    const body = review.slice(0, review.indexOf('\n}\n'));
    expect(body, 'the effort review inserts an engine event again — the row IS the delivery mechanism')
      .not.toMatch(/insertEngineEventIfAbsent/);
    expect(body, 'the effort review drives an agent turn again, which is what published the verdict')
      .not.toMatch(/handleMessage/);
    expect(body, 'the effort review reads its verdict back out of the messages table again')
      .not.toMatch(/FROM messages/);

    // Counted the other way: it must actually ASK somebody. A body that reaches no model at
    // all would satisfy every clause above while deleting the feature.
    expect(body, 'the effort review no longer calls a model at all').toMatch(/callModel/);
    expect(body, 'the call must be toolless — that is what makes it persist nothing').toMatch(/tools:\s*false/);
    expect(body, 'the call must declare its purpose so the utility dial applies').toMatch(/purpose:\s*'effort_verdict'/);
  });

  it('B2 — assistant output has no engine lane, so the only safe route is not to persist it', () => {
    // This is the v3.4 structural finding, pinned here as a TRIPWIRE rather than fixed: the
    // lane default fails OPEN (`m.lane ?? 'owner'`), and assistant output can only ever reach
    // `a2a` or that default. While that is true, ANY engine intent that drives a PM turn
    // publishes its internal output — which is why t123's fix was to stop driving the turn,
    // not to add a seventh special case to the persistence classifier. If the default is ever
    // made to fail closed, this clause is the one that should be revisited.
    const store = stripComments(readSrc('memory/message-store.ts'));
    expect(store, "the lane default changed — re-derive whether the effort verdict still needs to avoid the turn path")
      .toMatch(/const lane: Lane = m\.lane \?\? 'owner'/);
  });

  it('B3 — the verdict purpose is a declared utility dial, capped to the artifact', async () => {
    // A purpose the dial table has never heard of leaves the call UNTOUCHED — no output cap,
    // thinking left on. So "declared" is the difference between a 128-token JSON object and a
    // model monologuing on the PM's dime; the string in `pm-agent.ts` is not self-enforcing.
    const { utilityDial, isUtilityPurpose } = await import('../../agent/utility-dial.js');
    expect(isUtilityPurpose('effort_verdict'), 'the purpose is not in the dial table, so nothing caps the call').toBe(true);
    const dial = utilityDial('effort_verdict')!;
    expect(dial.maxOutputTokens).toBeLessThanOrEqual(256);
    expect(dial.maxOutputTokens).toBeGreaterThanOrEqual(64);
  });
});
