// Blanks by SOURCE column, never only alias; no key/value rule: sql-child.ts already blanks config's values.

import { columnNamesCredential, redactCell, rowAgents } from './redact.js';

export interface ResultColumn { name: string; column: string | null; table: string | null }

export function redactResultRow(columns: readonly ResultColumn[], raw: readonly unknown[], agentIds: readonly string[] = []): unknown[] {
  const cells = columns.map((c, i) => [c.column && columnNamesCredential(c.column) ? c.column : c.name, raw[i]] as [string, unknown]);
  const agents = rowAgents(cells, agentIds);
  return cells.map(([n, v]) => redactCell(n, v, agents, false));
}
