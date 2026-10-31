// rollback.sh: a TERM during "Starting services" or during the --heal unload must not leave a service
// unloaded, and --heal must not say "Finished" when launchd did not load the platform.
// The REAL script runs against a scratch HOME with a STATEFUL stub `launchctl`: load/unload keep one
// marker file per label, `list` prints the loaded ones. No real launchd is reached.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..'), 'deploy/scripts/rollback.sh');
let home: string; let dojo: string; let bin: string; let state: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'rb-signal-'));
  dojo = path.join(home, '.dojo'); bin = path.join(home, 'bin'); state = path.join(home, 'ls');
  fs.mkdirSync(path.join(home, 'Library', 'LaunchAgents'), { recursive: true });
  fs.mkdirSync(dojo, { recursive: true }); fs.mkdirSync(bin); fs.mkdirSync(state);
  for (const s of ['platform', 'watchdog']) {
    fs.writeFileSync(path.join(home, 'Library', 'LaunchAgents', `com.dojo.${s}.plist`), '');
    fs.writeFileSync(path.join(state, s), '');
  }
});
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

/** `blockOn`: the first call of that verb sleeps 2s (so a signal can land in it). `refuseLoad`: load never takes. */
function stubLaunchctl(blockOn: 'load' | 'unload' | null, refuseLoad = false): void {
  fs.writeFileSync(path.join(bin, 'launchctl'), [
    '#!/bin/bash',
    `S="${state}"`,
    'lab() { b="${1##*/}"; b="${b%.plist}"; echo "${b##*.}"; }',
    'case "$1" in',
    '  list) for l in "$S"/*; do [ -e "$l" ] && printf "1\\t0\\tcom.dojo.%s\\n" "$(basename "$l")"; done; exit 0 ;;',
    `  ${blockOn ?? 'none'}) if [ ! -e "${home}/blocked" ]; then touch "${home}/blocked"; touch "${home}/block.started"; sleep 2; fi ;;`,
    'esac',
    'case "$1" in',
    '  unload) rm -f "$S/$(lab "$2")" ;;',
    `  load) ${refuseLoad ? ':' : 'touch "$S/$(lab "$2")"'} ;;`,
    'esac',
    'exit 0', '',
  ].join('\n'), { mode: 0o755 });
}

function makeBuild(dir: string, version: string): void {
  fs.mkdirSync(path.join(dir, 'packages', 'server', 'dist'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'dojo-platform', version }));
  fs.writeFileSync(path.join(dir, 'packages', 'server', 'dist', 'index.js'), '// build\n');
}
const env = (): NodeJS.ProcessEnv => ({ ...process.env, HOME: home, DOJO_HOME: home, PATH: `${bin}:${process.env.PATH ?? ''}` });
const loaded = (s: string): boolean => fs.existsSync(path.join(state, s));

async function termDuringBlock(args: string[]): Promise<void> {
  const child = spawn('bash', [SCRIPT, ...args], { env: env(), stdio: 'ignore', detached: true });
  const closed = new Promise<void>((r) => child.on('close', () => r()));
  for (let i = 0; i < 250 && !fs.existsSync(path.join(home, 'block.started')); i++) await new Promise((r) => setTimeout(r, 20));
  expect(fs.existsSync(path.join(home, 'block.started'))).toBe(true);
  process.kill(child.pid!, 'SIGTERM');
  await closed;
}

function pendingUpdate(): void {
  const staging = path.join(dojo, 'platform.staging-1-abc');
  makeBuild(staging, '3.2.0');
  fs.writeFileSync(path.join(dojo, 'update-state.json'),
    JSON.stringify({ phase: 'pending-update', stagingDir: staging, targetVersion: '3.2.0' }));
}

describe('rollback.sh never leaves a service unloaded', () => {
  it('a TERM during the first load of "Starting services" still ends with both services listed', async () => {
    makeBuild(path.join(dojo, 'platform'), '3.1.18');
    makeBuild(path.join(dojo, 'platform.backup-3.1.17'), '3.1.17');
    // Block the first `load` only: the unloads before it run normally.
    stubLaunchctl('load');
    await termDuringBlock([]);
    expect(loaded('platform')).toBe(true);
    expect(loaded('watchdog')).toBe(true);
  });

  it('--heal: a TERM during its unload still ends with both services listed', async () => {
    pendingUpdate();
    stubLaunchctl('unload');
    await termDuringBlock(['--heal']);
    expect(loaded('platform')).toBe(true);
    expect(loaded('watchdog')).toBe(true);
  });

  it('--heal: a load launchd does not take is not reported as finished, and exits 1', () => {
    pendingUpdate();
    stubLaunchctl(null, true);
    const r = spawnSync('bash', [SCRIPT, '--heal'], { env: env(), encoding: 'utf-8' });
    const out = `${r.stdout}${r.stderr}`;
    expect(r.status).toBe(1);
    expect(out).not.toContain('Finished installing');
    expect(out).toContain('did not start');
  });

  it('--heal: with both services listed it finishes and exits 0', () => {
    pendingUpdate();
    stubLaunchctl(null);
    const r = spawnSync('bash', [SCRIPT, '--heal'], { env: env(), encoding: 'utf-8' });
    expect(r.status).toBe(0);
    expect(`${r.stdout}${r.stderr}`).toContain('Finished installing 3.2.0');
    expect(JSON.parse(fs.readFileSync(path.join(dojo, 'platform', 'package.json'), 'utf-8')).version).toBe('3.2.0');
  });
});
