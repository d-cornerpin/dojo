# DOJO Platform — Weak-Model Robustness & Overall Fixes Plan

**Created:** 2026-04-12
**Goal:** Make the DOJO platform reliable for agents running on models weaker than Claude Opus/Sonnet — Haiku, GPT-4o-mini, Gemini Flash, local Ollama models, etc.

---

## Executive Summary

The DOJO works well with frontier models but breaks down with weaker ones. Six areas need attention:

1. **Tracker & PM agent** — PM told to use vault but lacks access, task list filter broken, agents not notified of task assignments, descriptions missing from listings
2. **Tool call handling** — malformed JSON silently becomes `{}`, no recovery when models get stuck
3. **Context assembly** — no boundary markers, weak models can't distinguish summaries from real messages
4. **Prompt design** — system prompts are bloated (4-6k tokens), no adaptation for model size
5. **Error communication** — all errors are plain text, no structured codes, weak models retry denied operations
6. **Observability** — agents silently idle when stuck, user gets no notification

The fixes below are ordered by impact. Each step is independent unless noted.

---

## PHASE 1: Critical — Things That Actively Break Weak Models

### 1.1 Fix Silent Tool Argument Parse Failures

**Problem:** In `model.ts:972`, when an OpenAI-compatible model returns malformed tool call JSON, the catch block silently produces `{}` empty args. The tool then executes with no arguments, often succeeding with wrong results or producing a confusing error. The model never learns its JSON was bad.

**Files:** `packages/server/src/agent/model.ts` (OpenAI path ~line 972, Ollama path ~line 500)

**Fix:**
- When `JSON.parse(acc.args)` fails, don't silently use `{}`.
- Instead, create a synthetic tool result with `is_error: true` and a message like:
  ```
  Error: Your tool call arguments were malformed JSON and could not be parsed.
  The raw text was: "<first 200 chars of acc.args>"
  Please retry this tool call with valid JSON arguments.
  ```
- Return this as a tool result so the model sees the failure and can retry.
- Add a counter: if 3+ consecutive malformed tool calls in the same turn, inject a system-level nudge with the correct JSON schema for the tool they're trying to call.

**Estimated effort:** Small — isolated to model.ts parse blocks.

---

### 1.2 Add Stuck-Model Detection & Nudging

**Problem:** When a weak model repeats itself or produces empty output, the runtime just breaks the loop and idles the agent (`runtime.ts:658-690`). The user sees the agent go idle with no explanation. The model gets no guidance on what went wrong.

**Files:** `packages/server/src/agent/runtime.ts` (~lines 658-690, ~line 688)

**Fix:**
- **On repetition detected (line 660):** Before breaking, inject a synthetic user message:
  ```
  [System: You are repeating yourself. Your last two responses were identical.
  If you're stuck, try a different approach. If the task is complete, call
  complete_task. If you need help, explain what you're stuck on.]
  ```
  Give the model ONE more iteration after this nudge. If it repeats again, then break.

- **On empty/whitespace response:** Add detection after `result.content` is set. If content is empty/whitespace AND no tool calls, inject:
  ```
  [System: You returned an empty response. Please respond to the user's
  last message or call a tool to continue your task.]
  ```
  Allow one retry.

- **On max tool loops hit (line 688):** Before breaking, persist a visible message to chat:
  ```
  [System: This turn used the maximum number of tool calls (25). The agent
  has paused. You may need to send a follow-up message to continue.]
  ```
  Broadcast this as a `chat:message` so it appears in the dashboard.

- **On consecutive no-result searches (line 674):** Before breaking, inject:
  ```
  [System: Multiple searches returned no results. The information may not
  exist in memory. Try responding based on what you already know, or ask
  the user for clarification.]
  ```

**Estimated effort:** Medium — touches the main loop in several places, but each nudge is a small insertion.

---

### 1.3 Structured Tool Results (Machine-Parseable)

**Problem:** Every tool returns free-form text strings. Weak models can't reliably extract IDs, statuses, or structured data from natural language results. This causes cascading failures in multi-step tool chains (e.g., create project → get ID → create task with that ID).

**Files:** `packages/server/src/tracker/tools.ts`, `packages/server/src/agent/tools.ts`, `packages/server/src/agent/web-tools.ts`

**Fix:**
- Add a structured header to every tool result that contains key fields:
  ```
  [OK] project_id=proj_abc123 | title=My Project
  
  Project created successfully.
  Tasks (2 created):
    1. Design mockups (task_abc124, on_deck)
    2. Build prototype (task_abc125, on_deck)
  ```
- The `[OK]` / `[ERROR]` prefix gives a clear signal.
- Key-value pairs on the first line are machine-parseable even by weak models.
- The human-readable description follows for context.

- Apply this pattern to all tools that return IDs or structured data:
  - `tracker_create_project` → include project_id
  - `tracker_create_task` → include task_id, project_id
  - `tracker_update_status` → include task_id, new_status
  - `tracker_get_status` → include project_id, task counts
  - `spawn_agent` → include agent_id, agent_name
  - `file_write` → include path, bytes_written
  - `exec` → include exit_code, then stdout/stderr
  - `web_search` → numbered results with URL on own line
  - `vault_remember` → include entry_id
  - `vault_search` → numbered results with IDs

**Estimated effort:** Medium-large — touches many tool implementations, but each change is mechanical.

---

### 1.4 Pre-Route Capability Validation

**Problem:** The router (`scorer.ts`) selects models without checking if they support tools or vision. Capability enforcement happens AFTER selection (`runtime.ts:25-108`), stripping features post-hoc. This wastes an API call and confuses the model when it gets tools stripped mid-flight.

**Files:** `packages/server/src/router/scorer.ts`, `packages/server/src/agent/runtime.ts`

**Fix:**
- In `selectModel()`, filter candidates by required capabilities BEFORE scoring:
  - If the current context contains images → require `vision` capability
  - If the agent has tools enabled → require `tools` capability (or strongly prefer it)
- Add a `requiredCapabilities` parameter to `selectModel()`:
  ```typescript
  selectModel(tier: string, agentId: string, opts?: {
    exclude?: string[];
    requireCapabilities?: string[];
  })
  ```
- In the scorer, add a "tools_present" dimension that boosts score when the message context includes tool-call-like language or when the agent has tools configured.
- When a model is selected that lacks tools, log a clear warning and broadcast a banner ONCE per session.

**Estimated effort:** Medium — changes scorer and selectModel signature.

---

### 1.5 Handle `capabilities` Parse Failures Safely

**Problem:** In `model.ts:155-157`, if the `capabilities` JSON column fails to parse, it defaults to an empty array `[]`. But in `runtime.ts:36`, an empty capabilities array means `useTools = true` (because the check is `capabilities.includes('tools') === false` which only disables tools if explicitly missing). So a model with corrupt/missing capability data gets ALL features enabled.

**Files:** `packages/server/src/agent/model.ts` (~line 155), `packages/server/src/agent/runtime.ts` (~line 36)

**Fix:**
- When capabilities JSON fails to parse, treat it as `['text']` (text-only) rather than `[]`.
- Add a `capabilitiesValid: boolean` flag to the model info return.
- In `enforceModelCapabilities`, if `capabilitiesValid === false`, disable tools and vision by default (safer than enabling everything).
- Log a warning: "Model {id} has invalid capabilities data — defaulting to text-only mode."

