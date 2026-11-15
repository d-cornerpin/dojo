// The one "resolve inside this folder" check: the export never follows an entry out of a technique
// folder (reported as a skipped link); agent writes and reads are not limited to it. A leaf (fs, path only).

import fs from 'node:fs';
import path from 'node:path';
// Real path of the nearest existing part of `p`, or null when an entry exists but cannot be resolved
// (dead link or loop: a write through it could land anywhere, so the caller treats it as outside).
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

export function insideFolder(dirPath: string, rel: string): string | null {
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

// Supporting-file names resolved against `dirPath` (absolute or climbing names are written where they say);
// only an unwritable name (empty, not text) is refused.
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
