# Healer Agent — Self-Healing for the DOJO Platform

## Overview

The Healer is a Sensei-tier system agent that runs on a user-configured schedule (like the Dreamer). Its job is to analyze the dojo's operational health, identify recurring problems, and either fix them automatically or propose fixes for user approval. Over time, the Healer learns which fixes work and which the user prefers to handle differently — making the dojo increasingly self-maintaining.

## Why This Exists

Today, when something goes wrong in the dojo — an agent gets stuck, a model switch corrupts message history, the PM crashes in an error loop — nothing happens until a human notices, digs through logs, and manually intervenes. The Healer closes that gap.

---

## Architecture

### Agent Design

- **Type:** Sensei, persistent (like the Dreamer, PM, Trainer, Imaginer)
- **Schedule:** User-configurable time, default 04:00 (one hour after the Dreamer's default 03:00)
- **Model:** User-configurable, defaults to a mid-tier model (needs good reasoning, doesn't need to be frontier)
- **Permissions:** File read (logs), exec (limited — read-only system commands), all tracker tools, vault, send_to_agent, list_agents
- **No file write, no spawning, no exec of arbitrary commands** — the Healer fixes things through the dojo's own tools (resetting sessions, updating statuses, sending messages), not by writing code or running scripts

### How It Runs

Same pattern as the Dreamer:

1. Server calculates next run time from config (`healer_time`)
2. `setTimeout` schedules the run
3. When it fires, the Healer agent is spawned (or woken if persistent)
4. The engine compiles a **Diagnostic Report** and delivers it as the Healer's input message
5. The Healer analyzes, triages, and acts
6. When done, calls `complete_task` and goes idle until next cycle

---

## The Diagnostic Report

The engine (not the LLM) compiles this report from real data. The Healer receives it as its input each cycle. This is the critical piece — the report must be structured, factual, and actionable.

### Data Sources

```
1. Error log digest (last 24h)
   - Grouped by: agent, error type, frequency
   - Example: "kelly: MODEL_CALL_FAILED x12 (Minimax midstream error: tool id not found)"
   - Example: "kevin: TURN_TIME_EXCEEDED x1"

2. Agent status anomalies
   - Agents in 'error' or 'paused' state and how long they've been there
   - Agents in 'working' state for >10 minutes (potential stuck)
   - Agents with 0 successful turns in the last 24h despite receiving messages

3. Nudge/recovery events
   - Empty response nudges: which agents, how many, did they recover?
   - Repetition nudges: which agents, how many?
   - Incomplete response nudges: which agents, how many?
   - Error loop pauses: which agents, when, still paused?

4. Tool failure patterns
   - Tools that failed >3 times in 24h, grouped by error type
   - Permission denials: which agents hitting which permissions, repeatedly?
   - Malformed tool call args: which agents, which tools?

5. Model performance
   - Per-model: avg latency, error rate, XML fallback rate
   - Models that triggered rate limits
   - Models with >10% error rate

6. Context health
   - Agents with orphaned tool_use/tool_result pairs in recent messages
   - Agents whose context token count exceeds 80% of their model's window
   - Compaction failures in the last 24h

7. Inter-agent communication
   - send_to_agent failures
   - Auto-route reply failures
   - PM poke failures

8. Tracker health
   - Tasks stuck in 'in_progress' for >24h
   - Tasks assigned to terminated agents
   - Projects with all tasks complete but project still 'active'
```

### Report Format

```
═══ DOJO DAILY DIAGNOSTIC — 2026-04-14 04:00 ═══

CRITICAL (requires immediate action):
  1. [AGENT_ERROR_LOOP] kelly — paused for 6 hours (since 22:00 yesterday)
     Error: MODEL_CALL_FAILED x5 in 2 min (Minimax tool id rejection)
     Root cause: Orphaned tool_result messages with synthetic IDs in context
     
  2. [STUCK_AGENT] test-bot-3 — 'working' for 14 hours
     Last activity: 14:00 yesterday
     Likely cause: Runtime crash without cleanup

WARNINGS (degraded but functional):
  3. [HIGH_ERROR_RATE] gemma4:31b — 23% error rate (7/30 calls failed)
     Errors: 5x timeout, 2x empty response
     Affected agents: kevin, dave-jr
     
  4. [NUDGE_HEAVY] kelly — 8 empty response nudges, 3 incomplete nudges
     Model: qwen3.5-9b
     May indicate model is too weak for PM workload

  5. [TRACKER_STALE] 2 tasks in_progress >24h
     - "Build landing page" assigned to dave-jr (36h)
     - "Write API docs" assigned to kevin (28h)

INFO (no action needed):
  6. [COMPACTION_OK] 3 successful compactions, 0 failures
  7. [DREAMER_OK] Dream cycle completed at 03:12, 4 archives processed
  8. [BUDGET_OK] $0.87 of $25 daily budget used (3.5%)

═══ END DIAGNOSTIC ═══
```

---

## The Three Tiers

### Tier 1: Auto-Fix (Healer just does it)

These are safe, reversible, and well-understood:

| Fix | Trigger | Action |
|-----|---------|--------|
| Reset stuck agent | Agent in 'working' >10 min, no recent activity | Set status to 'idle', clear activeRuns |
| Resume paused agent | Agent paused by error loop, errors stopped >30 min ago | Set status to 'idle', clear error records |
| Clean orphaned tool messages | Agent has tool_use/tool_result pairs with mismatched IDs | Run model-switch sanitizer on the agent |
| Prune PM messages | PM has >20 messages | Delete oldest, keep 10 |
| Complete orphaned projects | All tasks complete but project status still 'active' | Set project to 'complete' |
| Reassign orphaned tasks | Task assigned to terminated agent | Unassign (set assigned_to to NULL), notify primary |
| Clear stale rate limit status | Agent in 'rate_limited' >1 hour, no active retry | Set status to 'idle' |

After each auto-fix, the Healer logs what it did, sends a brief note to the primary agent, and records the fix in the `healer_log` table.

### Tier 2: Suggest to Primary Agent

These are probably right but the Healer wants Kevin to validate:

| Suggestion | Trigger | Message to Primary |
|------------|---------|-------------------|
| Model underperforming | >20% error rate or >50% nudge rate over 24h | "Kelly's model (qwen3.5-9b) had 8 empty responses in 24h. Consider switching to a more capable model." |
| Agent not responding | Agent received messages but produced 0 responses in 24h | "dave-jr received 3 messages but never responded. Check if the model is loaded in Ollama." |
| Permission pattern | Same agent denied same tool >5 times | "dave-jr tried file_write 7 times and was denied each time. Either the task needs different permissions or a different approach." |

### Tier 3: Propose to User (Dashboard Approval)

These are fixes the Healer is uncertain about, or that change configuration:

| Proposal | Trigger | Dashboard Display |
|----------|---------|-------------------|
| Switch agent model | Persistent failures on current model | "Kelly's model (MiniMax M2.7) fails 40% of tool calls. **Proposed fix:** Switch to Claude Haiku. [Approve] [Deny + Note]" |
| Increase turn time budget | Agent repeatedly hitting time limit | "Kevin hit the 15-min turn budget 3 times today on Ollama. **Proposed fix:** Increase to 25 min. [Approve] [Deny + Note]" |
| Adjust poke thresholds | PM poking too aggressively for slow models | "Kelly poked dave-jr 6 times for tasks that completed within 20 min. **Proposed fix:** Increase normal-priority first-poke from 5 min to 10 min. [Approve] [Deny + Note]" |
| Add tool permission | Agent repeatedly blocked on a tool it needs | "dave-jr needs file_write for its current task but doesn't have permission. **Proposed fix:** Grant file_write to ~/projects/**. [Approve] [Deny + Note]" |

---

## Dashboard: Vitals Panel

### Location

New section in the **Health** page, above the log viewer. Collapsed by default, with a badge showing pending proposals count.

### Layout

```
┌─────────────────────────────────────────────────────┐
│ Healer Proposals (2 pending)                    ▼   │
├─────────────────────────────────────────────────────┤
│                                                     │
│  ⚠ Switch Kelly's model from MiniMax M2.7           │
│    Kelly's current model fails 40% of tool calls    │
│    due to incompatible tool ID formats.             │
│    Proposed fix: Switch to Claude Haiku             │
│    Confidence: 85%                                  │
│    [Approve]  [Deny]                                │
│                                                     │
│  ⚠ Increase turn time budget to 25 min              │
│    Kevin hit the 15-min budget 3 times today on     │
│    Ollama (gemma4:31b). Each turn needed ~18 min    │
│    for multi-step tool chains.                      │
│    Proposed fix: Increase TURN_TIME_BUDGET_MS       │
│    Confidence: 70%                                  │
│    [Approve]  [Deny]                                │
│                                                     │
├─────────────────────────────────────────────────────┤
│ Recent Healer Actions (auto-fixes)                  │
│  ✓ Reset stuck agent test-bot-3 (was working 14h)   │
│  ✓ Cleaned 4 orphaned tool messages from kelly      │
│  ✓ Resumed kelly after error loop cooldown          │
│  ✓ Completed orphaned project "Dream Cycle 04-12"   │
└─────────────────────────────────────────────────────┘
```

### Deny Flow

When the user clicks **Deny**:

1. A text input expands: "What would you prefer instead? (optional)"
2. User types their note (or leaves blank)
3. On submit:
   - Proposal marked as `denied` in the `healer_proposals` table
   - A message is sent to the primary agent:
     ```
     [SOURCE: HEALER PROPOSAL DENIED — the user denied a proposed fix and may want to discuss alternatives]
     
     Denied proposal: Switch Kelly's model from MiniMax M2.7 to Claude Haiku
     Reason from Healer: Kelly's current model fails 40% of tool calls
     User's note: "Don't switch the model. Clear the bad messages instead — I want to keep MiniMax."
     
     Please discuss this with the user and figure out the right solution.
     If you resolve it, let the Healer know what was done so it learns for next time.
     ```
   - Primary agent picks up the conversation with the user
   - Whatever gets resolved, the Healer sees the outcome on its next cycle (via vault search for "healer proposal denied") and adjusts future proposals

### Approve Flow

When the user clicks **Approve**:

1. Proposal marked as `approved` in the `healer_proposals` table
2. On the Healer's next cycle, it checks for approved proposals and executes them
3. After execution, marks as `completed` with a result summary
4. The action appears in "Recent Healer Actions" list

---

## Database Schema

```sql
-- Healer configuration (same pattern as dreaming config — rows in config table)
-- Keys: healer_time, healer_model_id, healer_mode ('active' | 'monitor' | 'off')

-- Diagnostic snapshots
CREATE TABLE healer_diagnostics (
  id TEXT PRIMARY KEY,
  report TEXT NOT NULL,          -- Full diagnostic report text
  critical_count INTEGER DEFAULT 0,
  warning_count INTEGER DEFAULT 0,
  info_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Proposals requiring user approval
CREATE TABLE healer_proposals (
  id TEXT PRIMARY KEY,
  diagnostic_id TEXT,            -- Which diagnostic cycle spawned this
  category TEXT NOT NULL,        -- 'model_switch', 'config_change', 'permission_grant', etc.
  severity TEXT NOT NULL,        -- 'critical', 'warning', 'info'
  title TEXT NOT NULL,           -- Short description for dashboard
  description TEXT NOT NULL,     -- Full explanation
  proposed_fix TEXT NOT NULL,    -- What the Healer wants to do (plain language)
  fix_action TEXT,               -- JSON: structured action the Healer will execute if approved
  confidence INTEGER,            -- 0-100 estimated success rate
  status TEXT DEFAULT 'pending', -- 'pending', 'approved', 'denied', 'completed', 'expired'
  user_note TEXT,                -- User's note when denying
  result_summary TEXT,           -- What happened after execution
  agent_id TEXT,                 -- Which agent this concerns (if applicable)
  created_at TEXT DEFAULT (datetime('now')),
  resolved_at TEXT
);

-- Auto-fix log (Tier 1 actions the Healer took without approval)
CREATE TABLE healer_actions (
  id TEXT PRIMARY KEY,
  diagnostic_id TEXT,
  category TEXT NOT NULL,
  description TEXT NOT NULL,
  agent_id TEXT,                 -- Which agent was affected
  action_taken TEXT NOT NULL,    -- What was done
  result TEXT,                   -- 'success', 'failed', 'partial'
  created_at TEXT DEFAULT (datetime('now'))
);
```

---

## Healer SOUL Template

```markdown
# Identity

You are Healer, the dojo's self-healing agent. You analyze operational health data, fix routine problems automatically, and propose solutions for complex issues.

# Rules

- You run on a schedule, not continuously. Each cycle, you receive a diagnostic report.
- You have THREE response tiers. Follow them strictly:

## Tier 1 — Auto-Fix (do it yourself, no approval needed)
- Reset agents stuck in 'working' state
- Resume agents paused by error loops (if errors stopped >30 min ago)
- Clean orphaned tool messages from agent contexts
- Prune oversized PM message history
- Complete orphaned projects (all tasks done but project still active)
- Reassign tasks from terminated agents
- Clear stale rate-limited status

After each auto-fix, call healer_log_action to record what you did.

## Tier 2 — Suggest to Primary (send_to_agent to the primary agent)
- Model underperformance (high error rates, frequent nudges)
- Agents not responding to messages
- Repeated permission denial patterns

Keep suggestions brief and actionable. the primary agent is busy.

## Tier 3 — Propose to User (call healer_propose)
- Model switches
- Config changes (time budgets, poke thresholds)
- Permission grants
- Anything you're less than 70% confident about

Include: what's wrong, why, what you'd do, and your confidence level (0-100).

# Learning

Before proposing a fix, search the vault for previous proposals on the same topic.
If a similar fix was denied before, check what the user said and adjust your approach.
If a similar fix was approved and worked, increase your confidence.
After every cycle, vault_remember a brief summary of what you found and did.

# What You Never Do

- Never modify SOUL.md, USER.md, or any prompt files (that's the Dreamer's job)
- Never spawn agents or kill agents
- Never execute arbitrary shell commands
- Never change secrets or API keys
- Never make changes that require a server restart
- Keep messages short. You're a medic, not a therapist.
```

---

## Settings UI

In the **Sensei** tab of Settings (alongside Dreaming and Imaginer), add a **Healing** card:

```
┌─────────────────────────────────────┐
│ Healing                             │
│                                     │
│ The Healer agent analyzes daily     │
│ health data, auto-fixes routine     │
│ issues, and proposes solutions for  │
│ complex problems.                   │
│                                     │
│ Healer Model: [dropdown]            │
│ Mid-tier recommended.               │
│                                     │
│ Healing Time: [08:00]               │
│ When the Healer runs each day.      │
│ Default: 04:00 (after Dreamer).     │
│                                     │
│ Mode: ● Active  ○ Monitor  ○ Off   │
│ Active: auto-fix + proposals        │
│ Monitor: report only, no fixes      │
│                                     │
│ [Save]                              │
│                                     │
│ Last cycle: Apr 13, 4:02 AM         │
│ Fixed: 3 issues | Proposed: 2       │
│ [View Report]                       │
└─────────────────────────────────────┘
```

---

## API Routes

```
GET  /api/healer/config           — Get healer settings
POST /api/healer/config           — Update healer settings
GET  /api/healer/proposals        — List pending/recent proposals
POST /api/healer/proposals/:id    — Approve or deny a proposal { action: 'approve' | 'deny', note?: string }
GET  /api/healer/actions          — List recent auto-fix actions
GET  /api/healer/diagnostics      — Get latest diagnostic report
POST /api/healer/run              — Trigger an immediate healer cycle (for testing)
```

---

## Implementation Phases

### Phase A — Foundation (engine-level, no LLM)
1. Diagnostic report compiler — reads logs, DB, aggregates into structured report
2. Database tables (`healer_diagnostics`, `healer_proposals`, `healer_actions`)
3. Config keys (`healer_time`, `healer_model_id`, `healer_mode`)
4. Schedule timer (same pattern as Dreamer)
5. API routes for config and proposals

### Phase B — Auto-Fix Engine (still no LLM)
1. Implement Tier 1 auto-fixes as deterministic functions
2. These run BEFORE the LLM cycle — they don't need AI reasoning
3. Log actions to `healer_actions` table
4. Notify primary agent of auto-fixes via system message

### Phase C — Healer Agent (LLM)
1. HEALER-SOUL.md template
2. Agent spawn/wake on schedule
3. Healer receives diagnostic report as input
4. Healer tools: `healer_log_action`, `healer_propose`, vault, tracker, send_to_agent, list_agents
5. Healer analyzes report, handles Tier 2 (suggestions) and Tier 3 (proposals)

### Phase D — Dashboard UI
1. Vitals panel on Health page (proposals list, auto-fix log)
2. Approve/Deny flow with user note
3. Deny → message to primary agent
4. Healing card in Settings (Sensei tab)

### Phase E — Learning Loop
1. Healer searches vault for past proposals before making new ones
2. Tracks proposal outcomes (approved→worked, approved→failed, denied→user note)
3. Adjusts confidence based on history
4. Eventually: auto-promote recurring approved fixes to Tier 1
