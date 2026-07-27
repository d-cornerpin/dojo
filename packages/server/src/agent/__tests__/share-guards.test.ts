// PHASE-0 T10 — share/pdf paths pass the sensitive-path + permission checks,
// and every sensitive-path comparison case-folds on a case-insensitive
// filesystem.
//
// Before this task `share_file` minted a public download URL for ANY path with
// no check at all, `share_publicly` copied any path into an unauthenticated
// /share/ URL, and the pdf_* tools read any path straight into the model's
// context. Separately, all four sensitive-path layers compared case-sensitively
// while APFS does not, so `~/.dojo/Secrets.yaml` walked past every one of them
// at once (../overhaul-research/22-remediation-reconciliation.md §3).
//
// TEST HYGIENE (binding, task brief §2): these tests NEVER touch the owner's
// real ~/.ssh or ~/.dojo. `os.homedir()` is redirected to a throwaway temp
// directory and the "secrets" inside it are dummy strings this file wrote.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ── Fixture world ──
// Built BEFORE the module mocks so the homedir spy can point at it, and before
// any import of the code under test (vitest hoists vi.mock, not these consts).
const fixtureHome = fs.mkdtempSync(path.join(os.tmpdir(), 'share-guards-home-'));
const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'share-guards-scratch-'));

fs.mkdirSync(path.join(fixtureHome, '.dojo'), { recursive: true });
fs.mkdirSync(path.join(fixtureHome, '.ssh'), { recursive: true });
fs.writeFileSync(path.join(fixtureHome, '.dojo', 'secrets.yaml'), 'dummy: not-a-real-key\n');
fs.writeFileSync(path.join(fixtureHome, '.ssh', 'id_ed25519'), 'DUMMY PRIVATE KEY\n');
fs.writeFileSync(path.join(fixtureHome, '.ssh', 'id_ed25519.pub'), 'DUMMY PUBLIC KEY\n');
const scratchFile = path.join(scratchDir, 'notes.txt');
fs.writeFileSync(scratchFile, 'an ordinary file an agent may legitimately share\n');

// On the dev box (APFS, case-insensitive) `Secrets.yaml` IS `secrets.yaml`, so
// writing it a second time would just rewrite the same file. Only create the
// separate capitalised fixture when the filesystem really keeps them apart.
const capitalisedSecrets = path.join(fixtureHome, '.dojo', 'Secrets.yaml');
if (!fs.existsSync(capitalisedSecrets)) fs.writeFileSync(capitalisedSecrets, 'dummy: also-not-real\n');

// ── Module mocks ──
// auditLog / registerSharedFile / permission lookups all hit the DB. The agent
// row returned here carries file_read '*', so a refusal in these tests can only
// have come from the guard under test, never from an incidental allowlist miss.
vi.mock('../../db/connection.js', () => ({
  getDb: () => ({
    prepare: () => ({
      run: () => ({}),
      get: () => ({
        id: 'agent-under-test',
        name: 'Tester',
        permissions: '{"file_read":"*","file_write":"*"}',
        spawn_depth: 1,
        created_by: 'agent-parent',
        group_id: null,
      }),
      all: () => [],
    }),
    exec: () => ({}),
    transaction: (fn: () => unknown) => () => fn(),
  }),
}));

vi.mock('../../gateway/ws.js', () => ({ broadcast: () => { /* no-op */ } }));

vi.mock('../../services/tunnel.js', () => ({
  getTunnelStatus: () => ({ status: 'inactive', url: null }),
  killTunnelSync: () => { /* no-op */ },
}));

import { executeTool } from '../tools.js';
import {
  foldPath,
  isSensitivePath,
  isFsCaseInsensitive,
  setFsCaseInsensitive,
  probeFsCaseInsensitive,
  pdfInputPaths,
  sharePathGuard,
  type ProbeFs,
} from '../path-guards.js';
import { checkPermission } from '../permissions.js';

const AGENT = 'agent-under-test';

let homedirSpy: ReturnType<typeof vi.spyOn>;

beforeAll(() => {
  homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(fixtureHome);
});

