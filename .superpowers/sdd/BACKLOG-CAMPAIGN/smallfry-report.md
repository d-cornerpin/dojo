# SMALL-FRY SWEEP — release-blocker round

**Branch** `t86-smallfry` off `e0c44fa6` (t86-backlog tip), detached worktree. Kit-side item
committed in `dojo-test-kit` (`1d9300f`), one file, as authorised.
**Status: COMPLETE — 11 items fixed, 6 skipped with reasons, 0 gates red.**

Full suite **492 files / 7412 tests green**, `tsc --noEmit` clean (server AND dashboard), and the
whole gate battery green including `check-ratchets` (284 pinned files at or below their pin) —
**no ratchets.json or gate-manifest pin was edited; every pin was met by fitting the change.**

---

## THE TABLE — line → commit → proof

| # | BACKLOG line | item | commit | proof |
|---|---|---|---|---|
| 1 | `:25` | `a-rename-reaches-the-soul` + `a-service-agents-card` fixed `os.tmpdir()` path | `0da8a23b` | 3 concurrent runs: **BEFORE 3/3 RED** (3, 5, 8 tests) with the backlog's own `ENOENT … /T/dojo-t50-rename-souls/.dojo/prompts` — **AFTER 3/3 GREEN**, 26 each |
| 2 | `:40` | W3 rehydration bound, consistent with the W2 ceiling | `f2a0da1a` | §6.1 RED on the pre-fix read: *"expected [ 'tool_0437', … ] to include 'tool_0519'"* — the newest load was absent. §6.2 (under the cap) green both ways = the fix is free |
| 3 | `:34` | `system.ts` / `agents.ts` missing `clearSessionLoadedTools` — **audited, real** | `6dec4c73` | census of all 5 boundary writers; clause REDs by name when a door is un-wired: *"expected [ 'gateway/routes/system.ts' ] to deeply equal []"* |
| 4 | `:75` | the two reset doors disagree on `clearServedConversations` — **measured: three of five** | `6dec4c73` | same clause + §2 behaviour pin (both clears, per-clear best-effort); 25 door suites / 329 tests green |
| 5 | `:74` | N1 lost-manual release banner said "soul template" | `b846e527` (gate-side) | gate's header lines 95-127 cover `src/tools/docs/*.md`; title + `fail` now name manuals; `check-gate-manifest` green |
| 6 | `:74` | N3 `ReportDeliveryPanel` comment overclaimed GitHub's reason | `e891ea12` (product) | measured two producers in `github/issues.ts`: `labelsDroppedNote` carries `githubsWords(refusal)`, `silentlyDroppedNote` is read-back only |
| 7 | `:44` | doc drift: "session tool docs reset on restart" — they rehydrate | kit `1d9300f` | `rehydrateSessionToolsFromHistory` replays them; 43 observed. Comment corrected AND its purpose restated (it is what makes the golden session-independent, not a reboot workaround) |
| 8 | `:75` | seven-reflex block renders on an unpinned predicate | `601d7afc` | PART 6: renders with all three names; `it.each` proves it does NOT with any one missing; plus the T85 knock-on (tools exist, head empty → no block) |
| 9 | `:78` | FR-3 site-level min unguarded | `601d7afc` | clause calls `readTurns` DIRECTLY with 10,000. MUTATION: delete the `Math.min` → *"expected 40 to be 20"*, and **the other 23 clauses in that file stay green** — the size of the hole, measured |
| 10 | `:78` | the `'timestamp'`-row-count tripwire | `601d7afc` | MUTATION: declare a second `'timestamp'` field → RED by name, with the remedy in the message |
| 11 | — | my own +1 over `maintenance.ts`'s pin | `d9eb8787` | `check-ratchets` caught it; 2170/2170 restored |

## SKIPPED, each with a reason

