// ════════════════════════════════════════
// Migration Import — safe put-back of the owner's data after a failed import
// ════════════════════════════════════════

import fs from 'node:fs';

/**
 * Put the backup THIS run made back at `dojoDir`, without ever leaving the owner with no data:
 * the failed tree is renamed ASIDE first, the backup is renamed in, and only then is the failed
 * tree deleted. If the rename-in fails, nothing is deleted and nothing is restarted onto a
 * missing folder: the backup stays exactly where it is and the caller is told where.
 */
export function putBackOwnBackup(dojoDir: string, backup: string): { ok: true } | { ok: false; backup: string; reason: string } {
  const aside = `${dojoDir}-failed-import-${Date.now()}`;
  let movedAside = false;
  try {
    if (fs.existsSync(dojoDir)) { fs.renameSync(dojoDir, aside); movedAside = true; }
    fs.renameSync(backup, dojoDir);
  } catch (e) {
    return { ok: false, backup, reason: e instanceof Error ? e.message : String(e) };
  }
  if (movedAside) { try { fs.rmSync(aside, { recursive: true, force: true }); } catch { /* disposable; leave it */ } }
  return { ok: true };
}
