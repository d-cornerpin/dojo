// ════════════════════════════════════════════════════════════════════════════════════════
// UX-REPAIR ROUND 11 T45 — SOURCES BOUND THE SPECIFICS (round-11 S1, S4-Denver).
//
// THE INCIDENT. S1's reply stated the Fremont Sunday Market runs "10 AM–4 PM … rain or
// shine". Neither specific is in the ONE source the turn read (catalog §8.3's read table);
// the recorder re-checked the real hours and found the reply lucky-right, not sourced. S4's
// "home from Denver" is the same class with a different surface: no work row and no calendar
// event carries it, and the sentence traces to the agent's OWN earlier chat text while the
// calendar covering that window was silent. Class: confident specifics beyond what was read,
// with no hedge.
//
// WHY IT LANDS ON THE TOOL RESULT AND NOT IN THE PROMPT. dsh's F4, in their words: "the
// failure arrives mid-task; a static instruction does not reliably reach the retry decision,
// while the error message is present exactly when the model must act." HL6's own door-text
// audit reached the same verdict on this platform's record — a static conduct sentence was
// migrated OUT of the summaries header and INTO the board-read result for exactly this
// reason, and W8's replay is the datum. The decision moment for "may I state these hours?"
// is the moment the search results arrive, so the line rides the results.
//
// IT COSTS ZERO CACHED PREFIX BYTES. A `return` value is not a tool description and not a
// registry entry — the [FILED] precedent (W17), verified the same way at W18's release check,
// and pinned again by §3 below.
//
// HONEST BOUND, recorded in advance: floor-model compliance is UNKNOWN and no behavioural
// experiment is run for this task. The change rests on the truth argument — the results are
// the only sources the turn read, and until now nothing said so at the moment it mattered.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), 'utf8');

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

// ════════════════════════════════════════════════════════════════════════════════════════
// §1 — THE LINE, VERBATIM, ON BOTH TOOLS.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§1 the results say they are the only sources this turn has read', () => {
  /** The text as the plan wrote it. Retyped here on purpose: a test that imports the
   *  constant and compares it to itself proves nothing about what the bytes are. */
  const EXACT =
    '[These results are the only sources this turn has read. If your answer states specifics '
    + '(hours, prices, dates, policies) they do not contain, either fetch a page that confirms '
    + 'them or say which details are unverified.]';

  it('the constant IS the text, byte for byte', () => {
    expect(WEB_RESULT_SOURCE_BOUND).toBe(EXACT);
  });

  it('THE S1 SHAPE: a search result carries the line', async () => {
    braveSearch.mockResolvedValue(
      'Search results for "fremont sunday market hours":\n\n'
      + '1. Fremont Sunday Market\n   https://example.test/market\n   Seattle street market.',
    );
    const out = await call('web_search', { query: 'fremont sunday market hours' });
    expect(out.isError).toBe(false);
    // The results themselves are untouched — the line is APPENDED, never a replacement.
    expect(out.content).toContain('Seattle street market.');
    expect(out.content).toContain(EXACT);
    expect(out.content.endsWith(EXACT)).toBe(true);
  });

  it('a fetch result carries the same line, from the same constant', async () => {
    pageFetch.mockResolvedValue('Fetched from https://example.test/market:\n\nOpen Sundays.');
    const out = await call('web_fetch', { url: 'https://example.test/market', prompt: 'the hours' });
    expect(out.isError).toBe(false);
    expect(out.content).toContain('Open Sundays.');
    expect(out.content).toContain(EXACT);
  });

  it('ONE literal, not two — the two tools cannot drift apart', () => {
    const src = read('agent/tools/cat/web.ts');
    const occurrences = src.split('These results are the only sources this turn has read').length - 1;
    expect(occurrences).toBe(1);
  });

  it('A ZERO-RESULT SEARCH STILL SAYS IT — that is when the turn has read least', async () => {
    braveSearch.mockResolvedValue('No results found for: "fremont sunday market hours"');
    const out = await call('web_search', { query: 'fremont sunday market hours' });
    expect(out.content).toContain(EXACT);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §2 — WHAT DOES NOT CHANGE. A refusal is not a source, and the third web tool is not this
//      task's subject.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§2 the negative controls', () => {
  it('a permission refusal is byte-identical — there are no results to bound', async () => {
    braveSearch.mockResolvedValue('Permission denied: no network grant');
    const out = await call('web_search', { query: 'anything' });
    expect(out.isError).toBe(true);
    expect(out.content).toBe('Permission denied: no network grant');
  });

  it('a failed search is byte-identical', async () => {
    braveSearch.mockResolvedValue('Web search failed (HTTP 500): upstream');
    const out = await call('web_search', { query: 'anything' });
    expect(out.isError).toBe(true);
    expect(out.content).toBe('Web search failed (HTTP 500): upstream');
  });

  it('a failed fetch is byte-identical', async () => {
    pageFetch.mockResolvedValue('Fetch failed: ENOTFOUND');
    const out = await call('web_fetch', { url: 'https://example.test/x', prompt: 'anything' });
    expect(out.isError).toBe(true);
    expect(out.content).toBe('Fetch failed: ENOTFOUND');
  });

  it('web_fetch\'s missing-prompt refusal is byte-identical, and never reaches the network', async () => {
    const out = await call('web_fetch', { url: 'https://example.test/x' });
    expect(out.isError).toBe(true);
    expect(out.content).toContain('Error: web_fetch requires a `prompt` parameter');
    expect(out.content).not.toContain('only sources this turn has read');
    expect(pageFetch).not.toHaveBeenCalled();
  });

  it('web_browse is untouched — this task is the two READ tools', async () => {
    const out = await call('web_browse', { action: 'goto', url: 'https://example.test' });
    expect(out.content).toBe('browsed');
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §3 — THE CACHE TENET: a tool RESULT, in no prompt surface. The [FILED] precedent.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§3 zero cached prefix bytes', () => {
  const stem = 'These results are the only sources this turn has read';

  it('the sentence is in no tool description, no tool doc, no registry entry, no assembler', () => {
    expect(read('agent/tools/definitions.ts')).not.toContain(stem);
    expect(read('tools/tool-docs.ts')).not.toContain(stem);
    expect(read('prompt/registry/entries.ts')).not.toContain(stem);
    expect(read('prompt/assembler.ts')).not.toContain(stem);
    expect(read('prompt/templates.ts')).not.toContain(stem);
  });

  it('and it is not a recognizer, a steer or a floor — it is a return value', () => {
    const src = read('agent/tools/cat/web.ts');
    // The whole mechanism: one exported literal, appended to a handler's own `content`.
    expect(src).toContain('export const WEB_RESULT_SOURCE_BOUND');
    // The append is gated on ONE thing, the handler's own pre-existing `isError` — no new
    // inspection of what the result SAYS. The engine still only counts structure.
    expect(src.match(/if \(!isError\) content = withSourceBound\(content\);/g)).toHaveLength(2);
  });
});
