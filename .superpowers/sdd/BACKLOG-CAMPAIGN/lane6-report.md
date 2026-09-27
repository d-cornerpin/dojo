# LANE 6 — MESSAGE COLLAPSING: the never-silent invariant ships, the ask-keyed promotion is REFUSED

**Date:** 2026-09-26 (speed hour) · **Branch:** `t86-lane6` off `791467ff` · **Worktree:**
`<scratchpad>/lane6` · **Spec:** `.superpowers/sdd/BACKLOG-CAMPAIGN/collapsing-investigation.md`
**Commit:** `e005bf7d` — *"a continued human task no longer ends with its only words greyed out"*

**STATUS: SHIPPED, ONE HALF OF TWO, AND THE OTHER HALF IS REFUSED ON EVIDENCE — NOT DEFERRED FOR TIME.**

---

## 1. What shipped

A **third member of the existing promotion family** at the shared seam
(`post-call-classify/terminal-text.ts`), beside `deliveredAsCompiledAnswer` (T52) and
`deliveredAsStartLine` (the start-ack steer). It fires for **one turn class**, and that class is
the only one where no arm in the engine can speak at all.

**`isHumanContinuation` — a long human task the engine auto-continued.** Three facts compose
into a turn that structurally cannot be heard:

| fact | consequence |
|---|---|
| the ask was stamped served at the ORIGINAL pickup (`preflight/turn-trigger.ts`'s C3 stash) | `hasUnansweredUser` is **false**, so G-SUP-2's capture at the seam never arms and `finalize/deferred-recovery.ts` has nothing to recover |
| the person was acked at the original pickup | no ack is owed, so **no start-ack steer will fire** |
| no compile is owed | T52's arm is shut |

Every promotion arm is false ⇒ the text is demoted to a dimmed `[working-note]` ⇒ the turn ends
with the person shown nothing but grey. **That is the measured shape exactly** — the
investigation's two verbatim rows are consecutive turns on one long human task (seq 76946 turn
61, seq 76953 turn 62), which is what a re-continued task looks like.

The invariant: **such a turn may not END with its only utterance demoted.** The text is delivered
in place as the answer — an ordinary `agent-text` row, `originIntent: null`, through the same door
the model's own reply uses (never the ack lane, which every settlement excludes by name) — and **no
note is written at all**, so exactly one copy exists at rest.

**Files:** `answer-to-a-live-ask.ts` (new, 197 lines — predicate, delivery, and the whole
argument), `terminal-text.ts` (+30/−4), `__tests__/an-answer-that-rode-with-a-tool-call-is-not-a-note.test.ts`
(new, 398 lines, 17 clauses).

---

## 2. What does NOT ship, and why — the finding of this lane

**The investigation's Option A (promotion keyed on an OPEN ASK, `hasUnansweredUser`) was
implemented FIRST, driven, and REFUSED.**

Driving it turned **five reviewed CONTROL clauses in three sibling suites red**:

