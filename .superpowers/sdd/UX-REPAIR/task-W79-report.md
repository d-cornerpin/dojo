# W79 — THE TOOLS LANE APPENDS ACROSS A RESTART, NOT JUST ACROSS LOADS

Branch `ux-access-a7` from `ux-access-a6` (`a60d4632`). Two commits, nothing
pushed, no cut.

| | |
|---|---|
| fix | `95e9974d` T79: the tools lane appends across a RESTART, not just across loads |
| gate-side | `d6ccd24b` raise one ratchet pin for T79 (`tool-docs.ts` 595 → 683) |

---

## 1. WHICH-LINEAGE VERDICT

**Neither lineage regressed. The hole is in W69's own fix and it shipped with it
at v3.1.22.**

```
git diff b382580f HEAD -- packages/server/src/tools/tool-docs.ts
                          packages/server/src/agent/model.ts
                          packages/server/src/agent/tools/cat/meta.ts
  (empty — byte-identical)
```

Every file on the tools-array path is unchanged between `v3.1.22` (`b382580f`,
where T72b/3 shipped) and `a60d4632`. UX-ACCESS A1–A6 touched `surface.ts`
(what an agent may have) and never touched what ORDER the array carries. The
fleet probe in §5 confirms it from the other side: over all 114 agents the
advertised surface and the assembled at-rest array are byte-identical between
the base commit and this branch.

And W69's fix is not broken in the shape the report describes. Driven on the
live box, for the reported agent and its three real batches, three sequential
loads in ONE process append cleanly every time — each load's schemas land after
everything previously present, and the divergence is the array's closing
bracket:

```
before any load   14 tools  47,108 chars          tail (empty)
after load #1     15 tools  48,265   divergence at char 47,107 of 47,108
after load #2     19 tools  50,644   divergence at char 48,264 of 48,265
after load #3     21 tools  51,880   divergence at char 50,643 of 50,644
```

**What the fix never covered is the PROCESS BOUNDARY**, and that is where the
owner's numbers come from.

---

## 2. THE MECHANISM

`packages/server/src/tools/tool-docs.ts:299-331` (pre-fix) —
`rehydrateSessionToolsFromHistory`:

```
SELECT content FROM messages WHERE agent_id = ? AND role = 'assistant'
  ORDER BY created_at DESC, rowid DESC LIMIT 40
…
if (block?.type === 'tool_use') seen.add(block.name);
```

`partitionToolsForApiCall` (`tool-docs.ts:438`) reads the tail off a per-agent
`Set` whose insertion order IS the load order — **in one process**. The set does
not survive a restart, and the line above rebuilt it from the **CALLED** set, in
**CALL** order. Three ways that is not the array it is supposed to restore:

- a tool loaded and not yet called **vanishes** — the array SHRINKS and
  everything behind the gap moves;
- two tools loaded in one batch and used in the other order come back
  **SWAPPED**;
- anything older than the 40-message window is **gone**.

