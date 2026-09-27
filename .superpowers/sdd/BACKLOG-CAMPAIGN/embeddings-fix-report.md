# EMBEDDINGS: A DELETED THING KEEPS NO EMBEDDING

**Branch:** `t86-embeddings`, based `e0c44fa6` (`t86-backlog` tip) · **SHA:** `a5d698d5`
**Worktree:** `…/scratchpad/emb` · **Date:** 2026-09-26

**Verified:** full server suite **492 files / 7410 tests** · `npm run typecheck` exit 0 ·
`packages/dashboard` `tsc --noEmit` exit 0 · **`npm run gates` exit 0, 15/15 blocking green** ·
**seven mutants, each RED** · migration dry-run on a consistent backup of the live body.
6 files, +605/−17. **No `ratchets.json`, no gate-manifest, no `definitions.ts` edits.**

---

## ⚠ FIRST: MY OWN LANE-4 CLAIM WAS WRONG IN ITS CENTRAL CLAIM

I reported this as *"embeddings have no FK/cascade to messages; no message-delete path cleans
them."* Re-derived against this tip, **the cascade exists.**

`messages_embed_ad` and `summaries_embed_ad` are AFTER DELETE triggers that have shipped since
migration **`081_fts_sync_and_orphan_cleanup.sql`** (applied on this body 2026-07-02). All four
`messages` rebuilds (`127`/`131`/`132`/`133`) drop and re-create them. **They work** — which is
exactly why `summary` sits at zero orphans, and §2 of the new test proves they fire through all
three real doors.

How I got it wrong: I grepped for foreign keys (`REFERENCES messages` in `*embed*` migrations) and
for `embedding` inside `message-store.ts`. Both greps were accurate and both missed a TRIGGER,
which is neither. `081`'s own comment even states the FK problem and its solution. **The lesson for
the campaign: "no cascade" cannot be concluded from the absence of an FK in a schema that cannot
have one.**

The defect is real; its mechanism was not what I said.

---

## POPULATION BY KIND — measured read-only on the owner's body

| `source_type` | rows | orphaned | % | keyed by |
|---|---|---|---|---|
| `message` | 44,883 | **630** | 1.4% | `messages.id` |
| `summary` | 314 | 0 | 0% | `summaries.id` |
| `technique` | 19 | **15** | **78.9%** | `techniques.id` |
| `briefing` | 0 | — | — | `briefings.id` (declared by the type, **no producer**) |
| **total** | **45,216** | **645** | 1.4% | |

Nothing keys `vault_entries`: the engine never embeds a vault entry, so the kit sweep's
`orphanSources` lane over vault ids matches nothing the engine creates.

**And the serve side did not care.** `vector-search.ts` selected `content_preview` with no
liveness check and returned it as `preview`, so all 645 were live semantic hits carrying the
first 200 characters of content the platform had already deleted.

---

## ROOT CAUSE — a write-after-delete race, and the second wrong answer discarded

**The tempting second answer is the rebuilds.** `DROP TABLE` genuinely does not fire an AFTER
DELETE trigger, and `131`/`132` say exactly that in their own headers. **The dates refute it.**
The rebuilds all ran 2026-07-28. The orphans are dated 2026-07-27 → 2026-09-26 and were **still
arriving**:

```
2026-07  221      2026-08  350      2026-09   59      newest: the day of this fix
```

A one-time event does not trickle for two months.

**The mechanism.** `queueEmbedding` is fire-and-forget by design. `storeEmbedding` then
(1) checks dedup, (2) `await`s `generateEmbedding` — an Ollama call taking seconds — and
(3) INSERTs. Delete the source inside that window and the trigger fires while there is **still
nothing to delete**; the later INSERT lands a row no trigger can ever reach again.

The distribution is the signature — exactly the agents whose histories are trimmed and wiped
constantly: harness bot **443**, project manager **92**, primary **84**.

This is why `081`'s sweep did not hold. It cleaned the backlog; the race went on minting it.
**Live corroboration:** between two measurements an hour apart in this session the count moved
645 → 646.

**`technique` is proportionally far worse because it had no trigger at all.** Its cleanup lives in
application code (`techniques/store.ts`, inside a `withUnit` transaction) — correct, and it only
ever protects that ONE path. **78.9% is what app-code-only cleanup measures out to in practice.**

---

## THE FIX — three layers, each doing only what it alone can

### 1. The race, closed **in the statement** — `memory/embedding-sources.ts`

`insertEmbeddingIfSourceAlive` writes through `INSERT … SELECT … WHERE EXISTS`, so the source's
liveness and the row are decided **together or not at all**. A `SELECT` then an `INSERT` would
leave the same window open, only narrower — and "narrower" is precisely what kept this invisible
for months.

