// Files in the uploads folders are the owner's: the start-up and daily clean-up keeps every one of them,
// however old. Only a half-finished chunked upload (a `.part` file) older than a week is removed.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { homeDir } from '../../home.js';

const { removeAbandonedPartFiles } = await import('../routes/upload.js');

describe('an upload older than a week', () => {
  it('is still there after the clean-up, and an old half-finished upload is gone', () => {
    const dir = path.join(homeDir(), '.dojo', 'uploads', 'agent-week-old');
    fs.mkdirSync(dir, { recursive: true });
    const report = path.join(dir, 'contract.pdf');
    const oldPart = path.join(dir, '1700000000000_video.mov.part');
    const newPart = path.join(dir, '1800000000000_photo.jpg.part');
    for (const f of [report, oldPart, newPart]) fs.writeFileSync(f, 'x');
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    fs.utimesSync(report, eightDaysAgo, eightDaysAgo);
    fs.utimesSync(oldPart, eightDaysAgo, eightDaysAgo);

    removeAbandonedPartFiles();

    expect(fs.existsSync(report)).toBe(true);
    expect(fs.existsSync(oldPart)).toBe(false);
    expect(fs.existsSync(newPart)).toBe(true);
  });
});
