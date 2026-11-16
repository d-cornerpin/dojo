// A helper's line that names a folder holding a secret (the home folder, ~/.ssh) is refused, so a
// recursive search cannot walk into it; the main agent's is not. Decisions only: nothing runs.

import { describe, it, expect, vi } from 'vitest';

const PRIMARY = 'primary-agent';
vi.mock('../../../config/platform.js', async (orig) => ({
  ...(await orig<typeof import('../../../config/platform.js')>()),
  isPrimaryAgent: (id: string) => id === PRIMARY,
}));
vi.mock('../../../db/connection.js', () => ({
  getDb: () => ({ prepare: () => ({ run: () => ({ changes: 0 }), get: () => undefined, all: () => [] }) }),
}));

const { authorizeExecShapedCall } = await import('../exec-seam.js');
const { grantForManifest } = await import('../grants.js');
const { PRIMARY_AGENT_PERMISSIONS } = await import('../../manifest.js');

const OPEN = { file_read: '*', file_write: '*', exec_allow: ['*'], exec_deny: [], shell_allow: ['*'], shell_deny: [], network_domains: 'none', max_processes: 1, can_spawn_agents: false, can_assign_permissions: false, system_control: [] };
const helper = grantForManifest('agent-helper', OPEN as never);
const main = grantForManifest(PRIMARY, PRIMARY_AGENT_PERMISSIONS);
const LINES = ['grep -r invoice ~', 'rg TODO ~/', 'grep -rn key ~/.ssh', 'cp -r ~/.aws /tmp/x'];

describe('a helper grep -r of the home folder is refused', () => {
  it.each(LINES)('helper: %s', (line) => {
    expect(authorizeExecShapedCall(helper, 'shell', line).allowed).toBe(false);
  });

  it.each(LINES)('main agent: %s', (line) => {
    expect(authorizeExecShapedCall(main, 'shell', line).allowed).toBe(true);
  });

  it("a helper's search of an ordinary folder runs", () => {
    expect(authorizeExecShapedCall(helper, 'shell', 'grep -r invoice ~/Documents').allowed).toBe(true);
  });
});
