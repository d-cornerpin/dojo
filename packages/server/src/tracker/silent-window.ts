// ════════════════════════════════════════════════════════════════════════════════════════
// The per-agent silent window (OR-LONG-JOBS, t143), a leaf so a door can read it without the liveness lane's imports.
// The owner: "if there is no movement (no tokens going in or out) for a couple hours, we notify the user?" and "Can we
// make that a per agent setting? That way a user can give an agent they know is slow a longer silent window?"
// Read by the liveness lane (SILENT) and by the exec/shell door (how long a command may stay quiet, audit #14).
// ════════════════════════════════════════════════════════════════════════════════════════
import { getDb } from '../db/connection.js';

/** OR-LONG-JOBS: "a couple hours", confirmed as a per-agent setting with this default. */
export const DEFAULT_SILENT_WINDOW_MINUTES = 120;
const MIN_MS = 60_000;

/** This agent's silent window, in ms. NULL (or anything a door would refuse) is the default. */
export function silentWindowMs(agentId: string): number {
  const m = (getDb().prepare('SELECT silent_window_minutes AS m FROM agents WHERE id = ?').get(agentId) as { m: unknown } | undefined)?.m;
  return (typeof m === 'number' && Number.isInteger(m) && m >= 1 ? m : DEFAULT_SILENT_WINDOW_MINUTES) * MIN_MS;
}
