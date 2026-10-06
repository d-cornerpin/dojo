# t117 — the release-blocking import cycle

**Status: fixed, gate green.** Two product commits on `t117-import-cycle`:

| sha | what |
|---|---|
| `8e160973` | the origin-intent vocabulary moves to a leaf — the gate-blocking fix + the clause |
| `c9f7f8f7` | the owner-escalation clock moves to a leaf — the same defect, unmasked by the first |

Not pushed.

---

## 1. The gate output, before and after

The gate is `deploy/check-prefix-determinism.mjs`. It imports `db/connection.js` and then
`memory/assembler.js` out of the packaged `dist`, with **no server boot ahead of it**, and
assembles the stable prefix twice.

BEFORE:

```
  ✗ cache-prefix determinism gate: could not import the dist assembler:
    Cannot access 'START_ACK_ORIGIN_INTENT' before initialization
```

AFTER (exit 0):

```
  ✓ cache-prefix determinism gate: stable prefix byte-identical (24114 chars),
    systemVolatile empty, smell-free
```

Both measured in the same sandbox, against a real migrated database, invoked the way
`release.sh:582-584` invokes it. Two notes on reproducing it outside a packaged build:

- `@dojo/shared`'s `main` points at TypeScript source on purpose (so `tsx watch` needs no
  build), and plain Node cannot load that. The repo already has the answer —
  `deploy/resolve-shared-dist.mjs`, a resolve hook written for the tool-conformance gate. The
  packaged artifact instead rewrites the staged `main` (`build-package.sh:63-67`).
- `tsc` does not copy `src/db/migrations/*.sql` into `dist`, so a repo-local `dist` cannot
  migrate a fresh database. Copying the 186 SQL files into `dist/db/migrations` is enough.
  Both are properties of the repo-local `dist`, not of this defect.

## 2. The cycle, as a chain

`work/ask-settlement.ts:386` built a SQL fragment at **module scope**:

```ts
const NOT_A_START_ACK = `NOT EXISTS (SELECT 1 FROM messages ma WHERE ma.id = d.message_id
                 AND ma.origin_intent = '${START_ACK_ORIGIN_INTENT}')`;
```

The constant was declared at `memory/message-store.ts:1153` — near the END of the file. And
message-store reaches ask-settlement again through its own dependencies:

```
memory/message-store
  -> work/store
  -> work/obligation-memory
  -> vault/store
  -> memory/embeddings
  -> agent/abortable-call
  -> agent/live-work
  -> gateway/ws
  -> agent/v2/outbound
  -> agent/v2/deliveries
  -> work/ask-settlement
  -> memory/message-store          <-- closes the cycle
```

The assembler enters it in two hops: `memory/assembler -> agent/v2/counterparty ->
memory/message-store`, and separately `memory/assembler -> memory/recall-lane ->
agent/v2/answered-edge -> work/ask-settlement`.

So whenever message-store was the module a process entered **first**, ESM evaluated
ask-settlement's top level while message-store was still mid-initialization — before its
`export const` line had run — and the module-scope read landed in the temporal dead zone.

**The booted server never saw it.** `index.ts` happens to pull a module that finishes
message-store before anything reaches ask-settlement's top level, so the cycle resolved by
luck of import order. The gate was the first consumer to import the assembler first, and it
paid for the luck: it reported a prefix problem when nothing in the prefix had changed.

## 3. The root fix, and the argument for it

The `origin_intent` vocabulary moved to **`memory/origin-intents.ts`, a leaf module that
imports nothing**. The same move, for the same reason, produced
`scheduler/validation-clock.ts`.

Why a leaf is the fix rather than a patch: a module with no dependencies **cannot be partway
through its own initialization when someone reads it**. That makes a module-scope read of
anything declared there safe under *every* import order — not under the orders we happened to
test. Reordering imports, by contrast, buys a different piece of luck; it leaves the next
consumer to find the same dead zone, which is exactly how this one reached a release gate.

`message-store` re-exports both constants, so **every existing reader is unchanged** — the
constants still read as message-store's vocabulary, which is what the original comment said
and is still true. The declaration is what moved.