**Estimated effort:** Small.

---

## PHASE 2: High Priority — Significant UX Degradation

### 2.1 Context Boundary Markers

**Problem:** In `assembler.ts`, summaries flow directly into fresh tail messages with only a synthetic assistant ACK ("Thank you, I have reviewed...") as separator. Weak models can't distinguish compressed history from live conversation. They treat summaries as real dialogue, try to "respond" to them, or lose track of what's current.

**Files:** `packages/server/src/memory/assembler.ts` (~lines 115-184)

**Fix:**
- Add explicit section markers in the context:
  ```
  ═══ COMPRESSED HISTORY (summaries of earlier messages — not live conversation) ═══
  
  <summary ...>...</summary>
  
  ═══ END COMPRESSED HISTORY ═══
  
  ═══ RECENT CONVERSATION (live messages — respond to these) ═══
  ```
- The markers should be visually distinct (═══ characters) and use plain language.
- Add a one-line explanation of what summaries are in the wrapper text:
  ```
  The following are compressed summaries of older conversation history.
  These capture key facts and decisions but are NOT live messages.
  Do not respond to them directly — they are context only.
  ```
- After the fresh tail starts, add a brief note:
  ```
  The messages below are the most recent live conversation. Respond to these.
  ```

**Estimated effort:** Small — changes assembler.ts only.

---

### 2.2 Adaptive System Prompt Complexity

**Problem:** All agents get the same system prompt regardless of model capability. For a 4K-context local model, the system prompt alone (4-6K tokens) can consume 100%+ of the context window. Even for 32K models, a bloated system prompt leaves minimal room for actual conversation.

**Files:** `packages/server/src/prompt/assembler.ts`

**Fix:**
- Add a `promptComplexity` tier based on context window:
  - `full` (200K+): Current behavior — all sections included
  - `standard` (32K-200K): Remove redundant sections, condense vault/tracker rules
  - `compact` (8K-32K): Essential rules only, one paragraph per section, no examples
  - `minimal` (<8K): Identity + 3 critical rules + tool index only

- For `compact` and `minimal`:
  - Collapse the vault instructions (currently ~600 tokens) to 2 sentences
  - Collapse tracker instructions (currently ~400 tokens) to 3 sentences
  - Remove conditional sections (Google, Microsoft, PM awareness) unless the agent NEEDS them
  - Remove redundant rules that duplicate what's in the SOUL template
  - Remove the technique index (agent can call `load_tool_docs` if needed)

- Track the prompt token count and log a warning if it exceeds 30% of context window.

**Estimated effort:** Medium — requires refactoring assembler.ts to support tiers.

---

### 2.3 Stronger Permission Denial Messages

**Problem:** When a tool is denied, the message says "Permission denied: {reason}. DO NOT retry this operation..." (`tools.ts:1466`). Weak models often ignore "DO NOT" instructions and retry repeatedly, wasting tokens and frustrating users.

**Files:** `packages/server/src/agent/tools.ts` (~line 1466)

**Fix:**
- Make permission denials more forceful and provide alternatives:
  ```
  [BLOCKED] Permission denied: {reason}
  
  This operation is permanently blocked by your permission settings.
  Retrying will fail every time.
  
  Instead, you should:
  1. Try an alternative approach that doesn't require this permission
  2. Call complete_task(result="blocked", notes="Need permission for: {action}")
  3. Or ask the user: "I don't have permission to {action}. Would you like to grant it?"
  ```
- Add a "denied tool call" counter per agent per turn. If the same tool is denied 2+ times in a turn, inject a hard system message:
  ```
  [System: You have attempted a blocked operation {N} times. It will NEVER succeed.
  Stop attempting it and use an alternative approach.]
  ```
- After 3 denied attempts of the same tool, force-break the tool loop.

**Estimated effort:** Small-medium.

---

### 2.4 Tool Description Examples

**Problem:** Most tool descriptions have no usage examples. Weak models frequently call tools with wrong argument names, wrong types, or missing required fields. The `spawn_agent` description is 500+ tokens but has zero JSON examples.

**Files:** `packages/server/src/agent/tools.ts` (tool definitions section)

**Fix:**
- Add a concise example to every tool that has complex arguments:
  ```
  Example: memory_grep({ pattern: "budget meeting", limit: 5 })
  Returns: timestamped messages and summaries matching the query
  ```
- For the 10 most-used tools, add input AND output examples:
  - `exec`, `file_read`, `file_write`, `file_list`
  - `send_to_agent`, `spawn_agent`
  - `tracker_create_project`, `tracker_create_task`, `tracker_update_status`
  - `vault_remember`, `vault_search`
- Keep examples under 50 tokens each — just enough to show the shape.
- For tools with complex schemas (spawn_agent), add a "minimal example" and a "full example".

**Estimated effort:** Medium — writing good examples takes care.

---

### 2.5 Agent Stuck/Silent Notification to User

**Problem:** When a weak model gets stuck (repetition, empty output, max loops), the agent silently goes idle. The user has no idea anything went wrong. They see the agent sitting at "idle" and wonder if it's done.

**Files:** `packages/server/src/agent/runtime.ts`, `packages/server/src/gateway/ws.ts`

**Fix:**
- When the loop breaks for ANY abnormal reason, broadcast a `chat:system` event:
  ```typescript
  broadcast({
    type: 'chat:system',
    agentId,
    severity: 'warning', // or 'error'
    message: 'Agent stopped: repeating the same response',
    // or: 'Agent stopped: hit maximum tool call limit (25)'
    // or: 'Agent stopped: multiple searches returned no results'
    // or: 'Agent paused: 5 errors in 2 minutes (error loop detected)'
  });
  ```
- Add a `chat:system` WebSocket event type if it doesn't exist.
- Dashboard should render these as yellow/red banners in the chat window.
- For error loop pauses, include a "Resume" button in the dashboard.

**Estimated effort:** Small-medium — WS event + dashboard component.

---

### 2.6 Fix Non-Auto-Routed Agent Retry

**Problem:** Fixed-model agents (non-auto-routed) get only 1 attempt on model failure (`runtime.ts:364`). If their model has a transient error, the agent immediately fails. Auto-routed agents get 3 attempts with fallback models, but most sub-agents are fixed-model.

**Files:** `packages/server/src/agent/runtime.ts` (~line 364)

**Fix:**
- Give ALL agents at least 2 retry attempts (with exponential backoff).
- For fixed-model agents, retry the same model (transient errors are common).
- After 2 failures, offer to fall back to the agent's tier's default model:
  ```typescript
  const maxAttempts = isAutoRouted ? 3 : 2;
  // On non-auto failure after 2 attempts, try tier fallback
  if (!isAutoRouted && attempt === 1) {
    const tierFallback = getTierFallback(agentId);
    if (tierFallback) modelId = tierFallback;
  }
  ```
- Broadcast a banner when fallback is used: "Model {X} failed, falling back to {Y}."

**Estimated effort:** Small.

---

## PHASE 3: Medium Priority — Quality of Life

### 3.1 Improve Summarization Prompts for Weak Summarizers

**Problem:** The summarization prompts in `summarize.ts` assume the model understands the `[ROLE] message` format and the concept of compaction depth. Weak summarizer models produce bloated or garbled summaries, which then get deterministically truncated (losing the middle 60%).

