# The dashboard's test runner — BACKLOG line 54

Branch `t86-dashrunner`, cut from `t86-backlog`, rebased onto its current tip.

| | |
|---|---|
| base | `ef14e948` (the visibility lane, already on `t86-backlog`) |
| `2bedeb5f` | the runner + the rules from T5 / T6 / T7 / lane 4 |
| `57c2f52e` | the DOM half of the visibility lane's three rules |
| suite | **45 clauses · 7 files · ~5.6 s**, green on three consecutive runs |
| mutation round | **9 mutants, 9 RED**, every file verified reverted |

Files added: `packages/dashboard/vitest.config.ts`, `vitest.setup.ts`,
`src/__tests__/*.test.tsx` (6), `src/__tests__/helpers/frames.ts`.
Files changed: `packages/dashboard/package.json` (scripts + 4 devDeps),
`packages/dashboard/tsconfig.json` (exclude tests from the build program),
root `package.json` (`test`, `test:server`, `test:dashboard`, `typecheck`).
**No product file was changed.** Every finding below is reported, not patched.

---

## 1. The environment: happy-dom, and the argument is a census

The choice was made by counting what this dashboard actually calls, across all 121
files of `packages/dashboard/src`:

| API | call sites | happy-dom | jsdom |
|---|---|---|---|
| `localStorage` | 25 | ✅ | ✅ |
| `WebSocket` | 29 | ✅ | ✅ |
| `requestAnimationFrame` | 6 | ✅ | ✅ (needs `pretendToBeVisual`) |
| `URL.createObjectURL` | 5 | ✅ | ✅ |
| **`matchMedia`** | 2 | ✅ | ❌ hand-stub |
| **`ResizeObserver`** | 2 | ✅ | ❌ hand-stub |
| **`IntersectionObserver`** | 1 | ✅ | ❌ hand-stub |
| **`Element.scrollIntoView`** | 2 | ✅ | ❌ hand-stub |
| **`navigator.clipboard`** | 7 | ✅ | ❌ hand-stub |
| `canvas.getContext` | 1 (**WebGL**, the orb) | ❌ | ❌ (its optional `canvas` is 2D) |

jsdom would have cost this repo **five hand-written stubs** whose fidelity nobody
would ever check — and it buys nothing back, because the one thing jsdom does
better here is canvas, and the single call site asks for WebGL, which neither
implements. happy-dom is also ESM-native and starts in a fraction of the time,
which matters for a suite meant to join the release path rather than be run when
someone remembers.

The residue is **one** stub: `HTMLCanvasElement.getContext` returns `null`, which
is what a browser answers when the context is unavailable and what the orb engine
already has to survive. It is not a fake GPU.

**The census is itself a test** —
`src/__tests__/the-dom-environment-provides-what-the-dashboard-uses.test.ts`
asserts all ten rows. A happy-dom upgrade that drops one names itself instead of
making a component test fail three files away.

### The network tripwire (the sibling of `src/home.ts`'s real-home tripwire)

`fetch` throws in a dashboard test. The server suite's lesson was that a test
which can reach outside itself eventually does (123,000 log lines in the owner's
real `~/.dojo`); the dashboard's version of that mistake is a component test that
passes because `:3001` happened to be up. **It caught an un-mocked call on its
first run** (`components/LinkPreview.tsx:27`). Opting out is per-clause and
explicit (`vi.stubGlobal('fetch', …)`, un-stubbed after every test).

---

## 2. Migrated rules — every deferred rule I could find, with its status

Collected by grepping `.superpowers/sdd/{DOJO-REPORT-PLAN,BACKLOG-CAMPAIGN}` for
`no test runner` / `DOM runner` / `unheld` / `residual`. Five sources named the
same gap in the same words.

### HELD now (24 of the 45 clauses are these rules; the rest are the floor + the census)

