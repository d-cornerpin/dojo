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

  it('replaces long strings with <prose>', () => {
    const longString = 'x'.repeat(100);
    const sig = canonicalToolSignature('foo', { some_param: longString });
    expect(sig).toContain('<prose>');
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

  it('matches v1 runtime.ts behavior: prose fields list', () => {
    // Verifying the exact prose field set from v1 runtime.ts:255-259 is stripped
    const proseFields = ['caption', 'message', 'content', 'text', 'payload',
      'summary', 'description', 'query', 'reason', 'note', 'notes',
      'change_summary', 'instructions'];
    for (const field of proseFields) {
      const sig1 = canonicalToolSignature('foo', { path: '/x', [field]: 'value-A' });
      const sig2 = canonicalToolSignature('foo', { path: '/x', [field]: 'value-B' });
      expect(sig1).toBe(sig2);
    }
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

  it('does not block when sigs are different despite many calls', () => {
    const sigs = [
      canonicalToolSignature('file_read', { path: '/a' }),
      canonicalToolSignature('file_read', { path: '/b' }),
      canonicalToolSignature('file_read', { path: '/c' }),
    ];
    const result = loopDetector(tc('file_read', { path: '/d' }), sigs);
    expect(result.decision).toBe('ok');
  });

  it('exposes constants matching v1', () => {
    expect(RECENT_TOOL_WINDOW).toBe(8);
    expect(MAX_REPEATS_BEFORE_BREAK).toBe(3);
  });
});
