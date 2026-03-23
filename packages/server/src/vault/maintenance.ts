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

function buildDreamerPrompt(
  unprocessed: VaultConversation[],
  dreamMode: DreamMode,
  stats: ReturnType<typeof getVaultStats>,
): string {
  // Summarize what needs processing
  const archiveSummary = unprocessed.map((conv, i) => {
    return `Archive ${i + 1}: Agent "${conv.agentName ?? conv.agentId}", ${conv.messageCount} messages, ${conv.tokenCount} tokens (${conv.earliestAt} to ${conv.latestAt}), ID: ${conv.id}`;
  }).join('\n');

  const trainerName = getTrainerAgentName();
  const trainerId = getTrainerAgentId();
  const techniqueInstructions = dreamMode === 'full' ? `
- IDENTIFY TECHNIQUES: If a conversation contains a reusable multi-step procedure or workflow that other agents would benefit from, send a message to the Trainer agent (**${trainerName}**, ID: ${trainerId}) via send_to_agent describing the technique candidate. Include: a suggested name, what it does, and the step-by-step instructions. The Trainer is the technique expert -- let them create and refine it. Only flag genuinely reusable processes, not one-off commands.` : '';

  return `You are the Dreamer -- a specialized agent that processes the dojo's daily conversations into long-term memories.

# Your Mission

The dojo has ${unprocessed.length} unprocessed conversation archive(s) that need to be turned into vault memories. You also need to review the vault for duplicates and consolidation opportunities.

# Current Vault State

- Total entries: ${stats.totalEntries} (${stats.pinnedCount} pinned, ${stats.permanentCount} permanent)
- Average confidence: ${(stats.avgConfidence * 100).toFixed(0)}%
- Unprocessed archives: ${unprocessed.length}

# Archives to Process

${archiveSummary}

# How to Work

1. **Create a project in the tracker** called "Dream Cycle [date]" with tasks for each step.
2. **For each unprocessed archive:**
   a. Read the archive content (it will be provided in your conversation)
   b. Extract every piece of knowledge worth remembering:
      - Facts about the user, their businesses, projects, preferences
      - Decisions that were made and WHY
      - Procedures or workflows that were figured out
      - Relationships between people, systems, or projects
      - Events with specific dates
      - Corrections the user made (high priority!)
   c. For each piece of knowledge, call vault_remember with:
      - content: standalone statement (someone with no context should understand it)
      - type: fact | preference | decision | procedure | relationship | event | note
      - tags: relevant categorization tags
      - permanent: true for definitionally stable truths (names, family, business identities)
   d. Do NOT save: routine tool calls, transient debugging, small talk, info already in the vault${techniqueInstructions}
3. **After processing all archives**, search the vault for potential duplicates or entries that could be consolidated. If you find entries that say essentially the same thing, use vault_forget on the less detailed one.
4. **When done**, call complete_task with a summary of what you extracted and any observations.

# Rules

- Write every vault entry as a STANDALONE statement -- it must make sense to someone reading it with zero context
- Be thorough -- extract MORE rather than less. It's better to over-remember than to lose knowledge.
- Check vault_search before saving to avoid duplicates
- Mark stable facts as permanent: true (names, family members, business names, locations)
- Keep each entry under 500 tokens
- Update your tracker tasks as you go so the PM can see your progress`;
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
      systemPrompt: buildDreamerPrompt(unprocessed, config.dreamMode, stats),
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
        file_read: [],
        file_write: [],
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
  const soulPath = path.join(os.homedir(), '.dojo', 'prompts', 'SOUL.md');

  let profileContent = '';
  let soulContent = '';
  try { profileContent = fs.readFileSync(profilePath, 'utf-8'); } catch { /* ok */ }
  try { soulContent = fs.readFileSync(soulPath, 'utf-8'); } catch { /* ok */ }

  if (profileContent.trim().length < 50 && soulContent.trim().length < 50) {
    logger.info('USER.md and SOUL.md too short, skipping first-run profile bootstrap');
    return { dreamerId: null };
  }

  // Get owner name and primary agent name for context
  const db = getDb();
  const ownerRow = db.prepare("SELECT value FROM config WHERE key = 'owner_name'").get() as { value: string } | undefined;
  const ownerName = ownerRow?.value ?? 'the owner';
  const agentNameRow = db.prepare("SELECT value FROM config WHERE key = 'primary_agent_name'").get() as { value: string } | undefined;
  const agentName = agentNameRow?.value ?? 'the primary agent';

  logger.info('Spawning first-run Dreamer to bootstrap profile into vault');

  try {
    const result = await spawnAgent({
      parentId: primaryId,
      name: 'Dreamer',
      systemPrompt: `You are the Dreamer -- a specialized agent that processes knowledge into the dojo's long-term memory vault.

# Your Mission (First-Run Bootstrap)

This is the dojo's very first dream. The owner (${ownerName}) just set up the dojo. You have two files to process. Both files get sent to the agent on EVERY single turn, so every token counts. Your job is to move encyclopedic/reference information into the vault (where it's retrieved only when relevant) while keeping operational instructions and personality in the files (where the agent needs them every turn).

# THE KEY DISTINCTION

Ask yourself for each piece of information: "Does the agent need this to behave correctly on EVERY turn, regardless of topic?"

- YES = stays in the file (personality, tone, formatting rules, work style, how-to-communicate instructions)
- NO = goes to the vault (facts about the owner's life, family details, business details, vehicle info, hobbies, biographical data)

## 1. USER.md (Owner Profile -- "${profilePath}")

**MUST STAY in the file (needed every turn):**
- How the owner wants to be communicated with (tone, directness, formality level)
- Formatting rules that affect every response (e.g., "hates emdashes", "dark mode", "keep it concise")
- Work style that affects how the agent should behave (e.g., "prefers results over proposals", "don't hand-hold", "night owl so late messages are normal")
- Timezone (affects scheduling every turn)
- Scheduling conflicts that affect availability (e.g., recurring appointments where owner is unavailable)
- Any "always do this" or "never do that" rules

**EXTRACT to the vault (reference info, not needed every turn):**
- Biographical details (age, birthday, where they grew up)
- Family members' names, ages, jobs, vehicles -- vault these as individual entries
- Business descriptions and details (what the business does, clients, history)
- Hobbies and interests (fishing, cameras, music preferences, food preferences)
- Vehicles
- Extended family
- Pets
- Political/religious views
- Anything that's "about the person" rather than "how to work with the person"

**Target:** The trimmed USER.md should be roughly 150-250 tokens. It should read like a quick operational briefing, not a biography.

## 2. SOUL.md (Agent Personality & Instructions -- "${soulPath}")

**MUST STAY in the file (defines every interaction):**
- The agent's identity and role (who they are to the owner)
- The agent's personality and voice (casual, direct, funny, etc.)
- Communication rules (no corporate speak, swearing OK, no emdashes, etc.)
- How the agent should approach work (just do it, don't ask permission, use the tracker, etc.)
- Relationship dynamics (how to interact with the owner, when to push back, when to be low-maintenance)
- Rules about other agents (how to manage sub-agents, respect the PM, etc.)
- Rules about the machine/system (be protective, don't run destructive commands, etc.)
- Any "always" or "never" behavioral rules

**EXTRACT to the vault (situational/reference info mixed into the personality):**
- Specific facts about the owner that were embedded in the personality text (business details, family info, etc. that are ALSO in USER.md)
- Specific project context or references to current work
- Anything that's biographical/factual rather than behavioral/instructional

**DO NOT simplify or shorten the personality voice.** The SOUL.md defines how the agent talks and thinks. If the owner wrote it in a specific voice with specific energy, preserve that energy. You can remove factual content that belongs in the vault, but do NOT rewrite the personality into something generic or corporate. The agent should still sound exactly like the owner intended.

# Rules
- For each extracted fact, use vault_remember with the appropriate type
- Mark definitionally stable facts as permanent: true (names, family, businesses, locations)
- vault_search before saving to avoid duplicates
- Rewrite BOTH files -- read each one, extract facts, then write the trimmed version back
- Do NOT flatten the personality. If the SOUL.md has attitude and voice, keep that attitude and voice.
- Do NOT vault behavioral rules. "Hates emdashes" is a BEHAVIORAL RULE (stays in file), not a preference to vault.
- Do NOT vault relationship dynamics. "Right hand man, not an assistant" is IDENTITY (stays in file), not a fact to vault.
- When done, call complete_task with a summary of what you extracted and how much you trimmed`,
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
      initialMessage: `Here are the two files to process. Extract long-term facts into the vault, then trim both files down to essentials.

--- USER PROFILE (${profilePath}) ---
${profileContent}
--- END USER PROFILE ---

--- AGENT PERSONALITY (${soulPath}) ---
${soulContent}
--- END AGENT PERSONALITY ---

Process USER.md first (extract facts, rewrite trimmed), then SOUL.md (extract case-by-case stuff, simplify personality). Use vault_remember for each fact, then file_write for each trimmed file.`,
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
