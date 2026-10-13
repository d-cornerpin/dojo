// ════════════════════════════════════════════════════════════════════════════════════════
// t140 round 5 — THE TEST NETS: NARROW WHERE THEY WERE TOO WIDE, AND REACHING EVERY PROCESS.
//
// Round 3 recorded three gaps in the nets `vitest.setup.ts` lays (t140 round 2):
//   1. THE CLI NET MATCHED TEXT, NOT THE PROGRAM. It refused any command line with the word
//      `claude` standing alone (`echo claude`), and on a case-insensitive disk it let `Claude`
//      through. It now asks what program is being started: the executable's own name, any case.
//   2. THE NETS STOPPED AT THE WORKER. A process a test starts (a `node -e`, a `tsx` script)
//      inherited only the scrubbed environment; nothing stopped it starting the CLI. The nets now
//      ride into every Node process the suite starts.
//   3. THERE WAS NO NETWORK NET. "Nothing reached the network" was observed, never enforced. An
//      outbound connection to anything but this machine is now refused, loudly, in the worker and
//      in every Node process it starts.
//
// ⚠ THIS BOX HAS THE REAL CLI ON ITS PATH. Every clause that plants a CLI start uses a FAKE `claude`
// in a scratch directory with a PATH of that directory alone; the fake only writes a marker file.
// A red run therefore shows the marker, never a real launch.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const CLI_NET = /TEST NET: a test tried to start the real Claude CLI/;
const NETWORK_NET = /TEST NET: a test tried to reach the network/;

let scratch = '';
let marker = '';
beforeAll(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 't140-nets-'));
  marker = path.join(scratch, 'launched');
  for (const name of ['claude', 'Claude']) {
    const fake = path.join(scratch, name);
    if (!fs.existsSync(fake)) fs.writeFileSync(fake, '#!/bin/sh\necho launched > "$T140_MARKER"\n', { mode: 0o755 });
  }
});
afterAll(() => { fs.rmSync(scratch, { recursive: true, force: true }); });

/**
 * Run `code` in a fresh Node process the way a test would start one, with the fake CLI alone on PATH.
 * `env`: 'copied' — the test's environment, copied and amended; 'fresh' — an environment built from
 * nothing (no NODE_OPTIONS of its own); 'inherited' — no env option at all, the process's own.
 */
function grandchild(code: string, env: 'copied' | 'fresh' | 'inherited' = 'copied'): string {
  const saved = { PATH: process.env.PATH, T140_MARKER: process.env.T140_MARKER };
  if (env === 'inherited') { process.env.PATH = scratch; process.env.T140_MARKER = marker; }
  try {
    const out = childProcess.spawnSync(process.execPath, ['-e', code], {
      ...(env === 'copied' ? { env: { ...process.env, PATH: scratch, T140_MARKER: marker } } : {}),
      ...(env === 'fresh' ? { env: { PATH: scratch, T140_MARKER: marker } } : {}),
      encoding: 'utf8',
      timeout: 20_000,
    });
    return `${out.stdout ?? ''}${out.stderr ?? ''}`;
  } finally {
    process.env.PATH = saved.PATH;
    if (saved.T140_MARKER === undefined) delete process.env.T140_MARKER; else process.env.T140_MARKER = saved.T140_MARKER;
  }
}

describe('t140 round 5 — the CLI net asks what program is started, not what words are on the line', () => {
  it('an ordinary command whose ARGUMENT is the word claude runs', () => {
    expect(String(childProcess.execSync('echo claude')).trim()).toBe('claude');
  });

  it('the CLI under a different case is still refused, and nothing is launched', () => {
    fs.rmSync(marker, { force: true });
    expect(() => childProcess.spawnSync(path.join(scratch, 'Claude'), ['--version'], { env: { ...process.env, T140_MARKER: marker } })).toThrow(CLI_NET);
    expect(fs.existsSync(marker), 'the fake CLI ran').toBe(false);
  });
});

describe('t140 round 5 — the nets reach every Node process the suite starts', () => {
  it.each(['copied', 'fresh', 'inherited'] as const)('a process a test starts (its environment %s) cannot start the CLI either', (env) => {
    fs.rmSync(marker, { force: true });
    const said = grandchild(`
      try { require('child_process').spawnSync('claude', ['--version'], { env: process.env }); process.stdout.write('NOT-STOPPED'); }
      catch (e) { process.stdout.write(String(e && e.message)); }
    `, env);
    expect(said).toMatch(CLI_NET);
    expect(fs.existsSync(marker), 'the fake CLI ran from the grandchild').toBe(false);
  });
});