**Files:** `packages/server/src/memory/summarize.ts`, `packages/server/src/memory/compaction.ts`

**Fix:**
- Add explicit framing to the summarization input:
  ```
  You are summarizing a conversation between a user and an AI assistant.
  The conversation is formatted as:
    [USER] = messages from the human user
    [ASSISTANT] = responses from the AI assistant
    [TOOL] = results from tool executions
  
  Summarize the key facts and decisions. Preserve all specific details.
  ```
- For depth 1+ condensation, explain the input:
  ```
  You are merging multiple summaries into one unified summary.
  Each <summary> block below is a COMPRESSED version of earlier conversation.
  They may overlap in time. Merge them, keeping ALL specific details from each.
  ```
- Reduce the compression ratio for weak models. Add to compaction config:
  ```typescript
  const leafTargetTokens = isWeakModel(modelId) ? 8000 : 5000; // Less aggressive
  ```
- Improve the deterministic truncation fallback — instead of head+tail, use sentence-boundary extraction:
  - Extract all sentences
  - Score by information density (presence of names, numbers, URLs)
  - Keep highest-scoring sentences up to token budget

**Estimated effort:** Medium.

---

### 3.2 Memory Retrieval Result Clarity

**Problem:** `memory_grep` results mix raw messages and compressed summaries without clear distinction. Weak models treat summaries as literal conversation, try to "respond" to people mentioned in summaries, or miss that details were compressed away.

**Files:** `packages/server/src/memory/retrieval.ts`

**Fix:**
- Clearly label each result type:
  ```
  ═══ RAW MESSAGES (exact conversation records) ═══
  [2024-01-15 10:30] (user) We discussed the Q1 budget
  [2024-01-15 10:31] (assistant) Here's the budget breakdown...
  
  ═══ COMPRESSED SUMMARIES (condensed history — details may be lost) ═══
  [sum_abc123] Covers: Jan 10-15 | Compression: 4x
    User and assistant discussed budget allocation for Q1...
  ```
- Add "Compression: Nx" label to summaries so the model knows detail may be missing.
- When no results found, suggest concrete next steps:
  ```
  No results found for "budget meeting".
  Suggestions:
  - Try broader terms: "budget" or "meeting"
  - Try vault_search for semantic (meaning-based) search
  - The information may predate your memory window
  ```

**Estimated effort:** Small-medium.

---

### 3.3 Newline Sanitization in Model Output

**Problem:** User reports agents "adding \n where there should not be \n". This is likely weak models producing literal `\n` strings instead of actual newline characters, or producing excessive whitespace that gets rendered literally in iMessage.

**Files:** `packages/server/src/agent/runtime.ts`, `packages/server/src/services/imessage-bridge.ts`

**Fix:**
- After model response is captured, sanitize:
  ```typescript
  // Normalize literal "\n" strings that weak models sometimes produce
  let content = result.content;
  if (content) {
    content = content.replace(/\\n/g, '\n'); // literal \n → real newline
    content = content.replace(/\n{3,}/g, '\n\n'); // collapse 3+ newlines to 2
    content = content.trim();
    result.content = content;
  }
  ```
- For iMessage delivery specifically, apply additional cleanup:
  - Strip markdown formatting (`**bold**` → `bold`, etc.)
  - Collapse excessive whitespace
  - Trim trailing newlines

**Estimated effort:** Small.

---

### 3.4 `load_tool_docs` Auto-Suggestion

**Problem:** Weak models don't know to call `load_tool_docs` before using a complex tool. They guess at argument names and types, producing malformed calls.

**Files:** `packages/server/src/agent/tools.ts`

**Fix:**
- When a tool call fails due to missing/wrong arguments, append to the error result:
  ```
  Hint: Call load_tool_docs(tools=["tool_name"]) to see the full parameter
  documentation before retrying.
  ```
- In the tool index (generated by prompt assembler), mark complex tools with a flag:
  ```
  - spawn_agent ⚠️ (call load_tool_docs first — complex parameters)
  - tracker_create_project ⚠️ (call load_tool_docs first)
  ```
- For `compact`/`minimal` prompt tiers (Phase 2.2), include a global instruction:
  ```
  Before using any tool for the first time, call load_tool_docs(tools=["tool_name"])
  to read its full documentation.
  ```

**Estimated effort:** Small.

---

### 3.5 PM Agent Model Independence

**Problem:** The PM agent defaults to the primary agent's model (`pm-agent.ts:126-131`). If the primary runs a weak model, the PM is also weak — and the PM needs to parse tracker state, format poke messages, and make escalation decisions. A weak PM breaks the entire project management loop.

**Files:** `packages/server/src/tracker/pm-agent.ts`

**Fix:**
- Give the PM agent its own model configuration independent of the primary.
- Default the PM to a mid-tier model (at least the "routine" tier from the router).
- If no specific PM model is configured, use the router's routine tier default — never inherit a weak primary model.
- Add this to the platform config:
  ```yaml
  pm_agent:
    model_id: auto  # or a specific model
    min_tier: routine  # never use the lowest tier for PM
  ```

**Estimated effort:** Small-medium.

---

### 3.6 Conversation Continuation Awareness

**Problem:** Agents just stop with no indication they'll try again or finish the job. When a weak model gives a partial response and the loop ends normally (no tool calls = done), the user thinks the agent has finished when it actually gave up mid-thought.

**Files:** `packages/server/src/agent/runtime.ts`

**Fix:**
- After the model responds with text (no tool calls), check if the response looks incomplete:
  ```typescript
  function looksIncomplete(text: string): boolean {
    const trimmed = text.trim();
    // Ends mid-sentence (no terminal punctuation)
    if (!/[.!?:)\]"']$/.test(trimmed)) return true;
    // Very short response to a complex request
    if (trimmed.length < 50 && lastUserMessage.length > 200) return true;
    // Contains "I will" / "Let me" / "I'll" without follow-through
    if (/\b(I will|Let me|I'll|I'm going to)\b/i.test(trimmed) && trimmed.length < 200) return true;
    return false;
  }
  ```
- If incomplete, inject a continuation nudge:
  ```
  [System: Your response appears incomplete. Please continue where you left off,
  or if you're finished, confirm by saying so.]
  ```
- Allow one more iteration. If the model responds with just "I'm done" or similar, accept it.

**Estimated effort:** Medium — heuristic tuning needed.

---

### 3.7 Tool Call Format Recovery for XML-Style Output

**Problem:** Some models (MiniMax, older Gemini, local models) output tool calls as XML text instead of structured function calls. There's already a fallback parser in `model.ts:1016` for the `<invoke name="">` format, but it only handles one specific XML pattern.

**Files:** `packages/server/src/agent/model.ts` (~line 1016)

**Fix:**
- Expand the XML tool call parser to recognize additional patterns weak models produce:
  ```
  Pattern 1: <invoke name="tool">...</invoke>  (already handled)
  Pattern 2: <tool_call><name>tool</name><arguments>{...}</arguments></tool_call>
  Pattern 3: ```json\n{"name": "tool", "arguments": {...}}\n```
  Pattern 4: <function_call name="tool" arguments='{"key": "value"}' />
  ```
