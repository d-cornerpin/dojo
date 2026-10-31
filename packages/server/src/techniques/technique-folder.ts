// ════════════════════════════════════════
// THE TECHNIQUE FOLDER'S DISK DOOR — the one "resolve inside this folder" check, in one place.
//
// Requirement: a path that comes from outside the platform (an agent's supporting-file name, a
// package's technique id, an entry found while walking a folder) may only ever land strictly inside
// the folder it is meant for. Absolute paths, dot segments and links that point out are refused.
// A pure leaf (node:fs and node:path only) so any module can import it.
// ════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
/**
 * Every id the store has ever made: `createTechnique` (store.ts) slugs a name with
 * `toLowerCase().replace(/[^a-z0-9-]/g, '-')`, so lowercase letters, digits and dashes (a dash may
 * lead). 255 characters is the longest folder name the disk allows.
 */
export function isSafeTechniqueId(id: unknown): id is string {
  return typeof id === 'string' && /^[a-z0-9-]+$/.test(id) && id.length <= 255;
}

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
 * Every supporting-file name resolved inside `dirPath`: a Map of name to full path, or the plain
 * refusal for the first name that does not stay inside (callers write nothing in that case).
 */
export function supportingFileTargets(dirPath: string, files: Array<{ path: string }> | undefined): Map<string, string> | string {
  const targets = new Map<string, string>();
  for (const file of files ?? []) {
    const target = insideTechniqueDir(dirPath, file.path);
    if (target === null) return `Supporting file path "${file.path}" must stay inside the technique folder.`;
    targets.set(file.path, target);
  }
  return targets;
}
