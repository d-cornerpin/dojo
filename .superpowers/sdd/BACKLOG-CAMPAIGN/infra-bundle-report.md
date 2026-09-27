# RELEASE-BLOCKER ROUND — INFRA BUNDLE REPORT

**Branch:** `t86-infra`, off `e0c44fa6` → `0e8557a3` (3 commits) · **Kit:** `803d539` (probe only)
**Worked in:** a detached worktree under the scratchpad. `t86-backlog` **never touched** (verified:
it contains none of my commits). `ratchets.json` and `gate-manifest.mjs` **not edited**. No
`definitions.ts`. **No live `~/.dojo` writes** — the live body was read through `?mode=ro` only,
and the scratch server wrote its stamp into a scratch `DOJO_HOME`.
**Status:** all three items done. `typecheck` exit 0 · full suite **494/494 files, 7423/7423
tests, exit 0** · gates **14/15** — one size ratchet red, unavoidable, argued below.

| item | commit |
|---|---|
| 1 — the fresh orphan tap + work-side census + migration 175 | **`a592a914`** (`dojo`) |
| 2 — migration adjudications | **`cbc59613`** (`dojo`) |
| 3 — serverIdentity build stamp, engine | **`0e8557a3`** (`dojo`) |
| 3 — probe, kit | **`803d539`** (`dojo-test-kit`) |

---

## ⚠ THE ONE PIN THAT NEEDS RAISING (for reconciliation at merge)

**`packages/server/src/db/migration-checksums.ts`: pinned 307, now 317 (+10).** Every other gate
is green; this is the only red.

**It is unavoidable, not untidy.** `KNOWN_DIVERGENCES` is a **data table**, and adjudicating a
divergence means adding an entry whose minimum shape is seven lines (`file`, `appliedChecksum`,
`fileChecksum`, `since`, `reason`, plus braces). I trimmed everything else that could go: a
14-line explanation of why `165` is *not* adjudicated became 3 lines pointing at the test and this
report. So the +10 is **one 7-line entry plus a 3-line warning that must not be lost** — the
warning is load-bearing because without it the next worker "fixes" the ERROR log by adding the
entry I deliberately refused to write.

Item 1 needed no raise (`occurrences.ts` held at 835 exactly, by moving the sweep into a new
module). Item 3 needed none (`boot-stamp.ts` is a new 155-line file under both caps;
`gateway/server.ts` is unpinned, 355 → 361).

---

## ITEM 1 — THE TAP'S WRITER, NAMED

**`work/occurrences.ts`, both of its delete paths:**

* **`releaseOccurrence()`** — the scheduler could not claim the occurrence, so the row is deleted
  and its sequence freed for the next tick.
* **`deleteOccurrencesOf()`** — a schedule is deleted, so its occurrence children go with it.

Both swept `work_events`; neither swept `adjudications`.

**An occurrence CAN carry an adjudication and nothing guarded against it.** `store.ts`'s
`transition()` writes one for any row closed with an authoritative claim or by a system closer —
**there is no `kind` check on that INSERT** — and `settleOccurrence()` closes occurrences as
`scheduler`.

**How it was pinned to occurrences rather than guessed.** The live orphan is
`claim_state='done'`, `verdict='upheld'`, `work_id` a **bare uuid** — which is exactly what
`uuidv4()` mints for an occurrence, and unlike the `ask:` / `cmt:` / `piece:` prefixes the other
kinds carry — with **zero surviving `work_events`**, because the deleter cleaned those and only
those. `tracker-store.ts` was ruled out by reading: it already sweeps adjudications for itself
*and* its children. The surviving 78 adjudications sit on `project` and `task` rows and none on an
occurrence, which is survivor bias and consistent: the adjudicated occurrences are the ones that
got deleted.

### ⚠ A SECOND BUG, FOUND BY THE NEW CENSUS ON ITS FIRST RUN

`techniques.build_project_id` is the **fourth** reference into `work(id)`, and neither occurrence
path cleared it. `techniques/store.ts` takes `buildProjectId` as a caller-supplied `string | null`
with **no kind constraint**, so the declared FK permits it to name an occurrence — and because it
is `NO ACTION` the consequence is **not a lost row but a RAISE**: `deleteOccurrencesOf` throws and
the schedule cannot be deleted. Both paths now NULL it (never follow it — a technique outlives
whatever built it).

### L1-F2 — THE WORK-SIDE CENSUS

