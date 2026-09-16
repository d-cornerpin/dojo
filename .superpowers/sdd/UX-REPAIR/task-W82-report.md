# W82 — T74b: the test suite gets its own home, and rotation stops deleting what it did not write

**Branch** `t74b-tests-stay-home`, based on **main `b382580`** (main's HEAD; verified an
ancestor of `ux-access-a7`/`a8`, so this ships with either the stable cache-fix cut or the
Preflight). Two commits, nothing pushed, no cut, no release.

| | |
|---|---|
| source | **`ab3e01da`** |
| gate-side | **`71dfde03`** |
| verified tree | `71b54746dc6ec89be971d2b9522f77a9c40e18c2` (identical to the tree the full suite and the gates were run against) |
| report | `dojo/.superpowers/sdd/UX-REPAIR/task-W82-report.md` |

**Worked in an isolated git worktree, never in the main tree.** The main tree was being
actively edited by another worker throughout (its dev server bounced at 01:35, 01:36 and
01:45 on `prompt/registry/entries.ts`, `call-llm/pre-call-injections.ts`,
`vault/retrieval.ts`, and it advanced from `0cc9a3ba` to `91af5ba7` while I worked). All
worktrees have been removed; the branch ref survives, checked out nowhere.

---

## VERDICTS

| clause | verdict |
|---|---|
| RED — writes land in a fake real home at HEAD | **PROVEN** |
| GREEN — real home untouched, canary byte-identical, all writes in the scratch home | **PROVEN** |
| tripwire throws on a deliberate violation | **PROVEN** (3 shapes) |
| full suite passes WITH the isolation on | **PROVEN** — 378 files / 5,381 tests, 0 failures |
| production rotation byte-identical on its own files | **PROVEN** (5 controls) |
| `npm run gates` | **13/13 blocking green**, 4/4 report instruments recorded |
| kit roster | **green** (`check-roster-conformance.mjs`, exit 0) |
| tests that needed fixing | **35 existing files; 5 cases in 3 of them were real findings** |

---

## 1 — THE DEFECT, RE-VERIFIED WITH MY OWN COMMANDS

W80's D1 is a **lead I re-derived, not a claim I inherited.**

**Census (mine, at `b382580`).** `grep -rn "homedir" packages/server/src`: **109 `os.homedir()`
call sites across 58 non-test files**, every one resolving the real home for itself, plus one
more resolution site W80 did not name — `migration/dependency-script.ts:98` reading
`process.env.HOME` directly. **110 sites, zero overridable.** `grep -rn "DOJO_HOME|DOJO_DATA|DOJO_LOG"`:
no matches. `find . -name "vitest.config*"`: **the server package had no vitest config file at
all** — no `setupFiles`, no `globalSetup`, no HOME redirection behind `vitest run`.

**RED, measured.** I built a fake "real home" with canary files and ran the **untouched**
suite at `b382580` against it (`HOME=<fake>`, which is what `os.homedir()` reads on POSIX).

- *Subset run* (22 files, `src/db/__tests__` + public-share): **9,151 lines appended to the
  canary `dojo.log`** (canary sha `f567…` → `70d6…`), **40+ share bundles** created under
  `.dojo/out/`, and **`.dojo/secrets.yaml` written** — a credentials file, into a home the
  test never asked for.
- *Full suite* (376 files): `~/.dojo/secrets.yaml`; **8,809 log lines, 8,759 of them
  `component:"migrations"`, across 25 migration boots**; **30 share bundles**; and `data/`,
  `prompts/`, `voice/` directories created. On the owner's real box the same run was 369
  boots and ~123,000 lines.

**The destruction is live on the box right now, and not only from tests.** While I worked,
the real `~/.dojo/logs/dojo.log.1` was rewritten at `08:46:17Z` and `dojo.log` began at
`08:46:24Z` — the backup holds **seven seconds**. It is **12.4 MB, 83,557 lines, 83,188 of
them `migrations`, 248 migration boots**. The per-process throttle is the mechanism: every
`tsx watch` restart is a new process with `lastRotateCheck = 0`, so it may rotate
immediately. Until this branch lands, any `npm test` — or a restart storm — keeps doing
this. **No trace of my own runs appears in the real log** (`grep -c "dojo-test-homes"` and
`grep -c "w82-tree\|w82-verify\|w82-base"` → `0` in both `dojo.log` and `dojo.log.1`).

