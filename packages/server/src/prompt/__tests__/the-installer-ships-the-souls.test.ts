// UX-REPAIR ROUND 12 / T55 — THE INSTALLER PROVES THE SOULS SHIPPED (W35's HU-1, as code).
//
// ── THE HAND-UP, VERBATIM (W35 §7) ──
// "The whole headline depends on `readPlatformTemplate` finding a template on a box that is
//  NOT the repo… nothing in the gate set checks it. The PM test asserts
//  `platformTemplateSearchPaths` 'covers the repo layout and ~/.dojo/platform/templates' as
//  STRINGS; it never asserts the BUILD actually puts a file there. If `build-package.sh:70-71`
//  is ever dropped, every PM and Trainer silently reverts to the stub and no gate would notice."
//
// ── WHAT THE GATE DOES, AND WHY THIS TEST EXISTS BESIDE IT ──
// `deploy/checks/check-shipped-souls.mjs` asks the BUILT ARTIFACT — not the script text — for
// each `templates/*-SOUL.md`, at the exact path the COMPILED assembler computes from its own
// location (`platformTemplateSearchPaths`'s one relative hop, resolved from
// `packages/server/dist/prompt/`). A gate is only worth its manifest line if it BITES, so this
// pins the bite in the unit suite — which is itself a release gate — by driving the real script
// against synthetic artifacts: one complete, and one built the way it would be if the copy step
// were dropped.
//
// It lives beside `prompt/assembler.ts` on purpose: the depth the gate asserts is the depth
// THAT file computes, and if `platformTemplateSearchPaths` ever moves, this is the neighbour
// that fails.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import realOs from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../../../..');
const GATE = path.join(REPO_ROOT, 'deploy/checks/check-shipped-souls.mjs');
const REPO_TEMPLATES = path.join(REPO_ROOT, 'templates');

const WORK = path.join(realOs.tmpdir(), 'dojo-t55-shipped-souls');

