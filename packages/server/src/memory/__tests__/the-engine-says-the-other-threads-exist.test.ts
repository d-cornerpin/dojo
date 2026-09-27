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
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
    getDbPath: () => p.join(os.tmpdir(), 'dojo-other-threads-test', 'dojo.db'),
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
  OTHER_THREADS_MAX_ROWS, OTHER_THREADS_WINDOW_DAYS, buildOtherThreadsInjection,
  otherThreadsWorstCaseChars, readOtherThreads, renderOtherThreads,
} from '../other-threads-lane.js';
import { recalledRowLabel } from '../party-label.js';
// ⚠ NOT A PATH. `guard-corpus-census.test.ts` refuses a guard that reaches into `agent/v2/steps` by
// hand: six copies of that walk existed before the GUARD-AUDIT and they are why the corpus drifted.
// `engineFileContaining` locates the injection site through the shared derivation, so a tranche that
// moves the step package moves this clause with it instead of blinding it silently.
import { engineFileContaining } from '../../agent/v2/__tests__/engine-sources.js';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
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
    seedConversation('conv-im', { channel: 'imessage', counterpartyId: 'x', counterpartyName: 'a contact' });
    seedMessage({ conversationId: 'conv-im', role: 'user', content: 'their question', atMs: hoursAgo(4) });
    seedMessage({ conversationId: 'conv-im', role: 'assistant', content: 'my reply', atMs: hoursAgo(3) });
    expect(readOtherThreads(AGENT, SERVED).rows[0].theySpokeLast).toBe(false);
  });

  it('a PEER thread is excluded — agent coordination is not a person waiting', () => {
    seedConversation('conv-a2a', { channel: 'a2a', counterpartyId: 'peer' });
    seedMessage({ conversationId: 'conv-a2a', role: 'user', content: '[A2A] status?', atMs: hoursAgo(2) });
    expect(readOtherThreads(AGENT, SERVED).rows).toHaveLength(0);
  });

  it('a thread outside the window is history, not a live silo', () => {
    seedConversation('conv-old', { channel: 'imessage', counterpartyId: 'y', counterpartyName: 'a contact' });
    seedMessage({
      conversationId: 'conv-old', role: 'user', content: 'ancient',
      atMs: hoursAgo(OTHER_THREADS_WINDOW_DAYS * 24 + 1),
    });
    expect(readOtherThreads(AGENT, SERVED).rows).toHaveLength(0);
  });

  it('ANOTHER AGENT\'S thread can never appear — the W3-4 rule', () => {
    db().prepare("INSERT INTO agents (id, name, classification, status) VALUES ('other', 'B', 'sensei', 'idle')").run();
    seedConversation('conv-theirs', { channel: 'imessage', counterpartyId: 'z', counterpartyName: 'a contact', agentId: 'other' });
    seedMessage({ conversationId: 'conv-theirs', role: 'user', content: 'not mine', atMs: hoursAgo(2), agentId: 'other' });
    expect(readOtherThreads(AGENT, SERVED).rows).toHaveLength(0);
  });

  it('newest first, capped, and the overflow is COUNTED not swallowed', () => {
    for (let i = 0; i < OTHER_THREADS_MAX_ROWS + 3; i++) {
      seedConversation(`conv-${i}`, { channel: 'imessage', counterpartyId: `p${i}`, counterpartyName: `contact ${i}` });
      seedMessage({ conversationId: `conv-${i}`, role: 'user', content: `q${i}`, atMs: hoursAgo(20 - i) });
    }
    const read = readOtherThreads(AGENT, SERVED);
    expect(read.rows).toHaveLength(OTHER_THREADS_MAX_ROWS);
    expect(read.hidden).toBe(3);
    // Newest first: the last-seeded conversation has the most recent message.
    expect(read.rows[0].label).toContain(`contact ${OTHER_THREADS_MAX_ROWS + 2}`);
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
    expect(text).toContain('ONE thread');
  });

  it('the elision is never silent', () => {
    for (let i = 0; i < OTHER_THREADS_MAX_ROWS + 2; i++) {
      seedConversation(`c${i}`, { channel: 'imessage', counterpartyId: `p${i}`, counterpartyName: `contact ${i}` });
      seedMessage({ conversationId: `c${i}`, role: 'user', content: 'x', atMs: hoursAgo(10 - i) });
    }
    expect(buildOtherThreadsInjection(AGENT, SERVED)).toContain('and 2 more threads active in the last');
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
    // The basename rule is exact only while ONE module in the tree carries that name.
    const named: string[] = [];
    const walkNames = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== '__tests__') walkNames(abs); continue; }
        if (/^other-threads-lane\.[cm]?[jt]sx?$/.test(e.name)) named.push(abs);
      }
    };
    walkNames(SRC);
    expect(named).toHaveLength(1);
  });

  it('ONE importer, and it is the POST-assembly tail step', () => {
    const assembler = fs.readFileSync(path.join(SRC, 'memory', 'assembler.ts'), 'utf8');
    // `volatileFrom` IS the assembled array's length, so any push the loop makes is behind the
    // cache breakpoint BY CONSTRUCTION rather than by placement.
    expect(assembler).toContain("`volatileFrom` is this array's length");
    const importers: string[] = [];
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== '__tests__') walk(abs); continue; }
        if (!e.name.endsWith('.ts') || e.name.endsWith('.test.ts')) continue;
        if (importSpecifiers(fs.readFileSync(abs, 'utf8')).some(resolvesToLane)) {
          importers.push(path.relative(SRC, abs));
        }
      }
    };
    walk(SRC);
    expect(importers).toEqual(['agent/v2/steps/call-llm/pre-call-injections.ts']);
    // …so nothing on the PREFIX path can even see it: a prefix entry would have to import it.
    expect(assembler).not.toContain('other-threads-lane');
  });

  it('it is DECLARED in the lane table, which is what protects it from the priority repair', () => {
    const lanes = fs.readFileSync(path.join(SRC, 'memory', 'lanes.ts'), 'utf8');
    expect(lanes).toContain("'engine.other-threads': 'lane.loop-tail'");
    // The census in the assembly-repair suite requires the injected literals and the table to be
    // the SAME SET; this is the half that lives on this side of it.
    expect(engineFileContaining("'engine.other-threads'")).not.toBeNull();
  });

  it('HUMAN TURNS ONLY — the push sits inside the conversation gate', () => {
    const site = engineFileContaining("'engine.other-threads'")!.text;
    const gate = site.indexOf("counterparty.kind === 'user' && turnCtx.conversationId");
    const push = site.indexOf("'engine.other-threads'");
    expect(gate).toBeGreaterThan(-1);
    expect(push).toBeGreaterThan(gate);
    // And it is inside that block, not merely after it: the recall-lane injection that follows the
    // block is the next landmark, so the push must come before it.
    expect(push).toBeLessThan(site.indexOf("mctx.recallLane = ctx.recallLane"));
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §6 — THE BYTE BOUND, derived by calling the renderer at maximal caps.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§6 the worst case is measured, not asserted', () => {
  it('the widest shape this lane can emit is bounded and stated', () => {
    const worst = otherThreadsWorstCaseChars();
    // Measured 2026-09-26. The bound is what a reserve derivation may rely on; if this moves, the
    // lane got wider and somebody meant it to.
    expect(worst).toBeGreaterThan(600);
    expect(worst).toBeLessThan(1400);
  });

  it('the widest REAL shape on a seeded body stays well under that bound', () => {
    for (let i = 0; i < OTHER_THREADS_MAX_ROWS + 5; i++) {
      seedConversation(`c${i}`, { channel: 'imessage', counterpartyId: `p${i}`, counterpartyName: `a contact ${i}` });
      seedMessage({ conversationId: `c${i}`, role: 'user', content: 'x'.repeat(4000), atMs: hoursAgo(10 - i) });
    }
    const text = buildOtherThreadsInjection(AGENT, SERVED)!;
    expect(text.length).toBeLessThanOrEqual(otherThreadsWorstCaseChars());
    // 4,000-char messages in every thread, and the block is still this small: the proof that no
    // content rides along is arithmetic, not a promise.
    expect(text.length).toBeLessThan(1400);
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
  beforeEach(() => { grantsOff.clear(); });

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
