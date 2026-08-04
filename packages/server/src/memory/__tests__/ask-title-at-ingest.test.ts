// PHASE-5 T9 (owner decision D4) — THE TRACKER TITLE IS WRITTEN BY THE SYSTEM MODEL.
//
// The ticket a person's message opens used to be titled `content.slice(0, 120)`: a copy of
// the owner's own words carried out of `messages` and into `work.title`, a cross-store
// surface with its own readers and its own lifetime. Whatever he typed rode along.
//
// Three properties, each with a negative control of the same shape beside it, because a
// check that has never refused anything is not known to refuse the thing it was written for:
//
//   1. NOTHING IS DERIVED FROM THE CONTENT AT THIS SEAM. Not the whole message, not a
//      prefix, not any run of it. This test fails against the mechanism it replaced — it is
//      the RED that came first.
//   2. THE FALLBACK IS THE TICKET'S OWN IDENTIFIER, and it is reached by the real resolver
//      on the real "no system tier configured" path, not by a stub. **REFUSAL: it is never
//      the 120-character slice.**
//   3. AN INSTRUCTION TO A MODEL IS NOT A PROVEN REFUSAL. The prompt asks the model not to
//      copy values; `acceptModelTitle` is what makes that a property, by running the
//      platform's EXISTING declared-value scrub over the answer and refusing the whole
//      title if the scrub would change it — never writing the scrubbed form instead.
//
// Plus the invariant this task was not allowed to spend: the message and its ticket are
// still ONE transaction, and the ticket is still dated by the message.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const mockDb: { current: Database.Database | null } = { current: null };

vi.mock('../../db/connection.js', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => path.join(os.tmpdir(), 'dojo-ask-title-test', 'dojo.db'),
  };
});

import { runMigrations } from '../../db/migrations.js';
import { insertMessage, insertMessageIfAbsent, wouldOpenAsk } from '../message-store.js';
import { askIdForMessage } from '../../work/store.js';
import {
  acceptModelTitle, insertInboundMessageIfAbsent, ASK_TITLE_MAX_CHARS,
} from '../../work/ask-title.js';
import {
  noteHandedCredentialValues, forgetHandedCredentialValues,
} from '../../credentials/secret-values.js';

const AGENT = 'kevin';

/** A string nobody has ever typed, so a hit anywhere is this test's and only this test's. */
const SECRET = 'sk-live-t9selftest-4b91ce27ad';
const ASK_CONTENT =
  `Here's the OpenWeather API key for the weather technique: ${SECRET}. `
  + 'Please save it somewhere you can use it later, then tell me where you put it.';

/** The shape every channel producer hands the writer for a real person's message. */
const ownerInbound = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  agentId: AGENT, role: 'user', content: ASK_CONTENT,
  lane: 'owner', channel: 'dashboard', senderId: 'owner', authorized: true,
  conversationId: 'conv-1',
  inboundMeta: JSON.stringify({ channel: 'dashboard', relation: 'owner' }),
  ...over,
});

const workFor = (messageId: string): Record<string, unknown> | undefined =>
  mockDb.current!.prepare('SELECT * FROM work WHERE id = ?').get(askIdForMessage(messageId)) as
    Record<string, unknown> | undefined;
const messageRow = (id: string): Record<string, unknown> | undefined =>
  mockDb.current!.prepare('SELECT * FROM messages WHERE id = ?').get(id) as
    Record<string, unknown> | undefined;

beforeEach(() => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  mockDb.current = db;
  runMigrations();
  db.pragma('foreign_keys = ON');
  db.prepare(
    `INSERT INTO agents (id, name, status, session_started_at)
     VALUES (?, 'Kevin', 'idle', '1970-01-01')`,
  ).run(AGENT);
  db.prepare(
    `INSERT INTO conversations (id, agent_id, channel, counterparty_id)
     VALUES ('conv-1', ?, 'dashboard', 'owner')`,
  ).run(AGENT);
  forgetHandedCredentialValues();
});