| # | Rule, as its report stated it | Source | Where it is held | Mutant |
|---|---|---|---|---|
| 1 | "the brief's five fields actually reach the DOM unescaped-but-uninterpreted… **the one worth a DOM runner**" | T6 §7 | `the-brief-you-approve-is-the-bytes-you-see` — five fields byte-for-byte (runs of spaces, hard newlines), each ONE text node with no structure inside it, plus a card-wide refusal of `b/em/strong/code/script/li/a` | **M1** — render the brief through `<Markdown>`: **8 clauses RED** (⚠ CORRECTED 2026-09-26, final sweep C / B4 — reported as 16; the file holds 8 `it`s and M1 kills all 8, 8 F / 37 P. And the granularity was overstated too: M1 also times out the first `waitFor` at ~1,013 ms and the subscription and delivery-panel clauses cascade off it, so the file cannot distinguish *the bytes rule broke* from *the card stopped rendering*. The rule is genuinely held; the number and the resolution were not) |
| 2 | "that `loadStatus()` is called on every frame (the refetch-on-event idiom, never a partial merge)… **this is the one worth a DOM runner if the house ever gets one**" | T5 §2b | `a-frame-refetches-the-whole-answer` — all four frames refetch, and the WHOLE new answer replaces the card (the frame's own `login` never reaches the screen) | **M5** — merge the frame instead of refetching: 2 RED |
| 3 | "the four `subscribe()` wirings and their cleanup" | T5 §2b | same file — four subscriptions counted, four unsubscribed on unmount | (M4's sibling) |
| 4 | "the two `subscribe()` wirings and their cleanup" | T6 §7 | `…bytes-you-see` — both frames refetch, both unsubscribe | **M4** — drop the cleanup: RED |
| 5 | "the `problem` state — text of the last `github:connect_failed` frame, and of a refused `POST /connect`… **the honest gap**" | T5 §2b | `a-frame-refetches-the-whole-answer` — the reason renders; a frame with **no `error` field** renders the fallback sentence; a new attempt clears it | — |
| 6 | "the `delivery` panel (file path + paste link, rendered after the row leaves the list)" | T6 §7 | `…bytes-you-see` — the export path and the prefilled link's `href`, and the row is gone | — |
| 7 | the consent sentence names the destination **the list door answered with** | T6 (D4) | `…bytes-you-see` — both branches, expectations COMPUTED from `postTargetSentence` so the sentence is never copied | **M2** — a constant repo: 2 RED |
| 8 | Save sends only what moved, and saving is never approving | T6 | `…bytes-you-see` | **M3** — send the whole form: RED |
| 9 | "pressing 'Add to it' in a browser calls `handlePost({addToExisting})`" (three buttons, three handlers) | T7 §6 | `the-duplicate-answer-is-the-owners` — all three answers, plus "Not now" posting nothing | — |
| 10 | "Forcing the fast path unconditionally still survives, and will until `packages/dashboard` has a test runner" | lane 4 | `a-hidden-credential-draws-a-chip` — the chip is drawn, the raw token never reaches the page, one chip per placeholder; the fixture proves itself against the shipped recognizer first | **M6** — force the fast path: 4 RED |
| 11 | "whether the dashboard dims or fully hides `working-note`: … Read off `pages/Chat.tsx`'s render" | lane 6 §5(a) + the visibility lane | `the-feed-asks-the-visibility-rule` — R1/R2/R3 and RC-9's survival, driven through the real feed, on **both** note arms | **M8, M9** — drop the call from either arm: RED |
| 12 | mount-once (`loadedRef`) on both cards | T5 §2b, T6 §7 | both card files — one door call at mount, not two | — |

### STILL DEFERRED — named, not implied to be covered

| Rule | Source | Why it is still open |
|---|---|---|
| `busy` disabling (both cards) | T5 §2b, T6 §7 | holdable now, just not held: needs a slow-resolving door and an assertion on `disabled`. ~20 minutes, no blockers. |
| the two-click Cancel confirm + the discard toast (report card) | T6 §7 | same: holdable, unheld. I stopped at the consent path. |
| `problem` on the **report** card (a refused approve / save / cancel) | T6 §7 | held for the GitHub card, not for this one. Same shape, ~15 minutes. |
| the other ~74 components and 10 pages | — | the smoke floor proves they MOUNT; nothing asserts what they draw. That is the honest state of the package, not a gap this task closed. |
| a rejecting `fetch` in the smoke floor | this task | blocked on the two defects in §4. When they are fixed, flip the stub back to a rejection and the floor gets stronger. |

---

## 3. Wiring — and the gate-manifest diff the coordinator asked for

### Done here

* `packages/dashboard/package.json` — `test: vitest run`, `test:watch`, `typecheck`.
* root `package.json` — `test` runs **server then dashboard**; `test:server` /
  `test:dashboard` for one at a time; `typecheck` now also runs
  `tsc --noEmit -p packages/dashboard/tsconfig.json`.
  *That last one closes a claim the release script has always made and never
  checked:* `deploy/release.sh:237` prints `✓ server, shared, dashboard typecheck
  clean` while `npm run typecheck` checked two of the three. It passes with the
  dashboard added (exit 0), once `packages/shared/dist` exists — the same
  precondition the server step already has.
* `packages/dashboard/tsconfig.json` — tests excluded from the build program,
  exactly as `packages/server/tsconfig.json` excludes its own. Verified: `tsc
  --listFiles` contains zero `__tests__` paths. **Consequence, stated: the test
  files are transpiled but not type-checked** — the same standing trade the server
  suite makes.

### NOT done here, deliberately: the blocking gate

`npm run gates` runs no suite at all — both suites are `release-only` tier by
owner ruling 2026-07-21 (`deploy/checks/gate-manifest.mjs:290`). So joining the
dashboard suite to the blocking path means one manifest row and one `release.sh`
step, and **they must move in the same commit**:
`deploy/checks/check-gate-manifest.mjs:238` requires a literal
`step "<title>"` in `release.sh` for every release-only row, so editing either
file alone fails the gate. I did not touch either.

**Proposal A (preferred — one suite gate, one owner):**

```diff
--- a/deploy/checks/gate-manifest.mjs
+++ b/deploy/checks/gate-manifest.mjs
@@ -290,8 +290,10 @@
     id: 'unit-suite',
     tier: 'release-only',
     phase: 'n/a',
     script: null,
     args: [],
-    title: 'Unit-suite gate (packages/server vitest, full run)',
-    why: 'Owner ruling 2026-07-21: suites in no gate rot silently — 8 suites sat red for up to 8 weeks, one carrying a real production bug. Minutes long, so it is a release gate rather than a per-commit one, and it is never skippable.',
+    title: 'Unit-suite gate (server + dashboard vitest, full run)',
+    why: 'Owner ruling 2026-07-21: suites in no gate rot silently — 8 suites sat red for up to 8 weeks, one carrying a real production bug. Minutes long, so it is a release gate rather than a per-commit one, and it is never skippable. The DASHBOARD suite joined it the day that package got a runner (t86-dashrunner): it holds the byte-to-DOM consent gate, the refetch-on-event idiom and the working-note visibility rules — a red there is an owner looking at the wrong text or at nothing, which is exactly the class this gate exists for, and ~6s of the run.',
   },
```

```diff
--- a/deploy/release.sh
+++ b/deploy/release.sh
@@ -507,6 +507,6 @@
-step "Unit-suite gate (packages/server vitest, full run)"
-( cd "$SCRIPT_DIR/../packages/server" && npx vitest run --reporter=dot ) \
-  || fail "Unit-suite gate: server unit tests are red. Root-cause and fix (owner rule: testing exists to find problems); NOT publishing."
-echo "- unit suite: full packages/server vitest run, green (never skippable)" >> "$RELEASE_RECORD"
+step "Unit-suite gate (server + dashboard vitest, full run)"
+( cd "$SCRIPT_DIR/../packages/server" && npx vitest run --reporter=dot ) \
+  || fail "Unit-suite gate: server unit tests are red. Root-cause and fix (owner rule: testing exists to find problems); NOT publishing."
+( cd "$SCRIPT_DIR/../packages/dashboard" && npx vitest run --reporter=dot ) \
+  || fail "Unit-suite gate: DASHBOARD tests are red. Root-cause and fix; NOT publishing."
+echo "- unit suite: full server + dashboard vitest runs, green (never skippable)" >> "$RELEASE_RECORD"
```

Two invocations rather than the root `npm test`, so the failure message names
which suite is red.

**Proposal B (alternative):** a second manifest row `dashboard-suite` with its own
`step`. More granular reporting in the release record; two rows to keep in sync,
and the `why` text has to argue for a second gate rather than for a wider one. A
is the smaller lie-free change.

⚠ **Either way the coordinator must run `npm install` at the repo root**: the four
devDependencies are declared but `package-lock.json` is NOT regenerated in this
branch (see §5 on how the suite was verified without it).

---

## 4. Findings the runner produced on its first real run — for routing, not patched

1. **A failed `fetch` escapes as an unhandled rejection from two page loaders.**
   `pages/Techniques.tsx:35` (`fetchTechniques`, via `load` at `:93`) and
   `pages/Settings.tsx:1014` (`load`, via `:1030`) have no `.catch`. With the
   server down, the list silently never arrives and the owner is told nothing.
   Both files belong to other lanes this round, so the smoke floor mounts against
   a server that ANSWERS 503 instead, and says so where it does it.
2. **18 files call the global `fetch` directly instead of going through
   `lib/api`** — pages `Settings`, `Health`, `Techniques`, `TechniqueDetail`,
   `Setup`; components `TechniqueSelector`, `TechniqueCard`,
   `TechniqueSessionProvider`, `MigrationExport`, `ActiveJobsIndicator`,
   `LinkPreview`, `CanvasView`, `ImportWizard`, `PostMigrationBanner`,
   `GoogleActivityLog`, `MicrosoftActivityLog`, `orb/useOrbActivity`,
   `lib/voice/voice-client`. Those calls have **no door a test can mock**, which is
   why the smoke floor has to stub a global. Worth a sweep: it is also the reason
   the tripwire cannot be strict everywhere.
3. **`pages/Agents.tsx:353` reads `result.data.warnings.length` with no guard.** A
   door answering `ok` without that field costs the owner the Ollama warning and
   throws inside an async handler where nobody sees it.
4. **⚠ CORRECTED AND CLOSED 2026-09-26 (final sweep C / B5): SEVEN product headers stated a
   false premise, not four, and they are now swept.** The list as written named four of the
   five files it then listed and missed three. The real seven, measured by
   `grep -rln "no test runner" packages/dashboard/src`:
   `components/GitHubSettings.tsx`, `components/Markdown.tsx`,
   `components/ReportPreviewCard.tsx`, `lib/credential-placeholder.ts`,
   `lib/github-card.ts`, `lib/provider-edits.ts`, `lib/stop-affordance.ts`
   (`lib/working-note-visibility.ts`, named here, does not carry the sentence).
   All seven were swept comment-only on `t86-tidy`, keeping each original argument and
   dropping only the false premise — a component test can assert what was RENDERED, not what
   a door would accept, which is why a DECISION still belongs in a pure module. The original
   text of this item follows, for the record: four headers, each saying *"`packages/dashboard`
   has no test runner"* as the reason a rule lives where it lives. The
   ARCHITECTURE is still right (decidable rules belong in `lib/`, driven from the
   server suite — that is cheaper than a DOM test and always will be), but the
   sentence needs one clause added: *"…and the DOM half is held in
   `dashboard/src/__tests__`."* I left every one of them alone — three are in
   files other lanes are editing this round, and a stale comment is a smaller
   problem than a conflict.

---

## 5. How this was verified, and what a fresh checkout changes

The worktree has no `node_modules` of its own, and the `@dojo/shared` shadow trap
is real: a naive symlink to the repo's tree makes `@dojo/shared` resolve to the
MAIN checkout's package, so a worktree would silently test another branch's
shared code. What was built instead:

* `node_modules/` — one symlink per top-level entry of the repo's tree, **except
  `@dojo`**, which is a real directory whose `shared` / `server` / `dashboard`
  point at THIS worktree. Verified: `require.resolve('@dojo/shared')` →
  `<worktree>/packages/shared/src/index.ts`.
* the same rule one level down, because this repo keeps per-package installs:
  `packages/dashboard/node_modules/{@novnc,onnxruntime-web,onnxruntime-common}`
  from the repo, `@dojo/shared` from the worktree. (Without it, `vite` cannot
  resolve `@novnc/novnc/core/rfb.js` and the whole suite fails to collect.)
* the four new devDeps installed into a scratch prefix and **copied** (not
  symlinked) into the worktree, because Node resolves a symlinked package's own
  dependencies from its REAL path: symlinked, `@testing-library/react` found the
  scratch prefix's React 19 peer copy and every render died with *"A React Element
  from an older version of React was rendered."* Copied, it resolves the repo's
  React 18.3.1 — one React, which is the only arrangement that works.
* `npm run test -w packages/dashboard` and `npm run typecheck` were both run
  through **npm**, not just through a bare binary, so the script wiring is
  measured and not assumed.

On a fresh `npm install` at the repo root, none of that scaffolding exists or is
needed — it is worktree plumbing, and nothing in the committed diff depends on it.

---

## 6. Concerns

1. **The lock file.** `package-lock.json` is untouched; the coordinator's
   `npm install` is a required step before the suite runs anywhere else. If the
   integrator wants the lock in this branch, it is one command and one commit —
   I left it out rather than commit a lock resolved against a hand-built scope.
2. **The gate is not wired.** Until the §3 diff lands, this suite is in no gate,
   which is exactly the condition owner ruling 2026-07-21 exists to refuse. It is
   the one thing this task could not finish alone by instruction.
3. **The smoke floor is deliberately shallow** (mount, plus "something rendered").
   Ten pages, no content assertions. That is a floor, not coverage, and a reader
   who takes it for coverage will be wrong.
4. **Two tests mount `pages/Chat.tsx` and `pages/Settings.tsx`** — the two hottest
   files in the tree this round. They assert nothing about layout, so a redesign
   will not break them, but a lane that deletes the `showsWorkingNote` call or the
   `whitespace-pre-wrap` field rendering WILL see red. That is the point, and the
   test headers say which rule and which report it came from, so whoever hits it
   can tell a regression from a deliberate change in about ten seconds.
