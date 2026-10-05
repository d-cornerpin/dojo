// ════════════════════════════════════════════════════════════════════════════════════════
// WHAT KEEPS AN EMBEDDING ALIVE — THE DECLARED MAP (BACKLOG-CAMPAIGN, embeddings fix).
//
// ── WHY THIS EXISTS, MEASURED ON THE OWNER'S OWN BODY (45,216 rows, read-only) ──
//   message     44,883    630 ORPHANED (1.4%)
//   summary        314      0 ORPHANED
//   technique       19     15 ORPHANED (78.9%)
//   briefing         0      — declared by the type, no producer. RETIRED, see below.
// …and the search read took `content_preview` with no liveness check at all, serving it straight
// to the caller. So all 645 were live semantic hits carrying the first 200 characters of content
// the platform had already deleted.
//
// `embeddings` is POLYMORPHIC: `(source_type, source_id)` names a row in one of four different
// tables, so no foreign key can express it and SQLite cannot cascade it. Migration `081` said so
// in its own words and closed the two lanes it knew about with AFTER DELETE triggers. What it
// could not close is a lane it never named (`technique`, which had no trigger at all) or rows
// written AFTER a delete — the write-after-delete race in `embeddings.ts`, which is the mechanism
// that kept the backlog coming back for two months after `081` swept it.
//
// ── WHY A LEAF MODULE, AND IT IS NOT A STYLE PREFERENCE ──
// Three readers need this answer: the guarded INSERT (`embeddings.ts`), the search read
// (`vector-search.ts`), and the completeness census. Putting it in `embeddings.ts` made
// `vector-search.ts` depend on that module's EXPORT SURFACE — and sixteen test files replace
// `embeddings.js` with a partial `vi.mock` factory listing four functions by hand. Two of them
// broke instantly, and every future export would break more. A leaf with NO imports of its own
// cannot be caught in that crossfire, and a declared map is a leaf by nature: it makes no calls,
// holds no state, and touches no database.
// ════════════════════════════════════════════════════════════════════════════════════════

/**
 * The kinds of thing the platform embeds.
 *
 * Declared HERE, beside the map, and re-exported from `embeddings.ts` so every existing importer
 * is unaffected. The two must stay together: a kind that exists without a liveness table is a
 * kind whose dead rows serve for ever, and `Record<EmbeddingSourceType, string>` below is what
 * makes that a compile error rather than a silent hole.
 */
export type EmbeddingSourceType = 'message' | 'summary' | 'technique';

/**
 * The table whose surviving row makes an embedding of this kind still true.
 *
 * CLOSED AND EXHAUSTIVE by its own type.
 *
 * ── ⛔ `briefing` IS RETIRED (t103 item D — OWNER RULING 2026-10-05, decision #6) ──────
 * It was declared here and in the type with ZERO producers, on the argument that "a lane that
 * starts writing them must not have to remember this file". The owner's ruling is the other way
 * round, and the measurement is why: re-verified at `09514572`, nothing in the tree embeds a
 * briefing. `memory/backfill.ts` enumerates `message | summary | technique`; the two
 * `queueEmbedding` call sites pass `message` and `summary`; `memory/briefing.ts` writes a
 * `briefings` row and embeds nothing. A declared kind with no producer is not an affordance —
 * it is a liveness rule, a SQL arm, a census row and a type member that every reader of this
 * file has to understand and that no row has ever exercised. The lane that one day writes
 * briefings adds its kind back in the same commit as its producer, where the two can be read
 * together.
 *
 * The `briefings` TABLE is untouched — `memory/briefing.ts` still writes it and
 * `migrations/002` still creates it. What is gone is the claim that it backs an embedding kind.
 *
 * NO MIGRATION, verified: zero producers means zero rows, and `migrations/175` already carries a
 * by-name sweep of orphaned `source_type = 'briefing'` rows for any box that somehow holds one.
 * That file is applied history and is deliberately not edited. A legacy row that survived it is
 * handled by the read path's fail-closed arm and by `insertEmbeddingIfSourceAlive`'s unknown-kind
 * arm below: excluded and reported, never crashed on.
 *
 * Every table named here is created by the migration chain and can never be absent from a booted
 * box — which is what makes it safe for `embeddingSourceAliveSql` to name all of them
 * unconditionally in one prepared statement.
 */
export const EMBEDDING_SOURCE_TABLES: Record<EmbeddingSourceType, string> = {
  message: 'messages',
  summary: 'summaries',
  technique: 'techniques',
};

/**
 * A SQL predicate over an aliased `embeddings` row, true only while the row's source still exists.
 *
 * ⚠ FAIL-CLOSED ON A KIND NOBODY DECLARED, deliberately. The alternative — serve anything
 * unrecognised — is how this defect behaved for its whole life, and the two directions do not cost
 * the same: a kind that stops being searchable is visible and reported (the completeness census
 * fails on it), while a kind that serves dead previews is silent and indistinguishable from
 * working. Every kind the type declares is in the map above, so this arm is unreachable today.
 *
 * Values are interpolated, and that is safe BY CONSTRUCTION rather than by trust: both the keys
 * and the table names come from the closed literal map above, never from a caller, a model or a
 * row. `alias` is the only argument and every call site passes a literal.
 */