### 2. The missing cascade — `techniques_embed_ad` (migration `175`)

Same shape and idiom as `081`'s two, so the three lanes read identically. `briefing` deliberately
gets none: nothing writes one, and a trigger on a table with no producer is a claim rather than a
guard. The declared map covers it on the serve side.

### 3. The serve side — `vector-search.ts`

An embedding may not serve unless its source is alive. **Not redundant with 1 and 2:** a trigger
cannot fire for a row lost to a `DROP TABLE`, so cleanup can only ever promise *"clean right
now"*, while this promises *"cannot serve, however it got here"*. It is the only layer that says
anything about rows that already exist.

### Why not an FK — the question a reader will ask

`embeddings` is **polymorphic**: `source_id` names a row in one of four tables depending on
`source_type`. No single-table foreign key can express that, and SQLite cannot cascade it. `081`
reached the same conclusion. Hence one **declared map** (`EMBEDDING_SOURCE_TABLES`) read by all
three layers, with a completeness census that fails when a kind arrives without a liveness rule —
and `Record<EmbeddingSourceType, string>` makes the same omission a compile error.

**Fail-closed on an undeclared kind, deliberately:** a kind that stops being searchable is visible
and the census fails on it; a kind that serves dead previews is silent and indistinguishable from
working. Interpolation into SQL is safe **by construction** — keys and table names come from a
closed literal map, never from a caller, model or row.

### Why the map is a LEAF and not part of `embeddings.ts`

Sixteen test files replace `embeddings.js` with a partial `vi.mock` factory listing four functions
by hand. A declared map living there put `vector-search.ts` at the mercy of that mock surface and
**broke two files immediately**; every future export would break more. A leaf with no imports of
its own cannot be caught in that crossfire.

---

## PER-DOOR PROOF — one line each

All from `memory/__tests__/a-deleted-thing-keeps-no-embedding.test.ts` (13 clauses, real
migrations, real triggers, a real gated backend).