| suite | clause |
|---|---|
| `the-owed-window-delivers-the-model-s-own-line.test.ts` | *"outside the owed window the 2026-07-23 ruling stands, byte for byte"* — CONTROL, no ack owed: the line is a working note and nothing is delivered |
| same | CONTROL — an ack ALREADY delivered this turn is never followed by a second one |
| same | the dashboard is covered by the same window, **and only by the same window** (the ruling's own scope) |
| `the-composed-answer-delivers-the-first-time.test.ts` | CONTROL — a waiting human with no owed compile keeps G-SUP-2's capture, **untouched** |
| `a-reminder-turn-has-a-waiting-human.test.ts` | CONTROL — a waiting human still captures exactly as before (G-SUP-2's original arm) |

Those five are **three owner rulings in test form**: demote-don't-discard (2026-07-10); the
2026-07-23 refusal of a branch that *"delivered whatever mid-work narration was captured … AS the
ack … so the model was never actually asked to address the user"*; and its 2026-08-12 narrowing.

`hasUnansweredUser` is **true on every ordinary human turn**, so keying on it promotes ordinary
mid-work preamble — which is precisely the branch 2026-07-23 deleted. Re-blessing five reviewed
controls to let it back in is a **re-rule, not a fix**, and it is not a worker's to make.

**What A is missing is the half the investigation itself named and this seam cannot supply:**
*"if the turn holds an open human ask **and this text is the turn's terminal text**"*. Terminality
is only knowable at turn end — `teardown/draft-reclassify.ts` says so in its own bold text
(*"THE ANSWER'S IDENTITY IS ONLY KNOWN AT TURN END"*). **A's correct home is the turn boundary**,
promoting the note after the fact.

### The blocker that makes A a design decision rather than a task (owner-visible)

A turn-boundary promotion has to un-dim a note that is already a row and already rendered. Both
available routes are larger than they look:

1. **`messages.retired_at`** is the display-suppression axis — the dashboard's history read is
   `WHERE agent_id = ? AND retired_at IS NULL AND lane = 'owner'` (`gateway/routes/agents.ts:793`).
   **It has NO runtime writer today**: the only two writers in the tree are migrations 102 and 104.
   Inserting the promoted row and retiring the note would make this the first runtime writer of a
   display-suppression column. (`sweepById` writes `swept_at`, which is the serve-drain axis and
   does **not** hide a row from the chat — a trap worth recording.)
2. **A new WS frame.** `chat:message` updates **in place by id** and preserves the existing entry's
   `role`/`displayKind` (`Chat.tsx:1328-1348`), so it cannot convert a rendered `role='system'`
   note back into a bubble. `chat:workingnote` has a `reclassified: true` arm that stamps the
   stored kind in place — a `promoted: true` mirror of it is ~6 lines of `Chat.tsx` plus the
   frame — but that is a dashboard change and the hour was scoped to server-side proofs.

**Recommendation:** A at the turn boundary, via the `chat:workingnote` mirror (route 2), which
needs no new column-writer and reuses the reclassification announcement the house already trusts.
Owner ruling wanted on route 1 vs route 2 before it is built.

---

## 3. The fixture tallies the brief asked for

| corpus group | count | verdict held by clause |
|---|---|---|
| **continuation-shaped human turns** (the measured class's own shape) | the investigation's **7** of 204 human-triggered turns (3.4%) | **PROMOTED** — delivered as the answer, no note, no dimming frame |
| **service-agent scheduler cycles** (`═══ DREAM CYCLE ═══`, `═══ DOJO DAILY DIAGNOSTIC ═══`) | **45** (34 dreamer, 11 healer) | **STILL DEMOTED** — one working note, no delivery, `surfacedReplyThisTurn` stays false |
| **ordinary waiting-human turns** (Option A's target) | the rest of the 146 | **UNCHANGED** — captured into `deferredUserReplyWithTools` and demoted, byte for byte; pinned from this side too so a later widening fails here first |
| **inter-agent turns** | — | **REFUSED** even with every other predicate true |
| **a turn with both an answer and narration** | — | **answer delivered once, narration noted** — the `surfacedReplyThisTurn` / `startAckRepliedNow()` gate |

The service-agent exclusion is **structural, not a name list**: a scheduler cycle is neither a
continuation nor inter-agent. This matters because of the investigation's own **Correction 2** —
those notices are stamped `display_kind='user-text'` too, so a fix keyed on the trigger's display
kind would have promoted all 45.

---

## 4. Verification — every number from a command that ran

| check | command | result |
|---|---|---|
| new clauses | `npx vitest run …an-answer-that-rode-with-a-tool-call-is-not-a-note.test.ts` | **17/17** |
| the step package | `npx vitest run src/agent/v2/steps/post-call-classify/` | **238/238, 17 files** |
| wider regression | `npx vitest run src/agent/v2/ src/work/` | **2327/2327, 138 files** |
| typecheck | `npm run typecheck` | **exit 0** |
| lint | `npx eslint <both touched files> --no-inline-config` | **exit 0, zero findings** |

### Mutants — 4 planted, 4 dead, revert sha256-identical

| mutant | result |
|---|---|
| **M1 the carve-out removed** (`return false` — co-occurrence alone decides again) | **6F / 232P** |
| **M2 widened to EVERY turn** (`return true` — the 2026-07-23 ruling re-planted) | **19F / 219P** at the plant site · **26F / 212P** at the exported predicate (review L6-1) |
| **M3 the narration gate removed** (a turn that already spoke promotes again) | **4F / 234P** |
| **M4 the inter-agent exclusion removed** (A2A narration promoted to a human bubble) | **1F / 237P** |

`sha256` before = after = `4c8aaed8e073dd354865923ab4f7c0f17f1764a13cce321fdc6a4d2ebedb3cc0`; green
restored at 238/238 after the last revert.

**CORRECTED BY SWEEP REVIEW B (L6-1), AND THE CORRECTION MATTERS IN BOTH DIRECTIONS.** The number
above was understated *and* it was the wrong evidence to lean on.

The count: the reviewer re-planted M2 one layer out — `return true` at the EXPORTED predicate rather
than at the inner site — which short-circuits the `interAgentTurn` and `surfacedReplyThisTurn`
guards as well, and measures **26F / 212P**. Same direction, blunter instrument, bigger blast. Both
numbers are real; they are different plants, and the difference between them is exactly the two
guards the inner plant leaves standing. 19F was reported as if it were the maximum.

The evidence: **the load-bearing proof of §2 is the Option-A run with its five named controls**, not
`return true`. A mutant that widens a predicate to every turn kills clauses for many reasons at
once and cannot distinguish "the ruling was overturned" from "the shape broke"; the Option-A run
names the three owner rulings it would overturn and fails on the five sibling controls that encode
them, which is the argument. The reviewer's own words: *"the refusal was correct and the spec'd fix
was wrong … it is measured, not cautious."* Cite that run, not this row.

### One census fired, and it was right to

`agent/v2/__tests__/answered-edge.test.ts` — *"CONFORMANCE: the key has exactly ONE setter in the
ENGINE"* — went red on the first full run. The new module's header **quoted** the setter statement
verbatim in a comment, and the census counts matching **lines** over engine sources without
stripping comments. Reworded to describe the setter instead of pasting it, with a note in the file
saying why, so the next writer does not re-trip it. The census is correct as written; nothing about
it was relaxed.

---

## 5. The two ≤10-min corrections — BOTH ANSWERED

### (a) Investigation §7.2 — "whether the dashboard dims or fully hides `working-note`": **DETERMINED. Both, and it depends on the arm.**

Read off `pages/Chat.tsx`'s render:

| row shape | regular mode | wordy mode |
|---|---|---|
| `role='system'`, `[working-note] ` prefix | **DIMMED** — `<WorkingNoteBubble>` | dimmed |
| `role='system'`, `[working-note:internal] ` prefix (RC-9, a routed-channel turn) | **OMITTED ENTIRELY** — `if (note.internal && !wordyMode) return null;` | dimmed |
| `role='assistant'`, `display_kind='working-note'` (the `draft-reclassify` arm) | **DIMMED** — renders in both modes | dimmed |

So the owner's *"collapsed/greyed"* sighting is the **plain** arm (opacity, as the investigation
suspected), and the **internal** arm is strictly worse than what he reported — it is not dimmed,
it is gone. That raises the priority of the internal arm, which on a routed-channel-heavy box is
the dominant one and is effectively unexercised on the dev box (5 rows).

### (b) Investigation §7.3 — the 67-row gap (518 prefix-matched notes vs 585 `display_kind='working-note'`): **IDENTIFIED from code, not counted.**

`memory/message-store.ts`'s `reclassifyDraftsAsWorkingNotes` sets `display_kind='working-note'`
and states in its own header that **`content` is NOT touched and `role` is NOT touched** (the cache
law, OR7). Those rows are therefore `role='assistant'`, `display_kind='working-note'`, and carry
**no `[working-note] ` prefix** — a second classification path, with its own render arm at
`Chat.tsx:1894`. Its caller is `teardown/draft-reclassify.ts` (SWEEP CORE-2 item 7), whose own
measured population (546 extra bubbles over 535 multi-bubble turns) is the right order of
magnitude for a 67-row gap.

⚠ **Stated as a strong inference, not a measurement.** I did not count rows — the hour forbids
live `~/.dojo` work. A confirming query for whoever has the body:
`SELECT role, count(*) FROM messages WHERE display_kind='working-note' AND content NOT LIKE '[working-note]%' AND content NOT LIKE '[working-note:internal]%' GROUP BY role;`
— the inference predicts ~67 rows, all `role='assistant'`.

---

## 6. OWED to the integrator — one ratchet hand raise, deliberately not taken

`ratchets.json` was left untouched by instruction (six lanes would conflict on it). One pin is
now exceeded:

| file | pin | now | numstat | code / comment+blank |
|---|---|---|---|---|
| `packages/server/src/agent/v2/steps/post-call-classify/terminal-text.ts` | **407** | **433** | +30 / −4 | 12 / 14 |

`answer-to-a-live-ask.ts` (197) and the test file (398) are both under `maxNewFileLines = 400`, and
197 is under `check-growth`'s 240 crossing line, so neither needs an entry.

**Argued `$raises` text, ready to paste:**

> +26 (+30/−4; 12 code, 14 comment/blank). The 12 code lines are ONE MORE MEMBER OF AN EXISTING
> FAMILY: a third `deliveredAs…` flag beside `deliveredAsStartLine` and `deliveredAsCompiledAnswer`,
> one clause on the demote condition, one clause on the promotion opener, and a four-line delegation
> to `answer-to-a-live-ask.ts`, which holds the predicate, the delivery and the whole argument (197
> lines, unpinned). THE DECISION COULD NOT MOVE OUT OF THIS FILE: the three flags are read by the
> demote condition at this seam, and that condition IS the defect's site — the demotion keyed on
> co-occurrence with a tool call, which `shared/visibility.ts` states as a definition and which is
> false whenever the model answers and acts in one response. Measured cost of the definition: 7 of
> 204 human-triggered turns ended with the person shown nothing but a dimmed note. REFUSED: keying
> the carve-out on `hasUnansweredUser` (the investigation's Option A) — it turned five reviewed
> CONTROL clauses in three sibling suites red, each a statement of owner rulings 2026-07-10 /
> 2026-07-23 / 2026-08-12, and mutant M2 re-plants exactly that and kills 19 clauses. REFUSED:
> putting the flag on `PostCallScratch` to shrink this diff — a fourth reader of a decision only
> this arm makes. WHAT HOLDS IT: `__tests__/an-answer-that-rode-with-a-tool-call-is-not-a-note.test.ts`,
> 17 clauses, four dead mutants. From here this file may only shrink.

---

## 7. Concerns

**C1 — half the backlog item is still open, and it is the half the owner actually saw.** The
shipped invariant covers continuation turns. An ordinary waiting-human turn whose answer rode with
a tool call still demotes, still relies on `finalize/deferred-recovery.ts`, and still produces the
grey bubble the complaint names *if* that recovery does not fire. §2 is why, and the turn-boundary
design is the fix. **This is an owner-visible decision, not a silent deferral.**

**C2 — a double-copy exists TODAY on the ordinary waiting-human path, found while reading and not
introduced here.** When `hasUnansweredUser` is true the seam captures the text AND writes the note;
if the turn then ends with no tool-less reply, `deferred-recovery.ts` delivers the same text as an
assistant row. That is one answer stored twice — a note and a bubble — which is the shape T52's
comment describes for its own case (*"shown his answer twice, once collapsed and once for real"*).
Not touched, because touching it means touching the five controls. Worth its own item.

**C3 — the promoted row now enters model context, which is the intended direction and the one
behavioural change to watch.** `prompt/assembler.ts:410-411` excludes `[working-note] %` from
assembly; a promoted row is `agent-text` with no prefix, so the model can finally see what it
already said. The investigation names this as correct (it is what stops the model re-composing).
Not observed live this hour — no live turns were run.

**C4 — Option C (the dashboard affordance) is untouched and can ship independently.** §5(a) now
gives it a precise target: the *internal* arm is omitted, not dimmed, so a "N notes hidden"
affordance matters more than the dimming polish.

**C5 — `isHumanContinuation` was previously pinned by no clause at all** (`grep` over the step
package's suites: every sibling sets it `false`). This lane's file is the first to drive it true.
That is why the change is safe against the existing controls — and also why it has no prior
behavioural coverage to inherit.

---

## 8. Hygiene

- **Nothing is running.** No dev server was started or touched; no live turn was run; `~/.dojo` was
  neither written nor read. Every command was `vitest` / `tsc` / `eslint` inside the worktree, all
  exited.
- **No names in shipped surfaces.** The test fixtures use `'a probe agent'` and a synthetic uuid;
  the agent names from the investigation (`MrMeSeeks`, `kevin`, `dreamer`, `healer`,
  `BehaviorBot`) appear nowhere in the committed files — the two service-agent shapes are
  identified by their `═══ … ═══` cycle banners, which are engine-authored strings, not names. The
  quoted ask was rewritten to `'… in my mailbox …'` with no address, no path, no person.
- **Scope respected:** `ratchets.json`, `gate-manifest`, `definitions.ts` untouched (`git show
  --stat e005bf7d` = three files, all under `post-call-classify/`).
- ⚠ **The worktree carries three `node_modules` SYMLINKS** into the main checkout
  (`node_modules`, `packages/server/node_modules`, `packages/dashboard/node_modules`) — a fresh
  worktree has none and vitest cannot start without them. They are untracked and **`node_modules/`
  is in `.gitignore` but the symlink itself is not ignored**, so they show in `git status`. Not
  committed; remove them if the worktree is archived.
