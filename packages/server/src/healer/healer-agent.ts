// ════════════════════════════════════════
// Healer Agent, Self-Healing Orchestrator
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
import { postAgentNotice } from '../agent/agent-notice.js';
import { getAgentRuntime } from '../agent/runtime.js';
import { SEND_TO_PEOPLE } from '../agent/sensei-policy.js';
import type { Message } from '@dojo/shared';
import {
  getPrimaryAgentId,
  getHealerAgentId,
  getHealerAgentName,
  isSetupCompleted,
} from '../config/platform.js';

const logger = createLogger('healer-agent');
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── v2.3.19 (error-handling-spec Phase 3), Dreamer-pattern budget ──
//
// The Healer must never receive a runaway cycle message that blows its
// context window. Constants mirror the Dreamer's approach in
// vault/maintenance.ts. Per-collector caps are enforced in diagnostic.ts;
// these constants are for the TOTAL cycle-message ceiling.
const CHARS_PER_TOKEN = 3;             // conservative, same as Dreamer
const HEALER_CONTEXT_OVERHEAD_TOKENS = 40_000; // sys prompt + tool schemas + vault retrieval
const HEALER_PROCESSING_GROWTH_FACTOR = 1.3;   // Healer makes fewer tool calls than Dreamer
const HEALER_BATCH_BUDGET_CAP_RATIO = 0.35;    // hard ceiling: 35% of context for diagnostic payload
const HEALER_FALLBACK_CONTEXT_WINDOW = 200_000; // sane default if we can't look up the model's window

// Stale-proposal sweep. A pending proposal is only auto-resolved by
// issue-matching when it carries usable provenance (an agent scope
// and/or a diagnostic code) AND the current run shows the issue is gone.
// Provenance-less proposals (all-NULL legacy rows, or ones the model
// filed with no agent/code) are never issue-matched, they would vanish
// on a false match, so an age cap is the only thing that ever closes
// them. The cap is generous on purpose: a live proposal the owner has
// not touched must survive many cycles, but the table still cannot grow
// without bound.
const PROPOSAL_EXPIRY_DAYS = 14;               // age cap: close pending proposals older than this
const PROPOSAL_EXPIRY_NOTE = `No decision after ${PROPOSAL_EXPIRY_DAYS} days, expired unapproved and closed by sweep.`;
const PROPOSAL_CLEARED_NOTE = 'Issue no longer detected in diagnostic, closed by sweep.';
// D-B v2: a quietly-queued Vitals consent (a held destructive call) that the
// owner never decided gets the same 14-day age cap, closed with a plain,
// non-error note (a quiet Vitals drop, never a loud alert).
const HELD_CONSENT_EXPIRY_NOTE = 'This request sat for two weeks without a decision, so I let it go. Nothing was changed or deleted.';

