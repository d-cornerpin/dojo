// Phase 3 (2026-05-04) per-tool result caps, as t200 (D12) re-made them.
//
// Until t200 `applyMaxResultTokensCap` CUT a result over its tool's declared `maxResultTokens`
// and told the agent to narrow its query. It is gone. `resultViewChars` now says how much of a
// result is shown whole, and a longer one is kept whole and shown as its pointer
// (`toolResultView`), with the read call for the rest. What these clauses keep from the old file is
// every SIZE rule: which tools are held to which size, the own-page carve-out and its 2x limit.
// The executor's whole path (admit, record, read) is driven in
// `agent/tools/__tests__/t200-result-store-a-long-result-is-kept-whole.test.ts`.

import { describe, it, expect } from 'vitest';
import { resultViewChars } from '../tools/index.js';
import { applyTextPagination } from '../tools/pagination.js';
import { TOOL_RESULT_VIEW_CHARS, toolResultView } from '../../memory/tool-result-view.js';

/** What the executor hands the recorder for this result: its view, and whether the whole is kept. */
function admit(tool: string, content: string): { view: string; kept: boolean } {
  const size = resultViewChars(tool, content);
  return content.length > size ? { view: toolResultView(content, 'call-1', size), kept: true } : { view: content, kept: false };
}

describe('resultViewChars + toolResultView (t200: kept whole, never cut away)', () => {
  it('returns content unchanged when under the size', () => {
    const small = 'just a small result';
    expect(admit('file_read', small)).toEqual({ view: small, kept: false });
  });

  it('a tool without maxResultTokens is held to the shared view, and a longer result is kept whole', () => {
    expect(resultViewChars('file_write', 'x')).toBe(TOOL_RESULT_VIEW_CHARS);
    const huge = 'x'.repeat(100_000);
    const out = admit('file_write', huge);
    expect(out.kept).toBe(true);
    expect(out.view.length).toBeLessThan(TOOL_RESULT_VIEW_CHARS);
    expect(out.view).toContain('tool_result_read');
  });

  it('file_read is held to the model\'s per-result view (V2_MAX_TOOL_RESULT_TOKENS)', () => {
    expect(resultViewChars('file_read', 'x')).toBe(TOOL_RESULT_VIEW_CHARS);
  });

  it('no tool is advised to run again or to narrow its query', () => {
    for (const tool of ['web_search', 'file_read', 'exec', 'made_up_tool']) {
      const out = admit(tool, 'w\n'.repeat(100_000));
      expect(out.kept).toBe(true);
      expect(out.view).not.toMatch(/Narrow your query|Re-call|Truncated by engine|same tool again/);
    }
  });

  it('exec and shell declare no size of their own: the shared view is theirs (ctx 13)', () => {
    expect(resultViewChars('exec', 'x')).toBe(TOOL_RESULT_VIEW_CHARS);
    expect(resultViewChars('shell', 'x')).toBe(TOOL_RESULT_VIEW_CHARS);
  });

  it('web_fetch is shown whole up to 2000 tokens (Phase 3.5: tightened from 6K → 2K when prompt extraction returns)', () => {
    expect(resultViewChars('web_fetch', 'x')).toBe(2000 * 4);
    expect(admit('web_fetch', 'b'.repeat(30_000)).kept).toBe(true);
  });

  it('web_search is shown whole up to 3000 tokens', () => {
    expect(resultViewChars('web_search', 'x')).toBe(3000 * 4);
  });

  it('history_search is shown whole up to 4000 tokens', () => {
    expect(resultViewChars('history_search', 'x')).toBe(4000 * 4);
  });

  it('an unknown tool is held to the shared view', () => {
    expect(resultViewChars('made_up_tool', 'x')).toBe(TOOL_RESULT_VIEW_CHARS);
  });

  it('an error is held to the shared view alone, whatever the tool declares', () => {
    expect(resultViewChars('web_search', 'x', true)).toBe(TOOL_RESULT_VIEW_CHARS);
  });

  it('the pointer reports the whole size', () => {
    const out = admit('file_read', 'x'.repeat(400_000));
    expect(out.view).toMatch(/400,000 characters \(~100,000 tokens\)/);
  });

  it('Phase 3.5, content that ends in a friendly file_read trailer keeps it (shown whole within the view)', () => {
    const body = 'x'.repeat(Math.floor(TOOL_RESULT_VIEW_CHARS * 0.9));
    const friendly =
      body +
      '\n\n[Read lines 0-2000 of 4280 total. 2280 more lines remain.\n' +
      ' To continue: file_read(path="/x", offset=2000, limit=2000).\n' +
      ' To search for specific content: use grep instead.]';
    expect(admit('file_read', friendly)).toEqual({ view: friendly, kept: false });
  });

  it('Phase 3.5, content with an end-of-file trailer is shown whole within the view', () => {
    const friendly = 'y'.repeat(Math.floor(TOOL_RESULT_VIEW_CHARS * 0.9)) + '\n\n[End of file. Read lines 100-180 of 180 total.]';
    expect(admit('file_read', friendly)).toEqual({ view: friendly, kept: false });
  });

  it('Phase 3.5, registered cross-file sizes work (Google/MS tools)', async () => {
    // Importing google/tools-read.ts triggers its registerMaxResultTokens calls.
    await import('../../google/tools-read.js');
    const size = resultViewChars('gmail_read', 'x');
    expect(size).toBeLessThan(TOOL_RESULT_VIEW_CHARS);
    const out = admit('gmail_read', 'g'.repeat(size + 4_000));
    expect(out.kept).toBe(true);
    expect(out.view.length).toBeLessThanOrEqual(size);
  });
});

