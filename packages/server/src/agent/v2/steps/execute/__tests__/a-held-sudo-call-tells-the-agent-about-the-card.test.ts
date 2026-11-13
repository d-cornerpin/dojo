// ⚠ THE WIRING, NOT THE WORDS — and two surviving mutants are why this file exists.
//
// `sudo-copy.ts`'s `sudoHeldRefusal` is unit-tested in the broker corpus, and that is not enough: when I
// mutated the CALL SITE to stop passing it, and separately mutated the routing to ignore it, BOTH
// mutants lived. Every clause was measuring the string in isolation while the agent would have gone on
// reading the generic destructive sentence. That is exactly the S4 shape this campaign already paid for
// once — a helper covered, the seam that uses it not — so the assertion here is made on what
// `recordDispatchAndHold` actually returns to the loop.
//
// The two tables are built with the columns the real INSERT names. The SCHEMA is not this file's job:
// `npm run gates` prepares every statement in the tree against the migrated schema, and the live pass
// filed this exact row on a real migrated database. This file's job is which TEXT comes back.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
const policyRow = { current: 'gated' as string | null };
const PRIMARY = 'primary-agent';

vi.mock('../../../../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));
vi.mock('../../../../../config/platform.js', async (orig) => ({
  ...(await orig<typeof import('../../../../../config/platform.js')>()),
  getSudoPolicyRaw: () => policyRow.current,
  isPrimaryAgent: (id: string) => id === PRIMARY,
  getPrimaryAgentId: () => PRIMARY,
}));

import { recordDispatchAndHold } from '../dispatch-bookkeeping.js';
import { initState } from '../../../state.js';

beforeEach(() => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE healer_proposals (
      id TEXT PRIMARY KEY, category TEXT, severity TEXT, title TEXT, description TEXT,
      proposed_fix TEXT, status TEXT, agent_id TEXT, evidence_json TEXT, urgency TEXT,
      surface TEXT, notified_at TEXT, approval_token TEXT, approval_signature TEXT,
      approval_args_json TEXT, applied_at TEXT, resolved_at TEXT, user_note TEXT, created_at TEXT
    );
    CREATE TABLE destructive_approvals (
      token TEXT PRIMARY KEY, agent_id TEXT NOT NULL, tool_name TEXT, signature TEXT NOT NULL,
      request_text TEXT, args_json TEXT, root_kind TEXT, root_id TEXT, task_id TEXT,
      turn_number INTEGER, status TEXT NOT NULL DEFAULT 'pending', decided_by TEXT, decided_at TEXT,
      wake_delivered INTEGER DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT);
  `);
  db.prepare("INSERT INTO agents (id, name) VALUES (?, 'Primary')").run(PRIMARY);
  mockDb.current = db;
  policyRow.current = 'gated';
});

const held = async (script: string): Promise<string> => {
  const state = initState({
    agentId: PRIMARY, contextWindow: 200_000, isAutoRouted: false, configuredModelId: 'test',
    turnNumber: 1, triggeredByIMessage: false, triggeredByA2AReplyIntent: null,
    lastUserMessageContent: null, lastUserMessageId: null, inboundChannel: null,
    inboundContext: null, pendingTechniqueAck: null,
  });
  const out = await recordDispatchAndHold(
    state,
    ({ id: 'tc-1', name: 'shell', arguments: { script } } as never),
    ({ agentId: PRIMARY, db: mockDb.current, agent: { name: 'Primary' } } as never),
  );
  expect(out.refusal, `a held \`${script}\` must produce a refusal`).not.toBeNull();
  return String(out.refusal?.content ?? '');
};

describe('a held sudo call tells the agent about the card', () => {
  it('⚠ THE REFUSAL THE LOOP RECEIVES is the sudo one, not the generic destructive sentence', async () => {
    const text = await held('sudo cp bin/imsg /opt/homebrew/bin/');
    expect(text).toContain('`gated`');                                  // the policy, and its value
    expect(text).toContain('sudo cp bin/imsg /opt/homebrew/bin/');      // the command, verbatim
    expect(text).toContain('card');                                     // a human decision is pending
    expect(text).toMatch(/SAY IN YOUR REPLY/);                          // …and what is POSSIBLE
    expect(text).not.toContain('could delete or overwrite something');  // the generic text is gone
    expect(text).not.toContain('Healer section');
  });

  // ⚠ NO CLAUSE HERE FOR "the policy value is read, not written in". `free` never holds, so the only
  // shape available was a conditional assertion that PASSES WHEN IT SKIPS — a coin-flip test, which is
  // worse than no test. That property is measured where it can actually be falsified: the broker
  // corpus calls `sudoHeldRefusal` with `free` and `blocked` directly (§10 R4-4).

  it('and the row it filed still carries the owner card + the bound token', async () => {
    await held('sudo whoami');
    const row = mockDb.current?.prepare('SELECT * FROM healer_proposals').get() as Record<string, unknown>;
    expect(String(row.title)).toContain('administrator command');
    expect(String(row.approval_token).length).toBeGreaterThan(0);
    expect(String(row.approval_signature).length).toBeGreaterThan(0);
    expect(JSON.parse(String(row.approval_args_json)).script).toBe('sudo whoami');
  });
});
