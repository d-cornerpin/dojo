// ════════════════════════════════════════
// One-shot Technique Dependency Audit Migration
// ════════════════════════════════════════
//
// First server boot after the dependency-manifest feature ships, this
// drops a single message in the trainer agent's chat asking them to
// walk every existing technique and bring it up to the new contract:
//   - dependencies.json populated (was missing or empty before this
//     feature shipped — no code path created one).
//   - Every file referenced in TECHNIQUE.md exists in the support dir.
//
// Persists a config-table flag (`technique_dep_audit_dispatched_at`)
// after the message goes out, so subsequent boots don't re-fire. The
// flag stores the dispatch timestamp rather than a boolean so we can
// see in the DB exactly when each install ran the migration.
//
// Idempotent: if the flag is already set, this is a no-op.

import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { broadcast } from '../gateway/ws.js';
import { getAgentRuntime } from '../agent/runtime.js';
import { getTrainerAgentId, getTrainerAgentName, getOwnerName } from '../config/platform.js';

const logger = createLogger('technique-audit-migration');

const FLAG_KEY = 'technique_dep_audit_dispatched_at';

export async function runTechniqueDependencyAuditOnce(): Promise<void> {
  const db = getDb();

  // Idempotency check.
  const flagRow = db.prepare("SELECT value FROM config WHERE key = ?").get(FLAG_KEY) as { value: string } | undefined;
  if (flagRow?.value) {
    logger.debug('Technique dependency audit already dispatched', { dispatchedAt: flagRow.value });
    return;
  }

  // Trainer must exist.
  const trainerId = getTrainerAgentId();
  if (!trainerId) {
    logger.info('No trainer agent configured — skipping technique audit migration');
    return;
  }
  const trainerRow = db.prepare('SELECT id, status FROM agents WHERE id = ?').get(trainerId) as { id: string; status: string } | undefined;
  if (!trainerRow || trainerRow.status === 'terminated') {
    logger.info('Trainer agent not active — deferring technique audit migration to next boot');
    return;
  }

  // Don't bother if there are no techniques to audit.
  const countRow = db.prepare("SELECT COUNT(*) AS n FROM techniques WHERE state NOT IN ('archived', 'disabled')").get() as { n: number };
  if (countRow.n === 0) {
    logger.info('No techniques present — marking audit as dispatched (no-op)');
    db.prepare(`
      INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')
    `).run(FLAG_KEY, new Date().toISOString(), new Date().toISOString());
    return;
  }

  const trainerName = getTrainerAgentName();
  const ownerName = getOwnerName();

  const parts: string[] = [];
  parts.push(`[PLATFORM MIGRATION] Technique sharing now requires every technique to declare its dependencies explicitly so that shared techniques work on the receiver's machine. ${countRow.n} existing technique(s) need your one-time audit pass.`);
  parts.push('');
  parts.push(`Why: shared techniques used to break on the receiver because TECHNIQUE.md could reference files (custom scripts, configs) that lived outside the technique directory, and external installs (npm packages, brew packages, git repos) were only described in prose. The receiver's dojo had no machine-readable way to know what to install. We fixed that — but only NEW saves enforce the rule. Existing techniques you own need to be brought up to spec.`);
  parts.push('');
  parts.push('Procedure (do these at your own pace — no rush, but block any new export with a missing-files warning until the source is clean):');
  parts.push('');
  parts.push('1. Call list_techniques to enumerate everything in the dojo.');
  parts.push('2. For each technique, in order:');
  parts.push('   a. technique_read(name, action="outline") — see what files exist.');
  parts.push('   b. technique_read(name, action="read_file", file="TECHNIQUE.md") — read the instructions.');
  parts.push('   c. Identify every file path referenced in TECHNIQUE.md. For each one:');
  parts.push('      - If it exists inside the technique directory: good, nothing to do.');
  parts.push('      - If it exists somewhere else on this machine: copy it into the technique\'s support dir (via update_technique\'s `files` param) and rewrite the TECHNIQUE.md reference to be relative (e.g. "./script.py").');
  parts.push(`      - If it doesn't exist anywhere: ask ${ownerName} where the file should come from. It might be a git repo to clone or a download to fetch — record that in dependencies.json instead of bundling.`);
  parts.push('   d. Identify every external install the technique relies on (look at the README for "prerequisites", "install", "run `brew install X`", "pip install Y", etc.). Populate dependencies.json with each one:');
  parts.push('      - system_packages: brew/apt/choco entries');
  parts.push('      - language_packages: npm/pip/gem entries');
  parts.push('      - repos: any git clones with their URLs and target paths');
  parts.push('      - models_or_assets: model files or large downloads (with destination paths)');
  parts.push('      - manual_steps: anything that needs human action (cloud signup, hardware config)');
  parts.push('   e. Call update_technique with the new instructions (if you rewrote any references), files (any you copied in), and the full dependencies manifest. The save will validate and refuse if anything is still off — fix and retry.');
  parts.push(`3. When you finish a technique, just move on — no need to report each one. Send ${ownerName} a single summary when the whole queue is done, or interrupt them if any technique can\'t be salvaged without input.`);
  parts.push('');
  parts.push('Skip techniques that are already in the archived or disabled state — they\'re not user-facing.');
  parts.push('');
  parts.push(`This is a one-time migration. Future techniques will be validated at save time, so this won't come up again.`);
  const message = parts.join('\n');

  // Insert + wake. Same insert-then-handleMessage pattern other engine→
  // trainer handoffs use.
  try {
    const msgId = uuidv4();
    db.prepare(`
      INSERT INTO messages (id, agent_id, role, content, created_at)
      VALUES (?, ?, 'user', ?, datetime('now'))
    `).run(msgId, trainerId, message);
    broadcast({
      type: 'chat:message',
      agentId: trainerId,
      message: {
        id: msgId, agentId: trainerId, role: 'user' as const,
        content: message,
        tokenCount: null, modelId: null, cost: null, latencyMs: null,
        createdAt: new Date().toISOString(),
      },
    });
    void getAgentRuntime().handleMessage(trainerId, message).catch((err) => {
      logger.warn('Trainer wake for audit migration failed (non-fatal)', {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    // Persist the flag so this never fires again on this install.
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')
    `).run(FLAG_KEY, now, now);

    logger.info('Technique dependency audit dispatched to trainer', {
      trainerId, trainerName, techniqueCount: countRow.n,
    });
  } catch (err) {
    logger.error('Technique dependency audit dispatch failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
