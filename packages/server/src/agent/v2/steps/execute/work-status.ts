// Active (floor-disarming) status args, never a terminal one; twin STATUS_SYNONYMS in task-status-words.ts.
const ADVANCING_STATUS_ARGS = new Set([
  'in_progress', 'inprogress', 'working', 'active', 'doing', 'started', 'wip',
  'on_deck', 'ondeck', 'todo', 'to_do', 'queued', 'backlog', 'pending',
]);
export function isAdvancingStatusArg(rawStatus: unknown): boolean {
  if (typeof rawStatus !== 'string') return false;
  const key = rawStatus.trim().toLowerCase().replace(/[\s-]+/g, '_');
  return ADVANCING_STATUS_ARGS.has(key);
}