W69 added `rows.reverse()` here for exactly this reason ("the set it fills is
now the tools lane's ORDER"). It fixed the DIRECTION of a sequence that was
still the wrong sequence.

**Why it fires without the user doing anything.** The dev box runs
`tsx watch src/index.ts`. Every source edit restarts the server, and the first
turn after each restart re-derives every live agent's tail. Restarts are
uncorrelated with loads, which is why the owner saw it on a conversation with
3+ loads and read it as a per-load defect.

### The offsets match

Measured on the live box for the reported conversation (agent `a504e5c9`):
the head is 47,108 chars and head + first-loaded-tool is 48,265. At the
chars-per-token ratio his own two numbers imply (~4.35) those are **10,834** and
**11,041** — his **10,837** and **11,043**. The divergences sit AT the head|tail
boundary and ONE TAIL ENTRY IN: the tail's order and membership moved, and
nothing in the head did. The receipts agree from the other side — the system
prompt's sha is byte-constant (`ad568e801eb861f5`) across all three calls, so
nothing in the system region moved either.

The tools array is the first thing on the wire, so a divergence there re-bills
the system prompt and the entire conversation behind it: a **near-constant
offset** with a **cost that grows with the conversation** — 931 → 8,582 →
17,916. That is the shape, exactly.

---

## 3. THE FIX

`tool-docs.ts:315-401`. Rehydration **replays the load sequence the history
already records** instead of inferring one:

- every `load_tool_docs` call is an assistant `tool_use` block carrying the
  exact names it asked for; the rows are ordered. Replayed **oldest-first**.
- scoped to `session_started_at`, the same boundary the assembler reads, so a
  restart after a reset cannot hand back the session the agent was told to
  forget.
- names canonicalized through `resolveToolAlias`, the same rule the door applies
  before it loads anything (`agent/tools/cat/meta.ts:69-74`), so a renamed tool
  replays as the name that was actually loaded.
- **nothing new is stored.** No table, no column, no write path. The record
  existed; it was simply not the one being read.
- membership stays settled in ONE place — `partitionToolsForApiCall`'s `byName`
  filter. A name the door refused sits in the set and never reaches the array.
- **requirement #15 preserved**: a tool the agent is demonstrably USING whose
  load is not on record (a pre-fix conversation, an archived session) still
  comes back — **appended behind** the replayed sequence, so recovering one can
  never move one the record already placed.

One number was introduced, `LOAD_SEQUENCE_CALL_CAP = 500`, a runaway guard and
not a window. Measured, not invented: the owner's 365 MB dev dojo holds **257**
load calls in its entire message table across every agent and every session it
has ever run; the busiest single agent has 228 all time and the most in any one
live session is 4.

---

## 4. DRIVEN: BEFORE AND AFTER

Same agent, same history, same permitted set. A restart, then the tools array
the next call goes out with.

```
ARM A  pre-T79 rehydration
  tail: email_search, plaud_recent_recordings, plaud_list_recordings,
        plaud_account_info, plaud_search_recordings          50,720 chars
  vs the pre-restart array:  PREFIX BROKEN
  divergence at char 48,280  (~11,041 tok at his ratio — his 11,043)
  2 tools DROPPED (plaud_get_summary, plaud_get_transcript), 2 SWAPPED

ARM B  T79
  tail: email_search, plaud_list_recordings, plaud_recent_recordings,
        plaud_get_summary, plaud_get_transcript, plaud_account_info,
        plaud_search_recordings                              51,880 chars
  vs the pre-restart array:  BYTE-IDENTICAL — 0 invalidated
```

Consecutive-call diffs across the three real batches, each preceded by a
restart, with the system prompt (24,781 chars) and the message array taken from
that call's own receipt. ARM A's replay of the pre-T79 algorithm is validated
against the real pre-T79 function's output over the full history — identical,
name for name.

```
        ARM A (pre-T79)                ARM B (T79)
load    divergence  invalidated        divergence  invalidated
 #1        11,777        9,087            11,777        9,087
 #2        12,066       15,954            12,066       15,954
 #3        12,070       16,723            12,661       16,423
```

Load #3 is the restart-hit call: ARM A diverges 591 tokens earlier, one tail
entry in, and sends an array missing two tools the session had loaded. ARM B
appends after everything previously present. Determinism holds — three restarts
in a row produce byte-identical arrays for `kevin`, `healer`, `dreamer` and the
reported agent.

---

## 5. CONTROLS

| control | result |
|---|---|
| **114-agent effective-capability diff** | **EMPTY** — advertised surface + at-rest array + breakpoint index byte-identical between `a60d4632` (worktree) and this branch, `md5 454d8f2269fe1e2861002828b36532bd` both sides |
| **single-load shape** | `check-cache-prefix` assertion 7: loading `work_note` mid-session grew kevin's array **29 → 30**, cached region byte-identical, breakpoint index **28** unchanged — W69's proof shape, and kevin's breakpoint is 28 in BOTH arms of the fleet probe |
| **prompt bytes / goldens** | **ZERO movement** — `check-cache-prefix` and `check-assembled-context` green with **no `--update`**, golden on disk `98864a0aa32bcf6b…` |
| A5/A6 panel behavior | untouched — full suite green, surface diff empty |
| server unit suite | **387 files / 5,654 tests green**, exit 0 (W78: 5,647 — +7, this task's clauses) |
| `npm run typecheck` | exit 0 |
| `tsc -p packages/dashboard` | exit 0 |
| `npm run lint` | **0 errors, 104 warnings** — the pinned baseline exactly |
| `npm run gates:block` | **13/13 blocking green** |
| `npm run gates:report` | capability-ledger reporting + deletion-ratio refusing on the pre-existing untracked `task-W72-report.md` — the same two A1–A6 recorded |
| kit roster | **conformant** — 9 checkers, 8 rostered, 1 declared manual |
| kit prompt-gate roster | **8/8 exit 0** at `d6ccd24b`, record accepted by `check-prompt-gate-record.mjs` |

### The one behavior change, declared

Three of 114 agents' first post-restart array moves, and **every move is a
restoration** — no agent loses anything it had:

```
a504e5c9   19 → 21 tools   (50,720 → 51,880 chars)   +2 restored, order corrected
healer     16 → 17 tools   (25,188 → 25,913)         +1 restored (file_write)
kevin      29 → 49 tools   (77,196 → 116,696 chars, +9,875 est tok)  +20 restored
```

**Kevin's +9,875 tokens is a real cost and it is the point.** That session
opened 2026-07-26 and has made 16 load calls; the old path silently garbage-
collected 20 of them at every restart, and the agent then re-loaded what it
needed — each re-load re-billing the whole prompt behind the tools array. The
contract this task states ("loaded tools keep their first-load position
forever") pays the schemas once instead. The bound is the session: a reset or a
new session clears the set, and the replay is scoped to `session_started_at`.

---

## 6. WHAT THIS DOES NOT FIX, STATED PLAINLY

Append-only makes the tools ARRAY a stable prefix. It does not make the PROMPT
one. On this provider the tools array is the first thing on the wire, so a
legitimate mid-session load still re-bills the system prompt and the whole
conversation behind it — in the measurement above, load #2 invalidates 15,954
tokens in both arms and only ~600 of those are the new schemas. That is
structural, not a defect: a provider will not accept a call to a tool that was
never declared, and a declaration that arrives later arrives before everything
that came after it. What this task removes is the class of invalidation that had
no cause at all — the array reshuffling with no load behind it.

---

### One flake seen and run to ground, not mine

A suite run that straddled local midnight failed one clause of
`tracker/__tests__/activity-over-a-window-becomes-readable.test.ts` — the S4
shape, "57 opened and 57 closed **today**". It is a day-boundary coin-flip and
it is not this branch's: the file passes alone in **both** trees (22/22 in the
`a60d4632` worktree and 22/22 here), the run before midnight was green, and the
re-run at 00:02 is green. Flagged for whoever owns the tracker window; nothing
in this task touches it.

## 7. HOUSEKEEPING

Base worktree removed. Dev instruments installed twice and uninstalled twice,
verified clean both times (`0 [DEV-INSTRUMENTS] markers left`). Working tree
carries only the pre-existing untracked `task-W72-report.md`, which arrived
before this task. No background process left running.