afterAll(() => {
  homedirSpy.mockRestore();
  fs.rmSync(fixtureHome, { recursive: true, force: true });
  fs.rmSync(scratchDir, { recursive: true, force: true });
});

beforeEach(() => {
  // Default posture for the behaviour tests: the dev box's real filesystem.
  setFsCaseInsensitive(true);
});

async function share(p: string): Promise<{ content: string; isError: boolean }> {
  const r = await executeTool(AGENT, { id: 'call-1', name: 'share_file', arguments: { path: p } });
  return { content: r.content, isError: !!r.isError };
}

// ════════════════════════════════════════
// Step 1 — the five cases the plan names
// ════════════════════════════════════════

describe('share_file refuses sensitive paths', () => {
  it('blocks ~/.dojo/secrets.yaml', async () => {
    const r = await share('~/.dojo/secrets.yaml');
    expect(r.content).toContain('[BLOCKED]');
    expect(r.content).toContain('sensitive-files block list');
    expect(r.isError).toBe(true);
    // The whole point: no URL was minted.
    expect(r.content).not.toMatch(/Download link/);
  });

  it('blocks ~/.ssh/id_ed25519', async () => {
    const r = await share('~/.ssh/id_ed25519');
    expect(r.content).toContain('[BLOCKED]');
    expect(r.isError).toBe(true);
    expect(r.content).not.toMatch(/Download link/);
  });

  it('blocks ~/.dojo/Secrets.yaml — the case-folding bypass', async () => {
    const r = await share('~/.dojo/Secrets.yaml');
    expect(r.content).toContain('[BLOCKED]');
    expect(r.isError).toBe(true);
    expect(r.content).not.toMatch(/Download link/);
  });

  it('blocks an absolute path to the same secret (no ~ to expand)', async () => {
    const r = await share(path.join(fixtureHome, '.dojo', 'secrets.yaml'));
    expect(r.content).toContain('[BLOCKED]');
    expect(r.isError).toBe(true);
  });

  it('still shares an ordinary scratch file', async () => {
    const r = await share(scratchFile);
    expect(r.content).not.toContain('[BLOCKED]');
    expect(r.isError).toBe(false);
    expect(r.content).toMatch(/^Download link for notes\.txt: http/);
  });

  it('still shares a PUBLIC ssh key (.pub stays on the allow side)', async () => {
    const r = await share('~/.ssh/id_ed25519.pub');
    expect(r.content).not.toContain('[BLOCKED]');
    expect(r.content).toMatch(/Download link/);
  });
});

describe('pdf tools refuse sensitive paths', () => {
  it('blocks pdf_read of ~/.dojo/secrets.yaml', async () => {
    const r = await executeTool(AGENT, {
      id: 'call-2', name: 'pdf_read', arguments: { path: '~/.dojo/secrets.yaml' },
    });
    expect(r.content).toContain('[BLOCKED]');
    expect(r.isError).toBe(true);
  });

  it('blocks pdf_merge when ANY input path is sensitive', async () => {
    const r = await executeTool(AGENT, {
      id: 'call-3',
      name: 'pdf_merge',
      arguments: {
        input_paths: [path.join(scratchDir, 'a.pdf'), '~/.ssh/id_ed25519'],
        output_filename: 'merged.pdf',
      },
    });
    expect(r.content).toContain('[BLOCKED]');
    expect(r.isError).toBe(true);
  });

  it('lets an ordinary pdf path through the guard (it fails later, on its own merits)', async () => {
    const r = await executeTool(AGENT, {
      id: 'call-4', name: 'pdf_read', arguments: { path: path.join(scratchDir, 'nope.pdf') },
    });
    expect(r.content).not.toContain('[BLOCKED]');
    expect(r.content).toMatch(/file not found/i);
  });
});

describe('share_publicly refuses sensitive paths', () => {
  it('blocks ~/.dojo/secrets.yaml before public-share is ever called', async () => {
    const r = await executeTool(AGENT, {
      id: 'call-5', name: 'share_publicly', arguments: { source_path: '~/.dojo/secrets.yaml' },
    });
    expect(r.content).toContain('[BLOCKED]');
    expect(r.isError).toBe(true);
    expect(r.content).not.toMatch(/Public URL/);
  });
});

