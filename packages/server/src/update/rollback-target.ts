// THE COPY(IES) A ROLLBACK WOULD RESTORE. There is ONE selection rule and it lives in
// `~/.dojo/scripts/rollback.sh`: this asks the script itself (`--print-target`, read-only: no lock,
// no services, no moves), so stable releases outrank pre-releases here exactly as they do there. A
// cleanup never deletes it, whatever `keep` says (t286). An installed script that predates that
// mode is NEVER run (it would roll back); then the plausible picks are kept, which errs toward
// keeping a copy.
import path from 'node:path';

// The file and process access is handed in by the caller (the update route, which already holds it),
// so this module reaches nothing itself.

export interface RollbackTargetInput {
  dojoDir: string;
  home: string;
  backupPrefix: string;
  /** `backupDir` from the update marker, when there is one. */
  recordedBackupDir?: string | null;
  /** The `platform.backup-*` folders, newest version first. */
  backupsNewestFirst: Array<{ path: string; version: string }>;
  readText: (file: string) => string;
  exists: (file: string) => boolean;
  /** Runs rollback.sh with the given flag and returns its stdout. */
  runScript: (script: string, flag: string, home: string) => string;
}

export function rollbackTargetPaths(i: RollbackTargetInput): string[] {
  const script = path.join(i.dojoDir, 'scripts', 'rollback.sh');
  try {
    if (i.readText(script).includes('--print-target')) {
      const out = i.runScript(script, '--print-target', i.home).trim();
      return out ? [out] : [];
    }
  } catch { /* script missing or failed: fall through to the conservative set */ }
  const keepers: string[] = [];
  const r = i.recordedBackupDir;
  if (r && path.dirname(r) === i.dojoDir && path.basename(r).startsWith(i.backupPrefix)
    && i.exists(path.join(r, 'package.json'))) keepers.push(r);
  if (i.backupsNewestFirst[0]) keepers.push(i.backupsNewestFirst[0].path);
  const stable = i.backupsNewestFirst.find(b => !b.version.includes('-'));
  if (stable) keepers.push(stable.path);
  return keepers;
}
