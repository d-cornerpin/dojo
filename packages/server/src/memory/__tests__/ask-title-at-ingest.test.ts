// PHASE-5 T9 (owner decision D4) — THE TRACKER TITLE IS WRITTEN BY THE SYSTEM MODEL,
// FLIPPED TO ID-FIRST WITH ASYNC REPLACEMENT BY PHASE-6 T0B (the owner, 2026-08-04).
//
// The ticket a person's message opens used to be titled `content.slice(0, 120)`: a copy of
// the owner's own words carried out of `messages` and into `work.title`, a cross-store
// surface with its own readers and its own lifetime. Whatever he typed rode along.
//
// T9 replaced that with a model-written title and made ingest WAIT for it (2.3–5.2 s,
// measured). T0B removes the wait: the ticket files immediately with ITS OWN IDENTIFIER and
// the model's title REPLACES it when it arrives. §5 below is that property, and it is
// behavioural — the replacement is driven through the door, not asserted about the source.
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

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const mockDb: { current: Database.Database | null } = { current: null };

/** The system model's answer, driven per clause. The two imports inside the resolver are
 *  dynamic (the model module reaches back into the message store), and this mock is what a
 *  dynamic import resolves to — so §5 drives the REAL resolver over a stubbed provider,
 *  never a stubbed resolver. */
