// A-2 — data/toolbox-groups.json names process groups on THIS machine in THIS boot. An export that
// carried it would, on a restore to the same machine, replace the live ledger with an old one.
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { copyDojoTree } from '../export.js';

vi.mock('../../db/connection.js', () => ({
  getDb: () => { throw new Error('unused'); },
  getDbPath: () => '/nonexistent/dojo.db',
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn() }));

describe('what an export copies out of data/', () => {
  it('leaves out the toolbox process ledger but keeps ordinary data files', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'export-ledger-'));
    try {
      const src = path.join(root, 'src'), dest = path.join(root, 'dest');
      fs.mkdirSync(path.join(src, 'data'), { recursive: true });
      fs.writeFileSync(path.join(src, 'data', 'toolbox-groups.json'), '{"boot":1,"groups":[]}');
      fs.writeFileSync(path.join(src, 'data', 'slides_styles.json'), '{}');
      copyDojoTree(src, dest);
      expect(fs.existsSync(path.join(dest, 'data', 'toolbox-groups.json'))).toBe(false);
      expect(fs.existsSync(path.join(dest, 'data', 'slides_styles.json'))).toBe(true);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
