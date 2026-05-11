// error-handling-spec Phase 4 — input rectification framework tests.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  rectifyAttachment,
  registerRectifier,
  type AttachmentInput,
} from '../input-rectification.js';

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'input-rect-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function mkImage(filename = 'tiny.png'): AttachmentInput {
  const p = path.join(tmpDir, filename);
  fs.writeFileSync(p, TINY_PNG);
  return {
    fileId: 'f1',
    filename,
    mimeType: 'image/png',
    size: TINY_PNG.length,
    path: p,
    category: 'image',
  };
}

describe('rectifyAttachment — image branch (lifts v2.3.18 behavior)', () => {
  it('returns kept=true for a tiny PNG (under budget passthrough)', () => {
    const att = mkImage();
    const result = rectifyAttachment(att);
    expect(result).not.toBeNull();
    expect(result!.kept).toBe(true);
    expect(result!.data).toBeDefined();
    expect(result!.mediaType).toBe('image/png');
    // No fresh resize on under-budget passthrough.
    expect(result!.freshlyApplied).toBe(false);
    expect(result!.agentNote).toBeUndefined();
  });

  it('returns null for non-image attachments (no rectifier registered)', () => {
    const att: AttachmentInput = {
      fileId: 'f1',
      filename: 'doc.pdf',
      mimeType: 'application/pdf',
      size: 1024,
      path: '/tmp/nope.pdf',
      category: 'pdf',
    };
    expect(rectifyAttachment(att)).toBeNull();
  });

  it('returns null for missing image file', () => {
    const att: AttachmentInput = {
      fileId: 'f1',
      filename: 'missing.png',
      mimeType: 'image/png',
      size: 0,
      path: path.join(tmpDir, 'missing.png'),
      category: 'image',
    };
    expect(rectifyAttachment(att)).toBeNull();
  });
});

describe('registerRectifier', () => {
  it('new rectifier takes precedence over built-ins (unshift order)', () => {
    let called = false;
    const unregister = registerRectifier((att) => {
      called = true;
      return {
        kept: true,
        mediaType: 'image/jpeg',
        data: Buffer.from('xx'),
        freshlyApplied: true,
        agentNote: 'test rectifier ran',
      };
    });
    try {
      const att = mkImage();
      const result = rectifyAttachment(att);
      expect(called).toBe(true);
      expect(result!.agentNote).toBe('test rectifier ran');
    } finally {
      unregister();
    }
    // After unregister, the built-in image rectifier handles it again.
    const att2 = mkImage('after.png');
    const result2 = rectifyAttachment(att2);
    expect(result2!.agentNote).toBeUndefined(); // built-in returns no note for under-budget
  });

  it('rectifier that returns null falls through to the next', () => {
    const unregister = registerRectifier(() => null);
    try {
      const att = mkImage();
      const result = rectifyAttachment(att);
      expect(result).not.toBeNull();
      expect(result!.kept).toBe(true); // image rectifier still handled it
    } finally {
      unregister();
    }
  });
});
