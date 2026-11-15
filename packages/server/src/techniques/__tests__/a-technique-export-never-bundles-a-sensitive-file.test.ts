// A technique export copies a referenced file into the bundle only when it is not sensitive: anything under
// ~/.ssh (public halves too) and every file the platform's sensitive list names becomes a manual step instead.
// Driven through autoResolveViolations, the export's resolver, with fake files in a scratch home.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'technique-bundle-'));
vi.stubEnv('DOJO_HOME', home);
const { autoResolveViolations, emptyDependencyManifest } = await import('../dependencies.js');

const technique = path.join(home, 'technique');
const FILES = ['.ssh/id_ed25519.pub', '.ssh/known_hosts', '.dojo/secrets.yaml', 'Projects/.env', 'Projects/notes.txt'];

beforeAll(() => {
  fs.mkdirSync(technique, { recursive: true });
  for (const rel of FILES) {
    fs.mkdirSync(path.dirname(path.join(home, rel)), { recursive: true });
    fs.writeFileSync(path.join(home, rel), 'fake content');
  }
});
afterAll(() => {
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

const actionFor = (rel: string) => {
  const raw = `~/${rel}`;
  const { resolutions } = autoResolveViolations(technique, [{
    reference: { raw, source: 'inline_code', excerpt: raw }, reason: 'tilde_home', detail: 'outside the technique',
  }], emptyDependencyManifest());
  return resolutions[0]?.action;
};

describe('a technique export never bundles a sensitive file', () => {
  it.each(FILES.slice(0, 4))('~/%s becomes a manual step', (rel) => {
    expect(actionFor(rel)).toBe('declared_as_manual_step');
  });

  it('an ordinary file is bundled', () => {
    expect(actionFor('Projects/notes.txt')).toBe('bundled');
  });
});
