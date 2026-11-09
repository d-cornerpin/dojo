// ════════════════════════════════════════════════════════════════════════════════════════
// NO EMBEDDING KIND OUTLIVES ITS PRODUCER — THE `briefing` KIND IS RETIRED.
// (t103 item D — OWNER RULING 2026-10-05, decision #6: "the briefing kind is KILLED".)
//
// ── WHAT WAS RE-VERIFIED AT `09514572` ───────────────────────────────────────────────
// `briefing` was declared in `EmbeddingSourceType` and in `EMBEDDING_SOURCE_TABLES` with ZERO
// producers, on the argument that a future lane should not have to remember the file. Nothing
// embeds a briefing: `memory/backfill.ts` enumerates `message | summary | technique`, the two
// `queueEmbedding` call sites pass `message` and `summary`, and `memory/briefing.ts` writes a
// `briefings` row and embeds nothing at all.
//
// ── THE RULE THIS FILE IS ────────────────────────────────────────────────────────────
//   §1  the CENSUS, both directions: every kind the map declares HAS a producer in the tree, and
//       every kind produced in the tree IS declared. Re-adding `briefing` without a producer
//       REDS here; so does adding a producer for a kind with no liveness table;
//   §2  no retired kind survives in the type, the map, or the SQL the search read runs;
//   §3  a LEGACY stored row of a retired kind is EXCLUDED by the read, not crashed on;
//   §4  the write tolerates an unknown kind — reports it, writes nothing, throws nothing;
//   §5  CONTROL: the `briefings` TABLE and its writer are untouched. The ruling retires an
//       embedding kind, not a feature.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

import { EMBEDDING_SOURCE_TABLES, embeddingSourceAliveSql, insertEmbeddingIfSourceAlive, UNDECLARED_EMBEDDING_KIND_WARNING, type EmbeddingSourceType } from '../embedding-sources.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../..');

/** The RETIRED kinds — the vocabulary this file refuses to let back in without a producer. */
const RETIRED = ['briefing'] as const;

// ════════════════════ §1 THE CENSUS, BOTH DIRECTIONS ════════════════════

describe('§1 every declared kind has a producer, and every producer is declared', () => {

  it('the declared set is exactly the three kinds that have producers today', () => {
    expect(Object.keys(EMBEDDING_SOURCE_TABLES).sort())
      .toEqual(['message', 'summary', 'technique']);
  });
});

// ════════════════════ §2 NOTHING NAMES THE RETIRED KIND ════════════════════

