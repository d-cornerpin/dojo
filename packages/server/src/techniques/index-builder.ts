// Builds the technique index injected into agent system prompts.

import { getDb } from '../db/connection.js';
import { mayUseTechnique } from '../agent/access/read.js';

// Published technique index for system prompts (about 10 tokens per listing). Without `agentId` every
// published technique is listed, never a silently narrowed set.
export function generateTechniqueIndex(agentId?: string): string {
  const db = getDb();
  const all = db.prepare(`
    SELECT id, name, description, tags FROM techniques
    WHERE state = 'published' AND enabled = 1
    ORDER BY usage_count DESC, name ASC
  `).all() as Array<{ id: string; name: string; description: string | null; tags: string }>;

  // Same predicate as `use_technique` access, so no agent is advertised a procedure it would be refused.
  const techniques = agentId ? all.filter((t) => mayUseTechnique(agentId, t.id)) : all;

  if (techniques.length === 0) return '';

  let index = '## Available Techniques\n';
  // The live user message outranks a technique's standing steps.
  index += 'You have learned the following techniques. When a task matches one, call `use_technique(name="<technique-id>")` first to load the full instructions, then follow them — they carry steps, scripts, and context that improve the result. The user\'s live message outranks a technique: if they conflict, follow the user.\n\n';

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

// Draft technique context for agents in a build squad.
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
