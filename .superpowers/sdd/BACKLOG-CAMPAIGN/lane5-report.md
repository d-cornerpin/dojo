# LANE 5 — W1/W2 TOOL-ARRAY CAPS: REPORT

**Branch** `t86-lane5` off `791467ff` (detached worktree). **Spec** `caps-design.md`.
**Status: COMPLETE.** Both workstreams shipped, mutation-proven both directions, full suite and
typecheck green on every commit. **One gate is RED and I did not touch it: the size ratchet, +5
lines on `cat/agents.ts`. The raise is argued in §6 — it is the only thing this lane asks for.**

| commit | what |
|---|---|
| `6c68aed4` | W1+W2 PRODUCT |
| `36133f80` | W2 PRODUCT FIX — the replay path had disabled the ceiling (found by its own test) |
| `6b6067f1` | W1+W2 TESTS — 47 clauses, 10 mutations |

Final: full suite **478 files / 7195 tests green**, `tsc --noEmit` clean, eslint 0 errors,
`check-lint-baseline` 216/219 (three BELOW the pin — a swallowing `catch {}` was deleted),
`check-growth`, `check-no-personal-names`, `check-orphans`, `check-wiring`, `check-sql-prepares`,
`check-must-consume`, `check-iso-writes` all green. **No `definitions.ts` edit, so no golden
moves. No `ratchets.json` / gate-manifest edit. No live server or `~/.dojo` write.**

---

## 1. THE TWO REFUSAL MESSAGES, VERBATIM

**W1 — the cap** (`agent/always-loaded-tools.ts`, `alwaysLoadedCapRefusal`; `30` is interpolated
from `PRIMARY_AGENT_ALWAYS_LOADED.length`, never a literal):

```
always_loaded_tools has 31 entries; the cap is 30 (the primary agent's own always-loaded size). Pass the tools this agent needs one call away and let it load_tool_docs for the rest.
```

**W1 — the unknown names** (the defect that used to be silent):

```
always_loaded_tools names tools that do not exist: not_a_real_tool, also_invented. Check the tool index.
```

**W2 — the per-call cap** (`tools/tool-session-set.ts`, `loadToolDocsOverflowRefusal`; `12` is
interpolated from `LOAD_TOOL_DOCS_MAX_PER_CALL`):

```
Error: load_tool_docs accepts at most 12 tool names per call (received 13). Load the ones you need for THIS step; you can call again for the rest.
```

**W2 — the eviction note**, appended to the tool result so a name never leaves silently:

```
Evicted from your session set (unused longest): tool_000. Re-load if you need them.
```

**W2 — the manual/tool split** (replaces the false `Tools not found: x`):

```
Loaded, but no manual is available on this install for: no_manual_here. Those tools are real and callable — the generated documentation is missing, not the tool.
```

Two more refusals W1 added, for completeness: the shape clause — `always_loaded_tools must be an
array of tool names; received string ("none"). Pass ["tool_a", "tool_b"], or omit the field to
take this agent's role default.` — and the element clause, `always_loaded_tools[1] is not a tool
name (42). Every entry must be a non-empty tool name string.`

---

## 2. W1 — WHAT SHIPPED

New module `packages/server/src/agent/always-loaded-tools.ts` (174 lines), exported so both spawn
paths share one predicate.

