# FINAL SWEEP — SLICE B (the reply-path pair, the visibility lane)

**REPLY-PATH (C2 + the honesty gate): SOUND. Ships.** The RED-first line reproduces verbatim, the
anti-repetition half genuinely holds under an independent over-widening mutant, the 5-of-17
measurement is confirmed against the owner's own body, and the de-duplicated predicate is
*exhaustively* equivalent to the form it replaced.

**VISIBILITY LANE: SOUND. Ships.** Every truth-table row the brief names is driven by a named,
green clause; the census tightening is real (`allow: {}`) and `Chat.tsx` came in one line *under*
its pin.

**ONE RELEASE-LEVEL FINDING, AND IT IS NOT MINE: `npm run gates` exits 1 at `a847076f`.** Neither
lane causes it — see F1. Every pin in my slice is satisfied exactly.

Verified in a detached worktree at `a847076f`, `packages/shared` built there, `node_modules`
wired per-worktree with `@dojo/shared` shadowed to the worktree's own copy. Worktree removed.

---

## Verified, with my own commands

| claim | verdict | evidence |
|---|---|---|
| RED-first line | **REPRODUCED VERBATIM** | reverting the two behavioural files (keeping `exit-attribution.ts` so imports resolve) → **9 F / 7 P**, including `cut 4: expected 'held' to be 'reopened'` |
| `no_reply_intended` still spends rungs and stands down | **HOLDS — caught 3 ways** | MC6 (adding it to `ENGINE_IMPOSED_EXITS`) → **3 F**, one of them *"`no_reply_intended` spends its rungs and STANDS DOWN at the bound: expected 'reopened' to be 'held'"* |
| the 5-of-17 measurement | **CONFIRMED on the live body** | read-only `SELECT`: `answered 5459 · no_reply_intended 3983 · handoff 1356 · park 117 · unknown 33` — exactly five non-null reasons, and **`iteration_cap` = 0 rows**, as are brake, identical_call, stop, preempt, provider_error, stream_idle, abort, terminated, budget, delegation_exit, compile_pending |
| 17 declared · one production writer | **CONFIRMED** | `TurnExitReason` has exactly 17 members; one `finalizeTurn(` call site outside tests (`finalize-record.ts:103`) |
| the fifth predicate's scope is narrow | **CONFIRMED** | my probe: `web_search`, `vault_remember`, `message_send`, `gmail_send`, and the near-misses `dojo_reporter`, `report`, `DOJO_REPORT`, `dojo_report_v2` **all stay quiet** with a live delivery claim; exact-name match, no substring leak |
| Arm C fires with the verbatim steer | **CONFIRMED byte-for-byte** | the steer equals the report's quoted text exactly, `is_error` content quoted inside it |
| `4b79e280` did not weaken the predicate | **CONFIRMED EXHAUSTIVELY** | I reconstructed the two-step original and swept every combination of 0–3 `dojo_report` calls × `isError ∈ {true,false,undefined}` × foreign-call present/absent (>50 cases): **identical null-agreement and identical counts** |
| truth-table key rows | **ALL GREEN, by name** | row 2 *"renders in regular mode"* + its *"BEFORE this lane that row returned null"* control · row 4 *"RC-9 IS INTACT"* · row 5 *"equals a visible answer → wordy-only"*, *"EXACT equality only"*, *"whitespace-only difference"* · row 10 *"SCHEDULER CYCLES KEEP THEIR BEHAVIOUR"* · row 7 *"a tool-only assistant row is NOT an answer"* · row 9 *"two notes, no answer between them"* · *"wordy mode shows every note, whatever the verdict"* |
| the census tightened | **CONFIRMED** | `marker-ownership.test.ts` now carries `allow: {}` — the entry is deleted, not commented into survival — and `Chat.tsx:4` imports `parseWorkingNote, WORKING_NOTE_PREFIX, INTERNAL_WORKING_NOTE_PREFIX` from `@dojo/shared` |
| no ratchet owed by the visibility lane | **CONFIRMED** | `Chat.tsx` **2048** vs pin **2049** |
| `2d41abf0` is gate-side only | **CONFIRMED** | one file, `ratchets.json`, +24/−2 |
| suites | **GREEN** | C2 16 · gate 15 · visibility 23 · truth-guards + marker-ownership + ask-settlement + answered-edge: **148** in the shared run; all touched suites pass |
| typecheck · dashboard build | **exit 0 · exit 0** | `✓ built in 3.52s` |

**Mutants re-planted (all restores sha256 byte-identical).** Reply-path: **MC3** ladder ignores the
attribution → **6 F** (claimed 6) · **MC6** over-widened → **3 F** (claimed 3) · **MC7** missing
record read as a cut → **1 F** (claimed 1). Honesty gate: **MH2** SUCCEEDED conjunct removed →
**2 F** (claimed 2) · **MH3** CALL-EXISTS removed → **2 F** (claimed 2), and its kill set includes
*"a DIFFERENT tool's error is not this artifact's — quiet"*, so the narrow scope is held by a
clause that dies when the scope widens. Visibility: **V1** R2 removed → **6 F / 17 P** (claimed
6/17) · **V3** R3 removed → **3 F / 20 P** (claimed 3/20).

---

## Findings

