// The main agent's daily SSH work is not refused at the shell or exec door, lines that name a private
// key included: the secret stays hidden by blanking what a command prints. Decisions only: nothing runs.

import { describe, it, expect, vi } from 'vitest';

const PRIMARY = 'primary-agent';
vi.mock('../../../config/platform.js', async (orig) => ({
  ...(await orig<typeof import('../../../config/platform.js')>()),
  isPrimaryAgent: (id: string) => id === PRIMARY,
}));

const { authorizeExecShapedCall } = await import('../exec-seam.js');
const { grantForManifest } = await import('../grants.js');
const { PRIMARY_AGENT_PERMISSIONS } = await import('../../manifest.js');

const main = grantForManifest(PRIMARY, PRIMARY_AGENT_PERMISSIONS);

describe('the main agent uses its SSH keys', () => {
  it.each([
    'ssh -i ~/.ssh/id_rsa deploy@host.example.com',
    'ssh-add ~/.ssh/id_ed25519',
    'chmod 600 ~/.ssh/id_ed25519',
    'ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519 -N ""',
    'ls -l ~/.ssh',
    'ls -l ~/.ssh/id_rsa',
    'git push origin main',
    'GIT_SSH_COMMAND="ssh -i ~/.ssh/id_ed25519" git push origin main',
    'cat ~/.ssh/known_hosts',
  ])('shell: %s', (line) => {
    expect(authorizeExecShapedCall(main, 'shell', line).allowed).toBe(true);
  });

  it('exec', () => {
    expect(authorizeExecShapedCall(main, 'proc', ['ssh-add', '/Users/someone/.ssh/id_ed25519']).allowed).toBe(true);
  });
});
