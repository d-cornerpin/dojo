// Regression test for injectAttachmentBlocks: the function must match user
// messages by content suffix, not strict equality, because the assembler
// prepends framing ([New Session]…, stop-marker, etc.) to the most recent
// user message AFTER it's persisted but BEFORE injection runs.
//
// Bug fix 2026-05-04 — image/PDF attachments silently dropped on every
// post-reset / post-stop turn because the lookup never found a match.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mockDb = { current: null as Database.Database | null };

vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));

import { injectAttachmentBlocks } from '../runtime.js';

// 67-byte 1x1 transparent PNG (smallest valid PNG)
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

let tmpDir: string;
let imgPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inject-att-'));
  imgPath = path.join(tmpDir, 'test.png');
  fs.writeFileSync(imgPath, TINY_PNG);

  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      attachments TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);
  mockDb.current = db;
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function seedAttachmentMsg(id: string, content: string): void {
  const att = JSON.stringify([
    {
      fileId: 'f1',
      filename: 'test.png',
      mimeType: 'image/png',
      size: TINY_PNG.length,
      path: imgPath,
      category: 'image',
    },
  ]);
  mockDb.current!.prepare(
    `INSERT INTO messages (id, agent_id, role, content, attachments)
     VALUES (?, 'kevin', 'user', ?, ?)`,
  ).run(id, content, att);
}

describe('injectAttachmentBlocks', () => {
  it('matches by exact content (baseline)', () => {
    seedAttachmentMsg('m1', 'what is in this image?');
    const messages: Array<{ role: 'user' | 'assistant'; content: string | unknown[] }> = [
      { role: 'user', content: 'what is in this image?' },
    ];
    injectAttachmentBlocks(messages as never, 'kevin');
    expect(Array.isArray(messages[0].content)).toBe(true);
    const blocks = messages[0].content as Array<{ type: string }>;
    expect(blocks.find((b) => b.type === 'image')).toBeDefined();
  });

  it('matches by suffix when assembler prepends framing (regression)', () => {
    // The DB row has the original content; the assembled message has it
    // wrapped with a session-start banner. Without the suffix fallback,
    // the lookup fails and the image is silently dropped.
    seedAttachmentMsg('m1', 'what is in this image?');
    const wrapped =
      '[New Session: 2026-05-04 — fresh context per user reset]\n\nwhat is in this image?';
    const messages: Array<{ role: 'user' | 'assistant'; content: string | unknown[] }> = [
      { role: 'user', content: wrapped },
    ];
    injectAttachmentBlocks(messages as never, 'kevin');
    expect(Array.isArray(messages[0].content)).toBe(true);
    const blocks = messages[0].content as Array<{ type: string }>;
    expect(blocks.find((b) => b.type === 'image')).toBeDefined();
    // The text block should keep the wrapped content (we don't strip framing
    // at this layer — that's the assembler's job).
    const textBlock = blocks.find((b) => b.type === 'text') as { text: string };
    expect(textBlock.text).toBe(wrapped);
  });

  it('does not double-inject the same DB row when two messages match', () => {
    // Two assembled user messages with no assistant in between (so the
    // 2026-05-05 "skip if assistant after" gate does not skip msg[0]).
    // Only one DB attachment row. The second match shouldn't re-use the
    // row (usedDbIds guard).
    seedAttachmentMsg('m1', 'tag');
    const messages: Array<{ role: 'user' | 'assistant'; content: string | unknown[] }> = [
      { role: 'user', content: 'tag' },
      { role: 'user', content: 'something else ending in tag' },
    ];
    injectAttachmentBlocks(messages as never, 'kevin');
    // First user message gets the attachment (exact match, no assistant after)
    expect(Array.isArray(messages[0].content)).toBe(true);
    // Second user message stays a string (no second match for the same row)
    expect(typeof messages[1].content).toBe('string');
  });
});
