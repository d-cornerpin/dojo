# LANE 3 — four isolated smalls, and the review-C fix round

**Re-created 2026-09-26.** The original never reached disk (review C §0 recorded the absence; the
file-rewrite hazard in concern 7 below is the likely cause). It is committed this time, not left
untracked, so it cannot evaporate again.

Two rounds:

* **Round 1** — branch `t86-lane3`, based `791467ff`, head `e5436e51` (6 commits) + kit `692c7f7`.
* **Round 2 (this one)** — branch `t86-lane3fix`, based `e83674d6` (current `t86-backlog`), head
  below (8 commits) + kit `f9dbf8e5`, `40ab5aaf`.

| # | subject | round 1 | round 2 (review C) |
|---|---|---|---|
| 1 | a utility dial is not an agent turn | `6199ec82` | `dc3e9a9e` (L3-F1 + L3-F3) |
| 2 | the sim capture reads as SUCCESS (kit) | kit `692c7f7` | kit `40ab5aaf` (L3-F7) |
| 3 | the estimator's divisor is observed | `7be322a4` | `d2524f5d` (L3-F2) |
| 4 | release.sh demands the ritual | `27b82173` + `d461796b`, `8c032337` + `e5436e51` | `c1d0ea1b` + `93573126` (L3-F4/F5/F6), kit `f9dbf8e5` |
| 5 | lane 5's findings, folded in | — | `266dce67` (L5-F1), `719c6b48` (L5-F2) |

---

## 1 — a utility dial is not an agent turn

**Round 1.** Three of four `recordCost` sites in `agent/model.ts` stamped the turn's label on every
call that reached them; the fourteen engine utility dials (router probe, classifiers, summarize,
vision reads, ask-title, voice opener, image captioner…) all landed as `agent_turn`, which forced the
harness into size heuristics twice. Fixed by aligning the three on the fourth's expression.

**Round 2 — L3-F1 (MED-HIGH), and the reviewer was right.** Keying on `tools` reads the CARGO and
calls it the KIND. `agent/runtime.ts`'s capability gate sets `useTools = false` for a REAL turn on a
model without the tools capability, so on such a box every turn recorded `completion` and **no row
said `agent_turn` at all** — the same consumer question answered wrongly, one direction over. The
clause was structurally blind to it.

Now: `ModelCallParams.purpose`, declared by the ONE dial that is a served turn, and every site reads
`routerTier ?? purpose ?? 'completion'`. Zero net lines in `model.ts` (at its pin); `model-call.ts`
lands exactly on its pin. `'ollama'`/`'agent-sdk'` leave this column on purpose — they named the pipe,
which is already `provider_id`; history keeps them and the whitelist keeps them as members.

**The non-tool-capable-box clause result:** `RED-CRITICAL: the NON-TOOL-CAPABLE BOX — a declared turn
that ships no tools is still a turn` — **PASSES** at `(routerTier: undefined, purpose: 'agent_turn',
tools: false)` for all four sites; and with the old expression planted back it fails with
`` `routerTier ?? (tools ? 'agent_turn' : 'completion')` records "completion" for a REAL agent turn ``.
Both directions pinned, plus a structural clause that no expression may mention `tools` at all.
L3-F3 folded in: the premise clause names all **fourteen** dials (it named twelve; `system-control.ts`
and `web-tools.ts` were missing), count asserted, and each must stay UNDECLARED.

Mutations: old expression → 3 of 9 red; declaration deleted → the one-declaring-site clause red.
Reverts restore sha256 `36db421c` / `d869a4c0`.

## 2 — the sim capture (kit only)

Verified again this round: the string ships nowhere in the dojo repo. Round 1 reworded it to lead with
SUCCEEDED, forbid the retry and pre-empt the read-back, keeping the load-bearing `[SIM] captured `
prefix (four assertion sites) and dropping "sim mode" from the model-visible half (`anomaly.mjs`'s
leak rule). **L3-F7:** `family-calendar.mjs`'s note still quoted the dead text and still called its own
fidelity concern "HANDED UP rather than fixed here" — corrected, with the observed-duplicate CAP
deliberately left alone (it was set from measurement; the reworded string has not been measured against
those families yet, and tightening on an unmeasured improvement is the same guess in the other
direction).