afterEach(() => {
  forgetHandedCredentialValues();
});

// ════════════════════════════════════════════════════════════════════════
// 1. NOTHING IS DERIVED FROM THE CONTENT — this is the RED that came first
// ════════════════════════════════════════════════════════════════════════

describe('the ask ticket carries no copy of what the person typed', () => {
  it('RED FIRST: the title is not the message, not its first 120 characters, and not any run of it', () => {
    insertMessage(ownerInbound({ id: 'm-1' }) as never);
    const title = String(workFor('m-1')!.title);

    // The exact mechanism removed.
    expect(title).not.toBe(ASK_CONTENT.slice(0, 120));
    // The thing that mechanism carried.
    expect(title).not.toContain(SECRET);
    // And no prefix of any length a slice could have taken: 12 characters is already
    // shorter than every credential this platform stores.
    for (let n = 12; n <= ASK_CONTENT.length; n += 4) {
      expect(title).not.toContain(ASK_CONTENT.slice(0, n));
    }
  });

  it('the same holds for the idempotent writer, which is the one every channel uses', () => {
    insertMessageIfAbsent(ownerInbound({ id: 'm-2' }) as never);
    const title = String(workFor('m-2')!.title);
    expect(title).not.toContain(SECRET);
    expect(title).not.toBe(ASK_CONTENT.slice(0, 120));
  });
});

// ════════════════════════════════════════════════════════════════════════
// 2. THE FALLBACK IS THE TICKET'S OWN IDENTIFIER
// ════════════════════════════════════════════════════════════════════════

describe('the bounded wait falls back to the ticket\'s own identifier', () => {
  it('no title resolved: the ticket is titled with its own id', () => {
    insertMessage(ownerInbound({ id: 'm-3' }) as never);
    expect(workFor('m-3')!.title).toBe(askIdForMessage('m-3'));
    expect(workFor('m-3')!.title).toBe(workFor('m-3')!.id);
  });

  it('THE REAL RESOLVER, on the real no-system-tier path: still the ticket id, never a slice',
    async () => {
      // Nothing is stubbed. This database has no `system` router tier, which is a supported
      // production state, and it is the same code path a timeout takes.
      const p = await insertInboundMessageIfAbsent(ownerInbound({ id: 'm-4' }) as never);
      expect(p).not.toBeNull();
      const w = workFor('m-4')!;
      expect(w.title).toBe(askIdForMessage('m-4'));
      expect(String(w.title)).not.toContain(SECRET);
    });

  it('a resolved title is written verbatim, and the message and ticket are still ONE unit',
    async () => {
      const p = await insertInboundMessageIfAbsent(
        ownerInbound({ id: 'm-5', askTitle: 'Save the weather API key' }) as never,
      );
      const w = workFor('m-5')!;
      expect(w.title).toBe('Save the weather API key');
      // One transaction: the ticket is dated by the MESSAGE's own timestamp, which only
      // exists because the row was written in the same unit.
      expect(w.opened_at).toBe(messageRow(p!.id)!.created_at);
      expect(w.state).toBe('open');
      expect(w.root_id).toBe('m-5');
    });

  it('a designed no-op mints no second ticket and rewrites no title', async () => {
    await insertInboundMessageIfAbsent(ownerInbound({ id: 'm-6', askTitle: 'First title' }) as never);
    const again = await insertInboundMessageIfAbsent(
      ownerInbound({ id: 'm-6', askTitle: 'Second title' }) as never,
    );
    expect(again).toBeNull();
    expect(workFor('m-6')!.title).toBe('First title');
    const n = mockDb.current!.prepare("SELECT COUNT(*) AS n FROM work WHERE kind = 'ask'").get() as { n: number };
    expect(n.n).toBe(1);
  });

  it('NEGATIVE CONTROLS: nothing that is not a person asking waits for a title or gets a ticket',
    async () => {
      // No channel — the platform writing to itself in the second person.
      expect(wouldOpenAsk(ownerInbound({ id: 'x1', channel: null }) as never)).toBe(false);
      // A peer agent.
      expect(wouldOpenAsk(ownerInbound({ id: 'x2', lane: 'a2a', sourceAgentId: 'peer-1' }) as never)).toBe(false);
      // The engine's own events lane.
      expect(wouldOpenAsk(ownerInbound({ id: 'x3', lane: 'events', originIntent: 'scheduler' }) as never)).toBe(false);
      // The agent's own words.
      expect(wouldOpenAsk(ownerInbound({ id: 'x4', role: 'assistant' }) as never)).toBe(false);
      // ...and the door still writes them, with no ticket.
      await insertInboundMessageIfAbsent(ownerInbound({ id: 'x1', channel: null }) as never);
      expect(messageRow('x1')).toBeDefined();
      expect(workFor('x1')).toBeUndefined();
      // The positive control of the same shape, so "no ticket" never means "no tickets".
      expect(wouldOpenAsk(ownerInbound({ id: 'x5' }) as never)).toBe(true);
    });
});

