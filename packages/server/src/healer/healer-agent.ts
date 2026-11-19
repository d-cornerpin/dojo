// Healer self-healing orchestrator: compile the diagnostic, run auto-fixes, then wake the permanent Healer
// agent for Tier 2-3 analysis. The Healer is a permanent resident of Masters (like the Trainer):
// idle between cycles, woken when a cycle fires.

import { HELD_CONSENT_EXPIRY_NOTE_TEXT } from '../agent/engine-lines.js';
import { primaryReady } from '../agent/primary-ready.js';
import fs from 'node:fs';
import { CHARS_PER_TOKEN } from '../memory/budget.js'; // shared token-estimate constant
import { HEALER_WORKING_STUCK_MINUTES } from '../agent/stuck-thresholds.js';
// The Healer's status writes go through the one status writer.
import { writeAgentStatus } from '../agent/agent-status.js';
// The activeRuns concurrency guard, as recoverStuckAgents applies it in agent/runtime.ts. shared-state.ts is a
// leaf module (imports only the logger), so this import cannot form a cycle.
import { activeRuns } from '../agent/shared-state.js';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/connection.js';
import { setConfigValue } from '../config/config-value.js';
import { insertMessageIfAbsent } from '../memory/message-store.js';
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
  isPrimaryAgent,
  isPMAgent,
  isTrainerAgent,
} from '../config/platform.js';
import { homeDir } from '../home.js';
import { serviceAgentModelId } from '../agent/main-model-floor.js';
import { nextDailyRunDelayMs } from '../config/clock-time.js';
import { ownerConditionsOnHealerSeen } from './owner-notices.js';
import { ownerMailboxes } from '../services/owner-mailboxes.js';

const logger = createLogger('healer-agent');
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Budget for the cycle message: the Healer must never receive a runaway message that blows its context window.
// Mirrors the Dreamer's approach in vault/maintenance.ts; per-collector caps live in diagnostic.ts, these
// constants set the TOTAL ceiling.
const HEALER_CONTEXT_OVERHEAD_TOKENS = 40_000; // sys prompt + tool schemas + vault retrieval
const HEALER_PROCESSING_GROWTH_FACTOR = 1.3;   // Healer makes fewer tool calls than Dreamer
const HEALER_BATCH_BUDGET_CAP_RATIO = 0.35;    // hard ceiling: 35% of context for diagnostic payload
const HEALER_FALLBACK_CONTEXT_WINDOW = 200_000; // sane default if we can't look up the model's window

// Stale-proposal sweep: a pending proposal is auto-resolved by issue-matching only with usable provenance (an
// agent scope and/or a diagnostic code) AND the current run showing the issue gone. Provenance-less proposals
// are never issue-matched (they would vanish on a false match), so only this generous age cap closes them.
const PROPOSAL_EXPIRY_DAYS = 14;               // age cap: close pending proposals older than this
const PROPOSAL_EXPIRY_NOTE = `No decision after ${PROPOSAL_EXPIRY_DAYS} days, expired unapproved and closed by sweep.`;
const PROPOSAL_CLEARED_NOTE = 'Issue no longer detected in diagnostic, closed by sweep.';
// A quietly-queued Vitals consent (a held destructive call) the owner never decided gets the same age cap,
// closed with a plain non-error note.
const HELD_CONSENT_EXPIRY_NOTE = HELD_CONSENT_EXPIRY_NOTE_TEXT;   // the Dojo speaking, never 'I'

// Cap on how many cycles re-present an approved-but-unapplied proposal to the Healer (each one wakes it). Past
// the cap it stops being re-presented and the primary agent is told once that the fix is stuck.
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
 * Compose the Healer's cycle message under a strict char budget. Over budget, the diagnostic REPORT is
 * truncated (with a marker) so approved proposals and instructions, the highest-value content, survive.
 */