## 3 — the estimator's divisor

**Round 1** refused the blind constant change (budget.ts's own header measured `/3` at 30% OVER on
prose and says "never tune it"; the harness's 1.88-2.08× is a different population) and shipped the
re-derivation instead: `costs/ledger-calibration.ts` + migration 174, min-of-exact-ratios with a
cache-inclusive numerator, three guards, 167's one-way rule mirrored, `tracker.ts` net zero lines.

**Round 2 — L3-F2 (MED).** All three guards bounded the INPUT; nothing bounded the RESULT, and the fold
is a MINIMUM, so one row pins the reading for a window and the daily rescan cannot rescue it. Guard 4
is 167's reader-side legal range, mirrored: `MIN = 1` (no tokeniser emits more than one token per
character of real text — the load-bearing bound, since low is the only direction that can make a
consumer less safe than no reading) and `MAX = 12` (clear of real text; above it a provider is
under-reporting usage. It protects no decision by itself — a high ratio is inert under a minimum — and
exists so a number no tokeniser could produce cannot reach the log or a future non-minimum fold).

**The poisoned-row exclusion line**, as the platform now logs it (once per provider per process):

```
info  ledger-calibration  Ledger row excluded from the chars-per-token reading: ratio outside the legal range
      { providerId: 'local', ratio: 0.001, legalRange: [1, 12], estimatedInputTokens: 2000,
        billedInputTokens: 8000000,
        likelyCause: 'billed input is not characters of a prompt (image/audio tokens), so it cannot
                      measure a text tokeniser' }
```

And the reviewer's row is not a corrupt record — it is **the shape of a vision call**, which is why the
argument at the guard is about image tokens rather than freak data. Six clauses (raw 0.001 still
computed, range excludes it, the fold keeps the honest 4.0, both extremes + NaN/Infinity refused with
the boundaries legal, a text row at the floor still measures, and the live path leaves the column while
logging once). Mutation: range dropped → 2 red; revert restores sha256 `ff905f59`.

## 4 — the release ritual

**Round 1** closed the measured hole (`grep -c ritual deploy/release.sh` was 0) with the copy the kit's
own header asks for, plus a clause that EXECUTES the real script bytes against fixtures, and matched
the kit's `drawUnsteered` field within the hour it arrived.

**Round 2:** L3-F4 — "ten families" was a count; ten empty strings and ten copies of one name both
shipped, **on both sides**, so the fix is on both sides (release.sh and the kit validator + four
selftest cases, including a CONTROL that ten real families still validate). L3-F5a — `pinnedDraws`
shapes were not equivalent (`.length > 0` vs a non-empty filter); the copy now filters as the kit does.
L3-F5b — the ritual block does **not** re-check `green`; K1 above owns that, so the block now discloses
the dependency and a clause asserts K1 appears **before** it. L3-F6 — the ✓ line read `final.n`, a
number nothing validates; it now reports `families.length`. Plus the **parity clause** the reviewer
asked for: it reads BOTH sides and diffs the ritual field checks in both directions, handling an absent
sibling repo by saying so rather than passing quietly.

Mutations: families check softened to a count → the ten-identical clause red on both sides (dojo 23/24,
kit 83/84); reverts restore sha256 `8d16e911` (release.sh) and `a83bb383` (kit).

## 5 — lane 5's findings

**L5-F1** (`266dce67`): the spawner throw's justification said "three callers" — there are **two**
(`cat/agents.ts:355`, `vault/maintenance.ts:1876`); the disclosed residual named a dashboard route that
does not carry this field at all (`always_loaded_tools` appears nowhere under `gateway/`, and the
Dreamer does not pass it), so existence is CLOSED on every reachable path today; and — the one that
could have shipped a defect — the plan note telling the next lane to REUSE this validator for the
`POST /api/agents` `'none'` fix is deleted with its reason: that is the file-grant path, where `'none'`
is a documented scalar, so clause 1 would refuse a valid value. Corrected in `lane5-report.md` (tracked,
rides this branch) and in `caps-design.md` §1.1/§1.5/§3 (untracked — corrected in the working tree; this
report and the commit message are the record).

