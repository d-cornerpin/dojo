// Verify share_publicly inlines linked assets when the source is a single
// HTML file. Without this, every <img src="hero.png"> 404s when fetched
// through the share URL because the asset isn't in the share directory.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Mock tunnel module so the test doesn't need a real Cloudflare connection.
vi.mock('../tunnel.js', () => ({
  getTunnelStatus: () => ({
    enabled: false,
    mode: 'quick',
    status: 'inactive' as const,
    url: null,
    error: null,
    startedAt: null,
    cloudflaredInstalled: false,
  }),
}));

// Override OUT_DIR location so the test doesn't pollute ~/.dojo/out.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'public-share-html-'));
process.env.HOME = tmpHome;

import { createPublicShare, OUT_DIR } from '../public-share.js';

let workDir: string;

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'share-src-'));
});

afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

describe('share_publicly — HTML asset inlining', () => {
  it('copies a sibling image referenced via relative <img src>', () => {
    const htmlPath = path.join(workDir, 'page.html');
    fs.writeFileSync(path.join(workDir, 'logo.png'), 'fake-png-bytes');
    fs.writeFileSync(htmlPath, `<html><body><img src="logo.png" alt="logo"></body></html>`);

    const result = createPublicShare({ sourcePath: htmlPath });
    expect(result.inlinedAssets?.copied).toBe(1);
    expect(result.inlinedAssets?.skipped).toBe(0);
    expect(fs.existsSync(path.join(OUT_DIR, result.slug, 'logo.png'))).toBe(true);
    // HTML's reference is unchanged (was already relative).
    const html = fs.readFileSync(path.join(OUT_DIR, result.slug, 'page.html'), 'utf-8');
    expect(html).toContain('<img src="logo.png"');
  });

  it('preserves subdirectory structure for relative refs', () => {
    fs.mkdirSync(path.join(workDir, 'assets'));
    fs.mkdirSync(path.join(workDir, 'css'));
    fs.writeFileSync(path.join(workDir, 'assets', 'hero.jpg'), 'jpg-bytes');
    fs.writeFileSync(path.join(workDir, 'css', 'style.css'), 'body { color: red; }');
    const htmlPath = path.join(workDir, 'page.html');
    fs.writeFileSync(htmlPath,
      `<html><head><link rel="stylesheet" href="css/style.css"></head>` +
      `<body><img src="assets/hero.jpg"></body></html>`);

    const result = createPublicShare({ sourcePath: htmlPath });
    expect(result.inlinedAssets?.copied).toBe(2);
    expect(fs.existsSync(path.join(OUT_DIR, result.slug, 'assets', 'hero.jpg'))).toBe(true);
    expect(fs.existsSync(path.join(OUT_DIR, result.slug, 'css', 'style.css'))).toBe(true);
  });

  it('flattens absolute filesystem paths to a sanitized basename', () => {
    const photoPath = path.join(workDir, 'photo.png');
    fs.writeFileSync(photoPath, 'png-bytes');
    const htmlPath = path.join(workDir, 'page.html');
    fs.writeFileSync(htmlPath, `<html><body><img src="${photoPath}"></body></html>`);

    const result = createPublicShare({ sourcePath: htmlPath });
    expect(result.inlinedAssets?.copied).toBe(1);
    // Destination is a basename in the share root, not the full original path.
    expect(fs.existsSync(path.join(OUT_DIR, result.slug, 'photo.png'))).toBe(true);
    // HTML's reference rewritten to the relative basename.
    const html = fs.readFileSync(path.join(OUT_DIR, result.slug, 'page.html'), 'utf-8');
    expect(html).toContain('src="photo.png"');
    expect(html).not.toContain(photoPath);
  });

  it('leaves external URLs alone', () => {
    const htmlPath = path.join(workDir, 'page.html');
    const original =
      `<html><body>` +
      `<img src="https://example.com/foo.png">` +
      `<a href="mailto:foo@bar">mail</a>` +
      `<a href="#section">jump</a>` +
      `<img src="data:image/png;base64,abc">` +
      `</body></html>`;
    fs.writeFileSync(htmlPath, original);

    const result = createPublicShare({ sourcePath: htmlPath });
    expect(result.inlinedAssets?.copied).toBe(0);
    const html = fs.readFileSync(path.join(OUT_DIR, result.slug, 'page.html'), 'utf-8');
    expect(html).toBe(original);
  });

  it('handles inline CSS url(...) refs in three quoting styles', () => {
    fs.writeFileSync(path.join(workDir, 'a.png'), 'a');
    fs.writeFileSync(path.join(workDir, 'b.png'), 'b');
    fs.writeFileSync(path.join(workDir, 'c.png'), 'c');
    const htmlPath = path.join(workDir, 'page.html');
    fs.writeFileSync(htmlPath,
      `<html><head><style>` +
      `.a { background: url("a.png"); }` +
      `.b { background: url('b.png'); }` +
      `.c { background: url(c.png); }` +
      `</style></head><body></body></html>`);

    const result = createPublicShare({ sourcePath: htmlPath });
    expect(result.inlinedAssets?.copied).toBe(3);
    expect(fs.existsSync(path.join(OUT_DIR, result.slug, 'a.png'))).toBe(true);
    expect(fs.existsSync(path.join(OUT_DIR, result.slug, 'b.png'))).toBe(true);
    expect(fs.existsSync(path.join(OUT_DIR, result.slug, 'c.png'))).toBe(true);
  });

  it('strips ?query and #fragment when looking up the file but preserves them in the HTML', () => {
    fs.writeFileSync(path.join(workDir, 'style.css'), 'css');
    const htmlPath = path.join(workDir, 'page.html');
    fs.writeFileSync(htmlPath, `<link rel="stylesheet" href="style.css?v=42">`);

    const result = createPublicShare({ sourcePath: htmlPath });
    expect(result.inlinedAssets?.copied).toBe(1);
    expect(fs.existsSync(path.join(OUT_DIR, result.slug, 'style.css'))).toBe(true);
    const html = fs.readFileSync(path.join(OUT_DIR, result.slug, 'page.html'), 'utf-8');
    expect(html).toContain('href="style.css?v=42"');
  });

  it('skips refs that escape the HTML directory via ../ path traversal', () => {
    fs.mkdirSync(path.join(workDir, 'pages'));
    const htmlPath = path.join(workDir, 'pages', 'page.html');
    // Sibling file outside of the html's directory.
    fs.writeFileSync(path.join(workDir, 'secret.txt'), 'secret');
    fs.writeFileSync(htmlPath, `<a href="../secret.txt">secret</a>`);

    const result = createPublicShare({ sourcePath: htmlPath });
    expect(result.inlinedAssets?.copied).toBe(0);
    expect(result.inlinedAssets?.skipped).toBe(1);
    expect(result.inlinedAssets?.warnings.some((w) => w.includes('escaping'))).toBe(true);
    expect(fs.existsSync(path.join(OUT_DIR, result.slug, 'secret.txt'))).toBe(false);
  });

  it('does not warn when a ref points at a missing file (just leaves it alone)', () => {
    const htmlPath = path.join(workDir, 'page.html');
    fs.writeFileSync(htmlPath, `<img src="not-here.png">`);

    const result = createPublicShare({ sourcePath: htmlPath });
    expect(result.inlinedAssets?.copied).toBe(0);
    expect(result.inlinedAssets?.skipped).toBe(0);
    expect(result.inlinedAssets?.warnings).toEqual([]);
    // HTML preserved as-is — browser will 404 the asset, agent's choice.
    const html = fs.readFileSync(path.join(OUT_DIR, result.slug, 'page.html'), 'utf-8');
    expect(html).toContain('<img src="not-here.png">');
  });

  it('dedupes when the same asset is referenced multiple times', () => {
    fs.writeFileSync(path.join(workDir, 'logo.png'), 'png');
    const htmlPath = path.join(workDir, 'page.html');
    fs.writeFileSync(htmlPath,
      `<img src="logo.png"><img src="logo.png"><img src="logo.png">`);

    const result = createPublicShare({ sourcePath: htmlPath });
    expect(result.inlinedAssets?.copied).toBe(1); // copied once, referenced thrice
  });

  it('does not inline assets for non-HTML single files (e.g. CSS shared on its own)', () => {
    const cssPath = path.join(workDir, 'style.css');
    fs.writeFileSync(cssPath, 'body { background: url("logo.png"); }');
    fs.writeFileSync(path.join(workDir, 'logo.png'), 'png');

    const result = createPublicShare({ sourcePath: cssPath });
    expect(result.inlinedAssets).toBeUndefined();
    expect(fs.existsSync(path.join(OUT_DIR, result.slug, 'logo.png'))).toBe(false);
  });
});
