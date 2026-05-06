# v2 Behavior Preservation Checklist

> Source: `DOJO Overhaul/DOJO-V2-IMPLEMENTATION-PLAN.md` Part XIX.
> Purpose: every v1-visible behavior listed here MUST work identically (or
> better) in v2. Phase 8 dev validation walks this top-to-bottom.

## User-visible behaviors

- [ ] **Streaming chat responses** — TRUE streaming via direct `onChunk` broadcast (UX improvement; v1 buffered chunks until model finished)
- [ ] **`complete_task` exits agent loop** — `postCallClassify` detects and sets `phase = 'done'`
- [ ] **`image_create` exits loop (fire-and-forget)** — `postCallClassify` detects and sets `phase = 'done'`
- [ ] **XML-fallback tool parsing** — synthetic `text_tool_*` IDs collapse to plain text instead of structured tool_use blocks
- [ ] **Empty-messages guard** — `assembleContext` returns cleanly without calling model when `messages.length === 0`
- [ ] **User attachment block injection** — `injectAttachmentBlocks()` called in assemble phase
- [ ] **`show_to_user` attachment draining** — `drainPendingAttachments` after assistant message persists
- [ ] **Cost recording per model call** — `recordCost()` after each successful `callModel`
- [ ] **Embedding queueing for assistant text** — `queueEmbedding('message', ...)` for assistant text responses
- [ ] **Status heartbeat for dashboard reconnects** — `startStatusHeartbeat` at start, `stopStatusHeartbeat` at finalize/exception paths
- [ ] **Stop button** — `stoppedAgents` Set + `activeAbortControllers` Map + `stopMarkerPending` flag
- [ ] **Preempt for urgent wakeup** — `preemptedAgents` Set, abort controller pattern, clean run-end
- [ ] **`pendingNudge` in-memory injection** — `state.pendingNudge`, prepended as synthetic user msg, never DB-persisted
- [ ] **Auto-continuation when MAX_TOOL_LOOPS hits with progress** — replaced by `progressClassifier` decision
- [ ] **Turn time budget auto-continuation** — `turnContinuationCounts` Map preserved
- [ ] **Recoverable provider 4xx in-loop recovery** — moved to `agent/v2/classifiers/provider.ts`
- [ ] **Dreamer special-case context overflow** — Dreamer-specific branch in error cascade
- [ ] **Rate-limit retry state machine** — `rate-limit-retry.ts` UNTOUCHED
- [ ] **Error loop detection** — `errors.ts:recordError` called on surrender
- [ ] **Healer notification with grace period** — `healer/injury-recovery.ts:onAgentInjured` called on surrender
- [ ] **`notifyPrimaryOfInjury`** — preserved as v2 method
- [ ] **iMessage routing** — `triggeredByIMessage` + `imFlagSetAtRunStart` snapshot pattern
- [ ] **Presence-away iMessage forwarding** — `maybeForwardToImessage` when presence is `away`
- [ ] **Engine ack on iMessage-triggered turns** — engine inserts ack to dashboard ONLY, never via iMessage
- [ ] **`[BLOCKED]` content prefix for permission denials** — preserved with `consecutivePermissionDenials` counter
- [ ] **Loop break with canonical tool signature** — moved to `agent/v2/classifiers/loop.ts`
- [ ] **Repetition detection** — subsumed by `loopDetector`
- [ ] **No-results detection** — subsumed by `progressClassifier`
- [ ] **Inter-agent silence on text after `send_to_agent`** — preserved in `postCallClassify`
- [ ] **Missed A2A reply nudge** — subsumed by `a2aReplyEnforcer` classifier
- [ ] **Stop marker injection on next turn** — `assembler.ts` UNTOUCHED, same `stopMarkerPending` config flag
- [ ] **Stuck agent recovery** — `recoverStuckAgents` periodic check UNTOUCHED

## Dashboard / WebSocket events

- [ ] `chat:message` — every message persistence broadcasts
- [ ] `chat:chunk` (with `done: false/true`) — streaming text chunks (TRUE streaming)
- [ ] `chat:chunk_cancelled` (NEW) — mid-stream error
- [ ] `chat:tool_call` — before each tool execution
- [ ] `chat:tool_result` — after each tool execution
- [ ] `chat:error` — on error or paused agent
- [ ] `chat:warning` (NEW) — 90% WARN events from compaction gate
- [ ] `agent:status` — on status change (idle, working, paused, error, terminated, rate_limited)
- [ ] `memory:compaction` — when compaction fires (rare in v2)

## Tools

- [ ] All 71 tool names from v1 still callable in v2
- [ ] No tool removed except `large-files.ts` interception path (deletes nothing the agent calls directly)

## Module-level state

- [ ] `activeRuns: Set<string>`
- [ ] `pendingWakeups: Set<string>`
- [ ] `stoppedAgents: Set<string>`
- [ ] `preemptedAgents: Set<string>`
- [ ] `activeAbortControllers: Map<string, AbortController>`
- [ ] `agentStartTimes: Map<string, number>`
- [ ] `turnBoundary: Map<string, string>` (already in `turn-state.ts`)
- [ ] `turnContinuationCounts: Map<string, number>`
- [ ] `recoveryRunStreak` — moved to per-turn `state.recoveryStreak` (intentional change per Part VIII)
- [ ] `statusHeartbeats: Map<string, Timer>`
- [ ] `toolsUnavailableNotified: Set<string>`
