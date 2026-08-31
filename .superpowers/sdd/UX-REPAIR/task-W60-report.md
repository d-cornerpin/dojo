# W60 — T67b, THE PREFIX HOLDS STILL

Branch `t67b-prefix-holds-still` from `main` at `b522d36`. Nothing pushed, nothing published.
Round 16 runs before any cut.

**Headline, measured on the dev box on matched arms (same agent, same five asks, same floor
model, back to back, ~2 minutes apart):**

| | `b522d36` | T67b | |
|---|---|---|---|
| consecutive-turn assemblies byte-identical before the newest exchange | **0 of 3** | **3 of 3 (100.0%)** | the gate's verdict |
| first divergence | **index 0**, a 24,497-char merged block | none | |
| provider cache reuse (DeepSeek, `cost_records`) | **75.32%** | **93.53%** | +18.21 points |
| uncached input per turn | **6,735 tokens** | **1,807 tokens** | −4,928/turn, −73% |

The owner's DS4 agent measured ~14,200 tokens recomputed per turn against a ~90s prefill
bound. The equivalent figure on our provider fell by 4,928 tokens per turn.

---

## 1. THE CENSUS — every lane emitted into the cacheable region `messages[0, volatileFrom)`

`volatileFrom` is recorded at `agent/v2/steps/assemble/index.ts:188` as `ctx.messages.length`,
so the cacheable region is EXACTLY the assembler's output — every content lane, the ack, and
the post-budget mutations.

| # | lane | slot | class at `b522d36` | the volatile input | disposition |
|---|---|---|---|---|---|
| 1 | `lane.briefing` | 100 | **VOLATILE** (daily) | `new Date()` at assembly (`assembler.ts:865`) | stamp ← the row's `generated_at` |
| | | | **FLAP** | `shouldFireScaffolding` | gate deleted |
| 2 | `lane.vault` | 200 | **VOLATILE** (per-ask) | query built from the last 3 messages | retrieval half **MOVED to the tail** |
| | | | **IMPURE** | `updateRetrievalStats` — a WRITE in the assembly read path | left with the retrieval |
| | | | **FLAP** | `shouldFireScaffolding` | gate deleted |
| 3 | `lane.summaries` | 300 | **VOLATILE** (per-ask) | `buildPerTurnRecallQuery` vector ranking | ranking removed; deterministic recency pack |
| | | | **VOLATILE** (window) | technique scrub over the last 30 rows — a SCROLLING window | scrub window ← the session (monotonic) |
| 4 | `lane.attempt-ledger` | 500 | STATIC | absolute `[ts]` lines from the task log | untouched |
| 5 | `lane.active-tasks` | 600 | **VOLATILE** (clock) | `renderTaskStamps` → `relAgo()`, ticks every minute | renders the recorded instant |
| | | | **VOLATILE** (window) | "all mentioned recently" over the last 6 rows | suppression **deleted** |
| | | | **FLAP** | `shouldFireScaffolding` | gate deleted |
| 6 | `lane.continuity` | 700 | **BOUNDED FLAP** | expires 3 turns after its compaction | **KEPT, argued** — §6 below |
| 7 | `lane.scratchpad` | 800 | STATIC | agent config | untouched |
| 8 | `lane.directive` | 900 | **VOLATILE** (IS the newest ask) | the newest unanswered user message | **MOVED to the tail (1890)** |
| 9 | `lane.scaffolding-ack` | 1000 | DERIVED | the admitted lane ids | stable once 1/2/5/8 stop moving |
| 10 | `lane.events` | 1050 | APPEND | absolute stamps; the set grows with the tail | untouched |
| 11 | `lane.fresh-tail` | 1100 | APPEND **+ REWRITE** | `stubOldToolResults` re-derived from the live turn counter | T56's boundary rule, extended |
| | | | STATIC | `stampTextContent` (row `createdAt`), T56's reasoning stamp | untouched |
| 12 | post-budget prepends | 1160–1195 | one-shot | mutate the LAST message only — inside the newest exchange | untouched |
| 13 | `lane.pm-tail` | (PM path) | APPEND | the same tail | inherits #11 |

**The orchestrator named two offenders. The census found eight.** The two largest — by measured
bytes — were not among them: `lane.directive` (the newest ask pinned at the FRONT of history)
and the `stubOldToolResults` mid-session rewrite.

