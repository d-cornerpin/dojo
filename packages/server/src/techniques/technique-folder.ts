// ════════════════════════════════════════
// THE TECHNIQUE FOLDER'S DISK DOOR — the one "resolve inside this folder" check, in one place.
//
// Requirement: the EXPORT walks a technique folder and never follows an entry that leads outside it
// (it is reported as a skipped link). Writes and reads the agent asks for are NOT limited to the
// folder: the Mac belongs to the agent (OR-MAC-BELONGS-TO-THE-AGENT).
// A pure leaf (node:fs and node:path only) so any module can import it.
// ════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
/**
 * The real path of the nearest part of `p` that exists (so a link anywhere along it is followed),
 * or null when an entry exists but cannot be resolved (a broken link or a link loop): a write
 * through it could land anywhere, so the caller must treat it as outside.
 */
function realOfNearestExisting(p: string): string | null {
  let cur = p;
  for (;;) {
    try { return fs.realpathSync(cur); } catch { /* not resolvable: missing, or a dead link */ }
    try { fs.lstatSync(cur); return null; } catch { /* truly not there yet */ }
    const parent = path.dirname(cur);
    if (parent === cur) return cur;
    cur = parent;
  }
}

/**
 * The full path of `rel` inside `dirPath`, or null when `rel` is empty, not a string, absolute,
 * resolves to the folder itself or outside it, or passes through a link that leads outside.
 */
export function insideTechniqueDir(dirPath: string, rel: string): string | null {
  if (typeof rel !== 'string' || rel === '' || rel.includes('\0') || path.isAbsolute(rel)) return null;
  const root = path.resolve(dirPath);
  const resolved = path.resolve(root, rel);
  if (!resolved.startsWith(root + path.sep)) return null;
  const realRoot = realOfNearestExisting(root);
  const realTarget = realOfNearestExisting(resolved);
  if (realRoot === null || realTarget === null) return null;
  if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) return null;
  return resolved;
}

/**
 * Every supporting-file name resolved against `dirPath`: a Map of name to full path. The Mac belongs
 * to the agent (OR-MAC-BELONGS-TO-THE-AGENT), so an absolute name or one that climbs out is written
 * where it says. Only a name that cannot be written at all (empty, not text) is refused.
 */
export function supportingFileTargets(dirPath: string, files: Array<{ path: string }> | undefined): Map<string, string> | string {
  const targets = new Map<string, string>();
  for (const file of files ?? []) {
    if (typeof file.path !== 'string' || file.path === '' || file.path.includes('\0')) {
      return `Supporting file path ${JSON.stringify(file.path)} is not a usable file name.`;
    }
    targets.set(file.path, path.resolve(dirPath, file.path));
  }
  return targets;
}