`work/__tests__/a-deleted-work-row-leaves-no-verdict.test.ts` reads `work`'s referents from
`PRAGMA foreign_key_list` at run time, pins the set at exactly four —
`work_events.work_id`, `adjudications.work_id`, `techniques.build_project_id`, `work.parent_id` —
asserts **all four are `NO ACTION`** (which is *why* every delete path must sweep by hand), and
requires that a deleted work row is named by none of them. A fifth reference, or a new delete path
that forgets one, fails without anybody editing the file. Schema from `runMigrations()`, not the
hand-built fixture: a census read off a fixture proves the fixture.

**New module `work/work-refs.ts`** — `clearReferencesToWork()`, the one owner of "what points at a
work row". Three call sites had three different ideas of the list: `tracker-store.ts` swept two,
`purge-sweep.ts` all four, `occurrences.ts` one. A list in one place can be wrong once; copied into
three it can be wrong three ways, and was. Delegating also kept `occurrences.ts` **at** its pin.

`work-fixture.ts` gains the `techniques` table — without it the production path throws
"no such table: techniques" and four existing clauses went red. (And no backticks in that comment:
the whole block is one JS template literal, and a backtick there ends it. Learned the hard way.)

### MIGRATION 175 — rehearsed on a WAL-complete `VACUUM INTO` copy

174 was taken by lane 3; **checked before numbering**, as instructed.

| table | before | after |
|---|---|---|
| `adjudications` | 79 | **78** (−1) |
| `work_events` · `work` · `techniques` · `agents` · `messages` · `deliveries` · `turns` | — | **all unchanged** |

`PRAGMA foreign_key_check`: `adjudications->work` **1 → 0**; only `summary_messages->messages` (19)
remains — a different parent table, filed separately. Apply **0.021 s**, `integrity_check` **ok**,
re-applied twice with byte-identical counts.

It states all four work references, not only the one with rows today, because another box's history
is not this one's. A verdict is **DELETED** (its `work_id` is `NOT NULL`, so with the row gone there
is no question for it to answer); the two link columns are **NULLED**.

---

## ITEM 2 — ONE ADJUDICATED, ONE REFUSED

The brief said measure first and STOP rather than adjudicate anything that is not the
harmless-comment class. **One is; one is not.**

### `168_work_tracker_default_grant.sql` — ADJUDICATED

Recorded `8a9fc56b1ea5cf1e…` is **exactly** the file at its previous commit `d51cbba2`, which is
what proves the row was written by those bytes. The whole diff to today's file (`755dda36`, *"review
F1/F4: the migration header states the one stored decision it overrides"*) is **seven added `--`
lines**. Executable SQL **byte-identical** with `--` lines stripped: `252bbe6efe7e92c5…` on both
sides, over **1,302 non-comment bytes**, so the comparison is not vacuous.

### ⚠ `165_work_effort_meter.sql` — NOT ADJUDICATED. THIS IS THE FINDING.

The box records `92d9f1fe7668102c7423d0959faef534db94651501f531d6dfcef1469ad8d2af`. **That
checksum matches no version of the file anywhere in this repository.**

Searched exhaustively, not assumed: exactly **one** blob of `165` has ever existed (`9ab9f8c3e4`,
normalising to `eefb8f19…`, which is also the file today) across `git log --all --follow` and a
hash of every candidate blob from `git rev-list --all --objects`. No stash, no other ref.

So the bytes that wrote that row **cannot be produced, cannot be diffed, and therefore cannot be
shown to be comment-only**. An entry in that ledger asserts *"the difference has been diagnosed"*;
writing one without the bytes would be a **fabricated warrant** — precisely the failure the ledger
exists to prevent. **It keeps logging at ERROR until somebody produces the applied version or the
box is rebuilt.**

The absence is **pinned, not merely omitted**: the ledger test now asserts `165` is *not* in
`KNOWN_DIVERGENCES`, with the reason inline, so a future worker cannot quietly add it to silence a
log line. A mutant that does exactly that goes red.

**Recommendation:** this is a dev-box-only artefact (the row was written from a working tree). The
clean resolutions are (a) rebuild that box's `_migrations` row from the current file after
confirming the schema matches, or (b) accept the ERROR line as the honest record of an
unreconstructable past. Owner's call; I did not take it.

---

## ITEM 3 — THE BUILD STAMP

