// The backup copies a rollback would restore. The selection rule lives in `~/.dojo/scripts/rollback.sh`
// and is asked via `--print-target` (read-only); an installed script without that mode is never run
// (it would roll back), so the plausible picks are kept instead. A cleanup never deletes the target.
import path from 'node:path';

// File and process access is handed in by the caller, so this module reaches nothing itself.

export interface RollbackTargetInput {
  dojoDir: string;
  home: string;
  backupPrefix: string;
  recordedBackupDir?: string | null;
  backupsNewestFirst: Array<{ path: string; version: string }>;
  readText: (file: string) => string;
  exists: (file: string) => boolean;
  runScript: (script: string, flag: string, home: string) => string;
}

export function rollbackTargetPaths(i: RollbackTargetInput): string[] {
  const script = path.join(i.dojoDir, 'scripts', 'rollback.sh');
  try {
    if (i.readText(script).includes('--print-target')) {
      const out = i.runScript(script, '--print-target', i.home).trim();
      return out ? [path.resolve(out)] : [];
    }
  } catch { /* script missing or failed: fall through to the conservative set */ }
  const keepers: string[] = [];
  const r = i.recordedBackupDir;
  if (r && path.dirname(r) === i.dojoDir && path.basename(r).startsWith(i.backupPrefix)
    && i.exists(path.join(r, 'package.json'))) keepers.push(path.resolve(r));
  if (i.backupsNewestFirst[0]) keepers.push(path.resolve(i.backupsNewestFirst[0].path));
  const stable = i.backupsNewestFirst.find(b => !b.version.includes('-'));
  if (stable) keepers.push(path.resolve(stable.path));
  return keepers;
}
