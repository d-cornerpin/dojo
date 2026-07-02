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
     VALUES (?, 'primary', 'user', ?, ?)`,
  ).run(id, content, att);
}

describe('injectAttachmentBlocks', () => {
  it('matches by exact content (baseline)', () => {
    seedAttachmentMsg('m1', 'what is in this image?');
    const messages: Array<{ role: 'user' | 'assistant'; content: string | unknown[] }> = [
      { role: 'user', content: 'what is in this image?' },
    ];
    injectAttachmentBlocks(messages as never, 'primary');
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
    injectAttachmentBlocks(messages as never, 'primary');
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
    injectAttachmentBlocks(messages as never, 'primary');
    // First user message gets the attachment (exact match, no assistant after)
    expect(Array.isArray(messages[0].content)).toBe(true);
    // Second user message stays a string (no second match for the same row)
    expect(typeof messages[1].content).toBe('string');
  });

  it('keeps the image on iter 2+ when iter 1 emitted text + tool_use (v2.3.16 regression)', () => {
    // The 2026-05-05 fix dropped images on every loop iteration after the
    // first because it treated ANY assistant-after as a turn boundary. In a
    // multi-iteration turn (model emits text + tool_use, then is called
    // again after the tool_result), iter 2 saw the user message stripped of
    // image blocks and hallucinated "no image came through" — which then
    // leaked back via iMessage. Fix: walk the messages array and only treat
    // a *plain text* assistant message (no tool_use) as a turn boundary;
    // text+tool_use is mid-loop, so anything before it is still in-turn.
    seedAttachmentMsg('m1', 'what is in this image?');
    const messages: Array<{ role: 'user' | 'assistant'; content: string | unknown[] }> = [
      { role: 'user', content: 'what is in this image?' },
      // iter 1 model output: text + tool_use, persisted as a content-block array
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'I see a cat. Saving to memory.' },
          { type: 'tool_use', id: 't1', name: 'memory_save', input: {} },
        ],
      },
      // tool_result (Anthropic API form: user role with content blocks)
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }],
      },
    ];
    injectAttachmentBlocks(messages as never, 'primary');
    // The user message still gets the image injected — even though iter 1's
    // assistant is "after" it — because that assistant has tool_use blocks
    // and is therefore mid-loop, not a turn boundary.
    expect(Array.isArray(messages[0].content)).toBe(true);
    const blocks = messages[0].content as Array<{ type: string }>;
    expect(blocks.find((b) => b.type === 'image')).toBeDefined();
  });

  it('does NOT re-inject a prior turn\'s attachment in the next turn', () => {
    // Two completed turns: the user sent an image, the agent answered with
    // plain text (no tool_use), then the user sent a new image. On the new
    // turn's assemble, the prior turn's image must NOT be re-injected — the
    // 2026-05-05 PDF-resurrection bug. The new turn's image SHOULD inject.
    seedAttachmentMsg('m1', 'first image');
    seedAttachmentMsg('m2', 'second image');
    const messages: Array<{ role: 'user' | 'assistant'; content: string | unknown[] }> = [
      { role: 'user', content: 'first image' },
      { role: 'assistant', content: 'I saw the first image.' }, // plain text → turn boundary
      { role: 'user', content: 'second image' },
    ];
    injectAttachmentBlocks(messages as never, 'primary');
    // First user message stays a string (prior turn, attachment not re-injected)
    expect(typeof messages[0].content).toBe('string');
    // Second user message gets the image (current turn)
    expect(Array.isArray(messages[2].content)).toBe(true);
    const blocks = messages[2].content as Array<{ type: string }>;
    expect(blocks.find((b) => b.type === 'image')).toBeDefined();
  });
});
