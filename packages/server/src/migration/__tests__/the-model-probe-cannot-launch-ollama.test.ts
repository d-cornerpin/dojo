// ════════════════════════════════════════════════════════════════════════════
// A PROBE THAT ASKS WHETHER OLLAMA IS THERE MUST NOT BE ABLE TO START IT.
//
// ── THE INCIDENT ────────────────────────────────────────────────────────────
// Two migration probes answered "which models does this box have?" by shelling
// out: `execSync('ollama list')`, in `manifest.ts` (the export inventory) and
// `checks.ts` (the post-migration wizard). On macOS the `ollama` CLI AUTO-LAUNCHES
// Ollama.app when nothing is listening on 11434 — so a probe whose entire job was
// to ASK a question was able to ANSWER it by starting a daemon, and that daemon
// inherited the environment of whoever asked.
//
// That is not hypothetical. During ritual round 9 a vitest worker running under a
// sandboxed HOME (`run-53015-mubwi8rk/w17`) launched Ollama.app with the test HOME,
// and the real box was then served an EMPTY model store until the app was restarted
// by hand — which is the same outage that produced the 102 embedding ERRORs that
// stopped the release.
//
// ── WHAT THIS FILE PINS ─────────────────────────────────────────────────────
// The MECHANISM, not the wording: an HTTP GET cannot spawn anything, so the probe
// must reach the daemon over HTTP and must never invoke the `ollama` binary. Each
// case fails if the CLI call is planted back.
//
// The distinction being held, deliberately: `checkCommandExists('ollama')` in
// checks.ts NAMES the binary as an argument to `which` and is untouched. A PATH
// lookup cannot launch an app, and "is it installed" is a different question from
// "is it running" — collapsing them would have changed the wizard's meaning.
// ════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExportManifest } from '../manifest.js';

const spawned = vi.hoisted(() => ({ commands: [] as string[] }));

// Records every child process the code under test starts, refuses the one shape
// this file exists to forbid, and otherwise behaves exactly like the real thing.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const guarded = (cmd: string, opts?: unknown): unknown => {
    spawned.commands.push(cmd);
    if (/^\s*ollama\b/.test(cmd)) {
      throw new Error(`TEST GUARD: the ollama BINARY was invoked (\`${cmd}\`) — that is the auto-launch this probe must never do`);
    }
    // `which ollama` is answered here rather than from the box, so the wizard's
    // "installed" branch is exercised on a machine with or without Ollama.
    if (/^\s*which\s+ollama\s*$/.test(cmd)) return '/usr/local/bin/ollama\n';
    return actual.execSync(cmd, opts as never);
  };
  return { ...actual, default: actual, execSync: guarded };
});

vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {} }));

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_DIR = path.resolve(HERE, '..');
const TAGS_URL = 'http://localhost:11434/api/tags';
const INSTALLED = ['nomic-embed-text:latest', 'qwen3:8b'];

const realFetch = globalThis.fetch;

function tagsResponder(models: string[]): ReturnType<typeof vi.fn> {
  return vi.fn(async (url: unknown) => {
    if (!String(url).includes('/api/tags')) throw new Error(`unexpected fetch: ${String(url)}`);
    return new Response(JSON.stringify({ models: models.map(name => ({ name, size: 1 })) }), { status: 200 });
  });
}

function baseManifest(overrides: Partial<ExportManifest['contents']> = {}): ExportManifest {
  return {
    version: '1.0',
    platform_version: '0.0.0',
    exported_at: new Date().toISOString(),
    exported_from: {
      hostname: 'h', username: 'u', home_directory: '/tmp',
      os_version: 'macOS 15', node_version: process.version,
    },
    contents: {
      database: true, database_size_bytes: 1, prompts: [], techniques_count: 0, techniques: [],
      vault_entries_count: 0, agents_count: 0, agents: [],
      google_workspace_connected: false, google_workspace_email: null,
      microsoft_connected: false, imessage_configured: false,
      ollama_models: [], providers: [], uploads_size_bytes: 0,
      cloudflare_named_tunnel: false,
      ...overrides,
    },
    encryption: 'aes-256-cbc',
    checksum: '',
  };
}

