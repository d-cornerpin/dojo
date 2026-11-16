// A helper's line that names an SSH private key is refused at the shell, exec and AppleScript doors,
// by any program and inside a script's text; its ordinary files and public keys are not. Nothing runs.

import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';

vi.mock('../../../db/connection.js', () => ({
  getDb: () => ({ prepare: () => ({ run: () => ({ changes: 0 }), get: () => undefined, all: () => [] }) }),
}));

const { authorizeExecShapedCall } = await import('../exec-seam.js');
const { authorizeAppleScript } = await import('../applescript.js');
const { resolveCommandArg } = await import('../resolve.js');
const { grantForManifest } = await import('../grants.js');
const { homeDir } = await import('../../../home.js');

const helper = grantForManifest('agent-helper', {
  file_read: '*', file_write: '*', exec_allow: ['*'], exec_deny: [], shell_allow: ['*'], shell_deny: [],
  network_domains: 'none', max_processes: 1, can_spawn_agents: false, can_assign_permissions: false, system_control: ['applescript'],
});
const KEY = path.join(homeDir(), '.ssh', 'id_rsa');
const shell = (line: string): boolean => authorizeExecShapedCall(helper, 'shell', line).allowed;

describe('a helper cannot name an SSH private key on the shell', () => {
  it.each([
    `cat ${KEY}`,
    `sort ${KEY}`,
    'cat ~/.ssh/id_ed25519',
    `python3 -c "print(open('${KEY}').read())"`,
    `cp ${KEY} /tmp/x`,
  ])('shell: %s', (line) => {
    expect(shell(line)).toBe(false);
  });

  it('exec and AppleScript', () => {
    expect(authorizeExecShapedCall(helper, 'proc', ['base64', KEY]).allowed).toBe(false);
    const r = resolveCommandArg(`do shell script "cat ${KEY}"`);
    expect(r.ok && authorizeAppleScript(helper, r.value).allowed).toBe(false);
  });

  it('ordinary files and public keys are not refused', () => {
    expect(shell('sort /tmp/names.txt')).toBe(true);
    expect(shell(`cat ${KEY}.pub`)).toBe(true);
    expect(shell('cat ~/.ssh/known_hosts')).toBe(true);
  });
});
