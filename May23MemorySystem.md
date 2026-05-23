# DOJO Memory System — Audit & Redesign Notes

**Date:** 2026-05-23
**Author:** Claude (engine audit pass)
**Scope:** Full read of `packages/server/src/memory/*`, `packages/server/src/vault/*`, `packages/server/src/agent/v2/*`, `packages/server/src/agent/tools.ts`, `packages/server/src/prompt/assembler.ts`.

This document is an architectural review — what the system does today, where it works, where it doesn't, and what to change next. It is **not** a phase brief and does **not** describe code that exists only in the spec.

---

## TL;DR

The DOJO memory system is actually three distinct stores with three lifecycles. The agent does not see them as one thing — and worse, **the agent has no first-class awareness that it has a memory system at all**. It knows the current time and it occasionally sees a "memory compacted" divider, but it does not know:

- how much context it has left
- when compaction is about to fire
- what is in its vault
- which of its summaries are fresh vs. stale
- that some of what it sees was rewritten by the engine

The v2.7.10 fix (removing post-compaction auto-recall) made the system *honest* again — the engine no longer secretly re-injects history. But honesty is not the same as awareness. The agent now operates more reliably but still flies blind. The next move is to give the agent a real sense of its own memory state, on the model of a human knowing roughly how tired they are.

---

## 1. The Three Stores

| Store | Table(s) | Lifecycle | Read by |
|---|---|---|---|
| **Message store** | `messages` | Forever (never deleted) | `memory_grep`, `recall_recent_thread`, `memory_describe`, fresh-tail assembly |
| **Summary DAG** | `summaries`, `summary_messages`, `summary_parents`, `context_items` | Forever (re-summarized, never deleted) | Assembler injects "top-level" summaries each turn; `memory_expand` walks them |
| **Vault** | `vault_conversations` (raw archive), `vault_entries` (extracted facts) | Conversations consumed by Dreamer; entries decay/age out/pin | Session-start scaffolding, `vault_search`, `vault_expand` |

Each store has a different *job*:

- **Messages** = the immutable ledger. Every word the user, agent, or tool produced. Used for audit + grep + on-demand replay.
- **Summary DAG** = the *working* compression. Leaf summaries collapse chunks of ~30K tokens into ~5K; condensed summaries (depth ≥ 1) collapse 4+ leaves into ~6K. Top-level summaries are what the agent sees as "what happened earlier."
- **Vault** = the *learned* memory. The Dreamer agent reads archived conversations and writes durable facts ("David's wife is Crystal", "the cornerpin Wi-Fi password is X") into `vault_entries`. These entries have confidence, retrieval counts, pinning, and a decay model.

The first store is mechanical, the second is statistical, and the third is semantic. None of them know about each other — they are wired together by `assembler.ts` and `compaction.ts`.

---

## 2. ASCII Flowchart — One Agent Turn

