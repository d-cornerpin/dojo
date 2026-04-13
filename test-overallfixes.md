# Testing the Overall Fixes — Kevin's Checklist

You have a set of platform improvements to test on the dev server. Work through each section below, check the box when it passes, and note any failures. You don't need to test them in order — pick whatever makes sense.

---

## 1. PM Agent Tools Access (Fix 6.0)

The PM agent was told to use the vault but didn't have permission. Now it does.

- [ ] Open Rick's chat in the dashboard
- [ ] Send Rick a message: "Check the vault for any previous project context"
- [ ] Verify Rick calls `vault_search` successfully (not "permission denied" or "tool not available")
- [ ] Send Rick: "Remember that this is a test cycle for the overall fixes"
- [ ] Verify Rick calls `vault_remember` successfully
- [ ] Send Rick: "Search your memory for any recent tracker activity"
- [ ] Verify Rick can call `memory_grep` successfully

---

## 2. Tracker List Filter (Fix 6.1)

The filter on `tracker_list_active` was broken — always returned everything.

- [ ] Create a test project with 2-3 tasks assigned to different agents
- [ ] Ask Kevin: "Show me my active tasks" — he should call `tracker_list_active(filter="mine")`
- [ ] Verify it only shows tasks assigned to Kevin, not all tasks
- [ ] Ask Kevin: "Show me blocked tasks" — verify it filters to blocked only
- [ ] Verify task listings now show truncated descriptions under each task title (the `→` lines)
- [ ] Verify the "Tip: Call tracker_get_status..." line appears at the bottom

---

## 3. Task Assignment Notification (Fix 6.3)

When a task is assigned to an agent, that agent now gets a message with instructions.

- [ ] Ask Kevin to create a task and assign it to another agent (e.g., Dave Jr)
- [ ] Open Dave Jr's chat in the dashboard
- [ ] Verify a `[SOURCE: TRACKER TASK ASSIGNMENT]` message appeared with the task title, ID, description, and instructions on how to complete/block it
- [ ] Verify Dave Jr started working on the task automatically (status changed to "working")

---

## 4. Structured Tool Results (Fix 1.3)

Tracker tools now return `[OK] key=value` headers.

- [ ] Ask Kevin to create a project — verify the response starts with `[OK] project_id=... | title=...`
- [ ] Ask Kevin to create a task — verify `[OK] task_id=... | title=...`
- [ ] Ask Kevin to check a task status — verify `[OK] task_id=... | status=... | priority=...`
- [ ] Ask Kevin to complete a step — verify `[OK] task_id=... | status=complete`
- [ ] Verify Kevin can parse these IDs and use them in follow-up tool calls without confusion

---

## 5. PM Review with Descriptions (Fix 6.4)

The PM now sees task descriptions in its review messages.

- [ ] Create a task with a detailed description (e.g., "Research the top 5 competitors and summarize their pricing models")
- [ ] Wait for Rick's next review cycle (up to 10 minutes) or trigger it by sending Rick "Do a tracker review"
- [ ] Check Rick's chat — the review message should include `Instructions: Research the top 5 competitors...` under the task line

---

## 6. Stuck Model Nudging (Fix 1.2)

Agents now get nudged instead of silently stopping when stuck.

- [ ] If you have access to a weak model (Ollama local, etc.), assign it to a test agent
- [ ] Give the test agent a task that might cause repetition or empty responses
- [ ] Check the agent's chat for `[System: You are repeating yourself...]` or `[System: You returned an empty response...]` nudge messages
- [ ] Verify the agent gets ONE retry after the nudge before stopping
- [ ] Verify a `chat:error` banner appears in the dashboard when the agent finally stops

**If you can't trigger this naturally:** You can verify the logic exists by checking that the nudge messages and broadcasts are in the code. The important thing is that agents no longer silently idle.

---

## 7. Malformed Tool Call Recovery (Fix 1.1)

Models that produce bad JSON for tool arguments now get a clear error instead of silent failure.

- [ ] If you have a weak model available, try asking it to use a complex tool (like `spawn_agent` or `tracker_create_project`)
- [ ] If it produces malformed JSON, verify the error message says "Your tool call arguments were malformed JSON" and suggests `load_tool_docs`
- [ ] Verify the agent retries the tool call after seeing the error

**If you can't trigger this naturally:** The fix is defensive — it only fires when JSON parsing fails. On strong models it won't activate.

---

## 8. Context Boundary Markers (Fix 2.1)

Summaries in context are now wrapped with clear markers.

- [ ] Have a long conversation with Kevin (enough to trigger compaction — check the Health page for compaction events)
- [ ] After compaction, send Kevin a new message
- [ ] Check the server logs (debug level) for the assembled context — look for `═══ COMPRESSED HISTORY ═══` and `═══ END COMPRESSED HISTORY ═══` markers wrapping the summaries

