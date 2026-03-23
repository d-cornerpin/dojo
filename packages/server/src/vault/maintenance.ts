// ════════════════════════════════════════
// Vault Maintenance: Dreaming Cycle
// Spawns a temporary "Dreamer" agent to process vault conversations,
// extract knowledge, identify techniques, and maintain the vault.
// Engine-level pruning runs before the Dreamer is spawned.
// ════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { broadcast } from '../gateway/ws.js';
import { spawnAgent } from '../agent/spawner.js';
import { getPrimaryAgentId, getTrainerAgentId, getTrainerAgentName } from '../config/platform.js';
import {
  getUnprocessedConversations,
  getVaultStats,
  type VaultConversation,
} from './store.js';

const logger = createLogger('vault-dreaming');

export type DreamMode = 'full' | 'light' | 'off';

// ── Dreaming Config ──

export function getDreamingConfig(): { modelId: string | null; dreamTime: string; dreamMode: DreamMode } {
  const db = getDb();

  const modelRow = db.prepare("SELECT value FROM config WHERE key = 'dreaming_model_id'").get() as { value: string } | undefined;
  const timeRow = db.prepare("SELECT value FROM config WHERE key = 'dreaming_time'").get() as { value: string } | undefined;
  const modeRow = db.prepare("SELECT value FROM config WHERE key = 'dreaming_mode'").get() as { value: string } | undefined;

  return {
    modelId: modelRow?.value ?? null,
    dreamTime: timeRow?.value ?? '03:00',
    dreamMode: (modeRow?.value as DreamMode) ?? 'full',
  };
}

export function setDreamingConfig(config: { modelId?: string; dreamTime?: string; dreamMode?: DreamMode }): void {
  const db = getDb();
  const upsert = db.prepare(`
    INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')
  `);

  if (config.modelId !== undefined) {
    upsert.run('dreaming_model_id', config.modelId, config.modelId);
  }
  if (config.dreamTime !== undefined) {
    upsert.run('dreaming_time', config.dreamTime, config.dreamTime);
  }
  if (config.dreamMode !== undefined) {
    upsert.run('dreaming_mode', config.dreamMode, config.dreamMode);
  }
}

// ── Get Default Model for Dreaming ──

function getDefaultDreamModel(): string | null {
  const db = getDb();
  const model = db.prepare(`
    SELECT id FROM models WHERE is_enabled = 1
    ORDER BY
      CASE WHEN api_model_id LIKE '%sonnet%' THEN 0
           WHEN api_model_id LIKE '%gpt-4o%' THEN 1
           ELSE 2 END,
      input_cost_per_m ASC
    LIMIT 1
  `).get() as { id: string } | undefined;
  return model?.id ?? null;
}

// ── Engine-Level Maintenance (no LLM needed) ──

function runEngineMaintenance(): { pruned: number; decayed: number } {
  const db = getDb();
  let pruned = 0;

  // Hard delete entries with confidence < 0.1
  const hardDeleted = db.prepare(
    'DELETE FROM vault_entries WHERE confidence < 0.1 AND is_obsolete = 0 AND is_pinned = 0 AND is_permanent = 0'
  ).run();
  pruned += hardDeleted.changes;

  // Mark obsolete: confidence < 0.5, never retrieved, older than 7 days
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const lowConfidence = db.prepare(
    'UPDATE vault_entries SET is_obsolete = 1, updated_at = datetime(\'now\') WHERE confidence < 0.5 AND retrieval_count = 0 AND created_at < ? AND is_obsolete = 0 AND is_pinned = 0 AND is_permanent = 0'
  ).run(sevenDaysAgo);
  pruned += lowConfidence.changes;

  // Decay confidence: not retrieved in 30 days, not pinned, not permanent
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const decayResult = db.prepare(`
    UPDATE vault_entries SET confidence = MAX(0, confidence - 0.1), updated_at = datetime('now')
    WHERE is_obsolete = 0 AND is_pinned = 0 AND is_permanent = 0
      AND (last_retrieved_at IS NULL OR last_retrieved_at < ?)
      AND created_at < ?
  `).run(thirtyDaysAgo, thirtyDaysAgo);

  if (pruned > 0) logger.info(`Engine maintenance: pruned ${pruned} low-value vault entries`);
  if (decayResult.changes > 0) logger.info(`Engine maintenance: decayed confidence on ${decayResult.changes} entries`);

  return { pruned, decayed: decayResult.changes };
}