> **CORRECTION (review C, L3-F1's sibling finding L5-F1 — 2026-09-26).** The sentence that stood here
> said this module is exported so the backlog's `POST /api/agents` `'none'` fix could **reuse** it.
> **IT MUST NOT BE REUSED THERE.** That backlog line is the **file_read / file_write grant** path,
> where `'none'` is a *documented scalar* — clause 1 ("must be an array") would refuse a
> documented-valid value. The two are not the same cast and not the same shape. Anyone picking up that
> backlog item writes a predicate for a field whose legal domain includes a scalar; this validator is
> for a field whose legal domain does not.

* **THE CAP IS DERIVED.** `alwaysLoadedMax()` returns `PRIMARY_AGENT_ALWAYS_LOADED.length`. A
  review that shrinks the primary shrinks the cap in the same edit.
* **A FUNCTION, NOT A CONST — measured, not stylistic.** The first cut read the constant at module
  init, and eight existing suites stopped loading: they partially `vi.mock`
  `tools/tool-docs.js`, and an init-time read of an export their mock does not declare fails the
  whole import graph. Reading it at call time also means the cap cannot be captured before the
  list it derives from is final.
* **THE HANDLER REFUSES AHEAD OF THE INSERT** (`cat/agents.ts`), so a refused spawn leaves no
  half-built agent — the property the design names as the reason the handler, not the spawner,
  owns the user-facing refusal. It answers **`INVALID_ARGS`**, deliberately not
  `PERMISSION_DENIED`: an argument problem reported as a permission problem is the T80a incident
  one field over, and `classifyToolResult` reads the code, never the prose.
* **THE SPAWNER KEEPS A THROW AS THE FLOOR** for **both** of its callers —
  `agent/tools/cat/agents.ts:355` (the `spawn_agent` handler) and `vault/maintenance.ts:1876` (the
  Dreamer's curation spawn). **CORRECTED (L5-F1):** this line said "three callers", and the count was
  the throw's whole justification. There are two.
* **THE SWALLOWED WRITE IS GONE.** `catch { /* column may not exist on very old databases */ }`
  is discharged by migration 022 — it could only ever hide a real fault behind a
  successful-looking spawn.
* Clause order: shape → elements (by index) → canonicalise + de-duplicate → cap → existence.
  De-duplication happens BEFORE the cap, so two spellings of one tool spend one entry, and the
  stored array can never emit the same schema twice.

### The one deliberate deviation: where existence is checked

The design says validate names against the registry at both seams. **Existence is checked only
where a registry is already in scope — the handler — and the floor enforces shape/elements/cap.**
The reason is measured: importing the registry into `always-loaded-tools.ts` pulls
`agent/tools/definitions.ts` (2,908 lines) and, through its concurrency registration, the whole
`agent/v2` subtree into **`spawner.ts`'s** import graph, a module that had never carried the tool
registry. The eight broken suites were that graph change made visible. The validator therefore
takes an optional `KnownTools` (`{ has(name): boolean }`); `toolDefinitionsByName()` satisfies it
and so does a bare `Set`. The handler passes it; the floor does not.

**What that costs, stated plainly — CORRECTED (L5-F1), and the correction makes it smaller:** the
original sentence claimed an unknown name arriving "through the dashboard create route or an engine
spawn" is still written. **The dashboard route does not exist as a path for this field:**
`always_loaded_tools` / `alwaysLoadedTools` appears **nowhere under `gateway/`**, and the Dreamer's
spawn does not pass the field either (its params are parentId, name, systemPrompt, classification,
timeout, persist, toolsPolicy, permissions, initialMessage). So the only live caller that passes it is
the handler, which **does** carry the registry — meaning existence is in fact **closed on every
reachable path today**, and the residual is a guard against a FUTURE caller rather than a live hole.
The cap and the shape are closed for both callers, on both branches (the no-registry branch is now
pinned by its own clauses — review C, L5-F2). If
the owner wants existence closed at the floor too, the honest fix is to give the spawner a
registry it can reach without the v2 graph, which is a separate piece of work and not a line in
this one.

---

## 3. W2 — WHAT SHIPPED

New module `packages/server/src/tools/tool-session-set.ts` (209 lines) holding the session set,
both numbers, the eviction, and the two message builders. `tools/tool-docs.ts` re-exports
`getSessionLoadedTools` / `markToolsLoaded` under the name every caller already imports, and
**shrank by one line** in the process.

* **PER CALL 12, ENFORCED AT THE HANDLER ON THE RAW REQUEST.** The design's Seam A put it inside
  `executeLoadToolDocs`; I moved it one layer out, and this is the second deliberate deviation.
  By the time the executor sees the array, `cat/meta.ts` has already intersected it with
  `getFilteredTools(agentId)` — so a 40-name runaway from an agent that may use 3 of them would
  arrive as 3 and pass a cap measured there. The bound exists to stop a runaway REQUEST, so it is
  measured on the request. The executor keeps the identical sentence as a floor, from the same
  owner, so neither can drift. (Test §5 pins exactly this case.)
* **NOT `maxItems` ON THE SCHEMA**, per the design: `load_tool_docs` is in every agent's
  always-loaded set, so its definition sits inside the cached prefix; a keyword there moves the
  cache-prefix golden and re-bills every agent's prefix once, for a bound the handler enforces at
  zero prefix bytes. Recorded in the code as a strictly-better follow-on for whenever a task is
  already moving that golden.
* **SESSION 64, LRU BY LAST CALL, AND THE RECENCY IS READ RATHER THAN INSTRUMENTED.** The design's
  §4 item 3 was "the exact hook that records 'tool called this turn' — I asserted one exists but
  did not find a live per-turn called-set". **Resolved without adding one.** Every tool call is
  already an assistant `tool_use` row — the same record `rehydrateSessionToolsFromHistory` replays
  — so the ranking is read from it, bounded to 400 rows, and **only at the moment the ceiling is
  crossed**, which the corpus says is approximately never. No dispatcher hook, no per-call
  bookkeeping, nothing to keep in sync, and no line added to the pinned `agent/tools/index.ts`.
  An unreadable record answers "nothing is ranked" and falls back to load order: best effort by
  construction, because a failed read must never break a turn or evict out of turn.
* **THE TWO PINS.** A name called in the newest turn ON RECORD is never evicted — when every
  candidate is pinned the set is left **OVER** the ceiling, because over by a name for one turn is
  strictly cheaper than taking a tool away from a model mid-turn. Always-loaded names are not in
  this set at all, so that pin is a documented no-op rather than a branch.
* **EVICTION IS REPORTED** in the tool result, never silent.
* **A MISSING MANUAL IS NOT A MISSING TOOL.** The existence test was `readToolDoc(name)`, a
  doc-FILE lookup, so a real tool whose generated `.md` never landed came back as
  `Tools not found: x`. Every name reaching the executor has already been intersected with
  `getFilteredTools(agentId)` — the precondition `readToolDoc`'s own docstring states — so it IS
  real and callable: it is marked loaded, and the absent manual is reported as a fact about the
  install. "No such tool" stays where its authority is, the handler's registry-backed
  `describeNameFailure`. **No registry import was needed for this**, which is why the split is
  cheaper than the design expected.

### The bug the tests found (`36133f80`)

`markToolsLoaded` pinned every name the current call asked for, and
`rehydrateSessionToolsFromHistory` calls it ONCE with a whole replayed session — so every
candidate was pinned and **71 names survived a 64 ceiling**. The bound existed and the one path
that can exceed it in a single step walked past it (Seam C). Fixed with a tier whose condition is
exactly what makes the pin impossible: the batch becomes evictable **when the batch alone exceeds
the ceiling**. A batch that fits is never the reason the bound broke (an ordinary call is ≤ 12 and
can never exhaust the older tier); a batch that does not fit gives up its coldest, which for a
replay with no call record is the FRONT of the sequence — so survivors stay in replayed order,
which is the property Seam C actually protects.

---

## 4. MUTATION PROOF — 10/10 RED, RESTORE RE-VERIFIED GREEN

One guard broken at a time in the PRODUCT, the owning test file run, restore verified afterwards.

| # | mutation | result |
|---|---|---|
| M1 | W1 cap clause removed | 2 failed / 17 |
| M2 | W1 unknown-name clause removed | 2 failed / 17 |
| M3 | W1 array-shape clause removed | 4 failed / 15 |
| M4 | W1 de-duplication removed | 2 failed / 17 |
| M5 | W2 per-call floor removed (executor) | 1 failed / 27 |
| M6 | W2 per-call cap removed (handler seam) | 2 failed / 26 |
| M7 | W2 session ceiling neutered | 7 failed / 21 |
| M8 | W2 tiered eviction removed (replay path) | 1 failed / 27 |
| M9 | W2 existence split reverted to the doc-file test | 2 failed / 26 |
| M10 | W2 eviction reported silently | 1 failed / 27 |

**The other direction — nothing at or under the bound changes behaviour:**

* W1 §5: the corpus measured **0** agents with a non-NULL `always_loaded_tools` and **1**
  `spawn_agent` call in the entire message history, so a corpus-shaped declaration (one name,
  three names, a specialist eleven) passes through byte-identically **in declaration order**, and
  an absent declaration still writes nothing at all.
* W2 §1: 1-, 2-, 3- and 4-name calls — **98.4% of 372 live calls** — produce the pre-cap output
  string EXACTLY (count line, manuals joined by `\n\n---\n\n`, nothing appended), asserted with
  `toBe`, not `toContain`. 8 names, the largest array ever observed, is accepted. 12 is accepted at
  both seams.
* W2 §4: under the ceiling, rehydration still replays every name in order, including the
  `load_tool_docs` name the CALLED pass appends behind the sequence (requirement #15).

---

## 5. WHAT I DID NOT DO

1. **W3 is untouched**, as scoped: restart rehydration still imports CALLED names as well as
   loaded ones. Seam C bounds its RESULT; it does not change what it imports.
2. **The `POST /api/agents` `'none'` fix** (backlog item) is not wired, and **this validator is the
   wrong tool for it** — see the correction in §2. That backlog line is the file-grant path, where
   `'none'` is a documented scalar; clause 1 would refuse it. Whoever takes that item writes a
   predicate for a domain that legally includes a scalar.
3. **No existence check at the spawner floor** — §2, with the measurement and the cost.
4. **`ratchets.json` untouched**, so the tree has one red gate; see §6.

---

## 6. THE ONE RAISE I AM ASKING FOR

```
packages/server/src/agent/tools/cat/agents.ts: pinned 1533, now 1538  (+5)
```

**The five lines, itemised:** 1 import of the validator, 1 import of
`toolDefinitionsByName` (the registry the handler hands in), 1 comment line, and the 2-line guard
— `const declared = validateAlwaysLoadedTools(args.always_loaded_tools, toolDefinitionsByName());`
plus the refusal-and-audit line. The pre-existing cast line was replaced 1:1
(`alwaysLoadedTools: declared.names,`), so nothing else moved.

**Why it cannot go elsewhere.** The design and the brief both require the refusal to happen in the
HANDLER, and the reason is not cosmetic: the spawner's write sits AFTER the agent INSERT, so a
spawner-only refusal leaves a half-built agent — the exact outcome the guard exists to prevent.
The other three files this lane touched absorbed their changes inside their own pins:
`spawner.ts` is **unchanged at 1459** (the new import paid for by the deleted swallow),
`tool-docs.ts` **shrank to 682** (pin 683) by moving the session set into a new module, and
`cat/meta.ts` (unpinned, 145 → 161) stayed well under the 240 crossing line. Both new modules are
174 and 209 lines, under the 240 crossing line and the 400 new-file cap; `check-growth` is green.

**What I will not do to avoid it:** rewrap or delete unrelated comments in `cat/agents.ts` to buy
five lines. That is gaming the instrument the ratchet exists to be, and `$raises` exists precisely
so the alternative is an argued entry rather than quiet erosion. Five lines, at a file already
1,533 lines long, for the guard that closes a silent-typo path and a cache-prefix hazard.

**Suggested `$raises` entry** (owner/gate-side commit, not mine):

```json
{ "path": "packages/server/src/agent/tools/cat/agents.ts", "from": 1533, "to": 1538,
  "by": "W1 tool-array cap (BACKLOG-CAMPAIGN caps-design.md §1)",
  "why": "+5 NET (2 imports, 1 comment, 2-line guard; the cast line replaced 1:1). The refusal MUST be handler-side: the spawner's write happens after the agent INSERT, so a spawner-only refusal leaves a half-built agent. The other three touched files absorbed their changes inside their pins (spawner.ts unchanged at 1459, tool-docs.ts shrank to 682, meta.ts unpinned at 161) and the two new modules are 174/209 lines." }
```

---

## 7. CONCERNS

1. **The ratchet red above** is the only thing blocking a clean gate run.
2. **The recency read is a DB read inside `markToolsLoaded`**, which was pure in-memory before.
   It fires only when a set crosses 64 (the corpus says one agent has ever accumulated that much,
   and it is the harness bot), it is wrapped so a failure cannot break a turn, and it is bounded
   to 400 rows — but it is a new read on a path that had none, and that is worth the owner
   knowing rather than discovering.
3. **`SESSION_TOOL_SET_MAX` can be exceeded, by design**, when every candidate was called in the
   newest turn on record. The set then sits at ceiling+N until a later call can evict honestly. I
   believe this is the right trade (prefix churn mid-turn is the more expensive failure), but it
   does mean the ceiling is a strong bound rather than an absolute one, and a scenario that calls
   64 distinct tools inside one turn would hold it open.
4. **The cap numbers are forward guards with zero measured breakage**, which is their strength and
   also the limit of the evidence: the corpus cannot tell us what a real user box with
   sub-agent-heavy usage does. The caps are write-time only — existing rows are never
   re-validated — so no running agent is retroactively disarmed.
