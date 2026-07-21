// Phase 3 (2026-05-04), per-tool result cap enforcement tests.
//
// `applyMaxResultTokensCap` is the post-processing step that runs at the
// end of executeTool for any tool whose definition declares
// `maxResultTokens`. When the content exceeds the cap (using a 4 char/token
// approximation), the result is truncated and a trailer appended telling
// the agent how to paginate.
//
// These tests cover the cap behavior in isolation. Live verification of
// the integration with executeTool happens via dev-test-tools.

import { describe, it, expect } from 'vitest';
import { applyMaxResultTokensCap, applyTextPagination } from '../tools.js';

describe('applyMaxResultTokensCap', () => {
  it('returns content unchanged when under the cap', () => {
    const small = 'just a small result';
    expect(applyMaxResultTokensCap('file_read', small)).toBe(small);
  });

  it('returns content unchanged for tools without maxResultTokens set', () => {
    // file_write has no maxResultTokens, should never truncate.
    const huge = 'x'.repeat(100_000);
    expect(applyMaxResultTokensCap('file_write', huge)).toBe(huge);
  });

  it('truncates file_read output above 60000 tokens (~240000 chars)', () => {
    // e465cf2 (2026-05-22, v2.7.2): file_read cap raised 8000 → 60000 tokens
    // so a typical document lands in one call on modern context windows.
    const huge = 'x'.repeat(250_000);
    const out = applyMaxResultTokensCap('file_read', huge);
    expect(out.length).toBeLessThanOrEqual(60000 * 4);
    expect(out).toMatch(/\[Truncated by engine: returned ~60000 tokens of/);
    // file_read has pagination, so the trailer suggests offset/limit (not the
    // generic "narrow your query" message).
    expect(out).toMatch(/Re-call with offset\/limit/);
  });

  it('uses narrow-your-query guidance for tools without pagination', () => {
    // web_search has a cap but no offset/limit, trailer should NOT suggest it.
    const huge = 'w'.repeat(20_000);
    const out = applyMaxResultTokensCap('web_search', huge);
    expect(out).toMatch(/Narrow your query/);
    expect(out).not.toMatch(/offset\/limit/);
  });

  it('truncates exec output above 32000 tokens', () => {
    // e465cf2 (2026-05-22, v2.7.2): exec cap raised 4000 → 32000 tokens so
    // logs/grep/JSON dumps stop forcing `| head -N` workarounds.
    const huge = 'a'.repeat(150_000);
    const out = applyMaxResultTokensCap('exec', huge);
    expect(out.length).toBeLessThanOrEqual(32000 * 4);
    expect(out).toMatch(/\[Truncated by engine: returned ~32000 tokens/);
  });

  it('truncates web_fetch output above 2000 tokens (Phase 3.5: tightened from 6K → 2K when prompt extraction returns)', () => {
    const huge = 'b'.repeat(30_000);
    const out = applyMaxResultTokensCap('web_fetch', huge);
    expect(out.length).toBeLessThanOrEqual(2000 * 4);
    expect(out).toMatch(/\[Truncated by engine: returned ~2000 tokens/);
  });

  it('truncates web_search output above 3000 tokens', () => {
    const huge = 'c'.repeat(15_000);
    const out = applyMaxResultTokensCap('web_search', huge);
    expect(out.length).toBeLessThanOrEqual(3000 * 4);
  });

  it('truncates history_search output above 4000 tokens', () => {
    const huge = 'd'.repeat(20_000);
    const out = applyMaxResultTokensCap('history_search', huge);
    expect(out.length).toBeLessThanOrEqual(4000 * 4);
  });

  it('does not touch unknown tools', () => {
    const huge = 'e'.repeat(50_000);
    expect(applyMaxResultTokensCap('made_up_tool', huge)).toBe(huge);
  });

  it('reports an approximate original token count in the trailer', () => {
    const huge = 'x'.repeat(400_000); // ~100K tokens, over file_read's 60K cap
    const out = applyMaxResultTokensCap('file_read', huge);
    expect(out).toMatch(/of ~100000 total/);
  });

  it('Phase 3.5, does not re-truncate content that already has a friendly file_read trailer', () => {
    // The v2 file_read path appends its own pagination trailer
    // ("[Read lines 0-2000 of 4280 total. To continue: file_read(...)]")
    // when it returns less than the full file. The generic engine cap
    // must NOT re-truncate that output and replace the friendly trailer
    // with a generic one, the per-tool guidance is more useful.
    // Exceeds file_read's 60K-token (240K-char) budget on its own, but stays
    // under the 2x hard-overshoot cutoff (480K chars) so the carve-out
    // actually executes. (Was 40K chars, vacuous once e465cf2 raised the cap.)
    const body = 'x'.repeat(300_000);
    const friendly =
      body +
      '\n\n[Read lines 0-2000 of 4280 total. 2280 more lines remain.\n' +
      ' To continue: file_read(path="/x", offset=2000, limit=2000).\n' +
      ' To search for specific content: use grep instead.]';
    const out = applyMaxResultTokensCap('file_read', friendly);
    // Output unchanged, the friendly trailer was preserved.
    expect(out).toBe(friendly);
    expect(out).not.toMatch(/\[Truncated by engine/);
  });

  it('Phase 3.5, does not re-truncate content with end-of-file trailer', () => {
    // Over the 240K-char budget, under the 480K 2x cutoff (see above).
    const body = 'y'.repeat(300_000);
    const friendly = body + '\n\n[End of file. Read lines 100-180 of 180 total.]';
    const out = applyMaxResultTokensCap('file_read', friendly);
    expect(out).toBe(friendly);
  });

  it('Phase 3.5, registered cross-file caps work (Google/MS tools)', async () => {
    // Importing google/tools-read.ts triggers its registerMaxResultTokens
    // calls. After import, gmail_read should have a registered cap (4K)
    // even though it's not in agent/tools.ts toolDefinitions.
    await import('../../google/tools-read.js');
    const huge = 'g'.repeat(20_000); // ~5K tokens, exceeds 4K cap
    const out = applyMaxResultTokensCap('gmail_read', huge);
    expect(out.length).toBeLessThanOrEqual(4000 * 4);
    expect(out).toMatch(/\[Truncated by engine: returned ~4000 tokens/);
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

  it('engine cap carve-out preserves the pagination trailer on minor overshoots', () => {
    // applyMaxResultTokensCap should NOT re-truncate content with the new
    // pagination trailer pattern when overshoot is minor (≤ 2x budget).
    // gmail_read cap is 4000 tokens ≈ 16K char budget, body of 18K chars
    // is a 1.13x overshoot, well under the 2x hard-overshoot cutoff.
    const body = 'q'.repeat(18_000) + '\n\n[Read chars 0-18000 of 100000 total. 82000 more chars remain.\n To continue: gmail_read(message_id="x", offset=18000, limit=18000).]';
    const out = applyMaxResultTokensCap('gmail_read', body);
    expect(out).toBe(body);
    expect(out).not.toMatch(/Truncated by engine/);
  });

  it('engine cap overrides the trailer carve-out on hard overshoot (>2x budget)', () => {
    // Pre-2026-05-06 a tool that appended a pagination trailer could ship
    // arbitrarily-large content and bypass the engine cap entirely. file_read
    // hit this path with a single-line 5.9MB HTML file: per-line cap missing,
    // self-cap bypassed, trailer appended, generic cap skipped, model context
    // blown. New behavior: when content is >2x the budget, the trailer
    // carve-out doesn't save it.
    const body = 'q'.repeat(50_000) + '\n\n[Read chars 0-50000 of 100000 total. 50000 more chars remain.\n To continue: gmail_read(message_id="x", offset=50000, limit=50000).]';
    const out = applyMaxResultTokensCap('gmail_read', body);
    expect(out.length).toBeLessThan(body.length);
    expect(out).toMatch(/Truncated by engine/);
  });
});