const callModel = vi.fn();
vi.mock('../../agent/model.js', () => ({
  callModel: (...args: unknown[]) => callModel(...args),
}));

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
import { patchWork } from '../../work/tracker-store.js';
import {
  acceptModelTitle, insertInboundMessageIfAbsent, replaceAskTitleFromModel,
  ASK_TITLE_MAX_CHARS, ASK_TITLE_INPUT_CHARS, TITLE_INSTRUCTION,
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

/** Configure the `system` router tier for real. `getSystemModel()` reads these two tables,
 *  so the resolver takes its live path instead of the "no tier configured" one. */
const seedSystemTier = (): void => {
  const db = mockDb.current!;
  db.prepare(
    `INSERT INTO providers (id, name, type, auth_type) VALUES ('p-sys', 'Test', 'openai-compatible', 'api_key')`,
  ).run();
  db.prepare(
    `INSERT INTO models (id, provider_id, name, api_model_id, is_enabled) VALUES ('sys-model', 'p-sys', 'Sys', 'sys', 1)`,
  ).run();
  db.prepare(
    `INSERT INTO router_tier_models (tier_id, model_id, priority) VALUES ('system', 'sys-model', 0)`,
  ).run();
};

/** What the provider layer hands back for a title. */
const answered = (content: string): Record<string, unknown> => ({
  content, toolCalls: [], inputTokens: 0, outputTokens: 0, stopReason: 'end_turn',
});

beforeAll(async () => {
  // ── WHY THE MODULE GRAPH IS WARMED BEFORE ANY CLAUSE RUNS ──
  // The background replacement's first step is a dynamic import of the router, and that
  // graph costs ~2.2 s to load ONCE per worker. Cold, a job started by one clause is still
  // inside that import when its own test ends — it then lands on the NEXT clause's fresh
  // database and its mock, which is a harness artefact and not a property of the code.
  // (Found the honest way: it made a clause fail, and the trace said whose job it was.)
  await import('../../router/selector.js');
});

beforeEach(() => {
  callModel.mockReset();
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

afterEach(async () => {
  // Drain: let any job this clause started finish against the database it was started
  // against. With the graph warm this is microseconds, and it keeps clauses independent.
  await new Promise((r) => { setTimeout(r, 25); });
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
// 2. THE TICKET'S OWN IDENTIFIER IS WHAT IT IS FILED WITH, AND WHAT IT KEEPS
// ════════════════════════════════════════════════════════════════════════
//
// Under T9 this was the FALLBACK the bounded wait took on a timeout. Under T0B it is the
// value every ask ticket is filed with, and the value it keeps when no replacement arrives.
// The clauses are unchanged because the property is: the ticket's own identifier, never a
// slice of what was typed.

describe('the ticket is filed with, and keeps, its own identifier', () => {
  it('no title resolved: the ticket is titled with its own id', () => {
    insertMessage(ownerInbound({ id: 'm-3' }) as never);
    expect(workFor('m-3')!.title).toBe(askIdForMessage('m-3'));
    expect(workFor('m-3')!.title).toBe(workFor('m-3')!.id);
  });

  it('THE REAL RESOLVER, on the real no-system-tier path: still the ticket id, never a slice',
    async () => {
      // Nothing is stubbed. This database has no `system` router tier, which is a supported
      // production state, and the replacement it starts resolves to "leave the id alone".
      const p = insertInboundMessageIfAbsent(ownerInbound({ id: 'm-4' }) as never);
      expect(p).not.toBeNull();
      const w = workFor('m-4')!;
      expect(w.title).toBe(askIdForMessage('m-4'));
      expect(String(w.title)).not.toContain(SECRET);
    });

  it('a resolved title is written verbatim, and the message and ticket are still ONE unit',
    async () => {
      const p = insertInboundMessageIfAbsent(
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
    insertInboundMessageIfAbsent(ownerInbound({ id: 'm-6', askTitle: 'First title' }) as never);
    const again = insertInboundMessageIfAbsent(
      ownerInbound({ id: 'm-6', askTitle: 'Second title' }) as never,
    );
    expect(again).toBeNull();
    expect(workFor('m-6')!.title).toBe('First title');
    const n = mockDb.current!.prepare("SELECT COUNT(*) AS n FROM work WHERE kind = 'ask'").get() as { n: number };
    expect(n.n).toBe(1);
  });

  it('NEGATIVE CONTROLS: nothing that is not a person asking gets a ticket',
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
      insertInboundMessageIfAbsent(ownerInbound({ id: 'x1', channel: null }) as never);
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

  it('normalises what a model actually returns, and refuses what it cannot normalise', () => {
    expect(acceptModelTitle(AGENT, '  "Fix the roof quote"  ')).toBe('Fix the roof quote');
    expect(acceptModelTitle(AGENT, 'Title: Book the flight')).toBe('Book the flight');
    expect(acceptModelTitle(AGENT, 'Renew   the\tdomain')).toBe('Renew the domain');
    expect(acceptModelTitle(AGENT, '\n\nCheck the invoice\nand also some prose\n')).toBe('Check the invoice');
    // CHANGED BY UX-REPAIR T6, deliberately, and this clause is the record of it.
    // This used to assert TRUNCATION to ASK_TITLE_MAX_CHARS. Measured on the dev
    // DB before the change: all TEN ask rows whose title is exactly that length —
    // the truncation's own signature — are junk (raw tool-call JSON, the model's
    // monologue, a meta-refusal), and not one is a good title that was merely
    // clipped. An answer over the cap is an answer that ignored "3 to 8 words",
    // so the ticket keeps its own content-free identifier instead.
    expect(acceptModelTitle(AGENT, 'x'.repeat(500))).toBeNull();
    expect(acceptModelTitle(AGENT, 'x'.repeat(ASK_TITLE_MAX_CHARS))!.length).toBe(ASK_TITLE_MAX_CHARS);
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
// writer through the door, or — for the one producer that owns its own outer transaction —
// start the replacement itself once that transaction has committed.
//
// A producer that skipped it would not LEAK anything — its ticket would take its own
// identifier, which is the safe fallback and is now the value it is FILED with — but it
// would silently never get a real title, and nothing would say so. That is the rot class
// this clause exists to catch, and T0B's async path is exactly the shape that could have
// routed around it.
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

  it('and each of them reaches the door (or starts the replacement, for the one with its own transaction)', () => {
    for (const r of CONVERTED) {
      const src = fs.readFileSync(path.join(SRC, r), 'utf8');
      expect(
        src.includes('insertInboundMessageIfAbsent') || src.includes('replaceAskTitleFromModel'),
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

  it('and the RETIRED bounded wait is gone from the tree, not merely unused', () => {
    // PHASE-6 T0B deleted the wait in the same change that stopped waiting. Both halves of
    // it: the bound itself and the race that enforced it on the ingest caller.
    //
    // Read over CODE, not comments — `work/ask-title.ts`'s header deliberately KEEPS the
    // retired mechanism's name and its nine measured samples as the record of the cost that
    // was removed, and a clause that could not tell a record from a mechanism would forbid
    // writing that record down.
    const codeOf = (src: string): string => src.split('\n')
      .filter((l) => {
        const t = l.trim();
        return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
      }).join('\n');

    for (const f of walk(SRC)) {
      expect(codeOf(fs.readFileSync(f, 'utf8')), `${rel(f)} still names the retired ingest bound`)
        .not.toContain('ASK_TITLE_TIMEOUT_MS');
    }
    const door = codeOf(fs.readFileSync(path.join(SRC, 'work/ask-title.ts'), 'utf8'));
    expect(door).not.toContain('Promise.race');
    // ...and the pre-transaction resolver it existed to serve is gone with it, so no
    // producer can still be resolving a title above its own write.
    expect(door).not.toContain('resolveInboundAskTitle');
    // The negative control: the clause can still see a mechanism that IS there.
    expect(door).toContain('replaceAskTitleFromModel');
  });
});

// ════════════════════════════════════════════════════════════════════════
// 5. ID-FIRST WITH ASYNC REPLACEMENT — PHASE-6 T0B (the owner, 2026-08-04)
// ════════════════════════════════════════════════════════════════════════
//
// T9 asked the model BEFORE the write and made every inbound ask wait 2.3–5.2 s for its
// title. The owner's flip removes the wait: the ticket is FILED with its own identifier —
// content-free by construction, the same value the fallback already used — and the model's
// title REPLACES it when it arrives.
//
// These clauses are BEHAVIOURAL: the replacement is driven through the real door over a
// stubbed provider, and the ordering (id first, title later) is asserted from the database.
// The structural half — the wait is gone — is §4's last clause.
//
// THE REFUSALS THAT SURVIVE UNCHANGED, each with a clause here: the initial value is the
// ticket's own identifier and NEVER a slice of what was typed (§1 covers the slice; the
// clauses below cover the identifier); the model's title still passes the declared-value
// scrub (§3's check, now driven end to end through the async write); and the message and
// its ticket are still ONE transaction.

describe('the ticket files with its own identifier and the model\'s title replaces it', () => {
  /** The background job's first step is a dynamic import of the router, and the module graph
   *  behind it costs ~2.3 s to load ONCE per worker. That is module loading, not the
   *  property under test, so the bound here is generous on purpose. */
  const WAIT = { timeout: 15_000, interval: 10 };
  /** Per-clause budget, for the same reason: the default 5 s is a module-load bound here,
   *  not a property bound, and a clause that fails on a cold graph proves nothing. */
  const SLOW = 30_000;
  /** Long enough for anything already queued to run, on a warm module graph. */
  const settle = (): Promise<void> => new Promise((r) => { setTimeout(r, 100); });

  it('RED FIRST: the row and its ticket are FILED before the model answers, and nothing waits',
    async () => {
      seedSystemTier();
      let release!: (title: string) => void;
      callModel.mockReturnValue(new Promise((resolve) => {
        release = (title: string) => resolve(answered(title));
      }));

      // No `await`. The door is synchronous now — you cannot wait on what is not a promise.
      const row = insertInboundMessageIfAbsent(ownerInbound({ id: 'm-10' }) as never);

      // The person's message is durable and its obligation exists, and the model has not
      // been asked anything yet. This is the whole flip, in three assertions.
      expect(row).not.toBeNull();
      expect(messageRow('m-10')).toBeDefined();
      expect(workFor('m-10')!.title).toBe(askIdForMessage('m-10'));

      // The model is asked afterwards, and while it is thinking the ticket is already
      // filed and already carries a content-free name.
      await vi.waitFor(() => expect(callModel).toHaveBeenCalledTimes(1), WAIT);
      expect(workFor('m-10')!.title).toBe(askIdForMessage('m-10'));

      release('Save the weather API key');
      await vi.waitFor(() => expect(workFor('m-10')!.title).toBe('Save the weather API key'), WAIT);
      // The replacement is a rename, never a second ticket.
      const n = mockDb.current!.prepare("SELECT COUNT(*) AS n FROM work WHERE kind = 'ask'").get() as { n: number };
      expect(n.n).toBe(1);
    }, SLOW);

  it('the one-transaction invariant is untouched: the ticket is still dated by the message',
    async () => {
      seedSystemTier();
      callModel.mockResolvedValue(answered('Renew the domain'));
      const row = insertInboundMessageIfAbsent(ownerInbound({ id: 'm-11' }) as never);
      const w = workFor('m-11')!;
      expect(w.opened_at).toBe(messageRow(row!.id)!.created_at);
      expect(w.state).toBe('open');
      expect(w.root_id).toBe('m-11');
      // And the replacement does not disturb any of it.
      await vi.waitFor(() => expect(workFor('m-11')!.title).toBe('Renew the domain'), WAIT);
      expect(workFor('m-11')!.opened_at).toBe(w.opened_at);
      expect(workFor('m-11')!.root_id).toBe('m-11');
    }, SLOW);

  it('CRASH-HONEST: a replacement that never arrives leaves the id title standing, and nothing retries',
    async () => {
      seedSystemTier();
      callModel.mockRejectedValue(new Error('provider exploded'));
      insertInboundMessageIfAbsent(ownerInbound({ id: 'm-12' }) as never);
      expect(workFor('m-12')!.title).toBe(askIdForMessage('m-12'));

      await vi.waitFor(() => expect(callModel).toHaveBeenCalledTimes(1), WAIT);
      // No retry loop that can spin: the attempt is not repeated, and the title the ticket
      // was filed with is the title it keeps — content-free by construction.
      await settle();
      expect(callModel).toHaveBeenCalledTimes(1);
      expect(workFor('m-12')!.title).toBe(askIdForMessage('m-12'));
      expect(String(workFor('m-12')!.title)).not.toContain(SECRET);
    }, SLOW);

  it('a title that arrived while the model was thinking WINS — the replacement writes only over the placeholder',
    async () => {
      seedSystemTier();
      let release!: (title: string) => void;
      callModel.mockReturnValue(new Promise((resolve) => {
        release = (title: string) => resolve(answered(title));
      }));
      insertInboundMessageIfAbsent(ownerInbound({ id: 'm-13' }) as never);

      // Somebody renames the ticket through the ordinary attribute door before the model
      // answers — an agent editing it, or the owner. That name is newer than the model's.
      patchWork(askIdForMessage('m-13'), { title: 'Renamed by the agent' });

      release('What the model would have called it');
      await vi.waitFor(() => expect(callModel).toHaveBeenCalledTimes(1), WAIT);
      await settle();
      expect(workFor('m-13')!.title).toBe('Renamed by the agent');
    }, SLOW);

  it('PIN (green before the flip too): THE CHECK STILL BITES ON THE ASYNC PATH — a model title carrying a handed value is refused end to end',
    async () => {
      seedSystemTier();
      noteHandedCredentialValues(AGENT, [SECRET]);
      callModel.mockResolvedValue(answered(`Save API key ${SECRET} for weather`));
      insertInboundMessageIfAbsent(ownerInbound({ id: 'm-14' }) as never);

      await vi.waitFor(() => expect(callModel).toHaveBeenCalledTimes(1), WAIT);
      await settle();
      // The whole title is refused and the ticket keeps its own identifier — never the
      // scrubbed form, and never the slice.
      expect(workFor('m-14')!.title).toBe(askIdForMessage('m-14'));
      expect(String(workFor('m-14')!.title)).not.toContain(SECRET);
      expect(String(workFor('m-14')!.title)).not.toContain('<redacted-credential');
    }, SLOW);

  it('NEGATIVE CONTROL: nothing that is not a person\'s ask ever costs a model call', async () => {
    seedSystemTier();
    callModel.mockResolvedValue(answered('should never be asked for'));
    insertInboundMessageIfAbsent(ownerInbound({ id: 'y1', channel: null }) as never);
    insertInboundMessageIfAbsent(ownerInbound({ id: 'y2', role: 'assistant' }) as never);
    insertInboundMessageIfAbsent(ownerInbound({ id: 'y3', lane: 'a2a', sourceAgentId: 'peer-1' }) as never);
    await settle();
    expect(callModel).not.toHaveBeenCalled();
    // ...and a duplicate arrival does not buy a second one either: the writer's designed
    // no-op returns null, and a null row starts nothing.
    insertInboundMessageIfAbsent(ownerInbound({ id: 'y4' }) as never);
    expect(insertInboundMessageIfAbsent(ownerInbound({ id: 'y4' }) as never)).toBeNull();
    await vi.waitFor(() => expect(callModel).toHaveBeenCalledTimes(1), WAIT);
    await settle();
    expect(callModel).toHaveBeenCalledTimes(1);
  }, SLOW);

  it('PIN (green before the flip too): a caller that supplies its own title is honoured and asks no model at all', async () => {
    seedSystemTier();
    callModel.mockResolvedValue(answered('should never be asked for'));
    insertInboundMessageIfAbsent(ownerInbound({ id: 'm-15', askTitle: 'Given by the caller' }) as never);
    await settle();
    expect(workFor('m-15')!.title).toBe('Given by the caller');
    expect(callModel).not.toHaveBeenCalled();
  });

  it('the background job is safe to call directly, and a ticket that never existed is a no-op',
    async () => {
      // The one producer with its own outer transaction calls this itself, post-commit.
      seedSystemTier();
      callModel.mockResolvedValue(answered('Book the flight'));
      // No row was ever written for this id, so there is nothing to retitle and no throw.
      await replaceAskTitleFromModel(ownerInbound({ id: 'nope' }) as never, 'nope');
      expect(workFor('nope')).toBeUndefined();
    }, SLOW);
});

// ════════════════════════════════════════════════════════════════════════
// 6. UX-REPAIR T6 — THE TITLE STOPS COMPLETING THE PROMPT'S OWN WORDS
//
// Live on the box, 2026-08-10: "Add a small section for gym stuff." became
// **"Add gym section to work tracker"**. "work tracker" is not in the message —
// it is in the INSTRUCTION ("Write a short title for the request below, for a
// work tracker"), and the call is context-free by construction (`systemPrompt:
// ''`, ONE message, no conversation), so on a subject-free follow-up the only
// concrete noun the model had was the prompt's own.
//
// Same class, worse instance, also live: `ask:4149b755-…` is titled with a raw
// tool-call JSON blob, because the ONLY acceptance check is the declared-secret
// scrub — it validates for SECRETS, never for the instruction's own format.
//
// THE DISTINCTION THIS SECTION EXISTS TO KEEP (against `ask-title.ts:51-56`'s
// recorded refusal, "there is no 'does this look like a key' test here and there
// must never be one"): the new check reads the title against THE INSTRUCTION'S
// OWN STATED RULES. It never infers what a value MEANS. The scrub remains the
// only secrecy authority, and every clause of §3 above is untouched.
// ════════════════════════════════════════════════════════════════════════

describe('the title instruction no longer supplies the noun', () => {
  it('RED FIRST: "work tracker" cannot come out of the instruction, because it is not in it', () => {
    expect(TITLE_INSTRUCTION).not.toMatch(/work tracker/i);
    // The rules that carry the register are the ones that stay.
    expect(TITLE_INSTRUCTION).toContain('describing WHAT IS BEING ASKED');
    expect(TITLE_INSTRUCTION).toContain('Never copy values out of the message');
    expect(TITLE_INSTRUCTION).toContain('Reply with the title only');
  });
});

describe('the model is shown the conversation it is naming', () => {
  const WAIT = { timeout: 15_000, interval: 10 };
  const SLOW = 30_000;

  /** The S2 replay: a subject-bearing message, then the subject-free follow-up
   *  that produced the confabulation. */
  const FIRST = 'Make me a packing checklist for a 4-day work trip to Chicago, carry-on only, keep it practical. Put it in a file so I can open it later.';
  const FOLLOW_UP = 'Add a small section for gym stuff.';

  it('RED FIRST: the follow-up call carries the earlier owner message as labelled context',
    async () => {
      seedSystemTier();
      callModel.mockResolvedValue(answered('Add gym section to packing checklist'));
      insertInboundMessageIfAbsent(ownerInbound({ id: 'm-20', content: FIRST }) as never);
      await vi.waitFor(() => expect(callModel).toHaveBeenCalledTimes(1), WAIT);

      insertInboundMessageIfAbsent(ownerInbound({ id: 'm-21', content: FOLLOW_UP }) as never);
      await vi.waitFor(() => expect(callModel).toHaveBeenCalledTimes(2), WAIT);

      const sent = String((callModel.mock.calls[1][0] as { messages: Array<{ content: string }> }).messages[0].content);
      // The subject the follow-up does not name is now in front of the model...
      expect(sent).toContain('packing checklist');
      // ...clearly marked as context, and never as the thing to title.
      expect(sent).toMatch(/context only/i);
      expect(sent).toContain(FOLLOW_UP);
      // The whole input still fits the budget the call has always had.
      expect(sent.length).toBeLessThanOrEqual(ASK_TITLE_INPUT_CHARS + TITLE_INSTRUCTION.length + 200);
    }, SLOW);

  it('CONTROL: the FIRST message in a conversation is asked exactly as it always was', async () => {
    seedSystemTier();
    callModel.mockResolvedValue(answered('Make a Chicago packing checklist'));
    insertInboundMessageIfAbsent(ownerInbound({ id: 'm-22', content: FIRST }) as never);
    await vi.waitFor(() => expect(callModel).toHaveBeenCalledTimes(1), WAIT);

    const sent = String((callModel.mock.calls[0][0] as { messages: Array<{ content: string }> }).messages[0].content);
    expect(sent).toBe(`${TITLE_INSTRUCTION}\n\n${FIRST}`);
  }, SLOW);

  it('CONTROL: context is scoped to this conversation and to the owner lane', async () => {
    seedSystemTier();
    mockDb.current!.prepare(
      `INSERT INTO conversations (id, agent_id, channel, counterparty_id) VALUES ('conv-2', ?, 'dashboard', 'owner')`,
    ).run(AGENT);
    callModel.mockResolvedValue(answered('Something else entirely'));
    insertInboundMessageIfAbsent(ownerInbound({ id: 'm-23', content: 'A message about beekeeping supplies.' }) as never);
    await vi.waitFor(() => expect(callModel).toHaveBeenCalledTimes(1), WAIT);

    insertInboundMessageIfAbsent(
      ownerInbound({ id: 'm-24', conversationId: 'conv-2', content: FOLLOW_UP }) as never,
    );
    await vi.waitFor(() => expect(callModel).toHaveBeenCalledTimes(2), WAIT);
    const sent = String((callModel.mock.calls[1][0] as { messages: Array<{ content: string }> }).messages[0].content);
    expect(sent).not.toContain('beekeeping');
    expect(sent).toBe(`${TITLE_INSTRUCTION}\n\n${FOLLOW_UP}`);
  }, SLOW);
});

describe('a title that violates the instruction\'s own format is refused', () => {
  // MEASURED, not imagined: every one of these is a real title the floor model
  // wrote and `acceptModelTitle` accepted, read out of the dev DB on 2026-08-10.
  // All TEN rows in that database whose title is exactly ASK_TITLE_MAX_CHARS
  // long are junk of this kind — there is not one good title among them that was
  // merely clipped, which is why over-length REFUSES rather than truncates.
  const REAL_JUNK = [
    '{"type":"function","function":{"name":"file_write","parameters":{"file_path":"/tmp/x.txt","content":"hi"}}}',
    '{"name": "file_write", "arguments": {"file": "/tmp/dojo-steer-scenario.txt", "text": "steer scenario"}}',
    'file_write("/tmp/dojo-steer-scenario-bmsfhr7n7h0.txt", "steer scenario")Done. Texted the summary.',
    'I\'ll write the file first.The user instruction is clear: do exactly two things and nothing else.',
    'The request content is missing, so I cannot generate a title. For your other question, see below.',
  ];

  it('RED FIRST: the raw tool-call blob is refused and the ticket keeps its own identifier', () => {
    for (const junk of REAL_JUNK) expect(acceptModelTitle(AGENT, junk), junk).toBeNull();
  });

  it('CONTROL: every ordinary title still passes, unchanged', () => {
    for (const good of [
      'Compare and Recommend Note-Taking Apps',
      'Create packing checklist for work trip',
      'Schedule weekday calendar review and vet call',
      'Compare HubSpot and Pipedrive for Small Team',
      'Find largest file in fixtures folder',
      'Summarize folder contents thoroughly',
      'Total count of all files',
      'Add gym section to packing checklist',
    ]) {
      expect(acceptModelTitle(AGENT, good), good).toBe(good);
    }
  });

  it('CONTROL: the normalisations that already existed still normalise', () => {
    expect(acceptModelTitle(AGENT, '  "Fix the roof quote"  ')).toBe('Fix the roof quote');
    expect(acceptModelTitle(AGENT, 'Title: Book the flight')).toBe('Book the flight');
    expect(acceptModelTitle(AGENT, '\n\nCheck the invoice\nand also some prose\n')).toBe('Check the invoice');
  });

  it('CONTROL: the format check is not a secret-shape test — a key-LOOKING string with no declared value passes', () => {
    // `ask-title.ts:51-56`: "there is no 'does this look like a key' test here and
    // there must never be one." This clause is what keeps that true after T6.
    expect(acceptModelTitle(AGENT, 'Save sk-live-abc123def456 for weather')).toBe('Save sk-live-abc123def456 for weather');
  });
});