```
                    ┌─────────────────────────────────────────────┐
                    │  USER MESSAGE / SCHEDULER FIRE / A2A REPLY  │
                    └─────────────────────┬───────────────────────┘
                                          │
                                          ▼
                ┌──────────────────────────────────────────────┐
                │  v2/loop.ts — turn begins                    │
                │  state.ts: AgentTurnState created            │
                └──────────────────────┬───────────────────────┘
                                       │
                                       ▼
              ┌────────────────────────────────────────────────┐
              │  Persist user msg → `messages` table           │
              │  (store.ts — never lost)                       │
              └────────────────────────┬───────────────────────┘
                                       │
                                       ▼
   ┌───────────────────────────────────────────────────────────────────┐
   │  PRE-CALL GATES (classifiers/)                                    │
   │    • compactionGate  — checks utilization vs 0.90 / 0.96 / 0.99   │
   │    • vaultClassifier — should we fetch vault entries this turn?   │
   │    • hoarding, tracker, technique-ack, close-out, permission      │
   │                                                                   │
   │  If compactionGate says 'compact' → see Flowchart 2               │
   └───────────────────────────────┬───────────────────────────────────┘
                                   │
                                   ▼
   ┌───────────────────────────────────────────────────────────────────┐
   │  CONTEXT ASSEMBLY (memory/assembler.ts)                           │
   │                                                                   │
   │   System prompt header  ← SOUL.md + USER.md + tool docs           │
   │   + "Current date/time: <now>"  (prompt/assembler.ts:325)         │
   │                                                                   │
   │   ── Session-start scaffolding (FIRST turn of session ONLY) ──    │
   │     1. Morning briefing                                           │
   │     2. Vault entries (pinned + session_context tag)               │
   │     3. Top-level summaries from context_items                     │
   │        (scrubbed of any techniques freshly read this session)     │
   │     4. Active tasks (from tracker)                                │
   │     5. Continuity brief (valid for 3 turns post-compaction)       │
   │     6. Scratchpad                                                 │
   │     7. Active user directive                                      │
   │                                                                   │
   │   ── Fresh tail (EVERY turn) ──                                   │
   │     Last N messages where N = 80 / 64 / 40 / 24                   │
   │     by context window (200K / 128K / 32K / small)                 │
   │     • Tool results capped at V2_MAX_TOOL_RESULT_TOKENS = 15K      │
   │     • Tool results > 12 turns old replaced with stub pointing     │
   │       to memory_describe(id=...)                                  │
   └───────────────────────────────┬───────────────────────────────────┘
                                   │
                                   ▼
                ┌──────────────────────────────────────────────┐
                │  Model call (agent/model.ts)                 │
                │  Router picks tier; locked model overrides   │
                └──────────────────────┬───────────────────────┘
                                       │
                                       ▼
                ┌──────────────────────────────────────────────┐
                │  Post-call classifiers (loop detection,      │
                │  progress, output truncation, a2a intent…)   │
                └──────────────────────┬───────────────────────┘
                                       │
                                       ▼
                ┌──────────────────────────────────────────────┐
                │  Execute tool calls in parallel/serial       │
                │  per concurrency partition                   │
                └──────────────────────┬───────────────────────┘
                                       │
                                       ▼
                ┌──────────────────────────────────────────────┐
                │  Persist assistant msg + tool results →      │
                │  `messages` table                            │
                └──────────────────────┬───────────────────────┘
                                       │
                                       ▼
                ┌──────────────────────────────────────────────┐
                │  Loop back to PRE-CALL GATES or finalize     │
                │  (depends on stop_reason)                    │
                └──────────────────────────────────────────────┘
```

Key constants used above (verified in source):

| Constant | Value | File |
|---|---|---|
| `V2_MAX_TOOL_RESULT_TOKENS` | 15000 | `assembler.ts:36` |
| `V2_STUB_AFTER_TURNS` | 12 | `assembler.ts:54` |
| `DEFAULTS.contextThreshold` | 0.96 | `compaction.ts:158` |
| `DEFAULTS.leafChunkTokens` | 30000 | `compaction.ts:159` |
| `UNCOMPACTED_GAP_THRESHOLD` | 30 messages | `compaction.ts:185` |
| `COMPACTION_DIVIDER_THROTTLE_MS` | 10 minutes | `compaction.ts:239` |
| Compaction gate thresholds | 0.90 / 0.96 / 0.99 | `classifiers/compaction.ts` |
| Fresh tail size | 80 / 64 / 40 / 24 msgs | `assembler.ts:144–149` |

---

## 3. ASCII Flowchart — Compaction

