// ════════════════════════════════════════
// Healer Agent — Self-Healing Orchestrator
//
// Manages the healing cycle: compile diagnostic,
// run auto-fixes, spawn a temporary Healer agent
// for Tier 2-3 analysis, schedule next cycle.
//
// The Healer agent is spawned on-demand (like the
// Dreamer) and auto-terminates when done. It only
// appears in the agent list while running.
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
import { spawnAgent } from '../agent/spawner.js';
import { getPrimaryAgentId, isSetupCompleted } from '../config/platform.js';

const logger = createLogger('healer-agent');
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export type HealerMode = 'active' | 'monitor' | 'off';

// ── Config ──

export function getHealerConfig(): { modelId: string | null; healerTime: string; healerMode: HealerMode } {
  const db = getDb();
  const modelRow = db.prepare("SELECT value FROM config WHERE key = 'healer_model_id'").get() as { value: string } | undefined;
  const timeRow = db.prepare("SELECT value FROM config WHERE key = 'healer_time'").get() as { value: string } | undefined;
  const modeRow = db.prepare("SELECT value FROM config WHERE key = 'healer_mode'").get() as { value: string } | undefined;

  return {
    modelId: modelRow?.value ?? null,
    healerTime: timeRow?.value ?? '04:00',
    healerMode: (modeRow?.value as HealerMode) ?? 'active',
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

You are the Healer, the dojo's self-healing agent. You analyze operational health data, fix routine problems automatically, and propose solutions for complex issues.

# Rules

- You run on a schedule. Each cycle, you receive a diagnostic report.
- Tier 1 auto-fixes have already been applied before you run.
- Focus on Tier 2 (suggestions to primary agent) and Tier 3 (proposals for user approval).
- Search the vault for previous proposals before making new ones.
- After every cycle, vault_remember a summary of what you found and did.
- When done, call complete_task to finish your cycle.
- Keep messages short. You're a medic, not a therapist.`;
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

  // Step 2: Run auto-fixes (Tier 1) — no LLM needed
  let autoFixCount = 0;
  if (config.healerMode === 'active') {
    const autoResult = runAutoFixes(report.id, report.items);
    autoFixCount = autoResult.fixCount;
  }

  // Step 3: If there are warnings/critical items remaining, spawn a temporary Healer agent
  const remainingIssues = report.items.filter(i => i.severity !== 'info');
  let llmTriggered = false;

  if (config.healerMode === 'active' && remainingIssues.length > 0) {
    try {
      const modelId = config.modelId ?? getDefaultHealerModel();
      if (!modelId) {
        logger.warn('No model available for Healer LLM cycle');
      } else {
        const primaryId = getPrimaryAgentId();
        const systemPrompt = loadHealerSoulPrompt();

        // Check for approved proposals from the user
        const db = getDb();
        const approved = db.prepare(`
          SELECT id, title, proposed_fix, fix_action FROM healer_proposals
          WHERE status = 'approved'
        `).all() as Array<{ id: string; title: string; proposed_fix: string; fix_action: string | null }>;

        let approvedSection = '';
        if (approved.length > 0) {
          approvedSection = '\n\n═══ APPROVED PROPOSALS (execute these) ═══\n' +
            approved.map((p, i) => `${i + 1}. ${p.title}\n   Fix: ${p.proposed_fix}`).join('\n') +
            '\n═══ END APPROVED ═══';
        }

        const initialMessage = `${report.reportText}${approvedSection}\n\n${autoFixCount > 0 ? `Note: ${autoFixCount} auto-fix(es) were already applied before this report was delivered to you. Focus on the remaining issues.\n\n` : ''}For each issue in the diagnostic:\n1. Search the vault for past healer context on similar issues\n2. Fix it yourself, propose it to the user (healer_propose), or log and skip it (healer_log_action)\n3. Do NOT message other agents for advice — you are the diagnostician\n4. When done with all issues, call complete_task with a summary`;

        // Spawn temporary Healer agent (like the Dreamer)
        const result = await spawnAgent({
          parentId: primaryId,
          name: 'Healer',
          systemPrompt,
          modelId,
          classification: 'sensei',
          groupId: 'system-group',
          timeout: 7200, // 2 hours — the Healer takes whatever time it needs to fix problems
          persist: false, // auto-terminate on complete_task
          // Full access — same as the primary agent. The Healer may need to
          // read/write files, run commands, query the database, restart services,
          // or do whatever is needed to diagnose and fix problems.
          permissions: {
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
          },
          initialMessage,
        });

        logger.info('Healer agent spawned', { healerId: result.agentId, modelId });
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
