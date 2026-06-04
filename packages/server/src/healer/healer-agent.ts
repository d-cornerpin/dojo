// ════════════════════════════════════════
// Healer Agent — Self-Healing Orchestrator
//
// Manages the healing cycle: compile diagnostic,
// run auto-fixes, then wake the permanent Healer
// agent for Tier 2-3 analysis.
//
// The Healer is a permanent resident of Masters
// (like the Trainer and Imaginer). It stays idle
// between cycles and wakes when a cycle fires.
// ════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { broadcast } from '../gateway/ws.js';
import { compileDiagnosticReport } from './diagnostic.js';
import { runAutoFixes } from './auto-fix.js';
import { getAgentRuntime } from '../agent/runtime.js';
import type { Message } from '@dojo/shared';
import {
  getPrimaryAgentId,
  getHealerAgentId,
  getHealerAgentName,
  isSetupCompleted,
} from '../config/platform.js';

const logger = createLogger('healer-agent');
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── v2.3.19 (error-handling-spec Phase 3) — Dreamer-pattern budget ──
//
// The Healer must never receive a runaway cycle message that blows its
// context window. Constants mirror the Dreamer's approach in
// vault/maintenance.ts. Per-collector caps are enforced in diagnostic.ts;
// these constants are for the TOTAL cycle-message ceiling.
const CHARS_PER_TOKEN = 3;             // conservative — same as Dreamer
const HEALER_CONTEXT_OVERHEAD_TOKENS = 40_000; // sys prompt + tool schemas + vault retrieval
const HEALER_PROCESSING_GROWTH_FACTOR = 1.3;   // Healer makes fewer tool calls than Dreamer
const HEALER_BATCH_BUDGET_CAP_RATIO = 0.35;    // hard ceiling: 35% of context for diagnostic payload
const HEALER_FALLBACK_CONTEXT_WINDOW = 200_000; // sane default if we can't look up the model's window

function getHealerContextWindow(modelId: string | null): number {
  if (!modelId || modelId === 'auto') return HEALER_FALLBACK_CONTEXT_WINDOW;
  try {
    const db = getDb();
    const row = db
      .prepare('SELECT context_window FROM models WHERE id = ?')
      .get(modelId) as { context_window: number | null } | undefined;
    if (row?.context_window && row.context_window > 0) return row.context_window;
  } catch { /* */ }
  return HEALER_FALLBACK_CONTEXT_WINDOW;
}

interface BuildCycleMessageOptions {
  reportText: string;
  approvedSection: string;
  autoFixCount: number;
  contextWindow: number;
}

interface BuildCycleMessageResult {
  message: string;
  contextWindow: number;
  /** True if the report text was trimmed to fit the budget. */
  trimmed: boolean;
}

/**
 * Compose the Healer's cycle message under a strict char budget. If the
 * composed text would exceed the budget, the diagnostic REPORT is
 * truncated (with a marker) so approved proposals + instructions are
 * preserved — those are the highest-value content.
 */
function buildHealerCycleMessage(opts: BuildCycleMessageOptions): BuildCycleMessageResult {
  const { reportText, approvedSection, autoFixCount, contextWindow } = opts;

  // Budget calculation mirrors Dreamer's batchArchives (vault/maintenance.ts).
  const overheadChars = HEALER_CONTEXT_OVERHEAD_TOKENS * CHARS_PER_TOKEN;
  const availableTokens = contextWindow - HEALER_CONTEXT_OVERHEAD_TOKENS;
  const rawBudget = Math.max(0, availableTokens / HEALER_PROCESSING_GROWTH_FACTOR);
  const ratioCap = contextWindow * HEALER_BATCH_BUDGET_CAP_RATIO;
  const tokenBudget = Math.min(rawBudget, ratioCap);
  const charBudget = Math.floor(tokenBudget * CHARS_PER_TOKEN);

  const instructions =
    `\n\n${autoFixCount > 0 ? `Note: ${autoFixCount} auto-fix(es) were already applied before this report was delivered to you. Focus on the remaining issues.\n\n` : ''}` +
    `For each issue in the diagnostic:\n` +
    `1. Search the vault for past healer context on similar issues\n` +
    `2. Fix it yourself, propose it to the user (healer_propose), or log and skip it (healer_log_action)\n` +
    `3. Do NOT message other agents for advice — you are the diagnostician\n` +
    `4. When done with all issues, call complete_task with a summary`;

  const fixedOverhead = approvedSection.length + instructions.length;
  const reportBudget = charBudget - fixedOverhead;

  let trimmed = false;
  let reportPayload = reportText;
  if (reportPayload.length > reportBudget && reportBudget > 500) {
    const head = reportPayload.slice(0, Math.floor(reportBudget * 0.65));
    const tail = reportPayload.slice(-Math.floor(reportBudget * 0.25));
    reportPayload =
      `${head}\n\n[…${reportPayload.length - head.length - tail.length} chars elided for context budget…]\n\n${tail}`;
    trimmed = true;
  }

  const message = `${reportPayload}${approvedSection}${instructions}`;
  return { message, contextWindow, trimmed };
}