- Add a generic "tool call in text" detector that looks for JSON objects containing `"name"` and `"arguments"` keys.
- When detected, parse and convert to proper tool calls.
- Log when this fallback triggers so we can track which models need it.

**Estimated effort:** Medium — regex/parsing work.

---

### 3.8 Auto-Route Reply Detection Robustness

**Problem:** The auto-route reply detection in `runtime.ts:700-765` uses regex to extract sender ID from message content (`/^\[Message from .+? \(agent ID: ([^)]+)\)\]/`). If the message format changes or a weak model produces a different format, auto-routing silently breaks.

**Files:** `packages/server/src/agent/runtime.ts` (~lines 700-765)

**Fix:**
- Store inter-agent message metadata in a structured column instead of parsing message content:
  ```sql
  ALTER TABLE messages ADD COLUMN source_agent_id TEXT DEFAULT NULL;
  ALTER TABLE messages ADD COLUMN reply_expected BOOLEAN DEFAULT FALSE;
  ```
- When `send_to_agent` delivers a message, set `source_agent_id` on the inserted message.
- Auto-route check queries the column directly instead of regex-parsing content.
- This also makes inter-agent conversation threading queryable and debuggable.

**Estimated effort:** Medium — migration + code changes in tools.ts and runtime.ts.

---

## PHASE 4: Lower Priority — Polish & Hardening

### 4.1 Turn Time Budget

**Problem:** The tool loop has a max iteration count (25) but no time budget. A weak model making slow API calls can keep a turn running for 10+ minutes. No visibility to the user.

**Files:** `packages/server/src/agent/runtime.ts`

**Fix:**
- Add a turn time budget (configurable, default 5 minutes):
  ```typescript
  const TURN_TIME_BUDGET_MS = 5 * 60 * 1000;
  const turnStart = Date.now();
  
  // In the loop:
  if (Date.now() - turnStart > TURN_TIME_BUDGET_MS) {
    logger.warn('Turn time budget exceeded', { elapsed: Date.now() - turnStart }, agentId);
    // Persist system message and break
    break;
  }
  ```
- Broadcast a system message when the budget is exceeded.

**Estimated effort:** Small.

---

### 4.2 Vault/Technique Instructions Condensation

**Problem:** The vault instructions in the system prompt are ~600 tokens. The tracker instructions are ~400 tokens. Together they consume 1000+ tokens that repeat on every turn. For weak models with small context windows, this is devastating.

**Files:** `packages/server/src/prompt/assembler.ts`

**Fix:**
- Create condensed versions for smaller models:
  - Vault (full): 600 tokens → Vault (compact): 100 tokens
    ```
    You have a vault for long-term memory. Use vault_search(query) to look things up.
    Use vault_remember(content, tags) to save important facts. Search before asking
    "I don't remember." Save discoveries after completing tasks.
    ```
  - Tracker (full): 400 tokens → Tracker (compact): 80 tokens
    ```
    Use the project tracker to manage tasks. Call tracker_get_status to check progress.
    Call tracker_update_status to change task states. Don't check tracker during casual chat.
    ```
- These condensed versions should be used for the `compact` and `minimal` prompt tiers from Phase 2.2.

**Estimated effort:** Small — writing concise prompts.

---

### 4.3 Rate Limit Retry with Model Escalation

**Problem:** When a model hits a rate limit, the background retry manager (`rate-limit-retry.ts`) retries the same model on an escalating delay schedule. It never considers switching to a different model, even when the rate limit could persist for hours.

**Files:** `packages/server/src/agent/rate-limit-retry.ts`

**Fix:**
- After strike 3 (1-minute wait), check if there's an alternative model in the same tier.
- If available, offer to switch: broadcast a banner "Model X is rate-limited. Would you like to switch to Model Y?"
- For auto-routed agents, automatically switch after strike 3.
- For fixed-model agents, notify the user but don't auto-switch (respects their configuration).

**Estimated effort:** Medium.

---

### 4.4 Session Boundary Clarity for Fresh Sessions

**Problem:** When a user starts a fresh session, a note is injected (`assembler.ts:243-257`): "The user started a fresh session. Your earlier conversations have been moved to the vault." This is good but could be clearer for weak models about what they DO and DON'T have access to.

**Files:** `packages/server/src/memory/assembler.ts`

**Fix:**
- Expand the session note slightly:
  ```
  [New Session] Your previous conversation history has been archived.
  You still have access to your long-term memory via vault_search.
  You DO NOT have the detailed conversation from before — only summaries.
  If the user references something specific from before, use vault_search to find it.
  ```

**Estimated effort:** Tiny.

---

### 4.5 Technique Loading Clarity

**Problem:** Equipped techniques are injected into the system prompt but weak models sometimes don't understand they should follow technique instructions, or they confuse technique steps with general system instructions.

**Files:** `packages/server/src/prompt/assembler.ts` (technique injection section)

**Fix:**
- Frame technique content more explicitly:
  ```
  ═══ EQUIPPED TECHNIQUE: {name} ═══
  When performing "{name}", follow these steps IN ORDER:
  {steps}
  ═══ END TECHNIQUE ═══
  ```
- Add a brief global instruction in the prompt:
  ```
  You have equipped techniques (specialized procedures). When a task matches
  a technique, follow its steps exactly. Do not improvise your own approach.
  ```

**Estimated effort:** Small.

---

### 4.6 Error Type Classification

**Problem:** All errors are plain text strings. There's no way for the runtime to know if an error is "permission denied" vs "file not found" vs "network timeout" without string matching. This makes automated recovery impossible.

**Files:** `packages/server/src/agent/tools.ts`, `packages/server/src/agent/errors.ts`

**Fix:**
- Add error codes to tool results:
  ```typescript
  interface ToolResult {
    toolCallId: string;
    content: string;
    isError: boolean;
    errorCode?: 'PERMISSION_DENIED' | 'NOT_FOUND' | 'TIMEOUT' | 'INVALID_ARGS'
               | 'NETWORK_ERROR' | 'PARSE_ERROR' | 'RATE_LIMITED';
  }
  ```
- Use error codes to drive automated recovery:
  - `PERMISSION_DENIED` → don't retry, suggest alternative
  - `INVALID_ARGS` → suggest `load_tool_docs`
  - `TIMEOUT` → retry once with longer timeout
  - `RATE_LIMITED` → back off
  - `NOT_FOUND` → suggest alternative path/search

**Estimated effort:** Medium — touches many tool implementations.

---

### 4.7 Graceful Degradation When Tools Unsupported

**Problem:** When `enforceModelCapabilities` disables tools (`runtime.ts:88-105`), the model gets a one-time banner but then runs in text-only mode. The agent can't do anything useful without tools. The user doesn't understand why their agent is broken.

**Files:** `packages/server/src/agent/runtime.ts`

**Fix:**
- When tools are disabled, inject a clear explanation into the system prompt:
  ```
  IMPORTANT: Your current model ({model_name}) does not support tool calling.
  You can only respond with text. You CANNOT execute commands, read files,
  search memory, or use any tools. If the user asks you to do something that
  requires tools, explain that your model doesn't support it and suggest they
  switch to a model that does (e.g., via the Settings page).
  ```
- Also broadcast a persistent dashboard banner (not just one-time).
- Consider auto-suggesting a model upgrade if the agent is configured for tasks that require tools.

