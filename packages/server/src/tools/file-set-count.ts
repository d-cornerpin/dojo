// The file-set counter behind a task's measure (work/measure.ts): counts files under `path` whose
// relative path matches glob `pattern`, by walking the real directory. `*` and `?` stay within one
// folder, `**` crosses folders; a pattern without `**` is walked only as deep as it reaches. Symlinked
// folders are never followed. A top folder that cannot be read is a reading that could not be made,
// never 0; an unreadable subfolder is named in `unreadable` and the row stores the whole reading as
// unmade (`work/ledger-store.ts readingForClose`). The walk is registered under the agent's own stop
// (`openAgentCall`, `turn` scope), and a stopped walk is no reading, never a partial count.
// Authorization: the measure is checked with `file_list`'s gates before every count
// (`agent/tools/cat/measure-door.ts` `refusalFor`). The walk runs at turn end and at a close, outside
// any tool call's capability, which is why it reads the disk directly.
import fs from 'node:fs';
import path from 'node:path';
import { resolveHomePath } from '../agent/path-resolve.js';
import { isFsCaseInsensitive } from '../agent/fs-case.js';

/** The folder's own case sensitivity (the boot probe covers only the data volume): case-flipped inode match. */
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
        return false;
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
        if (e.isDirectory()) {
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