export type HealerMode = 'active' | 'monitor' | 'off';

// ── Config ──

export function getHealerConfig(): {
  modelId: string | null;
  healerTime: string;
  healerMode: HealerMode;
  /** v2.3.19 — true when the Healer and primary agent share a provider.
   *  If their provider goes down both Healers go down at once, defeating
   *  the cross-provider isolation that's the whole point of having a
   *  separate Healer model. The dashboard surfaces a Settings warning
   *  when this is true. */
  providerSharedWithPrimary: boolean;
  primaryProviderName: string | null;
  healerProviderName: string | null;
} {
  const db = getDb();
  const modelRow = db.prepare("SELECT value FROM config WHERE key = 'healer_model_id'").get() as { value: string } | undefined;
  const timeRow = db.prepare("SELECT value FROM config WHERE key = 'healer_time'").get() as { value: string } | undefined;
  const modeRow = db.prepare("SELECT value FROM config WHERE key = 'healer_mode'").get() as { value: string } | undefined;

  // Provider-isolation check. Resolve each model to its provider name.
  // Pre-spec the dashboard surfaced no warning for this, so users could
  // unknowingly run both agents on Anthropic and lose every recovery
  // path the moment Anthropic flapped.
  let primaryProviderName: string | null = null;
  let healerProviderName: string | null = null;
  let providerSharedWithPrimary = false;
  try {
    const primaryId = getPrimaryAgentId();
    const primaryAgent = db.prepare('SELECT model_id FROM agents WHERE id = ?').get(primaryId) as { model_id: string | null } | undefined;
    const healerModelId = modelRow?.value ?? primaryAgent?.model_id ?? null;

    if (primaryAgent?.model_id) {
      const row = db.prepare(`
        SELECT p.name FROM models m
        JOIN providers p ON p.id = m.provider_id
        WHERE m.id = ?
      `).get(primaryAgent.model_id) as { name: string } | undefined;
      primaryProviderName = row?.name ?? null;
    }
    if (healerModelId) {
      const row = db.prepare(`
        SELECT p.name FROM models m
        JOIN providers p ON p.id = m.provider_id
        WHERE m.id = ?
      `).get(healerModelId) as { name: string } | undefined;
      healerProviderName = row?.name ?? null;
    }
    if (primaryProviderName && healerProviderName && primaryProviderName === healerProviderName) {
      providerSharedWithPrimary = true;
    }
  } catch { /* best effort */ }

  return {
    modelId: modelRow?.value ?? null,
    healerTime: timeRow?.value ?? '04:00',
    healerMode: (modeRow?.value as HealerMode) ?? 'active',
    providerSharedWithPrimary,
    primaryProviderName,
    healerProviderName,
  };
}

export function setHealerConfig(config: { modelId?: string; healerTime?: string; healerMode?: HealerMode }): void {
  const db = getDb();
  const upsert = db.prepare(`
    INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')
  `);

  if (config.modelId !== undefined) {
    upsert.run('healer_model_id', config.modelId, config.modelId);
  }
  if (config.healerTime !== undefined) {
    upsert.run('healer_time', config.healerTime, config.healerTime);
  }
  if (config.healerMode !== undefined) {
    upsert.run('healer_mode', config.healerMode, config.healerMode);
  }
}

// ── Default Model ──

function getDefaultHealerModel(): string | null {
  const db = getDb();
  const model = db.prepare(`
    SELECT id FROM models WHERE is_enabled = 1
    ORDER BY
      CASE WHEN api_model_id LIKE '%sonnet%' THEN 0
           WHEN api_model_id LIKE '%gpt-4o%' THEN 1
           WHEN api_model_id LIKE '%haiku%' THEN 2
           ELSE 3 END,
      input_cost_per_m ASC
    LIMIT 1
  `).get() as { id: string } | undefined;
  return model?.id ?? null;
}

// ── SOUL Template ──