```
                                            ┌──────────────────────────┐
                                            │  compactionGate per turn │
                                            └────────────┬─────────────┘
                                                         │
                                                         ▼
       ┌──────────────────────────────────────────────────────────────────┐
       │  TRIGGER CHECK (checkAndCompact, compaction.ts:288)              │
       │                                                                  │
       │   A. assembledTokens > 0.96 × contextWindow  → REACTIVE          │
       │   B. uncompactedGap > 30 messages            → ROUTINE DRAIN     │
       │   C. force flag from recovery cascade        → REACTIVE          │
       │   D. uncompactedTokens > 30K outside tail    → PROACTIVE LEAF    │
       │                                                                  │
       │   If none → return, continue turn                                │
       └──────────────────────────────────┬───────────────────────────────┘
                                          │
                       ┌──────────────────┼────────────────────┐
                       ▼                  ▼                    ▼
              ┌──────────────┐   ┌──────────────┐   ┌──────────────────┐
              │  REACTIVE    │   │  ROUTINE     │   │  PROACTIVE LEAF  │
              │  (full)      │   │  DRAIN       │   │  (single chunk)  │
              └──────┬───────┘   └──────┬───────┘   └────────┬─────────┘
                     │                  │                    │
                     ▼                  │                    │
   ┌─────────────────────────────────┐  │                    │
   │ 1. generateContinuityBrief()    │  │                    │
   │    LLM call, ~4K-token recap    │  │                    │
   │    of last ~50K chars.          │  │                    │
   │    Stored in agents.config:     │  │                    │
   │      continuityBrief             │  │                    │
   │      continuityBriefValidUntilTurn = currentTurn + 3    │
   └────────────────┬────────────────┘  │                    │
                    ▼                   ▼                    │
   ┌─────────────────────────────────────────────┐           │
   │ 2. archiveMessagesBeforeCompaction()        │           │
   │    Raw msgs → vault_conversations table.    │           │
   │    SKIPPED for Dreamer/Trainer/Healer/PM/   │           │
   │    Imaginer (service agents) and for any    │           │
   │    agent with dreamer_ignore=1.             │           │
   │    Compaction ABORTS if archive fails.      │           │
   └────────────────┬────────────────────────────┘           │
                    ▼                                        │
   ┌─────────────────────────────────────────────────────────┴────────┐
   │ 3. runLeafCompaction()                                           │
   │    • Scrub technique bodies from input first (prevents the       │
   │      summarizer from paraphrasing technique content — v2.7.6)    │
   │    • Chunk uncompacted messages at 30K tokens                    │
   │    • Per chunk → generateSummary(depth=0, target=5K)             │
   │    • Insert into `summaries` + link via `summary_messages`       │
   └────────────────┬─────────────────────────────────────────────────┘
                    ▼
   ┌──────────────────────────────────────────────────────────────────┐
   │ 4. runCondensation()  (REACTIVE only, depth ≤ 1)                 │
   │    • Find ≥ 4 uncondensed leaves at depth N                      │
   │    • generateSummary(depth=N+1, target=6K)                       │
   │    • Link via `summary_parents`                                  │
   └────────────────┬─────────────────────────────────────────────────┘
                    ▼
   ┌──────────────────────────────────────────────────────────────────┐
   │ 5. rebuildContextItems()                                         │
   │    Top-level summaries + fresh tail → live context window.       │
   └────────────────┬─────────────────────────────────────────────────┘
                    ▼
   ┌──────────────────────────────────────────────────────────────────┐
   │ 6. insertCompactionDivider() — throttled to once per 10 minutes  │
   │    Inserts a user-visible line in chat:                          │
   │      "── Memory Compacted — reclaimed ~XK tokens ──"             │
   │    The agent ALSO sees this in its fresh tail next turn.         │
   └────────────────┬─────────────────────────────────────────────────┘
                    ▼
              ┌─────────────┐
              │ Resume turn │
              └─────────────┘
```

**What v2.7.10 removed from this flow:**

The block formerly between steps 5 and 6 used to call `insertRecallNudge()` and the v2/loop.ts hard intercept used to auto-run `recall_recent_thread` (8 turns, ~15K chars) and inject the result as a synthetic system message. That re-injection became part of the next fresh tail, which made the next compaction fire sooner with even more re-injected content, which spiraled. The agent in the 17-email campaign saw replayed scheduler messages and re-pasted tool_use blocks for emails it had already sent. Removed in commit `cba0c83`.

---

## 4. ASCII Flowchart — Nightly Dreamer Cycle

