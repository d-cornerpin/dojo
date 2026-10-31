// t285 R2 — one dojo_inspect sql result row, redacted (the config key governs the whole row).

import { REDACTED_CREDENTIAL } from '../credentials/secret-values.js';
import { keyNamesCredential, redactCell, rowAgents, columnNamesCredential } from './redact.js';

/** An output column as the statement reports it: its name, and the table column it comes from. */
export interface ResultColumn { name: string; column: string | null; table: string | null }

/** t285 R2 — one result row, redacted. A cell is blanked under the SOURCE column it was read from
 *  (never only its alias). When the row carries the `config` key and that key names a credential,
 *  EVERY other cell of the row is blanked as well: the value may sit in an alias, behind
 *  `substr(value, …)`, or in any expression. (A statement that reads `config.value` without
 *  selecting `config.key` never reaches here: `refuseDeniedSql` refuses it.) */
export function redactResultRow(columns: readonly ResultColumn[], raw: readonly unknown[], agentIds: readonly string[] = []): unknown[] {
  const keyAt = columns.findIndex((c) => (c.column ?? c.name) === 'key' && (c.table === null || c.table === 'config'));
  const keyed = keyAt !== -1 && keyNamesCredential(raw[keyAt]);
  const names = columns.map((c) => (c.column && columnNamesCredential(c.column) ? c.column : c.name));
  const cells = names.map((n, i) => [n, raw[i]] as [string, unknown]);
  const agents = rowAgents(cells, agentIds);
  return cells.map(([n, v], i) => {
    if (keyed && i !== keyAt && (typeof v === 'string' || Buffer.isBuffer(v))) return REDACTED_CREDENTIAL;
    return redactCell(n, v, agents, keyed);
  });
}