**L5-F2** (`719c6b48`): six clauses on the no-registry branch — the one `vault/maintenance.ts` takes —
including that skipping clause 5 skips ONLY clause 5, and that an invented name is accepted there while
the registry-bearing path refuses it (the documented difference, stated so a future seam change is
argued rather than discovered). Mutation: short-circuit the branch → 2 red; revert restores sha256
`a47882d6`.

---

## Verification (round 2, in the worktree)

`npm run typecheck` exit 0 · `npm run gates` exit 0 · **full server suite 7,383 of 7,385**, the two
failures re-run green in isolation (52/52) and are the shared-`os.tmpdir()` class of concern 5 —
`the-installer-ships-the-souls` lost its synthetic artifacts to a parallel lane mid-run ("no built
artifact"), and `a-stop-stops-the-media-generators`' timing control flipped under load; neither touches
anything this lane changed · the four touched suites green · kit `release-ritual-selftest` 84/0.

The `@dojo/shared` shadow trap was closed before any suite ran: the worktree carries its own
`packages/server/node_modules/@dojo/shared -> ../../../shared` and its own built `packages/shared/dist`,
verified with `require.resolve` pointing INSIDE the worktree.

TWO THINGS THE FULL RUN FOUND, both fixed in-round rather than reported as residue:

* **The tree's own guard-corpus census refused my clause** (`a637c88e`). The L3-F1 clause reached into
  `agent/v2/steps` by a typed path — the second hand-rolled walk that census exists to refuse. It now
  asks `engine-sources.ts` for the engine file CONTAINING the declaration, which is strictly stronger:
  `engineFileContaining` throws when two engine files carry the same needle, so the clause also proves
  the declaration is UNIQUE among the step packages.
* **The growth detector refused the calibrator** at 311 lines (60% of the 400-line new-file cap), and
  the gate's two remedies are split or pin. Pinned at 311 in a gate-side-only commit (`7e5a8fe5`) with
  the argument for not splitting: of the 82 new lines only ~25 are code, and separating guard 4's
  reasoning from the four-line predicate it governs is the "rule in a file nobody opens" failure. **It
  is a pin, not a raise** — the file may only shrink from here, no existing entry moved, and the raises
  items 1 and 3 still want remain argued (concern 1) rather than taken.

## Concerns

1. **Raises still not taken, still argued.** Item 1's `purpose` field and item 3's guard 4 both fit at
   zero net lines, so neither needed one. What still needs a raise is **spending** item 3's reading:
   `estimateTokens` is provider-agnostic and called from 71 sites, so wiring it costs `budget.ts` +2
   (pin 573, at pin) plus threading a provider fact through `model.ts` (pin 3652, at pin) — and it
   needs a design call first (a single global minimum vs a per-population divisor for prose vs tools
   JSON).
2. **The ritual gate is blocking.** The next cut needs a real ritual marker (`--blast` + a fresh
   ten-family draw), and now ten **distinct** families.
3. **Two copies will drift again.** The parity clause catches it at the next suite run rather than the
   next release, but nothing tells the kit it has a mirror. The standing fix is one line in the kit's
   marker-writing path printing the field list the gate must carry.
4. **Migration numbers are a shared space.** Round 1's migration collided with lane 1's 173 and was
   renumbered to 174 before hand-off. Two lanes cannot both read "next free".
5. **A cross-lane suite flake, not a defect.** `prompt/__tests__/a-rename-reaches-the-soul.test.ts`
   uses a FIXED `os.tmpdir()` fixture path, so parallel lanes delete each other's fixture; it passes
   alone at base and in both lane worktrees. Needs a per-run suffix by whoever owns it.
6. **Item 2 crossed the repo boundary** three times now (kit `692c7f7`, `f9dbf8e5`, `40ab5aaf`), on kit
   `main` rather than a lane branch, so those commits are outside whatever review the dojo lanes get.
7. **The file-rewrite hazard is real and cost this report once.** Heredoc (`python3 - <<'PY'`) edits in
   these worktrees have been silently reverted or partially applied more than once; each time it was
   caught only because a clause went red. Every edit this round was read back or re-run after writing.
