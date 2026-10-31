// The backup prune that runs at every start must run whatever the leftovers sweep does: a sweep that is
// slow or stuck (waiting on a stopped writer) never holds the prune back.
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

vi.mock('../../../update/leftovers.js', () => ({ cleanUpdateLeftovers: () => new Promise(() => { /* never settles */ }) }));

import { pruneOldBackupsAsyncAtBoot } from '../update.js';
import { homeDir } from '../../../home.js';

describe('pruneOldBackupsAsyncAtBoot', () => {
  it('still prunes the old backups while the sweep never finishes', async () => {
    const dojo = path.join(homeDir(), '.dojo');
    const mk = (v: string): string => {
      const d = path.join(dojo, `platform.backup-${v}`);
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ version: v }));
      return d;
    };
    const oldest = mk('3.0.1'); mk('3.0.2'); mk('3.0.3'); mk('3.0.4');
    void pruneOldBackupsAsyncAtBoot();
    for (let i = 0; i < 400 && fs.existsSync(oldest); i++) await new Promise((r) => setTimeout(r, 25));
    expect(fs.existsSync(oldest)).toBe(false);
    for (const v of ['3.0.1', '3.0.2', '3.0.3', '3.0.4']) fs.rmSync(path.join(dojo, `platform.backup-${v}`), { recursive: true, force: true });
  });
});
