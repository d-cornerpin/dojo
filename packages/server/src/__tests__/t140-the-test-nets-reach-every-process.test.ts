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

/** Run `code` in a fresh Node process the way a test would start one, with the fake CLI alone on PATH. */
function grandchild(code: string): string {
  const out = childProcess.spawnSync(process.execPath, ['-e', code], {
    env: { ...process.env, PATH: scratch, T140_MARKER: marker },
    encoding: 'utf8',
    timeout: 20_000,
  });
  return `${out.stdout ?? ''}${out.stderr ?? ''}`;
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
  it('a process a test starts cannot start the CLI either', () => {
    fs.rmSync(marker, { force: true });
    const said = grandchild(`
      try { require('child_process').spawnSync('claude', ['--version'], { env: process.env }); process.stdout.write('NOT-STOPPED'); }
      catch (e) { process.stdout.write(String(e && e.message)); }
    `);
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