**A measured correction worth recording.** While building the clause, the obvious mutant —
point ask-settlement's import back at `message-store` — did **not** bring the dead zone back.
An ESM re-export binds the importer to the *leaf's* binding, not to anything of the
re-exporting module's, so reading through `message-store` is safe even from module scope. A
first draft of this fix carried comments in four files asserting the opposite; they were
corrected before commit. The load-bearing invariant is **where the constant is DECLARED**, and
that is what the clause guards. The `import … from '../memory/origin-intents.js'` spelling in
ask-settlement is kept because it says out loud why the leaf exists, not because the other
spelling would be wrong.

## 4. The sweep

The question asked was whether other module-scope reads in the assembler's graph sit one
import away from the same defect. A static brace-depth scan for "top-level reads of imported
bindings" produced mostly false positives (strings and regexes defeat the depth count), so the
sweep was done **empirically** instead, which is both honest and exhaustive for the question:

> for each of the 466 modules reachable from `memory/assembler.js`, import that module FIRST,
> alone, in a fresh process, and record what it throws.

**33 of 466 threw.** Three defect families:

| family | entry points | status |
|---|---|---|
| `START_ACK_ORIGIN_INTENT` | 31 | **fixed** (`8e160973`) |
| `VALIDATION_ESCALATION_MIN` | 1 | **fixed** (`c9f7f8f7`) |
| `<provider><Read\|Write>ToolDefinitions` | 6 | **open, reported** |

After both commits: **6 remain, all in the third family.** The 31 included
`memory/assembler.js` and `memory/message-store.js` themselves plus 29 others
(`agent/v2/steps/finalize/*`, `agent/v2/counterparty`, `prompt/registry/entries`,
`scheduler/runner`, `report/gather`, `tracker/notify`, `work/join-drive` and more) — one
defect, not thirty-one.

### The one that was masked

`scheduler/runner.js` appeared in the START_ACK list, and fixing that revealed its own:
`tracker/pm-agent.ts:985` derives `VALIDATION_COVERAGE_BOUND_MS` from runner's
`VALIDATION_ESCALATION_MIN` at module scope, while runner reaches pm-agent back through its
own graph. Identical shape, identical fix. **This is the sweep earning its keep**: the first
throw in a graph hides every later one, so a fix must be followed by a re-sweep or it only
moves the symptom.

### Still open: the provider tool-definition cycle

Six entry points — `google/tools-read`, `google/tools-write`, `microsoft/tools-read`,
`microsoft/tools-write`, and the two `agent/tools/provider/*` shims — throw
`Cannot access 'googleReadToolDefinitions' before initialization` (and the three siblings) from
a module-scope read at `agent/tools/index.js:105`.

**CORRECTED AFTER REVIEW — the six ARE inside the gate's import closure.** This report's
original wording was "it does not block this gate; the gate imports `memory/assembler.js`,
which is green" — an empirical claim, and true. But that was offered as the licence to ride to
v3.3.1, and the stronger reading of it does not survive contact with the graph. The reviewer
computed the transitive closure of value imports from `memory/assembler.ts` and the family is
inside it:

```
memory/assembler -> prompt/assembler -> agent/tools/definitions -> google/tools-read
memory/assembler -> prompt/assembler -> services/imessage-bridge -> agent/runtime
  -> agent/v2/loop -> .../execute/index -> .../execute/run-one -> agent/tools/index
```

Every edge is a value import, none erased at compile time. So the gate's import of the
assembler **does** evaluate both the provider modules and `agent/tools/index.js`, whose
module-scope read is the offender. **The gate is safe by EVALUATION ORDER, not by
unreachability**: entering through the assembler, `agent/tools/definitions.ts:50` fully
initializes `google/tools-read.js` before `agent/tools/index.ts:105` runs its read. The six
throw only when one of *them* is the first module. That is precisely the species of luck this
lane exists to remove, now sitting one import away from a release gate.

Left unfixed here, deliberately, on the corrected basis — three things, none of them
unreachability:

