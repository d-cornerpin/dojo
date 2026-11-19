// Make an HTML file self-contained for the canvas: relative sibling assets would 404 once served from
// /api/upload/download/<id>?inline=1, so local assets inside the file's own directory are inlined as data: URIs
// and every other ref is left alone. The dock and the headless render canvas_read uses then match.

import fs from 'node:fs';
import path from 'node:path';
import { resolveHomePath } from '../agent/path-resolve.js';
import { shareDeny } from '../agent/brokers/fs.js';
import { resolvePathArg } from '../agent/brokers/resolve.js';
import { insideFolder } from '../techniques/technique-folder.js';

/** The policy on every HTML, SVG or Office preview served for display: an opaque origin, so the page's
 *  script cannot read the dashboard's storage or call its API with the owner's credentials. */
export const DISPLAY_CSP =
  'sandbox allow-scripts allow-popups allow-forms allow-modals allow-downloads allow-popups-to-escape-sandbox';

const ASSET_MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.avif': 'image/avif',
  '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.ogg': 'video/ogg',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
};
// Cap per-asset size so one giant file can't blow up the served HTML.
const MAX_ASSET_BYTES = 24 * 1024 * 1024;

// True for refs we must not touch: remote URLs, data URIs, anchors, protocol-relative URLs, special schemes.
function isRemote(ref: string): boolean {
  return /^(https?:|data:|blob:|mailto:|tel:|#|javascript:)/i.test(ref) || ref.startsWith('//');
}

/** May the canvas read this file: never one the secret-file rule denies, in either spelling, and with
 *  `folder` only a file inside that folder once links are followed. */
export function canvasMayRead(absPath: string, folder?: string): boolean {
  const resolved = resolvePathArg(absPath);
  if (!resolved.ok || !resolved.value.realResolved || shareDeny(resolved.value, 'canvas')) return false;
  return folder === undefined || insideFolder(folder, path.relative(folder, absPath)) !== null;
}

function toDataUri(absPath: string): string | null {
  try {
    const stat = fs.statSync(absPath);
    if (!stat.isFile() || stat.size > MAX_ASSET_BYTES) return null;
    const ext = path.extname(absPath).toLowerCase();
    const mime = ASSET_MIME[ext] ?? 'application/octet-stream';
    const data = fs.readFileSync(absPath).toString('base64');
    return `data:${mime};base64,${data}`;
  } catch {
    return null;
  }
}

export function inlineHtmlAssets(htmlAbsPath: string): string {
  let html: string;
  try {
    html = fs.readFileSync(htmlAbsPath, 'utf-8');
  } catch {
    return '';
  }
  const baseDir = path.dirname(htmlAbsPath);

  // Resolve a single ref to a data: URI, or null to leave it as-is.
  const resolveRef = (rawRef: string): string | null => {
    let ref = rawRef.trim();
    if (!ref || isRemote(ref)) return null;
    ref = ref.replace(/^file:\/\//i, '');          // file:///Users/x.png -> /Users/x.png
    const clean = resolveHomePath(ref.split(/[?#]/)[0]); // drop ?query / #hash, expand ~
    if (!clean) return null;
    // Refs are URLs ("my%20pic.png"): try the percent-decoded path first, then the text as written; a malformed
    // "%zz" ref is left alone rather than throwing.
    let decoded = clean;
    try {
      decoded = decodeURIComponent(clean);
    } catch {
      decoded = clean;
    }
    const read = (p: string) => {
      const abs = path.isAbsolute(p) ? p : path.resolve(baseDir, p);
      return canvasMayRead(abs, baseDir) ? toDataUri(abs) : null;
    };
    return read(decoded) ?? (decoded === clean ? null : read(clean));
  };

  // Media tags: inline src / poster (NOT <a href>, which is navigation).
  html = html.replace(/<(img|source|script|video|audio|input|embed|track)\b[^>]*>/gi, (tag) =>
    tag.replace(/\b(src|poster)\s*=\s*(["'])(.*?)\2/gi, (m, attr, q, ref) => {
      const data = resolveRef(ref);
      return data ? `${attr}=${q}${data}${q}` : m;
    }),
  );
  // <link href> (stylesheets, icons), only the link tag, not anchors.
  html = html.replace(/<link\b[^>]*>/gi, (tag) =>
    tag.replace(/\bhref\s*=\s*(["'])(.*?)\1/gi, (m, q, ref) => {
      const data = resolveRef(ref);
      return data ? `href=${q}${data}${q}` : m;
    }),
  );
  // CSS url(...) in <style> blocks and inline style="" (backgrounds, fonts).
  html = html.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (m, _q, ref) => {
    const data = resolveRef(ref);
    return data ? `url(${data})` : m;
  });

  return html;
}
