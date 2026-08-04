// ════════════════════════════════════════════════════════════════════════════
// THE ASSET AN HTML PAGE NAMES IS PUBLISHED TOO (PHASE-5 T9B).
//
// THE REQUIREMENT, and it is the owner's (2026-08-03, "Close it now"): **every
// file a shared page pulls in passes the same sanctioned sensitive-path refusal
// the publish family's other doors run.**
//
// `createPublicShare()` copies bytes into `~/.dojo/out/<slug>/`, which the
// gateway serves at `/share/<slug>/…` WITHOUT a sign-in. Two denials already
// stand at that door — one for the file the caller names, one for every file the
// directory walk sweeps in as a passenger. An asset an HTML page NAMES is the
// third population of exactly the same shape, and it had no denial: the page's
// own `<img>` / `<link>` / `<script>` / `url(…)` references reach any file on
// the machine and put it at the public URL.
//
// ── WHAT THIS FILE HOLDS, AND WHAT IT DELIBERATELY DOES NOT ──
// It holds the REFUSAL and it holds the NEGATIVE CONTROLS with equal weight.
// The controls are the half that keeps the refusal honest: this is a NEW refusal
// on behaviour that works today, so every clause that proves something is now
// blocked is paired with one proving that what publishes today still publishes,
// byte for byte and count for count. A guard that also refuses ordinary assets
// is not a narrower guard, it is a broken feature.
//
// The check is the site's own `isSensitivePath` — the same one its two existing
// denials ask — asked on the resolved path BEFORE anything stats, reads or
// copies the asset, which is the order both siblings ask it in. It is asked
// about BOTH spellings of the file (lexical and symlink-resolved) because the
// publish family's own door has asked both since PHASE-5 T2; a `..` and a
// symlink are two ways of writing the same filename, and the clauses below
// drive each one.
// ════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

// The deny list answers `~`-rooted rules against `os.homedir()`, and OUT_DIR is
// computed from it at import time — so the fake home is installed before the
// import, exactly as the sibling asset test does it.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'public-share-sensitive-'));
process.env.HOME = tmpHome;

import { createPublicShare, OUT_DIR } from '../public-share.js';

let workDir: string;

/** Absolute path under the fake home, with its parents created. */
function inHome(...parts: string[]): string {
  const p = path.join(tmpHome, ...parts);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  return p;
}

/** Write `html` as the page and share it. */
function share(html: string, name = 'page.html'): ReturnType<typeof createPublicShare> {
  const htmlPath = path.join(workDir, name);
  fs.writeFileSync(htmlPath, html);
  return createPublicShare({ sourcePath: htmlPath });
}

/** Everything under the share directory, relative and sorted. */
function shareTree(slug: string, dir?: string, out: string[] = []): string[] {
  const root = path.join(OUT_DIR, slug);
  const here = dir ?? root;
  for (const entry of fs.readdirSync(here, { withFileTypes: true })) {
    const full = path.join(here, entry.name);
    if (entry.isDirectory()) shareTree(slug, full, out);
    else out.push(path.relative(root, full));
  }
  return out.sort();
}

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'share-sensitive-src-'));
});

afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