describe('§2 the retired kind survives in no type, no map and no live SQL', () => {

  it('the liveness PREDICATE names every declared kind and no retired one', () => {
    const sql = embeddingSourceAliveSql('e');
    for (const [kind, table] of Object.entries(EMBEDDING_SOURCE_TABLES)) {
      expect(sql, `${kind} has no arm in the predicate`).toContain(`e.source_type = '${kind}'`);
      expect(sql, `${kind}'s table is not joined`).toContain(`FROM ${table} src`);
    }
    for (const kind of RETIRED) {
      expect(sql, `${kind} still has an arm in the live predicate`)
        .not.toContain(`e.source_type = '${kind}'`);
    }
    // The arm count is the both-ways half: an arm for a kind that is not in the map would mean
    // the predicate and the declared map had drifted apart again.
    expect([...sql.matchAll(/source_type = '/g)].length)
      .toBe(Object.keys(EMBEDDING_SOURCE_TABLES).length);
  });
});

// ════════════════════ §3 A LEGACY ROW IS EXCLUDED, NOT FATAL ════════════════════

describe('§3 a stored row of a retired kind is excluded by the read, and nothing crashes', () => {
  function freshDb(): Database.Database {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE messages (id TEXT PRIMARY KEY);
      -- t140: the liveness predicate reads summaries.kind (a not-yet-condensed note is not
      -- embeddable); every real schema has the column since migration 002.
      CREATE TABLE summaries (id TEXT PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'leaf');
      CREATE TABLE techniques (id TEXT PRIMARY KEY);
      CREATE TABLE briefings (id TEXT PRIMARY KEY, agent_id TEXT, content TEXT);
      CREATE TABLE embeddings (
        id TEXT PRIMARY KEY, source_type TEXT, source_id TEXT, agent_id TEXT,
        content_preview TEXT, embedding BLOB, dimensions INTEGER, created_at TEXT);
    `);
    return db;
  }

  it('the predicate excludes a legacy `briefing` row EVEN WHEN its briefings row is alive', () => {
    // The fail-closed direction the leaf's own header argues for: a kind that stops being
    // searchable is visible and reported; a kind that serves rows with no liveness rule is
    // silent and indistinguishable from working.
    const db = freshDb();
    try {
      db.prepare("INSERT INTO briefings (id, agent_id, content) VALUES ('b-1', 'a-1', 'x')").run();
      db.prepare("INSERT INTO messages (id) VALUES ('m-1')").run();
      for (const [st, sid] of [['briefing', 'b-1'], ['message', 'm-1']]) {
        db.prepare(
          `INSERT INTO embeddings (id, source_type, source_id, dimensions, created_at)
           VALUES (?, ?, ?, 3, datetime('now'))`,
        ).run(`e-${sid}`, st, sid);
      }
      const rows = db.prepare(
        `SELECT e.source_type AS t FROM embeddings e WHERE ${embeddingSourceAliveSql('e')}`,
      ).all() as Array<{ t: string }>;
      expect(rows.map((r) => r.t)).toEqual(['message']);
    } finally {
      db.close();
    }
  });

  it('the predicate still RUNS — a retired kind does not make the statement unpreparable', () => {
    const db = freshDb();
    try {
      expect(() => db.prepare(
        `SELECT COUNT(*) AS c FROM embeddings e WHERE ${embeddingSourceAliveSql('e')}`,
      ).get()).not.toThrow();
    } finally {
      db.close();
    }
  });
});

// ════════════════════ §4 THE WRITE TOLERATES AND REPORTS ════════════════════

describe('§4 an unknown kind at the write is reported, not thrown', () => {
  const row = {
    id: 'e-1', sourceId: 's-1', agentId: 'a-1', preview: 'p',
    vector: Buffer.from([1, 2, 3]), dimensions: 3,
  };

  it('writes nothing, returns false, and names the kind — with no exception', () => {
    const seen: string[] = [];
    const db = {
      prepare: () => { throw new Error('the guard must refuse BEFORE any statement is built'); },
    };
    const written = insertEmbeddingIfSourceAlive(
      db,
      { ...row, sourceType: 'briefing' as unknown as EmbeddingSourceType },
      (kind) => seen.push(kind),
    );
    expect(written).toBe(false);
    expect(seen).toEqual(['briefing']);
  });

  it('a DECLARED kind still reaches the statement, so the guard is not a blanket refusal', () => {
    let sql = '';
    const db = {
      prepare: (s: string) => { sql = s; return { run: () => ({ changes: 1 }) }; },
    };
    const written = insertEmbeddingIfSourceAlive(
      db, { ...row, sourceType: 'message' }, () => { throw new Error('message is declared'); },
    );
    expect(written).toBe(true);
    expect(sql).toContain('FROM messages src');
  });

  it('the warning the caller says lives beside the guard that detects it', () => {
    expect(UNDECLARED_EMBEDDING_KIND_WARNING).toContain('declares no liveness table');
  });

  it('the report callback is OPTIONAL — a caller without one still does not throw', () => {
    const db = { prepare: () => { throw new Error('unreachable'); } };
    expect(() => insertEmbeddingIfSourceAlive(
      db, { ...row, sourceType: 'briefing' as unknown as EmbeddingSourceType },
    )).not.toThrow();
  });
});

// ════════════════════ §5 CONTROL — THE FEATURE IS NOT TOUCHED ════════════════════

describe('§5 CONTROL: the briefings table and its writer survive the retirement', () => {
  it('migrations/002 still creates the briefings table', () => {
    const sql = fs.readFileSync(path.join(SRC, 'db/migrations/002_memory_engine.sql'), 'utf-8');
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS briefings \(/);
  });

  it('migrations/175 still carries its by-name sweep of legacy `briefing` embeddings', () => {
    // Applied history, deliberately not edited: it is what cleans a box that somehow holds one.
    const sql = fs.readFileSync(path.join(SRC, 'db/migrations/175_orphaned_embeddings.sql'), 'utf-8');
    expect(sql).toMatch(/source_type = 'briefing'/);
  });
});