function buildHealerCycleMessage(opts: BuildCycleMessageOptions): BuildCycleMessageResult {
  const { reportText, approvedSection, autoFixCount, contextWindow } = opts;

  // Budget calculation mirrors Dreamer's batchArchives (vault/maintenance.ts).
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

export const HEALER_MODES = ['active', 'monitor'] as const;
export type HealerMode = typeof HEALER_MODES[number];

// ── Config ──

export function getHealerConfig(): {
  modelId: string | null;
  healerTime: string;
  healerMode: HealerMode;
  /** True when the Healer and primary share a provider (an outage takes both down); Settings shows a warning. */
  providerSharedWithPrimary: boolean;
  primaryProviderName: string | null;
  healerProviderName: string | null;
} {
  const db = getDb();
  const modelRow = db.prepare("SELECT value FROM config WHERE key = 'healer_model_id'").get() as { value: string } | undefined;
  const timeRow = db.prepare("SELECT value FROM config WHERE key = 'healer_time'").get() as { value: string } | undefined;
  const modeRow = db.prepare("SELECT value FROM config WHERE key = 'healer_mode'").get() as { value: string } | undefined;

  // Provider-isolation check: resolve each model to its provider name.
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
    healerMode: (modeRow?.value as HealerMode | undefined) ?? 'active',
    providerSharedWithPrimary,
    primaryProviderName,
    healerProviderName,
  };
}

export function setHealerConfig(config: { modelId?: string; healerTime?: string; healerMode?: HealerMode }): void {
  if (config.modelId !== undefined) setConfigValue('healer_model_id', config.modelId);
  if (config.healerTime !== undefined) setConfigValue('healer_time', config.healerTime);
  if (config.healerMode !== undefined) setConfigValue('healer_mode', config.healerMode);
}

// ── Default Model ──


// The Healer's charter (HEALER-SOUL.md) is not written as a message row at creation: soulFileForAgent in
// prompt/assembler.ts declares it and the runtime (getSoulContent) and Settings card (agent-prompt-surface.ts)
// read it, so a doctrine update reaches a running Healer and the identity survives pruning.

// ── Permanent Healer Agent Tools & Permissions ──

// The Healer keeps every permission the primary has for write/exec work, with ONE deny-list carve-out: the shared
// SEND_TO_PEOPLE set (comms tools with no identity gate in their executors), derived from the same sensei-policy
// set the Trainer denies from so a future comms tool is denied by construction. An empty allow keeps everything
// the manifest permits. The destructive-action gate (destructive-gate.ts) still holds rm/dd/truncate, DELETE/DROP/ALTER/REPLACE
// on the Dojo database and writes to the owner's identity/config files; the global denies and PRIMARY_ONLY_TOOLS strip apply.
// Written on the create and reactivate paths only.
const HEALER_TOOLS_POLICY = JSON.stringify({ allow: [], deny: [...SEND_TO_PEOPLE] });

const HEALER_PERMISSIONS = JSON.stringify({
  file_read: '*',
  file_write: '*',
  exec_allow: ['*'],
  exec_deny: [],
  network_domains: '*',
  can_spawn_agents: false,
  can_assign_permissions: false,
  system_control: [],
});

// ── Healer self-watchdog ──
// Bypasses onAgentInjured's self-skip (the Healer cannot heal itself) and applies the Tier 1 auto-fix logic to
// the Healer directly every 5 minutes: error, paused or working too long resets it to idle. No LLM cost.

const HEALER_WATCHDOG_INTERVAL_MS = 5 * 60 * 1000;
// From the one stuck-threshold table, which explains why it differs from the engine reaper's 75 minutes.
let healerWatchdogTimer: ReturnType<typeof setInterval> | null = null;

