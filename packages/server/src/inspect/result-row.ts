// t285 F1 — one dojo_inspect sql result row, redacted. The config table's credential values are
// already blanked at the source (the child shows `config` through a TEMP VIEW, `sql-child.ts`),
// so only the column rules remain: a cell is blanked under the SOURCE column it was read from
// (never only its alias), then every string cell is scrubbed.

import { columnNamesCredential, redactCell, rowAgents } from './redact.js';

/** An output column as the statement reports it: its name, and the table column it comes from. */
export interface ResultColumn { name: string; column: string | null; table: string | null }

export function redactResultRow(columns: readonly ResultColumn[], raw: readonly unknown[], agentIds: readonly string[] = []): unknown[] {
  const cells = columns.map((c, i) => [c.column && columnNamesCredential(c.column) ? c.column : c.name, raw[i]] as [string, unknown]);
  const agents = rowAgents(cells, agentIds);
  return cells.map(([n, v]) => redactCell(n, v, agents, false));
}
