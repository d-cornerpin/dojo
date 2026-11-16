// The owner's ruling: a shell line that names the keys file is refused, for the main agent too, at the
// shell, exec and AppleScript doors, however the line spells it. Asked of the brokers only: nothing runs.

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

const main = grantForManifest(PRIMARY, PRIMARY_AGENT_PERMISSIONS);
const appleScript = (script: string) => {
  const r = resolveCommandArg(script);
  if (!r.ok) throw new Error('unresolvable');
  return authorizeAppleScript(main, r.value);
};

describe("the main agent's shell refuses a line naming the keys file", () => {
  it.each([
    'cat ~/.dojo/secrets.yaml',
    `python3 -c "print(open('$HOME/.dojo/secrets.yaml').read())"`,
    "cat ~/.dojo/secr''ets.yaml",
    'rm ~/.dojo/secrets.yaml',
    'echo x > ~/.dojo/secrets.yaml',
    'chmod 600 ~/.dojo/secrets.yaml',
  ])('shell: %s', (line) => {
    const verdict = authorizeExecShapedCall(main, 'shell', line);
    expect(verdict.allowed).toBe(false);
    expect(verdict.allowed ? '' : verdict.reason).toMatch(/keys file.*Settings/);
  });

  it('exec', () => {
    expect(authorizeExecShapedCall(main, 'proc', ['cat', '/Users/someone/.dojo/secrets.yaml']).allowed).toBe(false);
  });

  it('AppleScript, in a shell payload and in the script body', () => {
    expect(appleScript('do shell script "cat ~/.dojo/secrets.yaml"').allowed).toBe(false);
    expect(appleScript('read POSIX file "/Users/someone/.dojo/secrets.yaml"').allowed).toBe(false);
  });

  it('an ordinary line runs', () => {
    expect(authorizeExecShapedCall(main, 'shell', 'cat ~/.dojo/logs/dojo.log').allowed).toBe(true);
  });
});
