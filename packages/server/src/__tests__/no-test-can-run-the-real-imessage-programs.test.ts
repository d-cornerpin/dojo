// ════════════════════════════════════════════════════════════════════════════════════════
// v3.5 E19b — NO TEST CAN RUN THE REAL `imsg` OR `osascript`.
//
// A real `imsg send` (or a Messages AppleScript) texts a real phone, and the developer box has
// both installed. Until now nothing but each test file's own `child_process` mock stood between
// the suite and that phone; a mock that missed a call (a send path turned async, a new door)
// would have sent for real. The nets (`vitest.test-nets.cjs`) now refuse, loudly and by name,
// any call that would start the real program — in the worker and in every process it starts.
// A test stubs the transport, or plants its own stand-in in a scratch directory.
//
// Every attempt planted below is harmless even if the net were missing: `imsg --help` and
// `osascript -e 'return 1'` drive nothing. Even so, no clause executes anything until it has
// checked that the net is loaded (`theNetIsIn`), so a RED run on a tree without the net fails
// on that check and starts no program at all.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const NET = /TEST NET: a test tried to run the real iMessage program/;

const nets = createRequire(import.meta.url)('../../vitest.test-nets.cjs') as { MESSAGES_NET_MESSAGE?: string };
/** Asserted FIRST in every clause: without the net, nothing below may execute. */
const theNetIsIn = (): void => { expect(nets.MESSAGES_NET_MESSAGE, 'the iMessage net is loaded').toMatch(NET); };

type Call = (...a: unknown[]) => unknown;
const cp = childProcess as unknown as Record<string, Call>;

let scratch = '';
beforeAll(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'e19b-stand-in-'));
  for (const name of ['imsg', 'osascript']) {
    fs.writeFileSync(path.join(scratch, name), '#!/bin/sh\necho stand-in\n', { mode: 0o755 });
  }
});
afterAll(() => { fs.rmSync(scratch, { recursive: true, force: true }); });

describe('E19b — the real iMessage programs cannot be started from a test', () => {
  it.each([
    ['execFileSync', ['/usr/bin/osascript', ['-e', 'return 1']]],
    ['execFileSync', ['/opt/homebrew/bin/imsg', ['--help']]],
    ['spawnSync', ['imsg', ['--help']]],
    ['spawnSync', ['OSASCRIPT', ['-e', 'return 1']]],
    ['execSync', ["osascript -e 'return 1'"]],
    ['execSync', ['true && imsg --help']],
    ['spawnSync', ['/bin/sh', ['-c', 'osascript -e "return 1"']]],
    ['spawnSync', ['env', ['FOO=1', 'imsg', '--help']]],
    ['spawnSync', ['osascript', ['-e', 'return 1'], { shell: true }]],
    ['spawnSync', ['/bin/sh', ['-c', 'echo $(/usr/bin/osascript -e "return 1")']]],
  ] as const)('child_process.%s(%j) is refused by name', (fn, args) => {
    theNetIsIn();
    expect(() => cp[fn](...(args as readonly unknown[]))).toThrow(NET);
  });

  it('the async doors refuse too (spawn and execFile throw before anything starts)', () => {
    theNetIsIn();
    expect(() => cp.spawn('/opt/homebrew/bin/imsg', ['--help'])).toThrow(NET);
    expect(() => cp.execFile('osascript', ['-e', 'return 1'], () => undefined)).toThrow(NET);
  });

  it('a shell that resolves the name in a way no parser sees runs the net\'s stand-in, which refuses', () => {
    theNetIsIn();
    const ran = childProcess.spawnSync('/bin/sh', ['-c', 'echo "[$(osascript -e "return 1")]"'], { encoding: 'utf8' });
    expect(ran.stdout.trim(), 'the real osascript answered').toBe('[]');
    expect(ran.stderr).toMatch(NET);
  });

  it('a Node process a test starts carries the net', () => {
    theNetIsIn();
    const ran = childProcess.spawnSync(process.execPath, ['-e',
      "require('node:child_process').execFileSync('/usr/bin/osascript', ['-e', 'return 1'])"], { encoding: 'utf8' });
    expect(ran.status).not.toBe(0);
    expect(ran.stderr).toMatch(NET);
  });

  it('a stand-in planted in a scratch directory still runs — tests can stub the program', () => {
    theNetIsIn();
    expect(String(childProcess.execFileSync(path.join(scratch, 'imsg'), ['--help'])).trim()).toBe('stand-in');
    const before = process.env.PATH;
    process.env.PATH = `${scratch}:${before ?? ''}`;
    try {
      expect(String(childProcess.execFileSync('osascript', ['-e', 'return 1'])).trim()).toBe('stand-in');
    } finally { process.env.PATH = before; }
  });

  it('a whole environment handed to a child gets the net\'s stand-in first, so a name it resolves is refused', () => {
    theNetIsIn();
    const env = { ...process.env, PATH: `/usr/bin:/bin:${process.env.PATH ?? ''}` };
    expect(() => childProcess.execFileSync('osascript', ['-e', 'return 1'], { env })).toThrow(NET);
  });
});