**Estimated effort:** Small.

---

## PHASE 5: Prompt Template Improvements

### 5.1 PM-SOUL.md Clarity

**Problem:** The PM's escalation chain ("poke once → poke with urgency → escalate") is ambiguous. Weak PM models don't understand the difference between a poke and an urgent poke, or when to escalate.

**Files:** `templates/PM-SOUL.md`

**Fix:**
- Replace vague escalation with concrete rules:
  ```
  Poke schedule:
  1. First poke (at scheduled time): "Checking in on {task}. How's progress?"
  2. Second poke (next schedule after no response): Add [URGENT] prefix.
     "⚠️ [URGENT] No update on {task} after {time}. Please respond with status."
  3. Escalation (next schedule after still no response): Message the primary agent.
     "Escalating {task} — {agent} has not responded after 2 pokes over {time}."
  
  NEVER poke more than twice before escalating.
  NEVER skip straight to escalation without poking first.
  ```

**Estimated effort:** Small.

---

### 5.2 TRAINER-SOUL.md Voice Simplification

**Problem:** The Trainer template asks the model to be both a "wise martial arts sensei" AND a precise technical documentation writer. Weak models fail at this code-switching — they either write poetic technique docs or abandon the persona entirely.

**Files:** `templates/TRAINER-SOUL.md`

**Fix:**
- Separate the persona from the technical requirements:
  ```
  VOICE: When chatting with users, speak as a calm, wise teacher.
  
  TECHNIQUE WRITING: When creating techniques, switch to precise technical writing.
  Techniques must be step-by-step instructions that an AI agent can follow exactly.
  Do NOT use metaphors or philosophical language in technique content.
  The persona is for conversation only, not for technique documentation.
  ```

**Estimated effort:** Tiny.

---

### 5.3 IMAGINER-SOUL.md Simplification

**Problem:** The "Non-Negotiable Request Flow" is overly rigid. Weak models interpret this as an absolute and fail on edge cases. The refusal policy ("if it's safe, just make it" vs. explicit refusal list) creates contradiction.

**Files:** `templates/IMAGINER-SOUL.md`

**Fix:**
- Replace "Non-Negotiable" with "Standard Flow" and add a brief escape clause:
  ```
  Follow this flow for image requests. If a step doesn't apply (e.g., the
  user provides a complete description), skip it.
  ```
- Unify the safety policy:
  ```
  SAFETY: Before generating, check this list. If the request matches ANY item, refuse:
  - Copyrighted characters (Disney, Marvel, etc.)
  - Real named people
  - Branded logos or IP
  - Sexual or violent content
  
  If the request is safe (doesn't match the list above), generate it without hesitation.
  ```

**Estimated effort:** Tiny.

---

## PHASE 6: Tracker & PM Agent — Critical Path Fixes

The tracker and PM agent are core infrastructure. Every task, every poke, every escalation flows through them. The issues below cause agents to say "I don't have access" or silently miss task instructions.

### 6.0 PM Agent Tools Policy — Missing Critical Tools

**Problem:** The PM's `tools_policy.allow` list is missing tools that its own system prompt tells it to use. This is the direct cause of agents reporting "I don't have access to look at the instructions."

**PM-SOUL.md lines 19-21** says:
```
During your reviews, save important project state, decisions, or blockers to the vault.
Search the vault before each review cycle to recall context from previous cycles.
```

But the PM's allow list (`pm-agent.ts:112-116, 146-150, 182-186`) is:
```
tracker_list_active, tracker_get_status, tracker_update_status,
tracker_add_notes, tracker_pause_schedule, tracker_resume_schedule,
send_to_agent, broadcast_to_group, list_agents, list_groups, get_current_time
```

**Missing tools:**
- `vault_search` — PM is told to "search the vault before each review cycle" but CAN'T
- `vault_remember` — PM is told to "save important project state to the vault" but CAN'T
- `load_tool_docs` — PM can't inspect tool schemas when confused about parameters
- `tracker_complete_step` — PM can't advance steps during escalation handling
- `memory_grep` — PM can't search conversation history to understand task context

**Files:** `packages/server/src/tracker/pm-agent.ts` (3 locations: lines 112-116, 146-150, 182-186)

**Fix:**
```typescript
const pmToolsPolicy = JSON.stringify({
  allow: [
    // Tracker
    'tracker_list_active', 'tracker_get_status', 'tracker_update_status',
    'tracker_add_notes', 'tracker_complete_step',
    'tracker_pause_schedule', 'tracker_resume_schedule',
    // Communication
    'send_to_agent', 'broadcast_to_group', 'list_agents', 'list_groups',
    // Memory
    'vault_search', 'vault_remember',
    'memory_grep',
    // Utility
    'load_tool_docs', 'get_current_time',
  ],
});
```

Update in ALL THREE locations where `pmToolsPolicy` / `syncToolsPolicy` is defined.

**Estimated effort:** Tiny — three string array edits.

---

### 6.1 `tracker_list_active` Filter is Broken (Always Returns 'all')

**Problem:** The tool dispatcher hardcodes the scope to `'all'` regardless of what filter the agent passes.

**File:** `packages/server/src/agent/tools.ts` line 2037

**Current code:**
```typescript
case 'tracker_list_active':
  content = trackerListActive(agentId, {
    scope: args.filter === 'all' || !args.filter ? 'all' : 'all',  // BUG: always 'all'
  });
```

The ternary evaluates to `'all'` on BOTH branches. The `'mine'`, `'blocked'`, and `'overdue'` filter options in the tool schema do nothing.

**Fix — Step 1:** Fix the dispatcher to pass through the filter:
```typescript
case 'tracker_list_active': {
  const filter = args.filter as string | undefined;
  if (filter === 'mine') {
    content = trackerListActive(agentId, { scope: 'tasks', assignedTo: agentId });
  } else if (filter === 'blocked') {
    content = trackerListActive(agentId, { scope: 'tasks', status: 'blocked' });
  } else {
    content = trackerListActive(agentId, { scope: 'all' });
  }
  isError = content.startsWith('Error');
  break;
}
```

**Fix — Step 2:** Update `trackerListActive` in `packages/server/src/tracker/tools.ts` to accept optional `assignedTo` and `status` filter params, passing them through to `listTasks()`.

**Estimated effort:** Small.

---

### 6.2 `tracker_list_active` Doesn't Show Task Descriptions

**Problem:** The task list output shows only title, ID prefix, assignee, and priority. No description/instructions. An agent looking at their task list has zero visibility into what the task actually requires. They must call `tracker_get_status` on each individual task — but nothing tells them to do this.

**File:** `packages/server/src/tracker/tools.ts` lines 541-556

**Current output:**
```
In Progress Tasks (2):
  [aaa73e0e] Build landing page [Dave Jr] (high)
  [bbb91f12] Write API docs [Kevin] (normal)
```

**Fix:** Include a truncated description (first 100 chars) when available:
```
In Progress Tasks (2):
  [aaa73e0e] Build landing page [Dave Jr] (high)
    → Create a responsive landing page using the new design system...
  [bbb91f12] Write API docs [Kevin] (normal)
    → Document all REST endpoints in the gateway, including request/response schemas...
```