describe('t140 round 5 — the network net', () => {
  let server: http.Server;
  let port = 0;
  beforeAll(async () => {
    server = http.createServer((_req, res) => { res.end('ok'); });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    port = (server.address() as { port: number }).port;
  });
  afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

  it('an outbound connection to anything but this machine is refused at once, by name', async () => {
    const started = Date.now();
    let message = '';
    try {
      // TEST-NET-3 (RFC 5737): an address that is never anyone's server.
      await fetch('http://203.0.113.7:81/', { signal: AbortSignal.timeout(5_000) });
    } catch (e) {
      const err = e as Error & { cause?: Error };
      message = `${err.message} ${err.cause?.message ?? ''}`;
    }
    expect(message).toMatch(NETWORK_NET);
    expect(Date.now() - started, 'refused, not timed out').toBeLessThan(2_000);
  });

  it('…and from a process a test starts', () => {
    const said = grandchild(`
      fetch('http://203.0.113.7:81/', { signal: AbortSignal.timeout(5000) })
        .then(() => process.stdout.write('REACHED'))
        .catch((e) => process.stdout.write(String(e && e.message) + ' ' + String(e && e.cause && e.cause.message)));
    `);
    expect(said).toMatch(NETWORK_NET);
  });

  it('CONTROL — this machine is still reachable (a test\'s own local server)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(await res.text()).toBe('ok');
  });
});

// ── round 6 (final review M2, M3; ruling R-V333-15) ─────────────────────────────────────────
describe('t140 round 6 — the CLI net sees through wrappers, and the network net allows only literal loopback', () => {
  /** The fake first on PATH, the system directories after it (where `env` and `nohup` live). */
  const wrappedEnv = (): NodeJS.ProcessEnv => ({ ...process.env, PATH: `${scratch}:/usr/bin:/bin`, T140_MARKER: marker });

  it.each(['env claude --version', 'nohup claude --version', 'exec claude --version', '(claude --version)', 'env FOO=1 claude --version'])(
    'a shell line that starts the CLI through a wrapper — %s — is refused, and nothing is launched', (line) => {
      fs.rmSync(marker, { force: true });
      expect(() => childProcess.execSync(line, { env: wrappedEnv(), stdio: 'ignore' })).toThrow(CLI_NET);
      expect(fs.existsSync(marker), 'the fake CLI ran').toBe(false);
    });

  it('spawn(env, [claude]) is refused, and nothing is launched', () => {
    fs.rmSync(marker, { force: true });
    expect(() => childProcess.spawnSync('env', ['claude', '--version'], { env: wrappedEnv() })).toThrow(CLI_NET);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('…and an ordinary wrapped command still runs', () => {
    expect(String(childProcess.execSync('env echo claude', { env: wrappedEnv() })).trim()).toBe('claude');
  });

  it('the network net counts only literal loopback as this machine — not a hostname that starts with "127."', async () => {
    const { isThisMachine } = await import('../../vitest.test-nets.cjs') as unknown as { isThisMachine: (h: unknown) => boolean };
    for (const host of ['localhost', '127.0.0.1', '127.1.2.3', '::1', '[::1]', '::ffff:127.0.0.1', undefined]) {
      expect(isThisMachine(host), `${String(host)} is this machine`).toBe(true);
    }
    for (const host of ['127.example.com', '127.0.0.1.example.com', '10.0.0.1', '203.0.113.7', 'api.example.com']) {
      expect(isThisMachine(host), `${host} is not this machine`).toBe(false);
    }
  });
});

// ── round 7 (round-6 re-review minor net residue) ─────────────────────────────────────────────
// Parsing a command string cannot see what a shell runs once it is running: `sh -c claude`, a
// `$(…)`, an escaped name. The net now also puts a stand-in `claude` FIRST on every process's PATH
// (`vitest.test-nets.cjs`), so whatever a shell resolves by name is the stand-in, which refuses.
describe('t140 round 7 — whatever a shell resolves as "claude" is the net\'s stand-in', () => {
  /** The net's stand-in first (when there is one), then the fake, then the system directories. */
  const shellEnv = async (): Promise<NodeJS.ProcessEnv> => {
    // The net's stand-in when the net is in (the fake follows it), so a RED run starts only the fake.
    const standIn = path.resolve(__dirname, '../../test-net-stand-in');
    const netIn = (process.env.PATH ?? '').split(':')[0] === standIn;
    return { ...process.env, PATH: `${netIn ? `${standIn}:` : ''}${scratch}:/usr/bin:/bin`, T140_MARKER: marker };
  };

  it.each(['sh -c claude', 'bash -c "claude --version"', 'echo $(claude --version)', 'c\\laude --version'])(
    'a shell that starts the CLI in a way no parser sees — %s — runs the stand-in, which refuses; nothing is launched', async (line) => {
      fs.rmSync(marker, { force: true });
      const ran = childProcess.spawnSync('/bin/sh', ['-c', line], { env: await shellEnv(), encoding: 'utf8' });
      const said = `${ran.stderr ?? ''}${ran.error?.message ?? ''}`;
      expect(fs.existsSync(marker), 'the fake CLI ran').toBe(false);
      expect(said).toMatch(CLI_NET);
    });
});
