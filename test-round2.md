# Testing Round 2 — Remaining Verifications

Round 1 confirmed: tracker list filters, task assignment notifications, structured tool results, inter-agent messaging, and dashboard loading. This round covers everything that was blocked or untested.

---

## 1. Kelly (PM Agent) — Vault Access & Reviews

Kelly was in error state last round. She's been fixed and restarted.

- [ ] Send Kelly a message via send_to_agent: "Search the vault for any previous project context"
- [ ] Verify Kelly calls `vault_search` successfully (no permission error)
- [ ] Send Kelly: "Remember that we completed a test cycle for the overall fixes on April 13th"
- [ ] Verify Kelly calls `vault_remember` successfully
- [ ] Send Kelly: "Do a tracker review"
- [ ] Verify Kelly reviews active tasks and her review includes task descriptions (look for `Instructions:` lines under each task)
- [ ] Verify Kelly can call `tracker_get_status` to read full task details
- [ ] If there are stalled tasks, verify Kelly sends you a message via `send_to_agent` about them

---

## 2. Model Switch Sanitization (NEW)

When an agent's model is changed, tool call messages are now automatically sanitized so the new model doesn't crash on old tool IDs.

- [ ] Pick a sub-agent that has some tool call history (or create one and have it make a few tool calls)
- [ ] Switch that agent's model from the dashboard Settings
- [ ] Check the server logs for "Collapsed tool call messages after model change"
- [ ] Send the agent a message — verify it responds normally without any "tool id not found" errors
- [ ] Verify the agent still has context from before the model switch (it should remember what it was doing)

---

## 3. Stuck Model Nudging

Agents now get nudged when they repeat themselves or return empty responses, instead of silently going idle.

- [ ] This is hard to trigger with strong models — check the server logs for any of these nudge messages:
  - `"Model returned empty response, injecting nudge"`
  - `"Agent repeating itself, injecting nudge"`
  - `"Consecutive empty search results, injecting nudge"`
- [ ] If you can trigger a repeated search that returns nothing, verify the `[System: Multiple searches returned no results...]` nudge appears in the agent's chat
- [ ] After any nudge, verify the agent gets one more try before stopping

---

## 4. Context Boundary Markers

Summaries in context now have clear markers separating compressed history from live conversation.

- [ ] If any agent has had enough conversation to trigger compaction, send them a message
- [ ] Check server logs (debug level) for the context assembly — look for `═══ COMPRESSED HISTORY ═══` wrapping summaries
- [ ] Ask an agent "What do you remember from earlier?" — verify they reference summary content naturally without treating it as a live message they need to respond to

---

## 5. Permission Denial Messages

Denied tool calls now show `[BLOCKED]` with concrete alternatives.

- [ ] Find or create a sub-agent with restricted permissions (no file write, no exec, etc.)
- [ ] Ask it to do something it can't (e.g., "Write a file to ~/test.txt" for an agent without file_write)
- [ ] Verify the error says `[BLOCKED] Permission denied:` and lists 3 alternatives
- [ ] Verify the agent does NOT retry the blocked operation — it should try an alternative or report it's blocked

---

## 6. Incomplete Response Detection

Agents that stop mid-sentence now get nudged to continue.

- [ ] Give an agent a complex multi-part question that might produce a long response
- [ ] If the response ends mid-sentence (no period/punctuation), check for `[System: Your response appears incomplete...]` in the logs
- [ ] Verify the agent continues its response after the nudge

---

## 7. Turn Time Budget

Turns are now limited to 15 minutes (increased from the 5 minutes that killed Kevin's first attempt).

- [ ] This already works — Kevin's first test was killed at 6 minutes by the old 5-minute budget
- [ ] Verify Kevin can now complete multi-tool-call turns without being cut off
- [ ] If a turn DOES exceed 15 minutes, verify the system message appears: `[System: This turn exceeded the 15 minute time budget...]`

---

## 8. Agent Termination Notification

The chat view now shows when an agent is terminated.

- [ ] Spawn a test sub-agent with a short timeout: `spawn_agent(name="TestBot", system_prompt="You are a test bot. Say hello.", timeout=120)`
- [ ] Wait for it to timeout (2 minutes) or kill it manually
- [ ] Check the dashboard chat view for that agent — verify "Agent terminated: [reason]" appears as an error banner

---

## 9. Error Loop Notification

When an agent is paused due to repeated errors, the chat now shows why.

- [ ] This is hard to trigger intentionally — mostly a safety net
- [ ] If any agent enters "paused" state during testing, check its chat for "Agent paused: 5 errors in 120 seconds"
- [ ] Check server logs for `"Error loop detected, pausing agent"` entries

---

## 10. Adaptive Prompt Complexity

System prompts now scale based on model context window size.

- [ ] Check server logs for `"System prompt assembled"` entries — they now include a `tier` field
- [ ] Verify agents on large models (Claude, GPT-4o) show `tier: "full"` or `tier: "standard"`
- [ ] If any agent runs on a small-context model (<32K), verify `tier: "compact"` and that vault/tracker instructions are condensed
- [ ] Check for any `"System prompt exceeds 30% of context window"` warnings

---

## 11. XML Tool Call Recovery

Models that output tool calls as text (XML, JSON blocks) now get parsed into real tool calls.

- [ ] This only triggers for models that don't use native tool calling (some Ollama models, MiniMax)
- [ ] Check server logs for `"Extracted text-based tool calls (fallback)"` entries
- [ ] If triggered, verify the tool actually executed correctly

---

## 12. Pre-Route Capability Check

The auto-router now prefers models with tool support.

- [ ] If any agent uses auto-routing, check server logs for the router selection
- [ ] Look for `"Model lacks required capabilities, skipping"` if text-only models are in a tier
- [ ] Verify the selected model actually supports tools

---

## Quick Priority Order

Do these first (most likely to surface issues):
1. **Section 1** — Kelly vault access (was completely blocked last round)
2. **Section 2** — Model switch sanitization (new feature, needs validation)
3. **Section 7** — Turn time budget (already proved it works, just confirm Kevin isn't getting cut off)

Then these if time allows:
4. **Section 5** — Permission denials
5. **Section 8** — Agent termination notification
6. **Sections 3, 4, 6** — Nudging, boundaries, incomplete detection (opportunistic — trigger if you can)
7. **Sections 9-12** — Monitoring/logging checks (look for log entries during normal operation)
