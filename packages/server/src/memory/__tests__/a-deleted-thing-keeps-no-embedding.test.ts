// ════════════════════════════════════════════════════════════════════════════════════════
// AN EMBEDDING MUST NOT OUTLIVE THE THING IT DESCRIBES (BACKLOG-CAMPAIGN).
//
// ── WHAT WAS MEASURED ON THE OWNER'S OWN BODY, read-only, 45,216 embedding rows ──
//   message     44,883    630 ORPHANED (1.4%)
//   summary        314      0 ORPHANED
//   technique       19     15 ORPHANED (78.9%)
//   briefing         0      — declared by the type, no producer yet
// …and `vector-search.ts` took `content_preview` with NO liveness check, serving it straight to
// the caller. So all 645 were live semantic hits carrying the first 200 characters of content the
// platform had already deleted.
//
// ── THE TWO WRONG ANSWERS THIS FILE EXISTS TO STOP A FUTURE READER BELIEVING ──
// (1) "Nothing cleans up on delete." Something does: `messages_embed_ad` and
//     `summaries_embed_ad` have existed since migration `081`, every `messages` rebuild
//     re-creates them, and they work — which is exactly why `summary` sits at zero. §2 proves
//     they fire through all three real doors.
// (2) "The four `messages` rebuilds lost them." `DROP TABLE` really does not fire an AFTER
//     DELETE trigger, but the dates refute it as the CAUSE: rebuilds all ran 2026-07-28, while
//     the orphans are dated 2026-07-27 → 2026-09-26 and still arriving (221 July, 350 August,
//     59 September). A one-time event does not trickle for two months.
//
// ── THE ACTUAL MECHANISM: A WRITE-AFTER-DELETE RACE, reproduced live in §1 ──
// `queueEmbedding` is fire-and-forget; `storeEmbedding` `await`s a model call taking seconds and
// INSERTs afterwards. Delete the source inside that window and the trigger fires while there is
// still nothing to delete — then the INSERT lands a row no trigger can ever reach. The
// distribution is the signature: the harness bot 443, the project manager 92, the primary 84,
// i.e. exactly the agents whose histories are trimmed and wiped constantly.
//
// §1 does not simulate that race, it RUNS it: the embedding backend is stubbed behind a gate the
// test opens by hand, so the delete lands strictly between the `await` and the INSERT.
//
// ── THREE LAYERS, AND EACH IS TESTED FOR THE THING ONLY IT CAN DO ──
//   §1 the INSERT is `INSERT … SELECT … WHERE EXISTS` — liveness and write in ONE statement, so
//      the race has no window rather than a narrower one.
//   §2/§3 the cascades — the covered lanes, and the `technique` lane that had no trigger at all.
//   §4 the serve side — an orphan that arrives by a route no trigger can see (a `DROP TABLE`)
//      still cannot be SERVED. This is the only layer that promises anything about rows that
//      already exist, which is why it is not redundant with §1-§3.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
  getDbPath: () => ':memory:',
  closeDb: vi.fn(),
}));

import { runMigrations } from '../../db/migrations.js';
import { storeEmbedding } from '../embeddings.js';
import { EMBEDDING_SOURCE_TABLES, type EmbeddingSourceType } from '../embedding-sources.js';
import { vectorSearch } from '../vector-search.js';
import {
  deleteAllForAgent, deleteForAgentBefore, deleteNonSystemForAgent,
} from '../message-store.js';

const AGENT = 'agent-emb';
const DIMS = 8;

let tmpDir: string;

/** A deterministic unit vector of DIMS floats — the stub backend's answer. */
const VEC = Array.from({ length: DIMS }, (_, i) => (i === 0 ? 1 : 0));

/** Gate the stubbed backend so a delete can land strictly inside the `await`. */
let releaseEmbed: (() => void) | null = null;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dojo-emb-orphan-'));
  mockDb.current = new Database(path.join(tmpDir, 'dojo.db'));
  mockDb.current.pragma('foreign_keys = ON');
  runMigrations();

  releaseEmbed = null;
  vi.stubGlobal('fetch', async () => {
    if (releaseEmbed) {
      await new Promise<void>((resolve) => { releaseEmbed = resolve; });
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ embedding: VEC }),
      text: async () => '',
    } as unknown as Response;
  });

  const db = mockDb.current;
  db.prepare("INSERT INTO agents (id, name, status) VALUES (?, 'Emb', 'idle')").run(AGENT);
});