function loadHealerSoulPrompt(): string {
  const templatePaths = [
    path.resolve(__dirname, '../../../../templates/HEALER-SOUL.md'),
    path.resolve(__dirname, '../../../templates/HEALER-SOUL.md'),
  ];

  for (const templatePath of templatePaths) {
    try {
      if (fs.existsSync(templatePath)) {
        return fs.readFileSync(templatePath, 'utf-8');
      }
    } catch { /* try next */ }
  }

  // Fallback
  return `# Identity

You are the Healer, the dojo's self-healing agent. You have two jobs:

1. **Daily diagnostics:** Analyze operational health data, fix routine problems, propose solutions for complex issues.
2. **Injury recovery:** When an agent goes down (error/injured status), you receive an alert with the error details. Your job is to diagnose the problem and get the agent back on its feet.

# Injury Recovery

When you receive an \`[INJURY ALERT]\`, an agent has been down for 5+ minutes and hasn't recovered on its own. Follow this procedure:

1. **Read the error type and message** in the alert. This tells you what went wrong.
2. **For transient errors** (rate limits, network issues, timeouts, 5xx errors):
   - The issue has likely resolved itself. Poke the agent with \`send_to_agent\` using \`intent="QUESTION"\` (without that intent the message defaults to FYI and the agent will NOT wake to retry). Tell them what happened and ask them to check \`tracker_list_active\` and resume where they left off.
   - Example: \`send_to_agent(agent="[agent_id]", intent="QUESTION", payload="You hit a rate limit 5 minutes ago and went offline. It should be cleared now — please check your tasks with tracker_list_active and continue working.")\`
3. **For context corruption** (malformed tool calls, invalid request errors, tool_use_id errors):
   - The agent's conversation history is likely corrupted. Use \`reset_session(agent_id="...")\` to clear their context and give them a fresh start. Then poke them to resume their tasks.
4. **For config errors** (wrong model, auth failures, API key issues):
   - You cannot fix these. Send an iMessage to the user via \`imessage_send\` explaining which agent is down and why. Keep it short: "[Agent name] is down due to [reason]. Needs manual fix in Settings."
5. **For unknown errors:**
   - Try poking the agent first. If that fails (you get another injury alert shortly after), use \`reset_session\`. If that also fails, alert the user via iMessage.

When you receive a \`[RECOVERY NOTICE]\`, the agent is back online. No action needed — just note it for context.

**After handling an injury:** Log what you did with \`healer_log_action\`, then end your turn. Do NOT keep checking on the agent — you'll get another injury alert if they go down again. If the recovered agent replies to your poke, do NOT respond. The exchange is done — log and move on. No acknowledgement loops.

# Daily Diagnostics

- You also run on a daily schedule. Each cycle, you receive a diagnostic report.
- Tier 1 auto-fixes have already been applied before you run.
- Focus on Tier 2 (suggestions to primary agent) and Tier 3 (proposals for user approval).
- Search the vault for previous proposals before making new ones.
- After every cycle, vault_remember a summary of what you found and did.

# Rules

- Keep messages short. You're a medic, not a therapist.
- Use \`list_agents\` to see the current state of all agents.
- Use \`send_to_agent\` with \`intent="QUESTION"\` to poke injured agents (other intents default to FYI which will NOT wake them).
- Use \`reset_session\` to clear corrupted agent context.
- Use \`imessage_send\` ONLY to alert the user about problems you cannot fix yourself.
- Do NOT message other agents for advice — you are the diagnostician.
- Do NOT touch the tracker. You have no tracker tools. Tasks are managed by the PM agent, not you.
- When done with a healing action, call complete_task to finish.
- Do NOT reply to agents that respond to your pokes. Log the result with healer_log_action and end your turn.`;
}

// ── Permanent Healer Agent Tools & Permissions ──

const HEALER_TOOLS_POLICY = JSON.stringify({
  allow: [
    // Diagnostic and healing
    'healer_propose',
    'healer_log_action',
    // v2.3.19 — Dreamer-style log access via engine helpers. NEVER read
    // healer-report-*.log directly; these helpers cap the response so
    // the Healer can't choke on its own history.
    'healer_recent_actions',
    'healer_action_detail',
    // v2.3.19 — close the audit loop on approved proposals.
    'healer_mark_applied',
    // Agent management — for injury recovery
    'list_agents',
    'send_to_agent',       // Poke injured agents to see if they can resume
    'reset_session',       // Clear corrupted context to heal stuck agents
    'imessage_send',       // Alert user when an agent can't be auto-healed
    // Vault
    'vault_remember', 'vault_search', 'vault_forget',
    // Memory
    'memory_grep', 'memory_describe', 'memory_search',
    // File + shell access. The Healer's whole purpose is to dig into
    // arbitrary problems and produce evidence-backed proposals. The
    // global denies in permissions.ts (healer log files, secrets.yaml)
    // are the only off-limits paths; everything else — the SQLite
    // database, audit logs, app logs, configs, agent message tables —
    // is fair game and frequently necessary to verify what the
    // diagnostic surfaced. `exec` is included so the Healer can run
    // `sqlite3 ~/.dojo/data/dojo.sqlite "SELECT ..."` to look up
    // structural fields (agent_type, config.persist, schedule_status)
    // that no tool wrapper currently exposes. The exec deny substring
    // 'secrets.yaml' still blocks `cat ~/.dojo/secrets.yaml` style
    // reads via shell.
    'file_read', 'file_list', 'exec',
    // Utility
    'load_tool_docs', 'get_current_time', 'complete_task',
  ],
});

const HEALER_PERMISSIONS = JSON.stringify({
  file_read: '*',
  file_write: '*',
  file_delete: 'none',
  exec_allow: ['*'],
  exec_deny: [],
  network_domains: '*',
  max_processes: 5,
  can_spawn_agents: false,
  can_assign_permissions: false,
  system_control: [],
});

// ── v2.3.19 (error-handling-spec Phase 3) — Healer self-watchdog ──
//
// The pre-spec system had a chicken-and-egg problem: if the Healer
// itself was injured, onAgentInjured exited early ("can't heal myself")
// and just iMessaged the user. Other agents that errored during the
// Healer outage stayed stuck because nothing else could deal with them.
//
// This watchdog runs every 5 minutes and, bypassing onAgentInjured's
// self-skip, applies the existing Tier 1 auto-fix logic to the Healer
// directly. If the Healer is stuck in 'error', 'paused', or has been
// 'working' too long, the watchdog resets it to idle. The Healer can
// then be re-engaged by the next normal cycle or any new injury.
//
// This is engine-level, deterministic, no LLM cost.