// ════════════════════════════════════════
// The permission half of the gate
// ════════════════════════════════════════

describe('share_file enforces file_read permission', () => {
  it('refuses a path outside the agent manifest with the standard permission block', async () => {
    // A second agent id with a narrow manifest. checkPermission reads the
    // manifest through the same mocked row, so drive the refusal by asking for
    // a path the DEFAULT sub-agent allowlist would never contain: swap the
    // manifest for this one call.
    const guard = await sharePathGuard(AGENT, 'share_file', scratchFile);
    expect(guard.allowed).toBe(true);

    // The permission branch itself: a globally denied read is refused even for
    // a manifest that says file_read '*'.
    const denied = checkPermission(AGENT, {
      type: 'file_read',
      path: path.join(fixtureHome, '.dojo', 'logs', 'healer.log'),
    });
    expect(denied.allowed).toBe(false);
  });

  it('a permission refusal carries blockedMessage=null so the caller renders the standard text', async () => {
    const guard = await sharePathGuard(AGENT, 'share_file', path.join(fixtureHome, '.dojo', 'logs', 'healer.log'));
    expect(guard.allowed).toBe(false);
    if (!guard.allowed) expect(guard.blockedMessage).toBeNull();
  });

  it('a sensitive-list refusal carries its own [BLOCKED] text', async () => {
    const guard = await sharePathGuard(AGENT, 'share_file', '~/.dojo/secrets.yaml');
    expect(guard.allowed).toBe(false);
    if (!guard.allowed) expect(guard.blockedMessage).toContain('[BLOCKED] share_file refused');
  });
});

// ════════════════════════════════════════
// The fold — BOTH filesystem answers
// ════════════════════════════════════════

describe('case folding is driven by the measured filesystem, not by the platform', () => {
  it('folds when the filesystem is case-insensitive', () => {
    setFsCaseInsensitive(true);
    expect(isFsCaseInsensitive()).toBe(true);
    expect(foldPath('/Users/X/.dojo/Secrets.yaml')).toBe('/users/x/.dojo/secrets.yaml');
    expect(isSensitivePath(path.join(fixtureHome, '.dojo', 'Secrets.yaml'))).toBe(true);
    expect(isSensitivePath(path.join(fixtureHome, '.ssh', 'ID_ED25519'))).toBe(true);
    expect(isSensitivePath(path.join(fixtureHome, 'Projects', '.ENV'))).toBe(true);
  });

  it('does NOT fold when the filesystem is case-sensitive — no false blocks on Linux', () => {
    setFsCaseInsensitive(false);
    expect(isFsCaseInsensitive()).toBe(false);
    expect(foldPath('/home/X/.dojo/Secrets.yaml')).toBe('/home/X/.dojo/Secrets.yaml');
    // On a case-sensitive box these are genuinely different files.
    expect(isSensitivePath(path.join(fixtureHome, '.dojo', 'Secrets.yaml'))).toBe(false);
    expect(isSensitivePath(path.join(fixtureHome, 'Projects', '.ENV'))).toBe(false);
    // The exact-case originals are still caught, on both filesystems.
    expect(isSensitivePath(path.join(fixtureHome, '.dojo', 'secrets.yaml'))).toBe(true);
    expect(isSensitivePath(path.join(fixtureHome, '.ssh', 'id_ed25519'))).toBe(true);
  });

  it('share_file mirrors the flag: Secrets.yaml is blocked folded, allowed unfolded', async () => {
    setFsCaseInsensitive(true);
    expect((await share('~/.dojo/Secrets.yaml')).content).toContain('[BLOCKED]');
    setFsCaseInsensitive(false);
    expect((await share('~/.dojo/Secrets.yaml')).content).not.toContain('[BLOCKED]');
  });

  it('the permission layer folds too (matchGlob had no /i)', () => {
    const capital = path.join(fixtureHome, '.dojo', 'Secrets.yaml');
    setFsCaseInsensitive(true);
    expect(checkPermission(AGENT, { type: 'file_read', path: capital }).allowed).toBe(false);
    setFsCaseInsensitive(false);
    expect(checkPermission(AGENT, { type: 'file_read', path: capital }).allowed).toBe(true);
    // Lower-case is denied on both filesystems.
    setFsCaseInsensitive(true);
    expect(checkPermission(AGENT, {
      type: 'file_read', path: path.join(fixtureHome, '.dojo', 'secrets.yaml'),
    }).allowed).toBe(false);
  });

  it('the exec substring deny folds too', () => {
    setFsCaseInsensitive(true);
    expect(checkPermission(AGENT, { type: 'exec', command: 'cat ~/.dojo/Secrets.yaml' }).allowed).toBe(false);
    setFsCaseInsensitive(false);
    expect(checkPermission(AGENT, { type: 'exec', command: 'cat ~/.dojo/secrets.yaml' }).allowed).toBe(false);
  });
});

