// ════════════════════════════════════════
// The Healer's "recurring tool errors this week" section (K37). A report, not a limit: it lists
// the tool errors that happened more than once in the last seven days, with how many times, how
// many agents, a sample, and whether the remedy registry (tools/error-remedies.ts) has an answer
// for it. An error with no remedy is the Healer's cue to ask for one.
// ════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { hasRemedy } from '../tools/error-remedies.js';
import type { DiagnosticItem } from './diagnostic.js';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
// "Recurring" is arithmetic: it happened more than once.
const RECURRING_MIN_HITS = 2;

interface SignatureRow { tool: string; sample: string; hits: number; agents: string }

export function getRecurringToolErrors(): DiagnosticItem[] {
  const rows = getDb().prepare(
    `SELECT tool, sample, hits, agents FROM tool_error_signatures
      WHERE hits >= ? AND last_at > ? ORDER BY hits DESC, last_at DESC`,
  ).all(RECURRING_MIN_HITS, Date.now() - WEEK_MS) as SignatureRow[];
  if (rows.length === 0) return [];
  const lines = rows.map((r) => {
    const agents = (JSON.parse(r.agents) as string[]).length;
    const remedy = hasRemedy(r.tool, r.sample) ? 'yes' : 'no';
    return `- ${r.tool}: ${r.hits} hits, ${agents} agent${agents === 1 ? '' : 's'}, remedy registered: ${remedy}. Sample: ${r.sample}`;
  });
  return [{
    severity: 'info',
    code: 'RECURRING_TOOL_ERRORS',
    title: `${rows.length} tool error${rows.length === 1 ? '' : 's'} recurred this week`,
    detail: `Recurring tool errors this week (tool, hits, agents, remedy):\n${lines.join('\n')}`,
  }];
}