**Alternative check:** Ask Kevin "What do you remember from our earlier conversation?" — if summaries are present, Kevin should reference them naturally without confusing them with live messages.

---

## 9. Permission Denial Messages (Fix 2.3)

Denied tool calls now say `[BLOCKED]` with concrete alternatives.

- [ ] Find or create a sub-agent with restricted permissions (e.g., no file write access)
- [ ] Ask it to write a file
- [ ] Verify the error starts with `[BLOCKED] Permission denied:` and includes the 3 numbered alternatives
- [ ] Verify the agent does NOT retry the same blocked operation

---

## 10. Turn Time Budget (Fix 4.1)

Turns are now limited to 5 minutes.

- [ ] This is hard to trigger on strong models — mostly a safety net for weak/slow models
- [ ] If you can create a scenario with many sequential tool calls, watch for the `[System: This turn exceeded the 5 minute time budget...]` message
- [ ] Check server logs for `Turn time budget exceeded` warnings

---

## 11. Incomplete Response Detection (Fix 3.6)

Agents that stop mid-sentence now get nudged to continue.

- [ ] If you have a weak model, give it a complex question that might produce a truncated response
- [ ] Verify a `[System: Your response appears incomplete...]` nudge appears
- [ ] Verify the agent continues its response after the nudge

---

## 12. Newline Sanitization (Fix 3.3)

Literal `\n` strings and excessive whitespace are cleaned up.

- [ ] If you have a weak model that produces literal `\n` in text, verify they're converted to real newlines
- [ ] Check iMessage replies for clean formatting (no `**bold**` markdown syntax, no triple+ newlines)

---

## 13. Inter-Agent Messaging (Fix 3.8)

Auto-route reply detection now uses a DB column instead of regex.

- [ ] Ask Kevin to message another agent (e.g., "Send Dave Jr a message asking how his task is going")
- [ ] Wait for Dave Jr to reply
- [ ] Verify Kevin sees Dave Jr's reply (this was the original inter-agent bug)
- [ ] Verify the auto-route fires correctly — if Dave Jr responds with text but forgets `send_to_agent`, the reply should still reach Kevin automatically
- [ ] Check the dashboard — both sides of the conversation should be visible in each agent's chat

---

## 14. Adaptive Prompt Complexity (Fix 2.2)

System prompts now scale based on model context window.

- [ ] Check server logs for `System prompt assembled` entries — they should now include a `tier` field (full/standard/compact/minimal)
- [ ] If you have agents on different models, verify that smaller-context models get `compact` or `minimal` tier
- [ ] Check for `System prompt exceeds 30% of context window` warnings in logs for any small models

---

## 15. Pre-Route Capability Check (Fix 1.4)

The auto-router now prefers models with tool support.

- [ ] If you have auto-routed agents, verify in server logs that the router logs include capability filtering
- [ ] Look for `Model lacks required capabilities, skipping` in debug logs if a text-only model is in the tier

---

## 16. Stuck Agent Recovery (Fix 7.5)

Agents stuck in "working" state are now auto-recovered.

- [ ] Check server logs at startup for `Recovered stuck agent` messages (if any agents were stuck from before)
- [ ] The recovery runs every 5 minutes — if an agent is stuck for 10+ minutes, it should reset to idle

---

## 17. Agent Termination Notification (Fix 7.2)

The chat view now shows when an agent is terminated.

- [ ] Spawn a test sub-agent with a short timeout (e.g., 2 minutes)
- [ ] Wait for it to timeout and terminate
- [ ] Verify the chat view shows "Agent terminated: [reason]" in the error banner

---

## 18. Error Loop Notification (Fix 7.3)

When an agent is paused due to repeated errors, the chat now shows why.

- [ ] If you can trigger 5 errors in 2 minutes on an agent (e.g., a model that's down), verify the chat shows "Agent paused: 5 errors in 120 seconds"
- [ ] This is primarily a safety net — you may not be able to trigger it in normal testing

---

## 19. XML Tool Call Recovery (Fix 3.7)

Expanded fallback patterns for models that output tool calls as text.

- [ ] If you have a model that occasionally outputs XML-style tool calls (MiniMax, some Ollama models), verify they still get executed
- [ ] Check server logs for `Extracted text-based tool calls (fallback)` entries

---

## Quick Smoke Test (Do This First)

Before diving into individual tests, do a quick end-to-end check:

1. [ ] Start the dev server (`npm run dev`)
2. [ ] Open the dashboard — verify it loads without errors
3. [ ] Send Kevin a message — verify he responds normally
4. [ ] Ask Kevin to create a project with tasks — verify the tracker works
5. [ ] Check Rick's chat — verify he's running and has vault access
6. [ ] Send a message to a sub-agent — verify inter-agent messaging works
7. [ ] Check the Health page — verify no errors in logs
