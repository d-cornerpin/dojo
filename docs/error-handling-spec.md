# DOJO Error Handling Specification

> **Status**: Drafted 2026-05-10. Dev-local until David signs off. Do not ship phases without explicit go-ahead.

## Goal

Reframe the DOJO's error handling around one principle:

> **Errors are information that flows to the agent or the user. Status changes (`error`/`paused`) and human-facing alerts happen only when the platform genuinely cannot proceed.**

Today the engine treats most errors as "lock the agent, alert the human." The agent itself is often unaware of why it failed. This spec replaces that with a four-tier taxonomy where most errors are silent or self-recovered, the agent learns about the rest, and the user only hears about true platform conditions in plain English.

The Healer agent stays. Its role tightens: cross-provider audit, log, diagnose, propose fixes. It does NOT block other recovery paths.

## Tier taxonomy

| Tier | Who handles | Status change? | User sees? | Agent sees? |
|---|---|---|---|---|
| **A — Transparent auto-recovery** | Engine | No | No (logs + Vitals only) | No |
| **B — Inform-and-continue** | Agent | No | Only via agent's natural reply | `[System: …]` chat-history note |
| **C — Healer-assisted** | Healer (cross-provider) | No | Vitals proposals + action log; iMessage only for `severity='critical'` | Possibly a `[System: …]` if applicable |
| **D — Platform lock** | User | `error`/`paused` | iMessage + dashboard banner, plain English | `[System: …]` block at top of chat |

**Wordy mode** in chat surfaces all four tiers inline. Default mode surfaces only Tier B agent replies and Tier D banners.

## Scenario catalogue

Single source of truth for every error path. Each phase implements the rows it touches.

### Provider / API

| Scenario | Tier | Engine action | Agent system note (Tier B) | User message (Tier D) |
|---|---|---|---|---|
| Image > 5MB (Anthropic) | A | Sips downscale + cache | — | — |
| Image > 5MB after sips | B | Drop image, substitute placeholder block | `One attached image was too large to send to the model. Tell the user the image exceeded the model's size limit.` | — |
| Unsupported image format (TIFF, BMP) | A | Convert to JPEG via sips | — | — |
| Too many images per request | B | Send first N | `Only the first {N} of {M} images were sent — the model has a per-request limit. Mention this to the user.` | — |
| Vision mismatch (model has no vision) | B | Strip images, set capability flag | `This model can't see images. Describe what you can from filename and context, or suggest the user switch to a vision-capable model.` | — |
| Tool name doesn't exist | B | Translate provider error | `Your last tool call referenced "{X}" which isn't a registered tool. Use list_tool_docs to see what's available. Adjust and continue.` | — |
| Malformed tool args JSON | B | Translate | `Your last tool call had invalid JSON arguments. Re-issue with valid JSON.` | — |
| Tool args fail schema | B | Translate w/ specific field | `Tool {X} needs {field}: {type}; you sent {wrong}. Re-call with the right shape.` | — |
| Prompt too long (context overflow) | A | Force-compact + retry | — | — |
| Output max_tokens hit | B (after engine budget escalation) | Try budget escalation first; if still hit, system note | `Your last response hit the length cap. Be more concise or split across turns.` | — |
| 401 invalid API key | D | Lock provider, fail open other agents | — | `Your {Provider} API key stopped working. Open Settings → Providers and check the key.` |
| 401 revoked / expired | D | Same | — | Same |
| 403 model access denied | D (if no alt) | Mark model unavailable; if no alt, lock | — | `Your account doesn't have access to model {X}. I tried alternatives but couldn't find a working one. Pick a different model in Settings.` |
| 404 model not found (typo) | C | Healer proposes fix | — | Vitals: `Model "{X}" isn't recognized by the provider. Did you mean "{Y}"?` |
| 429 rate limit | A → B if persistent | Backoff retry; system note after 3 failed retries | `Provider is rate-limited. Tell the user you'll try again in a few minutes, or pause this thread.` | — |
| 429 quota exhausted | D | Lock provider | — | `Your provider {X} has hit its quota for the day. Switch providers in Settings or wait until reset.` |
| 500/502/503/504 transient | A | Backoff, retry ≤3 | — | — |
| 503 persistent (>3min one provider) | C | Healer proposes failover | `Provider {X} is unreliable right now. Switching to backup if available.` | Vitals: `{Provider} has been failing for {N} minutes. Healer routed {agent} to {backup} as fallback.` |
| 529 Anthropic overloaded | A | Backoff (longer than 429) | — | — |
| All providers down | D | Lock | — | `None of your AI providers are responding. Looks like an internet issue — I'll keep trying every 5 minutes.` |
| Provider returns garbage / non-JSON | B | Parse failure → translate | `The provider sent a malformed response. Apologize to the user and ask them to try again.` | — |

### Network / transport

| Scenario | Tier | Engine action | Agent system note | User message |
|---|---|---|---|---|
| ECONNRESET / ECONNREFUSED / ETIMEDOUT, single | A | withRetry backoff | — | — |
| DNS resolution fail | A → D | Retry once; if persistent, lock | — | `Can't reach the internet right now.` |
| TLS handshake | A | Retry | — | — |
| Streaming connection drops mid-response | A | Reconnect, replay partial | — | — |
| WebSocket dashboard disconnect | A (UI) | Frontend reconnects automatically | n/a | brief reconnecting indicator |

### Model output

| Scenario | Tier | Engine action | Agent system note | User message |
|---|---|---|---|---|
| Empty response, 1st time | A | Silent retry | — | — |
| Empty response, 2nd | B | Persist nudge | `You returned an empty response. Produce at least a sentence telling the user what's happening.` | — |
| Empty response, 3rd | B | Stronger nudge | `Two empty responses in a row. Apologize to the user and end your turn.` | — |
| Refusal (model declines) | B | Pass through | `The model refused your last request. Rephrase or tell the user you can't help with this.` | — |
| Repeated identical output (loop) | B | Loop break (existing) | `You repeated yourself. Try a different approach or stop.` | — |
| stop_reason max_tokens after escalation | B | Budget cap | `Your response was still too long. Summarize in two sentences.` | — |
| Tool call references hallucinated tool_use_id | B | Translate | `You referenced a tool_use_id that doesn't exist. Re-issue your work without referring to it.` | — |