**F1 — MEDIUM (release-level, NOT this slice's). `npm run gates` exits 1 at `a847076f`.**
`packages/server/src/db/migration-checksums.ts` is **pinned 307, now 317 (+10)** and the
size-ratchet gate refuses. None of my six commits touches that file (checked each: 0 hits); it was
last moved by **`f4613141`** *"migration 168 is adjudicated; 165 is NOT"* — the migration lane. The
replypath report's "`npm run gates` exit 0" was true on its own branch (`t86-replypath` off
`e0c44fa6`) and is no longer true of the integrated HEAD. **Somebody owes a 307→317 raise before
this cut publishes**, and it is not either of my lanes.

**F2 — LOW. The body carries 535 turns with a NULL `exit_reason`, and the report's measurement does
not mention them.** The distribution I read is five reasons *plus* `(null) 535` — 4.7% of 11,483
turns. The code handles it correctly and deliberately: `turnWasEngineCut` is
`r?.exit_reason ? ENGINE_IMPOSED_EXITS.has(...) : false`, so a null answers "not a cut", spends a
rung, and keeps today's behaviour — the same conservative direction as the missing-record case that
MC7 pins. The gap is in the report's framing only: "FIVE exit reasons have EVER been written" is
true of non-null values, while the largest non-`answered` bucket after `no_reply_intended` is
*nothing at all*, and those are precisely the rows where the ladder's premise ("the model saw the
ask and chose silence") has the least evidence behind it. Worth a ledger line, not a fix.

**F3 — LOW. `park` is the one reclassified reason with live rows, and the report frames the change
as purely preventive.** `iteration_cap` has 0 rows, so that half genuinely cannot regress anything.
But `park` (**117 rows**) is in `ENGINE_IMPOSED_EXITS` too, so every park now stops spending a rung
— a real behavioural change on live data. The report does bound it (concern 4: *"park exists 117
times but never under an ask stand-down"*) and the module argues it (*"the turn got BUSY rather than
silent"*, with the hold arm owning the join case), so I am not disputing the decision — only that
"the fix is preventive and its RED is constructed" reads as zero-blast-radius when one reason in the
set has 117 live rows.

**✅ DONE 2026-09-26 (`t86-tidy` `b447352a`) — corrected to 9 F / 7 P in place, naming the ninth (§4's
second stand-down clause) and why it matters: the RED-first evidence covers the stand-down twice.**

**F4 — LOW (accuracy). The RED-first count is 9, not 8.** The report says the headline line plus
*"the other seven RED clauses"*. I measure **9 F / 7 P**; the extra is §4's
*"a promoted ack plus a cut, four times over"* (`round 4: expected 'held' to be 'reopened'`), a
second stand-down clause. The headline line itself reproduces exactly.

**✅ DONE 2026-09-26 (`b447352a`) — the report now carries a two-row table separating the EMITTABLE five
from the OBSERVED five, names `brake` (emittable, never written) and `unknown` (written by something
else) as the difference, states six post-fix, and folds in F2's 535 NULL rows.**

**F5 — LOW (accuracy, mine as much as theirs). Two of the five 5s in the C2 story are different
sets, and the prose merges them.** "One `finalizeTurn` call site … emits five of seventeen" is the
*emittable* set before the fix (brake, answered, park, handoff, no_reply_intended); "FIVE exit
reasons have EVER been written" is the *observed* set (answered, no_reply_intended, handoff, park,
**unknown**). `brake` is emittable-but-never-written; `unknown` is written by something that is not
this call site. Both claims are individually true; a reader who merges them will conclude `brake`
has rows, or that `unknown` comes from the derivation. After the fix the derivation emits six.

**F6 — INFORMATIONAL, and it is the honest limit of the gate rather than a defect.** Concern 2 of
the replypath report is the real residual: the guard is keyed to `dojo_report` **by name**
(`REPORT_ARTIFACT_TOOL`), which my probe confirms is an exact-match, leak-free scope — and that is
the design. The consequence is that a second door writing no `deliveries` row would be invisible to
all five truth guards, with nothing failing until it shipped. The census that would catch it does
not exist; the report says so, and I am agreeing rather than adding.

**F7 — INFORMATIONAL. The census tightening has no downside I can find.** `allow: {}` means there
is now *no* escape hatch for this marker, so any future local declaration fails loudly. That is
strictly better than the *"pending SWEEP-E"* permission it replaced, and the deletion was forced by
the census's own "entries that no longer match anything" clause — it fired, and it was right.

---

## Note on my own method, since it changed a result

My first mutant pass restored files with `git checkout -- <path>` after having staged pre-fix
versions with `git checkout <rev> -- <path>`. That restores from the **index**, which held the old
file — so everything after the RED-first step ran against a half-reverted C2 product and reported
nonsense (a source-census clause failing on unrelated engine prose). I caught it on the
sha256 mismatch line, reset hard, and re-ran the whole C2 trio with `git show <rev>:path > path`
(which never touches the index). **Every number in this review is from the clean pass.** The
sha-after-restore check is what made the contamination visible rather than plausible.

## Bottom line

Both lanes in my slice are sound and mutation-proven, and I could not break either one's central
claim. The only thing standing between this branch and a cut is **F1**, which belongs to the
migration lane.