afterEach(() => {
  vi.unstubAllGlobals();
  mockDb.current?.close();
  mockDb.current = null;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const db = (): Database.Database => mockDb.current!;

function seedMessage(id: string, role = 'user'): string {
  db().prepare('INSERT INTO messages (id, agent_id, role, content) VALUES (?, ?, ?, ?)')
    .run(id, AGENT, role, `a message long enough to be embedded: ${id}`);
  return id;
}

function seedSummary(id: string): string {
  db().prepare(`
    INSERT INTO summaries (id, agent_id, depth, kind, content, token_count, earliest_at, latest_at)
    VALUES (?, ?, 0, 'rollup', ?, 20, datetime('now'), datetime('now'))
  `).run(id, AGENT, `a summary long enough to be embedded: ${id}`);
  return id;
}

function seedTechnique(id: string): string {
  db().prepare(`
    INSERT INTO techniques (id, name, description, state, directory_path)
    VALUES (?, ?, ?, 'published', ?)
  `).run(id, id, `a technique description long enough to embed: ${id}`, `/tmp/none/${id}`);
  return id;
}

/** An embedding row written DIRECTLY — the shape a `DROP TABLE` leaves behind, which no
 *  trigger and no guarded INSERT can ever have seen. */
function plantEmbedding(sourceType: string, sourceId: string): string {
  const id = `emb-${sourceType}-${sourceId}`;
  db().prepare(`
    INSERT INTO embeddings (id, source_type, source_id, agent_id, content_preview, embedding, dimensions)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, sourceType, sourceId, AGENT,
    `SECRET-PREVIEW-${sourceId}`,
    Buffer.from(new Float32Array(VEC).buffer), DIMS);
  return id;
}

const embCount = (sourceType: string, sourceId: string): number =>
  (db().prepare('SELECT COUNT(*) AS c FROM embeddings WHERE source_type = ? AND source_id = ?')
    .get(sourceType, sourceId) as { c: number }).c;

// ════════════════════════════════════════════════════════════════════════════════════════
describe('§1 the write-after-delete race — RUN, not simulated', () => {
  it('a source deleted WHILE its embedding is being computed leaves NO row', async () => {
    const id = seedMessage('m-race');

    // Hold the backend open so the delete lands strictly between the await and the INSERT.
    releaseEmbed = () => {};
    const inFlight = storeEmbedding('message', id, AGENT, 'content long enough to embed for real');
    await vi.waitFor(() => { if (typeof releaseEmbed !== 'function') throw new Error('not gated yet'); });

    // The delete happens now — the trigger fires while there is still nothing to delete.
    expect(deleteAllForAgent(AGENT), 'the door really deleted the message').toBe(1);
    expect(embCount('message', id), 'and there was nothing for the trigger to clean').toBe(0);

    // Let the embedding finish. THIS is the INSERT that used to land an unreachable orphan.
    (releaseEmbed as unknown as () => void)();
    await inFlight;

    expect(
      embCount('message', id),
      'an embedding whose source died mid-flight must not be written at all',
    ).toBe(0);
  });

  it('CONTROL: the same call with the source still alive DOES write', async () => {
    const id = seedMessage('m-live');
    await storeEmbedding('message', id, AGENT, 'content long enough to embed for real');
    expect(embCount('message', id), 'the guard must not have broken the happy path').toBe(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
describe('§2 every real message-delete door takes the embedding with it', () => {
  it('deleteAllForAgent', async () => {
    const id = seedMessage('m-all');
    await storeEmbedding('message', id, AGENT, 'content long enough to embed for real');
    expect(embCount('message', id)).toBe(1);
    deleteAllForAgent(AGENT);
    expect(embCount('message', id), 'the embedding died with its message').toBe(0);
  });

  it('deleteForAgentBefore (the project manager\'s bounded history)', async () => {
    const older = seedMessage('m-older');
    const cutoff = seedMessage('m-cutoff');
    await storeEmbedding('message', older, AGENT, 'content long enough to embed for real');
    expect(embCount('message', older)).toBe(1);
    deleteForAgentBefore(AGENT, cutoff);
    expect(embCount('message', older), 'the trimmed message took its embedding').toBe(0);
  });

  it('deleteNonSystemForAgent (the wipe that keeps identity rows)', async () => {
    const sys = seedMessage('m-sys', 'system');
    const chat = seedMessage('m-chat', 'user');
    await storeEmbedding('message', sys, AGENT, 'content long enough to embed for real');
    await storeEmbedding('message', chat, AGENT, 'content long enough to embed for real');
    deleteNonSystemForAgent(AGENT);
    expect(embCount('message', chat), 'the wiped message took its embedding').toBe(0);
    expect(embCount('message', sys), 'and the kept system row kept its own').toBe(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
describe('§3 the technique lane — the one with no cascade at all', () => {
  it('a raw technique delete cleans its embedding (the trigger migration 081 never wrote)', async () => {
    const id = seedTechnique('t-one');
    await storeEmbedding('technique', id, null, 'a technique description long enough to embed');
    expect(embCount('technique', id)).toBe(1);

    // Deliberately NOT through `techniques/store.ts`: that path already deleted the embedding in
    // application code, and app-code-only is what 78.9% orphaned measures out to. This is any
    // OTHER route to the same row — a migration, a repair, a future caller.
    db().prepare('DELETE FROM techniques WHERE id = ?').run(id);
    expect(embCount('technique', id), 'the cascade covers the lane, not just the one door').toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
describe('§4 an orphan that no trigger could have seen still cannot SERVE', () => {
  it('a planted orphan is never returned, while a live sibling is', async () => {
    // Live row, through the real path.
    const live = seedMessage('m-served');
    await storeEmbedding('message', live, AGENT, 'content long enough to embed for real');
    // Orphan, planted directly — the shape a DROP TABLE leaves.
    plantEmbedding('message', 'm-vanished');

    expect(embCount('message', 'm-vanished'), 'the orphan really is in the table').toBe(1);

    const hits = await vectorSearch('anything', AGENT, {
      queryEmbedding: new Float32Array(VEC), minSimilarity: 0, limit: 50,
    });
    const ids = hits.map((h) => h.sourceId);

    expect(ids, 'the live embedding still serves — the filter is not a blanket').toContain(live);
    expect(ids, 'a deleted message may not come back as a semantic hit').not.toContain('m-vanished');
    expect(
      JSON.stringify(hits),
      'and its preview — the first 200 chars of deleted content — reaches no caller',
    ).not.toContain('SECRET-PREVIEW-m-vanished');
  });

  it('the other kinds are unaffected in BOTH directions', async () => {
    const s = seedSummary('s-live');
    const t = seedTechnique('t-live');
    await storeEmbedding('summary', s, AGENT, 'a summary long enough to be embedded here');
    await storeEmbedding('technique', t, null, 'a technique description long enough to embed');
    plantEmbedding('summary', 's-gone');

    const hits = await vectorSearch('anything', undefined, {
      queryEmbedding: new Float32Array(VEC), minSimilarity: 0, limit: 50,
    });
    const ids = hits.map((h) => h.sourceId);
    expect(ids, 'a live summary still serves').toContain(s);
    expect(ids, 'a live technique still serves').toContain(t);
    expect(ids, 'a dead summary does not').not.toContain('s-gone');
  });

  it('deleting a message touches no OTHER kind\'s embeddings', async () => {
    const m = seedMessage('m-x');
    const s = seedSummary('s-x');
    const t = seedTechnique('t-x');
    await storeEmbedding('message', m, AGENT, 'content long enough to embed for real');
    await storeEmbedding('summary', s, AGENT, 'a summary long enough to be embedded here');
    await storeEmbedding('technique', t, null, 'a technique description long enough to embed');

    deleteAllForAgent(AGENT);

    expect(embCount('message', m), 'the message embedding went').toBe(0);
    expect(embCount('summary', s), 'the SUMMARY embedding survived — the risk this fix had to avoid').toBe(1);
    expect(embCount('technique', t), 'the TECHNIQUE embedding survived too').toBe(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
describe('§6 the sweep clears the existing backlog — and is not a blanket delete', () => {
  // The cascades and the guarded INSERT only govern rows written from NOW ON. The 645 rows
  // already on the owner's body are this migration's job, and the danger of a cleanup migration
  // is not that it deletes too little — it is that it deletes something unrecoverable. So the
  // migration's own SQL is driven here, against planted orphans AND against a row of a kind it
  // has never heard of, which must survive it.
  const MIGRATION = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    '../../db/migrations/175_orphaned_embeddings.sql',
  );

  it('deletes the orphans of every declared kind, and spares live rows and unknown kinds', async () => {
    // Live rows, through the real path.
    const liveMsg = seedMessage('m-keep');
    const liveSum = seedSummary('s-keep');
    await storeEmbedding('message', liveMsg, AGENT, 'content long enough to embed for real');
    await storeEmbedding('summary', liveSum, AGENT, 'a summary long enough to be embedded here');

    // Orphans of each declared kind, planted as a DROP TABLE would leave them.
    plantEmbedding('message', 'm-dead');
    plantEmbedding('summary', 's-dead');
    plantEmbedding('technique', 't-dead');
    plantEmbedding('briefing', 'b-dead');
    // …and a kind this migration has never heard of. Deleting this would be the unrecoverable
    // mistake, so it is a control, not an afterthought.
    plantEmbedding('some-future-kind', 'f-1');

    db().exec(fs.readFileSync(MIGRATION, 'utf8'));

    expect(embCount('message', 'm-dead'), 'the message orphans are swept').toBe(0);
    expect(embCount('summary', 's-dead'), 'the summary orphans are swept').toBe(0);
    expect(embCount('technique', 't-dead'), 'the technique orphans are swept').toBe(0);
    expect(embCount('briefing', 'b-dead'), 'the briefing orphans are swept').toBe(0);

    expect(embCount('message', liveMsg), 'a LIVE message embedding survives the sweep').toBe(1);
    expect(embCount('summary', liveSum), 'a LIVE summary embedding survives the sweep').toBe(1);
    expect(
      embCount('some-future-kind', 'f-1'),
      'a kind the sweep does not know must SURVIVE it — a blanket delete here is unrecoverable',
    ).toBe(1);
  });

  it('is idempotent: running it twice changes nothing the second time', () => {
    const live = seedMessage('m-idem');
    plantEmbedding('message', 'm-idem-dead');
    const sql = fs.readFileSync(MIGRATION, 'utf8');
    db().exec(sql);
    const after1 = (db().prepare('SELECT COUNT(*) AS c FROM embeddings').get() as { c: number }).c;
    db().exec(sql);
    const after2 = (db().prepare('SELECT COUNT(*) AS c FROM embeddings').get() as { c: number }).c;
    expect(after2, 'a re-run is a no-op').toBe(after1);
    expect(embCount('message', 'm-idem-dead')).toBe(0);
    expect(live).toBeTruthy();
  });
});

describe('§5 the declared map is complete, and every table it names is real', () => {
  it('every source kind the type admits has a liveness table', () => {
    // The `Record<EmbeddingSourceType, string>` type makes this a compile error too; this is the
    // runtime half, and it is what fails when a kind is added with an empty or wrong table.
    const kinds: EmbeddingSourceType[] = ['message', 'summary', 'briefing', 'technique'];
    for (const k of kinds) {
      expect(EMBEDDING_SOURCE_TABLES[k], `${k} declares no liveness table`).toBeTruthy();
    }
    expect(
      Object.keys(EMBEDDING_SOURCE_TABLES).sort(),
      'the map and the type must name the same kinds — a kind missing here serves dead rows for ever',
    ).toEqual([...kinds].sort());
  });

  it('each named table exists in the real schema and has the id column the predicate joins on', () => {
    for (const [kind, table] of Object.entries(EMBEDDING_SOURCE_TABLES)) {
      const row = db().prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      ).get(table);
      expect(row, `${kind} names table "${table}", which does not exist`).toBeTruthy();
      const cols = (db().prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
        .map((c) => c.name);
      expect(cols, `${table} has no id column to check liveness against`).toContain('id');
    }
  });
});