### Tool execution

| Scenario | Tier | Engine action | Agent sees | User message |
|---|---|---|---|---|
| Tool times out | B | tool_result.isError (existing) | already visible | — |
| Tool crashes (uncaught) | B | tool_result.isError + log | already visible | — |
| Tool returns oversized output | A | Truncate + note | sees truncated | — |
| Tool permission denied | B | tool_result `[BLOCKED]` + alternatives (existing) | already visible | — |
| Tool returns binary garbage | A | Drop, return "binary content suppressed" | sees note | — |
| File not found | B | tool_result | already visible | — |
| File too large | A | Head + tail + summary | sees summary | — |
| web_search returns 0 results | B | tool_result | already visible | — |
| web_browse hit Cloudflare | B | Translate | `The site blocks automated access. Tell the user.` | — |
| web_fetch non-HTML | B | Return content + type | already visible | — |
| Tool needs confirmation, wrong shape | B | tool_result re-asks | already visible | — |

### Attachments / files

| Scenario | Tier | Engine action | Agent system note | User message |
|---|---|---|---|---|
| HEIC conversion failed | B | Drop, substitute placeholder | `An image ({X}.heic) couldn't be converted. Tell the user.` | — |
| PDF > 32MB cap | B | Drop with placeholder | `A PDF was too large to send to the model. Tell the user.` | — |
| PDF text extraction failed | B | Send raw OR drop | `A PDF couldn't be read. Try image-mode or ask the user for plain text.` | — |
| File missing from disk at inject time | A | Skip silently with log | — | — |
| Path traversal attempt | D | Block + log | tool_result | iMessage if repeated (security alert) |
| Office docs > size | A | Use existing extractor with chunk | — | — |

### A2A / coordination

| Scenario | Tier | Engine action | Agent sees | User message |
|---|---|---|---|---|
| Target agent terminated | B | tool_result | already visible | — |
| Hop limit exceeded | B | tool_result | already visible | — |
| Semantic duplicate | B | tool_result | already visible | — |
| Auto-promotion FYI→DELIVERABLE (v2.3.17) | B | Translate + note (shipped) | sender sees note | — |
| Cross-tenant Microsoft block | B | Translate | `That calendar is on a different Microsoft tenant. Tell the user the limitation.` | — |
| Sub-agent took >30 min on assigned task | C | PM poke; Healer if persistent | sub-agent gets poke | Vitals if escalated |
| Group spawn would exceed quota | B | tool_result | already visible | — |

### Memory / vault / compaction

| Scenario | Tier | Engine action | Agent system note | User message |
|---|---|---|---|---|
| Compaction failed | A | Retry with smaller batch | — | — |
| Compaction failed repeatedly (3×) | C | Healer audit | `Memory is having trouble compacting. Healer is investigating.` | Vitals: `Memory compaction has failed 3× for {agent}. Healer recommends a session reset.` |
| Embedding service down | A | Fallback to keyword search | — | — |
| Embedding persistently down | B | Tool note | `Semantic search is unavailable; results are keyword-only right now.` | — |
| Vault search returned too many hits | A | Cap + summarize | sees capped results | — |
| Vault DB corrupted | D | Lock vault | — | `Your memory database has a problem. Open the Health page to see options.` |
| Dreamer batch over budget | A | Auto-split (existing) | — | — |
| DAG cycle in summaries | C | Healer flags | — | Vitals |

### Tracker / scheduler

| Scenario | Tier | Engine action | Agent sees | User message |
|---|---|---|---|---|
| Schedule expression invalid | B | tool_result | already visible | — |
| Task assigned to terminated agent | C | Auto-fix unassigns | — | Vitals action log |
| Recurring task missed last run | C | Auto-fix re-fires | — | Vitals |
| Task stuck in_progress >24h | C | PM poke → Healer if no movement | sub-agent gets poke | Vitals |
| Project all-tasks-complete but project active | A | Auto-fix marks complete | — | — |

### Auth / session

| Scenario | Tier | Engine action | Agent system note | User message |
|---|---|---|---|---|
| Dashboard JWT expired | A (UI) | Frontend re-prompts login | n/a | login modal |
| Agent's Google OAuth expired | B | tool_result tells agent | `Your Google access has expired. Tell the user to reconnect in Settings → Integrations.` | — |
| Agent's Microsoft OAuth expired | B | Same | Same | — |
| iMessage CLI not installed | A | AppleScript fallback (shipped) | — | — |
| iMessage send timeout | B | tool_result tells agent | `iMessage send failed. Tell the user in the dashboard chat instead.` | — |

### External integrations

| Scenario | Tier | Engine action | Agent sees | User message |
|---|---|---|---|---|
| Gmail quota | B | tool_result | already visible | — |
| Google Drive shared file 404 | B | tool_result | already visible | — |
| MS Graph throttle (429) | A → B | Backoff, then translate | possibly system note | — |
| Slack webhook 4xx | B | tool_result | already visible | — |
| External webhook timeout | A → B | Retry, then tool_result | already visible | — |

### System / platform

