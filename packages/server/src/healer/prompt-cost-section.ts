// ════════════════════════════════════════
// The Healer's "what each agent's standing instruction costs" section (K36): per agent, the three
// largest sections with their tokens and how much each has grown since its growth reference.
// A report, not a limit.
// ════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { promptCostReport } from '../memory/prompt-sections.js';
import type { DiagnosticItem } from './diagnostic.js';

const TOP_SECTIONS = 3;

const signed = (n: number): string => (n > 0 ? `+${n}` : String(n));

export function getPromptCostItems(): DiagnosticItem[] {
  const agents = getDb().prepare(
    `SELECT a.id, a.name FROM agents a WHERE EXISTS (SELECT 1 FROM prompt_sections p WHERE p.agent_id = a.id) ORDER BY a.name`,
  ).all() as Array<{ id: string; name: string }>;
  const lines: string[] = [];
  for (const a of agents) {
    const r = promptCostReport(a.id);
    if (r.sections.length === 0) continue;
    const top = r.sections.slice(0, TOP_SECTIONS)
      .map((s) => `${s.entryId} ${s.tokens} tokens${s.growth ? ` (${signed(s.growth)} since the last reference)` : ''}`);
    lines.push(`- ${a.name}: ${r.systemTokens} tokens in all; largest: ${top.join(', ')}`);
  }
  if (lines.length === 0) return [];
  return [{
    severity: 'info',
    code: 'PROMPT_COST',
    title: 'What each agent\'s standing instruction costs',
    detail: `Standing instruction, three largest sections per agent:\n${lines.join('\n')}`,
  }];
}
