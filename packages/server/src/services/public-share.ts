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

export interface PublicShareResult {
  url: string;
  slug: string;
  publicPath: string;       // absolute path to the entry file under OUT_DIR
  baseSource: 'tunnel' | 'localhost';
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

  if (stat.isFile()) {
    entry = sanitizeFilename(path.basename(src));
    fs.copyFileSync(src, path.join(shareDir, entry));
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
  });

  return { url, slug, publicPath, baseSource };
}
