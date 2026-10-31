// Some web answers hold no results at all: the missing-key notice, a stop, a page
// that answered an HTTP error. Nothing was read there, so the "only sources" line
// has nothing to be about — yet none of them is an error, so `isError` stays false
// and the line used to ride them anyway. These answers must return byte-identical.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const braveSearch = vi.fn<(agentId: string, p: Record<string, unknown>) => Promise<string>>();
const pageFetch = vi.fn<(agentId: string, p: Record<string, unknown>) => Promise<string>>();

vi.mock('../../../web-tools.js', () => ({
  webSearch: (agentId: string, p: Record<string, unknown>) => braveSearch(agentId, p),
  webFetch: (agentId: string, p: Record<string, unknown>) => pageFetch(agentId, p),
}));

vi.mock('../../../browser.js', () => ({
  executeWebBrowse: async () => 'browsed',
}));

import { webHandlers, WEB_RESULT_SOURCE_BOUND } from '../web.js';
import type { ToolCall } from '../../../types.js';

const call = (name: string, args: Record<string, unknown>) =>
  webHandlers[name]!({
    agentId: 'a1',
    name,
    args,
    callId: 'call_1',
    toolCall: { id: 'call_1', name, arguments: args } as unknown as ToolCall,
  });

beforeEach(() => {
  braveSearch.mockReset();
  pageFetch.mockReset();
});

describe('the sources line skips answers that hold no sources', () => {
  // Retyped literals on purpose: a test that imports the production constants and
  // compares them to themselves proves nothing about what the bytes are.

  it('a search with no Brave key configured is returned byte-identical, not an error', async () => {
    const notice = 'Web search not configured. Add a Brave Search API key in Settings > Platform.';
    braveSearch.mockResolvedValue(notice);
    const out = await call('web_search', { query: 'anything' });
    expect(out.isError).toBe(false);
    expect(out.content).toBe(notice);
  });

  it('a search stopped by the user is returned byte-identical, not an error', async () => {
    const stopped = 'Stopped: you pressed stop while this was still generating.';
    braveSearch.mockResolvedValue(stopped);
    const out = await call('web_search', { query: 'anything' });
    expect(out.isError).toBe(false);
    expect(out.content).toBe(stopped);
  });

  it('a fetch stopped by the user is returned byte-identical, not an error', async () => {
    const stopped = 'Stopped: you pressed stop while this was still generating.';
    pageFetch.mockResolvedValue(stopped);
    const out = await call('web_fetch', { url: 'https://example.test/x', prompt: 'anything' });
    expect(out.isError).toBe(false);
    expect(out.content).toBe(stopped);
  });

  it('a fetch that met an HTTP error is returned byte-identical, not an error', async () => {
    const answer = 'That URL returned HTTP 404 (Not Found), so there is no page content to read.';
    pageFetch.mockResolvedValue(answer);
    const out = await call('web_fetch', { url: 'https://example.test/gone', prompt: 'anything' });
    expect(out.isError).toBe(false);
    expect(out.content).toBe(answer);
  });

  it('a normal search answer still ends with the sources line', async () => {
    braveSearch.mockResolvedValue('Search results for "x":\n\n1. a');
    const out = await call('web_search', { query: 'x' });
    expect(out.isError).toBe(false);
    expect(out.content.endsWith(WEB_RESULT_SOURCE_BOUND)).toBe(true);
  });
});