Implementation in `trackerListActive`:
```typescript
for (const t of inProgress) {
  const assignee = t.assignedTo ? ` [${t.assignedToName ?? t.assignedTo}]` : ' [unassigned]';
  parts.push(`  [${t.id.slice(0, 8)}] ${t.title}${assignee} (${t.priority})`);
  if (t.description) {
    const desc = t.description.length > 120 ? t.description.slice(0, 120) + '...' : t.description;
    parts.push(`    → ${desc}`);
  }
}
```

Also update the `tracker_list_active` tool description to mention:
```
"For full task details including complete description and notes, call tracker_get_status with the task ID."
```

**Estimated effort:** Small.

---

### 6.3 Non-Scheduled Task Assignment Doesn't Notify the Assigned Agent

**Problem:** When a task is created via `tracker_create_task` and assigned to an agent, the task record is created in the DB but **no message is injected into the assigned agent's conversation**. The agent has no idea the task exists until:
- The PM pokes them about it (3-10 minutes later, depending on priority)
- They happen to call `tracker_list_active`
- The scheduler fires it (only for scheduled tasks)

Scheduled tasks DO get a message via `runner.ts:131-138`. Non-scheduled tasks get nothing.

**File:** `packages/server/src/tracker/tools.ts` (in `trackerCreateTask`, after line 276)

**Fix:** When a task is created and assigned to an agent OTHER than the creator, inject a message into the assigned agent's conversation and trigger their runtime:
```typescript
// Notify assigned agent about new task (unless they created it themselves)
if (assignedTo && assignedTo !== agentId) {
  const creatorName = resolveAgentName(agentId) ?? agentId;
  const taskNotification = [
    `[SOURCE: TRACKER TASK ASSIGNMENT — you have been assigned a new task]`,
    ``,
    `Task: ${title}`,
    `ID: ${taskId}`,
    `Priority: ${priority ?? 'normal'}`,
    description ? `\nInstructions:\n${description}` : '',
    projectId ? `Project: ${projectId}` : '',
    `Assigned by: ${creatorName}`,
    ``,
    `Begin working on this task. When finished, call tracker_update_status(task_id="${taskId}", status="complete", notes="what you did").`,
    `If you get stuck, call tracker_update_status(task_id="${taskId}", status="blocked", notes="why you're blocked").`,
  ].filter(Boolean).join('\n');

  const notifyMsgId = uuidv4();
  db.prepare(`
    INSERT INTO messages (id, agent_id, role, content, created_at)
    VALUES (?, ?, 'user', ?, datetime('now'))
  `).run(notifyMsgId, assignedTo, taskNotification);

  broadcast({
    type: 'chat:message',
    agentId: assignedTo,
    message: {
      id: notifyMsgId, agentId: assignedTo, role: 'user' as const,
      content: taskNotification,
      tokenCount: null, modelId: null, cost: null, latencyMs: null,
      createdAt: new Date().toISOString(),
    },
  });

  // Trigger the agent's runtime so they process the task immediately
  const runtime = getAgentRuntime();
  runtime.handleMessage(assignedTo, taskNotification).catch(err => {
    logger.error('Task assignment notification failed', {
      taskId, assignedTo,
      error: err instanceof Error ? err.message : String(err),
    }, agentId);
  });
}
```

**Estimated effort:** Medium — needs careful handling to avoid double-triggering for scheduled tasks.

---

### 6.4 PM Review Message Doesn't Include Task Descriptions

**Problem:** The PM's LLM review (`pm-agent.ts:385-396`) builds a task summary with only title, status, assignee, and schedule info. No descriptions. The PM is making decisions about stalled tasks without knowing what those tasks actually say.

**File:** `packages/server/src/tracker/pm-agent.ts` lines 385-396

**Current format:**
```
- [IN_PROGRESS] "Build landing page" -> Dave Jr (repeats every 2 hours)
```

**Fix:** Include truncated description:
```typescript
const taskSummary = activeTasks.map(t => {
  let line = `- [${t.status.toUpperCase()}] "${t.title}" -> ${t.assignedToName ?? 'unassigned'}`;
  if (t.repeatInterval) line += ` (repeats every ${t.repeatInterval} ${t.repeatUnit})`;
  if (t.scheduledStart) {
    const nextRun = t.nextRunAt ? new Date(t.nextRunAt.includes('Z') ? t.nextRunAt : t.nextRunAt + 'Z') : null;
    if (nextRun && nextRun > nowDate) {
      line += ` [next run: ${t.nextRunAt}]`;
    }
  }
  if (t.status === 'blocked') line += ' [BLOCKED]';
  // Include description so PM knows what the task actually is
  if (t.description) {
    const desc = t.description.length > 150 ? t.description.slice(0, 150) + '...' : t.description;
    line += `\n  Instructions: ${desc}`;
  }
  return line;
}).join('\n');
```

**Estimated effort:** Tiny.

---

### 6.5 PM Poke Message Content Inconsistency

**Problem:** The poke is stored in the recipient's messages with one format but broadcast to the dashboard with a different format.

**Stored (pm-agent.ts:524):**
```
[SOURCE: PM AGENT POKE FROM RICK — this is NOT a message from the user, it's an automated poke...]
```

**Broadcast (pm-agent.ts:534):**
```
[Rick — Project Manager] {pokeMessage}
```

The agent sees the verbose `[SOURCE: ...]` prefix, which is consistent with other inter-agent messages. But the dashboard sees a different, shorter format. This means what the user sees in the dashboard doesn't match what the agent sees in its context.

**File:** `packages/server/src/tracker/pm-agent.ts` lines 521-535

