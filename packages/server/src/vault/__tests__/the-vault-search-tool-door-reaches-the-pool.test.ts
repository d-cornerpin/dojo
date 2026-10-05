// ⚠ THE TOOL DOOR, END TO END — `vault_search` as the model actually calls it.
//
// The lane's other clause file proves the four reads are bounded and pooled at the STORE. This one
// proves the thing a user would notice: that `executeVaultSearch` — the handler behind the
// `vault_search` tool — hands the model ROWS, and that in `mode: 'exact'` it does so through the
// reader pool rather than on the thread that serves HTTP.
//
// ⚠ AND IT RECORDS WHAT THE PRE-FIX DOOR RETURNED, because the orchestrator asked whether this lane
// was about to ship a Promise serialised as `{}`. IT WAS NOT, and the answer is worth stating
// precisely rather than reassuringly: `listEntries` was synchronous at the lane's base and stayed
// synchronous through every commit of it, so `:429` always returned a real `VaultEntry[]` and the
// rendered tool result always carried rows. Nothing was broken and nothing was about to be. What was
// true is that those rows were read ON THE SERVING THREAD — bounded after this lane's first commit,
// but still on the thread — which is a performance fact, not a correctness one. The fix is therefore
// NOT "add an await to `listEntries`" (awaiting a non-promise changes nothing); it is to call the
// POOLED door, `listEntriesBounded`, and await that.
//
// So two clauses, and they fail in different ways:
//   · "the door returns rows" passes before the fix AND after it — it is the regression guard, and
//     the mutant that removes the `await` is what makes it mean something;
//   · "the door's reads leave the serving thread" FAILS before the fix and passes after, which is
//     the change itself, asserted as a COUNT rather than a stopwatch.
//
// Every fixture is generated and fictional.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dojo-t98-tooldoor-'));
const dbPath = path.join(dbDir, 'fixture.db');
let db: Database.Database | null = null;

/** Every read the SERVING connection actually ran, by SQL — the same instrument the store clauses
 *  use, and for the same reason: a count means the same thing on an idle box and a loaded one. */
let onThreadReads: string[] = [];

function recordingDb(real: Database.Database): Database.Database {
  const wrapStatement = (sql: string, stmt: unknown): unknown => new Proxy(stmt as object, {
    get(target, prop) {
      const value = Reflect.get(target, prop) as unknown;
      if (prop === 'all' || prop === 'get') {
        return (...args: unknown[]) => {
          onThreadReads.push(sql.replace(/\s+/g, ' ').trim());
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
    },
  });
  return new Proxy(real, {
    get(target, prop) {
      if (prop === 'prepare') return (sql: string) => wrapStatement(sql, real.prepare(sql));
      const value = Reflect.get(target, prop) as unknown;
      return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
    },
  }) as Database.Database;
}

vi.mock('../../logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../db/connection.js', () => ({
  getDbPath: () => dbPath,
  getDb: () => {
    if (!db) throw new Error('fixture not open');
    return recordingDb(db);
  },
}));
// The tool layer embeds on the semantic path; exact mode never touches it, and the one clause below
// that drives semantic mode wants a deterministic vector rather than a network call.
vi.mock('../../memory/embeddings.js', () => ({
  generateEmbedding: async () => new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]),
  queueEmbedding: () => { /* not exercised */ },
  isEmbeddingBackendUnavailable: () => false,
  warnEmbeddingBackendAbsentOnce: () => { /* not exercised */ },
}));

import { executeVaultSearch } from '../tools.js';
import {
  readerPoolAvailable, resetReaderPoolForTest, terminateReaderPool, warmReaderPool,
} from '../../memory/reader-pool.js';

const AGENT = 'agent-tooldoor';
const NEEDLE = 'thistlewick ferry timetable';

