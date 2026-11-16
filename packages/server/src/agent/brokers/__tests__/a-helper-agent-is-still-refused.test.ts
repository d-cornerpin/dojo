// The limits the main agent no longer has still bind every other agent, however the line is spelled. A
// recursive read of the home folder is not among them: what it prints is blanked.

import { describe, it, expect, vi } from 'vitest';

const PRIMARY = 'primary-agent';
vi.mock('../../../config/platform.js', async (orig) => ({
  ...(await orig<typeof import('../../../config/platform.js')>()),
  isPrimaryAgent: (id: string) => id === PRIMARY,
}));

const { authorizeExecShapedCall } = await import('../exec-seam.js');
const { authorizeAppleScript } = await import('../applescript.js');
const { resolveCommandArg } = await import('../resolve.js');
const { grantForManifest } = await import('../grants.js');
const { PRIMARY_AGENT_PERMISSIONS } = await import('../../manifest.js');

// A helper as wide as the main agent's grant, so only the role decides.
const helper = grantForManifest('helper-agent', PRIMARY_AGENT_PERMISSIONS);
const refused = (line: string): boolean => !authorizeExecShapedCall(helper, 'shell', line).allowed;

describe('a helper agent is still refused', () => {
  it('every spelling of sudo, doas, su and osascript on a file', () => {
    for (const line of [
      'sudo ls', 'true; sudo ls', 'true && sudo ls', 'ls | sudo tee /etc/hosts', '(sudo ls)', 'echo $(sudo whoami)',
      'SUDO ls', 'env sudo ls', 'env X=1 sudo ls', 'command sudo ls', '\\sudo ls', '"sudo" ls', 'doas ls',
      'su root -c "ls"', 'sudo -i', 'bash -c "sudo ls"', 'osascript ~/Scripts/x.scpt',
    ]) expect(refused(line), line).toBe(true);
    expect(authorizeExecShapedCall(helper, 'proc', ['sudo', 'ls']).allowed).toBe(false);
  });

  it('the Dojo folder, and a word naming a hidden location', () => {
    for (const line of ['cd ~/.dojo && ls', 'tar czf ~/Desktop/dojo.tgz ~/.dojo', 'cp ~/.dojo/data/dojo.db ~/Desktop/', 'grep -ri key ~/.ssh', 'cat ~/.aws/credentials']) {
      expect(refused(line), line).toBe(true);
    }
  });

  it('rm -rf ~ and chmod 777, with no warning to pass', () => {
    for (const line of ['rm -rf ~', 'sudo rm -rf /', 'chmod 777 ~/Shared']) expect(refused(line), line).toBe(true);
  });

  it('an AppleScript asking for administrator privileges', () => {
    const r = resolveCommandArg('do shell script "ls" with administrator privileges');
    expect(r.ok && authorizeAppleScript(helper, r.value).allowed).toBe(false);
  });
});
