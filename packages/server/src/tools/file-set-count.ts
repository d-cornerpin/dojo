// v3.5 field fix 3, audit #5: the FILE-SET counter behind a task's measure (work/measure.ts).
//
// A measure `{ tool: "file_list", args: { path, pattern } }` names a set of files that is still to do
// (the PDFs in an inbox folder, the drafts not yet filed). The engine counts the files under `path`
// whose path relative to it matches the glob `pattern`, by walking the real directory: the count is
// bounded by what is on disk, never by a number. Glob: `*` and `?` stay within one folder, `**` crosses
// folders. A pattern without `**` is only walked as deep as it reaches. Symlinked folders are not
// followed (a loop cannot inflate the count). A directory that is not there, or cannot be read, is a
// reading that could not be made, never 0.
//
// Authorization: the measure is checked with `file_list`'s own gates before every count
// (`agent/tools/cat/measure-door.ts` `refusalFor`), so this walk only ever reads a tree the agent's
// own read grant covers. It runs on the platform's timing (at the end of a turn, at a close), outside
// any tool call's capability, which is why it reads the disk directly (see the effect-import list).
import fs from 'node:fs';
import path from 'node:path';
import { resolveHomePath } from '../agent/path-resolve.js';
import { isFsCaseInsensitive } from '../agent/fs-case.js';

// Re-review 2 (S2, S10) on top of the above:
//   * CASE: the glob follows the measured folder's OWN volume (a `Scan 12.PDF` matches "*.pdf" exactly
//     when that volume ignores case). Measured read-only on the folder itself (`volumeIgnoresCase`),
//     because the boot probe measures only the volume the Dojo's data lives on; it is the fallback
//     only when no folder name on the path has a letter to flip.
//   * BOUND: the walk is registered under the agent's own stop (`openAgentCall`, `turn` scope), so the
//     turn's abort ends it; a stopped walk is no reading, never a partial count. No count or depth limit.
//   * UNREADABLE: a subfolder that cannot be read is NAMED in the reading (`unreadable`) and the rest is
//     still counted; only an unreadable top folder is no reading.
//   * SYMLINKS: never followed (a symlinked folder is neither walked nor counted), so no loop.

/** The folder's own case sensitivity: stat it under a case-flipped name and compare the inode. */
async function volumeIgnoresCase(dir: string): Promise<boolean> {
  let p = dir;
  for (;;) {
    const name = path.basename(p);
    const flipped = [...name].map((c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase())).join('');
    if (flipped !== name) {
      try {
        const [a, b] = await Promise.all([fs.promises.stat(p), fs.promises.stat(path.join(path.dirname(p), flipped))]);
        return a.dev === b.dev && a.ino === b.ino;
      } catch {
        return false;   // the flipped name is not there: this volume tells case apart
      }
    }
    const parent = path.dirname(p);
    if (parent === p) return isFsCaseInsensitive();
    p = parent;
  }
}

/** The glob as a whole-path matcher over POSIX relative paths. */
function globMatcher(pattern: string, ignoreCase: boolean): RegExp {
  let re = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      const slash = pattern[i + 2] === '/';
      re += slash ? '(?:.*/)?' : '.*';
      i += slash ? 2 : 1;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, ignoreCase ? 'i' : '');
}

export type FileSetCount = { ok: true; count: number; unreadable?: string[] } | { ok: false; error: string };

export async function countFileSet(args: { path?: string; pattern?: string }, agentId?: string): Promise<FileSetCount> {
  const base = resolveHomePath(String(args.path ?? ''));
  const pattern = (args.pattern ?? '*').trim() || '*';
  if (!path.isAbsolute(base)) return { ok: false, error: `the measure's path must be absolute (got "${args.path ?? ''}")` };
  let stat: fs.Stats;
  try { stat = await fs.promises.stat(base); } catch { return { ok: false, error: `directory not found: ${base}` }; }
  if (!stat.isDirectory()) return { ok: false, error: `not a directory: ${base}` };
  const { openAgentCall } = await import('../agent/abortable-call.js');
  const slot = agentId ? openAgentCall(agentId, 'turn') : null;
  try {
    if (slot?.refused) return { ok: false, error: 'stopped before the count started' };
    const match = globMatcher(pattern, await volumeIgnoresCase(base));
    // How deep the pattern can reach: unlimited with `**`, else one level per `/`.
    const maxDepth = pattern.includes('**') ? Infinity : pattern.split('/').length;
    let count = 0;
    const unreadable: string[] = [];
    const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
      if (slot?.signal.aborted) throw new Error('stopped');
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch (err) {
        if (dir === base) throw err;
        unreadable.push(dir);
        return;
      }
      for (const e of entries) {
        const relPath = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {   // a symlink is neither a directory nor a file here: never followed
          if (depth + 1 < maxDepth) await walk(path.join(dir, e.name), relPath, depth + 1);   // eslint-disable-line no-await-in-loop -- one folder at a time
        } else if (e.isFile() && match.test(relPath)) {
          count += 1;
        }
      }
    };
    try {
      await walk(base, '', 0);
    } catch (err) {
      if (slot?.signal.aborted) return { ok: false, error: 'stopped: the count was cut by the turn ending or the stop button' };
      return { ok: false, error: `could not read ${base}: ${err instanceof Error ? err.message : String(err)}` };
    }
    return unreadable.length > 0 ? { ok: true, count, unreadable } : { ok: true, count };
  } finally {
    slot?.release();
  }
}
