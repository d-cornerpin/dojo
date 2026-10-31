// ════════════════════════════════════════════════════════════════════════════════
// WHAT AN UPDATE KILLED MID-FLIGHT LEAVES, AND WHAT MUST NOT SURVIVE IT.
//
// An update copies the live `node_modules` into a `platform.staging-*` work dir, and it writes
// the update record through a temp file that it then renames over the record. A kill in either
// window used to leave both behind: the copy's `cp` child outlived the parent and kept writing
// into the staging tree, the start-up clean-up deleted that tree under the live writer, the
// delete failed once — and nothing ever asked again. The folder then sat beside a live install
// forever, and every marker write that died between its temp write and its rename left another
// temp file next to the record.
//
// Tested here: the clean-up removes every leftover it finds on EVERY start (case 1); an item it
// could not remove gets its own log line and is simply retried at the next start (case 2); the
// live platform folder and the update record itself are never touched (case 1, again); and the
// copy child starts inside a process group that is killed when the server ends, so the orphan
// that started the whole chain cannot exist (case 3).
//
// The install root is a throwaway temporary folder of fake paths — never the real install.
// ════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

// The recorder: every swept-away failure must reach a log line the test can see.
const logLines: Array<{ level: string; msg: string; meta?: Record<string, unknown> }> = [];
vi.mock('../../../logger.js', () => {
  const rec = (level: string) => (msg: string, meta?: Record<string, unknown>) => { logLines.push({ level, msg, meta }); };
  return {
    createLogger: () => ({ debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error') }),
    setLogLevel: () => {}, setLogBroadcast: () => {}, readLogEntries: () => [],
  };
});

// Every child process this graph starts during the test is a fake. The copy child closes with
// code 0 the instant its listeners are attached, and reports a fixed pid so the group the test
// expects on the parent's `exit` hook is a number it can name.
const cpMocks = vi.hoisted(() => ({ spawn: vi.fn(), execFile: vi.fn(), exec: vi.fn() }));
const FAKE_CP_PID = 41111;
vi.mock('node:child_process', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:child_process')>();
  return {
    ...orig,
    default: { ...orig, spawn: cpMocks.spawn, execFile: cpMocks.execFile, exec: cpMocks.exec },
    spawn: cpMocks.spawn,
    execFile: cpMocks.execFile,
    exec: cpMocks.exec,
  };
});

function fakeCopyChild(): EventEmitter {
  const child = new EventEmitter() as EventEmitter & { pid: number; stdout: PassThrough; stderr: PassThrough };
  child.pid = FAKE_CP_PID;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  setImmediate(() => child.emit('close', 0, null));
  return child;
}

// The real imports sit below the mocks: the factories above close over these consts.
import { cleanUpdateLeftovers } from '../update.js';
import { installPlatformTree } from '../../../update/install-tree.js';

let box: string | null = null;
/** A temporary install root: `<tmp>/…/.dojo` is the fake `~/.dojo`. */
function makeBox(tag: string): string {
  box = fs.mkdtempSync(path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), `dojo-killed-update-${tag}-`));
  const dojo = path.join(box, '.dojo');
  fs.mkdirSync(dojo, { recursive: true });
  return dojo;
}