**The defect:** `serverIdentity()` answered "which code is the server running?" with
`git -C <listening pid's cwd> rev-parse HEAD` — a fact about **the install directory at probe
time**, not about the process. A server started an hour ago on a tree that has moved reports the
NEW sha while executing the OLD code. Same class as run `bms2ldriox4`, except the mismatch is in
**TIME** rather than **PLACE**, which is why `assertServerTreeMatches` structurally cannot see it.

**The fix:** `boot-stamp.ts` writes `~/.dojo/server-boot.json` from `createServer()` before a byte
is served — own pid, version, sha of the code **loaded**, start time, module dir. The probe believes
it **only when `stamp.pid` is the listening pid**, which is what makes a dead process's leftover
file harmless.

**Sha provenance, first hit wins:** `DOJO_BUILD_SHA` → `build-info.json` beside the platform
manifest (written by `deploy/build-package.sh` at **package** time) → a single `git rev-parse HEAD`
**only when a `.git` is present**. **A user's box takes the second path and never calls git** — it
has no repository. The third is the dev answer and is not the defect: the defect was calling git at
*probe* time against a tree that had moved. Unresolvable is `null`, never a guess.

### LIVE PROOF — the incident reproduced, then avoided

Booted from this worktree on a scratch `DOJO_HOME` and port 3099. **The owner's dev server was not
touched** (verified healthy on 3001 afterwards; no `server-boot.json` exists in the real `~/.dojo`).

Stamp written: `pid 48527 · version 3.2.0 · sha cbc5961344ed… · shaSource "git" · startedAt
2026-09-27T04:09:08.971Z`. HEAD was then moved on **while that process kept running**:

```
install-dir HEAD now      d103cb38   <- what the OLD probe would have reported
probe gitSha (NEW)        cbc59613   <- what the process actually LOADED
shaProvenance             boot-stamp:git
STALE-REPORT AVOIDED      true
```

Fallback, proven by rewriting the stamp's pid to a dead one:

```
gitShort        d103cb38
shaProvenance   "install-dir-head (stamp is another process)"   <- labelled, not silent
bootStamp       null (ignored)
```

**Seam kept compatible:** every previously returned field means what it did; three additive
(`shaProvenance`, `bootStamp`, `serverStartedAt`). `run-prompt-gates.mjs` needed no change — it
refuses on a falsy `gitSha`, which still holds. Kit change is the one probe file.

---

## STABLE-BRIDGE DRAFT — Entry 57 (`175`), for reconciliation at merge

