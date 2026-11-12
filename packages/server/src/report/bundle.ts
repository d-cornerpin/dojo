// The raw evidence bundle never leaves this box and is referenced by report ID. It lives on disk, not in
// SQLite, so it is absent from every backup, migration export and `VACUUM INTO` copy.
// Path safety has two halves, segment regexes (no `..` or separator) and `ensureDir`'s containment check;
// widening either alone opens nothing. The directory is resolved per call, never at module load.
// `redactHandedCredentials` scrubs the whole document before it touches disk.
// Over the cap it writes a small valid marker object, because truncated JSON cannot be parsed.

import fs from 'node:fs';
import path from 'node:path';
import { dojoDir } from '../home.js';
import { redactHandedCredentials } from '../credentials/secret-values.js';

export const REPORT_BUNDLE_MAX_BYTES = 2_000_000;
export const MAX_REPORT_DIRS = 50;

const BUNDLE_FILE = 'bundle.json';
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const SAFE_FILENAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}\.[A-Za-z0-9]{1,8}$/;

function safeId(reportId: string): string {
  if (!SAFE_ID.test(reportId)) throw new Error(`report id is not a platform id: ${JSON.stringify(reportId)}`);
  return reportId;
}

export function bundleDir(reportId: string): string {
  return dojoDir('reports', safeId(reportId));
}

/** Newest `MAX_REPORT_DIRS` directories survive; never throws, a failed sweep must not fail a report.
 *  Overwriting `bundle.json` does not bump its directory's mtime, so `readBundle` null is normal. */
function sweepOldReportDirs(keep: string): void {
  try {
    const root = dojoDir('reports');
    const dirs = fs.readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name !== keep)
      .map((e) => {
        const abs = path.join(root, e.name);
        try { return { abs, mtime: fs.statSync(abs).mtimeMs }; } catch { return { abs, mtime: 0 }; }
      })
      .sort((a, b) => a.mtime - b.mtime);
    // `keep` is newest by construction (just written), so it is counted, never swept.
    for (const d of dirs.slice(0, Math.max(0, dirs.length + 1 - MAX_REPORT_DIRS))) {
      try { fs.rmSync(d.abs, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  } catch { /* no reports directory yet, or an unreadable home: not this write's problem */ }
}

function ensureDir(reportId: string): string {
  const root = path.resolve(dojoDir('reports'));
  const dir = bundleDir(reportId);
  if (!path.resolve(dir).startsWith(root + path.sep)) {
    throw new Error(`report directory escaped the reports root: ${dir}`);
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function writeBundle(reportId: string, agentId: string, bundle: unknown): {
  path: string; bytes: number; truncated: boolean;
} {
  const file = path.join(ensureDir(reportId), BUNDLE_FILE);
  let text = redactHandedCredentials(agentId, JSON.stringify(bundle, null, 2) ?? 'null');
  const truncated = Buffer.byteLength(text, 'utf8') > REPORT_BUNDLE_MAX_BYTES;
  if (truncated) {
    const marker = (keptKeys: string[]): string => JSON.stringify({
      truncated: true, reason: 'bundle exceeded REPORT_BUNDLE_MAX_BYTES',
      maxBytes: REPORT_BUNDLE_MAX_BYTES, keptKeys,
    }, null, 2);
    text = marker((bundle && typeof bundle === 'object' && !Array.isArray(bundle))
      ? Object.keys(bundle as Record<string, unknown>).slice(0, 100)
      : []);
    // The marker is measured too: key names are unbounded, so it is not assumed small.
    if (Buffer.byteLength(text, 'utf8') > REPORT_BUNDLE_MAX_BYTES) text = marker([]);
  }
  fs.writeFileSync(file, text, { encoding: 'utf8', mode: 0o600 });
  sweepOldReportDirs(safeId(reportId));
  return { path: file, bytes: Buffer.byteLength(text, 'utf8'), truncated };
}

/** The bundle this box holds for a report, or null (missing and unparseable read alike). */
export function readBundle(reportId: string): unknown | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(bundleDir(reportId), BUNDLE_FILE), 'utf8')) as unknown;
  } catch { return null; }
}

/** A sibling file in the report's directory; THROWS on a non-literal name. No cap or scrub, so only
 *  the sanitized brief may be written here, never raw evidence. */
export function writeReportFile(reportId: string, filename: string, text: string): string {
  if (!SAFE_FILENAME.test(filename)) throw new Error(`not a platform file name: ${JSON.stringify(filename)}`);
  const file = path.join(ensureDir(reportId), filename);
  fs.writeFileSync(file, text, { encoding: 'utf8', mode: 0o600 });
  return file;
}
