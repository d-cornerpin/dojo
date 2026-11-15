import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { homeDir } from '../../home.js';
import { uploadRouter } from '../routes/upload.js';

const dojo = (): string => path.join(homeDir(), '.dojo');
const OUT = '..%2F..%2Fescaped';

function form(name: string, body: string): FormData {
  const f = new FormData();
  f.append('files', new File([body], name, { type: 'text/plain' }));
  return f;
}

describe('the upload routes stay inside the upload folder', () => {
  it('a normal upload, a chunked upload and a preview still work', async () => {
    const up = await uploadRouter.request('/agent-1', { method: 'POST', body: form('note.txt', 'hello') });
    expect(up.status).toBe(200);
    const stored = ((await up.json()) as { data: Array<{ path: string }> }).data[0].path;
    expect(await (await uploadRouter.request(`/file/agent-1/${path.basename(stored)}`)).text()).toBe('hello');
    const start = await uploadRouter.request('/start/agent-1', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ filename: 'big.bin', size: 3 }),
    });
    expect(start.status).toBe(200);
  });

  it('an encoded traversal in agentId is refused on both write routes and on the preview, and nothing is written outside', async () => {
    const one = await uploadRouter.request(`/${OUT}`, { method: 'POST', body: form('x.txt', 'x') });
    const two = await uploadRouter.request(`/start/${OUT}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ filename: 'x.bin', size: 1 }),
    });
    const three = await uploadRouter.request(`/file/${OUT}/x.txt`);
    expect([one.status, two.status, three.status]).toEqual([400, 400, 400]);
    expect(fs.existsSync(path.join(dojo(), 'escaped'))).toBe(false);
  });

  it('an encoded traversal in the file name, and a link that points out of the folder, are not served', async () => {
    const dir = path.join(dojo(), 'uploads', 'agent-2');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dojo(), 'keys-stand-in.txt'), 'SECRET');
    fs.symlinkSync(path.join(dojo(), 'keys-stand-in.txt'), path.join(dir, 'link.txt'));
    const a = await uploadRouter.request('/file/agent-2/..%2F..%2Fkeys-stand-in.txt');
    const b = await uploadRouter.request('/file/agent-2/link.txt');
    expect([a.status, b.status]).toEqual([400, 400]);
    expect(await b.text()).not.toContain('SECRET');
  });
});
