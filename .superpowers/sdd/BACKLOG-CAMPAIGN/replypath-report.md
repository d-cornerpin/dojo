# REPLY-PATH RELEASE BLOCKERS — C2 and the honesty gate

**Branch:** `t86-replypath`, off `t86-backlog` (`e0c44fa6`). Five commits.
**Verified at HEAD:** 493 files / **7,428** clauses exit 0 · `npm run gates` exit 0 · typecheck exit 0
on all three packages · ratchets, growth, names exit 0.

| # | sha | what |
|---|---|---|
| C2 product | `ba2e8303` | the record stops lying + the ladder charges silences, not cuts |
| C2 test | `5fb5461e` | 16 clauses; three written because mutants survived |
| Gate product | `44a56962` | `false-delivery-claim`, the fifth truth guard |
| Gate fix | `13627617` | one predicate, not two — an equivalent mutant is a redundancy |
| Gate-side | `c1a6f2dd` | two pin raises + one new pin, no product file |

---

## 1 · C2 — an engine cut is not the model's silence

### The root cause is one layer below where C2 was filed: A RECORD THAT LIES

A turn that runs into the tool-loop cap is CUT OFF BY THE ENGINE mid-work — `loop.ts:639` writes
`[System: This turn reached 75 tool calls…]`, notes a checkpoint, schedules a self-continuation — and
then falls through the SAME teardown as any other turn. That teardown could not see the cap:

```
const exitReason = toolPhaseEndedBySpinBrake ? 'brake'
  : answerRow ? 'answered' : parkedRow ? 'park' : handoffRow ? 'handoff'
  : 'no_reply_intended';                         // ← the cap landed HERE
```

So the record said **the model intended not to reply**, about a turn the model never got to finish.
That word is not a shrug: the ask re-serve ladder counts SILENCES, spends a rung on it, and at the
bound stands the ask down to `blocked` — the state the drain's `state = 'open'` queue stops picking
up. Four engine cuts and the owner's ask leaves circulation, never answered and never declined. Owner
ruling 10(d) forbids exactly that direction.

### THE RED-FIRST LINE

> **`cut 4: expected 'held' to be 'reopened'`**

Four turns seeded `iteration_cap`, and the ask is `held` → `blocked`. (The other seven RED clauses in
the same first run: the rung spent on every cut, the record unable to emit `iteration_cap` at all, the
flag not threaded, and the classifier absent.)

### Measured on the owner's body — and the measurement is what makes it a RECORD bug

```
10,934 turns. FIVE exit reasons have EVER been written:
  answered 5,451 · no_reply_intended 3,977 · handoff 1,356 · park 117 · unknown 33
`iteration_cap` — declared in TurnExitReason, CHECKed by the column, published in the
telemetry enum — HAS NEVER BEEN WRITTEN ONCE. Nor have brake, identical_call, stop,
preempt, provider_error, stream_idle, abort, terminated, budget, delegation_exit,
compile_pending. ONE finalizeTurn call site exists in production; it emits five of seventeen.
All 10 stand-downs to `blocked` read `no_reply_intended`.
```

**Whether any of those 10 was really a cut is UNKNOWABLE FROM THE RECORD.** That is the defect, not a
mitigation — and it is why the fix is both halves or neither.

### The fix
1. **The record stops lying.** `toolLoopCapReached` latches at the cap and rides to teardown exactly as
   `toolPhaseEndedBySpinBrake` does — a flag, not an import, because `finalize-record` is a STEP of
   `loop.ts` and reading `MAX_TOOL_LOOPS` back out would cycle. Placed AFTER `answered` (a
   capped-but-answered turn stays representable) and before `park`/`handoff` (the cap is WHY it ended).
2. **The ladder charges silences, not cuts.** `work/exit-attribution.ts` classifies who ended the turn;
   a cut hands the ask back OPEN on the same path, spends NOTHING, and can never reach the stand-down.

**Deliberately NOT engine-imposed**, because the owner's other complaint is repetition and the bound is
what stops it: `no_reply_intended` (the model chose silence — what the bound is FOR), `answered` (the
model's claim failing, twice on this body), `handoff`/`delegation_exit`/`compile_pending` (decisions;
the hold arm owns joins). **`stop` IS** engine-imposed: it is the owner interrupting, and an ask must
not be parked because somebody pressed stop four times. A MISSING turn record keeps today's behaviour.

### Mutants — 8 planted, 8 caught (baseline 149 clauses)

| # | plant | result |
|---|---|---|
| MC1 | the cap flag never latches | 1 F / 148 P |
| MC2 | the derivation drops `iteration_cap` | 2 F / 147 P |
| MC3 | the ladder ignores the attribution | 6 F / 143 P |
| MC4 | the stand-down fires on a cut anyway | 1 F / 148 P |
| MC5 | a cut spends a rung after all | 5 F / 144 P |
| MC6 | OVER-WIDENED: `no_reply_intended` read as a cut | 3 F / 146 P |
| MC7 | a missing turn record read as a cut | 1 F / 148 P |
| MC8 | the classifier fails OPEN on a read error | 1 F / 148 P |

**MC4, MC7 and MC8 survived the first run**, and the clauses that kill them exist because of that:
MC4 was invisible until a MIXED history (three real silences, then a cut) reached the bound; nothing
passed `turnNumber: null`; and the catch's direction was untested — asserted on `turnWasEngineCut`
directly, because the settlement's own evidence read joins `turns` too and breaking that table throws
before the question is asked.