> **CHAIN INDEX row:** `| `175_orphaned_work_references.sql` | **57** | RELEASE-BLOCKER ROUND |`
> *(lane 3's `174` presumably takes 56 — please confirm at merge; I checked the migration chain
> for numbering, not the ledger's positions.)*
>
> ## Entry 57 — `175_orphaned_work_references.sql` — THE VERDICT THAT OUTLIVED ITS WORK ROW
>
> | | |
> |---|---|
> | **Migration** | `packages/server/src/db/migrations/175_orphaned_work_references.sql` — local, shipped |
> | **Change class** | ⚠ DESTRUCTIVE of two row families. Two `DELETE`s, two `UPDATE`s, all `NOT EXISTS`-predicated. No DDL |
> | **Landed by** | RELEASE-BLOCKER ROUND, 2026-09-26, from sweep-review-A L1-F1 |
> | **Touches** | `adjudications` / `work_events` whose `work_id` matches no `work` row → DELETED. `work.parent_id`, `techniques.build_project_id` naming a missing row → NULL. Anything whose parent exists → UNTOUCHED |
>
> **Measured:** `adjudications` 79→78; every other table unchanged; `foreign_key_check`
> `adjudications->work` 1→0 (only `summary_messages->messages` 19 remains). Apply 0.021 s,
> `integrity_check` ok, idempotent.
>
> **⚠ Unlike 172/173 this one had a LIVE tap**, which is why the source fix ships with it: both
> `work/occurrences.ts` delete paths swept `work_events` and not `adjudications`, and an occurrence
> can carry one (`transition()` has no `kind` guard). Fixed via the new `work/work-refs.ts`.
>
> **Guard:** `db/__tests__/migration-175-orphaned-work-references.test.ts` (11 clauses, four bodies,
> negative control, counterfactual) + the work-side FK census in
> `work/__tests__/a-deleted-work-row-leaves-no-verdict.test.ts`. Mutation-proven seven ways.
>
> **ROLLBACK: none** — a delete of unreachable rows has no inverse; the marker only re-runs a file
> whose predicates then match nothing. Restoring means the pre-chain backup, and rolling back is the
> wrong move: what needs keeping is the source fix.

**Also for the ledger:** `KNOWN_DIVERGENCES` gained `168`, and `165` was deliberately refused — if
the bridge tracks adjudications, both facts belong there.

---

## MUTATION PROOFS — 13 MUTANTS, EVERY REVERT sha-VERIFIED

| file | baseline sha256 | mutant | result |
|---|---|---|---|
| `work/work-refs.ts` | `0a1e4a83ac743302…` | drop adjudications delete | **6 of 8 RED** |
| | | drop techniques NULL | **1 of 8 RED** |
| `work/occurrences.ts` | `6b30aacbae09ba28…` | `releaseOccurrence` → events-only | **3 of 8 RED** |
| | | `deleteOccurrencesOf` → events-only | **3 of 8 RED** |
| `migrations/176…sql` | `db209010…` | drop adjudications sweep | **4 of 11 RED** |
| | ⚠ CORRECTED 2026-09-26 (final sweep A / I-F2): recorded as `175…sql` @ `2bdfe5e1…`, which matches no shipped file — that sha is the PRE-RENUMBER `175_`-named copy, and the renumber changed a single comment line. The shipped `176_` file is **`db209010`**, and since this column is the revert-discipline anchor it has to be the value a reverter can actually check out. | | |
| | | `parent_id` UPDATE → DELETE | **2 of 11 RED** |
| | | `techniques` UPDATE → DELETE | **2 of 11 RED** |
| `db/migration-checksums.ts` | `80e4ee69cb6f124f…` (pre-trim) | drop the 168 entry | **1 of 18 RED** |
| | | 168's `fileChecksum` goes stale | **1 of 18 RED** |
| | | **somebody silences 165 by adding a guessed entry** | **1 of 18 RED** |

Item 3's stamp is held by seven clauses and two measured live proofs (above) rather than by
mutants — its failure mode is a stale *number*, which a unit mutant cannot manufacture.

---

## CONCERNS

1. **⚠ `165`'s ERROR line stays until the owner rules.** See item 2. I refused to adjudicate it and
   pinned the refusal. It needs either a box rebuild of that `_migrations` row or a conscious
   decision to live with the log line. **Not a code problem — an unreconstructable past.**

2. **The pin raise above is the only thing between this branch and 15/15.** One line in
   `ratchets.json`: `packages/server/src/db/migration-checksums.ts` 307 → 317.

3. **`summary_messages -> messages` (19) still unswept**, now the *only* remaining FK-violation
   family on the owner's body. Third time it has been deferred across three rounds. It wants its own
   item: `summary_messages.message_id` gained `ON DELETE CASCADE` in migration 130, so the same
   "which writer had FKs off" question applies and deserves a measured answer, not a blind sweep.

4. **The kit probe has no automated clause.** `behavioral/lib/serverstate.mjs` has no test harness in
   the kit, so both new behaviours (stamp believed on pid match; labelled fallback otherwise) rest on
   the measured run in the commit message. The engine half carries seven clauses. Stated rather than
   implied.

5. **`build-info.json` is written but never yet exercised by a real packaged install.** The
   `shaSource: 'package'` branch is unit-tested via the env override and the walk, but no packaged
   artifact was built in this round. **The first `build-package.sh` run should confirm
   `build-info.json` lands beside the platform manifest and that a packaged server stamps
   `shaSource: "package"`** — that is the path every user box takes.

6. **`transition()` still has no `kind` guard on its adjudication INSERT.** I fixed the *deleters*,
   not the writer, because an adjudication on an occurrence may well be intended (the scheduler
   genuinely closes them authoritatively). Worth an explicit decision: if an occurrence should never
   carry a verdict, the guard belongs at the INSERT and the sweep becomes belt-and-braces.

7. **Scratch artefacts to delete at merge:** the worktree `…/scratchpad/infra` (its `node_modules`
   are directories of symlinks into the main repo — nothing installed), the scratch home
   `…/scratchpad/infra-home`, rehearsal bodies `…/scratchpad/infra-rehearse/*.db` (~0.4 GB), and the
   suite logs `…/scratchpad/infra-suite*.txt`. The scratch server on 3099 was killed and the port
   verified free.