---

## 2. THE MIGRATIONS AND SPLITS, with RED → GREEN per change

Every clause below is a `describe` block in
`packages/server/src/memory/__tests__/the-prefix-holds-still.test.ts`. **All eight were RED at
`b522d36` with the product unchanged, and the FINAL test file was re-run against `b522d36`
after every clause was written — 8 of 8 failed.** That is the bite proof, not a claim.

| § | change | RED at `b522d36` | GREEN at `3f13c1a` |
|---|---|---|---|
| §1 | briefing stamp ← the row's `generated_at`; two assemblies across midnight | array differed | byte-identical |
| §1 | the stamp states the generation date, not today | `generated="2026-09-05"` | `generated="2026-08-30"` |
| §2 | the scaffolding gate deleted; turn 1's array is a PREFIX of turn 2's | briefing + vault + active-tasks vanished at turn 2 | append-only |
| §3 | `renderTaskStamps(st, {relative:false})`; +10 minutes, no row changed | `answered T7 10m ago` → `20m ago` | byte-identical |
| §4 | summaries + vault stop reading the live ask; a DIFFERENT second ask | history above it rewritten | append-only |
| §5 | the tool-result stub crosses T56's boundary; 19 turns, no compaction | a 4,000-char tool_result rewritten in place mid-history | append-only |
| §6 | the HL5 snapshot's `as of` ← the board's last-change instant; +37 min | header and row ages both ticked | byte-identical |
| §7 | `lane.directive` moves past `volatileFrom`; a second ask | message 0 rewritten | append-only, and `directiveLane` carries the pin |

### Where each moved half went — nothing deleted in silence

* **`lane.vault`'s semantic retrieval** → `memory/recall-lane.ts`, which was **already running
  the identical `semanticSearch`** with the identical scope, and already subtracting this
  lane's pinned set to avoid double-rendering. Its `includeVault` gate existed *only* because
  `lane.vault` fired on scaffolding turns; it is unconditionally true now. **One retrieval, one
  owner, in the tail.** `retrieveForContext` is **deleted**, not parked beside its replacement.
* **The FN-1 unfiled-archive bridge** → the same lane, same caps, same label. It searches BY
  THE QUERY, which is why it could not stay at slot 200.
* **`lane.vault`'s static half** stays at slot 200: pinned/permanent entries + `session_context`
  entries. No query, no clock, no write.
* **`lane.summaries`' ask-responsiveness** → the recall lane already retrieves raw messages and
  vault entries by meaning against the live ask, from the tail; `history_search` reaches the
  summaries themselves. **Honest bound recorded in-file:** what is given up is an OLD summary
  being auto-hoisted into the prefix because it matched today's question — and it was being
  paid for with the entire prefix behind it.
* **`lane.directive`** → `msg.directive`, `MessageSlot.ActiveDirectiveTail = 1890`, injected by
  the loop one place ahead of the clock. Its priority-10 rung becomes a **2,081-token reserve**,
  which is *stronger*: a reserve cannot be outbid where a priority can.
* **The tool-result stub** → the decision is a monotonic watermark
  (`agents.config.toolResultsStubbedBeforeTurn`) advanced at a compaction boundary by
  `stubOldToolResultsAtBoundary`; the assembler only RENDERS it, purely. **No migration** — the
  watermark is a per-agent scalar of exactly the kind that column already holds
  (`continuityBriefValidUntilTurn` is its neighbour and its precedent). Crossing matrix N/A.

### Deleted rather than left standing

`retrieveForContext`, `getVaultBudget`, `isV2SessionStart`, `selectSummariesByRelevance`,
`budgetSummaries`, the `buildPerTurnRecallQuery` import, and four now-unread lane declarations
(`lane.vault.rows.queryMessages`, `lane.vault.chars.query`, `lane.summaries.retrieval.*`,
`lane.active-tasks.rows.recentMentionWindow`). Unused symbols **113 → 112**.
`assembler.ts` 2,615 → 2,517 (−98); `vault/retrieval.ts` 450 → 407 (−43).

---

## 3. THE TAIL-HYGIENE RIDER

