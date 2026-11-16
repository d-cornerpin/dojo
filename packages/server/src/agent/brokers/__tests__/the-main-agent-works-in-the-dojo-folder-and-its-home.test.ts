// The main agent may look in, copy and archive the Dojo folder and search or back up its home; only
// the keys file, credential tables and the raw database through the file tools stay hidden from it.

import { describe, it, expect, vi } from 'vitest';

const PRIMARY = 'primary-agent';
vi.mock('../../../config/platform.js', async (orig) => ({
  ...(await orig<typeof import('../../../config/platform.js')>()),
  isPrimaryAgent: (id: string) => id === PRIMARY,
}));

const { authorizeExecShapedCall } = await import('../exec-seam.js');
const { authorizeFs } = await import('../fs.js');
const { resolvePathArg } = await import('../resolve.js');
const { grantForManifest } = await import('../grants.js');
const { PRIMARY_AGENT_PERMISSIONS } = await import('../../manifest.js');

const main = grantForManifest(PRIMARY, PRIMARY_AGENT_PERMISSIONS);
const runs = (line: string): boolean => authorizeExecShapedCall(main, 'shell', line).allowed;
const file = (kind: 'fs_read' | 'fs_write', p: string): boolean => {
  const r = resolvePathArg(p);
  return r.ok && authorizeFs(main, kind, r.value).allowed;
};

describe('the main agent works in the Dojo folder and its home', () => {
  it('looks in, copies and archives the Dojo folder', () => {
    for (const line of ['cd ~/.dojo && ls', 'ls ~/.dojo/data | grep db', 'tar czf ~/Desktop/dojo.tgz ~/.dojo', 'cp ~/.dojo/data/dojo.db ~/Desktop/',
      'sqlite3 ~/.dojo/data/dojo.db ".dump" > ~/Desktop/dump.sql', 'du -sh ~/.dojo/backups',
      'cat ~/.ssh/id_ed25519']) expect(runs(line), line).toBe(true);
  });

  it('searches and backs up its home, folders holding secret files included', () => {
    for (const line of ['grep -ri invoice ~', 'rsync -a ~/ /Volumes/Backup/', 'cp -r ~ /Volumes/X', 'mv ~/.config ~/old-config', 'rg TODO ~']) {
      expect(runs(line), line).toBe(true);
    }
  });

  it('edits a Dojo soul file with the file tools', () => {
    expect(file('fs_write', '~/.dojo/prompts/SOUL.md')).toBe(true);
  });

  it('still never sees a secret: key files, credential tables, the raw database through the file tools', () => {
    for (const line of ['cat ~/.dojo/secrets.yaml', 'ls -l ~/.dojo/secrets.yaml', 'sqlite3 -readonly ~/.dojo/data/dojo.db "SELECT * FROM google_accounts"']) {
      expect(runs(line), line).toBe(false);
    }
    expect(file('fs_read', '~/.dojo/data/dojo.db')).toBe(false);
    expect(file('fs_read', '~/.dojo/backups/dojo-old.db')).toBe(false);
  });
});
