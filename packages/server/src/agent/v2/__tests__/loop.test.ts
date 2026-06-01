import { describe, it, expect } from 'vitest';
import {
  canonicalToolSignature,
  loopDetector,
  RECENT_TOOL_WINDOW,
  MAX_REPEATS_BEFORE_BREAK,
} from '../classifiers/loop.js';
import type { ToolCall } from '@dojo/shared';

function tc(name: string, args: Record<string, unknown>, id = 'tc'): ToolCall {
  return { id, name, arguments: args };
}

describe('canonicalToolSignature', () => {
  it('produces a stable signature for the same op', () => {
    const sig1 = canonicalToolSignature('file_read', { path: '/foo/bar.ts' });
    const sig2 = canonicalToolSignature('file_read', { path: '/foo/bar.ts' });
    expect(sig1).toBe(sig2);
  });

  it('strips prose fields (caption, message, etc.)', () => {
    const sig1 = canonicalToolSignature('show_to_user', { file: 'a.png', caption: 'first try' });
    const sig2 = canonicalToolSignature('show_to_user', { file: 'a.png', caption: 'second try, with more words' });
    expect(sig1).toBe(sig2);
  });

  it('normalizes 6+ digit runs to *', () => {
    const sig1 = canonicalToolSignature('file_read', { path: '/tmp/render_1738422123_000.png' });
    const sig2 = canonicalToolSignature('file_read', { path: '/tmp/render_1738422999_000.png' });
    expect(sig1).toBe(sig2);
  });

  it('treats different paths as different sigs', () => {
    const sig1 = canonicalToolSignature('file_read', { path: '/foo/a.ts' });
    const sig2 = canonicalToolSignature('file_read', { path: '/foo/b.ts' });
    expect(sig1).not.toBe(sig2);
  });

  it('treats different tools as different sigs', () => {
    const sig1 = canonicalToolSignature('file_read', { path: '/foo/a.ts' });
    const sig2 = canonicalToolSignature('file_write', { path: '/foo/a.ts' });
    expect(sig1).not.toBe(sig2);
  });

  it('handles undefined arguments', () => {
    const sig = canonicalToolSignature('get_current_time', undefined);
    expect(sig).toBe('get_current_time:{}');
  });

  it('truncates long strings to a stable prefix (not a blob marker)', () => {
    // Pre-2026-05-06 this collapsed every long string to literal "<prose>",
    // which made every long exec command share a signature and trip the
    // loop detector after 3 unrelated calls. Now we keep a 60-char prefix
    // plus a length tag so distinct operations stay distinguishable.
    const sig1 = canonicalToolSignature('exec', {
      command: 'grep -n -i "invoice\\|closing" /Users/x/.dojo/techniques/some-technique/TECHNIQUE.md | head -40',
    });
    const sig2 = canonicalToolSignature('exec', {
      command: 'sed -i "" "s/Old/New/" /Users/x/.dojo/techniques/some-technique/TECHNIQUE.md',
    });
    const sig3 = canonicalToolSignature('exec', {
      command: 'python3 -c "import sys; print(\'hi\')" /Users/x/.dojo/techniques/some-technique/TECHNIQUE.md',
    });
    expect(sig1).not.toBe(sig2);
    expect(sig1).not.toBe(sig3);
    expect(sig2).not.toBe(sig3);
    // And the length tag is in there for stability
    expect(sig1).toMatch(/\[len=\d+\]/);
  });

  it('treats two identical long commands as the same signature (loop detector still works)', () => {
    const cmd = 'grep -rn "needle in a haystack" /very/long/path/to/somewhere/specific/in/the/repo';
    const sig1 = canonicalToolSignature('exec', { command: cmd });
    const sig2 = canonicalToolSignature('exec', { command: cmd });
    expect(sig1).toBe(sig2);
  });

  it('preserves number, boolean, null literally', () => {
    const sig = canonicalToolSignature('foo', { count: 5, flag: true, missing: null });
    expect(sig).toBe('foo:{"count":5,"flag":true,"missing":null}');
  });

  it('windows arrays to first 5 elements', () => {
    const sig1 = canonicalToolSignature('foo', { items: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] });
    const sig2 = canonicalToolSignature('foo', { items: ['a', 'b', 'c', 'd', 'e'] });
    expect(sig1).toBe(sig2);
  });

  it('sorts keys for stability', () => {
    const sig1 = canonicalToolSignature('foo', { z: 1, a: 2 });
    const sig2 = canonicalToolSignature('foo', { a: 2, z: 1 });
    expect(sig1).toBe(sig2);
  });

  it('strips the default prose fields for non-search tools', () => {
    // For ordinary tools, all of these fields are agent prose and get dropped
    // from the signature. v2.7.25 — `query` only stays in for search tools
    // (see test below); for everything else it's still stripped here so
    // ordinary tools that happen to accept a `query` field don't suddenly
    // start logging distinct sigs.
    const proseFields = ['caption', 'message', 'content', 'text', 'payload',
      'summary', 'description', 'query', 'reason', 'note', 'notes',
      'change_summary', 'instructions'];
    for (const field of proseFields) {
      const sig1 = canonicalToolSignature('some_non_search_tool', { path: '/x', [field]: 'value-A' });
      const sig2 = canonicalToolSignature('some_non_search_tool', { path: '/x', [field]: 'value-B' });
      expect(sig1).toBe(sig2);
    }
  });

  // v2.7.25 regression — vault_search with 4 different query phrasings was
  // collapsing to the same signature because `query` was in the global
  // PROSE_FIELDS set, so the 4th call tripped the 3-repeat loop detector.
  // For search tools, different queries are different operations.
  it('keeps `query` in signature for search tools (vault_search, web_search, gmail_search, etc.)', () => {
    const searchTools = [
      'vault_search', 'web_search', 'web_fetch', 'web_browse',
      'memory_grep', 'memory_describe', 'memory_expand',
      'gmail_search', 'outlook_search', 'calendar_search', 'calendar_search_ms',
      'drive_list', 'onedrive_search', 'contacts_search',
      'plaud_search_recordings', 'squad_recall', 'screen_read', 'technique_read',
    ];
    for (const tool of searchTools) {
      const sig1 = canonicalToolSignature(tool, { query: 'phrasing A' });
      const sig2 = canonicalToolSignature(tool, { query: 'phrasing B' });
      expect(sig1).not.toBe(sig2);
    }
  });

  it('still strips non-query prose fields (reason, note, etc.) for search tools', () => {
    // Search tools keep `query` but other prose fields still get dropped —
    // the agent shouldn't be able to disguise a duplicate call by passing
    // a different `reason` string.
    const sig1 = canonicalToolSignature('vault_search', { query: 'same query', reason: 'first try' });
    const sig2 = canonicalToolSignature('vault_search', { query: 'same query', reason: 'second try' });
    expect(sig1).toBe(sig2);
  });
});

