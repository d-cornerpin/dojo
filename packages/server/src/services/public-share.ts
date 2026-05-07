// ════════════════════════════════════════
// Public file sharing
// ════════════════════════════════════════
//
// Lets agents publish a file (or a small directory tree, e.g. an HTML page
// with linked assets) to a publicly-accessible URL. Shares live under
// ~/.dojo/out/<slug>/, where slug is a timestamp + short random tag so URLs
// are unguessable in practice. The gateway serves /share/<slug>/<file>
// without auth, so anyone with the URL can fetch.
//
// The returned URL prefers the active Cloudflare tunnel if one is up, so
// the link works from anywhere on the internet. Otherwise it falls back to
// the localhost URL — only useful from the same machine, but still
// correct for local-only workflows.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createLogger } from '../logger.js';
import { getTunnelStatus } from './tunnel.js';

const logger = createLogger('public-share');

const PORT = parseInt(process.env.DOJO_PORT ?? '3001', 10);
export const OUT_DIR = path.join(os.homedir(), '.dojo', 'out');

/** Slug shape: YYYYMMDD-HHMMSS-<7-char hex>. ~28-bit collision space. */
function makeSlug(): string {
  const now = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const rand = crypto.randomBytes(4).toString('hex').slice(0, 7);
  return `${date}-${time}-${rand}`;
}

function sanitizeFilename(name: string): string {
  // Strip path separators and dotfiles to keep the URL tidy and prevent
  // an agent from naming a file `..` or `/etc/passwd`.
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
    if (entry.isDirectory()) copyDirRecursive(srcPath, destPath);
    else if (entry.isFile()) fs.copyFileSync(srcPath, destPath);
    // skip symlinks/sockets/etc.
  }
}

// ── HTML asset inlining ──
//
// When sharing a single .html file, scan it for linked local assets
// (<img src=…>, <link href=…>, <script src=…>, url(…) in inline CSS) and
// copy each one into the share directory so the rendered page actually
// works at the public URL. Without this, every relative <img>/<link>
// 404s when fetched through /share/<slug>/<file>.
//
// Rules:
//   - URLs starting with http(s)://, data:, mailto:, tel:, sms:, #, //,
//     or javascript: are external — left untouched.
//   - Relative refs ("hero.png", "assets/style.css") preserve their
//     subdirectory structure under shareDir; HTML keeps its existing href.
//   - Absolute filesystem refs ("/Users/…/photo.png") get flattened to
//     a sanitized basename in shareDir, and the HTML is rewritten to use
//     that name as a relative path.
//   - Path traversal attempts ("../../../etc/passwd") and refs that
//     resolve outside shareDir are skipped with a warning.
//   - Bounded: at most 200 assets, 50MB total. Anything past the cap is
//     skipped with a warning.

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
  // Note: `file:` is intentionally NOT in this list. file:// URLs ARE local
  // filesystem refs that browsers render — Maddy embeds keyframes as
  // `<img src="file:///Users/.../foo.png">`, and we want to inline those
  // exactly like absolute filesystem paths. tryCopyAsset strips the scheme.
  return /^(?:https?:|data:|mailto:|tel:|sms:|#|\/\/|javascript:)/i.test(ref);
}

/** Strip a `file://` (or `file://localhost`) scheme prefix to get the raw
 *  filesystem path. URL-decoded. Returns null when the input isn't a file:// URL. */
function stripFileScheme(ref: string): string | null {
  const m = ref.match(/^file:\/\/(?:localhost)?(\/.*)$/i);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1]; // malformed encoding — best effort
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
  // Cache: source path → dest relative path. Same source referenced multiple
  // times is copied once and rewritten consistently.
  const copied = new Map<string, string>();
  const reportedMissing = new Set<string>();

  const tryCopyAsset = (ref: string): string | null => {
    if (isExternalRef(ref)) return null;

    // Strip URL query/fragment ("style.css?v=2" → "style.css") for the
    // filesystem lookup; preserve the original suffix in the rewritten ref.
    const queryIdx = Math.min(
      ref.indexOf('?') === -1 ? Infinity : ref.indexOf('?'),
      ref.indexOf('#') === -1 ? Infinity : ref.indexOf('#'),
    );
    const refPathOnly = queryIdx === Infinity ? ref : ref.slice(0, queryIdx);
    const refSuffix = queryIdx === Infinity ? '' : ref.slice(queryIdx);

    // file:// URLs are filesystem refs in URL form (Maddy's keyframe pattern).
    // Treat the stripped path as absolute.
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
      // Asset doesn't exist on disk. Could be intentional (template
      // placeholder) OR a real bug (HTML references a file that should
      // have been there but isn't). Track and surface in the result so
      // the user sees "8 missing" instead of silent zero feedback —
      // pre-2026-05-06 behavior was to skip silently which made it look
      // like the inliner didn't run at all.
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

  // Apply patterns one by one. html attribute refs (src/href) capture both
  // the attribute name and the URL; CSS url(...) captures only the URL.
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
  /** When sharing a single HTML file, the count of linked local assets
   *  (img/script/link/url(…)) that were detected, copied, missing on disk,
   *  or skipped for safety reasons. Undefined for non-HTML or directory
   *  shares. */
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
      // For HTML, walk the file's linked assets and copy them in too. Without
      // this, every relative <img>/<link>/<script>/url() in the page 404s when
      // fetched through the share URL because only the .html is in shareDir.
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
      // No obvious entry — point at the directory; user / agent can append a path.
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
