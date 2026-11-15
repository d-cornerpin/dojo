import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { homeDir } from '../../home.js';
import { uploadRouter } from '../routes/upload.js';

describe('the upload preview route', () => {
  it('serves an uploaded file and refuses an encoded path that leaves the agent folder', async () => {
    const dojo = path.join(homeDir(), '.dojo');
    fs.mkdirSync(path.join(dojo, 'uploads', 'agent-1'), { recursive: true });
    fs.writeFileSync(path.join(dojo, 'uploads', 'agent-1', 'note.txt'), 'hello');
    fs.writeFileSync(path.join(dojo, 'keys-stand-in.txt'), 'SECRET');

    const ok = await uploadRouter.request('/file/agent-1/note.txt');
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe('hello');

    const escape = await uploadRouter.request('/file/agent-1/..%2F..%2Fkeys-stand-in.txt');
    expect(escape.status).toBe(400);
    expect(await escape.text()).not.toContain('SECRET');
  });
});