* **The HL5 "as of" tick.** `renderSnapshot` stamped itself `new Date()` and dated its rows
  `opened N ago` off the same clock, so an IDENTICAL board rendered different bytes once a
  minute. The header now states `boardLastChangedAt(agentId)` — `MAX(COALESCE(updated_at,
  opened_at))` over the agent's work rows, which advances on every open, update **and close** —
  and the row ages are measured **from that same instant**, so the header and the rows cannot
  state two different nows. `relativeTimeAgo` gained an optional reference instant defaulting
  to the clock, so every other caller is byte-unchanged.
* **Tail ordering, verified and fixed.** Order at `b522d36`: turn-context(1850) → recent-outbound
  → deliveries(1860) → open-work → recently-answered → **relevant-memory(1870) → peer-status(1875)**
  → current-time(1900). The recall lane's own header says it goes after deliveries "because it is
  the more volatile of the two"; by that same test it belongs after peer-status — a peer's
  idle/working flip is rare, this block moves with EVERY ask. **`RecalledMemory` 1870 → 1880**,
  and the injection order in `pre-call-injections.ts` moved with it so the slot numbers and the
  imperative order say the same thing. Final order, most-stable-first, clock last:
  `1850 → 1860 → 1875 → 1880 → 1890 → 1900`.

---

## 4. THE NEW GATE — server test + kit gate, joined to the standing roster

**Server side:** `packages/server/src/memory/__tests__/the-prefix-holds-still.test.ts`, 8
clauses, in the full suite. The assertion is one sentence: *history is APPEND-ONLY, so the
earlier assembly's message array is a byte-exact PREFIX of the later one.* T56's compaction
boundary remains the one lawful exception and is not weakened.

**Kit side:** `dojo-test-kit/checks/check-prefix-holds-still.mjs`. It drives **5 consecutive
turns with 5 DIFFERENT asks** and asserts append-only across every judged pair.

Why a sixth check rather than widening `check-message-prefix` (K10b): K10b **drives the same ask
twice by design** — its own header, *"the check DRIVES ITS OWN PAIR with a FIXED ASK, so the one
input the guarded class depends on is byte-identical across the turn boundary by construction."*
That is the right fixture for its class and a strictly weaker statement than a real conversation
makes; folding the two would cost K10b the fixed input its verdict rests on. K10b's own fourth
drive PRICED the varying-ask divergence and gated on nothing. **This gate gates on it.**

What it refuses rather than exempts, each read from the allocator's own lane table and each
printed with its reason on every run:

* a pair straddling the one-shot `lane.new-session` marker (296 chars prepended on a session's
  first assembly only);
* a pair containing `lane.continuity`'s declared horizon expiry (§6);
* a window in which a **compaction created a summary** — refused as BROKEN PROBE, because
  exempting T56's boundary inside the comparison is a hole every future lane could climb through.

Floor: fewer than 3 judgeable pairs is a BROKEN PROBE, not a pass.

