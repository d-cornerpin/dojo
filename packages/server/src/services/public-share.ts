// Public file sharing: agents publish a file (or a small directory tree) to a public URL. Shares live under
// ~/.dojo/out/<slug>/, the slug being a timestamp plus a short random tag so URLs are unguessable in
// practice; the gateway serves /share/<slug>/<file> without auth. The returned URL prefers the active
// Cloudflare tunnel, else falls back to localhost (same machine only).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createLogger } from '../logger.js';
import { getTunnelStatus } from './tunnel.js';
import { isSensitivePath } from '../agent/path-guards.js';
import { homeDir } from '../home.js';
import { canvasMayRead } from './canvas-html.js';

const logger = createLogger('public-share');

const PORT = parseInt(process.env.DOJO_PORT ?? '3001', 10);
export const OUT_DIR = path.join(homeDir(), '.dojo', 'out');

/** Slug shape: YYYYMMDD-HHMMSS-<32 hex>: the 122 random bits of a download link's id. */
function makeSlug(): string {
  const now = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const rand = crypto.randomUUID().replace(/-/g, '');
  return `${date}-${time}-${rand}`;
}

function sanitizeFilename(name: string): string {
  // Strip path separators and dotfiles so an agent cannot name a file `..` or `/etc/passwd`.
  const basename = path.basename(name);
  const cleaned = basename.replace(/[^a-zA-Z0-9._-]/g, '_');
  if (!cleaned || cleaned === '.' || cleaned === '..') return 'file';
  return cleaned;
}

function copyDirRecursive(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    // A directory share must not sweep a secret in as a passenger; the tool-level gate only sees the named directory.
    if (isSensitivePath(srcPath)) {
      logger.warn('Public share: skipped a sensitive file inside the shared directory', { file: entry.name });
      continue;
    }
    if (entry.isDirectory()) copyDirRecursive(srcPath, destPath);
    else if (entry.isFile()) fs.copyFileSync(srcPath, destPath);
    // skip symlinks/sockets/etc.
  }
}

// ── HTML asset inlining ──
//
// Sharing a single .html file copies each linked local asset (<img src>, <link href>, <script src>, url() in
// inline CSS) into the share directory, so relative refs do not 404 at the public URL. Rules:
//   - http(s)://, data:, mailto:, tel:, sms:, #, //, javascript: are external and left untouched.
//   - Relative refs keep their subdirectory structure under shareDir; the HTML keeps its href.
//   - Absolute filesystem refs are flattened to a sanitized basename in shareDir and the HTML rewritten.
//   - Path traversal and refs resolving outside shareDir are skipped with a warning.
//   - An asset on the sensitive-files block list is REFUSED: a page may not put a secret at an
//     unauthenticated URL (`__tests__/public-share-assets-sensitive.test.ts` holds this).
//   - Bounded: at most 200 assets, 50MB total; anything past the cap is skipped with a warning.

const MAX_INLINED_ASSETS = 200;
const MAX_INLINED_TOTAL_BYTES = 50 * 1024 * 1024;
const MAX_PER_ASSET_BYTES = 25 * 1024 * 1024;

interface AssetInlineResult {
  rewritten: string;
  copiedCount: number;
  skippedCount: number;
  notFoundCount: number;
  warnings: string[];
}

function isExternalRef(ref: string): boolean {
  if (ref.length === 0) return true;
  // `file:` is intentionally NOT in this list: file:// URLs are local filesystem refs that browsers render
  // (`<img src="file:///Users/.../foo.png">`), inlined like absolute paths; tryCopyAsset strips the scheme.
  return /^(?:https?:|data:|mailto:|tel:|sms:|#|\/\/|javascript:)/i.test(ref);
}

/** Strip a `file://` (or `file://localhost`) scheme prefix to get the URL-decoded filesystem path, or null. */
function stripFileScheme(ref: string): string | null {
  const m = ref.match(/^file:\/\/(?:localhost)?(\/.*)$/i);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1]; // malformed encoding: best effort
  }
}