export function embeddingSourceAliveSql(alias = 'e'): string {
  const arms = Object.entries(EMBEDDING_SOURCE_TABLES).map(
    ([kind, table]) =>
      `(${alias}.source_type = '${kind}' AND EXISTS (SELECT 1 FROM ${table} src WHERE src.id = ${alias}.source_id))`,
  );
  return `(${arms.join(' OR ')})`;
}

/**
 * What a caller SAYS when an undeclared kind reaches the write — declared here, beside the guard
 * that detects it, so the sentence and the condition cannot drift apart.
 *
 * It lives in the leaf for a second reason, and it is the one BACKLOG line 30 asks about:
 * `memory/embeddings.ts` sits at its size ratchet EXACTLY, and the honest answer to "raise the
 * ceiling or extend the leaf" is to extend the leaf. That module is the vector pipeline; source
 * kinds, their liveness rules and now their refusal wording are this file's subject.
 */
export const UNDECLARED_EMBEDDING_KIND_WARNING =
  'Embedding discarded: its source kind declares no liveness table';

/** The liveness table for a kind, or `null` for one this file does not declare. The `null` is
 *  reachable only from UNTYPED callers and from legacy stored rows (the retired `briefing` kind
 *  is the one that has ever existed); every typed caller gets a string. */
export function embeddingSourceTableFor(kind: string): string | null {
  return Object.prototype.hasOwnProperty.call(EMBEDDING_SOURCE_TABLES, kind)
    ? EMBEDDING_SOURCE_TABLES[kind as EmbeddingSourceType]
    : null;
}

/** The narrow database surface this leaf needs, so it stays import-free: the caller passes its
 *  own handle rather than this module reaching for a connection. */
interface EmbeddingWriteDb {
  prepare(sql: string): { run(...params: unknown[]): { changes: number } };
}

/** One embedding, ready to write. */
export interface EmbeddingRow {
  id: string;
  sourceType: EmbeddingSourceType;
  sourceId: string;
  agentId: string | null;
  preview: string;
  vector: Buffer;
  dimensions: number;
}

/**
 * WRITE AN EMBEDDING ONLY WHILE ITS SOURCE IS STILL THERE. Returns false when the source has
 * gone, which is not an error — it is the correct outcome.
 *
 * ── WHY THIS IS ONE STATEMENT AND NOT A CHECK FOLLOWED BY AN INSERT ──
 * This is the fix for the whole orphan class. `queueEmbedding` is fire-and-forget and
 * `storeEmbedding` `await`s a model call taking seconds before it writes. Delete the source inside
 * that window — a project-manager history trim, an Imaginer wipe, the behavioural harness teardown,
 * all of which run constantly — and the AFTER DELETE trigger fires while there is still NOTHING to
 * delete; the later INSERT then lands a row no trigger can ever reach again. That is why migration
 * `081`'s sweep did not hold: it cleaned the backlog, and the race went on minting it (measured:
 * 221 in July, 350 in August, 59 in September, newest on the day of this fix).
 *
 * A `SELECT` and then an `INSERT` would leave exactly the same window, only narrower — and
 * "narrower" is what kept this invisible for months. `INSERT … SELECT … WHERE EXISTS` decides the
 * source's liveness and writes the row together, or does neither.
 */
export function insertEmbeddingIfSourceAlive(
  db: EmbeddingWriteDb,
  row: EmbeddingRow,
  /** Reported, not thrown, when a kind this file does not declare reaches the write. Injected so
   *  the leaf keeps its no-imports property (the same discipline `prompt/assembler.ts` uses for
   *  its last-resort path). */
  onUnknownKind?: (kind: string) => void,
): boolean {
  // ⚠ TOLERATE AND REPORT, NEVER CRASH (t103 item D). Before the retired `briefing` kind there
  // was no arm here at all: an unknown kind produced `FROM undefined` and threw inside a
  // fire-and-forget write. An untyped caller, or a legacy row replayed through a backfill, must
  // not be able to take a turn down with it — and writing nothing is the fail-closed direction
  // the whole module is built on.
  const table = embeddingSourceTableFor(row.sourceType);
  if (table === null) {
    onUnknownKind?.(row.sourceType);
    return false;
  }
  const result = db.prepare(`
    INSERT INTO embeddings (id, source_type, source_id, agent_id, content_preview, embedding, dimensions, created_at)
    SELECT ?, ?, ?, ?, ?, ?, ?, datetime('now')
     WHERE EXISTS (SELECT 1 FROM ${table} src WHERE src.id = ?)
  `).run(
    row.id, row.sourceType, row.sourceId, row.agentId, row.preview,
    row.vector, row.dimensions, row.sourceId,
  );
  return result.changes > 0;
}