export function runHealerSelfWatchdog(): void {
  try {
    if (!isSetupCompleted()) return;
    const db = getDb();
    const healerId = getHealerAgentId();
    const row = db
      .prepare('SELECT id, name, status, updated_at, last_error FROM agents WHERE id = ?')
      .get(healerId) as { id: string; name: string; status: string; updated_at: string; last_error: string | null } | undefined;
    ownerConditionsOnHealerSeen(row?.status ?? null); // back, or healthy, ends the owner's card
    if (!row) return; // Healer doesn't exist yet; ensureHealerAgentRunning will create it

    let shouldReset = false;
    let reason = '';

    if (row.status === 'error') {
      shouldReset = true;
      reason = 'in error status';
    } else if (row.status === 'paused' && !/^\[(?:budget_stop|no_model_fits)\]/.test(row.last_error ?? '')) {   // a parked Healer is not reset by a clock
      shouldReset = true;
      reason = 'in paused status';
    } else if (row.status === 'working') {
      const updatedMs = new Date(row.updated_at.replace(' ', 'T') + 'Z').getTime();
      if (Date.now() - updatedMs > HEALER_WORKING_STUCK_MINUTES * 60 * 1000) {
        // Never reap a run THIS process knows is live: resetting the row under a running cycle lets a new wake
        // start a SECOND concurrent cycle. A stale row that is still an active run means the cycle is wedged
        // here, so leave it to recoverStuckAgents.
        if (activeRuns.has(healerId)) {
          logger.warn('Healer self-watchdog: row is stale but run is live in-process, not resetting', {
            healerId, healerName: row.name,
          });
        } else {
          shouldReset = true;
          reason = `stuck in working status for >${HEALER_WORKING_STUCK_MINUTES} min`;
        }
      }
    }

    if (shouldReset) {
      writeAgentStatus(healerId, 'idle');
      broadcast({ type: 'agent:status', agentId: healerId, status: 'idle' });
      logger.warn('Healer self-watchdog reset Healer to idle', {
        healerId, healerName: row.name, prevStatus: row.status, reason,
      });
      // Also clear the Healer's per-agent backoff state (defensive: normally unset, since the Healer's
      // onAgentInjured short-circuits).
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
  // One-shot prune of stale archives at startup, even if no cycle ran within the retention window.
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

  if (!primaryReady('Healer', primaryId, () => ensureHealerAgentRunning())) return;

  // The Healer is identified by `healer_agent_id`, never by its name (an owner's agent can carry that name).

  const existing = db.prepare('SELECT id, status FROM agents WHERE id = ?').get(healerId) as
    | { id: string; status: string }
    | undefined;

  if (existing && existing.status !== 'terminated') {
    logger.info('Healer agent already running', { status: existing.status });
    // No boot rewrite of tools_policy or permissions, so owner edits to a live row stay. The send-to-people tools
    // are refused by mayUseChannel (a non-primary sensei has no channel grant), including ones added later; the
    // declared grants are seeded once by agent/access/materialize.ts. The create and reactivate paths below do
    // write the policy, since they mint a row rather than overwrite a live one.
    return;
  }

  const modelId = serviceAgentModelId('healer_model_id', primaryId);   // never a model under the floor

  if (existing) {
    // Reactivate from terminated
    // Identity columns are updated here but the STATUS goes through the one writer, both in ONE transaction, so
    // no reader sees a row that is renamed-but-terminated or terminated-but-renamed.
    db.transaction(() => {
      db.prepare(`
        UPDATE agents SET
          name = ?,
          model_id = ?,
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
      writeAgentStatus(healerId, 'idle');
    })();
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

    // No soul row is written here: the identity is seeded into ~/.dojo/prompts/HEALER-SOUL.md on first read.
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

  // Step 2: Sweep pending proposals so ones whose issue cleared do not pile up, but NEVER make a live,
  // still-relevant proposal vanish (the approval flow is the consent lane for routine fixes). Per proposal:
  //   1. Age cap (backstop): older than PROPOSAL_EXPIRY_DAYS closes it as expired-unapproved; the only thing
  //      that ever closes a provenance-less proposal.
  //   2. Issue-match (only with usable provenance): close it ONLY when the current run shows the issue gone.
  //      Agent-scoped: gone iff the run has NO anomaly of ANY code for that agent. Code-only: gone iff no item
  //      has that code.
  //   3. Otherwise keep it pending: with no provenance it is never issue-matched, so it cannot vanish on a
  //      false match.
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
        // (0) A token-bearing proposal is an engine-HELD destructive consent, not a diagnostic anomaly: its agent_id
        // is the caller (the Healer), so issue-matching would wrongly close it. The texted class (surface='imessage')
        // expires on the destructive-gate clock; a quietly-queued Vitals consent gets the same age cap, closed with a
        // plain non-error note.
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
        // Agent scope wins when present (the proposal stays live while that agent has ANY open anomaly);
        // code-only proposals match on the exact code.
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

  // Step 3: wake the permanent Healer when warnings/critical items remain OR approved-but-unapplied proposals
  // wait (an approval with no new issue must still get executed).
  const remainingIssues = report.items.filter(i => i.severity !== 'info');
  // Only proposals still under the re-wake cap (MAX_APPROVAL_REWAKES) can trigger a wake; a stuck one no longer counts.
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
        const approved = approvedProposals();
        const approvedSection = approvedProposalsSection(approved);

        // Build the cycle message and enforce a hard length ceiling BEFORE delivering it: lowest-priority sections
        // drop first (approved proposals are KEPT; the report is trimmed first, its collectors already capped).
        const buildResult = buildHealerCycleMessage({
          reportText: report.reportText,
          approvedSection,
          autoFixCount,
          contextWindow: getHealerContextWindow(healerState.model_id),
        });
        const cycleMessage = buildResult.message;

        // Log the final prompt size; at 80% or more of the ceiling the collectors need tightening.
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
        insertMessageIfAbsent({ id: msgId, agentId: healerId, role: 'user', content: cycleMessage });

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

        // Count this re-presentation of each approved-but-unapplied proposal. At the cap the `rewake_count < ?`
        // filters stop re-waking it and the primary agent is told ONCE the fix is stuck (`next` reaches the cap
        // on a single transition).
        for (const p of approved) {
          const next = p.rewake_count + 1;
          db.prepare("UPDATE healer_proposals SET rewake_count = ? WHERE id = ?").run(next, p.id);
          if (next >= MAX_APPROVAL_REWAKES) {
            try {
              postAgentNotice({
                toAgentId: getPrimaryAgentId(),
                fromName: 'Healer',
                brief: `A fix the owner approved ("${p.title}") still hasn't gone through after ${MAX_APPROVAL_REWAKES} tries, so I have stopped retrying it on my own. It is listed under Previous Suggestions in the Healer section of the dashboard; ask the owner whether to try it another way.`,
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

  // Step 5: ONE daily heartbeat to the primary: "all systems operational" or what needs attention (real-time
  // injury alerts are separate, runtime.notifyPrimaryOfInjury). Re-compiled AFTER the auto-fixes so it reports
  // the true remaining state. A manual dashboard-triggered cycle also posts, since a reply to a run is expected.
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
  const now = new Date();
  const { delayMs, usedFallback } = nextDailyRunDelayMs(config.healerTime, '04:00', now);
  if (usedFallback) {
    logger.warn('Healing cycle used fallback time, invalid healer time text', {
      healerTime: config.healerTime,
      fallback: '04:00',
    });
  }

  logger.info('Healing cycle scheduled', {
    nextHealing: new Date(now.getTime() + delayMs).toISOString(),
    delayMs,
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
  }, delayMs);
}

// ── Healer Log File ──
// Accumulates until the user sends a Healer Report, then it is archived and a new log starts.

const HEALER_LOG_PATH = path.join(homeDir(), '.dojo', 'logs', 'healer-report.log');
const HEALER_ARCHIVE_DIR = path.join(homeDir(), '.dojo', 'logs', 'healer-archives');

/** A generic role label for an agent (never its given name), for the Healer's log and report lines. */
function agentRoleLabel(agentId?: string, agentName?: string): string {
  if (!agentId) return 'unknown agent';
  if (isPrimaryAgent(agentId)) return 'Main Agent';
  if (isPMAgent(agentId)) return 'PM Agent';
  if (isTrainerAgent(agentId)) return 'Trainer Agent';
  if (agentId === getHealerAgentId()) return 'Healer Agent';
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

/** Read the current healer log file content. */
export function getHealerLogContent(): string | null {
  try {
    if (!fs.existsSync(HEALER_LOG_PATH)) return null;
    const content = fs.readFileSync(HEALER_LOG_PATH, 'utf-8').trim();
    return content.length > 0 ? content : null;
  } catch { return null; }
}

// Archive retention: 30 days of healer-report-*.log in ~/.dojo/logs/healer-archives/; older diagnostics remain
// in the structured tables (healer_diagnostics, healer_actions).
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

/** Archive the current healer log and start a new one; returns the archive filename. */
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

    // Prune anything older than the retention window; failures here do not fail the archive.
    pruneOldArchives();

    return archiveName;
  } catch (err) {
    logger.error('Failed to archive healer log', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** Approved, unapplied proposals under the re-wake cap; a token-bearing one is re-run by the Healer from its exact call, never from the owner's sentence. */
export function approvedProposals() {
  return getDb().prepare(`
    SELECT id, title, proposed_fix, rewake_count, approval_token, approval_signature, approval_args_json FROM healer_proposals
    WHERE status = 'approved' AND applied_at IS NULL AND rewake_count < ?
  `).all(MAX_APPROVAL_REWAKES) as Array<{ id: string; title: string; proposed_fix: string; rewake_count: number; approval_token: string | null; approval_signature: string | null; approval_args_json: string | null }>;
}

export function approvedProposalsSection(approved: ReturnType<typeof approvedProposals>): string {
  if (approved.length === 0) return '';
  return '\n\n═══ APPROVED PROPOSALS, execute these, then call healer_mark_applied(proposal_id) ═══\n' +
    approved.map((p) =>
      p.approval_token
        ? `[ID: ${p.id.slice(0, 8)}] ${p.title}\n   The owner approved this sensitive action. Re-run this exact tool call now to carry it out: tool ${p.approval_signature?.split(':')[0] ?? 'unknown'}, arguments ${p.approval_args_json ?? p.proposed_fix}`
        : `[ID: ${p.id.slice(0, 8)}] ${p.title}\n   Fix: ${p.proposed_fix}`
    ).join('\n') +
    '\n═══ END APPROVED ═══';
}

/** Emails the healer report from the agent mailbox to the owner's first connected mailbox, then archives the log. */
export async function sendHealerReport(): Promise<{ ok: boolean; error?: string }> {
  const logContent = getHealerLogContent();
  if (!logContent) {
    return { ok: false, error: 'No healer report to send. Run a healing cycle first.' };
  }

  // The agent's first account whose sending switch is on (else the first connected, so the tool names the switch).
  const { listGoogleAccounts } = await import('../google/accounts.js');
  const { listMicrosoftAccounts } = await import('../microsoft/accounts.js');
  const connected = [
    ...listGoogleAccounts('agent').map((a) => ({ a, google: true })),
    ...listMicrosoftAccounts('agent').map((a) => ({ a, google: false })),
  ].filter((x) => x.a.connected);
  const picked = connected.find((x) => x.a.sendEmail) ?? connected[0];
  if (!picked) return { ok: false, error: 'NO_EMAIL_CONFIGURED' };
  const { a: sender, google } = picked;

  // Gather platform context for the report
  const db = getDb();
  const version = (() => { try { const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../../package.json'), 'utf-8')); return pkg.version ?? 'unknown'; } catch { return 'unknown'; } })();
  const agentCount = (db.prepare("SELECT COUNT(*) as c FROM agents WHERE status != 'terminated'").get() as { c: number }).c;
  const modelList = (db.prepare("SELECT name, api_model_id FROM models WHERE is_enabled = 1").all() as Array<{ name: string; api_model_id: string }>).map(m => `${m.name} (${m.api_model_id})`).join(', ');
  const platform = `${os.platform()} ${os.arch()}, Node ${process.version}, ${os.cpus()[0]?.model ?? 'unknown CPU'}, ${Math.round(os.totalmem() / (1024 * 1024 * 1024))}GB RAM`;

  // The report goes to the owner's own connected mailbox, the same address list the Profile tab shows.
  const recipient = ownerMailboxes()[0]?.address;
  if (!recipient) return { ok: false, error: 'NO_OWNER_MAILBOX' };
  const subject = `DOJO Healer Report, ${new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}`;
  const body = `DOJO Healer Report\nVersion: ${version}\nPlatform: ${platform}\nActive Agents: ${agentCount}\nModels: ${modelList}\n\n${'─'.repeat(50)}\n\n${logContent}\n\n${'─'.repeat(50)}\n\nThis report was generated by the DOJO Healer agent.`;

  try {
    const mail = { to: recipient, subject, body, account: sender.email };
    const result = google
      ? await (await import('../google/tools-write.js')).executeGoogleWriteTool('gmail_send', mail, getHealerAgentId(), getHealerAgentName())
      : await (await import('../microsoft/tools-write.js')).executeMicrosoftWriteTool('outlook_send', mail, getHealerAgentId(), getHealerAgentName());
    if (result.startsWith('Error')) {
      const refused = /authenticat|credential|invalid_grant|unauthori[sz]ed|expired|\b401\b/i.test(result);
      return { ok: false, error: refused
        ? `The sign-in for the agent's ${google ? 'Google' : 'Microsoft'} account${sender.email ? ` (${sender.email})` : ''} was refused or has expired. Reconnect it in Settings → Channels.`
        : `The report could not be emailed: ${result.replace(/^Error:?\s*/, '')}` };
    }

    // Email sent successfully, archive the log
    const archiveName = archiveHealerLog();
    logger.info('Healer report sent and archived', { to: 'the owner', archiveName });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
