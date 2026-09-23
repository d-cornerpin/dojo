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

  // 2026-09-22 OWNER RULING — this assertion is INVERTED on purpose. It used to
  // read "strips prose fields (caption, message, etc.)". The prose allow-list is
  // deleted: a different caption is a different ask, and the allow-list is what
  // collapsed five distinct `user_gmail_search` date ranges into one signature on
  // the owner's box. Re-running the same operation under varied prose is caught by
  // the thrash ladder's DRIFT arms, not by pretending the args were equal.
  it('does NOT strip prose fields — a different caption is a different call', () => {
    const sig1 = canonicalToolSignature('show_to_user', { file: 'a.png', caption: 'first try' });
    const sig2 = canonicalToolSignature('show_to_user', { file: 'a.png', caption: 'second try, with more words' });
    expect(sig1).not.toBe(sig2);
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
    // And the length tag is in there for stability, now carrying a digest of the
    // WHOLE value so two long strings with the same head AND the same length are
    // still distinguishable (see the 500-char tail test below).
    expect(sig1).toMatch(/\[len=\d+#[0-9a-f]{8}\]/);
  });

  // 2026-09-22 OWNER RULING (2c): "reasonable length-capping that still
  // distinguishes distinct values — e.g. hash long values, never drop them."
  // The pre-fix form was `head…[len=N]`, so two 500-char queries sharing a
  // 60-char head and a length were ONE signature. They are two asks.
  it('caps long values without collapsing them: two 500-char values differing at the TAIL stay distinct', () => {
    const head = 'x'.repeat(480);
    const a = `${head}${'a'.repeat(20)}`;
    const b = `${head}${'b'.repeat(20)}`;
    expect(a.length).toBe(500);
    expect(b.length).toBe(500);
    const sigA = canonicalToolSignature('user_gmail_search', { query: a });
    const sigB = canonicalToolSignature('user_gmail_search', { query: b });
    expect(sigA).not.toBe(sigB);
    // …and the cap is still doing its job: the signature is nowhere near 500 chars
    // of value, so a long arg cannot blow up a log line or a steer message.
    expect(sigA.length).toBeLessThan(200);
  });

  it('folds an over-long array TAIL into the digest instead of dropping it', () => {
    const sig1 = canonicalToolSignature('foo', { items: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] });
    const sig2 = canonicalToolSignature('foo', { items: ['a', 'b', 'c', 'd', 'e', 'f', 'z'] });
    expect(sig1).not.toBe(sig2);
  });

  // The structural guarantee the thrash gate's message now rests on: it may say
  // "you already have the result" only because a signature match IS full-args
  // identity. If a key can vanish from the signature, that sentence becomes a lie
  // again — which is the defect the owner hit.
  it('⚠ EVERY ARGUMENT KEY APPEARS IN THE SIGNATURE (no allow-list, no exceptions)', () => {
    const args: Record<string, unknown> = {
      caption: 'c', message: 'm', content: 'k', text: 't', payload: 'p',
      summary: 's', description: 'd', query: 'q', reason: 'r', note: 'n',
      notes: 'nn', change_summary: 'cs', instructions: 'i',
      path: '/x', max_results: 40, flag: true, nothing: null,
      items: [1, 2], nested: { a: 1 },
    };
    for (const tool of ['show_to_user', 'user_gmail_search', 'gmail_search', 'file_append', 'some_tool_nobody_classified']) {
      const sig = canonicalToolSignature(tool, args);
      const missing = Object.keys(args).filter((k) => !sig.includes(`"${k}":`));
      expect(missing, `${tool} dropped arg key(s): ${missing.join(', ')}`).toEqual([]);
    }
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

  it('keeps an array head verbatim and bounds the rest (a 7-item array is not a 5-item one)', () => {
    const sig1 = canonicalToolSignature('foo', { items: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] });
    const sig2 = canonicalToolSignature('foo', { items: ['a', 'b', 'c', 'd', 'e'] });
    expect(sig1).not.toBe(sig2);
    expect(sig2).toBe('foo:{"items":["a","b","c","d","e"]}');
  });

  it('sorts keys for stability', () => {
    const sig1 = canonicalToolSignature('foo', { z: 1, a: 2 });
    const sig2 = canonicalToolSignature('foo', { a: 2, z: 1 });
    expect(sig1).toBe(sig2);
  });

  // The INVERSE of the old "strips the default prose fields for non-search tools".
  // Each of the 13 names below was on v1's PROSE_FIELDS allow-list. A tool NOBODY
  // classified — which is what `user_gmail_search` was — must distinguish all of
  // them, because there is no classification step left to miss.
  it('⚠ AN UNCLASSIFIED TOOL DISTINGUISHES EVERY FORMER PROSE FIELD', () => {
    const formerProseFields = ['caption', 'message', 'content', 'text', 'payload',
      'summary', 'description', 'query', 'reason', 'note', 'notes',
      'change_summary', 'instructions'];
    for (const field of formerProseFields) {
      const sig1 = canonicalToolSignature('some_tool_nobody_classified', { path: '/x', [field]: 'value-A' });
      const sig2 = canonicalToolSignature('some_tool_nobody_classified', { path: '/x', [field]: 'value-B' });
      expect(sig1, `${field} collapsed on an unclassified tool`).not.toBe(sig2);
    }
  });

  // v2.7.25's regression test, kept and WIDENED. It used to enumerate the 26
  // members of SEARCH_TOOLS — the carve-out set that had to be remembered. The
  // `user_`-prefixed twins were never in it, which is the 2026-09-22 defect, so
  // the list now includes them and the canonical names are checked for the same
  // property by the same rule rather than by membership.
  it('keeps `query` in the signature for every search tool AND its user_ twin', () => {
    const searchTools = [
      'vault_search', 'web_search', 'web_fetch', 'web_browse',
      'history_search', 'history_get', 'history_expand',
      'gmail_search', 'outlook_search', 'calendar_search', 'calendar_search_ms',
      'drive_list', 'onedrive_search', 'contacts_search',
      'plaud_search_recordings', 'squad_recall', 'screen_screenshot', 'technique_read',
      // The twins — runtime-generated, in no carve-out set, and the family the
      // old registry-exhaustive scan was structurally blind to.
      'user_gmail_search', 'user_outlook_search', 'user_calendar_search', 'user_drive_list',
    ];
    for (const tool of searchTools) {
      const sig1 = canonicalToolSignature(tool, { query: 'phrasing A' });
      const sig2 = canonicalToolSignature(tool, { query: 'phrasing B' });
      expect(sig1, `${tool} collapsed two distinct queries`).not.toBe(sig2);
    }
  });

  it('a different `reason` on the same search is also a different call now', () => {
    // Inverted from "still strips non-query prose fields for search tools". The
    // old worry was an agent disguising a duplicate by varying `reason`; the
    // measured cost of guarding against it was refusing real work, and the drift
    // arms of the thrash ladder catch signature-varying dodges by design.
    const sig1 = canonicalToolSignature('vault_search', { query: 'same query', reason: 'first try' });
    const sig2 = canonicalToolSignature('vault_search', { query: 'same query', reason: 'second try' });
    expect(sig1).not.toBe(sig2);
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

  // Regression: legitimate batch operations (e.g. update_agent run
  // against N sub-agents in a row) must NOT be blocked. Each call has
  // distinct args so the per-signature 3-strike check doesn't fire. The
  // blanket same-tool threshold I added in v2.2.2 was too coarse and
  // killed real work, removed in 2026-05-06.
  it('does not block legitimate batch operations across many sub-agents', () => {
    const sigs = [
      canonicalToolSignature('update_agent', { agent_id: 'a1', name: 'Alpha' }),
      canonicalToolSignature('update_agent', { agent_id: 'a2', name: 'Beta' }),
      canonicalToolSignature('update_agent', { agent_id: 'a3', name: 'Gamma' }),
      canonicalToolSignature('update_agent', { agent_id: 'a4', name: 'Delta' }),
      canonicalToolSignature('update_agent', { agent_id: 'a5', name: 'Epsilon' }),
    ];
    // 6th distinct call to update_agent, must NOT be blocked.
    const result = loopDetector(
      tc('update_agent', { agent_id: 'a6', name: 'Zeta' }),
      sigs,
    );
    expect(result.decision).toBe('ok');
  });

  it('does not block exploratory tool calls with distinct args', () => {
    // Memory grep with 5 different patterns, was previously blocked by the
    // same-tool threshold. After removing that, this is allowed. The proper
    // remedy for history_search thrashing is the v2.2.2 fix that gives results
    // their IDs + a copy-pasteable history_get(id="…") hint, so the
    // agent has a clean recovery path instead of needing to thrash.
    const sigs = [
      canonicalToolSignature('history_search', { pattern: 'Deck Brief, Pulse Analytics' }),
      canonicalToolSignature('history_search', { pattern: 'Deck Brief.*Pulse Analytics' }),
      canonicalToolSignature('history_search', { pattern: 'DECK BRIEF.*Pulse Analytics' }),
      canonicalToolSignature('history_search', { pattern: 'PITCH_KEY_LINE' }),
      canonicalToolSignature('history_search', { pattern: 'Pulse Analytics.*COVER' }),
    ];
    const result = loopDetector(
      tc('history_search', { pattern: 'Brand launch campaign.*Pulse' }),
      sigs,
    );
    expect(result.decision).toBe('ok');
  });

  // v2.7.25 regression, the owner reported a vault_search sweep getting
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
      tc('vault_search', { query: 'inbound iMessage from Alex gets an imessage_send', mode: 'semantic' }),
      sigs,
    );
    expect(result.decision).toBe('ok');
  });

  it('STILL blocks vault_search when the EXACT same query is repeated 4+ times', () => {
    // Loop detection should still catch a true loop, same query, same
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
