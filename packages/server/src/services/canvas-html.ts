// ════════════════════════════════════════
// inlineHtmlAssets, make an HTML file self-contained for the canvas.
//
// An HTML file written by an agent often references sibling assets by a
// RELATIVE path, e.g. <img src="marianne-photo.png">. The right-dock canvas
// serves that HTML from /api/upload/download/<id>?inline=1, so the iframe
// resolves "marianne-photo.png" against that URL (-> 404) and the image never
// shows, even though the file is sitting right next to the HTML on disk.
//
// This reads the HTML and inlines its LOCAL assets (images, stylesheets,
// scripts, fonts, url(...) refs) as data: URIs, resolved against the HTML
// file's own directory. Remote refs (http/https/data/protocol-relative/#) are
// left untouched. The result renders identically wherever it is served, the
// canvas iframe AND the headless render canvas_read uses, so what the agent
// sees in canvas_read matches what the user sees in the dock.
// ════════════════════════════════════════

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

function resolveHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

// True for refs we must NOT touch: real remote URLs, data URIs, in-page
// anchors, protocol-relative URLs, and special schemes.
function isRemote(ref: string): boolean {
  return /^(https?:|data:|blob:|mailto:|tel:|#|javascript:)/i.test(ref) || ref.startsWith('//');
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
    const clean = resolveHome(ref.split(/[?#]/)[0]); // drop ?query / #hash, expand ~
    if (!clean) return null;
    const abs = path.isAbsolute(clean) ? clean : path.resolve(baseDir, clean);
    return toDataUri(abs);
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