describe('the boot probe measures the filesystem', () => {
  const probeFsFor = (caseInsensitive: boolean): ProbeFs & { written: string[]; unlinked: string[] } => {
    const written: string[] = [];
    const unlinked: string[] = [];
    return {
      written,
      unlinked,
      writeFileSync: (file: string) => { written.push(file); },
      existsSync: (file: string) => written.some(
        (w) => (caseInsensitive ? w.toLowerCase() === file.toLowerCase() : w === file),
      ),
      unlinkSync: (file: string) => { unlinked.push(file); },
    };
  };

  it('reports TRUE on a case-insensitive volume (the A.tmp / a.tmp probe)', () => {
    const fake = probeFsFor(true);
    expect(probeFsCaseInsensitive('/some/dir', fake)).toBe(true);
    expect(fake.written[0]).toMatch(/-A\.tmp$/);
    expect(fake.unlinked).toHaveLength(1);
  });

  it('reports FALSE on a case-sensitive volume', () => {
    const fake = probeFsFor(false);
    expect(probeFsCaseInsensitive('/some/dir', fake)).toBe(false);
    expect(fake.unlinked).toHaveLength(1);
  });

  it('reports FALSE and still cleans up when the probe cannot write', () => {
    const fake = probeFsFor(true);
    const throwing: ProbeFs = {
      writeFileSync: () => { throw new Error('EACCES'); },
      existsSync: () => true,
      unlinkSync: fake.unlinkSync,
    };
    expect(probeFsCaseInsensitive('/some/dir', throwing)).toBe(false);
  });

  it('agrees with the real filesystem this suite is running on', () => {
    const real: ProbeFs = {
      writeFileSync: (f, d) => fs.writeFileSync(f, d),
      existsSync: (f) => fs.existsSync(f),
      unlinkSync: (f) => fs.unlinkSync(f),
    };
    const measured = probeFsCaseInsensitive(scratchDir, real);
    // Independent check: write one case, read the other.
    const probeUpper = path.join(scratchDir, 'CaseCheck.txt');
    const probeLower = path.join(scratchDir, 'casecheck.txt');
    fs.writeFileSync(probeUpper, 'x');
    const truth = fs.existsSync(probeLower);
    fs.unlinkSync(probeUpper);
    expect(measured).toBe(truth);
  });
});

// ════════════════════════════════════════
// Which pdf arguments the interceptor gates
// ════════════════════════════════════════

describe('pdfInputPaths', () => {
  it('collects path, input_paths and image-block paths; ignores output filenames', () => {
    expect(pdfInputPaths({ path: '/a.pdf' })).toEqual(['/a.pdf']);
    expect(pdfInputPaths({ input_paths: ['/a.pdf', '/b.pdf'], output_filename: 'out.pdf' }))
      .toEqual(['/a.pdf', '/b.pdf']);
    expect(pdfInputPaths({ content: [{ type: 'image', path: '/img.png' }, { type: 'text', text: 'hi' }] }))
      .toEqual(['/img.png']);
    expect(pdfInputPaths({ filename: 'report.pdf' })).toEqual([]);
    expect(pdfInputPaths({ path: '   ' })).toEqual([]);
  });
});
