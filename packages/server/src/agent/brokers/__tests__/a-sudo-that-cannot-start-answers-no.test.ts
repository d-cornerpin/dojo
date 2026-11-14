// When sudo cannot even be started (the spawn throws, as EPERM does), the probe answers no: the agent gets
// the password message instead of a failed tool call.
import { describe, it, expect, vi } from 'vitest';

vi.mock('node:child_process', () => ({ execFile: vi.fn(() => { throw Object.assign(new Error('spawn EPERM'), { code: 'EPERM' }); }) }));

import { sudoWouldHang } from '../sudo-probe.js';

describe('a sudo that cannot start', () => {
  it('answers with the password message, not a thrown spawn error', async () => {
    expect(await sudoWouldHang('sudo ls')).toContain('wants a password');
  });
});