// ── Build Dreamer Instructions ──

async function buildDreamerPrompt(
  unprocessed: VaultConversation[],
  dreamMode: DreamMode,
  stats: ReturnType<typeof getVaultStats>,
): Promise<string> {
  // Summarize what needs processing
  const archiveSummary = unprocessed.map((conv, i) => {
    return `Archive ${i + 1}: Agent "${conv.agentName ?? conv.agentId}", ${conv.messageCount} messages, ${conv.tokenCount} tokens (${conv.earliestAt} to ${conv.latestAt}), ID: ${conv.id}`;
  }).join('\n');

  const trainerName = getTrainerAgentName();
  const trainerId = getTrainerAgentId();
  const techniqueInstructions = dreamMode === 'full' ? `
- IDENTIFY TECHNIQUES: If a conversation contains a reusable multi-step procedure or workflow that other agents would benefit from, send a message to the Trainer agent (**${trainerName}**, ID: ${trainerId}) via send_to_agent describing the technique candidate. Include: a suggested name, what it does, and the step-by-step instructions. The Trainer is the technique expert -- let them create and refine it. Only flag genuinely reusable processes, not one-off commands.` : '';

  // Get file paths for profile updates
  const os = await import('node:os');
  const path = await import('node:path');
  const profilePath = path.join(os.homedir(), '.dojo', 'prompts', 'USER.md');
  const soulPath = path.join(os.homedir(), '.dojo', 'prompts', 'SOUL.md');

  return `You are the Dreamer -- a specialized agent that processes the dojo's daily conversations into long-term memories and keeps the dojo's profile files up to date.

# Your Mission

The dojo has ${unprocessed.length} unprocessed conversation archive(s). You have three jobs:
1. Extract knowledge from conversations into the vault
2. Update the owner's profile (USER.md) if conversations revealed new behavioral or operational info
3. Update the agent personality (SOUL.md) if the owner gave feedback about how the agent should behave

# Files

- USER.md: ${profilePath} -- The owner's profile. Contains behavioral/operational info the agent needs every turn.
- SOUL.md: ${soulPath} -- The agent's personality and instructions. Defines how the agent talks and works.

# Current Vault State

- Total entries: ${stats.totalEntries} (${stats.pinnedCount} pinned, ${stats.permanentCount} permanent)
- Unprocessed archives: ${unprocessed.length}

# Archives to Process

${archiveSummary}

# How to Work

1. **Create a project in the tracker** called "Dream Cycle [date]" with tasks for each step.
2. **For each unprocessed archive:**
   a. Read the archive content (it will be provided in your conversation)
   b. Extract facts worth remembering into the vault via vault_remember:
      - Facts about the user, their businesses, projects
      - Decisions that were made and WHY
      - Procedures or workflows that were figured out
      - Relationships between people, systems, or projects
      - Events with specific dates
      - Corrections the user made
   c. Do NOT vault: routine tool calls, transient debugging, small talk, info already in the vault
   d. Look for information that should update USER.md or SOUL.md (see below)${techniqueInstructions}
3. **After processing all archives**, check if USER.md or SOUL.md need updates (see below). If so, read the current file with file_read, make targeted edits, and write it back with file_write.
4. **Deduplicate**: search the vault for entries that say essentially the same thing. Use vault_forget on the less detailed one.
5. **When done**, call complete_task with a summary.

# When to Update USER.md

Read USER.md first. Then check: did any conversation reveal changes that affect it? Examples:
- The owner moved (update location and timezone, remove the old ones)
- The owner changed their work schedule
- The owner stated a new communication preference or rule
- A scheduling constraint changed or was removed
- Information in the file is now outdated or contradicted by something said in conversation

If yes, read the current file, make the changes, and write it back. You CAN update, replace, or remove content that is outdated. If the owner moved from Washington to Colorado, replace Washington with Colorado -- don't keep both. Keep the file lean and current. Only behavioral/operational content belongs here -- factual reference info goes to the vault.

# When to Update SOUL.md

Read SOUL.md first. Then check: did the owner give the agent direct feedback about its behavior? Examples:
- "Stop doing X" or "Start doing Y"
- "You're being too formal" or "Be more concise"
- "When I ask about X, always do Y"
- "Never do X again"
- A rule in SOUL.md is now contradicted by something the owner said

If yes, read the current file, make targeted edits, and write it back. You CAN remove or update rules that have been superseded. Preserve the file's existing voice and energy -- don't rewrite the whole thing, just update the parts that changed.

# Vault Entry Rules

- Write each entry as a STANDALONE statement
- Use the correct type: fact, relationship, decision, procedure, event, preference, note
- "preference" = factual preferences (likes Leica cameras, drinks iced black coffee). NOT behavioral rules.
- Mark stable facts as permanent: true (names, family, businesses, locations, birth dates)
- vault_search before saving to avoid duplicates
- Keep each entry under 500 tokens`;
}

