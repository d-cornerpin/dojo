// What a `file` proof item points at, read off the disk when it is checked: its size, modification
// time, the sha256 of its bytes and the first 8 KB as an excerpt, so every reader sees the file as it
// stood. The read is asked of `agent/permissions.ts` with the worker's own permissions first, and the
// file is hashed in fixed-size chunks, never held in memory whole.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { checkPermission } from '../../agent/permissions.js';

/** The most of a file's text a decider is shown. */
export const EXCERPT_BYTES = 8192;
const CHUNK_BYTES = 1 << 20;

export type FileFacts = { path: string; size: number; mtime: string; sha256: string; excerpt: string };

/** The sha256 of the file and its first EXCERPT_BYTES, read in chunks. */
function hashAndHead(filePath: string): { sha256: string; head: Buffer } {
  const hash = crypto.createHash('sha256');
  const buf = Buffer.allocUnsafe(CHUNK_BYTES);
  let head = Buffer.alloc(0);
  const fd = fs.openSync(filePath, 'r');
  try {
    for (;;) {
      const n = fs.readSync(fd, buf, 0, CHUNK_BYTES, null);
      if (n === 0) break;
      hash.update(buf.subarray(0, n));
      if (head.length < EXCERPT_BYTES) head = Buffer.concat([head, buf.subarray(0, Math.min(n, EXCERPT_BYTES - head.length))]);
    }
  } finally { fs.closeSync(fd); }
  return { sha256: hash.digest('hex'), head };
}

/** The file as it stands now, or why it cannot be read as proof. */
export function fileFacts(workerId: string, filePath: string): { ok: true; facts: FileFacts } | { ok: false; why: string } {
  const allowed = checkPermission(workerId, { type: 'file_read', path: filePath });
  if (!allowed.allowed) return { ok: false, why: `the worker may not read it (${allowed.reason ?? 'refused'})` };
  let st: fs.Stats;
  try { st = fs.statSync(filePath); } catch { return { ok: false, why: 'the file does not exist now' }; }
  if (!st.isFile()) return { ok: false, why: 'it is not a file' };
  let read: { sha256: string; head: Buffer };
  try { read = hashAndHead(filePath); } catch { return { ok: false, why: 'the file could not be read now' }; }
  // A binary file has no text to show; its size and hash still stand.
  const excerpt = read.head.includes(0) ? '' : read.head.toString('utf8');
  return { ok: true, facts: { path: filePath, size: st.size, mtime: st.mtime.toISOString(), sha256: read.sha256, excerpt } };
}
