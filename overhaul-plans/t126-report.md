# t126 — the video poll loop no longer outlives the process that started it

**Status: DONE** · branch `t126-poller-teardown` · worktree `worktrees/t126-poller-teardown` · from `abb482c0`

| | |
|---|---|
| `aa9cb32d` | the video poll loop no longer outlives the process that started it (product) |
| `a75b203d` | ratchets: the two pins t126's owned poll-loop lifetime raises — no product file (gate-side only) |
| `97cf7ef3` | the poller's lifetime moves to its own module, where its argument fits (product) |

## Step 0 — the premise, re-derived at my head

t123's note (`t123-report.md:481–496`) is accurate on every point I could check:

- `video-job-poller.ts` and `a-render-the-provider-still-reports-running-is-not-failed.test.ts` are
  byte-identical to `abb482c0` at my base, and the test imports none of t123's modules.
- the `void pollLoop(...)` sites are at `:447` and `:467` of main's file.

What t123 did **not** have, and what the fix turns on, is the second half of the mechanism — see
below. One number in the brief needed correcting: the brief points at
`services/video-job-poller.ts`; the file is `packages/server/src/services/video-job-poller.ts`.

## Diagnosis — it is NOT only the un-owned loop

The brief asked which it was: an un-unref'd timer, or an awaited fetch with no abort tie. It is
the second, plus a thing neither option names, and that third part is why the failure was an
`unhandledRejection` rather than a log line.

Reproduced deterministically before touching anything (a throwaway probe: start a loop, let it
reach its backoff, close the DB, let the backoff wake land) — **exactly one** unhandled rejection,
and its message identifies it:

```
REJECTIONS: [ 'test DB not initialized' ]
```

The chain, verified by reading each link rather than inferred:

1. `pollLoop` is fired with a bare `void`, runs up to thirty minutes, and spends nearly all of it
   asleep in a 5–30s backoff. Nothing tied it to the process going down.
2. At shutdown `index.ts` calls `closeDb()` and exits; under test teardown `mockDb.current = null`.
   A loop that wakes afterwards calls `getJob` → `getDb()` → **throws**.
3. The throw is caught by the loop's own `catch` — and **`markFailed` inside that `catch` calls
   `getDb()` again**, which throws the same error straight back **out of the handler**. So the
   honest log path (`logger.error('video poll loop threw')`) was *skipped*, and the `void`-ed
   promise rejected with nobody listening.

Step 3 is the part that makes this the class the brief names rather than a stray throw: the error
path could not report the error, because the error path needed the thing that had gone away.

Two further facts the fix depends on, both checked rather than assumed:

- **`logger` does not touch the DB** (`grep getDb logger.ts` → nothing), so the stand-down may log.
- **`AgentCallSlot.cutBy()` cannot answer this question.** It reads `abortReasonOf(ctl)` — the
  slot's *own* controller — deliberately, so a caller's clock can never be misread as a stop
  (`abortable-call.ts:50`). A lifetime composed in as an *external* therefore wakes the sleep but
  leaves `cutBy()` null: the loop would see an aborted signal, an instantly-resolving sleep and no
  reason to exit, i.e. the hot-spin the file's own A-5 note at `:334` warns costs a vitest worker
  an OOM crash. **The stand-down had to be its own check.** This cost me a mutant-green round and
  is the single most important thing in the new module's header.

## The fix

`services/video-poller-lifetime.ts` (new, 66 lines) owns one question — *is this process still
willing to poll?* — and the poller only reads it. Separate module for `media-job-status.ts`'s
reason: the question is asked by the loop, by `index.ts`'s shutdown and by the clauses, and a
second copy of the answer is how a vocabulary drifts.

- `pollerStopped()` is read at **each of the two points the loop could next touch the DB**: above
  the iteration's first `getJob`, and after the poll leg returns, before the `attempt_count`
  UPDATE. Two guards, not one, because they cover different phases — asleep, and on the wire.
- **The stand-down writes nothing.** No row, no broadcast, no verdict, not even an `attempt_count`
  bump. A shutdown is not a verdict on a render still running at the provider, so the row is left
  active and `startVideoJobPoller`'s boot resume adopts it — which is what that resume is for.
  This is the A-5 doctrine: `cancelled` carries the owner's name and a process going down never
  earned it.