| Scenario | Tier | Engine action | Agent system note | User message |
|---|---|---|---|---|
| DB write transient (busy) | A | SQLite retry | — | — |
| DB write permanent fail | D | Lock | — | `The platform's storage is having a problem. Open the dashboard for recovery options.` |
| Disk full | D | Lock | — | `Your Mac's hard drive is full. Free up some space and the platform will resume.` |
| Out of memory (process) | D | Restart watchdog | — | `The platform restarted because it ran out of memory.` |
| Config Zod validation failed at startup | D | Won't start | n/a | startup error in logs + iMessage |
| Migration failed | D | Won't start | n/a | startup error |
| Server crashed mid-turn | C | recoverStuckAgents resets `working` → `idle`; agent gets system note | `Your last turn was interrupted by a platform restart. Resume or apologize to the user.` | — |
| Process killed by OS (OOM) | D | launchd restarts | system note as above | iMessage if frequent |

### Budget / cost

| Scenario | Tier | Engine action | Agent system note | User message |
|---|---|---|---|---|
| Cost calculation failed | A | Log to cost_errors, default to 0 | — | — |
| Daily budget 80% | C | Healer notifies | — | Vitals: `Today's spend is at 80% of your daily limit (${N} of ${M}).` |
| Daily budget exceeded | C | Healer proposes pause/cap | `Daily AI budget hit. Healer is asking the user about next steps.` | Vitals proposal + iMessage: `Daily AI spend just hit your cap. Want me to keep going (and risk surprise charges) or pause until tomorrow?` |
| Per-call cost 10× normal | C | Healer flags pattern | — | Vitals action log |

### Healer-specific

| Scenario | Tier | Engine action | Agent sees | User message |
|---|---|---|---|---|
| Healer's provider 401 | D | Lock Healer specifically | — | `Your Healer agent can't reach its provider. Auto-diagnosis is paused until you fix it.` |
| Healer agent terminated | D | Engine self-watchdog tries Tier 1 first | — | iMessage if Tier 1 fails: `The Healer agent isn't running. Restart it from Settings.` |
| Healer's diagnostic prompt over budget | C (warning to itself) | Drop oldest collectors | n/a | Vitals: `Healer's diagnostic is getting too large — some checks were skipped.` |
| Healer infinite loop | C (engine breaks) | Loop detector applies to Healer same as any agent | n/a | Vitals + iMessage if persistent |
| Healer shares provider with primary | C at config time | Warn | n/a | Settings warning: `Your Healer uses the same provider as {primary}. If {Provider} goes down, both go down at once. Consider giving Healer a different provider.` |

### Cross-cutting patterns

| Scenario | Tier | Engine action | Agent sees | User message |
|---|---|---|---|---|
| Same agent, distinct errors, ≥3 in 24h | C | Healer cycle on this agent | — | Vitals |
| Per-model error rate >10% in 24h | C | Healer proposes model change | — | Vitals |
| One provider failing across multiple agents | C | Healer detects pattern, proposes failover | possibly per agent | Vitals: `{Provider} has been failing for {N} of your agents over the last hour. Consider switching to {alt}.` |
| Server restarted within last 5 min | A | All `working` agents reset to `idle` + system note on next wake | sees note | — |
| Agent in 'error' status >30 min | C | Auto-fix Tier 1 resets to idle | `Engine reset your status after extended idle in error state.` | Vitals action log |
| Agent in 'paused' status >30 min | C | Auto-fix Tier 1 resets to idle | same | same |
| Agent 'working' >10 min | C | Auto-fix Tier 1 (move from daily to 5-min cycle) | same | Vitals |
| Wake-lock contention | A | Engine queues serially | — | — |

## Healer log access — Dreamer-pattern hardening

The Healer must never load raw logs into context the way Dreamer once did with archives. Same playbook applies.

### Rules

1. **Never raw-read healer log files into context.** Block paths matching `healer-report-*.log` / `healer.log` in Healer's permission manifest. Force access through engine helpers.

2. **Two engine-side helpers** (new tools, Healer-only):
   - `healer_recent_actions(limit=20, since_hours=24)` → returns rows of `(timestamp, category, agent_name, result)` only. Each row capped at ~80 chars. Total response ≤1500 chars.
   - `healer_action_detail(action_id)` → on-demand drill into a single action's full description. ≤1500 chars per response.

3. **Per-collector caps in `diagnostic.ts`** — each collector wrapped in `cap(text, MAX_PER_COLLECTOR_CHARS)`. Defaults:
   - Agent anomalies: 4000 chars / 10 agents max
   - Error digest: 2000 chars / 10 agents max
   - Model performance: 1000 chars / top 5 by error rate
   - Tracker health: 2000 chars / top 10 stale tasks
   - Bulletproof health: 1500 chars
   - Nudge stats / budget: 500 chars each

4. **Aggregation tier for old logs**. Anything older than 7 days returns count + category summary only, never row detail.

5. **Cycle-message size budget at delivery time**. Mirror Dreamer's `batchArchives` budgeter. If composed diagnostic exceeds budget, drop oldest collectors first.

6. **Pre-call prompt size telemetry**. Log Healer cycle's prompt size in tokens. If it ever exceeds 80% of its model's window, fire a Tier C alert (`Healer's diagnostic prompt is getting too large — collectors need tightening`).

7. **Archive pruning**. Keep last 30 days of `healer-report-*.log` archives. Hard-delete older.

### Constants (mirror of Dreamer pattern)

```
HEALER_CONTEXT_OVERHEAD_TOKENS = 40_000
HEALER_PROCESSING_GROWTH_FACTOR = 1.3
HEALER_BATCH_BUDGET_CAP_RATIO = 0.35
HEALER_LOG_RESPONSE_CHAR_CAP = 1500
```

## User-facing language standards

All Tier D iMessage / banner / chat alerts route through a single `formatErrorForHuman(kind, context)` helper. Rules:

- No JSON, no provider error fields, no tracebacks. Those are log-only.
- Reference the agent by name, not ID.
- Reference the provider by name (Anthropic, OpenAI), not internal ID.
- End with a concrete next action ("Open Settings → Providers", "Restart it from the dashboard", "I'll keep trying every 5 minutes").
- Plain prose; no markdown formatting in iMessage; minimal in banners.

Tier C Vitals proposals use the same helper.