1. **The gate's own entry point is clause-protected.** Arm 1 imports `memory/assembler.ts`
   first in a fresh child, on source. If any future import flips the order so that
   assembler-first trips the provider dead zone, arm 1 reds in CI rather than a release gate
   refusing a cut.
2. **It is not one commit away.** Unlike a string constant, these are large arrays *mutated at
   module scope in several passes* within their own files (`tools-read.ts:268-305`,
   `tools-write.ts:522-914` and siblings: `push`, `find`, and `for…of` over the array being
   built) and then aggregated in `agent/tools/index.ts`. Moving a declaration does not fix
   that; the module-scope assembly itself has to become a function. It needs its own lane.
3. **It is pre-existing** — not introduced by v3.3. The cut it is near was refused by the
   START_ACK family, which is fixed and proven fixed.

**And it is now MEASURED rather than left unwatched** — see the census arm in §6. The
tool-conformance gate (`deploy/check-tool-conformance.mjs`) imports built tool modules and is
the consumer most likely to enter one of the six first.

## 5. G2 — zero prompt bytes moved

The change moves where two constants are declared; it changes no value and no behaviour. Proven
at the byte level rather than argued:

The prefix was assembled on the **original** tree and on the **fixed** tree, both times by
importing `work/ask-settlement.js` first — the lucky order the original tree tolerates, which
makes the two trees comparable at all:

```
BEFORE  len=24114  sha256=4296d877fc24c362360df84ef5d37d7a77cbd8f98d1d3e399ec974817f94a44b
AFTER   len=24114  sha256=4296d877fc24c362360df84ef5d37d7a77cbd8f98d1d3e399ec974817f94a44b
```

Byte-identical. The gate independently reports the same 24114 chars, byte-identical across its
own two assembles, `systemVolatile` empty, smell-free.

Suites run, all green (one file at a time):

- `memory/the-prefix-holds-still` (16) — the prefix goldens
- `memory/prefix-lane-conformance` (15)
- `memory/message-store` (41), `memory/single-writer-conformance` (13)
- `post-call-classify/the-stamped-start-ack-keeps-its-readers-honest` (14) — the
  writer/authority drift guard, which greps both source files for the constant and forbids a
  second spelling of its value; the leaf move keeps it satisfied
- `post-call-classify/the-answer-the-owner-heard-…` (10),
  `the-composed-answer-delivers-the-first-time` (14),
  `the-owed-window-delivers-the-model-s-own-line` (11)
- `work/ask-settlement` (40), `work/owner-escalation-ordering` (13)
- `tracker/validation-coverage` (11), `tracker/a-wedged-validation-…` (15),
  `tracker/supervisor-works` (19), `tracker/a-close-request-survives-the-scheduler` (13)
- all 7 `scheduler/__tests__` files (65)
- `tsc --noEmit` clean

### One existing clause was edited

`tracker/__tests__/validation-coverage.test.ts` asserted single-sourcing by naming
`'../scheduler/runner.js'` in pm-agent's import path. The declaration moved, so the path moved.
The clause still asserts the fact it was built to protect — pm-agent **imports** the clock and
**declares no second one** — and the value equality (`VALIDATION_COVERAGE_BOUND_MS ===
VALIDATION_ESCALATION_MIN * 60_000`) is untouched and still reads through `runner.js`, which
also holds runner's re-export honest. No clause was weakened or deleted.

## 6. The clause, and the mutant

`packages/server/src/memory/__tests__/the-assembler-initializes-when-it-is-imported-first.test.ts`
— 9 arms.

**Why it spawns child processes.** A temporal dead zone is a property of a module graph's FIRST
evaluation. By the time a vitest file body runs, the worker's registry already holds
message-store (every other test imported it), so the cycle is already resolved and an
in-process import proves nothing. *This is precisely why a suite of this size stayed blind to
the defect for the life of the constant.* Each arm therefore runs the repo's own `tsx` on a
fresh child and reads its verdict off stdout, following the precedent in
`gateway/routes/__tests__/the-version-is-read-the-way-an-esm-module-must-read-it.test.ts`.
The arms run against **source**, so they need no build and cannot be skipped.

The arms:

