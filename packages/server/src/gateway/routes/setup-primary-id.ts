import type Database from 'better-sqlite3';
import { isPastFirstRun } from '../../config/setup-state.js';

// Resolves the agent a provision call is about: after first run a primary request maps to the stored
// primary_agent_id when it exists; placeholders (primary, pm) are removed only during first run.
export function resolveProvision(db: Database.Database, requestedId: string, primary: boolean | undefined): { id: string; placeholders: string[] } {
  if (!isPastFirstRun()) return { id: requestedId, placeholders: ['primary', 'pm'] };
  let id = requestedId;
  if (primary === true) {
    const stored = db.prepare("SELECT value FROM config WHERE key = 'primary_agent_id'").get() as { value: string } | undefined;
    const exists = (x: string) => !!db.prepare('SELECT id FROM agents WHERE id = ?').get(x);
    if (stored?.value && exists(stored.value)) id = stored.value;
    else for (let n = 2; exists(id); n++) id = `${requestedId}-${n}`; // stale pointer: create fresh, never adopt another agent
  }
  return { id, placeholders: [] };
}
