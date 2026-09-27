# FINAL SWEEP — SLICE C (small-fry · dashboard runner · gate wiring)

**VERDICT — SMALL-FRY: GO.** All three scrutinised fixes verified at the root and mutation-proven;
2 LOW, 2 NIT, none blocking. The three "the-line-was-wrong" corrections are all accurate — I
re-derived each.
**VERDICT — DASHBOARD RUNNER: GO.** The runner works, the gate wiring is correct and actually runs
in the release path, the lockfile is installable. 1 MEDIUM (a census clause that is vacuous about the
thing it claims to assert), 2 LOW, 2 NIT.

**⚠ BUT THE BRANCH IS NOT RELEASABLE, FOR SOMEBODY ELSE'S REASON — see B1.** `npm run gates` exits
**1** at `a847076f`: the size ratchet refuses. It is not in either of my lanes and neither of my two
reports could have caused it.

Verified in a detached worktree at `a847076f` under `/tmp` (`packages/shared` built first), dashboard
via `npm run test -w packages/dashboard`. Live tree never written to. Worktree removed.

---

## 0. TWO PREMISE CORRECTIONS

**(a) Four of the six assigned SHAs are stale (rebased lanes), as last slice.** `de829dc7` and
`ae5158e3` resolve; `2bedeb5f` → **`a6e3b24d`** and `57c2f52e` → **`d099816d`**, both
`patch-id`-identical, so the content is what was assigned. The smallfry report's own internal SHAs
(`0da8a23b`, `f2a0da1a`, `6dec4c73`, `b846e527`, `e891ea12`, `601d7afc`, `d9eb8787`) are likewise
pre-rebase; their on-branch twins are `b1b8beca`, `7015311e`, `73c46c42`, `f63f5006`, `31fff368`,
`6be11bee`, `f0f06139`. Ranges reviewed: small-fry `b1b8beca~1..de829dc7`, dashrunner
`a6e3b24d~1..ae5158e3`.

**(b) ⚠ A PARALLEL SLICE HAS REPOINTED THE LIVE REPO'S `@dojo/shared` AT ITS OWN WORKTREE.**
Measured in the live checkout:

```
packages/server/node_modules/@dojo/shared    -> /private/tmp/.../scratchpad/wtA-final/packages/shared
packages/dashboard/node_modules/@dojo/shared -> /private/tmp/.../scratchpad/wtA-final/packages/shared
```