beforeAll(async () => {
  const { runMigrations } = await import('../../db/migrations.js');
  runMigrations();
});

beforeEach(() => { spawned.commands.length = 0; });
afterEach(() => { globalThis.fetch = realFetch; });

describe('the mechanism: no migration module runs the ollama binary', () => {
  it('nothing under src/migration starts a child process whose command IS `ollama`', () => {
    const offenders: string[] = [];
    for (const name of fs.readdirSync(MIGRATION_DIR)) {
      if (!name.endsWith('.ts')) continue;
      const src = fs.readFileSync(path.join(MIGRATION_DIR, name), 'utf-8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      const call = /\b(exec|execSync|execFile|execFileSync|spawn|spawnSync)\s*\(\s*(['"`])([^'"`]*)\2/g;
      for (let m = call.exec(src); m !== null; m = call.exec(src)) {
        const commandWord = m[3].trim().split(/\s+/)[0];
        if (commandWord === 'ollama') offenders.push(`${name}: ${m[1]}('${m[3]}')`);
      }
    }
    expect(
      offenders,
      'the ollama CLI auto-launches Ollama.app when the daemon is down — a probe may not be able to start what it is asking about',
    ).toEqual([]);
  });
});

describe('the export manifest reads the model list over HTTP', () => {
  it('the inventory comes from /api/tags, and no ollama process is started', async () => {
    const fetchStub = tagsResponder(INSTALLED);
    globalThis.fetch = fetchStub as unknown as typeof fetch;

    const { generateManifest } = await import('../manifest.js');
    const manifest = await generateManifest(1234, [], [], 0);

    expect(manifest.contents.ollama_models).toEqual(INSTALLED);
    expect(fetchStub.mock.calls[0][0]).toBe(TAGS_URL);
    expect(spawned.commands.filter(c => /^\s*ollama\b/.test(c))).toEqual([]);
  });

  it('a daemon that is down answers honestly — no models, no throw, no spawn', async () => {
    globalThis.fetch = vi.fn(async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;

    const { generateManifest } = await import('../manifest.js');
    const manifest = await generateManifest(1234, [], [], 0);

    expect(manifest.contents.ollama_models).toEqual([]);
    expect(spawned.commands.filter(c => /^\s*ollama\b/.test(c))).toEqual([]);
  });
});

describe('the post-migration wizard reads the model list over HTTP', () => {
  it('a model the box already has is marked Downloaded, from /api/tags', async () => {
    const fetchStub = tagsResponder(INSTALLED);
    globalThis.fetch = fetchStub as unknown as typeof fetch;

    const { runPostMigrationChecks } = await import('../checks.js');
    const checks = await runPostMigrationChecks(baseManifest({ ollama_models: ['nomic-embed-text:latest', 'absent-model:latest'] }));

    expect(checks.find(c => c.id === 'ollama-model-nomic-embed-text:latest')?.status).toBe('ok');
    expect(checks.find(c => c.id === 'ollama-model-absent-model:latest')?.status).toBe('action_needed');
    expect(fetchStub).toHaveBeenCalled();
    expect(spawned.commands.filter(c => /^\s*ollama\b/.test(c))).toEqual([]);
    // The PATH lookup is deliberately still here: it names the binary, never runs it.
    expect(spawned.commands).toContain('which ollama');
  });

  it('with the daemon down every declared model reads as needing download, not as installed', async () => {
    globalThis.fetch = vi.fn(async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;

    const { runPostMigrationChecks } = await import('../checks.js');
    const checks = await runPostMigrationChecks(baseManifest({ ollama_models: ['nomic-embed-text:latest'] }));

    expect(checks.find(c => c.id === 'ollama-model-nomic-embed-text:latest')?.status).toBe('action_needed');
    expect(spawned.commands.filter(c => /^\s*ollama\b/.test(c))).toEqual([]);
  });
});
