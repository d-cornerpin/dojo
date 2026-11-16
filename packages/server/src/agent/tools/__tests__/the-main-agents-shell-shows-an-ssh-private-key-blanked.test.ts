// The main agent's shell is not refused for reading a hidden file: the command runs and no line of the file
// comes back. Made-up keys and passwords (repeated letters) in a scratch home; every path is absolute.

import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

const BODY = ['QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ', 'RRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRR', 'SSSSSSSSSSSSSSSSSSSS=='];
const RSA_BODY = 'TTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTT';
const PUBLIC = 'ssh-ed25519 PPPPPPPPPPPPPPPPPPPPPPPPPPPP someone@example.com';
const { scratchDojo, MAIN } = await import('./scratch-dojo.js');
const { home, run, text, blocked } = await scratchDojo('hidden-file-blank', {
  '.ssh/id_ed25519': ['-----BEGIN OPENSSH PRIVATE KEY-----', ...BODY, '-----END OPENSSH PRIVATE KEY-----', ''].join('\n'),
  '.ssh/id_ed25519.pub': `${PUBLIC}\n`,
  '.ssh/id_rsa': `-----BEGIN RSA PRIVATE KEY-----\n${RSA_BODY}\n-----END RSA PRIVATE KEY-----\n`,
  '.ssh/work.ppk': 'PuTTY-User-Key-File-3: ssh-rsa\nPrivate-Lines: 1\nUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUU\n',
  '.aws/credentials': '[default]\naws_secret_access_key = XXXXXXXXXXXXXXXXXXXX/XXXXXXXXXXXXXXXXXXX\n',
  '.netrc': 'machine example.com\nlogin someone\npassword vvvvvvvvvvvvvvvv\n',
  'one/.netrc': 'machine example.com login someone password wwwwwwwwwwwwwwww\n',
});
const ssh = path.join(home, '.ssh');
/** The command's output, after checking it ran and was not refused. */
const shell = async (script: string): Promise<string> => {
  const outcome = await run(MAIN, 'shell', { script });
  expect(blocked(outcome), script).toBe(false);
  return JSON.stringify(outcome);
};

describe("the main agent's shell shows a hidden file blanked", () => {
  it.each([`cat "${ssh}/id_ed25519"`, `tail -3 "${ssh}/id_ed25519"`, `python3 -c "print(open('${ssh}/id_ed25519').read())"`])('%s shows no line of the key', async (script) => {
    const out = await shell(script);
    for (const line of BODY) expect(out).not.toContain(line);
  });

  it('a key in another format, and a .netrc in either form, show no secret', async () => {
    expect(await shell(`cat "${ssh}/id_rsa"`)).not.toContain(RSA_BODY);
    expect(await shell(`cat "${home}/.netrc"`)).not.toContain('vvvvvvvvvvvvvvvv');
    expect(await shell(`cat "${home}/one/.netrc"`)).not.toContain('wwwwwwwwwwwwwwww');
  });

  it('a leading cd moves where a bare or relative name is read', async () => {
    expect(await shell(`cd "${ssh}" && cat work.ppk`)).not.toContain('UUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUU');
    expect(await shell(`cd "${home}/.aws" && cat credentials`)).not.toContain('XXXXXXXXXXXXXXXXXXXX/XXXXXXXXXXXXXXXXXXX');
    expect(await shell(`cd "${home}" && cat .netrc`)).not.toContain('vvvvvvvvvvvvvvvv');
    expect(await shell(`cd "${home}" && tail -3 .ssh/id_rsa`)).not.toContain(RSA_BODY);
  });

  it('an AppleScript result shows no line of the key', async () => {
    // A stand-in osascript prints what the payload would: the real one is never run in tests.
    fs.writeFileSync(path.join(home, 'osascript'), `#!/bin/sh\ntail -3 '${ssh}/id_ed25519'\n`, { mode: 0o700 });
    vi.stubEnv('PATH', `${home}:${process.env.PATH}`);
    const out = await text(MAIN, 'applescript_run', { script: `do shell script "tail -3 '${ssh}/id_ed25519'"` });
    expect(out).not.toMatch(/AppleScript error/);
    for (const line of BODY) expect(out).not.toContain(line);
  });

  it('a public key, a folder listing and the output of a command that only names the key are not blanked', async () => {
    expect(await shell(`cat "${ssh}/id_ed25519.pub"`)).toContain(PUBLIC);
    expect(await shell(`ls -l "${ssh}"`)).toContain('id_ed25519');
    expect(await shell(`echo "identity loaded for this session"; : "${ssh}/id_ed25519"`)).toContain('identity loaded for this session');
  });
});