function buildDreamerInitialMessage(unprocessed: VaultConversation[]): string {
  // Build the initial message with all archive contents
  const archiveTexts: string[] = [];

  for (const conv of unprocessed) {
    let parsedMessages: Array<{ role: string; content: string; createdAt?: string }>;
    try {
      parsedMessages = JSON.parse(conv.messages);
    } catch {
      continue;
    }

    const formatted = parsedMessages.map(m => {
      const role = (m.role ?? 'unknown').toUpperCase();
      const ts = m.createdAt ? ` [${m.createdAt}]` : '';
      return `[${role}${ts}] ${m.content}`;
    }).join('\n\n');

    archiveTexts.push(`=== ARCHIVE: ${conv.agentName ?? conv.agentId} (ID: ${conv.id}) ===
${conv.messageCount} messages, ${conv.earliestAt} to ${conv.latestAt}

${formatted}

=== END ARCHIVE ===`);
  }

  // Mark archives as processed now -- the Dreamer will handle extraction
  // If the Dreamer fails, the archives stay in the DB (they just won't be re-queued
  // unless we add retry logic later)
  const db = getDb();
  for (const conv of unprocessed) {
    db.prepare('UPDATE vault_conversations SET is_processed = 1, processed_at = datetime(\'now\') WHERE id = ?').run(conv.id);
  }

  return `Here are the conversation archives to process. Extract all knowledge into the vault using vault_remember, then call complete_task when done.

${archiveTexts.join('\n\n')}

Begin by creating a tracker project, then process each archive systematically.`;
}

// ── Main Dreaming Cycle ──

