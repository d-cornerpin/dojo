// ════════════════════════════════════════════════════════════════════════════
// EACH EXPORT GETS ITS OWN TEMP FILE.
//
// createExport used to write the final zip to `dojo-export-<date>.zip` — a path
// that depends only on the date. A second export the same day (a second browser
// tab, a retry after a slow first try) reached createFinalZip and opened that
// SAME path for writing, truncating the file the first request was still
// streaming: the first download ended short of its Content-Length, and when the
// first stream closed it deleted the second request's finished file too.
// exportOutputPath keeps the date in the name and adds a random suffix so two
// exports never share a path.
// ════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { exportOutputPath } from '../export.js';

vi.mock('../../db/connection.js', () => ({
  getDb: () => { throw new Error('unused'); },
  getDbPath: () => '/nonexistent/dojo.db',
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn() }));

const DATE = '2026-10-31';

describe('each export gets its own file', () => {
  it('two calls with the same date give two different paths', () => {
    expect(exportOutputPath(DATE)).not.toBe(exportOutputPath(DATE));
  });

  it('each path is inside the temp dir, named dojo-export-2026-10-31-… and ends with .zip', () => {
    for (const p of [exportOutputPath(DATE), exportOutputPath(DATE)]) {
      expect(path.dirname(p)).toBe(os.tmpdir());
      const name = path.basename(p);
      expect(name.startsWith('dojo-export-2026-10-31-')).toBe(true);
      expect(name.endsWith('.zip')).toBe(true);
    }
  });

  it('the suffix is 8 hex chars', () => {
    for (const p of [exportOutputPath(DATE), exportOutputPath(DATE)]) {
      expect(path.basename(p)).toMatch(/^dojo-export-2026-10-31-[0-9a-f]{8}\.zip$/);
    }
  });
});
