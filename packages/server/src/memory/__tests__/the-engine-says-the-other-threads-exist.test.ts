// ════════════════════════════════════════════════════════════════════════════════════════
// THE ENGINE SAYS THE OTHER THREADS EXIST — HEAD 2, the owner's 2026-09-24 false denial.
//
// ── THE INCIDENT ─────────────────────────────────────────────────────────────────────────────
// An agent held two conversation silos for the SAME PERSON. Asked from one about the other, it said
// it had no way to see the other thread. It had every way: the inbound was live, the rows were in
// its own database, and `history_search` is agent-scoped with no conversation clause. It eventually
// ran `history_get` and answered correctly — THE RECOVERY PATH EXISTED, WAS REACHABLE, AND WORKED.
// The defect is entirely that nothing prompted it.
//
// ── WHY THIS IS AN HONESTY BUG AND NOT A SCOPING BUG ─────────────────────────────────────────
// Every conversation filter on a human turn is CORRECT and each has a named incident behind it (a
// friend's iMessage bleeding into a dashboard turn; a months-long re-answer ghost). None of them is
// announced. So the model's only in-context evidence about its own reach is the ABSENCE OF ROWS, and
// absence reads as incapability — the W84 shape one surface over. This lane publishes the strip.
//
// ── THE CLAUSE THAT MATTERS MOST IS §2's "NO CONTENT" ────────────────────────────────────────
// A lane that quoted the other thread would be the friend-on-iMessage bleed with extra steps: it
// would re-introduce, by a different door, the exact leak the filters exist to prevent. The lane
// publishes a party, a channel, an instant and who spoke last — and then NAMES THE TOOL. §2 holds
// that as a positive clause (the tools are named) and as a negative one (no message body appears,
// asserted against seeded content that would be unmistakable if it leaked).
//
// ── §5 IS THE CACHE LAW, WITH THE REVIEWER'S OWN LESSON BUILT IN ─────────────────────────────
// The round-4 review planted a SECOND importer of a tail lane in a prefix file WITHOUT the file
// extension; under `moduleResolution: "bundler"` it typechecked, leaked the lane into the cached
// prefix, and every clause stayed green because the guard grepped a literal string. The importer
// reader here matches the MODULE under any resolver-legal spelling, and it carries its own fixture
// table of caught and ignored specifiers.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };

vi.mock('../../db/connection.js', async () => {
  const os = await import('node:os');
  const p = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-other-threads-test', 'dojo.db'),
  };
});
/** The channel half reads live platform config; this file tests the LANE, so the registry is
 *  stubbed to a known set. §3 asserts the derivation against the real shape separately. */
vi.mock('../../services/capability-registry.js', () => ({
  listChannelStatuses: () => [
    { name: 'email', displayName: 'Email', configured: true, inboundLive: true },
    { name: 'imessage', displayName: 'iMessage', configured: true, inboundLive: true },
    { name: 'sms', displayName: 'SMS', configured: true, inboundLive: false },
    { name: 'teams', displayName: 'Teams', configured: false, inboundLive: false },
  ],
}));

vi.mock('../../agent/access/read.js', () => ({
  // Granted by default in this file; §3b flips it to prove the other direction.
  toolCategoryGranted: (_a: string, t: string) => !grantsOff.has(t),
}));
const grantsOff = new Set<string>();

import { runMigrations } from '../../db/migrations.js';
import {
  buildOtherThreadsInjection, readOtherThreads, renderOtherThreads,
} from '../other-threads-lane.js';
import { withChannel } from '../thread-channel.js';
import { recalledRowLabel } from '../party-label.js';
const AGENT = 'threaded';
const SERVED = 'conv-dashboard';
const db = (): Database.Database => mockDb.current!;
const hoursAgo = (h: number): number => Date.now() - h * 3_600_000;