- `pollerSignal()` **is** composed into the loop's slot, which is what cuts the in-flight HTTP leg
  and wakes the backoff sleep. The *exit* is still the loop's own check — see above.
- The backoff `setTimeout` is **`unref`'d**, as `stall-sentinel.ts:217` and `router/maintenance.ts`
  do theirs, so a pending 30-second sleep can never be why the box refuses to exit.
- Both detached sites go through **`detachPollLoop`**, which routes a rejection into
  `logger.error`. This is the backstop: no poller failure — *including one from the error path
  itself* — can surface as an unhandled rejection again.
- An **entry fence** declines a late `enqueueVideoJob` (a turn can still be unwinding after
  `closeDb()`), and **`rearmVideoJobPoller()`** at boot is the one thing that lifts the fence.
- `index.ts`'s `shutdown()` calls `stopVideoJobPoller()` **before** `closeDb()`, beside the two
  worker-thread stops, in the same best-effort shape as the `stopTunnel()` line below it. The
  position is the whole point; placed after `closeDb()` the statement is decoration.

## Clauses — `the-video-poll-loop-does-not-outlive-its-process.test.ts`, 15 of them

**Driven, never slept.** Two seams make the drive honest, and both exist because a first draft was
dishonest in a way that mattered:

- **The phase a shutdown lands in is CHOSEN.** A gated `fetch` holds a leg on the wire until the
  clause lets it go; `untilSleeping()` waits for the `attempt_count` write that happens on the line
  before the sleep. The first draft stopped the poller as soon as a dial was *recorded* — which is
  mid-leg — so the mid-sleep guard was never exercised and **deleting it kept every clause green**.
- **Quiescence is observed, not waited out.** `untilLoopSettled()` polls
  `activeAbortControllers.has(AGENT)`: a loop that stood down has run its `finally` and released
  its slot, so "the registry no longer knows this agent" *is* "the promise settled and no timer of
  its own is pending". §1's second clause asserts the registry **does** know it while it runs, so
  the observable cannot pass vacuously.

| § | clause | mutant that reds it |
|---|---|---|
| §1 | the DB goes away under a live loop: nothing rejects unhandled, **and** nothing is logged at warn-or-above (a stand-down is *silent*) | mid-sleep stand-down deleted; stand-down writes a verdict |
| §1 | the loop's promise **settled** — it released its slot (and held one while running) | the pre-fix file |
| §1a | a shutdown landing **mid-leg** stands down as cleanly, and records no `attempt_count` | mid-leg stand-down deleted |
| §1b | not one further dial after the stop, measured past a whole further backoff | mid-sleep stand-down deleted; verdict mutant |
| §2 | the stop **wakes** the loop — it exits inside `POLL_START_MS`, not after it | the pre-fix file |
| §3 | the stood-down loop writes no row, no error, **no attempt** | verdict mutant |
| §3 | and posts no apology into the owner's chat | verdict mutant |
| §3 | the row it leaves open is one `countActiveVideoJobs()` actually counts — standing down is not a leak | the pre-fix file |
| §4 | a fenced enqueue does not even register a slot (sampled **synchronously** — the slot is released a tick later and a post-drive check cannot tell the two apart) | — (see honest note below) |
| §4b | the fence holds **after the DB is gone**: a late enqueue is a silent no-op | entry fence deleted |
| §4 | a fresh boot re-arms it and resumes the open render | boot re-arm deleted |
| §5 | the DB goes away **without** a stop: the loop's own error path throws and it is **LOGGED**, not rejected | `detachPollLoop` → bare `void pollLoop(jobId)` — **the original defect verbatim** |
| §6 | CONTROL: an un-stopped poller still polls a living render (asserts a **second** dial really happened) | — |
| §6 | CONTROL: an un-stopped poller still delivers a completed render | — |
| §6 | CONTROL: the owner's own stop still reads as *his* stop — `cancelled` | — |

### Mutation evidence (one plant/revert per command; every revert `shasum -c`-verified)

Re-run in full against the final two-module shape:

| mutant | result |
|---|---|
| M1 mid-sleep stand-down deleted | **RED** §1, §1b |
| M2 mid-leg stand-down deleted | **RED** §1a |
| M3 `detachPollLoop` → `void pollLoop(jobId)` (the defect verbatim) | **RED** §5 |
| M4 entry fence deleted | **RED** §4b |
| M6 stand-down writes `markCancelled` | **RED** §1, §1b, §3 |
| M7 boot re-arm deleted | **RED** §4 re-arm |
| M-pre the entire pre-fix file from `main` | **RED** 13 of 15 |

