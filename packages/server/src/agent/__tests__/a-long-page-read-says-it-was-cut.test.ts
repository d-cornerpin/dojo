// A prompt read of a long page says how much of the page the extractor saw; a short page carries no cut note.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { lookup } = vi.hoisted(() => ({ lookup: vi.fn() }));

vi.mock('node:dns/promises', () => ({
  default: { lookup },
  lookup,
}));

vi.mock('../permissions.js', () => ({
  checkPermission: () => ({ allowed: true }),
}));
vi.mock('../../config/loader.js', () => ({
  getSearchApiKey: () => null,
}));
vi.mock('../../logger.js', () => ({
  createLogger: () => ({
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  }),
}));

vi.mock('../../router/selector.js', () => ({ selectModel: () => ({ modelId: 'light-model' }) }));
const { callModel } = vi.hoisted(() => ({ callModel: vi.fn(async () => ({ content: 'The answer is 42.' })) }));
vi.mock('../model.js', () => ({ callModel }));

import { webFetch } from '../web-tools.js';
import { stripOutsideMarks } from '../../tools/external-content.js';

describe('a prompt read tells the agent how much of the page it saw', () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    lookup.mockReset();
    lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  /** A page served as plain text, so the body reaches the extractor untouched. */
  function servePage(body: string): void {
    globalThis.fetch = (() =>
      Promise.resolve(new Response(body, { status: 200, headers: { 'content-type': 'text/plain' } }))
    ) as typeof globalThis.fetch;
  }

  it('a prompt read of a long page says only the first 50000 characters were read', async () => {
    servePage('a'.repeat(60000));

    const out = stripOutsideMarks(await webFetch('agent-one', { url: 'https://example.com/long', prompt: 'find the answer' }));

    expect(out).toContain('(extracted via prompt from the first 50000 of 60000 characters; the rest was not read):');
    expect(out).toContain('The answer is 42.');
  });

  it('a prompt read of a short page carries no cut note', async () => {
    servePage('short page text');

    const out = stripOutsideMarks(await webFetch('agent-one', { url: 'https://example.com/short', prompt: 'find the answer' }));

    expect(out).toContain('(extracted via prompt):');
    expect(out).not.toContain('the rest was not read');
  });
});