describe('a shared page cannot pull a protected file in as an asset', () => {
  it('refuses a sensitive asset named as a relative sibling', () => {
    fs.writeFileSync(path.join(workDir, '.env'), 'OPENAI_API_KEY=redacted-in-test');
    const result = share('<html><body><script src=".env"></script></body></html>');

    expect(shareTree(result.slug)).toEqual(['page.html']);
    expect(result.inlinedAssets?.copied).toBe(0);
    expect(result.inlinedAssets?.skipped).toBe(1);
    expect(result.inlinedAssets?.warnings.join('\n')).toContain('.env');
    // The page's own reference is left exactly as written — a refused asset is
    // not silently rewritten to point at something that is not there.
    const published = fs.readFileSync(path.join(OUT_DIR, result.slug, 'page.html'), 'utf-8');
    expect(published).toContain('<script src=".env">');
  });

  it('refuses a sensitive asset in a subdirectory of the page', () => {
    fs.mkdirSync(path.join(workDir, 'config'));
    fs.writeFileSync(path.join(workDir, 'config', 'secrets.yaml'), 'api_key: redacted-in-test');
    const result = share('<html><head><link href="config/secrets.yaml"></head></html>');

    expect(shareTree(result.slug)).toEqual(['page.html']);
    expect(result.inlinedAssets?.skipped).toBe(1);
  });

  it('refuses a sensitive asset named by absolute path', () => {
    const key = path.join(workDir, 'keys', 'id_rsa');
    fs.mkdirSync(path.dirname(key), { recursive: true });
    fs.writeFileSync(key, 'PRIVATE KEY BYTES (test fixture)');
    const result = share(`<html><body><img src="${key}"></body></html>`);

    expect(shareTree(result.slug)).toEqual(['page.html']);
    expect(result.inlinedAssets?.copied).toBe(0);
    expect(result.inlinedAssets?.skipped).toBe(1);
  });

  it('refuses a sensitive asset named as a file:// URL (the keyframe pattern)', () => {
    const key = path.join(workDir, 'id_ed25519');
    fs.writeFileSync(key, 'PRIVATE KEY BYTES (test fixture)');
    const result = share(`<html><body><img src="file://${key}"></body></html>`);

    expect(shareTree(result.slug)).toEqual(['page.html']);
    expect(result.inlinedAssets?.skipped).toBe(1);
  });

  it('refuses a sensitive asset named by an inline CSS url(...)', () => {
    fs.writeFileSync(path.join(workDir, '.netrc'), 'machine example.com login redacted-in-test');
    const result = share('<html><head><style>body{background:url(".netrc")}</style></head></html>');

    expect(shareTree(result.slug)).toEqual(['page.html']);
    expect(result.inlinedAssets?.skipped).toBe(1);
  });

  it('refuses an ordinary-looking asset that lives inside a protected DIRECTORY', () => {
    // The whole point of the directory rows: the basename says nothing.
    const shot = inHome('.config', 'gcloud', 'token.png');
    fs.writeFileSync(shot, 'png-bytes');
    const result = share(`<html><body><img src="${shot}"></body></html>`);

    expect(shareTree(result.slug)).toEqual(['page.html']);
    expect(result.inlinedAssets?.skipped).toBe(1);
  });

  it('refuses a protected asset spelled with a traversal segment', () => {
    fs.mkdirSync(path.join(tmpHome, 'projects'), { recursive: true });
    const real = inHome('.ssh', 'diagram.png');
    fs.writeFileSync(real, 'png-bytes');
    const spelled = path.join(tmpHome, 'projects', '..', '.ssh', 'diagram.png');
    const result = share(`<html><body><img src="${spelled}"></body></html>`);

    expect(shareTree(result.slug)).toEqual(['page.html']);
    expect(result.inlinedAssets?.skipped).toBe(1);
  });

  it('refuses a protected asset reached through a symlink with an innocent name', () => {
    const key = inHome('.ssh', 'id_ecdsa');
    fs.writeFileSync(key, 'PRIVATE KEY BYTES (test fixture)');
    fs.symlinkSync(key, path.join(workDir, 'pic.png'));
    const result = share('<html><body><img src="pic.png"></body></html>');

    expect(shareTree(result.slug)).toEqual(['page.html']);
    expect(result.inlinedAssets?.skipped).toBe(1);
  });

  it('refuses only the protected asset — the rest of the page publishes normally', () => {
    fs.writeFileSync(path.join(workDir, 'logo.png'), 'png-bytes');
    fs.writeFileSync(path.join(workDir, '.env.production'), 'TOKEN=redacted-in-test');
    const result = share(
      '<html><body><img src="logo.png"><script src=".env.production"></script></body></html>',
    );

    expect(shareTree(result.slug)).toEqual(['logo.png', 'page.html']);
    expect(result.inlinedAssets?.copied).toBe(1);
    expect(result.inlinedAssets?.skipped).toBe(1);
  });
});