// FA-X7(b): cap on how many cycles re-present an approved-but-unapplied
// proposal to the Healer. An approved proposal wakes the Healer every cycle
// until the Healer applies it (calls healer_mark_applied). If the Healer keeps
// failing to apply it, that is an indefinite re-wake. After this many tries we
// stop re-presenting it and tell the primary agent once that the fix is stuck,
// so the owner can step in. Approved proposals still apply within the budget;
// only genuinely-stuck ones fall out of the wake loop.
const MAX_APPROVAL_REWAKES = 3;

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
 * preserved, those are the highest-value content.
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
    `3. Do NOT message other agents for advice, you are the diagnostician\n` +
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
  /** v2.3.19, true when the Healer and primary agent share a provider.
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
  // Must be a text-capable model: media-generation/embedding models cost 0 and
  // would otherwise win the cost tiebreak, breaking every healer LLM call.
  const model = db.prepare(`
    SELECT id FROM models WHERE is_enabled = 1
      AND capabilities NOT LIKE '%generation%'
      AND capabilities NOT LIKE '%embedding%'
    ORDER BY
      CASE WHEN api_model_id LIKE '%sonnet%' THEN 0
           WHEN api_model_id LIKE '%gpt-4o%' THEN 1
           WHEN api_model_id LIKE '%haiku%' THEN 2
           ELSE 3 END,
      input_cost_per_m ASC, id ASC
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
   - Example: \`send_to_agent(agent="[agent_id]", intent="QUESTION", payload="You hit a rate limit 5 minutes ago and went offline. It should be cleared now, please check your tasks with tracker_list_active and continue working.")\`
3. **For context corruption** (malformed tool calls, invalid request errors, tool_use_id errors):
   - The agent's conversation history is likely corrupted. Use \`reset_session(agent_id="...")\` to clear their context and give them a fresh start. Then poke them to resume their tasks.
4. **For config errors** (wrong model, auth failures, API key issues):
   - You cannot fix these. Send an iMessage to the user via \`imessage_send\` explaining which agent is down and why. Keep it short: "[Agent name] is down due to [reason]. Needs manual fix in Settings."
5. **For unknown errors:**
   - Try poking the agent first. If that fails (you get another injury alert shortly after), use \`reset_session\`. If that also fails, alert the user via iMessage.

When you receive a \`[RECOVERY NOTICE]\`, the agent is back online. No action needed, just note it for context.

**After handling an injury:** Log what you did with \`healer_log_action\`, then end your turn. Do NOT keep checking on the agent, you'll get another injury alert if they go down again. If the recovered agent replies to your poke, do NOT respond. The exchange is done, log and move on. No acknowledgement loops.

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
- Do NOT message other agents for advice, you are the diagnostician.
- Do NOT touch the tracker. You have no tracker tools. Tasks are managed by the PM agent, not you.
- When done with a healing action, call complete_task to finish.
- Do NOT reply to agents that respond to your pokes. Log the result with healer_log_action and end your turn.`;
}

// ── Permanent Healer Agent Tools & Permissions ──

// FU-4 (owner decision 2026-07-05): the Healer keeps EVERY permission the primary
// agent has for its write/exec work, with ONE deny-list carve-out. An empty allow
// means it keeps everything its manifest permits (the prior whitelist was the FU-4
// root cause: it silently under-granted the Healer every time a new tool shipped,
// most visibly file_write/file_patch/file_append, which the strip dropped so the
// Healer could not write a fix at all despite HEALER_PERMISSIONS carrying
// file_write '*'). The deny is exactly the shared SEND_TO_PEOPLE set: those
// comms-to-people tools (gmail/outlook send-reply-forward, teams sends, sms,
// imessage, voice) have NO identity gate in their executors, so nothing else stops
// the Healer from mailing/texting a real person on the owner's channels. Derived
// from the SAME sensei-policy set the Trainer denies from so the two cannot drift:
// a FUTURE comms tool is denied by construction (add it to sensei-policy.ts and
// this boot refresh picks it up). The rest of the safety boundary is unchanged:
// the destructive-action approval gate (destructive-gate.ts) holds the Healer's
// rm/dd/truncate AND, per FU-4, its writes to the owner's identity/config files;
// the always-on global write/exec denies (SOUL/secrets) and the non-primary
// PRIMARY_ONLY_TOOLS strip still apply. Refreshed on the ensure/reactivate/create
// paths below every boot, like the Trainer refreshes both columns.
const HEALER_TOOLS_POLICY = JSON.stringify({ allow: [], deny: [...SEND_TO_PEOPLE] });

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

// ── v2.3.19 (error-handling-spec Phase 3), Healer self-watchdog ──
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
      // (defensive, under normal flow this won't be set since the
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
  // One-shot prune of stale archives at startup, catches accumulated
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
    logger.warn('Primary agent not yet created, deferring Healer spawn', { primaryId });
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

  // Step 2: Sweep pending proposals. The owner rarely checks the Healer
  // block, and many issues clear on their own (a transient provider
  // failure, a stuck agent that restarted, a model the owner removed),
  // so without a sweep those proposals pile up forever. But the sweep
  // must NEVER make a live, still-relevant proposal vanish, that would
  // gut the approval flow the owner deliberately kept as the consent
  // lane for routine fixes.
  //
  // Decision rule, per pending proposal:
  //   1. Age cap (backstop): if it is older than PROPOSAL_EXPIRY_DAYS,
  //      close it as expired-unapproved. This is the ONLY thing that
  //      ever closes a provenance-less proposal, and the ultimate
  //      guarantee the table cannot grow without bound.
  //   2. Issue-match (only with usable provenance): if it has an agent
  //      scope and/or a diagnostic code, close it ONLY when the current
  //      run shows the issue is gone:
  //        - agent-scoped  -> gone iff the current run has NO anomaly of
  //          ANY code for that agent (conservative: keep the proposal
  //          alive while the agent still has any trouble).
  //        - code-only     -> gone iff the current run has NO item with
  //          that code.
  //   3. Otherwise (no provenance, under the age cap): keep it pending.
  //      It is never issue-matched, so it can never vanish on a false
  //      match; it waits for the owner or, eventually, the age cap.
  //
  // The prior implementation matched on `category` (free text the model
  // supplies) against diagnostic CODES, two disjoint domains, so
  // stillPresent was essentially always false and a proposal was
  // auto-resolved on the very next cycle. That is the bug this replaces.
  let autoResolvedCount = 0;
  let expiredCount = 0;
  try {
    const db = getDb();
    const pending = db.prepare(
      `SELECT id, diagnostic_code, agent_id, approval_token, surface,
              CAST((julianday('now') - julianday(created_at)) AS REAL) AS age_days
       FROM healer_proposals WHERE status = 'pending'`,
    ).all() as Array<{ id: string; diagnostic_code: string | null; agent_id: string | null; approval_token: string | null; surface: string | null; age_days: number | null }>;
    if (pending.length > 0) {
      // Index the current run's anomalies by code and by agent so each
      // proposal check is a Set lookup, not a scan.
      const currentCodes = new Set<string>();
      const currentAgents = new Set<string>();
      for (const item of report.items) {
        currentCodes.add(item.code.toUpperCase());
        if (item.agentId) currentAgents.add(item.agentId);
      }
      for (const p of pending) {
        // (0) D-B v2: a token-bearing proposal is an engine-HELD destructive
        // consent, NOT a diagnostic anomaly. Its agent_id is the caller (the
        // Healer), not a diagnostic scope, so issue-matching is meaningless and
        // would wrongly close it whenever the Healer has no current anomaly.
        // Lifecycle by lane:
        //   - the critical TEXTED class (surface='imessage') expires on the
        //     destructive-gate 60-minute clock with a loud owner notice;
        //   - a quietly-queued Vitals consent gets the SAME 14-day age cap as a
        //     routine proposal, closed here with a plain, non-error note (a quiet
        //     Vitals drop, not an alert).
        // Owner approval moves either out of 'pending'. Never issue-match a held
        // call (structural marker, not text parsing).
        if (p.approval_token) {
          if (p.surface === 'imessage') continue; // destructive-gate owns this expiry
          if (typeof p.age_days === 'number' && p.age_days >= PROPOSAL_EXPIRY_DAYS) {
            const changed = db.prepare(
              `UPDATE healer_proposals
               SET status = 'auto_resolved', resolved_at = datetime('now'), result_summary = ?
               WHERE id = ? AND status = 'pending'`,
            ).run(HELD_CONSENT_EXPIRY_NOTE, p.id).changes;
            if (changed > 0) {
              expiredCount++;
              try { broadcast({ type: 'healer:proposal', data: { id: p.id, status: 'auto_resolved' } }); } catch { /* */ }
            }
          }
          continue;
        }

        // (1) Age cap first, applies regardless of provenance.
        if (typeof p.age_days === 'number' && p.age_days >= PROPOSAL_EXPIRY_DAYS) {
          const changed = db.prepare(
            `UPDATE healer_proposals
             SET status = 'auto_resolved', resolved_at = datetime('now'), result_summary = ?
             WHERE id = ? AND status = 'pending'`,
          ).run(PROPOSAL_EXPIRY_NOTE, p.id).changes;
          if (changed > 0) expiredCount++;
          continue;
        }

        // (2) Issue-match, only with usable provenance.
        const hasAgentScope = !!p.agent_id;
        const code = p.diagnostic_code?.trim().toUpperCase() || null;
        const hasCode = !!code;
        if (!hasAgentScope && !hasCode) {
          continue; // (3) no provenance: never issue-matched, keep pending
        }
        // Agent scope wins when present: a proposal about an agent stays
        // live while that agent has ANY open anomaly. Code-only proposals
        // (global, no agent) match on the exact code.
        const stillPresent = hasAgentScope
          ? currentAgents.has(p.agent_id as string)
          : currentCodes.has(code as string);
        if (!stillPresent) {
          const changed = db.prepare(
            `UPDATE healer_proposals
             SET status = 'auto_resolved', resolved_at = datetime('now'), result_summary = ?
             WHERE id = ? AND status = 'pending'`,
          ).run(PROPOSAL_CLEARED_NOTE, p.id).changes;
          if (changed > 0) autoResolvedCount++;
        }
      }
      if (autoResolvedCount > 0 || expiredCount > 0) {
        logger.info('Healer sweep closed stale proposals', {
          autoResolvedCount, expiredCount, pendingChecked: pending.length,
        });
      }
    }
  } catch (err) {
    logger.warn('Healer proposal sweep failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Step 3: Run auto-fixes (Tier 1), no LLM needed
  let autoFixCount = 0;
  if (config.healerMode === 'active') {
    const autoResult = runAutoFixes(report.id, report.items);
    autoFixCount = autoResult.fixCount;
  }

  // Step 3: If there are warnings/critical items remaining, OR if there
  // are approved-but-not-yet-applied proposals waiting, wake the permanent
  // Healer agent. v2.3.19, pre-spec, the Healer only fired when the
  // diagnostic found something to diagnose. If the owner approved a proposal
  // but no NEW issues came up, the proposal sat forever waiting for
  // Healer to execute it. Now any pending approval also triggers the
  // cycle.
  const remainingIssues = report.items.filter(i => i.severity !== 'info');
  // FA-X7(b): only proposals still under the re-wake cap can trigger a wake.
  // Once a proposal has been re-presented MAX_APPROVAL_REWAKES times without
  // being applied it is considered stuck (the owner was told once), so it no
  // longer counts here and stops waking the Healer.
  const pendingApprovals = (() => {
    try {
      const row = getDb()
        .prepare(`SELECT COUNT(*) AS cnt FROM healer_proposals
                  WHERE status = 'approved' AND applied_at IS NULL AND rewake_count < ?`)
        .get(MAX_APPROVAL_REWAKES) as { cnt: number };
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
        logger.warn('Healer is already running a cycle, skipping LLM trigger');
      } else if (!healerState) {
        logger.warn('Healer agent not found after ensureHealerAgentRunning, skipping LLM trigger');
      } else {
        // Check for approved proposals from the user. v2.3.19:
        // applied_at filters out proposals you've already executed in a
        // prior cycle, only the OUTSTANDING approvals show up here.
        // After executing, you MUST call healer_mark_applied(proposal_id)
        // to record the work, otherwise the proposal will show up
        // again on the next cycle.
        // FA-X7(b): exclude proposals already at the re-wake cap. They are
        // stuck (the owner was notified once when they hit the cap), so they
        // are not re-presented to the Healer.
        const approved = db.prepare(`
          SELECT id, title, proposed_fix, fix_action, rewake_count, approval_token FROM healer_proposals
          WHERE status = 'approved' AND applied_at IS NULL AND rewake_count < ?
        `).all(MAX_APPROVAL_REWAKES) as Array<{ id: string; title: string; proposed_fix: string; fix_action: string | null; rewake_count: number; approval_token: string | null }>;

        let approvedSection = '';
        if (approved.length > 0) {
          approvedSection = '\n\n═══ APPROVED PROPOSALS, execute these, then call healer_mark_applied(proposal_id) ═══\n' +
            approved.map((p) =>
              // D-B step 2: a token-bearing proposal is a live destructive call the
              // owner approved. The Healer carries it out by RE-RUNNING the exact
              // same tool call; the engine lets it through once and records it as
              // done automatically, so it must re-issue the action, not just
              // acknowledge it.
              p.approval_token
                ? `[ID: ${p.id.slice(0, 8)}] ${p.title}\n   The owner approved this sensitive action. Re-run this exact action now to carry it out: ${p.proposed_fix}`
                : `[ID: ${p.id.slice(0, 8)}] ${p.title}\n   Fix: ${p.proposed_fix}`
            ).join('\n') +
            '\n═══ END APPROVED ═══';
        }

        // v2.3.19 (error-handling-spec Phase 3), Dreamer-pattern budget.
        // Build the cycle message and enforce a hard ceiling on its
        // length BEFORE delivering it. If it exceeds the cap, drop the
        // lowest-priority sections (approved proposals are KEPT, user
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
        // climbs past 80% of context, that's a Tier C signal, the
        // collectors need further tightening. Surface via warning log.
        const promptCharLimit = Math.floor(
          buildResult.contextWindow * HEALER_BATCH_BUDGET_CAP_RATIO * CHARS_PER_TOKEN,
        );
        const utilizationPct = Math.round((cycleMessage.length / promptCharLimit) * 100);
        if (utilizationPct >= 80) {
          logger.warn('Healer cycle message at high utilization, consider tightening collectors', {
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

        // FA-X7(b): this cycle re-presented each approved-but-unapplied
        // proposal to the Healer, count it. When a proposal reaches the cap,
        // stop re-waking on it (the `rewake_count < ?` filters above exclude
        // it next cycle) and tell the primary agent ONCE that the approved fix
        // is stuck so the owner can step in. Fires exactly once per proposal:
        // `approved` only holds rows with rewake_count < cap, so `next` reaches
        // the cap on a single transition.
        for (const p of approved) {
          const next = p.rewake_count + 1;
          db.prepare("UPDATE healer_proposals SET rewake_count = ? WHERE id = ?").run(next, p.id);
          if (next >= MAX_APPROVAL_REWAKES) {
            try {
              postAgentNotice({
                toAgentId: getPrimaryAgentId(),
                fromName: 'Healer',
                brief: `A fix you approved ("${p.title}") still hasn't gone through after ${MAX_APPROVAL_REWAKES} tries, so I've stopped retrying it on my own. Take a look on the Healer page when you get a chance, or let me know and we can sort it out together.`,
                intent: 'agent_health',
              });
            } catch (noticeErr) {
              logger.warn('Stuck-approval notice failed', {
                proposalId: p.id, error: noticeErr instanceof Error ? noticeErr.message : String(noticeErr),
              });
            }
            logger.warn('Approved proposal hit re-wake cap without being applied', {
              proposalId: p.id, title: p.title, rewakeCount: next,
            });
          }
        }
      }
    } catch (err) {
      logger.error('Healer LLM cycle failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  } else if (config.healerMode === 'monitor') {
    logger.info('Healer in monitor mode, report compiled but no fixes applied');
  }

  // Step 4: Append to the healer log file
  appendToHealerLog(report, autoFixCount);

  // Step 5 (owner request): ONE daily heartbeat to the primary, a positive "all systems
  // operational" when healthy, or a brief notice of what needs attention when not. This is
  // the Healer's single daily message; real-time injury alerts (runtime.notifyPrimaryOfInjury)
  // fire on the spot for immediate breakage and are separate. Re-compile AFTER the auto-fixes
  // so we report the true remaining state, not the pre-fix snapshot (don't flag a problem the
  // auto-fix just resolved). This runs on the daily scheduled cycle; a manual dashboard-
  // triggered cycle also posts (a status in response to an explicit run is expected).
  try {
    const finalReport = compileDiagnosticReport();
    const problems = finalReport.items.filter((i) => i.severity === 'critical' || i.severity === 'warning');
    if (problems.length === 0) {
      postAgentNotice({
        toAgentId: getPrimaryAgentId(),
        fromName: 'Healer',
        brief: `Daily health check: all systems operational.${autoFixCount > 0 ? ` Applied ${autoFixCount} routine fix${autoFixCount === 1 ? '' : 'es'}; nothing needs your attention.` : ''}`,
        intent: 'agent_health',
      });
    } else {
      const titles = problems.slice(0, 5).map((p) => p.title).join('; ');
      const more = problems.length > 5 ? ` (+${problems.length - 5} more)` : '';
      postAgentNotice({
        toAgentId: getPrimaryAgentId(),
        fromName: 'Healer',
        brief: `Daily health check: ${problems.length} issue${problems.length === 1 ? '' : 's'} need attention, ${titles}${more}. I'm ${config.healerMode === 'active' ? 'working on what I can' : 'in monitor mode'}.`,
        intent: 'agent_health',
      });
    }
  } catch (err) {
    logger.warn('Healer daily status notice failed', { error: err instanceof Error ? err.message : String(err) });
  }

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
  // Sub-agents: just say "sub-agent", no user-specific names
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
// v2.3.19 (error-handling-spec Phase 3 cleanup), archive retention.
// Without pruning, healer-report-*.log files accumulate forever in
// ~/.dojo/logs/healer-archives/. 30 days is generous, if you need
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

    // Prune anything older than the retention window. Best-effort, 
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

  // Recipient is pulled from config (`healer_report_recipient`). Pre-fix
  // this was hardcoded to the platform author's address, which meant
  // every install's "Send Healer Report" button silently emailed
  // diagnostics off-host. If no recipient is configured, refuse and
  // surface a friendly error so the user knows to set one in Settings.
  const recipientRow = db.prepare("SELECT value FROM config WHERE key = 'healer_report_recipient'").get() as { value: string } | undefined;
  const recipient = recipientRow?.value?.trim();
  if (!recipient) {
    return { ok: false, error: 'NO_REPORT_RECIPIENT' };
  }
  const subject = `DOJO Healer Report, ${new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}`;
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

    // Email sent successfully, archive the log
    const archiveName = archiveHealerLog();
    logger.info('Healer report sent and archived', { recipient, archiveName });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