beforeAll(() => {
  const d = new Database(dbPath);
  d.pragma('journal_mode = WAL');
  d.exec(`CREATE TABLE vault_entries (
    id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, agent_name TEXT,
    type TEXT NOT NULL DEFAULT 'fact', content TEXT NOT NULL, context TEXT,
    confidence REAL DEFAULT 1.0, is_permanent INTEGER DEFAULT 0, tags TEXT DEFAULT '[]',
    is_pinned INTEGER DEFAULT 0, is_obsolete INTEGER DEFAULT 0, superseded_by TEXT,
    retrieval_count INTEGER DEFAULT 0, last_retrieved_at TEXT, source_conversation_id TEXT,
    source TEXT DEFAULT 'extraction', embedding BLOB, namespace TEXT, citation TEXT,
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
  )`);
  // The unfiled-archive bridge reads this on both modes; empty is the ordinary case.
  d.exec(`CREATE TABLE vault_conversations (
    id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, agent_name TEXT, messages TEXT NOT NULL,
    message_count INTEGER NOT NULL, token_count INTEGER NOT NULL, earliest_at TEXT NOT NULL,
    latest_at TEXT NOT NULL, is_processed INTEGER DEFAULT 0, processed_at TEXT,
    attempts INTEGER DEFAULT 0, poisoned INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  const emb = Buffer.from(new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]).buffer);
  const ins = d.prepare(`INSERT INTO vault_entries (id, agent_id, type, content, embedding)
    VALUES (?, ?, 'fact', ?, ?)`);
  d.transaction(() => {
    // Three entries the search must find, and filler it must not.
    for (let i = 0; i < 3; i += 1) {
      ins.run(`hit-${i}`, AGENT, `the ${NEEDLE} runs hourly from the fictional north quay (${i})`, emb);
    }
    for (let i = 0; i < 40; i += 1) {
      ins.run(`miss-${i}`, AGENT, `an unrelated fictional note about made-up paperwork ${i}`, emb);
    }
  })();
  d.close();
  db = new Database(dbPath, { readonly: true });
});

afterAll(async () => {
  await terminateReaderPool();
  db?.close();
  db = null;
  fs.rmSync(dbDir, { recursive: true, force: true });
});

beforeEach(() => {
  onThreadReads = [];
  resetReaderPoolForTest();
});

describe('⚠ THE DOOR RETURNS ROWS — the regression guard, true before and after the fix', () => {
  it('exact mode renders the matching entries, not a Promise and not an empty object', async () => {
    const out = await executeVaultSearch(AGENT, { query: NEEDLE, mode: 'exact', limit: 5 });

    // ⚠ THE THREE SHAPES A BROKEN AWAIT PRODUCES, each refused by name, because "it contains the
    // needle" would also be true of the not-found message (which quotes the query back) and
    // `String(aPromise)` is '[object Promise]' rather than anything a `toContain` would catch.
    expect(typeof out).toBe('string');
    expect(out, 'the handler rendered a Promise instead of its rows').not.toContain('[object Promise]');
    expect(out, 'the handler rendered a Promise instead of its rows').not.toContain('{}');
    expect(out, 'exact mode reported a miss on a query that matches three entries')
      .not.toContain('No vault entries contain');

    // The rows themselves, by id and by count — the answer the model is handed.
    expect(out).toContain('Found 3 vault entries');
    for (const id of ['hit-0', 'hit-1', 'hit-2']) expect(out).toContain(id);
    expect(out, 'the filler leaked into an exact-substring answer').not.toContain('miss-');
  }, 60_000);

  it('a query that matches nothing still renders the miss SENTENCE, not a thrown handler', async () => {
    const out = await executeVaultSearch(AGENT, { query: 'no-such-fictional-string', mode: 'exact' });
    expect(out).toContain('No vault entries contain');
  }, 60_000);

  it('semantic mode is unchanged by this fix and still renders rows', async () => {
    // The other three reads were already async and already awaited at this call site, so this is a
    // control arm: if the fix had broken the shared door, this is where it would show.
    const out = await executeVaultSearch(AGENT, { query: NEEDLE, mode: 'semantic', limit: 5 });
    expect(typeof out).toBe('string');
    expect(out).not.toContain('[object Promise]');
    // The handler's own words, read off the handler rather than guessed: exact mode says "vault
    // entries", semantic mode says "vault memories". My first cut asserted the former for both and
    // reded on the difference, which is the useful kind of wrong — the clause now pins the real
    // string, so a reworded tool result has to come through here.
    expect(out).toMatch(/Found \d+ vault memories|No vault entries found/);
  }, 60_000);
});

describe('⚠ THE DOOR\'S READS LEAVE THE SERVING THREAD — the change itself, COUNTED', () => {
  it('exact mode runs no LIKE walk on the serving connection', async () => {
    expect(readerPoolAvailable(), 'worker threads are unavailable in this environment').toBe(true);
    await warmReaderPool();
    onThreadReads = [];

    const out = await executeVaultSearch(AGENT, { query: NEEDLE, mode: 'exact', limit: 5 });
    expect(out).toContain('Found 3 vault entries');

    // ⚠ ZERO, NOT "FEWER". This is the clause that FAILED before the fix and passes after it: the
    // handler called the synchronous door, so the leading-wildcard LIKE and its cost count both ran
    // here, on the thread that serves HTTP. Pre-fix this read 2.
    const walked = onThreadReads.filter((q) => /content LIKE|COUNT\(\*\) AS n, COALESCE/.test(q));
    expect(walked, 'the exact search walked the vault on the serving connection').toEqual([]);

    // What legitimately stays here is the window's two O(log n) seeks against the integer primary
    // key, and the archive bridge's own read — which is bounded by construction and is not this
    // lane's to move.
    expect(onThreadReads.filter((q) => q.includes('MAX(rowid)'))).toHaveLength(1);
    expect(onThreadReads.filter((q) => q.includes('MIN(rowid)'))).toHaveLength(1);
  }, 60_000);

  it('the handler AWAITS the pooled door — asserted on the call, with comments stripped', () => {
    // A source clause as well as the behavioural one, because the behavioural pair above can both be
    // satisfied by a synchronous door (rows yes, pool no) and the counted clause is the only thing
    // separating them — so the call shape is pinned too, and it is pinned as shape AND application:
    // the identifier, the `await`, and the assignment it feeds.
    const raw = fs.readFileSync(new URL('../tools.ts', import.meta.url), 'utf-8');
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code, 'exact mode no longer awaits the pooled listing door')
      .toMatch(/const rows = await listEntriesBounded\(\{/);
    // And the synchronous door is NOT what exact mode calls any more — the other direction.
    expect(code, 'the synchronous listing door is back on the tool path')
      .not.toMatch(/const rows = listEntries\(\{/);
  });
});

describe('⚠ EVERY PRODUCTION CALLER OF AN ASYNC VAULT READ AWAITS IT — a census, both ways', () => {
  // ⚠ WHY A CENSUS RATHER THAN A SPOT CHECK. These four reads return Promises, and TypeScript will
  // not stop a caller from assigning one to a variable and reading `.length` off it — the value is
  // `undefined`, nothing throws, and the agent is handed an empty answer that looks like a real one.
  // `listEntriesBounded` is new on the tool path with this fix, so this is exactly the moment to
  // write the rule down with a NUMBER: add a caller without an `await` and this reds.
  // ⚠ `fileURLToPath`, NOT `url.pathname`. This repository's path contains spaces, so `pathname`
  // hands back the percent-encoded form and every `readFileSync` ENOENTs. My first cut used
  // `pathname` and the clause died on `Claude%20Code%20Projects` — worth the comment because the
  // failure looks like a missing file rather than a wrong decoding.
  const SRC_ROOT = fileURLToPath(new URL('../../', import.meta.url));

  /** Every production `.ts` under `packages/server/src`, tests and fixtures excluded. */
  function productionFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...productionFiles(child));
      else if (/\.ts$/.test(entry.name) && !/\.(test|spec)\.ts$/.test(entry.name)) out.push(child);
    }
    return out;
  }

  const ASYNC_READS = [
    'semanticSearch',
    'listEntriesBounded',
    'findNearDuplicateEntry',
    'findSemanticDuplicate',
  ] as const;

  it('every call site of each async vault read is awaited, and the callers are named', () => {
    const files = productionFiles(SRC_ROOT);
    expect(files.length, 'the file walk found nothing — the walk broke, not the code')
      .toBeGreaterThan(300);

    const callers: Record<string, Set<string>> = {};
    const unawaited: string[] = [];
    for (const abs of files) {
      const code = fs.readFileSync(abs, 'utf-8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      const rel = abs.slice(abs.indexOf(`${path.sep}src${path.sep}`) + 5).split(path.sep).join('/');
      for (const name of ASYNC_READS) {
        for (const m of code.matchAll(new RegExp(`\\b${name}\\s*\\(`, 'g'))) {
          // The 24 characters in front of the identifier decide what this occurrence IS.
          const before = code.slice(Math.max(0, m.index - 24), m.index);
          // A DECLARATION is not a call, and neither is an import — skip both by their own shape.
          if (/\b(?:function|import|from)\s+$/.test(before)) continue;
          if (/typeof\s+$/.test(before)) continue;
          (callers[name] ??= new Set()).add(rel);
          // ⚠ THE RULE, and it is worth stating because TypeScript will not enforce it: a Promise
          // assigned to a variable and read for `.length` gives `undefined` and NOTHING THROWS —
          // the agent is handed an empty answer that looks like a real one. A call is accepted when
          // `await` or `return` stands immediately in front of it (`return` puts the caller's own
          // `await` in charge). `void` is NOT accepted: a deliberately-dropped vault read is a
          // dropped answer.
          if (!/\b(?:await|return)\s+$/.test(before)) unawaited.push(`${rel}: ${name}`);
        }
      }
    }

    // eslint-disable-next-line no-console
    console.log('ASYNC VAULT READ CENSUS  '
      + ASYNC_READS.map((n) => `${n} → ${[...(callers[n] ?? [])].sort().join(', ')}`).join(' · '));

    expect(unawaited, 'an async vault read is called without `await` — its answer reads `undefined`')
      .toEqual([]);

    // ⚠ AND THE OTHER DIRECTION, as NAMED SETS rather than counts — a new caller reds this clause and
    // its author has to come here and say that it awaits. The sets are the measured answer, not a
    // guess: my first cut asserted a `gateway/routes/vault.ts` caller for `semanticSearch` from
    // memory and reded, because that route calls `listEntries` and `getEntry` and never the semantic
    // path. The DECLARATION site is skipped by shape above, so `vault/store.ts` appearing here is a
    // real call inside the store — `createEntry`'s dedup and the embed-outage fallback.
    expect(new Set(callers['listEntriesBounded'] ?? []),
      'listEntriesBounded gained or lost a caller — name it, and say that it awaits')
      .toEqual(new Set(['vault/store.ts', 'vault/tools.ts']));
    expect([...(callers['findSemanticDuplicate'] ?? [])].sort(),
      'the dedup check is private to the store; a second caller is a design change')
      .toEqual(['vault/store.ts']);
    expect([...(callers['semanticSearch'] ?? [])].sort(),
      'semanticSearch gained or lost a caller')
      .toEqual(['memory/recall-lane.ts', 'vault/tools.ts']);
    expect([...(callers['findNearDuplicateEntry'] ?? [])].sort(),
      'the near-duplicate band check gained or lost a caller')
      .toEqual(['vault/tools.ts']);
  });
});