**Suites the round must not move:** `ask-settlement` + `answered-edge` + the withdrawn-report file —
133 clauses, green, untouched.

---

## 2 · The honesty gate — `false-delivery-claim`

### Why nothing caught the Arm C turn
The truth band holds four guards asking "the reply asserts X, the ledger says not-X". The closest,
`ungrounded-claim` (10), is *"reply claims a delivery no send tool made"* — **and it reads the
DELIVERIES LEDGER.** `dojo_report` is the one user-facing door that writes **no `deliveries` row, ever**.
The artifact moves by STATE TRANSITION, so no ledger-reading guard can ask about it at all.

So the gate is the **`failed-save-claim` shape with the noun changed** (that floor already asks this
turn's TOOL RESULTS whether the reply is true) — a FIFTH predicate in the same table, same seam, same
one-shot latch, **no new suppression**. Decision in `agent/v2/refused-delivery.ts`, the way guards 10
and 13 delegate theirs.

### THE STEER, VERBATIM

> You told the user that went out, and the only tool this turn that could have sent it REFUSED. Its own
> words: "*&lt;the tool's error, ≤240 chars&gt;*". Nothing was delivered. Tell them plainly what the state
> really is and what you can do about it — do not let the claim stand, and do not go silent.

It QUOTES THE TOOL (the ghosted-ask steer's second rung hands the model its own recorded words for the
same reason) and it ORDERS NO SILENCE — a mutant that makes it ask for one goes red, because 10(d)
means a guard may never resolve a contradiction by asking the model to say less.

### Scope — four conjuncts, each narrowing
SAME TURN (`toolResults` is turn-local by construction) · an EXPLICIT `is_error` · NOTHING of that tool
succeeded · a DELIVERY-SHAPED claim. **The vocabulary is measured, not chosen:** only `submitted` and
`delivered` stand alone; `sent`, `posted`, `filed`, `published` need their object, because "I sent you
the link in chat", "Posted a note on the tracker card" and "I published the draft to the shared folder"
are honest sentences on a failing report turn and a bare-word list steers all three. A denial guard runs
after the claim and can only quieten. **A bare "submitted" is enough here** — a deliberate departure
from the kit detector's destination requirement, because this floor holds the tool-refusal conjunct and
the Arm C reply was one word.

### Mutants — 9 planted, 9 caught (baseline 62 clauses)
MH1 never fires 3F · MH2 SUCCEEDED conjunct dropped 2F · MH3 CALL-EXISTS dropped 2F · MH4 tool binding
dropped 1F · MH5 DENIAL guard dropped 2F · MH6 over-widened vocabulary 1F · MH7 stops quoting the tool
1F · MH8 **asks for silence** 1F · MH9 one-shot latch dropped 1F.

⚠ **MH3's first form survived, and it was not a missing clause.** `decideRefusedDelivery` filtered
refusals with `isError === true` *and* returned null if any call succeeded — so deleting the filter
changed no behaviour. **An equivalent mutant is a redundancy in the product, not a gap in the tests**,
so `13627617` removes the redundancy (one predicate: at least one call, every one an explicit error) and
MH3 is re-planted as a conjunct that actually exists.

### Five instruments required declarations, and each got one
the steer table's floor count (28 → 29) · the merged guard's declared set · the step contract's floor
census (whose own note says it was rebuilt to catch exactly a new floor landing unlisted) · the
`TurnContext` field census · and the **guard-corpus census, which refused my by-path reads of the step
packages for the third time on this branch** — both new clause files now go through `engine-sources.ts`.

---

## CONCERNS

1. **Eight classified exit reasons still have no writer** (`stop`, `preempt`, `provider_error`,
   `stream_idle`, `abort`, `terminated`, `budget`, `identical_call` — 0 rows each). They are classified
   so the day one is wired the treatment is decided rather than discovered, and a clause holds that as
   deliberate. But until they are wired, an owner pressing STOP is still recorded as the model's own
   silence and still spends a rung. **That is the same defect this round fixed, on a different word,**
   and wiring a new exit reason has telemetry-enum and DB-CHECK consequences that put it outside a
   release-blocker round. Handed up.
2. **The honesty gate covers ONE artifact.** `dojo_report` is the only door with no `deliveries` row, so
   it is the only place the ledger-reading guards are blind — but the gate is keyed to that tool by
   name. A second such door would need its own entry, and nothing would notice until it shipped.
3. **`false-delivery-claim` is ranked 14, at the foot of the truth band, and on consequence it argues
   for a place beside 10.** Re-ranking a live precedence table was out of scope; recorded in the table.
4. **C2's shape has never fired on this body** (0 occurrences; all 10 stand-downs are
   `no_reply_intended`, and `park` exists 117 times but never under an ask stand-down). The fix is
   preventive and its RED is constructed, not measured. The measurement that *does* bind is the record
   one: `iteration_cap` never written across 10,934 turns.
5. **No live probes this round.** Both items are reachable only through rare engine states (the 75-call
   cap; a cancelled report mid-turn) and the round is sequential release-blocker work on delicate files.
   The clause + mutant evidence is unit-level, and item 2's fixture is the Arm C receipt shape.
