// ════════════════════════════════════════════════════════════════════════════════════════
// AN ATTACHMENT'S FENCE CODE IS PER-ROW, STABLE, AND UNDER A KEY THAT STAYS IN THE MODULE.
//
// The blocks that turn a contact's image or PDF into model content are rebuilt on every model
// call of a turn, so their fence must carry a code that reads the same on every call — or the
// message's bytes change and the prompt cache misses from there on. `attachment-fence.ts` draws
// it as an HMAC under a key pulled once per process, keyed to the row and the attachment's place
// in it, never from the content and never known to the sender. This pins the three properties the
// code relies on: two rows draw different codes, one row draws the same code on every rebuild, and
// the per-process key is nowhere in the module's exports. (The review's one open minor: there was
// no test that two rows get different codes.)
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';

// The key is private to attachment-fence.ts and is used only as the HMAC key in its codeOf, so it
// has no export to read. We reach it through the one seam that holds it — the call codeOf makes to
// node:crypto's createHmac — and we observe the drawn codes through the module's public door
// (bracketed / droppedAttachmentNote), which put each code in the fence's end line.
// Mutated (not reassigned) so the hoisted binding itself stays put: the mock writes the key into
// the box on every call, and the key-leak test resets it before its own codeOf run.
const keyBox = vi.hoisted(() => ({ key: undefined as Buffer | undefined }));
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<Record<string, (...args: unknown[]) => unknown>>();
  return {
    ...actual,
    createHmac: (algorithm: string, key: unknown, outputEncoding?: string) => {
      keyBox.key = key as Buffer;   // codeOf's key argument, the module's per-process CODE_KEY
      return actual.createHmac(algorithm, key, outputEncoding);
    },
  };
});

import * as attachmentFence from '../attachment-fence.js';
import { bracketed, droppedAttachmentNote, attachmentFenceOf, attachmentFenceTokens, type AttachmentFence } from '../attachment-fence.js';

const BLOCK = { type: 'text', text: 'a body' } as Anthropic.ContentBlockParam;
const fenceFor = (rowId: string): AttachmentFence => ({ kind: 'text message', from: 'an attachment from a contact', rowId, drawn: 0 });

// The code a fence draws, read off its end line ([END EXTERNAL {kind} {code}]) — the end is the
// only line whose last token is the 8-hex code; the kind's words carry none.
const codeFor = (fence: AttachmentFence): string => {
  const blocks = bracketed(fence, BLOCK);
  const end = blocks[blocks.length - 1] as Extract<Anthropic.ContentBlockParam, { type: 'text' }>;
  const m = /([0-9a-f]{8})\]$/.exec(end.text);
  expect(m, end.text).not.toBeNull();
  return m![1];
};

describe('a contact\'s attachment fence code (attachment-fence.ts)', () => {
  it('two different rows draw different codes', () => {
    expect(codeFor(fenceFor('row-A'))).not.toBe(codeFor(fenceFor('row-B')));
  });

  // A row holds more than one attachment; each takes its place in the row (the fence's `drawn`),
  // so two attachments of one row must not share a code either.
  it('two attachments of one row draw different codes (each by its place in the row)', () => {
    const oneRow = fenceFor('row-A');
    expect(codeFor(oneRow)).not.toBe(codeFor(oneRow));
  });

  // The cache tenet: the same row is rebuilt fresh on every model call, so it must read the same
  // code — the code is a function of the row and its place, not of the call.
  it('the same row, asked for twice in one process, draws the same code', () => {
    expect(codeFor(fenceFor('row-A'))).toBe(codeFor(fenceFor('row-A')));
  });

  // Keyed to the row, not a running count: drawing another row in between must not shift this one.
  it('drawing a different row in between does not shift a row\'s code', () => {
    const first = codeFor(fenceFor('row-A'));
    codeFor(fenceFor('row-B'));
    expect(codeFor(fenceFor('row-A'))).toBe(first);
  });

  // The per-process key is pulled once and held in the module; it is never an export, and nothing a
  // public function hands back carries it. We capture the real key the code HMACs under (above) and
  // walk every export and every returned value for it, by identity and by its hex and base64 text.
  it('the per-process key is not reachable from the module\'s exports', () => {
    keyBox.key = undefined;
    bracketed(fenceFor('row-A'), BLOCK);   // one codeOf runs, capturing the key it HMACs under
    const key = keyBox.key;
    expect(Buffer.isBuffer(key), 'the key the code HMACs under is the per-process random').toBe(true);
    expect(key!.length).toBe(32);

    const keyTexts = [key!.toString('hex'), key!.toString('base64')];
    const leak: string[] = [];
    const scan = (value: unknown, where: string, seen = new Set<unknown>()): void => {
      if (value === key || (Buffer.isBuffer(value) && keyTexts.includes(value.toString('hex')))) { leak.push(where); return; }
      if (typeof value === 'string' && keyTexts.some((t) => value.includes(t))) { leak.push(where); return; }
      if ((typeof value === 'object' || typeof value === 'function') && value !== null && !seen.has(value)) {
        seen.add(value);
        for (const [k, v] of Object.entries(value)) scan(v, `${where}.${k}`, seen);
      }
    };
    for (const [name, value] of Object.entries(attachmentFence)) scan(value, name);
    scan(bracketed(fenceFor('row-A'), BLOCK), 'bracketed()');
    scan(droppedAttachmentNote(fenceFor('row-B'), 'image', 'a.png', 'could not be read'), 'droppedAttachmentNote()');
    scan(attachmentFenceOf(JSON.stringify({ channel: 'email', sender: 'a@x.test' }), 'row-C'), 'attachmentFenceOf()');
    scan(attachmentFenceTokens(fenceFor('row-D')), 'attachmentFenceTokens()');
    expect(leak, leak.join(' | ')).toEqual([]);
  });
});
