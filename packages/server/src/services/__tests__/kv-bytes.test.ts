// v3.5 — PIN: the per-token KV arithmetic in `kv-bytes.ts`, shared by `num-ctx-calculator.ts`
// and the memory-fit gate (`agent/local-model-fit.ts`). Pure: no Ollama, no fetch. An error here
// either OOMs a small Mac (too low) or needlessly shrinks the window (too high), so the numbers below
// are pinned, not re-derived.
import { describe, it, expect } from 'vitest';
import { kvBytesPerTokenOf } from '../kv-bytes.js';

type Result = number | { reason: string };
const isReason = (r: Result): r is { reason: string } => typeof r !== 'number';

describe('kvBytesPerTokenOf', () => {
  it('a grouped-query model: 2 × block_count × kv_heads × head_dim × 2 bytes', () => {
    const r = kvBytesPerTokenOf(
      {
        'llama.block_count': 32,
        'llama.attention.head_count': 32,
        'llama.attention.head_count_kv': 8,
        'llama.embedding_length': 4096,
      },
      'llama',
    );
    // head_dim = 4096/32 = 128; 2 × 32 × 8 × 128 × 2.
    expect(r).toBe(131072);
  });

  it('no head_count_kv field falls back to full attention (head_count)', () => {
    const r = kvBytesPerTokenOf(
      { 'x.block_count': 2, 'x.attention.head_count': 4, 'x.embedding_length': 8 },
      'x',
    );
    // kv_heads = 4 (the full head_count); head_dim = 8/4 = 2; 2 × 2 × 4 × 2 × 2.
    expect(r).toBe(64);
  });

  it('a head_count_kv of 0 also falls back to full attention (never zero heads)', () => {
    const r = kvBytesPerTokenOf(
      { 'x.block_count': 2, 'x.attention.head_count': 4, 'x.attention.head_count_kv': 0, 'x.embedding_length': 8 },
      'x',
    );
    expect(r).toBe(64);
  });

  it('missing required fields return a reason that names block_count', () => {
    const r = kvBytesPerTokenOf({}, 'llama');
    expect(isReason(r)).toBe(true);
    expect(r.reason).toMatch(/block_count/);
  });

  it('a non-numeric block_count returns a reason, never a number', () => {
    const r = kvBytesPerTokenOf(
      { 'llama.block_count': '32', 'llama.attention.head_count': 32, 'llama.embedding_length': 4096 },
      'llama',
    );
    expect(isReason(r)).toBe(true);
    expect(r.reason).toMatch(/block_count/);
  });

  it('a zero head_count returns { reason: "head_count is zero" }', () => {
    const r = kvBytesPerTokenOf(
      { 'llama.block_count': 32, 'llama.attention.head_count': 0, 'llama.embedding_length': 4096 },
      'llama',
    );
    expect(r).toEqual({ reason: 'head_count is zero' });
  });

  it('a negative block_count returns a reason, never a number', () => {
    const r = kvBytesPerTokenOf(
      { 'llama.block_count': -1, 'llama.attention.head_count': 4, 'llama.embedding_length': 8 },
      'llama',
    );
    expect(isReason(r)).toBe(true);
    expect(r.reason).toMatch(/non-positive or NaN/);
  });

  it('a NaN embedding length returns a reason, never a number', () => {
    const r = kvBytesPerTokenOf(
      { 'llama.block_count': 32, 'llama.attention.head_count': 4, 'llama.embedding_length': NaN },
      'llama',
    );
    expect(isReason(r)).toBe(true);
    expect(r.reason).toMatch(/non-positive or NaN/);
  });

  it('honours the architecture prefix: qwen2 fields, not the unrelated llama fields', () => {
    const r = kvBytesPerTokenOf(
      {
        'llama.block_count': 32,
        'llama.attention.head_count': 32,
        'llama.attention.head_count_kv': 8,
        'llama.embedding_length': 4096,
        'qwen2.block_count': 10,
        'qwen2.attention.head_count': 10,
        'qwen2.attention.head_count_kv': 2,
        'qwen2.embedding_length': 512,
      },
      'qwen2',
    );
    // 2 × 10 × 2 × (512/10) × 2 — the llama.* fields would have given 131072.
    expect(r).toBe(4096);
  });

  it('does not read another arch\'s fields: qwen2 with only llama fields is a missing-fields reason', () => {
    const r = kvBytesPerTokenOf(
      {
        'llama.block_count': 32,
        'llama.attention.head_count': 32,
        'llama.attention.head_count_kv': 8,
        'llama.embedding_length': 4096,
      },
      'qwen2',
    );
    expect(isReason(r)).toBe(true);
    expect(r.reason).toMatch(/qwen2/);
  });
});