| BACKLOG line | item | why not done |
|---|---|---|
| `:44` | golden's always-loaded line vs array mismatch | **VERIFIED ALREADY FIXED**, not assumed: `prompt/assembler.ts:756` passes `partitionToolsForApiCall(...).alwaysLoaded` and `categories.ts:306` carries the T85 argument. The backlog's own "being fixed in the audit fix bundle (item 5)" has landed |
| lane 2 report | L6-2's kind | **VERIFIED SHIPPED**: the three-clause pin exists at `agent/v2/steps/preflight/__tests__/a-scheduler-cycle-has-no-continuation.test.ts`. Nothing of that kind was left open in the reviews I could read |
| `:78` | two residual 401 prose shapes · aliased-setter boundary · two-hop prong-C limit | **CANNOT READ THE SPEC**: their detail lives under `.superpowers/sdd/DOJO-REPORT-PLAN/`, which does not exist on this branch (only `BACKLOG-CAMPAIGN` and `UX-REPAIR` do). Guessing at a review's intent from a half-line is how a sweep ships a wrong fix |
| `:78` | whitelist 230/230 step-0 split conditions | Not a defect: a precondition recorded for the FIRST field-adding task. Nothing to fix until that task exists |
| coordinator's list | embeddings · orphan tap · serverIdentity · C2 · honesty gate · visibility · dashboard runner · kit owed-live | other lanes', as instructed |

## WHAT THE MEASUREMENTS CHANGED

Three items were not what their backlog line said, and in every case measuring first changed the
fix rather than confirming it:

1. **The reset-door cluster was bigger than both lines describing it.** `:34` asked whether two
   files were "possibly missing" a call (they were) and `:75` described a two-door disagreement.
   The real shape: FIVE writers of `agents.session_started_at`, giving FOUR different answers,
   with exactly one door doing both clears. Fixing the two named sites would have left three
   doors disagreeing. The fix is one owner (`agent/session-forget.ts`) plus a source-walk clause,
   so a sixth door cannot drift — the drift, not the clears, was the defect.

2. **W3's remaining gap was a DIRECTION, not a size.** The set is already bounded (the W2
   ceiling). What was wrong is that the replay read the OLDEST 500 rows while the ceiling keeps
   the NEWEST names — two bounds pointing opposite ways, so an agent past the cap would rebuild
   from its most ancient loads. I also rejected the obvious "make them consistent" move of keying
   the row cap on `SESSION_TOOL_SET_MAX`: a load row can place ZERO new names, so no row count
   provably carries 64 distinct survivors. Stated in the test header rather than asserted.

3. **`clearServedConversations`: the ROUTE side was right, and not as a preference.** Each
   cleaner's own contract decides it — "the per-agent turn-continuity scratch state ON A NEW
   SESSION" and "a reset is a DECISION to forget". Both are defined per-session, so every
   boundary writer owes both. No cleaner's scope was widened.

## CONCERNS

1. **`.superpowers/sdd/DOJO-REPORT-PLAN/` is absent from `t86-backlog`.** Five backlog lines
   (`:35`, `:36`, `:73`, `:74`, `:76`, `:77`) point their detail at files under it. I worked the
   items the backlog line itself described fully enough (N1, N3) and skipped the ones it did not.
   Whoever holds that directory should either land it on this branch or fold the detail into the
   backlog lines, or the next sweep will skip the same items for the same reason.
2. **`packages/dashboard` is still outside the root typecheck script** (`:28`'s own raise). I
   typechecked it explicitly for the `.tsx` comment edit; a lane that forgets to will not be told.
3. **The tmpdir family may have more members.** I fixed the two the backlog named and proved both.
   The pattern is `path.join(os.tmpdir(), '<constant>')` in a test that `rmSync`s it — worth a
   sweep of its own; I did not run one, so I am not claiming the family is closed.
4. **`categories.ts` sits at exactly the 400-line new-file cap** (`:75`'s third clause, untouched
   by me and still true). The seven-reflex pin is test-side only for that reason. The next change
   to that file needs the split first, not an argument.
5. **One kit file touched** (`checks/check-cache-prefix.mjs`), comment only, under the
   one-file-at-a-time authority. The kit's working tree also carries an unrelated dirty
   `behavioral/results/last-run.json` that is not mine and that I left alone.
