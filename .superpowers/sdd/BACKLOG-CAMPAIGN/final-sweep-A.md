# FINAL REVIEW SWEEP — RELEASE-BLOCKER ROUND, SLICE A

**Branch:** `t86-backlog` @ `a847076f` · **Slice:** the embeddings lane (`7f2dd237`) + the infra trio
(`bf0682ec` / `f4613141` / `ce91ab13` + renumber `897b516c` + residue `a847076f`)
**Worked in:** a detached worktree at `a847076f`, **`packages/shared` built first** and a
worktree-local `@dojo` scope wired under both package `node_modules` (the shadow trap). The owner's
dev server on 3001 was never touched; `~/.dojo` was read through `?mode=ro` / `-readonly` only and
every rehearsal ran on `VACUUM INTO` copies.

| lane | verdict |
|---|---|
| **embeddings — `7f2dd237`, migration 175** | **GO** — 1 finding, not blocking |
| **infra trio — occurrences tap + 176, the 168/165 adjudication, the build stamp** | **GO** — 4 findings; the one expected gate raise is outstanding |

**Full suite 499 files / 7,505 tests, exit 0.** `npm run typecheck` exit 0 (the root script now
covers the dashboard too) · dashboard `tsc --noEmit` exit 0 · **`npm run gates:block` exit 1 with
exactly one red**, the ratchet the infra report itself asked to be raised (I-F1).

---

## EMBEDDINGS LANE

**The race guard closes the window in the statement, and the proof runs the race rather than
simulating it.** `insertEmbeddingIfSourceAlive` is
`INSERT … SELECT … WHERE EXISTS (SELECT 1 FROM ${table} src WHERE src.id = ?)` — liveness and write
decided together. §1 gates the stubbed backend so the delete lands strictly between the `await` and
the INSERT, asserts the door really deleted the source **and that the trigger had nothing to clean**
(`embCount === 0`), then releases and asserts no row landed; a CONTROL proves the happy path still
writes. **E-M1 — the guard reverted to a plain `VALUES` insert, i.e. the original bug — reds 10 of
24.** The window is genuinely closed by the statement, not narrowed.

**Migration 175, rehearsed on a fresh WAL-complete `VACUUM INTO` copy** (420,462,592 bytes,
`integrity_check` ok):

| check | result |
|---|---|
| idempotence on the lived-in body (175 already applied) | `embeddings` **44,628 → 44,628, delta 0**; all three triggers present — `summaries_embed_ad · messages_embed_ad · techniques_embed_ad` |
| safety fixture — 3 live + 4 orphan + 1 **undeclared kind** | **exactly 4 deleted** (44,636 → 44,632): every live row survived, every orphan kind went, and **`some-future-kind` SURVIVED** — the per-kind-by-name promise holds |
| sources untouched | `messages` 49,591 · `summaries` 318 · `techniques` 4 — unchanged; `integrity_check` ok |
| live body corroboration | `embeddings` = **44,628**, matching the report's measured AFTER exactly |

The author's self-correction is right: the cascade **does** exist (`081`'s AFTER DELETE triggers),
and all three are present on the live body.

**Mutants** (`embedding-sources.ts` `bff55770`, `175_….sql` `4f1d65ee` — matching the report's
recorded sha — both restored):

| mutant | result |
|---|---|
| E-M1 race guard → plain `VALUES` (the ORIGINAL BUG) | **10 of 24 RED** |
| **E-M2 (mine) the guard always checks the `messages` table** | **4 RED** |
| **E-M3 (mine) 175's briefing arm → blanket `DELETE FROM embeddings`** (over-delete) | **1 RED** — the undeclared-kind survival clause |
| E-M4 `techniques_embed_ad` trigger removed | **1 RED** |

### Finding

| # | Sev | Finding |
|---|---|---|
| **E-F1** | **MEDIUM** (doc-accuracy; benign direction) | **The `NOT IN` safety argument is wrong on three of four tables.** The report says the subqueries run "over NOT NULL `TEXT PRIMARY KEY` columns, so no NULL can enter the list". Measured: `messages.id` really is `TEXT NOT NULL UNIQUE`, but **`summaries.id`, `techniques.id` and `briefings.id` are bare `TEXT PRIMARY KEY`** — and SQLite in a non-STRICT table with a non-INTEGER primary key **accepts a NULL**, which I demonstrated empirically. **The failure direction is safe**: one NULL in the list makes `NOT IN` delete **0 rows** (also measured), so it can silence the sweep but can never eat a live row. Live census is 0 NULL ids in all four tables, so the sweep behaved correctly. But the safety rests on "no writer ever inserts a NULL id", not on the schema guarantee claimed — and `NOT EXISTS`, which 176 uses, has no such dependency. Correct the claim or switch the idiom; the migration itself is safe as shipped. |

