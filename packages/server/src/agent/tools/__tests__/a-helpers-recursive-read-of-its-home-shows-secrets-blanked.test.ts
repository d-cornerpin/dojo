// A helper may list and search its home and the Dojo folder, and the Healer may look in the Dojo folder:
// only a word naming a hidden file or location is refused. What a recursive read prints is blanked: a
// private key, an AWS credentials file, a Google service-account key and a kube config. Made-up contents.

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

const { scratchDojo, HELPER, HEALER } = await import('./scratch-dojo.js');
const SECRETS = ['fakekeybodyzq7', 'zq7FakeSessionTok3nValue0042abc', 'MIIEvQzq7fakeGoogleKeyBody', 'zq7FakeKubeToken0042abcdef'];
const { home, run, text, blocked } = await scratchDojo('helper-recursive', {
  'notes/old-key.txt': 'zq7 kept\n-----BEGIN OPENSSH PRIVATE KEY-----\nfakekeybodyzq7\n-----END OPENSSH PRIVATE KEY-----\n',
  'backup/aws.txt': '[default]\naws_access_key_id = AKIAFAKEEXAMPLE0042\naws_session_token = zq7FakeSessionTok3nValue0042abc\nregion = zq7-east-1\n',
  'backup/robot.json': JSON.stringify({ project_id: 'zq7-project', private_key: '-----BEGIN PRIVATE KEY-----\nMIIEvQzq7fakeGoogleKeyBody\n-----END PRIVATE KEY-----\n' }, null, 2),
  'backup/kube.yaml': 'users:\n- name: zq7-admin\n  user:\n    token: zq7FakeKubeToken0042abcdef\n',
  '.dojo/data/notes.log': 'zq7 log line\n',
});

describe("a helper's recursive read of its home shows secrets blanked", () => {
  it('grep -r over the home runs and blanks every secret value', async () => {
    const out = await text(HELPER, 'shell', { script: `grep -r -h -A3 zq7 "${home}"` });
    for (const secret of SECRETS) expect(out).not.toContain(secret);
    for (const kept of ['zq7 kept', 'region = zq7-east-1', 'zq7-project', 'zq7-admin', 'zq7 log line']) expect(out).toContain(kept);
  });

  it.each([
    [HELPER, `ls "${home}"`], [HELPER, 'ls /'], [HELPER, 'echo "a / b"'], [HELPER, 'echo a/b | tr / _'],
    [HEALER, `ls "${home}/.dojo"`], [HEALER, `du -sh "${home}/.dojo"`], [HEALER, `find "${home}/.dojo/data" -name '*.log'`],
  ])('%s: %s is not refused', async (agent, script) => {
    expect(blocked(await run(agent, 'shell', { script }))).toBe(false);
  });

  it.each([`ls "${home}/.ssh"`, `cat "${home}/.ssh/id_rsa"`, `grep -r x "${home}/.config/gcloud"`])('a word naming a hidden location is refused: %s', async (script) => {
    expect(blocked(await run(HELPER, 'shell', { script }))).toBe(true);
  });
});