export async function runDreamingCycle(): Promise<{ dreamerId: string | null }> {
  const config = getDreamingConfig();

  if (config.dreamMode === 'off') {
    logger.info('Dreaming is disabled, skipping cycle');
    return { dreamerId: null };
  }

  const modelId = config.modelId ?? getDefaultDreamModel();
  if (!modelId) {
    logger.warn('No model available for dreaming cycle');
    return { dreamerId: null };
  }

  const primaryId = getPrimaryAgentId();
  if (!primaryId) {
    logger.warn('No primary agent found, cannot spawn Dreamer');
    return { dreamerId: null };
  }

  // Compute profile file paths for Dreamer's file access
  const os = await import('node:os');
  const path = await import('node:path');
  const profilePath = path.join(os.homedir(), '.dojo', 'prompts', 'USER.md');
  const soulPath = path.join(os.homedir(), '.dojo', 'prompts', 'SOUL.md');

  // Step 1: Engine-level maintenance (no LLM, fast)
  const maintenance = runEngineMaintenance();
  logger.info('Engine maintenance complete', maintenance);

  // Step 2: Check for unprocessed archives
  const unprocessed = getUnprocessedConversations();
  if (unprocessed.length === 0) {
    logger.info('No unprocessed conversation archives, skipping Dreamer spawn');
    broadcast({ type: 'dream:complete', data: { skipped: true, reason: 'no_archives', ...maintenance } } as never);
    return { dreamerId: null };
  }

  logger.info(`Spawning Dreamer agent to process ${unprocessed.length} archives`, {
    mode: config.dreamMode,
    modelId,
  });

  broadcast({ type: 'dream:started', data: { mode: config.dreamMode, archives: unprocessed.length } } as never);

  const stats = getVaultStats();

  // Step 3: Spawn the Dreamer agent
  try {
    const result = await spawnAgent({
      parentId: primaryId,
      name: 'Dreamer',
      systemPrompt: await buildDreamerPrompt(unprocessed, config.dreamMode, stats),
      modelId,
      classification: 'apprentice',
      timeout: 3600, // 1 hour safety net
      persist: false, // auto-terminate on complete_task
      toolsPolicy: {
        allow: [
          'vault_remember',
          'vault_search',
          'vault_forget',
          'memory_grep',
          'memory_search',
          'file_read',
          'file_write',
          'tracker_create_project',
          'tracker_create_task',
          'tracker_update_status',
          'tracker_add_notes',
          'tracker_complete_step',
          'get_current_time',
          'send_to_agent',
          'complete_task',
        ],
        deny: [],
      },
      permissions: {
        file_read: [profilePath, soulPath],
        file_write: [profilePath, soulPath],
        file_delete: 'none',
        exec_allow: [],
        exec_deny: ['*'],
        network_domains: 'none',
        max_processes: 0,
        can_spawn_agents: false,
        can_assign_permissions: false,
        system_control: [],
      },
      initialMessage: buildDreamerInitialMessage(unprocessed),
    });

    logger.info('Dreamer agent spawned', {
      dreamerId: result.agentId,
      archives: unprocessed.length,
    });

    return { dreamerId: result.agentId };
  } catch (err) {
    logger.error('Failed to spawn Dreamer agent', {
      error: err instanceof Error ? err.message : String(err),
    });

    // Unmark archives as processed so they can be retried
    const db = getDb();
    for (const conv of unprocessed) {
      db.prepare('UPDATE vault_conversations SET is_processed = 0, processed_at = NULL WHERE id = ?').run(conv.id);
    }

    return { dreamerId: null };
  }
}

// ── First-Run Profile Bootstrap ──

/**
 * After the setup wizard completes, spawn a Dreamer to process the user's
 * "About You" profile (USER.md). The Dreamer extracts long-term facts into
 * the vault and trims the profile down to only what's needed every turn.
 */
