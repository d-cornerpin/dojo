import { describe, it, expect } from 'vitest';
import {
  compactionGate,
  WARN_THRESHOLD,
  COMPACT_THRESHOLD,
  BLOCK_THRESHOLD,
} from '../classifiers/compaction.js';

describe('compactionGate', () => {
  const cw = 200000;

  it('returns noop well under threshold', () => {
    const r = compactionGate(50000, cw);
    expect(r.decision).toBe('noop');
    expect(r.ratio).toBeCloseTo(0.25, 2);
  });

  it('returns noop at exactly 89%', () => {
    const r = compactionGate(Math.floor(cw * 0.89), cw);
    expect(r.decision).toBe('noop');
  });

  it('returns warn at 90%', () => {
    const r = compactionGate(Math.floor(cw * 0.90), cw);
    expect(r.decision).toBe('warn');
    expect(r.reason).toContain('Part XVIII');
  });

  it('returns warn at 95%', () => {
    const r = compactionGate(Math.floor(cw * 0.95), cw);
    expect(r.decision).toBe('warn');
  });

  it('returns compact at 96%', () => {
    const r = compactionGate(Math.floor(cw * 0.96), cw);
    expect(r.decision).toBe('compact');
    expect(r.reason).toContain('Emergency');
  });

  it('returns compact at 98%', () => {
    const r = compactionGate(Math.floor(cw * 0.98), cw);
    expect(r.decision).toBe('compact');
  });

  it('returns block at 99%', () => {
    const r = compactionGate(Math.floor(cw * 0.99), cw);
    expect(r.decision).toBe('block');
    expect(r.reason).toContain('impossibly full');
  });

  it('returns block above 99%', () => {
    const r = compactionGate(Math.floor(cw * 1.05), cw);
    expect(r.decision).toBe('block');
  });

  it('handles invalid contextWindow gracefully', () => {
    const r = compactionGate(10000, 0);
    expect(r.decision).toBe('noop');
    expect(r.reason).toContain('invalid contextWindow');
  });

  it('exposes thresholds for documentation', () => {
    expect(WARN_THRESHOLD).toBe(0.90);
    expect(COMPACT_THRESHOLD).toBe(0.96);
    expect(BLOCK_THRESHOLD).toBe(0.99);
  });
});