---

## INFRA TRIO

### The renumber is clean

No duplicate numbers anywhere in the chain; `175_orphaned_embeddings.sql` and
`176_orphaned_work_references.sql` sit in order, the test file is `migration-176-…test.ts` and it
points at `176_orphaned_work_references.sql`. The **entire textual delta** of the renumber is one
comment line — the file's own pointer to its test name. No 175-vs-176 confusion survives.

### Migration 176, rehearsed on the same fresh copy

| | before | after |
|---|---|---|
| orphan `adjudications` / `work_events` / dangling `work.parent_id` / dangling `techniques.build_project_id` | 1 / 1 / 1 / 1 | **0 / 0 / 0 / 0** |
| **live** adjudications · work_events · work.parent · tech.build | 81 · 21,157 · 166 · 1 | **81 · 21,157 · 166 · 1 — unchanged** |
| `work` rows · `techniques` rows | 4,895 · 4 | **4,895 · 4** — the two link columns are **NULLED, never deleted** |

`integrity_check` ok; `foreign_key_check` down to only the 19 `summary_messages->messages`;
**idempotent** on re-apply. The live body confirms `adjudications->work` is now **0**.

**The `techniques.build_project_id` RAISE is genuinely prevented, and proven in the strongest
form.** The clause sets `foreign_keys = ON` **and asserts the pragma took**
(`expect(pragma('foreign_keys')).toBe(1)`), seeds a technique whose `build_project_id` names a doomed
occurrence, calls `deleteOccurrencesOf`, then asserts nothing names the deleted children **and that
the technique survived with only its link cleared**. Dropping the NULL (I-M2) reds it.

### The 165 pinned absence — verified by a stronger method than the report's, and the refusal is right

I hashed **every one of the 9,286 blobs in the object store, unfiltered**, CRLF-normalised with the
engine's own `migrationChecksum` (`sha256` of the text with `\r\n → \n`):

```
blobs matching the box's recorded 165 checksum (92d9f1fe…):  NONE — claim CONFIRMED
only blob of 165 that has ever existed: 9ab9f8c3e4 -> eefb8f19…  (the file today)
stashes: 0
```

So the bytes that wrote that `_migrations` row **cannot be produced, cannot be diffed, and therefore
cannot be shown to be comment-only**. An entry in `KNOWN_DIVERGENCES` asserts *"the difference has
been diagnosed"*; writing one without the bytes would be a fabricated warrant. **Refusing to
adjudicate is the correct call**, and the part that makes it durable is that the absence is *pinned*
rather than merely omitted — **I-M3 (mine: silence 165 by adding a guessed entry) reds 2**.

### The build stamp's stale-server proof — re-run on a real server

Booted from the worktree on a scratch `DOJO_HOME` and port 3097. Stamp written:
`pid 59311 · version 3.2.0 · sha a847076f · shaSource "git"`.

| arm | result |
|---|---|
| **HEAD moved to `897b516c` while the process kept running** | probe reports **`a847076f`**, `shaProvenance` **`boot-stamp:git`** — the code the process LOADED, not the moved directory. Stale report avoided. |
| **stamp's pid rewritten to a dead 999999** | probe **ignores the stamp** (`bootStamp: null`), falls back to `897b516c` and **labels it** `install-dir-head (stamp is another process)` — honest, not silent. |

**Unplanned live corroboration:** the owner's own dev server (pid 29594, main repo) has stamped
itself `897b516c` while the main repo HEAD is `a847076f`. It is, right now, a live instance of the
staleness this feature exists to detect — and the stamp reports the older, loaded sha correctly. The
scratch server was killed, port 3097 verified free, and the stamp in the real `~/.dojo` was confirmed
to belong to pid 29594 and the main repo's `moduleDir`, **not to my process**.

**Mutants** (`work-refs.ts` `0a1e4a83` matching the report, `migration-checksums.ts` `de5b7516`,
`boot-stamp.ts` `d4dd8b0e`; all restored):

| mutant | result |
|---|---|
| I-M1 `work-refs`: drop the adjudications delete | **6 of 44 RED** |
| I-M2 `work-refs`: drop the `techniques.build_project_id` NULL (the RAISE) | **1 RED** |
| **I-M3 (mine) somebody silences 165 with a guessed entry** | **2 RED** |

### Findings