// ════════════════════════════════════════════════════════════════════════
// 3. THE CHECK — an instruction to a model is not a proven refusal
// ════════════════════════════════════════════════════════════════════════

describe('the written title must pass the platform\'s declared-value scrub', () => {
  it('REFUSES a title carrying a value this process has handled — and does NOT write the scrubbed form',
    () => {
      noteHandedCredentialValues(AGENT, [SECRET]);
      const modelSaid = `Save API key ${SECRET} for weather`;
      const accepted = acceptModelTitle(AGENT, modelSaid);
      // The whole title is refused. `null` is the caller's instruction to use the ticket id.
      expect(accepted).toBeNull();
      // Explicitly NOT the repaired form: a title that had to be scrubbed is a title the
      // model copied from, and what else it copied is not knowable.
      expect(String(accepted)).not.toContain('<redacted-credential');
    });

  it('NEGATIVE CONTROL: the identical title is ACCEPTED when no such value was ever handled', () => {
    const modelSaid = `Save API key ${SECRET} for weather`;
    expect(acceptModelTitle(AGENT, modelSaid)).toBe(modelSaid);
  });

  it('the refusal is scoped to the agent that handled the value, like the scrub itself', () => {
    noteHandedCredentialValues('someone-else', [SECRET]);
    expect(acceptModelTitle(AGENT, `Save ${SECRET} please`)).not.toBeNull();
    expect(acceptModelTitle('someone-else', `Save ${SECRET} please`)).toBeNull();
  });

  it('END TO END: a refused title leaves the ticket with its own identifier', async () => {
    noteHandedCredentialValues(AGENT, [SECRET]);
    // What a model that ignored the instruction would have produced, put through the same
    // acceptance the resolver applies before anything is written.
    const title = acceptModelTitle(AGENT, `Store the key ${SECRET}`);
    await insertInboundMessageIfAbsent(
      ownerInbound({ id: 'm-7', ...(title === null ? {} : { askTitle: title }) }) as never,
    );
    expect(workFor('m-7')!.title).toBe(askIdForMessage('m-7'));
    expect(String(workFor('m-7')!.title)).not.toContain(SECRET);
  });

  it('normalises what a model actually returns, and caps it', () => {
    expect(acceptModelTitle(AGENT, '  "Fix the roof quote"  ')).toBe('Fix the roof quote');
    expect(acceptModelTitle(AGENT, 'Title: Book the flight')).toBe('Book the flight');
    expect(acceptModelTitle(AGENT, 'Renew   the\tdomain')).toBe('Renew the domain');
    expect(acceptModelTitle(AGENT, '\n\nCheck the invoice\nand also some prose\n')).toBe('Check the invoice');
    expect(acceptModelTitle(AGENT, 'x'.repeat(500))!.length).toBe(ASK_TITLE_MAX_CHARS);
  });

  it('an empty or unusable answer is a fallback, not a blank title', () => {
    expect(acceptModelTitle(AGENT, '')).toBeNull();
    expect(acceptModelTitle(AGENT, '   \n  ')).toBeNull();
    expect(acceptModelTitle(AGENT, '""')).toBeNull();
    expect(acceptModelTitle(AGENT, null)).toBeNull();
    expect(acceptModelTitle(AGENT, undefined)).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════
// 4. THE CENSUS — a new channel cannot quietly skip the door
// ════════════════════════════════════════════════════════════════════════
//
// The producers that carry a person's message are the ones that pass a CHANNEL with
// `role: 'user'` — that is the structural fact `isOwnerAsk` gates on (a `role='user'` row
// with no channel was not written by an ingest path). Every one of them must reach the
// writer through the door, or through `resolveInboundAskTitle` above its own transaction.
//
// A producer that skipped it would not LEAK anything — its ticket would take its own
// identifier, which is the safe fallback — but it would silently stop getting a real
// title, and nothing would say so. That is the rot class this clause exists to catch.
//
// The walk reads the source with fs (never grep: two of this tree's largest files carry
// NUL bytes and grep skips them silently), the same way the single-writer walk does.

describe('every inbound producer reaches the writer through the ingest door', () => {
  const SRC = path.join(__dirname, '..', '..');

  const walk = (dir: string, acc: string[] = []): string[] => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const fp = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === '__tests__' || e.name === 'migrations') continue;
        walk(fp, acc);
      } else if (e.name.endsWith('.ts')) acc.push(fp);
    }
    return acc;
  };
  const rel = (f: string) => path.relative(SRC, f).split(path.sep).join('/');

  /** The eight producers measured at this task's HEAD, each read at its site. */
  const CONVERTED = [
    'gateway/routes/chat.ts',
    'gateway/routes/twilio.ts',
    'services/gmail-watcher.ts',
    'services/imessage-bridge.ts',
    'services/outlook-watcher.ts',
    'services/teams-watcher.ts',
    'twilio/call-session.ts',
    'twilio/sms-inbound.ts',
  ];

  /** The two shapes a producer hands the writer in this tree: the object literal passed
   *  straight into an `insertMessage*` call, and the `NewMessage`-typed local the one
   *  producer with its own outer transaction builds first. A literal carrying BOTH a user
   *  role and a channel is a person's message arriving on a channel. */
  const CALL_RE = /(?:insert(?:Inbound)?Message(?:IfAbsent)?\(\{|:\s*NewMessage\s*=\s*\{)[\s\S]*?\n\s*\}[),;]/g;

  it('the producers that pass a channel with role user are exactly the converted eight', () => {
    const found: string[] = [];
    for (const f of walk(SRC)) {
      const r = rel(f);
      if (r === 'memory/message-store.ts' || r === 'work/ask-title.ts') continue; // the writer and the door
      const src = fs.readFileSync(f, 'utf8');
      for (const call of src.match(CALL_RE) ?? []) {
        if (/role:\s*'user'/.test(call) && /channel:/.test(call)) { found.push(r); break; }
      }
    }
    expect([...new Set(found)].sort()).toEqual(CONVERTED);
  });

  it('and each of them reaches the door (or the resolver, for the one with its own transaction)', () => {
    for (const r of CONVERTED) {
      const src = fs.readFileSync(path.join(SRC, r), 'utf8');
      expect(
        src.includes('insertInboundMessageIfAbsent') || src.includes('resolveInboundAskTitle'),
        `${r} writes a person's message without going through the ingest door`,
      ).toBe(true);
    }
  });

  it('and the removed mechanism is gone from the writer: nothing derives a title from content', () => {
    const writer = fs.readFileSync(path.join(SRC, 'memory/message-store.ts'), 'utf8');
    // The literal that shipped, and the shape of any replacement for it.
    expect(writer).not.toMatch(/title:\s*\(?b\.params\.content/);
    expect(writer).not.toMatch(/title:[^\n]*\.slice\(/);
  });
});
