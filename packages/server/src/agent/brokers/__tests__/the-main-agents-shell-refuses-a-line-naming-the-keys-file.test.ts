// The owner's ruling: a shell line that names the Dojo's keys file is refused, for the main agent too, at
// the shell, exec and AppleScript doors; a project's own secrets.yaml is not. Asked of the brokers: nothing runs.

import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';

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

const { homeDir } = await import('../../../home.js');
const KEYS = path.join(homeDir(), '.dojo', 'secrets.yaml');

describe("the main agent's shell refuses a line naming the keys file", () => {
  it.each([
    'cat ~/.dojo/secrets.yaml',
    'cat $HOME/.dojo/secrets.yaml',
    `cat ${KEYS}`,
    `python3 -c "print(open('${KEYS}').read())"`,
    "cat ~/.dojo/secr''ets.yaml",
    'rm ~/.dojo/secrets.yaml',
    'echo x > ~/.dojo/secrets.yaml',
    'chmod 600 ~/.dojo/secrets.yaml',
  ])('shell: %s', (line) => {
    const verdict = authorizeExecShapedCall(main, 'shell', line);
    expect(verdict.allowed ? '' : verdict.reason).toMatch(/keys file.*Settings.*owner/);
  });

  it('a relative name, against the call\'s working directory', () => {
    expect(authorizeExecShapedCall(main, 'shell', 'git add secrets.yaml', path.join(homeDir(), '.dojo')).allowed).toBe(false);
    expect(authorizeExecShapedCall(main, 'shell', 'git add secrets.yaml', path.join(homeDir(), 'code', 'app')).allowed).toBe(true);
  });

  it('exec', () => {
    expect(authorizeExecShapedCall(main, 'proc', ['cat', KEYS]).allowed).toBe(false);
  });

  it('AppleScript, in a shell payload and in the script body', () => {
    expect(appleScript('do shell script "cat ~/.dojo/secrets.yaml"').allowed).toBe(false);
    expect(appleScript(`read POSIX file "${KEYS}"`).allowed).toBe(false);
  });

  it("a project's own secrets.yaml is an ordinary file", () => {
    for (const line of ['kubectl apply -f chart/secrets.yaml', 'git add chart/templates/secrets.yaml', 'echo secrets.yaml >> .gitignore', 'cat ~/.dojo/logs/dojo.log']) {
      expect(authorizeExecShapedCall(main, 'shell', line).allowed, line).toBe(true);
    }
  });
});