| # | Sev | Finding |
|---|---|---|
| **I-F1** | **RESOLVED while this review was being written** | **Gates exited 1 on exactly one ratchet:** `packages/server/src/db/migration-checksums.ts` pinned **307, now 317 (+10)** — precisely what the infra report predicted and asked to be raised at merge, with no `$raises` entry for it at `a847076f`. Everything else was green (manifest conformant, 27 gates; the migration-freeze gate passes). **`828fdf0e` has since landed the raise** (307 → 317, pin now equal to actual, carrying the lane's own argument and crediting slice C for catching the red). Verified: pin 317, actual 317. Nothing outstanding — recorded because the measurement was taken before the fix. |
| **I-F2** | LOW | **The report's recorded sha for the work-references migration (`2bdfe5e1`) matches no shipped file.** It describes the pre-renumber `175_`-named file; the shipped `176_` file is `db209010`. Fully explained by the single comment line the renumber changed — but that sha is the revert-discipline anchor and should be updated to the shipped value. |
| **I-F3** | LOW | **The one behaviour that fixes the reported defect is unguarded.** The pid-match / labelled-fallback decision lives **kit-side** (`behavioral/lib/serverstate.mjs:285`) and has no automated clause; the seven engine clauses cover only the write side (pid/version/time, atomicity, second-boot overwrite, env override + labelling, 40-hex-or-null, negative control, unwritable target). The report discloses this as concern 4. I re-ran both behaviours above and they hold, but nothing would catch a regression. |
| **I-F4** | INFO | The `migration freeze` gate reports ✓ while `165` still logs at ERROR — that gate covers migrations whose *file* changed, and 165's file has not; the mismatch is applied-vs-file, audited rather than gated. Green gates therefore do **not** mean 165 is resolved; it still needs the owner's ruling (rebuild the row, or accept the line). |

---

## CLEANUP

| item | state |
|---|---|
| Detached worktree `…/scratchpad/wtA-final` | **removed** and pruned; restored to `a847076f` first and verified clean |
| Rehearsal bodies (`body.db`, `e-idem`, `e-safe`, `w-safe`, `w2` — ~2.1 GB) | **deleted** |
| Scratch server | killed; **port 3097 verified free**; scratch `DOJO_HOME` and its log deleted |
| Owner's dev server (3001) | **untouched and healthy**; the real `~/.dojo/server-boot.json` belongs to pid 29594 (main repo), not to my process — nothing of mine was written to the real home |
| Mutants | all reverted; `embedding-sources.ts` `bff55770`, `175_….sql` `4f1d65ee`, `work-refs.ts` `0a1e4a83`, `migration-checksums.ts` `de5b7516`, `boot-stamp.ts` `d4dd8b0e` re-asserted |
| `t86-backlog` | **not touched** — no commit, no checkout, no working-tree edit |

⚠ **One note for the coordinator on shared scratch:** a sibling agent overwrote my mutation harness
(`…/scratchpad/final-mutants.sh`) mid-run with a different slice's script. My results were already
captured, so nothing was lost, but the session scratchpad is shared across parallel reviewers and
generic filenames collide. Worth per-slice prefixes in the brief.

---

## Dispositions — fix round `t86-tidy`, 2026-09-26

**E-F1 — LEDGER-NOTED, migration untouched (`b447352a`).** The embeddings report's `NOT IN` safety
sentence is corrected to what the schema actually says: `messages.id` is `TEXT NOT NULL UNIQUE`, but
`summaries.id`, `techniques.id` and `briefings.id` are bare `TEXT PRIMARY KEY`, which SQLite lets be
NULL in a non-STRICT table — so the guarantee rests on "no writer inserts a NULL id", not on the
schema. The benign direction is recorded with it (one NULL makes `NOT IN` delete 0 rows: it can
silence a sweep, never eat a live row), as is the live census of 0 NULLs and the idiom to prefer next
time (`NOT EXISTS`, which migration 176 already uses). A one-line entry went into the project
BACKLOG, append-only. **The migration was not touched** — the freeze gate and the applied-on-dev
divergence both forbid it, and the shipped behaviour is safe as it stands.

**I-F2 — DONE (`b447352a`).** The revert-discipline anchor now names the shipped file:
`migrations/176…sql` @ **`db209010`**. The recorded `175…sql` @ `2bdfe5e1…` was the pre-renumber copy
and matched nothing a reverter could check out, which is the one job that column has.

**Not mine, and still owed at the tip (both re-measured at `828fdf0e`):** the size-ratchet debt slice
B records as F1, and — new here — **`npm run gates` also fails the LINT-BASELINE gate at the tip**:
`packages/server/src/boot-stamp.ts:35,37` hold `node:fs` and `node:child_process` as
error-severity `no-restricted-imports` findings, the file is not on
`deploy/checks/effect-import-exclusions.mjs`, and the total rose 106 → 108. Measured identically at
`828fdf0e` and at `t86-tidy`'s tip, and this branch touches neither that file nor any gate file. It
needs an exclusion-list entry **with its class and its reason** from whoever owns `ce91ab13`.
