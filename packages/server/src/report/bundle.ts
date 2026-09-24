// ════════════════════════════════════════════════════════════════════════════
// THE RAW EVIDENCE BUNDLE — THE PART THAT NEVER LEAVES THE BOX (DOJO-REPORT T2)
//
// Owner ruling D1: "Raw evidence still stays local in the bundle, referenced by
// report ID." This module is that sentence, made structural.
//
//  · IT IS DISK, NOT DATABASE, and that is a privacy decision before it is a size
//    one. Nothing here is ever queried; what it must be is ABSENT from every backup,
//    every migration export and every `VACUUM INTO` rehearsal copy, and a blob in
//    SQLite is in all three. `~/.dojo/reports/<id>/` mirrors the house's agent-scoped
//    diagnostic-artefact convention (`agent/v2/receipt.ts`), sweep discipline included.
//
//  · THE PATH IS RESOLVED PER CALL, never at module load. A module-level `dojoDir(...)`
//    constant freezes the home at first import and writes into the developer's real
//    `~/.dojo` during a test run — the incident `home.ts` exists for.
//
//  · EVERY PATH SEGMENT IS VALIDATED, which is how this module holds its own `node:fs`
//    import honestly: the report id must be the uuid the platform minted and a file
//    name must be a platform literal. No argument here can be steered into a directory
//    of an agent's choosing — the claim its entry in
//    `deploy/checks/effect-import-exclusions.mjs` makes.
//
//  · THE SCRUB IS BELT, NOT BRACES. `redactHandedCredentials` runs over the whole
//    serialized document before it touches the disk. The privacy gate is that the
//    bundle never leaves; this is here because a local file full of live tokens is a
//    hazard in its own right.
//
//  · OVER THE CAP, IT WRITES A WHOLE DOCUMENT, NOT A PREFIX. JSON truncated at a byte
//    offset cannot be parsed, so the reader cannot tell "too big" from "corrupt". A cap
//    breach writes a small, valid object that SAYS it is a truncation.
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
// The two path-segment shapes. Neither can express `..` or a separator, which is what
// lets this module hold `node:fs` directly and say no agent can steer the destination.
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
 * Keep the newest `MAX_REPORT_DIRS` report directories, oldest first by mtime. Runs on
 * every write; best-effort and never throws, because a failed sweep must not fail a report.
 */
function sweepOldReportDirs(keep: string): void {
  try {
    const root = dojoDir('reports');
    const dirs = fs.readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name !== keep)
      .map((e) => {
        const abs = path.join(root, e.name);
        let mtime = 0;
        try { mtime = fs.statSync(abs).mtimeMs; } catch { mtime = 0; }
        return { abs, mtime };
      })
      .sort((a, b) => a.mtime - b.mtime);
    // `keep` is newest by construction (just written), so it is counted, never swept.
    for (const d of dirs.slice(0, Math.max(0, dirs.length + 1 - MAX_REPORT_DIRS))) {
      try { fs.rmSync(d.abs, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  } catch { /* no reports directory yet, or an unreadable home — not this write's problem */ }
}

/** Create `~/.dojo/reports/<id>` owner-only and return it. */
function ensureDir(reportId: string): string {
  const dir = bundleDir(reportId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/**
 * Serialize, scrub, cap, write. The returned `bytes` is what is ON DISK, so a caller
 * that reports size to a human reports the truth rather than the intent.
 */
export function writeBundle(reportId: string, agentId: string, bundle: unknown): {
  path: string; bytes: number; truncated: boolean;
} {
  const file = path.join(ensureDir(reportId), BUNDLE_FILE);
  let text = redactHandedCredentials(agentId, JSON.stringify(bundle, null, 2) ?? 'null');
  const truncated = Buffer.byteLength(text, 'utf8') > REPORT_BUNDLE_MAX_BYTES;
  if (truncated) {
    const keptKeys = (bundle && typeof bundle === 'object' && !Array.isArray(bundle))
      ? Object.keys(bundle as Record<string, unknown>).slice(0, 100)
      : [];
    text = JSON.stringify({
      truncated: true, reason: 'bundle exceeded REPORT_BUNDLE_MAX_BYTES',
      maxBytes: REPORT_BUNDLE_MAX_BYTES, keptKeys,
    }, null, 2);
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

/**
 * Write a sibling file in the report's own directory — the export path D2 takes when
 * GitHub is not connected. THROWS on a name that is not a platform literal, rather
 * than sanitizing one: a caller passing a path is a bug to fix, not input to clean.
 */
export function writeReportFile(reportId: string, filename: string, text: string): string {
  if (!SAFE_FILENAME.test(filename)) throw new Error(`not a platform file name: ${JSON.stringify(filename)}`);
  const file = path.join(ensureDir(reportId), filename);
  fs.writeFileSync(file, text, { encoding: 'utf8', mode: 0o600 });
  return file;
}
