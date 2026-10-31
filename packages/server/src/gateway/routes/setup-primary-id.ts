import type Database from 'better-sqlite3';
import { isPastFirstRun } from '../../config/setup-state.js';

/**
 * Which agent a setup provision call is about, and which placeholder agents it may remove.
 * The primary is found by the stored primary_agent_id, never by the name typed in the wizard:
 * after first run, a primary request naming a different id means the stored primary (when that
 * agent exists). Placeholder agents (primary, pm) are removed only during first run; later an
 * agent with such an id is a real agent with history. The caller reads the id back from the response.
 */
export function resolveProvision(db: Database.Database, requestedId: string, primary: boolean | undefined): { id: string; placeholders: string[] } {
  if (!isPastFirstRun()) return { id: requestedId, placeholders: ['primary', 'pm'] };
  let id = requestedId;
  if (primary === true) {
    const stored = db.prepare("SELECT value FROM config WHERE key = 'primary_agent_id'").get() as { value: string } | undefined;
    if (stored?.value && db.prepare('SELECT id FROM agents WHERE id = ?').get(stored.value)) id = stored.value;
  }
  return { id, placeholders: [] };
}