---

## 2 — THE FIX

**(1) One lever.** `packages/server/src/home.ts` is now the only place the server decides
where home is: `DOJO_HOME` if set (absolute, or it refuses), `os.homedir()` otherwise.
**Production is unchanged by construction** — with the variable unset, `homeDir()` *is*
`os.homedir()`. All 110 sites call it, including `dependency-script.ts`.

**(2) Isolation, automatic.** `vitest.config.ts` picks one throwaway root per run and hands
it to every worker through `test.env`; `vitest.global-setup.ts` creates and removes it;
`vitest.setup.ts` runs **inside each worker before it imports a line of the code under
test** (which matters — most `~/.dojo` paths are module-level constants) and gives that
process its own home, pointing `DOJO_HOME`, `HOME` and `USERPROFILE` at it.

*Granularity: per worker PROCESS, and that is the honest answer for better-sqlite3.* It is a
synchronous in-process library; the damage shape is N operating-system processes opening and
migrating one `dojo.db` at once (369 concurrent boots is exactly that). Test files inside one
worker run in sequence and cannot collide that way, so the process boundary is the boundary
the pool model actually provides. Setup files re-run per test file, so a case that rebinds
`DOJO_HOME` cannot leak into the next file.

**(3) The tripwire, three ways.**
- *Runtime:* `homeDir()` **throws** when something resolves home during a test run with
  `DOJO_HOME` unset — the case where a script or a spawned child lost the variable.
- *Runtime:* `os.homedir` is patched per worker to **throw** when called from anywhere under
  `packages/server` except `home.ts`. **Narrowed after measurement, and this is stated
  because it is the guard's one concession:** a blanket throw took 137 test files down at
  collection — `playwright-core/lib/server/registry/index.js:482` resolves `os.homedir()` at
  module load. Third-party callers now get the scratch home (layer 2 already contains them);
  they are not the defect.
- *Static:* `src/__tests__/tests-stay-home.test.ts` greps the whole source tree, so a call
  site **nobody executes** is caught before the day it runs. It also refuses
  `process.env.HOME` in production files — that clause found `dependency-script.ts` — and
  asserts the three vitest files still exist, because the original defect was as much an
  absence as a bug.

**(4) Rotation hardening.** Split out of `logger.ts` into `src/log-rotation.ts` (the growth
gate asked for the split in those words), where **the keep policy is finally written down**:
one live file, one backup, never a `.2`. Two guards in front of the delete:
- **OWNERSHIP** — the backup is unlinked only if it is a *regular file* (not a symlink, not a
  directory) that is empty or begins with `{"timestamp":"`, this logger's own byte signature.
  No sidecar marker file: the log directory's contents are a user-visible surface.
- **AGE** — a backup younger than the 60 s throttle cannot be the product of a legitimate
  previous rotation of ours, so that rotation is **refused whole**; `rename` would clobber the
  backup as thoroughly as `unlink`. Self-healing: 60 s later it resumes.

*Production behaviour is not touched.* On its own files a real server's backup always carries
the signature and is always at least one throttle interval old, so it unlinks and renames
exactly as before. Asserted as five explicit CONTROLS, plus the incident replayed: wave one
rotates (correct — over threshold, backup hours old), the three inside seven seconds are
refused, and the history survives.

---

## 3 — PROOF

**GREEN, same canary, full suite.** Every canary file **byte-identical** after the run
(`dojo.log` `f56739380963e0d17cff4060ba8116ebbed47d0a`, `dojo.log.1`
`d91fc8c3d95dce122d68c697d41b5b593b6ef16d` — the pristine values), **not one new path
created** under the fake real home, and every write in the per-worker scratch homes.

**Full suite WITH the isolation on: `378 files / 5,381 tests, 0 failures`**, run from a
worktree inside the project folder at the verified tree.

**Baseline for comparison** — the untouched suite at `b382580` against a fresh fake home:
**4 files / 6 tests failing.** Three of those four were the disease itself (§4). The fourth,
`healer/recovery-single-owner`, fails only when the checkout lives under `/private/tmp`:
`evaluateScratchZoneAutoApprove` is asked about `path.join(process.cwd(), 'nope')` and
`/tmp` is a declared scratch zone. It passes from a normal location — which is why the final
run was done from one, and it is green there.

