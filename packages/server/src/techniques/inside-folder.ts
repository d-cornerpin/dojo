// ════════════════════════════════════════
// "RESOLVE INSIDE THIS FOLDER" — the one check every technique file write, import and export uses.
//
// Requirement: a path that comes from outside the platform (an agent's supporting-file name, a
// package's technique id, an entry found while walking a folder) may only ever land strictly inside
// the folder it is meant for. Absolute paths, dot segments and links that point out are refused.
// A pure leaf (node:fs and node:path only) so any module can import it.
// ════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';

/** The shape the store gives every technique id (`createTechnique` slugs names to this). */
export function isSafeTechniqueId(id: unknown): id is string {
  return typeof id === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(id) && id.length <= 200;
}

/** The real path of the nearest part of `p` that exists (so a link anywhere along it is followed). */
function realOfNearestExisting(p: string): string {
  let cur = p;
  for (;;) {
    try { return fs.realpathSync(cur); } catch { /* not there yet */ }
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
  if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) return null;
  return resolved;
}
