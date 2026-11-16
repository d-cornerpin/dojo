// A `#` at the start of an unquoted word comments out the rest of its line, as zsh reads it, and
// nothing in the comment (an apostrophe included) reaches past that line. Driven through the exec seam.

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../db/connection.js', () => ({
  getDb: () => ({ prepare: () => ({ run: () => ({ changes: 0 }), get: () => undefined, all: () => [] }) }),
}));

const { authorizeExecShapedCall } = await import('../exec-seam.js');
const { grantForManifest } = await import('../grants.js');

const all = grantForManifest('agent-all', {
  file_read: '*', file_write: '*', exec_allow: ['*'], exec_deny: [],
  network_domains: '*', max_processes: 1, can_spawn_agents: false, can_assign_permissions: false, system_control: [],
});
const shell = (line: string) => authorizeExecShapedCall(all, 'shell', line);

describe('a shell comment ends at its line', () => {
  it('an apostrophe in a comment hides no later line from the floor', () => {
    expect(shell("echo a # don't\nrm -rf /").allowed).toBe(false);
    expect(shell("bash <<'EOF'\n# it's fine\nrm -rf /\nEOF").allowed).toBe(false);
    expect(shell("bash -s <<'EOF'\necho a # don't\nrm -rf ~\nEOF").allowed).toBe(false);
    expect(shell("sh <<'EOF'\ncat <<'X'\nit's\nX\nrm -rf /\nEOF").allowed).toBe(false);
  });

  it('a hash inside a word or a quote is not a comment', () => {
    expect(shell("echo a#b'\nchmod 777 *'").allowed).toBe(true);
    expect(shell("echo '# x\nchmod 777 *'").allowed).toBe(true);
  });
});
