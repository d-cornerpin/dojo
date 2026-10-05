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

import {
  EMBEDDING_SOURCE_TABLES, embeddingSourceAliveSql, embeddingSourceTableFor,
  insertEmbeddingIfSourceAlive, type EmbeddingSourceType,
} from '../embedding-sources.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../..');

/** The RETIRED kinds — the vocabulary this file refuses to let back in without a producer. */
const RETIRED = ['briefing'] as const;

/** Every tracked .ts under src/, tests excluded — the shipped surface. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === '__tests__' || e.name === 'node_modules') continue;
      sourceFiles(full, out);
    } else if (e.name.endsWith('.ts') && !e.name.includes('.test.')) {
      out.push(full);
    }
  }
  return out;
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

/**
 * Every embedding kind the TREE actually produces, read off the call sites with their comments
 * stripped — so a kind named only in prose is not mistaken for a producer.
 *
 * Two shapes, because the tree has two: the direct `queueEmbedding('message', …)` /
 * `storeEmbedding('summary', …)` calls, and `memory/backfill.ts`, which builds a typed union of
 * `{ type: '<kind>' as const }` items and passes `item.type` through.
 */
function producedKinds(): Set<string> {
  const kinds = new Set<string>();
  for (const file of sourceFiles(SRC)) {
    const src = stripComments(fs.readFileSync(file, 'utf-8'));
    for (const m of src.matchAll(/(?:queueEmbedding|storeEmbedding)\(\s*'([a-z-]+)'/g)) {
      kinds.add(m[1]);
    }
    if (file.endsWith(path.join('memory', 'backfill.ts'))) {
      for (const m of src.matchAll(/type:\s*'([a-z-]+)'\s+as\s+const/g)) kinds.add(m[1]);
    }
  }
  return kinds;
}

// ════════════════════ §1 THE CENSUS, BOTH DIRECTIONS ════════════════════

describe('§1 every declared kind has a producer, and every producer is declared', () => {
  it('the produced set and the declared set are EQUAL', () => {
    // The clause the retirement needed, and the one that keeps it retired. A kind re-added to
    // the map with nobody writing it reds the left side; a producer for a kind with no liveness
    // table reds the right side — and that second direction is the original defect class, a
    // kind whose dead rows serve for ever.
    const produced = [...producedKinds()].sort();
    const declared = Object.keys(EMBEDDING_SOURCE_TABLES).sort();
    expect(produced.length).toBeGreaterThan(1);
    expect(declared).toEqual(produced);
  });

  it('no RETIRED kind is declared anywhere in the map or produced anywhere in the tree', () => {
    for (const kind of RETIRED) {
      expect(Object.keys(EMBEDDING_SOURCE_TABLES), `${kind} is still declared`).not.toContain(kind);
      expect([...producedKinds()], `${kind} has gained a producer — declare it again in the same commit`)
        .not.toContain(kind);
      expect(embeddingSourceTableFor(kind), `${kind} still resolves a liveness table`).toBeNull();
    }
  });

  it('the declared set is exactly the three kinds that have producers today', () => {
    expect(Object.keys(EMBEDDING_SOURCE_TABLES).sort())
      .toEqual(['message', 'summary', 'technique']);
  });
});

// ════════════════════ §2 NOTHING NAMES THE RETIRED KIND ════════════════════

describe('§2 the retired kind survives in no type, no map and no live SQL', () => {
  const leafSrc = stripComments(
    fs.readFileSync(path.join(SRC, 'memory/embedding-sources.ts'), 'utf-8'),
  );

  it('the TYPE no longer admits it', () => {
    // Read from source with comments stripped: the retirement is explained in the prose above
    // the declaration, and a clause the prose can satisfy is a clause about the prose.
    const decl = leafSrc.match(/export type EmbeddingSourceType = ([^;]+);/);
    expect(decl, 'the type declaration moved — this census reads it by shape').toBeTruthy();
    for (const kind of RETIRED) expect(decl![1]).not.toContain(`'${kind}'`);
    expect(decl![1]).toContain("'message'");
  });

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

  it('the WRITE guard no longer indexes the map blindly', () => {
    // `EMBEDDING_SOURCE_TABLES[row.sourceType]` on an unknown kind produced `FROM undefined` and
    // threw inside a fire-and-forget write. The lookup goes through the guarded accessor now.
    expect(leafSrc).toMatch(/const table = embeddingSourceTableFor\(row\.sourceType\);/);
    expect(leafSrc).toMatch(/if \(table === null\) \{/);
  });
});

// ════════════════════ §3 A LEGACY ROW IS EXCLUDED, NOT FATAL ════════════════════

describe('§3 a stored row of a retired kind is excluded by the read, and nothing crashes', () => {
  function freshDb(): Database.Database {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE messages (id TEXT PRIMARY KEY);
      CREATE TABLE summaries (id TEXT PRIMARY KEY);
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

  it('memory/briefing.ts still writes a briefings row, and still embeds nothing', () => {
    const src = stripComments(fs.readFileSync(path.join(SRC, 'memory/briefing.ts'), 'utf-8'));
    expect(src).toMatch(/INSERT INTO briefings/);
    expect(src).not.toMatch(/queueEmbedding|storeEmbedding/);
  });
});