**Fix:** Use the same content for both storage and broadcast. The `[SOURCE: ...]` prefix is the correct one (it follows the established convention for non-user messages). Update the broadcast to use the same content:
```typescript
const fullPokeContent = `[SOURCE: PM AGENT POKE FROM ${pmName.toUpperCase()} — this is NOT a message from the user, it's an automated poke from the PM agent checking on your progress] ${pokeMessage}`;

// Store in recipient's messages
db.prepare(`
  INSERT INTO messages (id, agent_id, role, content, created_at)
  VALUES (?, ?, 'user', ?, datetime('now'))
`).run(pokeMsgId, recipient, fullPokeContent);

// Broadcast same content to dashboard
broadcast({
  type: 'chat:message',
  agentId: recipient,
  message: {
    id: pokeMsgId, agentId: recipient, role: 'user' as Message['role'],
    content: fullPokeContent,
    // ...
  },
});
```

**Estimated effort:** Tiny.

---

### 6.6 PM-SOUL.md Needs Concrete Tool Usage Examples

**Problem:** The PM prompt tells it to "check the project tracker on your poke schedule" and "include full task context" but doesn't show it HOW with actual tool calls. Weak PM models don't know which tools to use or in what order.

**File:** `templates/PM-SOUL.md`

**Fix:** Add a concrete workflow section:
```markdown
# How to Check Tasks

When you receive a situation report, follow this process:

1. If you see an engine-detected issue, act on it:
   - ORPHANED task → call send_to_agent(agent="{{primary_agent_name}}", message="Task X is orphaned...")
   - STALE/OVERDUE task → the engine poke system handles nudges automatically, but call
     send_to_agent to notify {{primary_agent_name}} if escalation is needed
   - BLOCKED task → call send_to_agent(agent="{{primary_agent_name}}", message="Task X has been blocked for Y minutes...")

2. To get full details on any task: call tracker_get_status(id="<task_id>")
   This shows description, notes, dependencies, and step info.

3. To check what's active: call tracker_list_active(filter="all")

4. To save context for your next review: call vault_remember(content="...", tags=["pm-review"])
   To recall previous context: call vault_search(query="pm-review")

5. If everything looks fine: say "all clear" in your chat. Do NOT message {{primary_agent_name}}.
```

**Estimated effort:** Small.

---

### 6.7 Tracker Tool `complete_all_runs` Not Passed Through Dispatcher

**Problem:** The `tracker_update_status` tool schema defines `complete_all_runs` (line 709-711) for recurring tasks, but the dispatcher (tools.ts:2011-2018) doesn't pass it through:

```typescript
case 'tracker_update_status': {
  const updateArgs: Record<string, unknown> = {
    taskId: args.task_id as string,
    status: args.status as string,
  };
  if (args.notes) updateArgs.notes = args.notes;
  // BUG: args.complete_all_runs is never passed!
  content = trackerUpdateStatus(agentId, updateArgs);
```

The `trackerUpdateStatus` function (tools.ts:316-329) checks for `args.complete_all_runs`, but it's never in the args because the dispatcher strips it.

**File:** `packages/server/src/agent/tools.ts` line 2016

**Fix:**
```typescript
if (args.notes) updateArgs.notes = args.notes;
if (args.complete_all_runs) updateArgs.complete_all_runs = args.complete_all_runs;
```

**Estimated effort:** Tiny — one line.

---

### 6.8 Tracker Tool Description Gaps

**Problem:** Several tracker tool descriptions are too vague for weak models:

1. **`tracker_get_status`** (line 737): Says "Get the current status and details of a task or project" but doesn't mention it returns description, notes, dependencies, step info, etc. Agents don't know this is the tool to use for reading task instructions.

2. **`tracker_list_active`** (line 751): Says "List active projects and tasks, optionally filtered" — doesn't mention that descriptions are truncated and that `tracker_get_status` should be used for full details.

3. **`tracker_complete_step`** (line 766): Doesn't mention that it automatically marks the NEXT step as `in_progress` — a key behavior agents need to understand.

**File:** `packages/server/src/agent/tools.ts` lines 736-781

**Fix — updated descriptions:**

```typescript
{
  name: 'tracker_get_status',
  description: 'Get the full details of a task or project, including description/instructions, notes, dependencies, step number, assigned agent, and timestamps. Use this to read the instructions for any task. Accepts a task ID or project ID (full UUID or 8+ char prefix from tracker_list_active).',
  // ...
}

{
  name: 'tracker_list_active',
  description: 'List active projects and tasks with their status, assignee, and priority. Shows truncated descriptions. For full task details including complete instructions and notes, call tracker_get_status with the task ID.',
  // ...
}

{
  name: 'tracker_complete_step',
  description: 'Complete the current step in a multi-step project and automatically start the next one. Marks this task as "complete" and moves the next step (by step_number) to "in_progress". Also checks if the entire project is now complete. Use this instead of tracker_update_status when working through ordered project steps.',
  // ...
}
```

**Estimated effort:** Small.

---

### Summary: Tracker & PM Priority Order

| Priority | Fix | Impact | Effort |
|----------|-----|--------|--------|
| 🔴 P0 | 6.0 PM missing vault/tool_docs in allow list | **Directly causes "no access" errors** | Tiny |
| 🔴 P0 | 6.1 `tracker_list_active` filter broken | Filter options do nothing | Small |
| 🔴 P0 | 6.7 `complete_all_runs` not passed through | Recurring task completion broken | Tiny |
| 🟠 P1 | 6.3 Task assignment doesn't notify agent | Agents don't know tasks exist | Medium |
| 🟠 P1 | 6.2 Task list missing descriptions | Agents can't see instructions | Small |
| 🟠 P1 | 6.4 PM review missing descriptions | PM reviews without context | Tiny |
| 🟠 P1 | 6.8 Tracker tool descriptions too vague | Agents don't know tool capabilities | Small |
| 🟡 P2 | 6.6 PM-SOUL needs tool examples | Weak PM models don't know workflow | Small |
| 🟢 P3 | 6.5 Poke message format inconsistency | Dashboard/agent see different content | Tiny |

---

## PHASE 7: Dashboard & WebSocket Reliability

### 7.1 Structured Error Events (Replace String-Only Errors)

**Problem:** `ChatErrorEvent` only carries a string `error` field. The dashboard does string matching (`error.includes('429')`) to decide behavior (`Chat.tsx:438`). If the backend changes the message wording, the dashboard breaks.

**Files:** `packages/shared/src/ws.ts`, `packages/server/src/agent/runtime.ts`, `packages/dashboard/src/pages/Chat.tsx`

**Fix:**
- Extend `ChatErrorEvent` with structured fields:
  ```typescript
  interface ChatErrorEvent {
    type: 'chat:error';
    agentId: string;
    error: string;
    code?: 'RATE_LIMITED' | 'MODEL_FAILED' | 'PERMISSION_DENIED' | 'ERROR_LOOP' | 'TIMEOUT' | 'TERMINATED';
    severity?: 'info' | 'warning' | 'error';
    retryable?: boolean;
  }
  ```
- Dashboard uses `code` instead of string matching to decide behavior.
- Display different UI treatments based on severity (yellow for retryable, red for fatal).

**Estimated effort:** Small-medium.

---

### 7.2 Subscribe to Agent Termination in Chat

**Problem:** `Chat.tsx` never subscribes to `agent:terminated` events. When a sub-agent is terminated (by timeout, complete_task, or kill_agent), the user sees no notification in the chat view. They may continue typing messages to a dead agent.

**Files:** `packages/dashboard/src/pages/Chat.tsx`

**Fix:**
- Add subscription to `agent:terminated` event.
- Display a system message in chat: "This agent has been terminated. Reason: {reason}"
- Disable the chat input for terminated agents.

**Estimated effort:** Small.

---

### 7.3 Error Loop Pause Notification

**Problem:** When the error loop detector pauses an agent (`errors.ts:60`), it broadcasts `agent:status` with 'paused' but doesn't include WHY. The user sees the agent go to "paused" with no explanation. An iMessage alert fires for the primary agent, but dashboard users get nothing.

**Files:** `packages/server/src/agent/errors.ts`, `packages/server/src/gateway/ws.ts`

**Fix:**
- When error loop triggers a pause, broadcast a `chat:system` event:
  ```typescript
  broadcast({
    type: 'chat:system',
    agentId,
    severity: 'error',
    message: `Agent paused: ${ERROR_LOOP_THRESHOLD} errors in ${ERROR_LOOP_WINDOW_MS / 1000} seconds. Check the Health page for details.`,
  });
  ```
- Dashboard renders this as a red banner in the chat with a "Resume" button.

**Estimated effort:** Small.

---

### 7.4 WebSocket Reconnection Indicator

**Problem:** When the WebSocket disconnects and reconnects, it happens silently. Events emitted during the disconnect window are lost. The user has no idea they may have missed agent output.

**Files:** `packages/dashboard/src/hooks/useWebSocket.ts`, `packages/dashboard/src/components/` (new component)

**Fix:**
- Track connection state in the WebSocket hook: `connected | reconnecting | disconnected`.
- Show a subtle banner at the top of the dashboard when reconnecting:
  ```
  ⚠ Connection lost. Reconnecting... (attempt 3)
  ```
- When reconnected, briefly show: "Reconnected. You may have missed some events — refresh to catch up."
- Consider: On reconnect, fetch the latest N messages for the active agent to fill any gap.

**Estimated effort:** Medium.

---

### 7.5 Prevent Permanent 'working' State

**Problem:** If the runtime crashes mid-turn after setting status to 'working' but before the finally block runs, the agent stays in 'working' state forever. The user can't send new messages (the runtime rejects them because `activeRuns` has the agent).

**Files:** `packages/server/src/agent/runtime.ts`

**Fix:**
- Add a watchdog check: on server startup and every 5 minutes, scan for agents in 'working' status whose `updated_at` is older than 10 minutes. Reset them to 'idle'.
  ```typescript
  function recoverStuckAgents() {
    const db = getDb();
    const stuck = db.prepare(`
      SELECT id, name FROM agents
      WHERE status = 'working'
        AND updated_at < datetime('now', '-10 minutes')
    `).all();
    for (const agent of stuck) {
      db.prepare("UPDATE agents SET status = 'idle' WHERE id = ?").run(agent.id);
      activeRuns.delete(agent.id);
      broadcast({ type: 'agent:status', agentId: agent.id, status: 'idle' });
      logger.warn('Recovered stuck agent', { agentId: agent.id });
    }
  }
  ```
- Also clean up `activeRuns` Set on server startup (it's in-memory, so stale after restart).

**Estimated effort:** Small.

---

## Implementation Order (Recommended)

| Priority | Step | Impact | Effort | Dependencies |
|----------|------|--------|--------|-------------|
| 🔴 P0 | 1.1 Fix silent tool arg parse | Critical | Small | None |
| 🔴 P0 | 1.2 Stuck-model nudging | Critical | Medium | None |
| 🔴 P0 | 1.5 Capabilities parse safety | Critical | Small | None |
| 🟠 P1 | 2.1 Context boundary markers | High | Small | None |
| 🟠 P1 | 2.5 Agent stuck notification | High | Small-Med | None |
| 🟠 P1 | 2.3 Permission denial messages | High | Small-Med | None |
| 🟠 P1 | 2.6 Non-auto retry fix | High | Small | None |
| 🟡 P2 | 1.3 Structured tool results | High | Med-Large | None |
| 🟡 P2 | 1.4 Pre-route capability check | High | Medium | None |
| 🟡 P2 | 2.2 Adaptive prompt complexity | High | Medium | None |
| 🟡 P2 | 2.4 Tool description examples | High | Medium | None |
| 🟡 P2 | 3.3 Newline sanitization | Medium | Small | None |
| 🟡 P2 | 3.4 load_tool_docs suggestion | Medium | Small | None |
| 🟡 P2 | 3.5 PM agent model independence | Medium | Small-Med | None |
| 🟡 P2 | 3.6 Incomplete response detection | Medium | Medium | 1.2 |
| 🟢 P3 | 3.1 Summarization prompt improvement | Medium | Medium | None |
| 🟢 P3 | 3.2 Memory retrieval clarity | Medium | Small-Med | None |
| 🟢 P3 | 3.7 XML tool call recovery | Medium | Medium | None |
| 🟢 P3 | 3.8 Auto-route reply robustness | Medium | Medium | None |
| 🟢 P3 | 4.1 Turn time budget | Low-Med | Small | None |
| 🟢 P3 | 4.2 Vault/tracker condensation | Low-Med | Small | 2.2 |
| 🟢 P3 | 4.3 Rate limit model escalation | Low-Med | Medium | None |
| 🔴 P0 | 6.0 PM missing vault/load_tool_docs | **Causes "no access" errors** | Tiny | None |
| 🔴 P0 | 6.1 tracker_list_active filter broken | Filter options do nothing | Small | None |
| 🔴 P0 | 6.7 complete_all_runs not passed through | Recurring completion broken | Tiny | None |
| 🟠 P1 | 6.3 Task assignment doesn't notify agent | Agents don't know tasks exist | Medium | None |
| 🟠 P1 | 6.2 Task list missing descriptions | Can't see instructions | Small | None |
| 🟠 P1 | 6.4 PM review missing descriptions | PM reviews blind | Tiny | None |
| 🟠 P1 | 6.8 Tracker tool descriptions too vague | Agents misuse tools | Small | None |
| 🟡 P2 | 6.6 PM-SOUL needs tool examples | Weak PM doesn't know workflow | Small | None |
| 🟢 P3 | 6.5 Poke message format inconsistency | Dashboard/agent mismatch | Tiny | None |
| 🟠 P1 | 7.5 Prevent permanent 'working' state | High | Small | None |
| 🟡 P2 | 7.1 Structured error events | Medium | Small-Med | None |
| 🟡 P2 | 7.3 Error loop pause notification | Medium | Small | 2.5 |
| 🟢 P3 | 7.2 Subscribe to agent:terminated | Medium | Small | None |
| 🟢 P3 | 7.4 WebSocket reconnection indicator | Low-Med | Medium | None |
| ⚪ P4 | 4.4-4.7, 5.1-5.3 | Low-Med | Tiny-Small | Various |

---

## Files Touched (Summary)

| File | Steps |
|------|-------|
| `packages/server/src/agent/runtime.ts` | 1.2, 2.5, 2.6, 3.3, 3.6, 3.8, 4.1, 4.7 |
| `packages/server/src/agent/model.ts` | 1.1, 1.5, 3.7 |
| `packages/server/src/agent/tools.ts` | 1.3, 2.3, 2.4, 3.4, 4.6, 6.1, 6.7, 6.8 |
| `packages/server/src/memory/assembler.ts` | 2.1, 2.2, 4.4, 4.5 |
| `packages/server/src/prompt/assembler.ts` | 2.2, 4.2, 4.5 |
| `packages/server/src/memory/summarize.ts` | 3.1 |
| `packages/server/src/memory/compaction.ts` | 3.1 |
| `packages/server/src/memory/retrieval.ts` | 3.2 |
| `packages/server/src/router/scorer.ts` | 1.4 |
| `packages/server/src/tracker/tools.ts` | 1.3, 6.1, 6.2, 6.3, 6.7 |
| `packages/server/src/agent/web-tools.ts` | 1.3 |
| `packages/server/src/tracker/pm-agent.ts` | 3.5, 6.0, 6.4, 6.5 |
| `packages/server/src/agent/rate-limit-retry.ts` | 4.3 |
| `packages/server/src/agent/errors.ts` | 4.6, 6.3 |
| `packages/server/src/gateway/ws.ts` | 2.5, 6.3 |
| `packages/server/src/services/imessage-bridge.ts` | 3.3 |
| `templates/PM-SOUL.md` | 5.1, 6.6 |
| `templates/TRAINER-SOUL.md` | 5.2 |
| `templates/IMAGINER-SOUL.md` | 5.3 |
| `packages/shared/src/ws.ts` | 6.1 |
| `packages/dashboard/src/pages/Chat.tsx` | 6.1, 6.2 |
| `packages/dashboard/src/hooks/useWebSocket.ts` | 6.4 |