## Stated plainly: what is NOT mutation-proven, and three things I got wrong first

- **The `catch`'s stand-down branch is unreachable by design.** Deleting it keeps every clause
  green, and that is the *correct* consequence of the two in-loop guards working: nothing throws on
  the shutdown path any more. It is an assertion-reporter, not behaviour — which is why it logs at
  **warn** with wording saying a guard was missed, and why §1 asserts a stand-down is silent at
  warn-and-above. Its reporting path *is* exercised: M1's RED is produced **by** this branch firing.
  I am flagging it rather than claiming a mutant for it.
- **Three guards were behaviour-neutral as first written** and I only found it by running the
  mutants: the mid-sleep check (the clause stopped mid-leg), the entry fence (the loop already
  exits synchronously, so the registry is clean by the time `enqueueVideoJob` returns — its real
  observable only appears once the DB is *gone*, which is the production case, now §4b), and the
  §6 "still polls" control (one dial fit in the budget, so "it kept polling" proved nothing). All
  three are now load-bearing and red their own mutant. A clause set that passes a deleted guard is
  a clause set testing its own comments.
- **I asserted a wrong number in a `$raises` entry and corrected it.** I wrote "585 limit (468 ×
  1.25)", reading the limit off the *pin*. The growth detector measures from its own baseline —
  417, limit **521** — which the gate told me by refusing. The in-file version was 561. Corrected
  in the entry rather than quietly dropped.

## The pins, and why a module split rather than a baseline re-record

`video-job-poller.ts` 468 → **507**, `index.ts` 1318 → **1325**, both with +/- accounting and
argument in `$raises` (`a75b203d`, gate-side only, per G5).

The in-file version of this fix measured **561 against the 521 growth limit**. The three ways past
that were: delete another lane's documented reasoning from the file; re-record a growth baseline
six lanes share; or put the lifetime where its argument fits. The second is a campaign-wide
maintainer call and not a micro-lane's to make (t112 carries it as the #15 call), so I took the
third — which is also the better shape on its own merits, and leaves the new module unpinned at 66
lines, well under the 400-line new-file cap.

## Verification

- `npm run typecheck` (worktree root) — clean.
- `npm run gates` — **17/17 blocking green**, growth and size ratchets both clean, wiring walk
  reaches the new module. The one `✗` is the report-tier net-production accounting declining
  because the tree was dirty mid-run; it clears on commit and is not blocking.
- The clause file + t114's original file: **23/23 green**, run together.
- **Full server suite once at my head: `603/603` files, `9048/9048` tests, exit 0, 203.5s.**
  The point is not the pass count but the absence: **there is no `Errors` line in the run at all**
  (`grep -niE '^ *Errors '` → nothing), where t123 recorded `Errors 1 error` beside an all-passing
  suite. The only two `unhandled` matches in the whole log are the names of my own two clauses.
  Log: `/tmp/t126-full-suite.log`.
- Lane collisions: `t123-pm-wipe`, `t124-escalation-void`, `t125-silent-turns` touch **no** product
  file of mine. All three touch `ratchets.json`, which the campaign's standing rule resolves
  KEEP-BOTH at rebase. Nothing handed up.
- **`main` advanced under me** from `abb482c0` to `567b1245` ("the talking-command clauses stop
  betting a real child against a real bound") while I worked. My merge-base is still `abb482c0`
  and that commit touches only
  `agent/tools/__tests__/a-talking-command-is-not-killed-for-taking-long.test.ts` — no overlap with
  my product files or with either pin — so this branch rebases onto the new main cleanly. My suite
  run is at my own head and therefore does **not** include that flake fix; it passed regardless.

## G1/G2/G5

- **G1** — names gate green. No agent or personal names anywhere; the fixture agent is `'Fixture'`,
  ids are `t126-*`, the provider is `example.test`. Nothing relies on a specific agent name.
- **G2** — no prompt-assembly file touched; no prompt bytes move. The four cache-prefix goldens are
  byte-unchanged (not in the diff at all).
- **G5** — `ratchets.json` is alone in `a75b203d`, subject ends "— no product file"; the two product
  commits carry no gate file.
