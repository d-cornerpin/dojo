// ════════════════════════════════════════
// Technique Index Builder
// Generates a lightweight technique index for agent system prompts
// ════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { mayUseTechnique } from '../agent/access/read.js';

/**
 * Generate the published technique index for injection into system prompts.
 * Target: under 500 tokens for up to 50 techniques (~10 tokens per listing).
 *
 * UX-ACCESS A4 — IT TAKES AN AGENT NOW. It never did: the sole caller
 * (`prompt/registry/entries.ts`'s `sys.techniques-index`) was written
 * `render: () => generateTechniqueIndex()`, discarding the context, so the one
 * place a per-agent filter could attach threw the agent id away and every agent
 * on the box read the same advertisement. `agentId` is OPTIONAL because the
 * honest absence answer is the pre-A4 one — every published technique — and a
 * caller that genuinely has no agent (a dashboard preview, a test) must not get
 * a silently narrowed list.
 */
export function generateTechniqueIndex(agentId?: string): string {
  const db = getDb();
  const all = db.prepare(`
    SELECT id, name, description, tags FROM techniques
    WHERE state = 'published' AND enabled = 1
    ORDER BY usage_count DESC, name ASC
  `).all() as Array<{ id: string; name: string; description: string | null; tags: string }>;

  // The SAME predicate the `use_technique` door asks (`checkTechniqueAccess`),
  // so an agent is never advertised a procedure it would then be refused — the
  // advertised-vs-permitted drift this phase exists to end.
  const techniques = agentId ? all.filter((t) => mayUseTechnique(agentId, t.id)) : all;

  if (techniques.length === 0) return '';

  let index = '## Available Techniques\n';
  // Audit C4: ladder-anchored, not absolute — the live user message outranks
  // a technique's standing steps (precedence tier 1 vs tier 2).
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
