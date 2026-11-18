// A public share link carries as much randomness as a download link (122 bits, 32 hex characters),
// so nobody can find a shared page by trying addresses.

import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { homeDir } from '../../home.js';

vi.mock('../tunnel.js', () => ({ getTunnelStatus: () => ({ enabled: false, status: 'stopped', url: null }) }));

const { createPublicShare } = await import('../public-share.js');

describe('a share link', () => {
  it('ends in 32 random hex characters, different every time', () => {
    const file = path.join(homeDir(), 'share-me', 'note.txt');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'hello');
    const a = createPublicShare({ sourcePath: file });
    const b = createPublicShare({ sourcePath: file });
    expect(a.slug).toMatch(/^\d{8}-\d{6}-[0-9a-f]{32}$/);
    expect(b.slug).toMatch(/^\d{8}-\d{6}-[0-9a-f]{32}$/);
    expect(a.slug).not.toBe(b.slug);
  });
});