describe('applyTextPagination (Phase 3.5)', () => {
  it('returns content unchanged when whole content fits', () => {
    const small = 'short content';
    expect(applyTextPagination(small, 'gmail_read', {}, { message_id: 'abc' })).toBe(small);
  });

  it('returns first slice + pagination trailer when more remains', () => {
    const huge = 'a'.repeat(50_000);
    const out = applyTextPagination(
      huge,
      'gmail_read',
      { offset: 0, limit: 16_000 },
      { message_id: 'abc' },
    );
    // Slice is 16K, plus trailer
    expect(out).toContain('a'.repeat(100));
    expect(out).toMatch(/\[Read chars 0-16000 of 50000 total\. 34000 more chars remain/);
    expect(out).toMatch(/To continue: gmail_read\(message_id="abc", offset=16000, limit=16000\)/);
  });

  it('honors caller-provided offset', () => {
    const body = 'x'.repeat(30_000);
    const out = applyTextPagination(
      body,
      'docs_read',
      { offset: 16_000, limit: 16_000 },
      { document_id: 'doc1' },
    );
    expect(out).toMatch(/\[End of content\. Read chars 16000-30000 of 30000 total\.\]$/);
  });

  it('reports end-of-content cleanly on the final page', () => {
    const body = 'y'.repeat(30_000);
    // First page: chars 0-16000 → more remains
    const page1 = applyTextPagination(body, 'docs_read', { offset: 0, limit: 16_000 }, { document_id: 'd' });
    expect(page1).toMatch(/14000 more chars remain/);
    // Second page: chars 16000-30000 → end of content
    const page2 = applyTextPagination(body, 'docs_read', { offset: 16_000, limit: 16_000 }, { document_id: 'd' });
    expect(page2).toMatch(/End of content/);
  });

  it('returns past-end notice when offset is past content length', () => {
    const body = 'short';
    const out = applyTextPagination(body, 'gmail_read', { offset: 1000 }, { message_id: 'abc' });
    expect(out).toMatch(/Requested offset \(1000\) is past the end/);
    expect(out).toMatch(/To read from the start: gmail_read\(message_id="abc"\)/);
  });

  it('default limit slices at ~20K chars when no limit given', () => {
    const body = 'z'.repeat(50_000);
    const out = applyTextPagination(body, 'drive_read', {}, { file_id: 'f1' });
    // Default limit 20000 → slice 20000 + trailer
    expect(out).toMatch(/Read chars 0-20000 of 50000 total/);
  });

  it('coerces string offset/limit to numbers (DeepSeek / weak models emit them as strings)', () => {
    const body = 'q'.repeat(50_000);
    const out = applyTextPagination(
      body,
      'gmail_read',
      // String values, what DeepSeek actually sends despite schema saying number
      { offset: '0' as unknown as number, limit: '200' as unknown as number },
      { message_id: 'abc' },
    );
    expect(out).toMatch(/Read chars 0-200 of 50000 total/);
    // Confirm only 200 chars of body returned (plus trailer).
    expect(out.length).toBeLessThan(500);
  });

  it('the own-page carve-out shows a page that slightly overshoots its tool\'s size whole', async () => {
    // A page within twice its tool's declared size keeps its trailer in sight, as before t200.
    await import('../../google/tools-read.js');
    const size = resultViewChars('gmail_read', 'x');
    const body = 'q'.repeat(Math.floor(size * 1.1)) + '\n\n[Read chars 0-18000 of 100000 total. 82000 more chars remain.\n To continue: gmail_read(message_id="x", offset=18000, limit=18000).]';
    expect(admit('gmail_read', body)).toEqual({ view: body, kept: false });
  });

  it('past twice its tool\'s size a page is kept whole and shown as its pointer, not cut', async () => {
    // Pre-2026-05-06 a tool that appended a pagination trailer could ship arbitrarily-large
    // content and bypass the engine cap entirely (a single-line 5.9MB HTML file). The 2x limit stays.
    await import('../../google/tools-read.js');
    const size = resultViewChars('gmail_read', 'x');
    const body = 'q'.repeat(size * 3) + '\n\n[Read chars 0-50000 of 100000 total. 50000 more chars remain.\n To continue: gmail_read(message_id="x", offset=50000, limit=50000).]';
    const out = admit('gmail_read', body);
    expect(out.kept).toBe(true);
    expect(out.view.length).toBeLessThan(body.length);
    expect(out.view).toContain('tool_result_read');
  });
});