```
                ┌─────────────────────────────────────┐
                │ Server startup: index.ts:406        │
                │   scheduleDreamingCycle()           │
                │   setInterval cleanupOldUploads 24h │
                └────────────────┬────────────────────┘
                                 │
                                 ▼
           ┌──────────────────────────────────────────────┐
           │ vault/maintenance.ts:1615                    │
           │ Calculates next 'dreaming_time' (default 3AM)│
           │ Sleeps until then                            │
           └─────────────────────┬────────────────────────┘
                                 │
                                 ▼ (at scheduled time)
   ┌────────────────────────────────────────────────────────────────┐
   │ ENGINE MAINTENANCE (no LLM, deterministic)                     │
   │   1. Delete entries with confidence < 0.1                      │
   │   2. Mark obsolete: confidence < 0.5 + never retrieved + >7d   │
   │   3. Decay: not retrieved in 30d → confidence -= 0.1           │
   │   4. Auto-unpin: pinned >60d + not retrieved in 60d            │
   │   5. Age-out cold: never retrieved + >180d → mark obsolete     │
   │   (Entries with is_permanent=1 are exempt from all of above)   │
   └─────────────────────────┬──────────────────────────────────────┘
                             │
                             ▼
   ┌────────────────────────────────────────────────────────────────┐
   │ DREAMER AGENT (spawned, runs in own context)                   │
   │                                                                │
   │   For each unprocessed vault_conversations row:                │
   │     • Strip platform noise (continuity briefs, session         │
   │       markers, service-agent chatter, healer/tracker           │
   │       reorientation, tool_result payloads, filler "got it")    │
   │     • Cap raw body at 8K chars (head + tail, elide middle)     │
   │     • Cap per-message at 1500 chars                            │
   │     • Batch up to 35% of context window                        │
   │     • Read batch → call vault_remember(content, tags,          │
   │       confidence) for each extracted fact                      │
   │     • Mark conversations is_processed=1                        │
   └─────────────────────────┬──────────────────────────────────────┘
                             │
                             ▼
                  ┌──────────────────────┐
                  │ Re-schedule for next │
                  │ night, loop forever  │
                  └──────────────────────┘
```

---

## 5. What The Agent Actually Sees

This is the most important section. The above is the engineer's view. The agent's view is much narrower.

### Every turn, the agent gets:
1. Its SOUL.md identity + USER.md profile + tool docs (system prompt body).
2. `**Current date/time: <localized string>**` plus a short instruction telling it to use this to judge context freshness. *Refreshed on every turn.*
3. The fresh tail (last 24–80 messages, depending on model).
4. *Sometimes* a compaction divider line if compaction just fired (throttled to one every 10 min).

### Only at session start, the agent additionally gets:
- Morning briefing
- Pinned vault entries + `session_context`-tagged entries
- Top-level summaries
- Active tracker tasks
- Continuity brief (if `continuityBriefValidUntilTurn > currentTurn`)
- Scratchpad
- Active user directive

### The agent does NOT get:
- A token count or context utilization percentage.
- A "you have ~N turns until compaction" hint.
- A list of vault entries it owns or could query.
- An indication that older tool results were stubbed.
- An indication that summaries were scrubbed of technique content.
- A signal that the continuity brief is about to expire (turn N of 3).

### Tools the agent has for its own memory:
| Tool | Reaches into | Notes |
|---|---|---|
| `recall_recent_thread` | messages | Clean transcript of recent turns. As of v2.7.10, no longer auto-fires post-compaction; description now actively discourages over-use. |
| `memory_grep` | messages + summaries (FTS5) | Self-echo filter (v2.7.8) drops the agent's own `[{"type":"tool_use",...}]` JSON from results. |
| `memory_describe` | any single message / summary / large file by ID | The "expand a stub" tool. |
| `memory_expand` | summary DAG | Walks the DAG and calls a model to synthesize an answer. Up to 100K input tokens. |
| `vault_remember` / `vault_search` / `vault_expand` / `vault_forget` / `vault_update` | vault_entries | Knowledge-store CRUD. The agent CAN promote its own entries to `is_permanent=true`. |

---

## 6. Pitfalls

These are real, observed weaknesses, not theoretical concerns. They are listed roughly in order of impact.

### 6.1 The agent has no proprioception
The most consequential gap. The engine knows everything (token budget, time to compaction, summary count, vault size). The agent knows nothing. So:
- The agent cannot decide "I should save this to vault before compaction eats it."
- The agent cannot decide "I should drop my exploration scope, I'm at 90%."
- The agent cannot tell whether the summary it just read is fresh or 47 compactions old.
- The agent cannot tell when it is reading paraphrased content vs. verbatim content (e.g., scrubbed technique bodies).

This is why the v2.7.2 → v2.7.10 spiral happened. The engine tried to be helpful by *secretly* re-injecting history. When that failed, we removed the secret help — but we did not give the agent visibility into the underlying problem. So the agent is now better behaved but *less informed*.