**Armed on both mirrors** — the two-repo edit the roster requires:
`dojo-test-kit/checks/run-prompt-gates.mjs` CHECKS array, and
`dojo/deploy/checks/check-prompt-gate-record.mjs` REQUIRED list.
`check-roster-conformance` compares the two and now reports **8 ids, same set both sides**. The
new checker is declared in `PRODUCT_READERS` with verdict `cannot-go-quiet` (one product-number
read, `MODE_CACHE_MS`, with **no recorded fallback** — GUARD-AUDIT F8's repair adopted at birth).

### The kit gate's own bite proof — driven, not argued

The product was reverted to `b522d36` in the live tree (`git checkout b522d36 -- packages/server/src`),
instruments reinstalled, gate re-run:

```
TURN 2 → 3   cacheable region 5 message(s), 0 identical (0.0%)   MOVED
TURN 3 → 4   cacheable region 7 message(s), 0 identical (0.0%)   MOVED
   first divergence at index 0:
     turn 3: user lane.summaries 24497 chars d4be77213f9bc176
     turn 4: user lane.summaries 24505 chars 4085cbcb5587317a
   lane-table diff: lane.directive admitted/124 → admitted/126 …
TURN 4 → 5   cacheable region 9 message(s), 0 identical (0.0%)   MOVED
PREFIX MOVED — 3 of 3 judged pair(s) rewrote history above the newest exchange.
```

**24,497 characters of merged prefix, rewritten on every single turn.** The product was then
restored and the gate re-run green.

---

## 5. RESERVE RE-DERIVATION

Derived from the generators, never guessed beside them; both literals are pinned to their
generator by `recall-lane.test.ts`.

| lane | before | after | derivation |
|---|---|---|---|
| `lane.relevant-memory` | 1,911 | **2,179** | +268 = the FN-1 bridge at its own declared caps (3 snippets × 300 chars in their `- [<stamp>] ` frames + the shared label). The bridge did not grow — it MOVED, from an unbudgeted spend at slot 200. |
| `lane.directive` | — (priority 10 in the fit) | **2,081** | `formatDirectiveBlock` at `DIRECTIVE_MAX_CHARS = 8,000` + the two frame lines + the `history_get` pointer with a full 36-char id = 8,321 chars = 2,081 tokens. |

`POST_BUDGET_RESERVE_TOKENS` rises by 2,349 off the top. **What that costs, stated rather than
assumed:** the directive's 2,081 were already being spent from the content budget — from
*inside* the prefix, where they were re-billed with everything behind them on every turn
instead of once.

---

## 6. THE ONE BOUNDED FLAP THIS TASK KEPT — named, not omitted

`lane.continuity` appears at a compaction and vanishes `CONTINUITY_BRIEF_HORIZON_TURNS = 3`
turns later. That is a prefix shape change **not** at a compaction boundary — the same class §2
deleted from three other lanes.

**It is kept, and the argument is in the lane itself.** This lane is the LAST reader of T6's
whole mechanism (`readStoredTurnThreshold` + `CONTINUITY_BRIEF_HORIZON_TURNS` +
`continuityBriefValidUntilTurn`), and T6's finding was a threshold from an older numbering era
sitting **permanently in the future** — a brief written at turn 264 with `validUntil` 1598. An
ungated brief IS that state, by construction rather than by accident. Removing the gate to close
a bounded flap would resurrect the incident the gate exists for.

What makes it tolerable, in the gate's own terms: the flap is **bounded, one-way, and at most
once per brief** — one prefix rebuild per compaction cycle, on a cycle that already rebuilt the
prefix three turns earlier. The lanes §2 fixed cost one per conversation and one per session,
every session.

---

## 7. THE REGISTERED RE-BLESS — one batch, every moved surface named

**THE SYSTEM PROMPT DID NOT MOVE A BYTE.** `checks/golden/cache-prefix.kevin.txt` is
byte-identical (`git diff --stat` empty), and `check-cache-prefix` reports the prefix
**byte-invariant across all 9 turn-states, system 35,725 chars**.

| surface | change |
|---|---|
| `dojo-test-kit/checks/golden/assembled-context.json` | sha `8e9e0ee8d1cfc847…` → `3908712be17ee9c8…`. Per cell: **−`lane.directive`** (255 chars, index 0) and **−`lane.scaffolding-ack`** (419 chars, index 1). Every cell 11→9 / 12→10. The pin left the fit for the tail; with no scaffolding lane admitted on this fixture the ack renders null, which is its own declared rule (*"renders nothing when no scaffolding was admitted"*), not a second change. |
| `dojo-test-kit/checks/check-prompt-inventory.mjs` | +`msg.directive`; `msg.relevant-memory` now after `msg.peer-status`. |
| `dojo-test-kit/server-instruments/files/dev.ts` | the assembled-context dump reports `directiveLane` separately, exactly as it already reports `recallLane`. |
| `dojo-test-kit/checks/check-roster-conformance.mjs` | the new checker declared in `PRODUCT_READERS`. |
| `prompt/registry/__tests__/inventory.test.ts` | roster + order lock. |
| `memory/lanes.ts` | `LANE_PRIORITY` / `LANE_LADDER_LABEL` / `LANE_SECTION_LABEL` lose `lane.directive`; `POST_BUDGET_ENTRY_LANE` gains `msg.directive`. |
| **the scaffolding ack string** | `ACK_TAIL` loses *"The active user directive is the WHAT, never lose it."* The ack closes the scaffolding block at slot 1000 and the directive is not in that block any more; an ack naming a section that is not there is the exact defect this generator exists to make impossible. The sentence's job is done by the pin's own frame and by its tail position. Exact new string pinned in `recall-lane.test.ts`. |
| `memory/__tests__/lanes.test.ts` · `assembly-validation.test.ts` · `recall-lane.test.ts` · `stub-and-store.test.ts` | fixtures re-blessed, each with its argument in-file; `lane.directive`'s row left the fit fixtures the way `lane.relevant-memory`'s did at CORE-2 item 4, and a new clause pins that the repair may no longer DROP the pin (`isProtectedLaneId('lane.directive') === true`). |

---

## 8. VERDICTS

| | |
|---|---|
| server suite | **5,240 / 5,240 pass**, 366 files |
| `tsc --noEmit` server | **clean** |
| `tsc --noEmit` dashboard | **clean** |
| `npm run gates` | **13 / 13 blocking green** |
| kit prompt-gate roster | **8 / 8 green** (roster grew 7 → 8) |
| dojo-side record reader | **accepted** — 8 blocking gates green at `f4969801`, 0 acknowledged reds |
| driven byte-stability | **3 / 3 consecutive pairs 100.0% identical** before the newest exchange |
| provider cache reuse | **75.32% → 93.53%** (rose; the bar was "rise or hold") |
| migration | **none** — crossing matrix N/A, stated |
| pushed / published | **nothing** |

**Shas** — `dojo`, branch `t67b-prefix-holds-still` from `b522d36`:

```
968ec6d  T67b RED: the cross-turn invariance gate, and it bites at HEAD
c3b5e4a  T67b: the prefix holds still — seven migrations out of the cacheable region
9a51911  T67b: the symbols the migrations killed, deleted rather than left standing
0d09edd  gate-side: seven ratchets raised, one newly listed, two tightened
f496980  gate-side: the cross-turn invariance gate joins the release-blocking roster
3f13c1a  T67b census rider: the one bounded flap this task KEPT, argued in the lane
```

`dojo-test-kit` (local-only): `cbc72f3`, `453536a`.

**Gate-side commits are separate** (`0d09edd`, `f496980`, and the kit's two), per the header rule.

---

## 9. RESIDUALS AND HONEST BOUNDS

1. **`lane.continuity`'s bounded flap** — §6. Kept with its argument; the gate refuses the pair
   rather than judging it. If a future task retires T6's horizon for an independent reason,
   this lane should lose its gate in the same commit.
2. **Auto-recall no longer inflates `vault_entries.retrieval_count`.** `retrieveForContext`'s
   `updateRetrievalStats` write left with the function. Named as a behaviour change, not hidden:
   pinned/permanent rows are exempt from every hygiene arm in `vault/maintenance.ts` by
   construction (`is_pinned = 0 AND is_permanent = 0` is on each of them), and `work/obligation-
   memory.ts` already records auto-inflation making rows immune to hygiene as a **defect** rather
   than a service. The recall lane does not bump either — and on non-scaffolding turns (most
   turns) nothing bumped before this task, so the change is small and in the direction hygiene
   wants.
3. **`lane.summaries` no longer ranks by the live ask.** The ask-responsive surface is the recall
   lane (messages + vault, by meaning, every turn, from the tail) plus `history_search`. What is
   given up is an old summary being auto-hoisted into the prefix on a match. Recorded in-file.
4. **Tool results 12+ turns old now replay between compaction boundaries** instead of being
   stubbed mid-session. They are still capped per row by `capLargeToolResultStrings` and still
   evictable by `budgetFreshTail` — the two mechanisms that were always protecting the window.
   The growth is paid in **cached** tokens rather than in a prefix rewrite every turn. Worth
   watching in round 16 on a tool-heavy scenario.
5. **Round 16 has not run.** The behaviour bar is unmet by design: the round runs before any cut,
   on the owner's word. Its S-shapes should confirm the two precedent moves held or improved —
   the recall lane's tail migration and HL5's snapshot — and should include one tool-heavy
   scenario for residual 4 and one long-conversation scenario for residual 3.
6. **The dev box is left clean**: instruments uninstalled and verified (0 `[DEV-INSTRUMENTS]`
   markers), `context_receipt_mode` restored to `off` from the config table, the floor-model pin
   restored, working tree clean.