| Door / property | Result |
|---|---|
| **THE RACE, run not simulated** — backend held open, `deleteAllForAgent` lands strictly between the `await` and the INSERT | **no row written** ✓ |
| CONTROL — same call, source alive | row written ✓ (the guard did not break the happy path) |
| `deleteAllForAgent` (agent deletion, the three singletons' self-reset) | embedding gone ✓ |
| `deleteForAgentBefore` (project manager's bounded history) | embedding gone ✓ |
| `deleteNonSystemForAgent` (wipe that keeps identity rows) | wiped row's embedding gone, **kept system row keeps its own** ✓ |
| raw `DELETE FROM techniques` (any route, not just `store.ts`) | embedding gone ✓ — the new trigger |
| **orphan planted directly** (the shape a `DROP TABLE` leaves) | **not served**, and `SECRET-PREVIEW-…` reaches no caller ✓ |
| live sibling alongside that orphan | **still served** ✓ (the filter is not a blanket) |
| message delete vs **other kinds** | summary embedding **survives**, technique embedding **survives** ✓ |
| live summary + live technique via search | both still served ✓; dead summary not ✓ |
| sweep: orphans of all four kinds | swept ✓; **live rows and an undeclared `some-future-kind` SURVIVE** ✓ |
| sweep re-run | idempotent ✓ |
| declared map | complete vs the type ✓; every named table exists with an `id` column ✓ |

### Migration dry-run — consistent backup of the live body (`sqlite3` backup API, WAL-complete)

```
BEFORE  embeddings 45,274   orphans {message 630, summary 0, technique 15, briefing 0} = 645
AFTER   embeddings 44,628   orphans {message   0, summary 0, technique  0, briefing 0} = 0
DELETED 646            apply 0.099 s            idempotent across 3 applications
ONLY `embeddings` changed — messages 49,591 · summaries 318 · techniques 4 · briefings 0 ·
                            vault_entries 97 · summary_messages 8,520  ALL UNCHANGED
integrity_check ok
foreign_key_check 20 BEFORE → 20 AFTER (summary_messages 19, adjudications 1) — delta 0,
                  none in `embeddings`, none introduced here
triggers present after: messages_embed_ad · summaries_embed_ad · techniques_embed_ad
```

### Mutants — seven, each RED, restored GREEN

| Mutant | Result |
|---|---|
| Race guard reverted to a plain `VALUES` insert (**the original bug**) | RED |
| Serve-side liveness predicate removed | RED |
| `techniques_embed_ad` statement removed | RED |
| Liveness map points `summary` at the `messages` table | RED |
| Sweep made a blanket `DELETE FROM embeddings` | RED |
| Technique sweep dropped (`081`'s original blind spot) | RED |
| `briefing` dropped from the map (incomplete map) | RED |

Two earlier mutant attempts were **no-ops** (a trigger *renamed* rather than removed, so it still
fired) and I caught both by asserting the edit landed before trusting the green. Recorded because
"mutant survived" and "mutant never applied" look identical in a pass count.

---

## STABLE-BRIDGE ENTRY — DRAFT for the coordinator

Append to the index table (after the `172` row):

```
| `173_orphaned_agent_side_rows.sql` | **55** | BACKLOG LANE-1 |
| `174_provider_measured_chars_per_token.sql` | **—** | ⚠ NO ENTRY FOUND — see note |
| `175_orphaned_embeddings.sql` | **56** | BACKLOG-CAMPAIGN embeddings fix |
```

⚠ **Two index gaps found while drafting, neither mine:** `173` has Entry 55 in the body but **no
index row**, and `174_provider_measured_chars_per_token.sql` appears to have **neither**. The index
carries its own warning that it had stopped being appended at Entry 40; it looks to have fallen
behind again. Flagging rather than fixing — not my file to edit.

---

### Entry 56 — `175_orphaned_embeddings.sql` — AN EMBEDDING THAT OUTLIVED THE THING IT DESCRIBES

| | |
|---|---|
| **Migration** | `packages/server/src/db/migrations/175_orphaned_embeddings.sql` — local, shipped, runs on every box |
| **Bridge** | Chain number unchanged (175 follows 174). Not a `<NNN>b` bridge file, so the string-sort caveat does not apply |
| **Landed by** | BACKLOG-CAMPAIGN, 2026-09-26, from lane-4 concern 2 — **whose framing this entry corrects** |
| **Change class** | ⚠ **DESTRUCTIVE** + one DDL. Four `DELETE`s, each predicated on `NOT IN` against a named parent table, plus `CREATE TRIGGER IF NOT EXISTS techniques_embed_ad` |
| **Touches** | `embeddings` rows whose source row is gone, **per kind and by name** (`message`→`messages`, `summary`→`summaries`, `technique`→`techniques`, `briefing`→`briefings`) → DELETED. A row of any OTHER `source_type` → **UNTOUCHED, deliberately**. New AFTER DELETE trigger on `techniques` |
| **Destructive?** | Yes, and only of rows already unreachable as truth — every one described a row that no longer exists |
| **Sha256 (file at commit)** | `4f1d65eea9525b646e9f086b3360099a250e27862c2c78edae36c7557ebb6612` |

**Measured** (backup-API copy, WAL-complete, read-only source): `embeddings` 45,274 → 44,628
(**−646**); `messages` 49,591, `summaries` 318, `techniques` 4, `briefings` 0, `vault_entries` 97,
`summary_messages` 8,520 — **all unchanged**. Apply **0.099 s**, `integrity_check` ok, idempotent
across three applications. `foreign_key_check` 20 → 20 (`summary_messages` 19, `adjudications` 1,
both pre-existing and out of scope).

**Where the orphans came from — NOT the missing cascade, and NOT the rebuilds.** The cascade has
existed since `081` and works (`summary` = 0 is the control). The rebuilds ran 2026-07-28 while
the orphans span 2026-07-27 → 2026-09-26 and were still arriving. The cause is a
**write-after-delete race** in `memory/embeddings.ts`: `queueEmbedding` is fire-and-forget and
`storeEmbedding` `await`s a model call before its INSERT, so a source deleted in that window has
its trigger fire against nothing and the later INSERT lands an unreachable row. Distribution
confirms it (harness bot 443, project manager 92, primary 84). **This migration only cleans up;
the engine fix in the same commit stops the minting** (`INSERT … SELECT … WHERE EXISTS`).

**Per kind and by NAME, never a blanket delete**: silently deleting the embeddings of a
`source_type` added after this file was written is the one unrecoverable mistake a cleanup
migration can make. A mutant replacing the summary arm with `DELETE FROM embeddings` is RED.

**`NOT IN` is safe here** (unlike Entry 55's `NOT EXISTS` requirement): the subqueries are
`SELECT id FROM <table>` over `TEXT PRIMARY KEY` columns.

⚠ **LEDGER NOTE, 2026-09-26 (final sweep A / E-F1): the SAFETY ARGUMENT AS WRITTEN WAS WRONG ON
THREE OF THE FOUR TABLES, and the failure direction is the benign one.** The sentence claimed the id
columns are NOT NULL by schema. Measured by the reviewer: `messages.id` really is
`TEXT NOT NULL UNIQUE`, but **`summaries.id`, `techniques.id` and `briefings.id` are bare
`TEXT PRIMARY KEY`** — and SQLite, in a non-STRICT table with a non-INTEGER primary key, **accepts a
NULL** (demonstrated empirically). So the guarantee is not the schema's; it rests on "no writer ever
inserts a NULL id".

**Why nothing is broken, and why this is a note rather than a fix:** one NULL in a `NOT IN` list makes
the predicate delete **0 rows** (also measured) — it can SILENCE the sweep, never eat a live row — and
the live census is 0 NULL ids in all four tables, so the sweep behaved correctly as shipped. The
migration is not touched: **`NOT EXISTS`, which migration 176 already uses, has no such dependency**,
so the idiom to reach for next time is the one already in the tree. The claim above is corrected to
what the schema actually says; the safety of the shipped migration is unchanged.

**Guard:** `memory/__tests__/a-deleted-thing-keeps-no-embedding.test.ts` — 13 clauses over real
migrations and real triggers, including a **live reproduction of the race** (gated backend, delete
landing between the `await` and the INSERT), per-door proof for all three message doors, the
technique lane, both directions on the other kinds, and an undeclared-kind survival control.
Mutation-proven seven ways.

**ROLLBACK: none, and none is wanted.** Deleting unreachable rows has no inverse; removing the
marker only re-runs a file whose predicates then match nothing. The trigger is
`IF NOT EXISTS`, so a re-run is a no-op. What must be kept is the **engine** half — the guarded
INSERT — which is what stops new orphans; reverting that alone would restart the leak while the
sweep made the count look healthy.

---

## CONCERNS

1. **My lane-4 framing was wrong and is corrected above.** If any other lane took "no
   FK/cascade" at face value, it is worth re-checking. The general lesson: in a polymorphic table
   an FK *cannot* exist, so its absence proves nothing — look for triggers.
2. **The engine fix matters more than the migration, and they must not be separated.** The sweep
   without the guarded INSERT would clean 646 rows and the leak would refill them, exactly as
   `081` did for two months. If anything gets cherry-picked, take the code, not the migration.
3. **Raise argued, not taken: `embeddings.ts` is at its 319-line pin exactly.** The gate refused
   my +33 and I moved the code to the leaf instead, which is where it belonged — so no raise is
   needed *now*. But the file is at its ceiling with zero headroom, and the next person to touch
   it will face the same wall with less obvious somewhere-else to go. **Candidate: a deliberate
   ceiling raise for `packages/server/src/memory/embeddings.ts` in a gate-side-only commit**, or
   a decision that the module is finished and future work extends the leaf.
4. **Two STABLE-BRIDGE index gaps** (`173` body-only, `174` apparently absent) — flagged in the
   draft above, not fixed.
5. **One existing test fixture changed.** `an-absent-embedder-is-one-warn-not-a-hundred-errors`
   asserted an embedding lands for a source id it never created — now correctly refused. It gained
   a minimal `messages` table and one row; its subject (the warn latch) is untouched, and the
   absence cases never reach the INSERT at all.
6. **Pre-existing, out of scope, worth a ticket:** `foreign_key_check` on the live body reports 20
   violations — `summary_messages`→`messages` **19** and `adjudications` **1**. Unchanged by this
   work (delta 0) and unrelated to embeddings. Entry 55 already noted the `summary_messages` 19 as
   out of its scope too; nobody owns them yet.
7. **`briefing` is a declared source kind with no producer** (0 rows, `EmbeddingSourceType` admits
   it, `briefings` table exists). Covered on the serve side and in the sweep, given no trigger on
   purpose. Either a lane should start writing them or the kind should be retired — an owner call,
   not a defect.
8. **The flake family bit once.** One full-suite run showed 1 failure + 1 `[vitest-worker]`
   error; the immediate re-run was **492/7410 fully green**, and the final post-relocation run was
   green as well. Concurrent lanes on one box amplify BACKLOG line 53. A red suite still needs
   isolation before it is believed.
9. **The `@dojo/shared` shadow trap was pre-empted** (worktree-local `@dojo` scope under both
   `packages/server/node_modules` and `packages/dashboard/node_modules`, plus
   `npm run build -w packages/shared`). Not needed in the end — this lane touched no shared code —
   but wired before measuring anything, per the lane-4 warning.
10. **The wiring-walk gate reads `git ls-files`**, so a new production file is invisible to it
    until staged. My first gates run failed with "2 unresolved relative imports" purely because
    `embedding-sources.ts` was untracked. Harmless once staged, but it looks like a real defect and
    will cost the next person time.