function rewriteHtmlWithInlinedAssets(htmlPath: string, shareDir: string): AssetInlineResult {
  const html = fs.readFileSync(htmlPath, 'utf-8');
  const htmlDir = path.dirname(htmlPath);
  const warnings: string[] = [];
  let copiedCount = 0;
  let skippedCount = 0;
  let notFoundCount = 0;
  let totalBytes = 0;
  // Cache: source path to dest relative path, so a source referenced twice is copied once and rewritten consistently.
  const copied = new Map<string, string>();
  const reportedMissing = new Set<string>();

  const tryCopyAsset = (ref: string): string | null => {
    if (isExternalRef(ref)) return null;

    // Strip query/fragment ("style.css?v=2") for the filesystem lookup; the rewritten ref keeps the suffix.
    const queryIdx = Math.min(
      ref.indexOf('?') === -1 ? Infinity : ref.indexOf('?'),
      ref.indexOf('#') === -1 ? Infinity : ref.indexOf('#'),
    );
    const refPathOnly = queryIdx === Infinity ? ref : ref.slice(0, queryIdx);
    const refSuffix = queryIdx === Infinity ? '' : ref.slice(queryIdx);

    // file:// URLs are filesystem refs in URL form: treat the stripped path as absolute.
    const fileSchemePath = stripFileScheme(refPathOnly);
    const treatAsAbsolute = fileSchemePath !== null || path.isAbsolute(refPathOnly);
    const absoluteRefPath = fileSchemePath ?? refPathOnly;

    let absSource: string;
    let destRel: string;
    if (treatAsAbsolute) {
      absSource = absoluteRefPath;
      destRel = path.basename(absoluteRefPath).replace(/[^a-zA-Z0-9._-]/g, '_');
    } else {
      absSource = path.resolve(htmlDir, refPathOnly);
      destRel = refPathOnly.replace(/^\.\//, '');
      // Block traversal that escapes the HTML's directory at the source side.
      const relFromHtmlDir = path.relative(htmlDir, absSource);
      if (relFromHtmlDir.startsWith('..') || path.isAbsolute(relFromHtmlDir)) {
        warnings.push(`Skipped asset escaping HTML directory: ${ref}`);
        skippedCount++;
        return null;
      }
    }

    // An asset the page names is served with no sign-in, so it gets the canvas's secret-file check (both
    // spellings, before anything reads it); unlike the canvas, a share may publish files outside the page folder.
    if (!canvasMayRead(path.resolve(absSource))) {
      logger.warn('Public share: skipped a sensitive asset named by the shared page', { ref });
      warnings.push(`Skipped asset on the sensitive-files block list: ${ref}`);
      skippedCount++;
      return null;
    }

    if (copied.has(absSource)) {
      return copied.get(absSource)! + refSuffix;
    }
    if (copiedCount >= MAX_INLINED_ASSETS) {
      warnings.push(`Skipped: hit max ${MAX_INLINED_ASSETS} inlined assets`);
      skippedCount++;
      return null;
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(absSource);
    } catch {
      // Asset missing on disk: a template placeholder or a real bug. Tracked and surfaced in the result so the
      // user sees "8 missing" instead of silence.
      if (!reportedMissing.has(absSource)) {
        reportedMissing.add(absSource);
        notFoundCount++;
        if (warnings.length < 20) {
          warnings.push(`Asset not found on disk: ${ref}`);
        }
      }
      return null;
    }
    if (!stat.isFile()) return null;
    if (stat.size > MAX_PER_ASSET_BYTES) {
      warnings.push(`Skipped oversized asset (${(stat.size / 1024 / 1024).toFixed(1)}MB): ${ref}`);
      skippedCount++;
      return null;
    }
    if (totalBytes + stat.size > MAX_INLINED_TOTAL_BYTES) {
      warnings.push(`Skipped: hit ${MAX_INLINED_TOTAL_BYTES / 1024 / 1024}MB total cap at ${ref}`);
      skippedCount++;
      return null;
    }

    const destAbs = path.join(shareDir, destRel);
    const resolved = path.resolve(destAbs);
    if (!resolved.startsWith(path.resolve(shareDir) + path.sep)) {
      warnings.push(`Skipped asset with dest outside shareDir: ${ref}`);
      skippedCount++;
      return null;
    }

    try {
      fs.mkdirSync(path.dirname(destAbs), { recursive: true });
      fs.copyFileSync(absSource, destAbs);
      copied.set(absSource, destRel);
      copiedCount++;
      totalBytes += stat.size;
      return destRel + refSuffix;
    } catch (err) {
      warnings.push(`Failed to copy ${ref}: ${err instanceof Error ? err.message : String(err)}`);
      skippedCount++;
      return null;
    }
  };

  // html attribute refs (src/href) capture the attribute name and the URL; CSS url(...) captures only the URL.
  let rewritten = html;

  rewritten = rewritten.replace(/\b(src|href)\s*=\s*"([^"]*)"/gi, (match, _attr, ref: string) => {
    const newRef = tryCopyAsset(ref);
    return newRef === null ? match : match.replace(`"${ref}"`, `"${newRef}"`);
  });
  rewritten = rewritten.replace(/\b(src|href)\s*=\s*'([^']*)'/gi, (match, _attr, ref: string) => {
    const newRef = tryCopyAsset(ref);
    return newRef === null ? match : match.replace(`'${ref}'`, `'${newRef}'`);
  });
  rewritten = rewritten.replace(/url\(\s*"([^"]*)"\s*\)/gi, (match, ref: string) => {
    const newRef = tryCopyAsset(ref);
    return newRef === null ? match : `url("${newRef}")`;
  });
  rewritten = rewritten.replace(/url\(\s*'([^']*)'\s*\)/gi, (match, ref: string) => {
    const newRef = tryCopyAsset(ref);
    return newRef === null ? match : `url('${newRef}')`;
  });
  rewritten = rewritten.replace(/url\(\s*([^"'\s)][^\s)]*)\s*\)/gi, (match, ref: string) => {
    const newRef = tryCopyAsset(ref);
    return newRef === null ? match : `url(${newRef})`;
  });

  return { rewritten, copiedCount, skippedCount, notFoundCount, warnings };
}

export interface PublicShareResult {
  url: string;
  slug: string;
  publicPath: string;       // absolute path to the entry file under OUT_DIR
  baseSource: 'tunnel' | 'localhost';
  /** For a single HTML file: counts of linked local assets detected, copied, missing on disk or skipped for safety. */
  inlinedAssets?: {
    copied: number;
    skipped: number;
    notFound: number;
    warnings: string[];
  };
}

export interface CreatePublicShareInput {
  /** Absolute path to the file or directory to share. */
  sourcePath: string;
  /** Optional. When sharing a directory, the entry filename to point the URL at. Default: index.html if present, otherwise the directory listing. */
  entryFilename?: string;
}

export function createPublicShare(input: CreatePublicShareInput): PublicShareResult {
  const src = input.sourcePath;
  if (!path.isAbsolute(src)) {
    throw new Error(`sourcePath must be absolute, got: ${src}`);
  }
  if (!fs.existsSync(src)) {
    throw new Error(`Source does not exist: ${src}`);
  }
  // Layered on purpose: the share_publicly tool gates the agent's request, and this second check belongs to
  // the FUNCTION, so no future caller (route, job) can publish a secret by not knowing about the tool-level gate.
  if (isSensitivePath(src)) {
    throw new Error(`${src} is on the sensitive-files block list and can never be published to a public URL`);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const slug = makeSlug();
  const shareDir = path.join(OUT_DIR, slug);
  fs.mkdirSync(shareDir, { recursive: true });

  const stat = fs.statSync(src);
  let entry: string;
  let inlinedAssets: PublicShareResult['inlinedAssets'];

  if (stat.isFile()) {
    entry = sanitizeFilename(path.basename(src));
    const ext = path.extname(src).toLowerCase();
    if (ext === '.html' || ext === '.htm') {
      // For HTML, copy the linked assets in too: only the .html is in shareDir, so relative refs would 404.
      const result = rewriteHtmlWithInlinedAssets(src, shareDir);
      fs.writeFileSync(path.join(shareDir, entry), result.rewritten, 'utf-8');
      inlinedAssets = {
        copied: result.copiedCount,
        skipped: result.skippedCount,
        notFound: result.notFoundCount,
        warnings: result.warnings,
      };
    } else {
      fs.copyFileSync(src, path.join(shareDir, entry));
    }
  } else if (stat.isDirectory()) {
    copyDirRecursive(src, shareDir);
    if (input.entryFilename) {
      entry = sanitizeFilename(input.entryFilename);
    } else if (fs.existsSync(path.join(shareDir, 'index.html'))) {
      entry = 'index.html';
    } else {
      // No obvious entry: point at the directory; user / agent can append a path.
      entry = '';
    }
  } else {
    throw new Error(`Unsupported source type (not a file or directory): ${src}`);
  }

  const tunnelStatus = getTunnelStatus();
  let base: string;
  let baseSource: 'tunnel' | 'localhost';
  if (tunnelStatus.status === 'active' && tunnelStatus.url) {
    base = tunnelStatus.url.replace(/\/+$/, '');
    baseSource = 'tunnel';
  } else {
    base = `http://localhost:${PORT}`;
    baseSource = 'localhost';
  }

  const url = entry
    ? `${base}/share/${slug}/${entry}`
    : `${base}/share/${slug}/`;
  const publicPath = path.join(shareDir, entry);

  logger.info('Public share created', {
    slug, baseSource, sourceType: stat.isFile() ? 'file' : 'directory', entry,
    inlinedAssetsCopied: inlinedAssets?.copied,
    inlinedAssetsSkipped: inlinedAssets?.skipped,
  });

  return { url, slug, publicPath, baseSource, inlinedAssets };
}