### 6.2 Token estimation is `text.length / 4`
`store.ts:18`. Crude. Code and JSON tokenize denser than English; the heuristic underestimates by 5–15% on tool-heavy turns. The compaction gate fires later than intended on tool-heavy work, which means we routinely run right up against the model's hard limit before compacting.

### 6.3 Fresh tail size is static per context window
`assembler.ts:144–149`. 200K-context models always get 80 messages of fresh tail regardless of whether each message is 50 tokens or 10K tokens. A long tool-result-heavy stretch can put the fresh tail at 30K+ tokens; a chatty stretch can put it at 5K. The downstream effect is wildly inconsistent compaction frequency.

### 6.4 Continuity brief reading is not enforced
The brief is generated, stored, and injected for 3 turns. There is no signal back to the engine that the agent actually read it. If the agent ignores it and acts from fresh tail alone, the brief is wasted and the bug we are trying to prevent (lost context) recurs silently.

### 6.5 Vault entry lifecycle is invisible to the writer
When an agent calls `vault_remember(content=X)`, it gets back an entry ID and that's it. It does not know the engine's decay schedule, does not know that "never retrieved in 30 days → -0.1 confidence", does not know that confidence < 0.1 means permanent deletion. So agents create entries that quietly evaporate. Worse — when the agent re-reads an old vault entry via `vault_search`, the result does not include freshness metadata, so the agent cannot tell if a piece of information is current or 7 months stale.

### 6.6 Vault writes have no de-duplication
Two different agents (or one agent twice) can write `"David's wife is Crystal"` and `"User's wife: Crystal"` as separate vault entries. The Dreamer does not de-dupe across runs. Over months, the vault accumulates near-duplicates that share retrieval count, splitting confidence between siblings.

### 6.7 The Dreamer is a single point of failure
If the Dreamer is misconfigured, the model is wrong, the night is short, or anything errors during preprocessing, `vault_conversations` stack up. No backpressure, no alert, no fallback path. The vault simply stops growing.

### 6.8 Summary DAG depth cap = 1
`DEFAULTS.incrementalMaxDepth = 1`. Designed to prevent compaction from blocking the loop for too long. Side effect: a long-running agent accumulates many top-level summaries that *cannot* be condensed beyond a single level per compaction. After weeks, an agent can have 30+ top-level summaries injected at session start, eating context before the first turn even runs.

### 6.9 No advance warning of compaction
The agent sees the compaction divider *after* compaction. By then the assembled context has already changed, and the agent has no warning to wrap up cleanly, save state, or compress its own work-in-progress.

### 6.10 Session-start scaffolding only fires once per session
This is by design — but "session" is a fuzzy concept (a session boundary is created by an explicit reset). Long-lived agents (Kevin, scheduled-task agents) run for days without a session reset, so they never re-load pinned vault entries even after the user adds new ones. New pinned entries only appear after the next manual session boundary.

### 6.11 Technique scrubbing happens in two places
`compaction.ts:scrubTechniqueContentForSummary` and `assembler.ts:scrubSummariesAgainstFreshTechniques`. The two stages have slightly different rules and could drift out of sync. Currently working, but fragile.

### 6.12 `recall_recent_thread` is a footgun in disguise
Now that auto-fire is removed, the tool is safer — but a confused agent can still call it with large parameters and reintroduce the spiral manually. There is no per-turn cost cap on how many tokens of recall the agent can inject into its own context.

---

## 7. Recommended Corrections

Ordered by leverage, not effort. Each one is concrete; none are speculative.

### 7.1 Give the agent a "context vitals" header (highest leverage)
Inject a small block (~80 tokens) at the top of every turn:

```
**Context vitals**
Window: 200K   Used: 142K (71%)   Until compaction: ~28K tokens / ~12 turns
Fresh tail: 64 msgs   Top-level summaries: 4
Vault: 87 entries (12 pinned, 6 permanent)
Continuity brief: active (2 turns remaining)
```

This single change addresses pitfall 6.1, 6.4, 6.5, and 6.9. The agent gains proprioception. Cost is negligible compared to the bugs it prevents.

### 7.2 Replace `text.length / 4` with real tokenization
Tokenize per-provider (Anthropic, OpenAI, etc.) using their published tokenizer. Cache by message ID. Removes 6.2 and makes the vitals block above truthful.