describe('loopDetector', () => {
  it('returns ok for the first call', () => {
    const result = loopDetector(tc('file_read', { path: '/foo' }), []);
    expect(result.decision).toBe('ok');
    expect(result.repeatCount).toBe(1);
  });

  it('returns ok for the second call', () => {
    const sig = canonicalToolSignature('file_read', { path: '/foo' });
    const result = loopDetector(tc('file_read', { path: '/foo' }), [sig]);
    expect(result.decision).toBe('ok');
    expect(result.repeatCount).toBe(2);
  });

  it('returns ok for the third call (threshold not yet hit)', () => {
    const sig = canonicalToolSignature('file_read', { path: '/foo' });
    const result = loopDetector(tc('file_read', { path: '/foo' }), [sig, sig]);
    expect(result.decision).toBe('ok');
    expect(result.repeatCount).toBe(3);
  });

  it('blocks the FOURTH call (3 prior + this one = exceeds threshold)', () => {
    const sig = canonicalToolSignature('file_read', { path: '/foo' });
    const result = loopDetector(tc('file_read', { path: '/foo' }), [sig, sig, sig]);
    expect(result.decision).toBe('block');
    expect(result.repeatCount).toBe(4);
    expect(result.refusalMessage).toContain('STOP');
    expect(result.refusalMessage).toContain('file_read');
  });

  it('does not block when sigs are different and tool count is under MAX_SAME_TOOL_CALLS', () => {
    const sigs = [
      canonicalToolSignature('file_read', { path: '/a' }),
      canonicalToolSignature('file_read', { path: '/b' }),
      canonicalToolSignature('file_read', { path: '/c' }),
    ];
    const result = loopDetector(tc('file_read', { path: '/d' }), sigs);
    expect(result.decision).toBe('ok');
  });

  // Regression: legitimate batch operations (e.g. update_agent_profile run
  // against N sub-agents in a row) must NOT be blocked. Each call has
  // distinct args so the per-signature 3-strike check doesn't fire. The
  // blanket same-tool threshold I added in v2.2.2 was too coarse and
  // killed real work — removed in 2026-05-06.
  it('does not block legitimate batch operations across many sub-agents', () => {
    const sigs = [
      canonicalToolSignature('update_agent_profile', { agent_id: 'a1', name: 'Alpha' }),
      canonicalToolSignature('update_agent_profile', { agent_id: 'a2', name: 'Beta' }),
      canonicalToolSignature('update_agent_profile', { agent_id: 'a3', name: 'Gamma' }),
      canonicalToolSignature('update_agent_profile', { agent_id: 'a4', name: 'Delta' }),
      canonicalToolSignature('update_agent_profile', { agent_id: 'a5', name: 'Epsilon' }),
    ];
    // 6th distinct call to update_agent_profile — must NOT be blocked.
    const result = loopDetector(
      tc('update_agent_profile', { agent_id: 'a6', name: 'Zeta' }),
      sigs,
    );
    expect(result.decision).toBe('ok');
  });

  it('does not block exploratory tool calls with distinct args', () => {
    // Memory grep with 5 different patterns — was previously blocked by the
    // same-tool threshold. After removing that, this is allowed. The proper
    // remedy for memory_grep thrashing is the v2.2.2 fix that gives results
    // their IDs + a copy-pasteable memory_describe(id="…") hint, so the
    // agent has a clean recovery path instead of needing to thrash.
    const sigs = [
      canonicalToolSignature('memory_grep', { pattern: 'Deck Brief — Pulse Analytics' }),
      canonicalToolSignature('memory_grep', { pattern: 'Deck Brief.*Pulse Analytics' }),
      canonicalToolSignature('memory_grep', { pattern: 'DECK BRIEF.*Pulse Analytics' }),
      canonicalToolSignature('memory_grep', { pattern: 'PITCH_KEY_LINE' }),
      canonicalToolSignature('memory_grep', { pattern: 'Pulse Analytics.*COVER' }),
    ];
    const result = loopDetector(
      tc('memory_grep', { pattern: 'Brand launch campaign.*Pulse' }),
      sigs,
    );
    expect(result.decision).toBe('ok');
  });

  // v2.7.25 regression — David reported a vault_search sweep getting
  // blocked: 4 related-but-distinct phrasings hit the 3-repeat threshold
  // because the global PROSE_FIELDS set dropped `query` from the
  // signature. For search tools query is the operation; this test pins
  // the fix so it doesn't regress.
  it('does not block vault_search with distinct query phrasings (the user-reported case)', () => {
    const sigs = [
      canonicalToolSignature('vault_search', { query: 'iMessage delivery issues communication protocol', mode: 'semantic' }),
      canonicalToolSignature('vault_search', { query: 'imessage protocol reply send delivery failure bridge', mode: 'semantic' }),
      canonicalToolSignature('vault_search', { query: 'iMessage delivery failure broken bridge troubleshooting not receiving replies', mode: 'semantic' }),
    ];
    const result = loopDetector(
      tc('vault_search', { query: 'inbound iMessage from David gets an imessage_send', mode: 'semantic' }),
      sigs,
    );
    expect(result.decision).toBe('ok');
  });

  it('STILL blocks vault_search when the EXACT same query is repeated 4+ times', () => {
    // Loop detection should still catch a true loop — same query, same
    // mode, over and over. The fix only opens up DISTINCT phrasings.
    const sig = canonicalToolSignature('vault_search', { query: 'identical query', mode: 'semantic' });
    const result = loopDetector(
      tc('vault_search', { query: 'identical query', mode: 'semantic' }),
      [sig, sig, sig],
    );
    expect(result.decision).toBe('block');
  });

  it('exposes constants matching v1', () => {
    expect(RECENT_TOOL_WINDOW).toBe(8);
    expect(MAX_REPEATS_BEFORE_BREAK).toBe(3);
  });
});