Both are **absolute** symlinks written into the **shared** checkout (mtime 21:22 today). Two
consequences the coordinator should know: any other slice that symlinks the live `node_modules` — the
setup every report in this campaign describes — silently compiles `@dojo/shared` from **slice A's
worktree**, so a mutant planted in `shared` there changes every other slice's measurements; and once
that worktree is removed, `npm run test -w packages/server` **in the live tree** resolves a dangling
path. I did not touch it (another agent's live workspace); I built an isolated per-entry
`node_modules` with a worktree-local `@dojo`, verified
`require.resolve('@dojo/shared') → /private/tmp/finalC-wt/packages/shared/src/index.ts`, and took
every measurement below through that.

---

## 1. WHAT I CONFIRMED

| Claim | Verdict | Evidence |
|---|---|---|
| full server suite | **GREEN** | **499 files / 7,505 tests**, exit 0 |
| dashboard suite, via `npm run test -w packages/dashboard` | **GREEN** | **7 files / 45 tests** — exactly the report's "45 clauses · 7 files" |
| `npm run gates` | **✗ EXIT 1** | see **B1** |
| `check-gate-manifest` | **exit 0** | *"27 declared gates (15 blocking · 4 report · 8 release-only) … 8 release-only gate(s) declared as such and all still present in release.sh"* |
| the release.sh step title matches the manifest | **CONFIRMED** | rule 6 of the checker requires a literal `step "<title>"`; manifest and script both read `Unit-suite gate (server + dashboard vitest, full run)` |
| **the dashboard suite actually RUNS in the release path** | **CONFIRMED by dry-read** | `release.sh:507-512`: unconditional (no `if`, no `DRY_RUN` guard, and the block's own comment says `--skip-behavioral-gate` does not skip it); two separate invocations each with `\|\| fail`, so the failure names the package. Ordering is safe: `npm run build:package` at `:354` builds `packages/shared/dist` long before `:507` |
| the four devDeps are in the lockfile, and it is installable | **CONFIRMED** | `@testing-library/dom@10.4.2`, `@testing-library/react@16.3.3`, `happy-dom@20.14.5`, `vitest@3.2.4`, all `dev: true`, lockfileVersion 3; `npm ci --dry-run` succeeds. React resolves to a single **18.3.1** (the report's duplicate-React trap is not reproduced), and `@testing-library/react`'s `@types/react` peer accepts `^18 \|\| ^19` |
| root scripts | **CONFIRMED** | `test` = server then dashboard; `test:server` / `test:dashboard` split; `typecheck` now includes `packages/dashboard/tsconfig.json` |
| all five session-boundary doors now agree | **CONFIRMED** | each of the five writes `session_started_at = ?` **once**, calls `forgetSessionScratch` **once**, and hand-rolls **zero** clears |
| the dynamic-import graph property | **CONFIRMED** | none of the five doors gains a static import of `tool-docs`, `turn-state` **or** `session-forget` — all reach the owner via `await import(...)`, so the W4 note's property holds |
| W3: the replay reads NEWEST, and by the CALLED pass's own pattern | **CONFIRMED** | `ORDER BY created_at DESC, rowid DESC LIMIT ?` + `.reverse()`, the identical shape used at the called pass (`calledRows.reverse(); // the query is a newest-first recency window`) |
| the tmpdir fix, 3/3 before **and** after | **CONFIRMED** | see §2 |
| correction #3's contract argument | **CONFIRMED** | `clearServedConversations`' own docstring: *"Reset the per-agent turn-continuity scratch state **on a new session**"*; `clearSessionLoadedTools` likewise per-session. Neither cleaner's body was changed |

### The tmpdir fix, measured both ways (3 concurrent runs each)

| | result |
|---|---|
| **AFTER** (`dojo-t50-rename-souls-${process.pid}`) | **3/3 GREEN, 26 tests each** — matches the report exactly |
| **BEFORE** (pid suffix stripped from both fixtures) | **3/3 RED** — 7 / 5 / 7 failed of 26, carrying the backlog's own errors: `ENOENT: no such file or directory, mkdir '/var/folders/…/T/dojo-…'`, and the `open` and `stat` variants |

### Mutants — 8 planted (5 small-fry, 3 dashboard), all RED, all reverted

All twelve touched files byte-identical to baseline by sha256 (manifest `diff` empty); worktree
`git status` clean.

| # | mutation | result |
|---|---|---|
| **SF-M1** | a **sixth** boundary writer that forgets nothing | **2 F** — the census names the file: *"expected [ 'agent/drifted-door.ts', …(5) ] …"* and *"a door that moves the session boundary must forget the per-session scratch"* |
| **SF-M2** | un-wire one door (`system.ts` loses the owner call) | **1 F**, **by name**: *"expected [ 'gateway/routes/system.ts' ] to deeply equal []"* — the report's central claim, verified |
| **SF-M3** | hand-roll `clearServedConversations` back into a door | **1 F**, naming the offender — the one-owner rule bites |
| **W3-M1** | revert the replay to the pre-fix `ASC` read | **1 F / 29 P**, with the report's exact message: *"expected [ 'tool_0437', 'tool_0438', …(62) ] to include 'tool_0519'"*, and §6.2 (under the cap) stays green — the fix is free at real sizes |
| **TMP-M1** | strip the per-process suffix | 3/3 RED, above |
| **CM-D1** | simulate a happy-dom upgrade dropping `ResizeObserver` | **1 F** — the census fires, but see **B3** for what it does *not* say |
| **CM-D2** | delete the `getContext` stub — **the one declared residue** | **45/45 GREEN. The clause does not bite.** See **B2** |
| **CM-D3** | delete the network tripwire | **1 F** — *"expected [Function] to throw an error"*; the tripwire is pinned |
| **M1 (re-plant)** | render the brief through `<Markdown>` | **8 F / 37 P** — the whole brief file dies. See **B4** on the "16" |

---

## 2. FINDINGS

### Blocking the branch (not my lanes, but found here)

**B1 — BLOCKER (cross-lane). `npm run gates` exits 1 at `a847076f`: the size ratchet refuses.**
```
✗ 1 file(s) GREW past their ratchet (line counts are `wc -l`):
  packages/server/src/db/migration-checksums.ts: pinned 307, now 317  (+10)
✗ Size-ratchet gate … NOT publishing.
```
Attributed by walking the file across the branch: 307 at `de829dc7` / `a6e3b24d` / `d099816d` /
`e32b4b90` / `ae5158e3` / `bf0682ec`, and **317 from `f4613141`** (*"migration 168 is adjudicated;
165 is NOT"*) — the migration-adjudication lane, with no matching `ratchets.json` raise. It has
survived three commits since (`ce91ab13`, `897b516c`, `a847076f`). `release.sh` runs this gate, so
the cut refuses today. My worktree was clean when measured, and neither of my lanes touches that
file — the smallfry lane's own "+1 over `maintenance.ts`'s pin" was caught and restored by the same
gate (`f0f06139`), which is the instrument working. **Route to the adjudication lane: either fit the
10 lines or land an argued `$raises`.**

### Dashboard runner

**✅ DONE 2026-09-26 (`t86-tidy` `63a47ff8`) — the clause's subject is now the STUB: the prototype's
`getContext` must be the setup's zero-argument function (arity is the discriminator), all three of
`webgl`/`webgl2`/`2d` must answer null THROUGH it, and it must be on the prototype. Your own mutant —
delete the stub — now goes 1 F / 13 P where it was 45/45 green.**

**B2 — MEDIUM. The one declared residue of the happy-dom choice is unpinned, and the clause that
looks like it pins it is vacuous.** `vitest.setup.ts` stubs
`HTMLCanvasElement.prototype.getContext = () => null` and calls it *"the residue … in full"*;
the census asserts `getContext('webgl')` is `null`. **Measured: deleting the stub leaves 45/45
green** — because happy-dom 20.14.5 already answers `null` for `webgl`, `webgl2` **and** `2d`
(verified directly against the installed package). So the stub is a no-op today, the clause passes
for a reason other than the stub, and the day happy-dom returns a 2D-ish object the stub's removal —
or its silent breakage — is invisible. *Fix:* assert the stub itself (e.g. that `getContext` is the
setup's own function, or that a `2d` request also answers null *because* of it), or drop the stub and
say happy-dom already answers null.

**✅ DONE 2026-09-26 (`63a47ff8`) — `it.each` over ten rows, each carrying the API and its measured
call-site count; a dropped `ResizeObserver` now reads *"happy-dom no longer provides `ResizeObserver`,
which this package calls at 2 measured site(s)"* and names the two ways out. Plus a clause pinning the
table at ten rows with `getContext` deliberately excluded.**

**B3 — LOW. The census fires but does not "name itself", which is the whole claim made for it.**
Dropping `ResizeObserver` reds the clause with **`expected 'undefined' to be 'function'`** — no API
name. All five APIs sit in one `it` with no per-assertion message, so a reader must bisect five
candidates; the report's *"names itself instead of making a component test fail three files away"* is
delivered only in the sense that the right *file* fails. *Fix:* `it.each` over the ten rows, or an
assertion message per line — five short strings.

**✅ DONE 2026-09-26 (`b447352a`) — corrected in place to 8 F / 37 P, with your granularity point
(the `waitFor` timeout and the cascade) recorded beside it.**

**B4 — LOW (report accuracy). "M1 … 16 clauses RED" is not reproducible; the honest number is 8.**
The brief file holds **8** `it`s and M1 kills **all 8** (8 F / 37 P). Related: M1 takes down clauses
about subscriptions and the delivery panel too — the first `waitFor` times out (1,013 ms) and the
rest cascade — so the file cannot distinguish "the bytes rule broke" from "the card stopped
rendering". The rule is genuinely held; the count and the granularity are overstated.

**✅ DONE 2026-09-26 (`70f57ef3` sweep, `b447352a` correction) — the item now lists the real seven and
notes that `lib/working-note-visibility.ts`, which it named, does not carry the sentence. All seven were
swept comment-only rather than left for the next lane: none is instrument-anchored (checked against the
kit manifest first), `Markdown.tsx` stayed at its 433 pin, and each header kept its argument — a
component test can assert what was RENDERED, not what a door would accept.**

**B5 — LOW (report accuracy). §4.4's "Four product headers" is five in the body and seven in the
tree.** Files still saying *"no test runner"*: `components/GitHubSettings.tsx`,
`components/Markdown.tsx`, `components/ReportPreviewCard.tsx`, `lib/github-card.ts`,
`lib/credential-placeholder.ts`, `lib/provider-edits.ts`, `lib/stop-affordance.ts`. The report names
four of the five it lists and misses three. Leaving them alone this round is right (conflict risk);
the *list* is what the next lane will work from, so it should be the real seven.

**B6 — NIT. §3's typecheck claim over-states a release-path defect that did not exist.** The report
says the root-script change *"closes a claim the release script has always made and never checked:
`release.sh:237` prints `✓ server, shared, dashboard typecheck clean` while `npm run typecheck`
checked two of the three."* But `release.sh:236` — **pre-existing, not in this lane's diff** — already
ran `( cd packages/dashboard && npx tsc --noEmit -p tsconfig.json )`, so the printed claim was true.
The gap in `npm run typecheck` alone was real and is now closed; the release path was not lying, and
the dashboard is now typechecked twice at `:235` and `:236` (harmless, worth collapsing).

### Small-fry

**✅ DONE 2026-09-26 (`70f57ef3`) — the argument now sits at the widening in `session-forget.ts` and
names `fanout-serves-all-pieces`, the incident, and the AXIS: the risk scales with passes per reset,
not with how many doors can cause a reset, so five doors clearing once each is the same blast radius as
two. `turn-state.ts`'s docstring carries the 2 → 5 fact and the pointer, re-flowed to keep that file at
exactly its 239-line pin.**

**B7 — LOW. The lane took `clearServedConversations` from two callers to five, and the adjacent
incident its own docstring records is not addressed.** That function's docstring warns:
*"Clearing both ladders here would hand the unserved-wake drain two extra passes on every session
start, i.e. MORE self-wakes, on the one path a session reset touches … the wider clear was caught by
`fanout-serves-all-pieces` tripping the platform's own wake budget."* The warning is about widening
the function's **body**, which the lane correctly did not do — but three new session-boundary paths
now invoke it, which is a behaviour change on the same axis the incident lived on. The report's
correction #3 argues the per-session contract and never names that history or that suite. The full
suite is green (499 files / 7,505 tests), so **nothing is broken**; the gap is that the argument does
not reach the one prior failure this clear already had. *Fix:* one sentence in the header citing
`fanout-serves-all-pieces` and the fact that caller count, not scope, changed.

**✅ DONE 2026-09-26 (`b447352a`) — the table now says the BEFORE count is a nondeterministic draw
(yours 7/5/7, theirs 3/5/8, neither wrong) and that the load-bearing fact is 3/3 RED → 3/3 GREEN at 26.**

**B8 — NIT. Two count slips in the smallfry table.** Item 1's *"AFTER 3/3 GREEN, 26 each"* is right
(I measured 26); but the BEFORE failure counts are given as *"3, 5, 8 tests"* and reproduce as
**7 / 5 / 7** — a nondeterministic concurrent collision, so neither triple is wrong, and the table
should say so rather than quote one draw as the figure.

---

## 3. WHAT I DID NOT DO

1. **No behavioural run**; the gate wiring was dry-read and the manifest checker executed, not a cut.
2. **The kit-side smallfry item (`1d9300f`, comment-only in `dojo-test-kit`)** was out of my named
   slice and I did not review it.
3. **I did not re-measure the dashboard API census counts** (25 `localStorage`, 29 `WebSocket`, …).
   I verified the APIs are present and that the clause fires; the call-site counts are the report's.
4. **I did not fix the live tree's repointed `@dojo/shared`** (§0b) — it is another agent's live
   workspace mid-run. It needs an owner before slice A tears its worktree down.