**Tripwire, deliberate violations** — all three throw, asserted in
`tests-stay-home.test.ts`: a direct `os.homedir()` from this tree; `DOJO_HOME` deleted mid
test-run; a relative `DOJO_HOME`. Plus the **production control**: with `DOJO_HOME`, `VITEST`
and `NODE_ENV` all cleared, `homeDir()` returns the real home and nothing else.

**Other instruments.** `tsc --noEmit` clean on server and shared; the packaged build emits
(`dist/home.js`, `dist/log-rotation.js`); **unused-symbol diagnostics diff-identical to
baseline** (I removed three `os` imports the codemod orphaned rather than let the count
rise); deletion-ratio reported on a clean tree.

---

## 4 — THE 35 TESTS, AND THE 5 THAT WERE REAL FINDINGS

**5 cases in 3 files were reading the developer's live database**, and passed only because his
`agents` table happens to exist. On a fresh checkout they were always going to fail —
`SqliteError: no such table: agents` is what the baseline run returns for every one.

- `migration/__tests__/manifest-version` (1) — `generateManifest` SELECTs `agents`.
- `memory/__tests__/summary-write-boundary` (3) — `getIdentityContext` SELECTs `agents`.
- `agent/v2/steps/post-execution/__tests__/contract` (1) — `agentCanSelfCompleteById` SELECTs
  `agents`, in a file whose own header says *"a unit test must not open the dev database."*

Fixed honestly: the first two now make their own schema with `runMigrations()`; the third
stubs the reader its header already said it must not reach.

**The other 32 redirected home by a mechanism the one lever replaces:** 17
`vi.mock('node:os')` factories → a mock of `home.js` at the same directory; 3
`vi.spyOn(os,'homedir')` fixtures, 4 `process.env.HOME =` blocks and 2 `vi.stubEnv('HOME')`
blocks → `DOJO_HOME`; 4 child-process `env:` objects now pass `DOJO_HOME` through beside
`HOME`; `agent/effects/facade-contract` builds its expected paths with `homeDir()` like the
code it measures; and `agent/tools/publish-path-guards` quotes the call site by name in a
source-census regex, so it moved with it.

---

## 5 — GATE-SIDE (separate commit `71dfde03`, standing rule)

- **ratchets +1 line each** — `gateway/routes/update.ts` 1171→1172, `healer/approval-routing.ts`
  496→497, `migration/import.ts` 407→408, `prompt/assembler.ts` 1826→1827. Four files that
  still use `os` for something else, so the `import { homeDir }` line is an addition rather
  than a swap.
- **`log-rotation.ts` named in `effect-import-exclusions.mjs`** with its class
  (platform-internal) and its reason. It holds the `node:fs` import `logger.ts` used to hold;
  same reach, same path.
- **lint baseline** `no-restricted-imports` 81→82, eslint total 104→105, grandTotal 217→218.
  The split created one more `node:fs` import *statement*; `logger.ts` still holds its own.
  The alternative was deleting the rotation policy's written explanation to stay under the
  240-line growth line.

---

## 6 — HANDED UP, NOT FIXED

1. **The defect is reproducing on the owner's box right now** (§1) — 248 boots / 83,188
   migration lines / a seven-second backup at `08:46:17Z` today, from the main tree, not from
   me. Every `npm test` or restart storm there keeps overwriting log history until this
   branch lands.
2. **`~/.dojo/out` holds 19,448 entries** of accumulated test residue. Not mine to delete; the
   isolation stops it growing.
3. **`effect-import-exclusions.mjs`'s PLATFORM-INTERNAL header says "43 statements / 37 files"
   and the list holds 36 such entries** after my addition (35 before). That count went stale
   when an earlier entry was removed. No checker reads it; I did not re-derive someone else's
   number two lines from my edit.
4. **`growth-baseline.json` is 37 days old**, past its 30-day shelf life — the gate says so
   itself on every run. Re-recording it is a gate-side decision, not mine to take here.
5. **`logger.ts`'s 60-second rotation throttle is still per-process.** Making it cross-process
   would change production behaviour, which this task explicitly excludes. The AGE guard
   covers the damage the per-process throttle causes; the throttle itself is untouched.
