// Per-agent silent window in ms (default if unset); a leaf so doors can read it without liveness imports.
import { getDb } from '../db/connection.js';

export const DEFAULT_SILENT_WINDOW_MINUTES = 120;
const MIN_MS = 60_000;

export function silentWindowMs(agentId: string): number {
  const m = (getDb().prepare('SELECT silent_window_minutes AS m FROM agents WHERE id = ?').get(agentId) as { m: unknown } | undefined)?.m;
  return (typeof m === 'number' && Number.isInteger(m) && m >= 1 ? m : DEFAULT_SILENT_WINDOW_MINUTES) * MIN_MS;
}