beforeEach(() => {
  logLines.length = 0;
  cpMocks.spawn.mockReset().mockImplementation(() => fakeCopyChild());
  cpMocks.execFile.mockReset().mockImplementation((...args: unknown[]) => {
    const cb = args[args.length - 1] as (err: unknown, stdout?: string, stderr?: string) => void;
    cb(null, '', '');
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  if (box) fs.rmSync(box, { recursive: true, force: true });
  box = null;
});

describe('a killed update leaves nothing behind', () => {
  it('clears every leftover staging folder and record temp file, and touches nothing that is live', async () => {
    const dojo = makeBox('sweep');
    fs.mkdirSync(path.join(dojo, 'platform.staging-abc-1'), { recursive: true });
    fs.writeFileSync(path.join(dojo, 'platform.staging-abc-1', 'partial-copy.txt'), 'half a node_modules');
    fs.mkdirSync(path.join(dojo, 'platform.staging-abc-2', 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(dojo, 'platform.staging-abc-2', 'node_modules', 'left.js'), '');
    fs.writeFileSync(path.join(dojo, 'update-state.json.123.a.tmp'), '{ "phase": "pe');
    fs.writeFileSync(path.join(dojo, 'update-state.json.456.b.tmp'), '{ "phase": "pe');
    fs.writeFileSync(path.join(dojo, 'update-state.json'), JSON.stringify({ phase: 'idle' }));
    fs.writeFileSync(path.join(dojo, 'update-state.json.lock'), String(process.pid));
    fs.mkdirSync(path.join(dojo, 'platform', 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(dojo, 'platform', 'node_modules', 'live.js'), 'the live tree');

    const res = await cleanUpdateLeftovers(dojo);

    expect(res.failed).toEqual([]);
    expect(fs.existsSync(path.join(dojo, 'platform.staging-abc-1'))).toBe(false);
    expect(fs.existsSync(path.join(dojo, 'platform.staging-abc-2'))).toBe(false);
    expect(fs.existsSync(path.join(dojo, 'update-state.json.123.a.tmp'))).toBe(false);
    expect(fs.existsSync(path.join(dojo, 'update-state.json.456.b.tmp'))).toBe(false);
    // The record, its lock, and the live tree stay exactly as they were.
    expect(JSON.parse(fs.readFileSync(path.join(dojo, 'update-state.json'), 'utf8'))).toEqual({ phase: 'idle' });
    expect(fs.existsSync(path.join(dojo, 'update-state.json.lock'))).toBe(true);
    expect(fs.readFileSync(path.join(dojo, 'platform', 'node_modules', 'live.js'), 'utf8')).toBe('the live tree');
  });

  it('logs the one it could not remove, and the next start finishes it', async () => {
    const dojo = makeBox('retry');
    const doomed = path.join(dojo, 'platform.staging-abc-2');
    fs.mkdirSync(path.join(dojo, 'platform.staging-abc-1'), { recursive: true });
    fs.mkdirSync(doomed, { recursive: true });
    fs.writeFileSync(path.join(doomed, 'busy.txt'), 'still being written by an orphan');

    // One refusal, for that one folder only — the delete that failed once and, before the fix,
    // was never tried again.
    const realRm = fs.rm.bind(fs);
    let refusedOnce = false;
    vi.spyOn(fs, 'rm').mockImplementation(((target: unknown, opts?: unknown, cb?: unknown) => {
      if (!refusedOnce && String(target) === doomed) {
        refusedOnce = true;
        const busy = Object.assign(new Error(`ENOTEMPTY: directory not empty, rm '${String(target)}'`), { code: 'ENOTEMPTY' });
        if (typeof cb === 'function') { (cb as (e: unknown) => void)(busy); return undefined; }
        return Promise.reject(busy);
      }
      return (realRm as (...a: unknown[]) => unknown)(target, opts, cb);
    }) as unknown as typeof fs.rm);

    const first = await cleanUpdateLeftovers(dojo);
    expect(fs.existsSync(doomed)).toBe(true);
    expect(first.deleted).toEqual(['platform.staging-abc-1']);
    expect(first.failed).toEqual(['platform.staging-abc-2']);
    const complaints = logLines.filter((l) => l.level === 'warn' && JSON.stringify(l.meta).includes('platform.staging-abc-2'));
    expect(complaints).toHaveLength(1);

    // The next start: same sweep, nothing mocked this time. The folder goes.
    const second = await cleanUpdateLeftovers(dojo);
    expect(fs.existsSync(doomed)).toBe(false);
    expect(second.failed).toEqual([]);
  });

  it('starts the copy so that it dies with the server', async () => {
    const dojo = makeBox('child');
    const live = path.join(dojo, 'platform');
    fs.mkdirSync(path.join(live, 'node_modules', 'some-dep'), { recursive: true });
    fs.writeFileSync(path.join(live, 'package.json'), JSON.stringify({ version: '2.0.0' }));
    fs.writeFileSync(path.join(live, 'node_modules', 'some-dep', 'index.js'), '');
    const staged = path.join(dojo, 'platform.staging-abc-9');
    fs.mkdirSync(path.join(staged, 'packages', 'server', 'dist'), { recursive: true });
    fs.writeFileSync(path.join(staged, 'package.json'), JSON.stringify({ version: '3.0.0' }));
    fs.writeFileSync(path.join(staged, 'packages', 'server', 'dist', 'index.js'), '');

    // Watch the `exit` hooks the install registers while it runs, and keep the real
    // registration so a hook that outlived its child would still show in the count below.
    const exitHooks: Array<() => void> = [];
    const realOnce = process.once as unknown as (ev: string, cb: () => void) => void;
    const onceSpy = vi.spyOn(process, 'once').mockImplementation(((ev: unknown, cb: () => void) => {
      if (ev === 'exit') exitHooks.push(cb);
      realOnce.call(process, ev as string, cb);
      return process;
    }) as unknown as typeof process.once);
    const exitBaseline = process.listenerCount('exit');

    const res = await installPlatformTree({
      dojoDir: dojo,
      stagedDir: staged,
      targetVersion: '3.0.0',
      previousVersion: '2.0.0',
      runInstall: async () => {},
    });
    expect(res.ok).toBe(true);

    // The copy ran as a child of its own process group, so a kill of the group takes it down.
    const copies = cpMocks.spawn.mock.calls.filter((c) => c[0] === 'cp');
    expect(copies.length).toBeGreaterThan(0);
    expect(copies[0][1]).toEqual(['-Rc', path.join(live, 'node_modules'), path.join(staged, 'node_modules')]);
    expect(copies[0][2]).toEqual(expect.objectContaining({ detached: true }));

    // A child that already closed must not leave its hook behind.
    expect(process.listenerCount('exit')).toBe(exitBaseline);
    onceSpy.mockRestore();

    // And the hook the parent registered while the copy ran kills the copy's whole GROUP —
    // a negative pid is how a group is named — so the orphan can never outlive the server.
    expect(exitHooks.length).toBeGreaterThan(0);
    // Assert BEFORE restoring: `mockRestore` clears the recorded calls along with the
    // implementation, so a restore-first would blind the assertion below it.
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    for (const hook of exitHooks) hook();
    expect(killSpy).toHaveBeenCalledWith(-FAKE_CP_PID, 'SIGKILL');
    killSpy.mockRestore();
  });
});