1. `memory/assembler.ts` initializes when imported first — the import that refused the release
2. `memory/message-store.ts` initializes when imported first — the other side of the cycle
3. `work/ask-settlement.ts` initializes when imported first — **the control**: this one passed
   even with the defect in place, because entering ask-settlement first finishes message-store
   before ask-settlement's own top level runs. That is the luck the booted server was living
   on, and the reason arms 1 and 2 exist.
4. `scheduler/runner.ts` initializes when imported first
5. `tracker/pm-agent.ts` initializes when imported first
6. `scheduler/validation-clock.ts` is a leaf — it imports nothing
7. `runner.ts` re-exports the clock and declares no second one
8. `memory/origin-intents.ts` is a leaf — it imports nothing
9. `message-store.ts` re-exports the vocabulary and declares none of it (and does not re-spell
   `'engine_start_ack'`)

10. **the census** — the set of assembler-graph modules that throw when imported first is
    **exactly** the six named provider modules, each matched to the identifier whose dead zone
    it hits. See §4 and below.

Arms 6-9 compare **comment-stripped** source: these files discuss the very declarations they
must not contain, and a first draft of arm 9 was red on its own doc comment.

**Mutant — declare both constants back in the cyclic modules and read them from there:**

```
× memory/assembler.ts initializes when imported first        TDZ
× memory/message-store.ts initializes when imported first    TDZ
✓ work/ask-settlement.ts initializes when imported first     (the control, as designed)
× scheduler/runner.ts initializes when imported first        TDZ
✓ tracker/pm-agent.ts initializes when imported first        (lucky order, as designed)
× runner.ts re-exports the clock and declares no second one
× message-store.ts re-exports the vocabulary and declares none of it
                                                  5 failed | 4 passed
```

Reverted byte-identically afterwards (`git diff` empty against the committed tree; the final
gate run and the 466-module probe above were both made on the committed tree).

### The census arm (added after review, in this lane's test-only commit)

The review's correction — that the six ride inside the gate's closure and the gate passes on
evaluation order — makes an unwatched latent defect unacceptable, so it is measured. The arm
enumerates the assembler's graph by relative **value** imports (`import type` is erased and
cannot evaluate anything), probes all 468 modules first-in-a-fresh-process at concurrency 12,
and asserts the throwing set is exactly:

```
agent/tools/provider/google.ts      googleReadToolDefinitions
agent/tools/provider/microsoft.ts   microsoftReadToolDefinitions
google/tools-read.ts                googleReadToolDefinitions
google/tools-write.ts               googleWriteToolDefinitions
microsoft/tools-read.ts             microsoftReadToolDefinitions
microsoft/tools-write.ts            microsoftWriteToolDefinitions
```

44s wall-clock; the whole clause file runs in ~51s. It holds the **identifier** per module too,
so the same file acquiring a *different* module-scope defect is still red. It also asserts the
graph is >400 modules and contains the six — a broken enumerator must not make it vacuously
true — and treats a child that dies without a verdict as a thrower rather than a pass.

It bites in **both** directions, which is the point. Both proven:

- **a seventh thrower reds.** Mutant: a module-scope read between `tracker/notify.ts` and
  `work/poke-ladder.ts` (two graph modules with no individual arm) — notify imports poke-ladder
  at the top and declares the binding at the bottom, poke-ladder reads it at module scope:

  ```
  × NEW module-scope dead zone(s) — a cycle that works today only by luck of import order:
    + "tracker/notify.ts :: Cannot access '__T117_MUTANT' before initialization"
                                                          1 failed | 9 passed
  ```

  The other nine arms stayed green, so the census is what caught it. Reverted byte-identically.

- **a module that stops throwing reds too**, so the v3.3.1 lane cannot land silently. Mutant: a
  seventh entry added to the known set:

  ```
  × these no longer throw: the provider lane landed, so update KNOWN_FIRST_IMPORT_THROWERS:
    + "memory/assembler.ts"
  ```

**So the v3.3.1 provider lane must update `KNOWN_FIRST_IMPORT_THROWERS` as part of its work** —
the clause will not go green until it does. That is the required hand-off from this lane.

No import was reordered anywhere in this fix.