const HEALER_WATCHDOG_INTERVAL_MS = 5 * 60 * 1000;
const HEALER_WORKING_STUCK_MINUTES = 10;
let healerWatchdogTimer: ReturnType<typeof setInterval> | null = null;

function runHealerSelfWatchdog(): void {
  try {
    if (!isSetupCompleted()) return;
    const db = getDb();
    const healerId = getHealerAgentId();
    const row = db
      .prepare('SELECT id, name, status, updated_at FROM agents WHERE id = ?')
      .get(healerId) as { id: string; name: string; status: string; updated_at: string } | undefined;
    if (!row) return; // Healer doesn't exist yet; ensureHealerAgentRunning will create it

    let shouldReset = false;
    let reason = '';

    if (row.status === 'error') {
      shouldReset = true;
      reason = 'in error status';
    } else if (row.status === 'paused') {
      shouldReset = true;
      reason = 'in paused status';
    } else if (row.status === 'working') {
      const updatedMs = new Date(row.updated_at.replace(' ', 'T') + 'Z').getTime();
      if (Date.now() - updatedMs > HEALER_WORKING_STUCK_MINUTES * 60 * 1000) {
        shouldReset = true;
        reason = `stuck in working status for >${HEALER_WORKING_STUCK_MINUTES} min`;
      }
    }

    if (shouldReset) {
      db.prepare(`UPDATE agents SET status = 'idle', updated_at = datetime('now') WHERE id = ?`).run(healerId);
      broadcast({ type: 'agent:status', agentId: healerId, status: 'idle' });
      logger.warn('Healer self-watchdog reset Healer to idle', {
        healerId, healerName: row.name, prevStatus: row.status, reason,
      });
      // Also clear the per-agent backoff state for the Healer if any
      // (defensive — under normal flow this won't be set since the
      // Healer's onAgentInjured short-circuits, but if a future code path
      // changes that this keeps us safe).
      import('./injury-recovery.js').then((m) => {
        try { m.onAgentRecovered(healerId); } catch { /* */ }
      }).catch(() => { /* best effort */ });
    }
  } catch (err) {
    logger.error('Healer self-watchdog failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export function startHealerSelfWatchdog(): void {
  if (healerWatchdogTimer) return;
  healerWatchdogTimer = setInterval(runHealerSelfWatchdog, HEALER_WATCHDOG_INTERVAL_MS);
  // Also run once on startup so any state left over from a crash gets cleaned.
  setTimeout(runHealerSelfWatchdog, 30_000);
  // One-shot prune of stale archives at startup — catches accumulated
  // logs even if no new cycle ran in the retention window.
  setTimeout(pruneOldArchives, 60_000);
  logger.info('Healer self-watchdog started', { intervalMs: HEALER_WATCHDOG_INTERVAL_MS });
}

// ── Ensure Healer Agent Running ──

export function ensureHealerAgentRunning(): void {
  if (!isSetupCompleted()) {
    logger.info('Setup not completed, deferring Healer creation');
    return;
  }

  const db = getDb();
  const healerId = getHealerAgentId();
  const healerName = getHealerAgentName();
  const primaryId = getPrimaryAgentId();

  logger.info('Healer auto-spawn check triggered', { healerId, healerName });

  const primaryExists = db.prepare('SELECT id FROM agents WHERE id = ?').get(primaryId);
  if (!primaryExists) {
    logger.warn('Primary agent not yet created — deferring Healer spawn', { primaryId });
    setTimeout(() => ensureHealerAgentRunning(), 5000);
    return;
  }

  // Clean up any old temporary Healer agents (from before permanent resident approach)
  db.prepare("UPDATE agents SET status = 'terminated', updated_at = datetime('now') WHERE name = ? AND id != ?")
    .run(healerName, healerId);

  const existing = db.prepare('SELECT id, status FROM agents WHERE id = ?').get(healerId) as
    | { id: string; status: string }
    | undefined;

  if (existing && existing.status !== 'terminated') {
    logger.info('Healer agent already running', { status: existing.status });
    // Keep tools/permissions current on every boot
    db.prepare(
      "UPDATE agents SET tools_policy = ?, permissions = ?, updated_at = datetime('now') WHERE id = ?",
    ).run(HEALER_TOOLS_POLICY, HEALER_PERMISSIONS, healerId);
    return;
  }

  // Resolve model: use healer_model_id config if set, else primary agent's model
  const healerModelRow = db.prepare(
    "SELECT value FROM config WHERE key = 'healer_model_id'",
  ).get() as { value: string } | undefined;
  let modelId: string | null = healerModelRow?.value ?? null;
  if (!modelId) {
    const primary = db.prepare('SELECT model_id FROM agents WHERE id = ?').get(primaryId) as
      | { model_id: string | null }
      | undefined;
    modelId = primary?.model_id ?? null;
  }

  const systemPrompt = loadHealerSoulPrompt();

  if (existing) {
    // Reactivate from terminated
    db.prepare(`
      UPDATE agents SET
        name = ?,
        model_id = ?,
        status = 'idle',
        agent_type = 'persistent',
        parent_agent = ?,
        spawn_depth = 1,
        max_runtime = NULL,
        timeout_at = NULL,
        permissions = ?,
        tools_policy = ?,
        config = '{"persist":true,"shareUserProfile":true}',
        updated_at = datetime('now')
      WHERE id = ?
    `).run(healerName, modelId, primaryId, HEALER_PERMISSIONS, HEALER_TOOLS_POLICY, healerId);
    logger.info('Healer agent reactivated', { healerId, healerName });
  } else {
    // Create fresh
    db.prepare(`
      INSERT OR IGNORE INTO agents (id, name, model_id, system_prompt_path, status, config, created_by,
                          parent_agent, spawn_depth, agent_type, classification, max_runtime, timeout_at,
                          permissions, tools_policy, task_id, created_at, updated_at)
      VALUES (?, ?, ?, NULL, 'idle', '{"persist":true,"shareUserProfile":true}', ?,
              ?, 1, 'persistent', 'sensei', NULL, NULL,
              ?, ?, NULL, datetime('now'), datetime('now'))
    `).run(healerId, healerName, modelId, primaryId, primaryId, HEALER_PERMISSIONS, HEALER_TOOLS_POLICY);

    db.prepare(`
      INSERT OR IGNORE INTO messages (id, agent_id, role, content, created_at)
      VALUES (?, ?, 'system', ?, datetime('now'))
    `).run(uuidv4(), healerId, systemPrompt);

    logger.info('Healer agent created', { healerId, healerName });
  }
}

// ── Run Healing Cycle ──

export async function runHealingCycle(): Promise<{ diagnosticId: string; autoFixCount: number; llmTriggered: boolean }> {
  logger.info('Starting healing cycle');

  const config = getHealerConfig();

  // Step 1: Compile diagnostic report
  const report = compileDiagnosticReport();
  logger.info('Diagnostic compiled', {
    criticalCount: report.criticalCount,
    warningCount: report.warningCount,
    infoCount: report.infoCount,
  });

  // Step 2: Sweep pending proposals — anything that's no longer in the
  // current diagnostic is closed out as auto-resolved. Users don't check
  // the Healer block often, and a lot of intermittent issues clear on
  // their own (e.g., a transient provider failure, a stuck agent that
  // restarted, a model the user removed). Without this sweep those
  // proposals pile up forever, even after the underlying problem is
  // gone.
  let autoResolvedCount = 0;
  try {
    const db = getDb();
    const pending = db.prepare(
      `SELECT id, category, title, agent_id FROM healer_proposals WHERE status = 'pending'`,
    ).all() as Array<{ id: string; category: string; title: string; agent_id: string | null }>;
    if (pending.length > 0) {
      // Build a lookup of current diagnostic items by (code, title, agent_id).
      // Match keys are normalized so trailing punctuation / case drift
      // between runs doesn't accidentally re-flag a still-present issue
      // as resolved.
      const norm = (s: string): string => s.toLowerCase().trim().replace(/\s+/g, ' ');
      const currentKeys = new Set<string>();
      for (const item of report.items) {
        // Agent-scoped issues key on (code, agent). Global issues key
        // on (code, title) — title is the discriminator there.
        if (item.agentId) {
          currentKeys.add(`${item.code}::${item.agentId}`);
        }
        currentKeys.add(`${item.code}::${norm(item.title)}`);
      }
      for (const p of pending) {
        const stillPresent = p.agent_id
          ? currentKeys.has(`${p.category}::${p.agent_id}`)
            || currentKeys.has(`${p.category}::${norm(p.title)}`)
          : currentKeys.has(`${p.category}::${norm(p.title)}`);
        if (!stillPresent) {
          db.prepare(
            `UPDATE healer_proposals
             SET status = 'auto_resolved',
                 resolved_at = datetime('now'),
                 result_summary = 'Issue no longer detected in diagnostic — closed by sweep.'
             WHERE id = ? AND status = 'pending'`,
          ).run(p.id);
          autoResolvedCount++;
        }
      }
      if (autoResolvedCount > 0) {
        logger.info('Healer sweep auto-resolved stale proposals', {
          autoResolvedCount, pendingChecked: pending.length,
        });
      }
    }
  } catch (err) {
    logger.warn('Healer proposal sweep failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Step 3: Run auto-fixes (Tier 1) — no LLM needed
  let autoFixCount = 0;
  if (config.healerMode === 'active') {
    const autoResult = runAutoFixes(report.id, report.items);
    autoFixCount = autoResult.fixCount;
  }

  // Step 3: If there are warnings/critical items remaining, OR if there
  // are approved-but-not-yet-applied proposals waiting, wake the permanent
  // Healer agent. v2.3.19 — pre-spec, the Healer only fired when the
  // diagnostic found something to diagnose. If David approved a proposal
  // but no NEW issues came up, the proposal sat forever waiting for
  // Healer to execute it. Now any pending approval also triggers the
  // cycle.
  const remainingIssues = report.items.filter(i => i.severity !== 'info');
  const pendingApprovals = (() => {
    try {
      const row = getDb()
        .prepare(`SELECT COUNT(*) AS cnt FROM healer_proposals WHERE status = 'approved' AND applied_at IS NULL`)
        .get() as { cnt: number };
      return row.cnt;
    } catch { return 0; }
  })();
  let llmTriggered = false;

  if (config.healerMode === 'active' && (remainingIssues.length > 0 || pendingApprovals > 0)) {
    try {
      const db = getDb();
      const healerId = getHealerAgentId();

      // Ensure permanent Healer exists
      ensureHealerAgentRunning();

      const healerState = db.prepare('SELECT status, model_id FROM agents WHERE id = ?').get(healerId) as
        | { status: string; model_id: string | null }
        | undefined;

      if (healerState?.status === 'working') {
        logger.warn('Healer is already running a cycle — skipping LLM trigger');
      } else if (!healerState) {
        logger.warn('Healer agent not found after ensureHealerAgentRunning — skipping LLM trigger');
      } else {
        // Check for approved proposals from the user. v2.3.19:
        // applied_at filters out proposals you've already executed in a
        // prior cycle — only the OUTSTANDING approvals show up here.
        // After executing, you MUST call healer_mark_applied(proposal_id)
        // to record the work — otherwise the proposal will show up
        // again on the next cycle.
        const approved = db.prepare(`
          SELECT id, title, proposed_fix, fix_action FROM healer_proposals
          WHERE status = 'approved' AND applied_at IS NULL
        `).all() as Array<{ id: string; title: string; proposed_fix: string; fix_action: string | null }>;

        let approvedSection = '';
        if (approved.length > 0) {
          approvedSection = '\n\n═══ APPROVED PROPOSALS — execute these, then call healer_mark_applied(proposal_id) ═══\n' +
            approved.map((p) =>
              `[ID: ${p.id.slice(0, 8)}] ${p.title}\n   Fix: ${p.proposed_fix}`
            ).join('\n') +
            '\n═══ END APPROVED ═══';
        }

        // v2.3.19 (error-handling-spec Phase 3) — Dreamer-pattern budget.
        // Build the cycle message and enforce a hard ceiling on its
        // length BEFORE delivering it. If it exceeds the cap, drop the
        // lowest-priority sections (approved proposals are KEPT — user
        // explicitly asked for those; report content gets trimmed first
        // since collectors were already capped individually).
        const buildResult = buildHealerCycleMessage({
          reportText: report.reportText,
          approvedSection,
          autoFixCount,
          contextWindow: getHealerContextWindow(healerState.model_id),
        });
        const cycleMessage = buildResult.message;

        // Telemetry: log the final composed prompt size. If it ever
        // climbs past 80% of context, that's a Tier C signal — the
        // collectors need further tightening. Surface via warning log.
        const promptCharLimit = Math.floor(
          buildResult.contextWindow * HEALER_BATCH_BUDGET_CAP_RATIO * CHARS_PER_TOKEN,
        );
        const utilizationPct = Math.round((cycleMessage.length / promptCharLimit) * 100);
        if (utilizationPct >= 80) {
          logger.warn('Healer cycle message at high utilization — consider tightening collectors', {
            charLength: cycleMessage.length,
            charLimit: promptCharLimit,
            utilizationPct,
            wasTrimmed: buildResult.trimmed,
          });
        } else {
          logger.info('Healer cycle message budget OK', {
            charLength: cycleMessage.length,
            charLimit: promptCharLimit,
            utilizationPct,
            wasTrimmed: buildResult.trimmed,
          });
        }

        // Inject the cycle message and wake the permanent Healer
        const msgId = uuidv4();
        db.prepare(`
          INSERT OR IGNORE INTO messages (id, agent_id, role, content, created_at)
          VALUES (?, ?, 'user', ?, datetime('now'))
        `).run(msgId, healerId, cycleMessage);

        broadcast({
          type: 'chat:message',
          agentId: healerId,
          message: {
            id: msgId,
            agentId: healerId,
            role: 'user' as Message['role'],
            content: cycleMessage,
            tokenCount: null,
            modelId: null,
            cost: null,
            latencyMs: null,
            createdAt: new Date().toISOString(),
          },
        });

        const runtime = getAgentRuntime();
        runtime.handleMessage(healerId, cycleMessage).catch(err => {
          logger.error('Healer LLM cycle failed', {
            error: err instanceof Error ? err.message : String(err),
          }, healerId);
        });

        logger.info('Healer agent woken for cycle', { healerId });
        llmTriggered = true;
      }
    } catch (err) {
      logger.error('Healer LLM cycle failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  } else if (config.healerMode === 'monitor') {
    logger.info('Healer in monitor mode — report compiled but no fixes applied');
  }

  // Step 4: Append to the healer log file
  appendToHealerLog(report, autoFixCount);

  logger.info('Healing cycle complete', {
    diagnosticId: report.id,
    autoFixCount,
    llmTriggered,
    remainingIssues: remainingIssues.length,
  });

  return { diagnosticId: report.id, autoFixCount, llmTriggered };
}

// ── Scheduler ──

let healerTimer: ReturnType<typeof setTimeout> | null = null;

export function scheduleHealingCycle(): void {
  if (healerTimer) {
    clearTimeout(healerTimer);
    healerTimer = null;
  }

  if (!isSetupCompleted()) return;

  const config = getHealerConfig();
  if (config.healerMode === 'off') {
    logger.info('Healer is disabled, not scheduling');
    return;
  }

  const [hours, minutes] = config.healerTime.split(':').map(Number);
  const now = new Date();
  const next = new Date();
  next.setHours(hours, minutes, 0, 0);
  if (next <= now) {
    next.setDate(next.getDate() + 1);
  }

  const delay = next.getTime() - now.getTime();

  logger.info('Healing cycle scheduled', {
    nextHealing: next.toISOString(),
    delayMs: delay,
    mode: config.healerMode,
  });

  healerTimer = setTimeout(async () => {
    try {
      await runHealingCycle();
    } catch (err) {
      logger.error('Healing cycle failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    // Reschedule for next day
    scheduleHealingCycle();
  }, delay);
}

// ── Healer Log File ──
// Appends a plain-text summary of each cycle to a running log file.
// This log accumulates until the user sends a Healer Report, at which
// point it gets archived and a new log starts.

const HEALER_LOG_PATH = path.join(os.homedir(), '.dojo', 'logs', 'healer-report.log');
const HEALER_ARCHIVE_DIR = path.join(os.homedir(), '.dojo', 'logs', 'healer-archives');

/**
 * Map an agent name to a generic role label for external reports.
 * Reports go to the dev team who don't know the user's agent names.
 */
function agentRoleLabel(agentId?: string, agentName?: string): string {
  if (!agentId) return 'unknown agent';
  const { isPrimaryAgent, isPMAgent, isTrainerAgent, isImaginerAgent } = require('../config/platform.js');
  if (isPrimaryAgent(agentId)) return 'Main Agent';
  if (isPMAgent(agentId)) return 'PM Agent';
  if (isTrainerAgent(agentId)) return 'Trainer Agent';
  if (isImaginerAgent(agentId)) return 'Imaginer Agent';
  if (agentId === 'healer') return 'Healer Agent';
  // Sub-agents: just say "sub-agent" — no user-specific names
  return 'Sub-Agent';
}

function appendToHealerLog(report: ReturnType<typeof compileDiagnosticReport>, autoFixCount: number): void {
  try {
    // Only log cycles that found actual problems
    const problems = report.items.filter(i => i.severity === 'critical' || i.severity === 'warning');
    if (problems.length === 0 && autoFixCount === 0) return; // Nothing to report

    const timestamp = new Date().toLocaleString('en-US', {
      weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: true,
    });

    const lines: string[] = [];
    lines.push(`── Healer Cycle: ${timestamp} ──`);
    lines.push('');

    for (const item of problems) {
      const roleLabel = agentRoleLabel(item.agentId, item.agentName);
      // Replace agent name with role label in title and detail
      let title = item.title;
      let detail = item.detail;
      if (item.agentName) {
        title = title.replace(new RegExp(item.agentName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), roleLabel);
        detail = detail.replace(new RegExp(item.agentName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), roleLabel);
      }
      const severity = item.severity === 'critical' ? 'CRITICAL' : 'WARNING';
      lines.push(`[${severity}] ${title}`);
      lines.push(`  ${detail}`);
      lines.push(`  Code: ${item.code}`);
      lines.push('');
    }

    if (autoFixCount > 0) {
      lines.push(`Auto-fixed ${autoFixCount} issue(s):`);
      const db = getDb();
      const recentActions = db.prepare(`
        SELECT description, agent_id FROM healer_actions
        WHERE diagnostic_id = ? AND result = 'success'
      `).all(report.id) as Array<{ description: string; agent_id: string | null }>;

      for (const action of recentActions) {
        let desc = action.description;
        // Replace agent names with role labels
        if (action.agent_id) {
          const name = getAgentNameById(action.agent_id);
          if (name) {
            desc = desc.replace(new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), agentRoleLabel(action.agent_id, name));
          }
        }
        lines.push(`  ✓ ${desc}`);
      }
      lines.push('');
    }

    lines.push('');

    fs.appendFileSync(HEALER_LOG_PATH, lines.join('\n'), 'utf-8');
  } catch (err) {
    logger.warn('Failed to append to healer log', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function getAgentNameById(agentId: string): string | null {
  try {
    const db = getDb();
    const row = db.prepare('SELECT name FROM agents WHERE id = ?').get(agentId) as { name: string } | undefined;
    return row?.name ?? null;
  } catch { return null; }
}

/**
 * Read the current healer log file content.
 */
export function getHealerLogContent(): string | null {
  try {
    if (!fs.existsSync(HEALER_LOG_PATH)) return null;
    const content = fs.readFileSync(HEALER_LOG_PATH, 'utf-8').trim();
    return content.length > 0 ? content : null;
  } catch { return null; }
}

/**
 * Archive the current healer log and start a new one.
 * Returns the archive filename.
 */
// v2.3.19 (error-handling-spec Phase 3 cleanup) — archive retention.
// Without pruning, healer-report-*.log files accumulate forever in
// ~/.dojo/logs/healer-archives/. 30 days is generous — if you need
// older diagnostics they're in the structured DB tables anyway
// (healer_diagnostics, healer_actions).
const ARCHIVE_RETENTION_DAYS = 30;

function pruneOldArchives(): void {
  try {
    if (!fs.existsSync(HEALER_ARCHIVE_DIR)) return;
    const cutoffMs = Date.now() - ARCHIVE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const entries = fs.readdirSync(HEALER_ARCHIVE_DIR);
    let pruned = 0;
    for (const name of entries) {
      if (!name.startsWith('healer-report-') || !name.endsWith('.log')) continue;
      const full = path.join(HEALER_ARCHIVE_DIR, name);
      try {
        const stat = fs.statSync(full);
        if (stat.mtimeMs < cutoffMs) {
          fs.unlinkSync(full);
          pruned++;
        }
      } catch { /* skip individual file errors */ }
    }
    if (pruned > 0) {
      logger.info('Pruned old Healer archives', {
        prunedCount: pruned,
        retentionDays: ARCHIVE_RETENTION_DAYS,
      });
    }
  } catch (err) {
    logger.warn('Archive pruning failed (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export function archiveHealerLog(): string | null {
  try {
    if (!fs.existsSync(HEALER_LOG_PATH)) return null;

    if (!fs.existsSync(HEALER_ARCHIVE_DIR)) {
      fs.mkdirSync(HEALER_ARCHIVE_DIR, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const archiveName = `healer-report-${timestamp}.log`;
    const archivePath = path.join(HEALER_ARCHIVE_DIR, archiveName);

    fs.renameSync(HEALER_LOG_PATH, archivePath);
    logger.info('Healer log archived', { archivePath });

    // Prune anything older than the retention window. Best-effort —
    // failures here don't fail the archive operation.
    pruneOldArchives();

    return archiveName;
  } catch (err) {
    logger.error('Failed to archive healer log', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Send the healer report via email (Gmail or Outlook) and archive the log.
 */
export async function sendHealerReport(): Promise<{ ok: boolean; error?: string }> {
  const logContent = getHealerLogContent();
  if (!logContent) {
    return { ok: false, error: 'No healer report to send. Run a healing cycle first.' };
  }

  // Determine which email service is available
  const { isGoogleConnected } = await import('../google/auth.js');
  const { isMicrosoftConnected } = await import('../microsoft/auth.js');

  const hasGoogle = isGoogleConnected();
  const hasMicrosoft = isMicrosoftConnected();

  if (!hasGoogle && !hasMicrosoft) {
    return { ok: false, error: 'NO_EMAIL_CONFIGURED' };
  }

  // Gather platform context for the report
  const db = getDb();
  const version = (() => { try { const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../../package.json'), 'utf-8')); return pkg.version ?? 'unknown'; } catch { return 'unknown'; } })();
  const agentCount = (db.prepare("SELECT COUNT(*) as c FROM agents WHERE status != 'terminated'").get() as { c: number }).c;
  const modelList = (db.prepare("SELECT name, api_model_id FROM models WHERE is_enabled = 1").all() as Array<{ name: string; api_model_id: string }>).map(m => `${m.name} (${m.api_model_id})`).join(', ');
  const platform = `${os.platform()} ${os.arch()}, Node ${process.version}, ${os.cpus()[0]?.model ?? 'unknown CPU'}, ${Math.round(os.totalmem() / (1024 * 1024 * 1024))}GB RAM`;

  const recipient = 'david@cornerp.in';
  const subject = `DOJO Healer Report — ${new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}`;
  const body = `DOJO Healer Report\nVersion: ${version}\nPlatform: ${platform}\nActive Agents: ${agentCount}\nModels: ${modelList}\n\n${'─'.repeat(50)}\n\n${logContent}\n\n${'─'.repeat(50)}\n\nThis report was generated by the DOJO Healer agent.`;

  try {
    if (hasGoogle) {
      const { executeGoogleWriteTool } = await import('../google/tools-write.js');
      const result = await executeGoogleWriteTool('gmail_send', {
        to: recipient,
        subject,
        body,
      }, 'healer', 'Healer');

      if (result.startsWith('Error')) {
        return { ok: false, error: result };
      }
    } else if (hasMicrosoft) {
      const { executeMicrosoftWriteTool } = await import('../microsoft/tools-write.js');
      const result = await executeMicrosoftWriteTool('outlook_send', {
        to: recipient,
        subject,
        body,
      }, 'healer', 'Healer');

      if (result.startsWith('Error')) {
        return { ok: false, error: result };
      }
    }

    // Email sent successfully — archive the log
    const archiveName = archiveHealerLog();
    logger.info('Healer report sent and archived', { recipient, archiveName });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
