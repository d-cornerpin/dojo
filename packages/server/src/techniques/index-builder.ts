// ════════════════════════════════════════
// Technique Index Builder
// Generates a lightweight technique index for agent system prompts
// ════════════════════════════════════════

import { getDb } from '../db/connection.js';

/**
 * Generate the published technique index for injection into system prompts.
 * Target: under 500 tokens for up to 50 techniques (~10 tokens per listing).
 */
export function generateTechniqueIndex(): string {
  const db = getDb();
  const techniques = db.prepare(`
    SELECT id, name, description, tags FROM techniques
    WHERE state = 'published' AND enabled = 1
    ORDER BY usage_count DESC, name ASC
  `).all() as Array<{ id: string; name: string; description: string | null; tags: string }>;

  if (techniques.length === 0) return '';

  let index = '## Available Techniques\n';
  index += 'You have learned the following techniques. When a task matches a technique you have, ALWAYS call `use_technique(name="<technique-id>")` first to load the full instructions before proceeding. Do not improvise when a matching technique exists — the technique may contain specific steps, scripts, or context that improve the result.\n\n';

  for (const t of techniques) {
    let tags = '';
    try {
      const parsed = JSON.parse(t.tags);
      if (Array.isArray(parsed) && parsed.length > 0) {
        tags = ` [${parsed.join(', ')}]`;
      }
    } catch { /* skip */ }
    index += `- **${t.name}** (${t.id}): ${t.description ?? 'No description'}${tags}\n`;
  }

  return index;
}

/**
 * Generate draft technique context for agents in a build squad.
 */
export function generateDraftTechniqueContext(agentGroupId: string | null): string {
  if (!agentGroupId) return '';

  const db = getDb();
  const drafts = db.prepare(`
    SELECT id, name, state, directory_path FROM techniques
    WHERE build_squad_id = ? AND state IN ('draft', 'review')
  `).all(agentGroupId) as Array<{ id: string; name: string; state: string; directory_path: string }>;

  if (drafts.length === 0) return '';

  const parts: string[] = [];
  for (const t of drafts) {
    parts.push(`## Technique in Development: ${t.name}`);
    parts.push(`You are helping build this technique. Workspace: ${t.directory_path}`);
    parts.push(`Current TECHNIQUE.md: ${t.directory_path}/TECHNIQUE.md`);
    parts.push(`Status: ${t.state}`);
    parts.push('');
  }

  return parts.join('\n');
}
