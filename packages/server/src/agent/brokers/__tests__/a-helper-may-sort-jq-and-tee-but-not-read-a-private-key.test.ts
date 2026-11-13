// A helper on the default command list may run sort, jq and tee on ordinary files at both doors,
// and sort and jq are refused a private key exactly as cat is. Asked of the exec seam with strings
// only: nothing runs.
import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';

vi.mock('../../../db/connection.js', () => ({
  getDb: () => ({ prepare: () => ({ run: () => ({ changes: 0 }), get: () => undefined, all: () => [] }) }),
}));

const { authorizeExecShapedCall } = await import('../exec-seam.js');
const { grantForManifest } = await import('../grants.js');
const { DEFAULT_SUBAGENT_PERMISSIONS } = await import('../../manifest.js');
const { homeDir } = await import('../../../home.js');

const helper = grantForManifest('agent-helper', DEFAULT_SUBAGENT_PERMISSIONS);
const shell = (line: string): boolean => authorizeExecShapedCall(helper, 'shell', line).allowed;
const argv = (a: string[]): boolean => authorizeExecShapedCall(helper, 'proc', a).allowed;
const KEY = path.join(homeDir(), '.ssh', 'id_rsa');

describe('a helper may sort, jq and tee, but not read a private key', () => {
  it('runs them on ordinary files at both doors', () => {
    expect(shell('sort /tmp/names.txt')).toBe(true);
    expect(shell('cat /tmp/a.json | jq .x | tee /tmp/out.json')).toBe(true);
    expect(argv(['sort', '/tmp/names.txt'])).toBe(true);
    expect(argv(['jq', '.x', '/tmp/a.json'])).toBe(true);
  });

  it('refuses sort and jq on a private key, as cat is refused', () => {
    expect(shell(`cat ${KEY}`)).toBe(false);
    expect(shell(`sort ${KEY}`)).toBe(false);
    expect(shell(`jq -R . ${KEY}`)).toBe(false);
    expect(argv(['sort', KEY])).toBe(false);
    expect(argv(['jq', '-R', '.', KEY])).toBe(false);
  });
});