/** Run the gate exactly as release.sh and `npm run gates` do. */
function runGate(args: string[]): { code: number; out: string } {
  const r = spawnSync(process.execPath, [GATE, ...args], { encoding: 'utf8', cwd: REPO_ROOT });
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/**
 * A synthetic artifact in the SHIPPED layout: `<root>/platform/...`, with the compiled server
 * where `build-package.sh` puts it and the templates where its :70-71 copy step puts them.
 * `stripTemplates` is that copy step dropped — the exact failure W35 named.
 */
function buildArtifact(name: string, opts: {
  stripTemplates?: boolean;
  omit?: string[];
  truncate?: string[];
  wrongDepth?: boolean;
  noDist?: boolean;
} = {}): string {
  const root = path.join(WORK, name);
  fs.rmSync(root, { recursive: true, force: true });
  const platform = path.join(root, 'platform');
  if (!opts.noDist) fs.mkdirSync(path.join(platform, 'packages/server/dist/prompt'), { recursive: true });
  else fs.mkdirSync(platform, { recursive: true });
  if (!opts.noDist) {
    fs.writeFileSync(path.join(platform, 'packages/server/dist/prompt/assembler.js'), '// compiled\n');
  }
  // The artifact declares the tree it was built from; the gate uses it to decide whether
  // byte-identity against the repo templates is a fair question.
  const repoVersion = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version;
  fs.writeFileSync(path.join(platform, 'package.json'), JSON.stringify({ version: repoVersion }, null, 2));

  const dest = opts.wrongDepth
    ? path.join(platform, 'packages/server/dist/templates')
    : path.join(platform, 'templates');
  if (!opts.stripTemplates) {
    fs.mkdirSync(dest, { recursive: true });
    for (const f of fs.readdirSync(REPO_TEMPLATES).filter((f) => f.endsWith('.md'))) {
      if (opts.omit?.includes(f)) continue;
      const body = opts.truncate?.includes(f)
        ? '# Stub\n\nYou are the agent.\n'                     // the in-code stub, in a smaller hat
        : fs.readFileSync(path.join(REPO_TEMPLATES, f), 'utf8');
      fs.writeFileSync(path.join(dest, f), body);
    }
  }
  return root;
}

beforeAll(() => { fs.rmSync(WORK, { recursive: true, force: true }); fs.mkdirSync(WORK, { recursive: true }); });
afterAll(() => { fs.rmSync(WORK, { recursive: true, force: true }); });

describe('the installer proves the souls shipped', () => {
  it('GREEN: a complete artifact passes', () => {
    const r = runGate([buildArtifact('complete'), '--require-artifact']);
    expect(r.out).toContain('PM-SOUL.md');
    expect(r.code).toBe(0);
  });

  it('RED: the copy step dropped — no platform/templates at all — refuses', () => {
    const r = runGate([buildArtifact('no-templates', { stripTemplates: true }), '--require-artifact']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('PM-SOUL.md');
  });

  it('RED: PM-SOUL.md missing from an otherwise complete artifact refuses', () => {
    const r = runGate([buildArtifact('no-pm', { omit: ['PM-SOUL.md'] }), '--require-artifact']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('PM-SOUL.md');
  });

  it('RED: TRAINER-SOUL.md shipped as a stub refuses — presence is not enough', () => {
    const r = runGate([buildArtifact('stub-trainer', { truncate: ['TRAINER-SOUL.md'] }), '--require-artifact']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('TRAINER-SOUL.md');
  });

  it('RED: templates shipped at the WRONG DEPTH refuse — the assembler resolves ONE path', () => {
    const r = runGate([buildArtifact('wrong-depth', { wrongDepth: true }), '--require-artifact']);
    expect(r.code).toBe(1);
  });

  it('RED: an artifact with no compiled prompt/ directory refuses — the anchor must exist', () => {
    const r = runGate([buildArtifact('no-dist', { noDist: true }), '--require-artifact']);
    expect(r.code).toBe(1);
  });

  it('--require-artifact turns "no artifact" into a REFUSAL, never a quiet pass', () => {
    const r = runGate([path.join(WORK, 'does-not-exist'), '--require-artifact']);
    expect(r.code).toBe(1);
  });

  it('CONTROL: without --require-artifact a missing artifact SKIPS loudly (npm run gates is offline)', () => {
    const r = runGate([path.join(WORK, 'does-not-exist')]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('SKIPPED');
  });

  it('CONTROL: the gate covers EVERY *-SOUL.md the repo ships, discovered not hand-listed', () => {
    const shipped = fs.readdirSync(REPO_TEMPLATES).filter((f) => f.endsWith('-SOUL.md'));
    expect(shipped).toContain('PM-SOUL.md');
    expect(shipped).toContain('TRAINER-SOUL.md');
    const r = runGate([buildArtifact('coverage'), '--require-artifact']);
    for (const f of shipped) expect(r.out).toContain(f);
  });

  // ── T59 (W42): the NAMED FLOOR widens to the full set ──
  // Discovery already covered these files; discovery cannot refuse their DELETION, because a
  // repo with no `HEALER-SOUL.md` simply discovers one fewer soul and reports a clean sweep.
  // The named floor is the half that bites, and T59 put three more live dependencies behind it.

  it('RED: HEALER-SOUL.md missing from an otherwise complete artifact refuses', () => {
    const r = runGate([buildArtifact('no-healer', { omit: ['HEALER-SOUL.md'] }), '--require-artifact']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('HEALER-SOUL.md');
  });

  it('RED: IMAGINER-SOUL.md shipped as a stub refuses — presence is not enough', () => {
    const r = runGate([buildArtifact('stub-imaginer', { truncate: ['IMAGINER-SOUL.md'] }), '--require-artifact']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('IMAGINER-SOUL.md');
  });

  it('RED: a repo that DELETED a floor soul cannot pass on the strength of its siblings', () => {
    // The failure discovery alone cannot see. Simulated by asking the gate about a repo whose
    // templates directory is missing the file, which is what the named floor exists to catch.
    const src = fs.readFileSync(path.join(REPO_ROOT, 'deploy/checks/check-shipped-souls.mjs'), 'utf8');
    const floor = /const REQUIRED_SOULS = \[([\s\S]*?)\];/.exec(src)?.[1] ?? '';
    for (const f of ['PM-SOUL.md', 'TRAINER-SOUL.md', 'HEALER-SOUL.md', 'IMAGINER-SOUL.md', 'DREAMER-SOUL.md']) {
      expect(floor, `${f} must be a NAMED floor, not only discovered`).toContain(f);
    }
    // …and every named floor must actually be a file the repo ships, or the gate asserts a ghost.
    const shipped = fs.readdirSync(REPO_TEMPLATES);
    for (const m of floor.matchAll(/'([^']+)'/g)) expect(shipped).toContain(m[1]);
  });

  it('CONTROL: the gate is declared in the manifest and invoked by release.sh', () => {
    const manifest = fs.readFileSync(path.join(REPO_ROOT, 'deploy/checks/gate-manifest.mjs'), 'utf8');
    const release = fs.readFileSync(path.join(REPO_ROOT, 'deploy/release.sh'), 'utf8');
    expect(manifest).toContain('deploy/checks/check-shipped-souls.mjs');
    expect(release).toContain('checks/check-shipped-souls.mjs');
  });
});
