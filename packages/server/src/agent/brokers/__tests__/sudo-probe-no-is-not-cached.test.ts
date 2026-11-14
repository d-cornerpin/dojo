// ════════════════════════════════════════════════════════════════════════════════════════
// A "NO" IS NEVER CACHED — the probe answers again on every sudo line.
//
// `sudo -n true` answers "no" when this box has no NOPASSWD rule, and the probe caches that
// answer for the life of the process. The message that answer produces tells a HUMAN to run one
// line that grants passwordless sudo — but after the owner does exactly that, the cached "no"
// keeps every later sudo line refused with the same "wants a password" text, and nothing clears
// it short of a server restart the message never mentions. Only a "yes" is cached; a "no" is
// re-asked the next time a sudo line arrives, which costs one short `sudo -n true` only on a box
// that is refusing sudo anyway.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, vi } from 'vitest';

/** Which agent id counts as the primary. The role wall reads this. */
const PRIMARY = 'primary-agent';

vi.mock('../../../config/platform.js', async (orig) => ({
  ...(await orig<typeof import('../../../config/platform.js')>()),
  isPrimaryAgent: (id: string) => id === PRIMARY,
}));

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));

import { execFile } from 'node:child_process';
import { sudoWouldHang, resetSudoProbeCache } from '../sudo-probe.js';

const execFileMock = vi.mocked(execFile);

/** Drive the `sudo -n true` callback. The first call answers "no", later calls succeed. */
function setProbeResults() {
  let calls = 0;
  execFileMock.mockImplementation((_file, _args, _opts, cb) => {
    calls += 1;
    if (calls === 1) cb(new Error('password required'));
    else cb(null);
    return { on: vi.fn() } as unknown as ReturnType<typeof execFile>;
  });
}

describe('sudo-probe — a "no" is never cached', () => {
  beforeEach(() => {
    execFileMock.mockReset();
    resetSudoProbeCache();
  });

  it('first call on a box that refuses sudo returns the password message', async () => {
    setProbeResults();
    const result = await sudoWouldHang('sudo ls');
    expect(result).toContain('wants a password');
  });

  it('a "no" is re-asked: once the box accepts, the next sudo line carries on', async () => {
    setProbeResults();
    await sudoWouldHang('sudo ls');
    expect(await sudoWouldHang('sudo ls')).toBeNull();
  });

  it('a "yes" IS cached: the third call carries on and the probe ran exactly twice', async () => {
    setProbeResults();
    await sudoWouldHang('sudo ls');
    await sudoWouldHang('sudo ls');
    expect(await sudoWouldHang('sudo ls')).toBeNull();
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it('a non-sudo line never probes at all', async () => {
    setProbeResults();
    expect(await sudoWouldHang('ls -la')).toBeNull();
    expect(execFileMock).not.toHaveBeenCalled();
  });
});