function seedConversation(id: string, p: {
  channel: string; counterpartyId?: string | null; counterpartyName?: string | null; agentId?: string;
}): string {
  db().prepare(
    `INSERT INTO conversations (id, agent_id, channel, provider, counterparty_id, counterparty_name)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, p.agentId ?? AGENT, p.channel, p.channel, p.counterpartyId ?? null, p.counterpartyName ?? null);
  return id;
}

function seedMessage(p: {
  conversationId: string; role: 'user' | 'assistant'; content: string; atMs: number; agentId?: string;
}): void {
  db().prepare(
    `INSERT INTO messages (id, agent_id, conversation_id, role, content, created_at, display_kind)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(`m-${Math.random().toString(36).slice(2)}`, p.agentId ?? AGENT, p.conversationId,
    p.role, p.content, p.atMs, p.role === 'user' ? 'user-text' : 'agent-text');
}

beforeEach(() => {
  grantsOff.clear();   // the §7 grant matrix is file-shared; every test starts with all tools granted
  mockDb.current?.close();
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  db().prepare(
    "INSERT INTO agents (id, name, classification, status) VALUES (?, 'A', 'sensei', 'idle')",
  ).run(AGENT);
  db().prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('owner_name', 'the owner')").run();
  seedConversation(SERVED, { channel: 'dashboard', counterpartyId: 'owner' });
  seedMessage({ conversationId: SERVED, role: 'user', content: 'the served thread', atMs: hoursAgo(1) });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §1 — THE READ. What counts as another live thread, and what does not.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§1 the read', () => {
  it('the SERVED conversation is never one of the other threads', () => {
    expect(readOtherThreads(AGENT, SERVED).rows).toHaveLength(0);
  });

  it('a live thread on another channel is found, party-labelled and dated', () => {
    seedConversation('conv-im', { channel: 'imessage', counterpartyId: '+15550100999', counterpartyName: 'a contact' });
    seedMessage({ conversationId: 'conv-im', role: 'user', content: 'their question', atMs: hoursAgo(3) });

    const read = readOtherThreads(AGENT, SERVED);
    expect(read.rows).toHaveLength(1);
    expect(read.rows[0].label).toBe('a contact (imessage)');
    expect(read.rows[0].channel).toBe('imessage');
    expect(read.rows[0].theySpokeLast).toBe(true);
  });

  it('`theySpokeLast` is false when the agent replied last — the waiting signal', () => {
    // t207: an answered thread is named when it moved since the agent's last turn here (the served thread began 1h ago).
    seedConversation('conv-im', { channel: 'imessage', counterpartyId: 'x', counterpartyName: 'a contact' });
    seedMessage({ conversationId: 'conv-im', role: 'user', content: 'their question', atMs: hoursAgo(4) });
    seedMessage({ conversationId: 'conv-im', role: 'assistant', content: 'my reply', atMs: hoursAgo(0.5) });
    expect(readOtherThreads(AGENT, SERVED).rows[0].theySpokeLast).toBe(false);
  });

  it('a PEER thread is excluded — agent coordination is not a person waiting', () => {
    seedConversation('conv-a2a', { channel: 'a2a', counterpartyId: 'peer' });
    seedMessage({ conversationId: 'conv-a2a', role: 'user', content: '[A2A] status?', atMs: hoursAgo(2) });
    expect(readOtherThreads(AGENT, SERVED).rows).toHaveLength(0);
  });

  // t207: there is no 7-day window any more — an old thread that is still waiting is named (see the
  // t207-context-rest-the-other-threads-follow-the-signal test). An old thread that was answered is counted.
  it('an old thread that was answered is history: counted, not named', () => {
    seedConversation('conv-old', { channel: 'imessage', counterpartyId: 'y', counterpartyName: 'a contact' });
    seedMessage({ conversationId: 'conv-old', role: 'user', content: 'ancient', atMs: hoursAgo(24 * 30) });
    seedMessage({ conversationId: 'conv-old', role: 'assistant', content: 'answered', atMs: hoursAgo(24 * 30 - 1) });
    const read = readOtherThreads(AGENT, SERVED);
    expect(read.rows).toHaveLength(0);
    expect(read.hidden).toBe(1);
  });

  it('ANOTHER AGENT\'S thread can never appear — the W3-4 rule', () => {
    db().prepare("INSERT INTO agents (id, name, classification, status) VALUES ('other', 'B', 'sensei', 'idle')").run();
    seedConversation('conv-theirs', { channel: 'imessage', counterpartyId: 'z', counterpartyName: 'a contact', agentId: 'other' });
    seedMessage({ conversationId: 'conv-theirs', role: 'user', content: 'not mine', atMs: hoursAgo(2), agentId: 'other' });
    expect(readOtherThreads(AGENT, SERVED).rows).toHaveLength(0);
  });

  it('newest first among the waiting, none left out, and the quiet ones COUNTED not swallowed', () => {
    for (let i = 0; i < 6; i++) {
      seedConversation(`conv-${i}`, { channel: 'imessage', counterpartyId: `p${i}`, counterpartyName: `contact ${i}` });
      seedMessage({ conversationId: `conv-${i}`, role: 'user', content: `q${i}`, atMs: hoursAgo(20 - i) });
    }
    for (let i = 0; i < 3; i++) {
      seedConversation(`quiet-${i}`, { channel: 'imessage', counterpartyId: `q${i}`, counterpartyName: `quiet ${i}` });
      seedMessage({ conversationId: `quiet-${i}`, role: 'assistant', content: 'done', atMs: hoursAgo(40 + i) });
    }
    const read = readOtherThreads(AGENT, SERVED);
    expect(read.rows).toHaveLength(6);      // t207: every waiting thread, no cap
    expect(read.hidden).toBe(3);
    // Newest first: the last-seeded conversation has the most recent message.
    expect(read.rows[0].label).toContain('contact 5');
  });

  it('a thread whose party cannot be named is not printed at all', () => {
    // `conversationLabel` returns the channel alone when there is no counterparty; a row reading
    // "(imessage)" with no subject tells the model a thread exists and nothing about whose, which
    // invites a guess. The lane prints a party or nothing.
    seedConversation('conv-anon', { channel: 'imessage', counterpartyId: null, counterpartyName: null });
    seedMessage({ conversationId: 'conv-anon', role: 'user', content: 'anon', atMs: hoursAgo(2) });
    const rows = readOtherThreads(AGENT, SERVED).rows;
    for (const r of rows) expect(r.label).not.toBe('imessage');
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §2 — THE RENDER. Empty is absent; no content, ever; the tool is named.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§2 the render', () => {
  const withOneThread = (content = 'THE-SECRET-BODY-TEXT'): void => {
    seedConversation('conv-im', { channel: 'imessage', counterpartyId: 'x', counterpartyName: 'a contact' });
    seedMessage({ conversationId: 'conv-im', role: 'user', content, atMs: hoursAgo(3) });
  };

  it('EMPTY IS ABSENT — no header, no "you have no other threads" line', () => {
    expect(renderOtherThreads(readOtherThreads(AGENT, SERVED))).toBeNull();
    expect(buildOtherThreadsInjection(AGENT, SERVED)).toBeNull();
  });

  it('NOT ONE BYTE OF MESSAGE CONTENT reaches the block', () => {
    withOneThread('THE-SECRET-BODY-TEXT that must never appear in a lane');
    const text = buildOtherThreadsInjection(AGENT, SERVED)!;
    expect(text).not.toContain('THE-SECRET-BODY-TEXT');
    expect(text).not.toContain('must never appear');
  });

  it('it states the three facts and NAMES THE TOOLS that reach the thread', () => {
    withOneThread();
    const text = buildOtherThreadsInjection(AGENT, SERVED)!;
    expect(text).toContain('a contact (imessage)');      // party
    expect(text).toContain('[other conversation]');      // the obligations-lane tag
    expect(text).toContain('they messaged last');        // recency + who
    expect(text).toContain('history_search');            // the unscoped recovery tool
    expect(text).toContain('history_get');
    expect(text).toContain('recall_recent_thread(scope:"all")');
  });

  it('it contradicts the false denial IN WORDS, which is the whole point', () => {
    withOneThread();
    const text = buildOtherThreadsInjection(AGENT, SERVED)!;
    expect(text).toContain('"I have no way to see that" is FALSE');
    expect(text).toContain('each row labelled with the one it belongs to');
  });

  it('the elision is never silent', () => {
    withOneThread();
    for (let i = 0; i < 2; i++) {
      seedConversation(`c${i}`, { channel: 'imessage', counterpartyId: `p${i}`, counterpartyName: `contact ${i}` });
      seedMessage({ conversationId: `c${i}`, role: 'user', content: 'x', atMs: hoursAgo(90 + i) });
      seedMessage({ conversationId: `c${i}`, role: 'assistant', content: 'y', atMs: hoursAgo(89 + i) });
    }
    expect(buildOtherThreadsInjection(AGENT, SERVED)).toContain('and 2 more threads with nothing waiting and nothing new');
  });

  it('a read that throws costs the lane and nothing else', () => {
    // `buildOtherThreadsInjection` owns its catch, which is why the injection site has none.
    db().exec('DROP TABLE conversations');
    expect(buildOtherThreadsInjection(AGENT, SERVED)).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §3 — THE CHANNEL HALF. An agent with a live thread is told the channel is live.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§3 the capability half', () => {
  it('configured channels are published, and a configured-but-down one says so', () => {
    seedConversation('conv-im', { channel: 'imessage', counterpartyId: 'x', counterpartyName: 'a contact' });
    seedMessage({ conversationId: 'conv-im', role: 'user', content: 'q', atMs: hoursAgo(3) });
    const text = buildOtherThreadsInjection(AGENT, SERVED)!;
    expect(text).toContain('Channels you receive on right now:');
    expect(text).toContain('iMessage');
    expect(text).toContain('SMS (configured, inbound NOT live)');   // the negative control
    expect(text).not.toContain('Teams');                            // not configured, nothing to say
  });

  it('the channel line does not fire on its own — no thread, no block', () => {
    // Capability trivia on a turn with no other thread is a tail tax. The lane's licence to spend
    // bytes on every human turn comes from contradicting a false inference.
    expect(buildOtherThreadsInjection(AGENT, SERVED)).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §4 — THE PARTY LABEL ON RECALLED ROWS, the "present-but-unmarked" sub-case.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§4 a recalled row carries whose it was', () => {
  it('a row from ANOTHER thread is labelled; one from the served thread is not', () => {
    seedConversation('conv-im', { channel: 'imessage', counterpartyId: 'x', counterpartyName: 'a contact' });
    expect(recalledRowLabel('conv-im', SERVED)).toBe('a contact (imessage)');
    expect(recalledRowLabel(SERVED, SERVED)).toBeNull();
    expect(recalledRowLabel(null, SERVED)).toBeNull();
  });

  it('a PEER thread stays unlabelled — coordination is not attributed to a person', () => {
    seedConversation('conv-a2a', { channel: 'a2a', counterpartyId: 'peer' });
    expect(recalledRowLabel('conv-a2a', SERVED)).toBe('an agent thread');
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §5 — THE TAIL LAWS. The cache prefix cannot move.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§5 the lane rides the tail, provably', () => {
  /** Every module specifier a file imports, whatever syntax carried it. */
  function importSpecifiers(src: string): string[] {
    const out: string[] = [];
    for (const re of [
      /\bfrom\s*['"]([^'"]+)['"]/g,
      /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
      /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
      /\bimport\s+['"]([^'"]+)['"]/g,
    ]) for (const m of src.matchAll(re)) out.push(m[1]);
    return out;
  }
  /** Resolves to THIS module under any extension the resolver accepts — the round-4 reviewer's
   *  extensionless plant is the reason this matches the MODULE and not a literal string. */
  const resolvesToLane = (spec: string): boolean =>
    spec.replace(/\.(?:[cm]?[jt]sx?)$/, '').split('/').pop() === 'other-threads-lane';

  it('the importer reader is CLOSED: a fixture table of caught and ignored specifiers', () => {
    const CAUGHT = [
      "import { x } from '../../../../memory/other-threads-lane.js';",
      "import { x } from '../../../../memory/other-threads-lane';",     // the reviewer's plant shape
      "import { x } from '../memory/other-threads-lane.ts';",
      "import { x } from './other-threads-lane';",
      "import { x } from './other-threads-lane.mjs';",
      "const { x } = await import('../../memory/other-threads-lane.js');",
      "export { x } from '../memory/other-threads-lane';",
      "import '../memory/other-threads-lane.js';",
    ];
    const IGNORED = [
      "import { x } from '../memory/other-threads-lane-extra.js';",
      "import { x } from '../memory/other-threads-laneX';",
      "import { x } from '../memory/recall-lane.js';",
      "import { x } from '../report/state-lane.js';",
      '// a comment naming memory/other-threads-lane.js is not an import',
      "const s = 'memory/other-threads-lane.js';   // a string is not an import",
    ];
    for (const line of CAUGHT) expect(importSpecifiers(line).some(resolvesToLane), line).toBe(true);
    for (const line of IGNORED) expect(importSpecifiers(line).some(resolvesToLane), line).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §6 — THE BLOCK IS AS LONG AS THE SIGNAL (t207: no fixed caps), AND STILL CARRIES NO CONTENT.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§6 the block is as long as the signal, and still carries no content', () => {
  it('twelve waiting people with 4,000-character messages: twelve lines, no message body', () => {
    for (let i = 0; i < 12; i++) {
      seedConversation(`c${i}`, { channel: 'imessage', counterpartyId: `p${i}`, counterpartyName: `a contact ${i}` });
      seedMessage({ conversationId: `c${i}`, role: 'user', content: 'x'.repeat(4000), atMs: hoursAgo(10 - i / 10) });
    }
    const text = buildOtherThreadsInjection(AGENT, SERVED)!;
    expect(text.match(/\[other conversation\]/g)).toHaveLength(12);
    // 4,000-char messages in every thread, and the block is still small: no content rides along.
    expect(text).not.toContain('xxxxxxxxxxxxxxxxxxxx');
    expect(text.length).toBeLessThan(3000);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §7 — THE ROUTE SENTENCE NAMES ONLY TOOLS THIS AGENT CAN CALL.
//
// ⚠ A BUILD-TIME LIVE PROBE FOUND THIS, which is why it is a section and not a footnote. The lane
// was driven on a scratch agent through the real dashboard door: it fired at 769 chars and WORKED —
// the agent answered correctly out of the other silo instead of denying it — but the receipt showed
// `history_search`/`history_get`/`recall_recent_thread` were NOT ON THE CALL AT ALL (a
// dashboard-created agent's default grants exclude the Conversation Recall category), and the model
// reached the rows through nine `exec` calls instead. Naming a tool the agent cannot call is the SAME
// failure this lane cures, pointed the other way: a confident engine sentence that does not match
// platform truth, leaving the model to pick which authority to believe.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§7 the route sentence is grant-aware', () => {
  const withThread = (): void => {
    seedConversation('conv-im', { channel: 'imessage', counterpartyId: 'x', counterpartyName: 'a contact' });
    seedMessage({ conversationId: 'conv-im', role: 'user', content: 'q', atMs: hoursAgo(3) });
  };

  it('all three granted → all three named', () => {
    withThread();
    const text = buildOtherThreadsInjection(AGENT, SERVED)!;
    expect(text).toContain('`history_search`');
    expect(text).toContain('`history_get`');
    expect(text).toContain('`recall_recent_thread(scope:"all")`');
  });

  it('a tool that is NOT granted is not named', () => {
    withThread();
    grantsOff.add('history_get');
    const text = buildOtherThreadsInjection(AGENT, SERVED)!;
    expect(text).toContain('`history_search`');
    expect(text).not.toContain('`history_get`');
  });

  it('NONE granted → it says so plainly instead of pointing at a locked door', () => {
    withThread();
    for (const t of ['history_search', 'history_get', 'recall_recent_thread']) grantsOff.add(t);
    const text = buildOtherThreadsInjection(AGENT, SERVED)!;
    expect(text).not.toContain('history_search');
    expect(text).toContain('no conversation-recall tool granted');
    // The part the incident turned on SURVIVES: the thread exists, and the denial is still forbidden.
    expect(text).toContain('a contact (imessage)');
    expect(text).toContain('never say you have no way to see it');
    expect(text).toContain('"I have no way to see that" is FALSE');
  });

  it('a throwing access door costs the route sentence, not the lane', () => {
    withThread();
    // `routeSentence` catches, falls back to "nothing granted", and the THREAD still prints.
    expect(buildOtherThreadsInjection(AGENT, SERVED)).toContain('a contact (imessage)');
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §8 — T282. EVERY ROW NAMES ITS CHANNEL (the owner's law: agents always know which channel they are on).
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§8 every thread line names its channel', () => {
  const rowsOf = (): string[] => buildOtherThreadsInjection(AGENT, SERVED)!.split('\n').filter((l) => /^\d+\. /.test(l));

  it('the owner on iMessage reads "<owner> via iMessage"', () => {
    seedConversation('conv-own-im', { channel: 'imessage', counterpartyId: 'owner' });
    seedMessage({ conversationId: 'conv-own-im', role: 'user', content: 'x', atMs: hoursAgo(2) });
    const rows = rowsOf();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain('the owner via iMessage — last activity');
  });

  it('the owner on email reads "<owner> via email"', () => {
    seedConversation('conv-own-em', { channel: 'email', counterpartyId: 'owner' });
    seedMessage({ conversationId: 'conv-own-em', role: 'user', content: 'x', atMs: hoursAgo(2) });
    expect(rowsOf()[0]).toContain('the owner via email — last activity');
  });

  it('a contact thread is unchanged: channel once, never doubled', () => {
    seedConversation('conv-im', { channel: 'imessage', counterpartyId: 'x', counterpartyName: 'a contact' });
    seedMessage({ conversationId: 'conv-im', role: 'user', content: 'x', atMs: hoursAgo(2) });
    const row = rowsOf()[0];
    expect(row).toContain('a contact (imessage) — last activity');
    expect(row).not.toContain(' via ');
  });

  it('an unknown channel falls back to its own id, never blank', () => {
    expect(withChannel('the owner', 'carrier-pigeon')).toBe('the owner via carrier-pigeon');
  });
});
