// The public /share route serves files with no sign-in, so a link inside a shared folder that points
// outside it must not be followed.

import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { OUT_DIR } from '../../services/public-share.js';
import { createServer } from '../server.js';

let app: ReturnType<typeof createServer>['app'];

beforeAll(() => {
  const share = path.join(OUT_DIR, 'demo');
  fs.mkdirSync(share, { recursive: true });
  fs.writeFileSync(path.join(share, 'index.html'), '<p>hello</p>');
  const outside = path.join(OUT_DIR, '..', 'outside.txt');
  fs.writeFileSync(outside, 'private');
  fs.symlinkSync(outside, path.join(share, 'leak.txt'));
  app = createServer().app;
});

describe('public share route', () => {
  it('serves a normal shared file', async () => {
    const res = await app.request('/share/demo/index.html');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<p>hello</p>');
  });

  it('serves the index page when no file is named', async () => {
    expect((await app.request('/share/demo/')).status).toBe(200);
  });

  it('refuses a link inside the share that points outside it', async () => {
    const res = await app.request('/share/demo/leak.txt');
    expect(res.status).toBe(400);
  });
});