### 7.3 Make fresh tail token-budgeted, not count-budgeted
Replace "last 80 messages" with "last N messages that fit in 30% of the window, oldest dropped first." Solves 6.3 and stabilizes compaction frequency.

### 7.4 Add a brief-read confirmation
When the continuity brief is rendered, mark it visibly with a sentinel and have the agent emit `brief_acknowledged()` as a no-op tool. If the next turn does not call it, the engine refuses non-trivial tool calls until it does. Mirrors the technique-ack gate, which we already proved works.

### 7.5 Add freshness metadata to `vault_search` results
Each hit returns:
```
[id: vlt_xxx | confidence: 0.6 | retrieved 3× | last seen 12d ago | created 47d ago]
```
Addresses 6.5. Also lets the agent prefer recent entries when answering "what's current."

### 7.6 De-dupe vault entries on write
On `vault_remember`, embed the content and compare cosine similarity against existing entries. If > 0.92, merge into existing (bump retrieval count, append source). Addresses 6.6. Already have `embeddings.ts` and `vector-search.ts`.

### 7.7 Promote durable summaries automatically
After a top-level summary has survived 3 compaction cycles AND been retrieved ≥ 3 times via `memory_expand`, mark it `durable=1`. Durable summaries are exempted from re-condensation and may even be promoted into vault entries. Addresses 6.8.

### 7.8 Refresh session-start scaffolding on a daily heartbeat
Even without a session reset, re-load pinned vault entries every 24 hours of wall clock time. Detected via a `last_scaffolding_refresh_at` field on the agent. Addresses 6.10.

### 7.9 Compaction forecast pre-warning
At 85% utilization, inject a one-line nudge (NOT a synthetic system message — a flag on the assistant's context vitals header): `"⚠ approaching compaction — close out current step or save state to vault soon."` Addresses 6.9 without re-introducing the v2.7.2 spiral, because it adds no message content.

### 7.10 Cap `recall_recent_thread` per turn
Per-turn budget: agent may not call recall_recent_thread more than once, and the result is capped at 8K tokens regardless of options. Addresses 6.12. Hard cap is cheaper than trying to talk the agent out of misuse in the tool description.

### 7.11 Dreamer health visibility
A small dashboard widget: "Vault: 412 entries, 17 unprocessed conversations (oldest 3d), last Dreamer run: 4h ago (success)". And: if `unprocessed_count > 50` for >24h, emit an iMessage alert via the watchdog. Addresses 6.7.

### 7.12 Unified `memory_audit()` tool
A single tool the agent can call to dump its own memory state:
```
fresh tail: 64 msgs (142K tokens, 71% of 200K window)
top-level summaries: 4 (oldest 8d, latest 3h)
durable summaries: 1
vault entries owned: 47 (3 pinned, 1 permanent)
last compaction: 2h 14m ago
last Dreamer run: 6h ago
```
This makes 7.1's vitals self-discoverable on demand and gives the agent a way to *reason about its own memory* during a hard problem.

---

## 8. Suggested Order of Operations

If we do nothing else, do these three in this order. They are independently valuable and each unlocks the next.

1. **§7.2 (real tokenization)** — prerequisite for any honest vitals reporting. ~1 day. No agent-visible change yet.
2. **§7.1 (context vitals header)** — agent-visible. Pair with §7.9 (forecast warning) since they share the same injection point. ~1 day. Immediate uplift on long-running agent reliability.
3. **§7.5 (vault freshness metadata)** — agent-visible. ~½ day. Big quality improvement on vault recall.

The remaining items are valuable but not blocking. Pick from them as specific bugs surface.

---

## 9. Notes On What We Should NOT Change

- **The three-store design.** Messages / DAG / vault each serve a clear purpose. Don't merge.
- **The 10-minute throttle on the compaction divider.** Without it, busy compaction days would spam the user with dividers.
- **The decision to make `recall_recent_thread` agent-initiated only.** Auto-fire was the v2.7.2 disaster. Keep it manual.
- **`is_permanent` exemption from decay.** This is the user's escape hatch for vault entries that must never decay (passwords, names, addresses).
- **Service-agent archive skip.** Dreamer/Trainer/Healer/PM/Imaginer conversations are pure platform mechanics. Archiving them would be recursive token burn.

---

*End of document.*