// ── THE OTHER HALF: everything that publishes today still publishes ──────────
// These clauses are green BEFORE the refusal exists and identically after. They
// are the oracle for "less code, never less capability" applied to a guard: the
// refusal is honest only if none of them moves.
describe('the refusal does not touch anything a page legitimately pulls in', () => {
  it('copies an ordinary sibling asset, with no skips and no warnings', () => {
    fs.writeFileSync(path.join(workDir, 'logo.png'), 'png-bytes');
    const result = share('<html><body><img src="logo.png"></body></html>');

    expect(shareTree(result.slug)).toEqual(['logo.png', 'page.html']);
    expect(result.inlinedAssets?.copied).toBe(1);
    expect(result.inlinedAssets?.skipped).toBe(0);
    expect(result.inlinedAssets?.warnings).toEqual([]);
  });

  it('copies assets from the page’s own subdirectories, structure preserved', () => {
    fs.mkdirSync(path.join(workDir, 'assets'), { recursive: true });
    fs.mkdirSync(path.join(workDir, 'css'), { recursive: true });
    fs.writeFileSync(path.join(workDir, 'assets', 'hero.jpg'), 'jpg-bytes');
    fs.writeFileSync(path.join(workDir, 'css', 'style.css'), 'body{color:red}');
    const result = share(
      '<html><head><link href="css/style.css"></head><body><img src="assets/hero.jpg"></body></html>',
    );

    expect(shareTree(result.slug)).toEqual(['assets/hero.jpg', 'css/style.css', 'page.html']);
    expect(result.inlinedAssets?.skipped).toBe(0);
  });

  it('copies an ordinary asset named by absolute path and by file:// URL', () => {
    const a = path.join(workDir, 'chart.png');
    const b = path.join(workDir, 'photo.jpg');
    fs.writeFileSync(a, 'png-bytes');
    fs.writeFileSync(b, 'jpg-bytes');
    const result = share(`<html><body><img src="${a}"><img src="file://${b}"></body></html>`);

    expect(shareTree(result.slug)).toEqual(['chart.png', 'page.html', 'photo.jpg']);
    expect(result.inlinedAssets?.copied).toBe(2);
    expect(result.inlinedAssets?.skipped).toBe(0);
  });

  it('copies the .pub half of an SSH key pair — the deny list’s own exception', () => {
    const pub = inHome('.ssh', 'team_key.pub');
    fs.writeFileSync(pub, 'ssh-ed25519 AAAA… test');
    const result = share(`<html><body><img src="${pub}"></body></html>`);

    expect(shareTree(result.slug)).toEqual(['page.html', 'team_key.pub']);
    expect(result.inlinedAssets?.copied).toBe(1);
    expect(result.inlinedAssets?.skipped).toBe(0);
  });

  it('copies files whose names merely LOOK sensitive — nothing was widened', () => {
    // `secret*` is denied only under ~/.dojo; `.env.example` is not a member of
    // the sensitive basenames. Both publish, and that is the correct answer.
    fs.writeFileSync(path.join(workDir, 'secret-plan.png'), 'png-bytes');
    fs.writeFileSync(path.join(workDir, '.env.example'), 'KEY=');
    const result = share(
      '<html><body><img src="secret-plan.png"><script src=".env.example"></script></body></html>',
    );

    expect(shareTree(result.slug)).toEqual(['.env.example', 'page.html', 'secret-plan.png']);
    expect(result.inlinedAssets?.copied).toBe(2);
    expect(result.inlinedAssets?.skipped).toBe(0);
  });

  it('leaves external references alone and counts nothing against them', () => {
    const result = share(
      '<html><head><link href="https://cdn.example.com/a.css"></head>' +
      '<body><img src="data:image/png;base64,AAAA"><a href="#top">t</a></body></html>',
    );

    expect(shareTree(result.slug)).toEqual(['page.html']);
    expect(result.inlinedAssets?.copied).toBe(0);
    expect(result.inlinedAssets?.skipped).toBe(0);
    const published = fs.readFileSync(path.join(OUT_DIR, result.slug, 'page.html'), 'utf-8');
    expect(published).toContain('https://cdn.example.com/a.css');
    expect(published).toContain('data:image/png;base64,AAAA');
  });

  it('still counts a missing asset as missing, not as refused', () => {
    const result = share('<html><body><img src="gone.png"></body></html>');

    expect(result.inlinedAssets?.notFound).toBe(1);
    expect(result.inlinedAssets?.skipped).toBe(0);
  });

  it('still refuses a traversal that escapes the page directory, with its own reason', () => {
    fs.writeFileSync(path.join(workDir, '..', 'outside.png'), 'png-bytes');
    const result = share('<html><body><img src="../outside.png"></body></html>');

    expect(shareTree(result.slug)).toEqual(['page.html']);
    expect(result.inlinedAssets?.skipped).toBe(1);
    expect(result.inlinedAssets?.warnings.join('\n')).toContain('escaping HTML directory');
  });
});