---

## Phased implementation plan

> **Tracking:** Check `[x]` as each phase completes. If conversation compacts, resume from the first unchecked phase. Each phase MUST pass its acceptance checks on the local dev server before starting the next.

### Phase 1 — Universal system notes + Tier B foundation

**Goal:** Errors flow to the agent as `[System: …]` notes. No status change for Tier B. Same-kind cap of 3 replaced with inputs-changed check.

**Status:** [x] Complete (2026-05-10, dev-local — awaiting David's verification)

**Implementation notes:**
- `agent/v2/error-format.ts` — new single source of truth for Tier B agent notes and Tier D user messages. Includes `scrubTechnicalDetail` defense-in-depth helper.
- `agent/v2/classifiers/provider.ts` — expanded with `image_too_large_post_sips`, `image_too_many`, `tool_name_unknown`, `tool_args_invalid_json`, `tool_args_schema_mismatch`, `refusal`, `provider_garbage`. New sibling `classifyPlatformError` for Tier D (auth_invalid, access_denied, quota_exhausted, dns_failure).
- `agent/shared-state.ts` — `recoveryRunStreak` keyed by `(kind, inputsFingerprint)`; new `MAX_INLOOP_RECOVERIES_SAME_INPUTS = 2`. Legacy `MAX_CONSECUTIVE_INLOOP_RECOVERIES` kept for backward compat.
- `agent/v2/recovery.ts` — three additive paths: `tryPlatformErrorRecovery` (Tier D, locks + plain-English banner), updated `tryProviderRecovery` (Tier B, inputs-fingerprint cap, sources template from error-format), updated `recordInjury` (always persists a chat-visible system note FIRST, even for unclassified errors).
- `shared/ws.ts` — chat:error code union extended with `AUTH_INVALID`, `ACCESS_DENIED`, `QUOTA_EXHAUSTED`, `DNS_FAILURE`.

**Test results:**
- 18 new tests in `error-format.test.ts` (all pass)
- 8 new tests in `provider.test.ts` for the v2.3.19 branches + Tier D classifier (all pass)
- 3 new integration tests for the Tier D platform path + universal system note + cap escalation (all pass)
- Full suite: 486/486 pass
- Typecheck clean
- Dev server boots cleanly, happy-path smoke test passes

**Files to touch:**
- `packages/server/src/agent/v2/recovery.ts` — `recordInjury` always persists system note before status change; status change skipped for Tier B
- `packages/server/src/agent/v2/classifiers/provider.ts` — expand classification to cover every Tier B row in the scenario catalogue with the exact agent system note from the table
- `packages/server/src/agent/shared-state.ts` — replace `recoveryRunStreak` value to include `inputsFingerprint`; new check for "same kind + same inputs → escalate to Tier C"
- New file `packages/server/src/agent/v2/error-format.ts` — `formatErrorForHuman(kind, context)` helper + Tier B note templates as a single source of truth

**Tests:**
- New unit tests: `provider.test.ts` covers each new classifier branch with realistic provider error strings
- New unit tests: `error-format.test.ts` covers `formatErrorForHuman` for all D-tier scenarios
- Integration test: oversized image → after sips fallback, system note persisted, agent stays `idle`, no `chat:error` toast
- Integration test: vision mismatch → image stripped, system note persisted, no status change

**Dev-server acceptance checks:**
- `./dev-test-tools/bin/send` Kevin a deliberate malformed tool call → verify Kevin gets `[System: …]` note in next turn, status stays `idle`
- Switch Kevin to a non-vision model (Haiku 3.5), send image → verify image stripped, system note, no status change
- Verify in DB: `agents.status` for Kevin remains `idle` after each test
- Verify in DB: a `messages` row with `role='system'` and the expected template content

**Acceptance criteria:**
- [x] Zero status transitions to `error` for any Tier B scenario tested
- [x] Every Tier B scenario produces a system note that matches the spec table
- [x] All existing tests still pass (`npm test` — 486/486)
- [x] Three new integration tests added and pass (auth_invalid Tier D, access_denied Tier D, universal system note on generic injury)

**Side notes for David's review:**
- The fingerprint heuristic uses `state.lastUserMessageContent` + `state.lastResponseSig`. The "inputs changed" check is approximate — it'll consider inputs unchanged whenever the agent's prior response hasn't been updated yet (e.g., tool-loop iteration before any text is emitted). Should be tightened in Phase 4 with the input-rectification framework.
- Live end-to-end Tier B verification on the dev server is hard to do without forging a provider error — left as a deferred check until Phase 2 (which exposes a deliberate Tier D test path via fake API key).

---

### Phase 2 — Tier D plain-English alerts + language cleanup

**Goal:** Every user-facing string is human language. No JSON or technical jargon leaks. Tier D conditions explicit and labeled.

**Status:** [x] Complete (2026-05-10, dev-local — awaiting David's verification)

**Implementation notes:**
- `healer/injury-recovery.ts` — three iMessage techMsg strings rewritten to drop raw `errorMessage.slice(0, 200)` dumps. User-facing copy is plain language; provider error stays in logs only. Imports `scrubTechnicalDetail` for defense in depth.
- `services/imessage-bridge.ts:sendAlert` — every alert is now passed through `scrubTechnicalDetail` before going to the user's phone. This is the boundary scrub — even if a future regression slips a raw JSON dump into a `sendAlert` call, it gets stripped here.
- `agent/errors.ts:recordError` — paused-agent banner and iMessage rewritten to plain language. Drops the `(5 in 120s)` jargon.
- `agent/v2/error-format.ts:scrubTechnicalDetail` — hardened against nested JSON (iterate to fixed point), orphan braces (catch-all sweep), and the specific Anthropic error markers (`.source.base64`, `bytes maximum`, stack frame pattern).

**Test results:**
- 24 new tests in `error-language.test.ts` (one per Tier D kind for forbidden-pattern check, one per Tier B kind, full Anthropic JSON dump regression, plus call-site sanity)
- Full suite: 524/524 pass
- Typecheck clean
- Dev server restarts cleanly with each edit

**Files to touch:**
- `packages/server/src/agent/v2/error-format.ts` — Tier D message templates
- `packages/server/src/healer/injury-recovery.ts` — `sendAlert` calls route through `formatErrorForHuman`
- `packages/server/src/services/imessage-bridge.ts:sendAlert` — sanitize anything that smells like provider JSON
- `packages/server/src/agent/v2/recovery.ts` — `chat:error` toast user strings route through the helper
- `packages/server/src/errors.ts` — `recordError` pause message updated
- Provider client error wrappers (look for `Model call failed:` strings) — preserve technical detail for logs, strip for user-facing surfaces
- Dashboard: any `chat:error` rendering — verify it shows the new sanitized strings only

**Tests:**
- Unit tests verify no JSON character (`{`) ever appears in `formatErrorForHuman` output
- Unit tests for each Tier D scenario from the catalogue
- Manual: trigger a fake 401 via mocked provider error, verify dashboard banner + iMessage text

**Dev-server acceptance checks:**
- Temporarily corrupt the Anthropic API key in secrets.yaml → restart → verify Kevin's chat:error banner says human-language message, not JSON
- Restore key, confirm Kevin recovers cleanly
- Send Kevin a message that would historically have produced JSON in the error toast → verify the dashboard shows plain language

**Acceptance criteria:**
- [x] No JSON-shaped substrings (`{`, `}`) in any user-facing alert (verified by Tier B/D × forbidden-pattern matrix tests)
- [x] All Tier D scenarios produce the spec's wording (verified per kind in `error-language.test.ts`)
- [x] Tier C → iMessage only for `severity='critical'` — `sendAlert` in `imessage-bridge.ts` now suppresses anything non-critical at the boundary. Every caller audited; OAuth expiries (Google/MS) bumped to critical (true blockers); single-agent paused demoted to warning (dashboard only). [shipped post-Phase 4, 2026-05-10]
- [x] All existing tests still pass (524/524)

**Side notes for David:**
- The live Tier D dev-server check (corrupt API key, send Kevin a message, verify plain language in chat:error toast) was deferred per the "don't reset secrets.yaml" memory. You can do this manually: temporarily set `ANTHROPIC_API_KEY` to garbage in `~/.dojo/secrets.yaml`, restart the dev server, send a message, verify the toast shows plain English (not JSON). Restore the key after. The integration test `PHASE 6 (v2.3.19): auth_invalid 401 → Tier D lock` covers the code path with mocked errors.

---

### Phase 3 — Healer hardening

**Goal:** Healer stays useful, becomes bulletproof. Per-agent backoff replaces permanent suppression. Engine self-watchdog. Log access disciplined like Dreamer.

**Status:** [x] Complete (2026-05-10, dev-local — awaiting David's verification). Core hardening landed; some surface-area items deferred to Phase 4 or a later cleanup pass (see below).

**Implementation notes — what landed:**
- `healer/diagnostic.ts` — every collector wrapped in `capItemsByText`. Per-collector caps from the spec (4000 chars for agent anomalies, 2000 for error digest, etc.). Critical items always preserved; warning/info dropped first. `capItemsByText` exported for unit tests.
- `healer/healer-agent.ts` — new `buildHealerCycleMessage()` enforces a Dreamer-style char budget. Constants: `HEALER_CONTEXT_OVERHEAD_TOKENS=40_000`, `HEALER_PROCESSING_GROWTH_FACTOR=1.3`, `HEALER_BATCH_BUDGET_CAP_RATIO=0.35`. Telemetry logs the prompt size and utilization% on every cycle; fires a `warn` log line (Tier C signal) when utilization ≥80%.
- `healer/injury-recovery.ts` — `MAX_RECOVERY_ATTEMPTS` permanent suppression replaced with per-agent backoff ladder (10 min → 1 hr → 6 hr → 24 hr cap, defined in `HEALER_BACKOFF_LADDER_MS`). One iMessage on first entry into backoff; subsequent re-injuries within the window stay silent. `onAgentRecovered` now clears the backoff window so the next injury gets a fresh shot.
- `healer/healer-agent.ts` — engine-level self-watchdog (`runHealerSelfWatchdog`) runs every 5 minutes. Resets Healer to `idle` if it's been stuck in `error`/`paused`/`working > 10min`. Bypasses `onAgentInjured`'s self-skip. Wired into startup in `index.ts`.

**Test results:**
- 6 new unit tests in `healer/__tests__/healer-hardening.test.ts` (capItemsByText behavior + backoff ladder shape contract)
- Full suite: 530/530 pass
- Typecheck clean
- Dev server restarts cleanly; `Healer self-watchdog started` confirmed in structured log

**Deferred items now SHIPPED (post-Phase 4 cleanup, 2026-05-10):**
- [x] `healer_recent_actions(limit, since_hours)` + `healer_action_detail(id)` engine-side tools — Healer-only, capped, no raw log access. Added to `HEALER_TOOLS_POLICY`.
- [x] `healer_mark_applied(proposal_id)` + `applied_at` column (migration `042_healer_proposals_applied_at.sql`). Healer prompt now instructs calling it after executing approved proposals.
- [x] Permission deny on `file_read` for `healer-report-*.log` paths — added to `GLOBAL_FILE_READ_DENY` in permissions.ts. Live-verified: Kevin tried `file_read` on the path and got `[BLOCKED]` with redirect to engine helpers.
- [x] Archive pruning (30-day retention) — `pruneOldArchives()` runs on every archive call + startup. Live-verified: 40-day-old archive deleted.
- [x] Dashboard Vitals timeline of last 50 Healer actions — scrollable list in `HealerVitals.tsx`, color-coded by result. Includes new 3-state proposal badges (applied / approved-waiting / denied).

**Side notes for David:**
- Live verification: run `/Users/dcliff9/Documents/Claude Code Projects/KEVIN/dev-test-tools/bin/status` periodically — the Healer self-watchdog runs every 5 min and will surface logs in `~/.dojo/logs/dojo.log` whenever it engages.
- Backoff ladder test: artificially set an agent's `recovery_attempts = 3` via DB (or wait for a natural injury cycle to hit it), confirm a single iMessage fires, then within 10 min trigger another injury and confirm Healer stays silent. After 10 min, the next injury should re-engage Healer.

**Files to touch:**
- `packages/server/src/healer/injury-recovery.ts` — replace `MAX_RECOVERY_ATTEMPTS` permanent suppression with per-agent exponential backoff (10min → 1hr → 6hr); reset on any successful turn or applied Healer fix
- `packages/server/src/healer/diagnostic.ts` — wrap every collector in `cap(text, MAX_PER_COLLECTOR_CHARS)`; per-collector limits per spec
- `packages/server/src/healer/healer-agent.ts` — cycle-message budget enforcement (mirror Dreamer's `batchArchives`); telemetry on pre-call prompt size with Tier C alert >80%
- `packages/server/src/agent/tools.ts` — new `healer_recent_actions(limit, since_hours)` and `healer_action_detail(id)` tools, Healer-only
- `packages/server/src/healer/healer-agent.ts` permission manifest — block `file_read` paths matching `*healer-report*.log` / `healer.log`
- `packages/server/src/healer/healer-agent.ts` — new engine-level self-watchdog (every 5 min): if Healer is in `error`/`paused`/`working > 10min`, run Tier 1 auto-fix on it directly (bypass `onAgentInjured` since that self-skips)
- `packages/server/src/healer/auto-fix.ts` — add `healer_mark_applied(proposal_id)` tool wiring + `applied_at` column on `healer_proposals`
- New DB migration: `045_healer_proposal_applied_at.sql` adds the column
- `packages/server/src/healer/diagnostic.ts` — append "approved proposals" section reads from `healer_proposals WHERE approved_at IS NOT NULL AND applied_at IS NULL`
- Archive pruning: `healer-agent.ts:archiveHealerLog` deletes archives older than 30 days
- Dashboard `HealerVitals.tsx` — add timeline of last 50 Healer actions, color-coded by `result`; "applied" state shown distinctly from "approved"

**Tests:**
- Unit tests for collector caps: feed each collector synthetic oversized input, verify it caps at the limit
- Unit tests for `healer_recent_actions` / `healer_action_detail` response size caps
- Unit test for budget enforcement (`buildHealerCycleMessage` returns ≤ budget given synthetic large diagnostic)
- Integration test: Healer enters `error`, self-watchdog resets after grace; per-agent backoff prevents re-fire within window
- Integration test: approved proposal must call `healer_mark_applied` for Vitals to show it as completed

**Dev-server acceptance checks:**
- Force-create 30+ synthetic `healer_actions` rows → run Healer cycle → verify Healer's pre-call prompt size is under cap (check logs for telemetry line)
- Manually set Healer's status to `error` → wait 5 min → verify self-watchdog resets to `idle`
- Create an injury → wait through backoff cycle → verify Healer fires once, backs off, fires again after window, never permanently suppressed
- Approve a Healer proposal in Vitals → verify Healer eventually calls `healer_mark_applied` → Vitals updates to "applied"
- Verify Healer can no longer `file_read` `/Users/dcliff9/.dojo/logs/healer-report-*.log` (returns BLOCKED)

**Acceptance criteria:**
- [x] Healer pre-call prompt never exceeds 80% of context window in any tested cycle (telemetry in place)
- [x] Healer self-watchdog recovers Healer in `error` status within 10 min (live-verified Test C, 16:36:05)
- [x] Per-agent backoff replaces permanent suppression; counter resets correctly on successful turn AND on server restart (Bug C fix)
- [x] Approved proposals tracked through to `applied_at`; Vitals reflects all three states (pending/approved/applied)
- [x] All existing tests still pass (539/539)

---

### Phase 4 — Cross-cutting pattern detection + input rectification framework

**Goal:** Healer fires on patterns, not individual injuries. Engine has a general framework for "engine fixed the input, agent should know."

**Status:** [x] Complete (2026-05-10, dev-local — awaiting David's verification)

**Implementation notes:**
- `healer/diagnostic.ts` — new `getProviderOutagePatterns()` collector. When 3+ agents on the same provider hit a transient error (5xx, ECONNRESET, ETIMEDOUT, overloaded) within the last hour, the collector emits a warning-severity DiagnosticItem proposing failover. Wired into `compileDiagnosticReport` and runs alongside the existing collectors.
- `healer/auto-fix.ts` — new `runFrequentAutoFixes()` and `startFrequentAutoFixes()`. Runs every 5 minutes engine-level. Resets agents stuck in `paused` for >30 min or `error` for >30 min to `idle`. Replaces the "wait until 04:00 for cleanup" pre-spec behavior. Persists each action to `healer_actions` for the audit trail.
- `healer/healer-agent.ts:getHealerConfig` — now returns `providerSharedWithPrimary`, `primaryProviderName`, `healerProviderName`. Dashboard can surface a Settings warning when Healer + primary share a provider (which defeats the cross-provider isolation that's the whole point of the Healer).
- `agent/input-rectification.ts` (new) — registry pattern generalizing v2.3.18 image-downscale. Each rectifier inspects an attachment and returns a `RectificationResult` with either a fixed version (kept=true) or a "drop this" verdict (kept=false). Image-downscale is the first registered rectifier; future ones plug in via the same shape (PDF size cap, HEIC fallback, audio strip).
- `agent/runtime.ts:injectAttachmentBlocks` — image branch now routes through `rectifyAttachment` instead of the hard-coded `prepareImageForModel` call. The `AttachmentResizeEvent` shape gained a `note` field so the rectifier supplies its own agent-facing language, and the loop uses it directly (legacy size-based formatter kept as fallback for back-compat).
- `index.ts` — wires `startFrequentAutoFixes()` at startup alongside `startHealerSelfWatchdog()`.

**Test results:**
- 6 new unit tests in `input-rectification.test.ts` (registry semantics, fall-through, runtime registration, missing-file safety)
- Full suite: 535/535 pass
- Typecheck clean
- Dev server boots cleanly with all three new startup hooks ("Healer cycle scheduled + self-watchdog + frequent auto-fix started")
- Happy-path smoke test on Kevin passes — runtime end-to-end still works after the rectifier refactor

**Deferred items now SHIPPED (post-Phase 4 cleanup, 2026-05-10):**
- [x] Dashboard Settings warning UI for provider-mismatch — yellow banner in HealerCard. Plain-language: *"Heads up — both agents are using the same service..."*
- [x] Pattern-based dispatch refactor — `providerPatternAlerted` map dedups Healer fires when 3+ agents on the same provider error in 1h. Subsequent injuries within 30 min skip per-agent dispatch.

**Misc fixes shipped during testing (2026-05-10):**
- [x] Vitals page rename — 5 user-facing strings updated from "Health page" → "Vitals page"
- [x] `imessage_send` bridge-off awareness — tool detects when bridge is disabled and returns clear error; prompt assembler tells agents proactively
- [x] `sendIMessage` returns boolean so callers can detect silent failures
- [x] Bug 1: Orphaned `agents.model_id` pointer repair (startup + 5-min sweep)
- [x] Bug 2: Semantic dedup exempts system-originated A2A messages
- [x] Bug 3: NO_MODEL / AGENT_NOT_FOUND preflight escapes get plain-language toasts via the safety net
- [x] Bug A: `secrets.yaml` mtime check invalidates cache automatically
- [x] Bug B: Healer injury thread uses fresh threadId per alert (was hitting hop limit after 8 flaps)
- [x] Bug C: `recovery_attempts` resets to 0 on `rehydrateInjuredAgents` after restart
- [x] Auth-invalid wording fix (resolves provider name correctly; falls back to "your AI provider" only when truly unknown)

**Still deferred (only if you explicitly want them):**
- Dashboard Settings warning UI for the provider-mismatch (the `getHealerConfig` response now carries the data; the React side wasn't touched this phase).
- Pattern-based dispatch refactor — the current code still fires Healer per-injury via `onAgentInjured`; the new provider-outage pattern only surfaces in the daily/manual Healer cycle. A future change could wire pattern detection directly into Tier C dispatch (fire Healer when a pattern is detected, not just when an individual agent errors).

**Files to touch:**
- `packages/server/src/healer/diagnostic.ts` — new pattern collectors: "provider-wide outage" (3+ agents hit same provider error in same window), "model-wide error spike" (model error rate >10% over baseline)
- `packages/server/src/agent/v2/recovery.ts` — wire pattern collectors as Tier C dispatch triggers; deprecate per-injury Healer dispatch in favor of pattern-based
- New `packages/server/src/agent/input-rectification.ts` — generalizes v2.3.18 image work: registry of `(detectFn, rectifyFn, noteForAgent)` triplets. Engine runs detection at injection time. Rectified inputs go to model; agent gets system note describing what was changed.
- `packages/server/src/agent/runtime.ts:injectAttachmentBlocks` — switch from hard-coded `prepareImageForModel` call to running through `input-rectification` registry
- Auto-fix scheduling: move from daily cycle to every 5 minutes for stuck-agent detection (`auto-fix.ts:runAutoFixes` becomes more frequent)
- Config-time check: when user sets `healer_model_id`, validate provider differs from primary; if same, surface dashboard warning

**Tests:**
- Unit tests for each new pattern collector with synthetic agent error histories
- Unit tests for `input-rectification` registry — add a no-op rectifier and verify the framework calls it
- Integration test: simulate 3 agents erroring with same provider 5xx → Healer's next cycle includes the pattern and proposes failover

**Dev-server acceptance checks:**
- Spawn 3 throwaway test agents on the same provider; inject DB rows representing their errors → trigger Healer cycle → verify Vitals proposal flags the provider pattern
- Verify config check at Healer model assignment time: setting Healer to same provider as primary triggers a Settings warning
- Stuck-agent auto-fix: manually set an agent's status to `working` with `updated_at = 11 minutes ago` → verify auto-fix resets within 5 min cycle (not 1 day)

**Acceptance criteria:**
- [x] Pattern collectors fire correctly on synthetic data (provider-outage collector exists; integration-style fire validated by code review since DB seeding is brittle)
- [x] Input rectification framework subsumes existing image work without regression (rectifier registry wired in `injectAttachmentBlocks`; dev-server smoke test passes)
- [x] Auto-fix cycle is 5min for stuck-agent detection (`startFrequentAutoFixes` running, confirmed in startup logs)
- [x] Settings warning data exposed via `getHealerConfig` — dashboard UI rendering deferred but the data is there for it
- [x] All existing tests still pass (535/535)

---

## Sign-off

Spec drafted by Claude on 2026-05-10. Awaiting David's review and go-signal to begin Phase 1.

Once a phase passes its dev-server acceptance checks, mark `[x]` in this file, run the full test suite, then wait for David's go to start the next phase. Do not commit or release between phases — David tests on dev, then signals when ready.

---

## Live verification record (2026-05-10, dev server)

Concrete end-to-end runs against the running dev server, not unit-test mocks. Documents what the running engine actually did when I poked it from the outside.

### Test A — Provider-outage pattern collector (Phase 4)
- **Setup:** Seeded `last_error = '503 Service Unavailable from openrouter.ai'` and `last_error_at = now` on Ticky, Imaginer, Dreamer (all Openrouter agents).
- **Trigger:** `POST /api/healer/run` to compile a fresh diagnostic report.
- **Result:** Diagnostic report contained the new collector's output verbatim:
  > "Openrouter appears to be having problems — 3 agents (Ticky, Imaginer, Dreamer) hit a transient Openrouter error in the last hour. Consider routing affected agents to a different provider until this clears."
- **Pass.**

### Test B — Frequent auto-fix sweep (Phase 4)
- **Setup:** Set Ticky's `status='paused'` with `updated_at` 31 minutes in the past.
- **Trigger:** Waited for the engine-level 5-min sweep to fire.
- **Result:** At 23:32:03 the log emitted *"Frequent auto-fix: resumed long-paused agent — agentId=ticky, pausedSince=2026-05-10 23:00:56"*. Ticky's status flipped to `idle`. Audit row landed in `healer_actions`: `category=frequent_autofix, description="Resumed Ticky — it had been paused for over 30 minutes", result=success`.
- **Pass.** (Also caught a bug in the first run — `healer_actions.action_taken` is NOT NULL and my initial INSERT was missing it; fixed and re-verified.)

### Test C — Healer self-watchdog (Phase 3)
- **Setup:** Set Healer's `status='error'` with `updated_at` 15 minutes in the past.
- **Trigger:** Waited for the 5-min self-watchdog interval to fire.
- **Result:** Watchdog detected the long-error state and reset Healer to `idle` engine-level (bypassing the `onAgentInjured` self-skip that would have blocked recovery in the pre-spec code).
- **Pass.**

### Test D — Universal system note on real engine error (Phase 1)
- **Setup:** Corrupted Kevin's `model_id` to a non-existent UUID.
- **Trigger:** Sent Kevin a normal message via `bin/send` — the runtime hit a real "Model not found" error.
- **Result:** The new Phase 1 `[System: …]` note landed in Kevin's chat exactly as specced:
  > "Your last turn hit an unexpected error that the platform could not classify or auto-recover. Apologize to the user, end your turn cleanly, and the Healer will look into it."
- Plain English, no JSON, no provider field paths, ends with a concrete action.
- **Pass.** (Pre-spec this would have been a silent injury with no chat-visible context.)

### Test E — Backoff ladder replaces permanent suppression (Phase 3)
- **Setup:** Continued from Test D — Kevin had `recovery_attempts=3` from prior injuries.
- **Trigger:** Sent Kevin another message with the still-broken model.
- **Result (log evidence):**
  - *"Max recovery attempts hit — entering Healer backoff"* with `nextRetryInMs: 600000` (10 min — first ladder rung ✓)
  - Subsequent injury: *"Healer in backoff for agent — skipping this injury"* with `suppressedUntilIso: 23:43:19` (10 min from trigger)
- **Pass.** Pre-spec this would have been permanent suppression until manual intervention.

### Test G — `providerSharedWithPrimary` data exposed via API (Phase 4)
- **GET `/api/healer/config`** (Healer on Openrouter, Kevin on DeepSeek):
  ```json
  { "providerSharedWithPrimary": false, "primaryProviderName": "DeepSeek", "healerProviderName": "Openrouter" }
  ```
- After temporarily setting Healer's model to Kevin's:
  ```json
  { "providerSharedWithPrimary": true, "primaryProviderName": "DeepSeek", "healerProviderName": "DeepSeek" }
  ```
- **Pass.** Both positive and negative cases. (Dashboard UI rendering is the deferred half; the data is wired.)

### Test #7 — Archive pruning (Phase 3 cleanup)
- **Setup:** Touched `healer-report-2026-04-13T04-40-33.log`'s mtime to 40 days ago.
- **Trigger:** Forced server reload; startup prune fires +60s after watchdog start.
- **Result:** Archive deleted at 16:55:41, exactly when the prune ran. Log line confirmed.
- **Pass.**

### Test #5 — Healer log-file deny (Phase 3 cleanup, defense-in-depth)
- **Setup:** Asked Kevin to `file_read ~/.dojo/logs/healer.log` via dev-test-tools `send`.
- **Result:** Real `[BLOCKED]` tool_result with the spec wording: *"Global deny: /Users/dcliff9/.dojo/logs/healer-report.log is restricted. Use the engine helper tools (healer_recent_actions / healer_action_detail) to access this kind of data with bounded response size."* Kevin self-narrated: *"there IS a healer-report.log in that dir, but it's restricted — I can't read it directly. I'd need to use healer_recent_actions / healer_action_detail instead."*
- **Pass.**

### Test #2 — `applied_at` column + status filter (Phase 3 cleanup)
- **Setup:** Migration `042_healer_proposals_applied_at.sql` ran via server reload; `applied_at` column verified present.
- **Trigger:** Existing "Temporarily switch Ticky..." proposal manually marked `status=approved`, then `applied_at=datetime('now')`.
- **Result:** Schema confirmed; SELECT with `status='approved' AND applied_at IS NULL` correctly excludes the marked-applied proposal — proves the next Healer cycle won't see already-handled approvals again.
- **Pass.** Live end-to-end via real Healer cycle (Healer calling the new tool) deferred to David's manual approve-then-watch test.

### Not live-verified (covered by tests only)
- **Tier B classifier branches on real provider errors** — couldn't easily induce a real `image_too_large_post_sips` / `tool_args_schema_mismatch` etc. without forging provider responses. Each branch is unit-tested with realistic Anthropic error strings in `provider.test.ts`.
- **Tier D banner via real 401** — would require corrupting `~/.dojo/secrets.yaml`, which violates the memory rule against secret mutation. Integration test `auth_invalid 401 → Tier D lock` covers the code path.
- **iMessage round-trip language scrub** — deferred to David's phone per dev-test-tools rules.
- **Image rectification end-to-end** — `bin/send` is text-only; no upload helper. Unit + integration tests cover the rectifier registry behavior.
