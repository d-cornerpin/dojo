// start.sh hid the result of both `launchctl load` calls with `2>/dev/null` and then, whenever the
// plist files existed, printed "✅ Services started" and the dashboard address no matter what launchd
// did. A person following the restore instructions whose launchd refused the job (bad plist, a
// permission problem) was told Dojo was starting and waited for a dashboard that never came. The
// check is now "is each label listed by launchctl list" — which also counts an already-loaded job
// as a success, instead of the exit code of `load`.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../deploy/scripts/start.sh');
let home = '';
let binDir = '';

beforeEach(() => {
  home = fs.mkdtempSync(path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'start-sh-'));
  binDir = path.join(home, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const launch = path.join(home, 'Library', 'LaunchAgents');
  fs.mkdirSync(launch, { recursive: true });
  fs.writeFileSync(path.join(launch, 'com.dojo.platform.plist'), '');
  fs.writeFileSync(path.join(launch, 'com.dojo.watchdog.plist'), '');
});

afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

/**
 * A stub `launchctl` first on PATH: `load` appends the plist's file name to `home/loaded.txt` (the
 * body decides when launchd refuses), `list` prints one line per label whose name loaded.txt mentions.
 */
function stubLaunchctl(load: string): void {
  const list =
    `grep -q 'com.dojo.platform.plist' "$HOME/loaded.txt" 2>/dev/null && printf '123\\t0\\tcom.dojo.platform\\n'\n` +
    `    grep -q 'com.dojo.watchdog.plist' "$HOME/loaded.txt" 2>/dev/null && printf '%s\\t%s\\tcom.dojo.watchdog\\n' '-' 0`;
  fs.writeFileSync(
    path.join(binDir, 'launchctl'),
    `#!/bin/bash\ncase "$1" in\n  load) ${load} ;;\n  list)\n    ${list}\n  ;;\nesac\nexit 0\n`,
    { mode: 0o755 },
  );
}

/** `load` records the plist, unless the `refuse` file says launchd turned it down. */
const RECORDING_LOAD = '[[ -e "$HOME/refuse" ]] && exit 1; basename "$2" >> "$HOME/loaded.txt"';

function runStart(): { status: number | null; out: string } {
  const r = spawnSync('/bin/bash', [SCRIPT], {
    env: { PATH: `${binDir}:${process.env.PATH ?? ''}`, HOME: home },
    encoding: 'utf-8',
    timeout: 20_000,
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

describe('start.sh reports only what launchd loaded', () => {
  it('says services started, and exits 0, when launchd takes both plists', () => {
    stubLaunchctl(RECORDING_LOAD);
    const { status, out } = runStart();
    expect(status).toBe(0);
    expect(out).toContain('Services started');
  });

  it('says launchd did not load either one, and exits 1, when launchd refuses both', () => {
    stubLaunchctl(RECORDING_LOAD);
    fs.writeFileSync(path.join(home, 'refuse'), '');
    const { status, out } = runStart();
    expect(status).toBe(1);
    expect(out).toContain('did not load the platform and the watchdog');
    expect(out).not.toContain('Services started');
  });

  it('names only the watchdog when only the platform loads', () => {
    stubLaunchctl('[[ "$2" == *watchdog* ]] || basename "$2" >> "$HOME/loaded.txt"');
    const { status, out } = runStart();
    expect(status).toBe(1);
    expect(out).toContain('did not load the watchdog');
  });

  it('exits 0 when launchd already had both jobs loaded before the run', () => {
    fs.writeFileSync(path.join(home, 'loaded.txt'), 'com.dojo.platform.plist\ncom.dojo.watchdog.plist\n');
    stubLaunchctl(':');
    const { status, out } = runStart();
    expect(status).toBe(0);
    expect(out).toContain('Services started');
  });

  it('still says plists not found, and exits 1, when the plists are missing', () => {
    stubLaunchctl(RECORDING_LOAD);
    fs.rmSync(path.join(home, 'Library', 'LaunchAgents', 'com.dojo.platform.plist'));
    fs.rmSync(path.join(home, 'Library', 'LaunchAgents', 'com.dojo.watchdog.plist'));
    const { status, out } = runStart();
    expect(status).toBe(1);
    expect(out).toContain('plists not found');
  });
});
