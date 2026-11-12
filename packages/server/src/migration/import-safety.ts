// Safe put-back of the owner's data after a failed import; the caller passes `fs` in (no fs import here).


interface Fs {
  existsSync(p: string): boolean;
  renameSync(from: string, to: string): void;
  rmSync(p: string, o: { recursive?: boolean; force?: boolean }): void;
  mkdtempSync(prefix: string): string;
  writeFileSync(p: string, data: string): void;
  readFileSync(p: string, enc: 'utf-8'): string;
  cpSync(from: string, to: string, o: { recursive: boolean; verbatimSymlinks: boolean }): void;
}
import path from 'node:path';

// Put the backup this run made back at `dojoDir` without ever leaving the owner with no data: the failed tree
// is renamed aside first, the backup renamed in, and only then is the failed tree deleted. If the rename-in
// fails nothing is deleted or restarted onto a missing folder; the caller is told where the backup stays.
export function putBackOwnBackup(fs: Fs, dojoDir: string, backup: string): { ok: true } | { ok: false; backup: string; reason: string } {
  const aside = `${dojoDir}-failed-import-${Date.now()}`;
  let movedAside = false;
  try {
    if (fs.existsSync(dojoDir)) { fs.renameSync(dojoDir, aside); movedAside = true; }
    try {
      fs.renameSync(backup, dojoDir);
    } catch (renameErr) {
      // A refused rename (another volume, a permission on the parent) falls back to a COPY that goes in whole
      // or not at all (a partial one is removed); the backup is then removed too.
      try {
        fs.cpSync(backup, dojoDir, { recursive: true, verbatimSymlinks: true });
      } catch (copyErr) {
        try { fs.rmSync(dojoDir, { recursive: true, force: true }); } catch { }
        throw new Error(`${renameErr instanceof Error ? renameErr.message : String(renameErr)}; copying it back failed too: ${copyErr instanceof Error ? copyErr.message : String(copyErr)}`);
      }
      try { fs.rmSync(backup, { recursive: true, force: true }); } catch { /* a leftover copy; the data is back */ }
    }
  } catch (e) {
    // ~/.dojo must never vanish: put the live data we set aside back where it was.
    if (movedAside) { try { fs.renameSync(aside, dojoDir); } catch { /* best effort; the backup is intact and returned */ } }
    return { ok: false, backup, reason: e instanceof Error ? e.message : String(e) };
  }
  if (movedAside) { try { fs.rmSync(aside, { recursive: true, force: true }); } catch { /* disposable; leave it */ } }
  return { ok: true };
}

// One import at a time. The lock is a directory next to ~/.dojo (the folder is swapped during an import)
// holding the owner's pid. It is written fully, then RENAMED into place, so a lock never exists without its
// pid and two racers cannot both win. A dead holder's lock is renamed away, then deleted, never in place.

export class ImportAlreadyRunningError extends Error {
  constructor() { super('An import is already running. Wait for it to finish, then try again.'); this.name = 'ImportAlreadyRunningError'; }
}

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
};

const holderOf = (fs: Fs, lock: string): number | null => {
  try { const n = Number(fs.readFileSync(path.join(lock, 'pid'), 'utf-8')); return Number.isInteger(n) && n > 0 ? n : null; } catch { return null; }
};

export function acquireImportLock(fs: Fs, lock: string): () => void {
  for (let attempt = 0; attempt < 3; attempt++) {
    const fresh = fs.mkdtempSync(`${lock}.new-`);
    fs.writeFileSync(path.join(fresh, 'pid'), String(process.pid));
    try {
      fs.renameSync(fresh, lock); // fails if a lock already stands
      return () => { if (holderOf(fs, lock) === process.pid) fs.rmSync(lock, { recursive: true, force: true }); };
    } catch (e) {
      fs.rmSync(fresh, { recursive: true, force: true });
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'ENOTEMPTY' && code !== 'EEXIST') throw e;
    }
    const holder = holderOf(fs, lock);
    if (holder !== null && alive(holder)) throw new ImportAlreadyRunningError();
    // Dead (or unreadable) holder: rename the lock away atomically; only one racer's rename succeeds.
    const stale = `${lock}.stale-${process.pid}-${Date.now()}-${attempt}`;
    try { fs.renameSync(lock, stale); } catch { continue; }
    if (holderOf(fs, stale) !== holder && holderOf(fs, stale) !== null && alive(holderOf(fs, stale)!)) {
      // We moved a live lock another racer had just taken: put it back, and refuse.
      try { fs.renameSync(stale, lock); } catch { /* the lock is gone either way */ }
      throw new ImportAlreadyRunningError();
    }
    fs.rmSync(stale, { recursive: true, force: true });
  }
  throw new ImportAlreadyRunningError();
}
