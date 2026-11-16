// The main agent's shell is not refused for reading an SSH private key: the command runs, by cat or by a
// python one-liner, and the key block comes back blanked. Made-up key in a scratch home.

import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';

vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

const { scratchDojo, MAIN } = await import('./scratch-dojo.js');
const { home, run, blocked } = await scratchDojo('ssh-blank', {
  '.ssh/id_ed25519': '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAAfakekeybodyzq7\n-----END OPENSSH PRIVATE KEY-----\n',
});
const key = path.join(home, '.ssh', 'id_ed25519');

describe("the main agent's shell shows an SSH private key blanked", () => {
  it.each([`cat "${key}"`, `python3 -c "print(open('${key}').read())"`])('%s runs and returns no key material', async (script) => {
    const outcome = await run(MAIN, 'shell', { script });
    expect(blocked(outcome)).toBe(false);
    expect(JSON.stringify(outcome)).not.toContain('fakekeybodyzq7');
  });
});