export async function runFirstRunProfileBootstrap(): Promise<{ dreamerId: string | null }> {
  const config = getDreamingConfig();
  const modelId = config.modelId ?? getDefaultDreamModel();
  if (!modelId) {
    logger.warn('No model available for first-run profile bootstrap');
    return { dreamerId: null };
  }

  const primaryId = getPrimaryAgentId();
  if (!primaryId) {
    logger.warn('No primary agent found for first-run profile bootstrap');
    return { dreamerId: null };
  }

  // Read the USER.md profile and SOUL.md personality
  const fs = await import('node:fs');
  const path = await import('node:path');
  const os = await import('node:os');
  const profilePath = path.join(os.homedir(), '.dojo', 'prompts', 'USER.md');

  let profileContent = '';
  try { profileContent = fs.readFileSync(profilePath, 'utf-8'); } catch { /* ok */ }

  if (profileContent.trim().length < 50) {
    logger.info('USER.md too short, skipping first-run profile bootstrap');
    return { dreamerId: null };
  }

  const db = getDb();

  logger.info('Spawning first-run Dreamer to bootstrap profile into vault');

  try {
    const result = await spawnAgent({
      parentId: primaryId,
      name: 'Dreamer',
      systemPrompt: `You are processing the dojo owner's profile to optimize token usage. You have one job: split the profile into two parts.

PART 1 (stays in USER.md): Anything the agent needs to know on EVERY turn to behave correctly. This means:
- The owner's name and where they live and their timezone
- How they want to be communicated with
- How they want work done
- What to never do
- Scheduling constraints that affect the agent's behavior
- Work style rules

PART 2 (goes to the vault via vault_remember): Everything else. Biographical details, family members, business descriptions, vehicles, pets, hobbies, interests, food and music preferences, political views, etc. These are facts the agent only needs when the topic comes up.

Instructions:
1. Read the entire profile
2. For each piece of information, decide: does the agent need this to behave correctly on every turn regardless of topic? If yes, it stays. If no, it goes to the vault.
3. Call vault_remember for each fact being moved to the vault. Use the correct type (fact, relationship, preference). Set permanent: true for things that are definitionally stable (names, family, businesses, locations, birth dates).
4. Write the trimmed USER.md to "${profilePath}" using file_write. It should contain ONLY the behavioral and operational content. Do not summarize or reword the behavioral content. Keep the owner's original phrasing.
5. Call complete_task when done.`,
      modelId,
      classification: 'apprentice',
      timeout: 3600,
      persist: false,
      toolsPolicy: {
        allow: [
          'vault_remember',
          'vault_search',
          'file_read',
          'file_write',
          'get_current_time',
          'complete_task',
        ],
        deny: [],
      },
      permissions: {
        file_read: [profilePath],
        file_write: [profilePath],
        file_delete: 'none',
        exec_allow: [],
        exec_deny: ['*'],
        network_domains: 'none',
        max_processes: 0,
        can_spawn_agents: false,
        can_assign_permissions: false,
        system_control: [],
      },
      initialMessage: `Here is the owner's profile. Extract reference facts into the vault, then rewrite the file with those facts removed. Keep all behavioral and operational instructions.

--- USER PROFILE (${profilePath}) ---
${profileContent}
--- END USER PROFILE ---

Use vault_remember for each fact extracted, then file_write to save the trimmed USER.md. Do NOT touch SOUL.md.`,
    });

    logger.info('First-run Dreamer spawned for profile bootstrap', { dreamerId: result.agentId });
    return { dreamerId: result.agentId };
  } catch (err) {
    logger.error('Failed to spawn first-run Dreamer', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { dreamerId: null };
  }
}

// ── Dreaming Scheduler ──

let dreamTimer: ReturnType<typeof setTimeout> | null = null;

export function scheduleDreamingCycle(): void {
  if (dreamTimer) {
    clearTimeout(dreamTimer);
    dreamTimer = null;
  }

  const config = getDreamingConfig();
  if (config.dreamMode === 'off') {
    logger.info('Dreaming is disabled, not scheduling');
    return;
  }

  const [hours, minutes] = config.dreamTime.split(':').map(Number);
  const now = new Date();
  const next = new Date();
  next.setHours(hours, minutes, 0, 0);
  if (next <= now) {
    next.setDate(next.getDate() + 1);
  }

  const delay = next.getTime() - now.getTime();

  logger.info('Dreaming cycle scheduled', {
    nextDream: next.toISOString(),
    delayMs: delay,
    mode: config.dreamMode,
  });

  dreamTimer = setTimeout(async () => {
    try {
      await runDreamingCycle();
    } catch (err) {
      logger.error('Dreaming cycle failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    // Reschedule for next day
    scheduleDreamingCycle();
  }, delay);
}

export function cancelDreamingSchedule(): void {
  if (dreamTimer) {
    clearTimeout(dreamTimer);
    dreamTimer = null;
    logger.info('Dreaming schedule cancelled');
  }
}
