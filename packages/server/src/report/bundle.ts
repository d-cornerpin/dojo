// ════════════════════════════════════════════════════════════════════════════
// THE RAW EVIDENCE BUNDLE — THE PART THAT NEVER LEAVES THE BOX (DOJO-REPORT T2)
//
// Owner ruling D1: "Raw evidence still stays local in the bundle, referenced by
// report ID." This module is that sentence, made structural.
//
//  · DISK, NOT DATABASE — a privacy decision before a size one. Nothing here is queried;
//    what it must be is ABSENT from every backup, every migration export and every
//    `VACUUM INTO` copy, and a blob in SQLite is in all three. `~/.dojo/reports/<id>/`
//    mirrors the receipts convention (`agent/v2/receipt.ts`).
//
//  · RESOLVED PER CALL, never at module load: a module-level `dojoDir(...)` freezes the
//    home at first import and writes into the developer's real `~/.dojo` in a test run.
//
//  · SEGMENTS VALIDATED **AND** THE RESULT RE-CHECKED FOR CONTAINMENT. That pair is how
//    this module holds `node:fs` honestly, and it is the claim
//    `effect-import-exclusions.mjs` and the argued lint raise both rest on: the regexes
//    cannot express `..` or a separator (lexical), `ensureDir` refuses a resolved path
//    outside the reports root (structural). Widening either one alone opens nothing.
//
//  · THE SCRUB IS BELT, NOT BRACES. `redactHandedCredentials` runs over the whole
//    serialized document before it touches disk. The gate is that the bundle never
//    leaves; this is here because a local file of live tokens is its own hazard.
//
//  · OVER THE CAP IT WRITES A WHOLE DOCUMENT, NOT A PREFIX — and THE CAP BINDS THAT
//    DOCUMENT TOO. Truncated JSON cannot be parsed, so a breach writes a small valid
//    object that SAYS so; because that object names the keys it dropped it is
//    re-measured and stripped. A 4 MB "truncation" is a cap announcing its own breach.
// ════════════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { dojoDir } from '../home.js';
import { redactHandedCredentials } from '../credentials/secret-values.js';

/** Two megabytes. A bundle is turn records and tool shapes, not media. */
export const REPORT_BUNDLE_MAX_BYTES = 2_000_000;
/** The sweep floor — the newest 50 report directories survive, the rest are removed. */
export const MAX_REPORT_DIRS = 50;

const BUNDLE_FILE = 'bundle.json';
// The two path-segment shapes: neither can express `..` or a separator (header, bullet 3).
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const SAFE_FILENAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}\.[A-Za-z0-9]{1,8}$/;

function safeId(reportId: string): string {
  if (!SAFE_ID.test(reportId)) throw new Error(`report id is not a platform id: ${JSON.stringify(reportId)}`);
  return reportId;
}

/** `~/.dojo/reports/<reportId>`. Resolved per call — a redirected DOJO_HOME is honoured. */
export function bundleDir(reportId: string): string {
  return dojoDir('reports', safeId(reportId));
}

/**
 * Newest `MAX_REPORT_DIRS` directories survive, oldest first by mtime. Runs on every
 * write; never throws, because a failed sweep must not fail a report. ⚠ Overwriting
 * `bundle.json` does NOT bump its DIRECTORY's mtime, so a re-written report still sorts
 * old and a live row can outlive its bundle — `readBundle` null is normal, not corruption.
 */
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
  } catch { /* no reports directory yet, or an unreadable home — not this write's problem */ }
}

/** Owner-only `~/.dojo/reports/<id>`. The containment check is the STRUCTURAL half of the
 *  traversal claim — a regex is exactly what a later edit widens by accident. */
function ensureDir(reportId: string): string {
  const root = path.resolve(dojoDir('reports'));
  const dir = bundleDir(reportId);
  if (!path.resolve(dir).startsWith(root + path.sep)) {
    throw new Error(`report directory escaped the reports root: ${dir}`);
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** Serialize, scrub, cap, write. `bytes` is what is ON DISK, never what was intended. */
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
    // THE CAP BINDS THE FINAL BYTES. 100 keys 40 KB long each make a 4 MB "truncation":
    // the key NAMES are unbounded, so the marker must be measured, not assumed small.
    if (Buffer.byteLength(text, 'utf8') > REPORT_BUNDLE_MAX_BYTES) text = marker([]);
  }
  fs.writeFileSync(file, text, { encoding: 'utf8', mode: 0o600 });
  sweepOldReportDirs(safeId(reportId));
  return { path: file, bytes: Buffer.byteLength(text, 'utf8'), truncated };
}

/** The bundle this box holds for a report, or null — missing and unparseable read alike. */
export function readBundle(reportId: string): unknown | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(bundleDir(reportId), BUNDLE_FILE), 'utf8')) as unknown;
  } catch { return null; }
}

/** A sibling file in the report's own directory — D2's export path. THROWS on a non-literal
 *  name rather than sanitizing one: a caller passing a path is a bug to fix, not input to
 *  clean. No cap, no scrub: its text is the SANITIZED BRIEF, never raw evidence (T6). */
export function writeReportFile(reportId: string, filename: string, text: string): string {
  if (!SAFE_FILENAME.test(filename)) throw new Error(`not a platform file name: ${JSON.stringify(filename)}`);
  const file = path.join(ensureDir(reportId), filename);
  fs.writeFileSync(file, text, { encoding: 'utf8', mode: 0o600 });
  return file;
}
