// An export that skipped links tells the person which ones, through a response header the dashboard turns
// into its existing toast. No header when nothing was skipped.
import { describe, it, expect, vi } from 'vitest';
import { Readable } from 'node:stream';

const exp = vi.hoisted(() => ({ skippedLinks: [] as string[] }));
vi.mock('../../../techniques/share-export.js', () => ({
  exportTechnique: async () => ({
    stream: Readable.from([Buffer.from('zip')]), filename: 't.dojo.zip', autoResolutions: [], skippedLinks: exp.skippedLinks,
  }),
}));
vi.mock('../../../techniques/store.js', () => ({}));
vi.mock('../../../techniques/versioning.js', () => ({}));
vi.mock('../../../techniques/trainer-agent.js', () => ({}));
vi.mock('../../../techniques/share-import.js', () => ({ importTechnique: vi.fn() }));

import { techniquesRouter } from '../techniques.js';

const post = () => techniquesRouter.request('/t1/export', { method: 'POST' }) as Promise<Response>;

describe('the technique export names the links it left out', () => {
  it('sends the skipped paths in a header', async () => {
    exp.skippedLinks = ['notes/peek.txt', 'a/link'];
    const res = await post();
    const h = res.headers.get('X-Dojo-Export-Skipped-Links');
    expect(h).toBeTruthy();
    expect(JSON.parse(Buffer.from(h!, 'base64').toString('utf-8'))).toEqual(['notes/peek.txt', 'a/link']);
    expect(res.headers.get('Access-Control-Expose-Headers')).toContain('X-Dojo-Export-Skipped-Links');
  });
  it('sends no header when nothing was skipped', async () => {
    exp.skippedLinks = [];
    expect((await post()).headers.get('X-Dojo-Export-Skipped-Links')).toBeNull();
  });
});
