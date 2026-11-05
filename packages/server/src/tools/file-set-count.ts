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

/** The glob as a whole-path matcher over POSIX relative paths. */
function globMatcher(pattern: string): RegExp {
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
  return new RegExp(`^${re}$`);
}

export async function countFileSet(args: { path?: string; pattern?: string }): Promise<{ ok: true; count: number } | { ok: false; error: string }> {
  const base = resolveHomePath(String(args.path ?? ''));
  const pattern = (args.pattern ?? '*').trim() || '*';
  if (!path.isAbsolute(base)) return { ok: false, error: `the measure's path must be absolute (got "${args.path ?? ''}")` };
  let stat: fs.Stats;
  try { stat = await fs.promises.stat(base); } catch { return { ok: false, error: `directory not found: ${base}` }; }
  if (!stat.isDirectory()) return { ok: false, error: `not a directory: ${base}` };
  const match = globMatcher(pattern);
  // How deep the pattern can reach: unlimited with `**`, else one level per `/`.
  const maxDepth = pattern.includes('**') ? Infinity : pattern.split('/').length;
  let count = 0;
  const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
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
    return { ok: false, error: `could not read ${base}: ${err instanceof Error ? err.message : String(err)}` };
  }
  return { ok: true, count };
}
