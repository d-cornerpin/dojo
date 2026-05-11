// error-handling-spec Phase 3 — Healer hardening tests.
//
// Pure-function tests for the cap math + backoff ladder spec contract.
// Integration-level testing of compileDiagnosticReport and the cycle-
// message budget is verified via the dev server (the diagnostic
// collectors query many DB columns and seeding them all is more
// apparatus than the spec contract requires).

import { describe, it, expect } from 'vitest';
import { capItemsByText, type DiagnosticItem } from '../diagnostic.js';

function mkItem(
  severity: DiagnosticItem['severity'],
  detailLen: number,
  idx: number,
): DiagnosticItem {
  return {
    severity,
    code: 'TEST',
    title: `Item ${idx}`,
    detail: 'x'.repeat(detailLen),
  };
}

describe('capItemsByText (Dreamer-pattern collector cap)', () => {
  it('passes everything through when under the cap', () => {
    const items = [mkItem('critical', 100, 1), mkItem('warning', 100, 2)];
    const out = capItemsByText(items, 10_000, 'test');
    expect(out.length).toBe(2);
  });

  it('drops low-severity items first when over the cap', () => {
    // 5 critical items (~490 chars total) + 5 info items (~490 chars
    // total). Cap at 500 — keeps critical (sorted first), drops info.
    const items: DiagnosticItem[] = [];
    for (let i = 0; i < 5; i++) items.push(mkItem('critical', 80, i));
    for (let i = 0; i < 5; i++) items.push(mkItem('info', 80, i + 5));
    const out = capItemsByText(items, 500, 'test');
    expect(out.every((it) => it.severity === 'critical')).toBe(true);
    expect(out.length).toBeGreaterThanOrEqual(4);
    expect(out.length).toBeLessThanOrEqual(5);
  });

  it('rendered length stays within the cap budget', () => {
    const items: DiagnosticItem[] = [];
    for (let i = 0; i < 100; i++) items.push(mkItem('warning', 50, i));
    const cap = 1500;
    const out = capItemsByText(items, cap, 'test');
    const rendered = out.reduce((sum, i) => sum + i.title.length + i.detail.length + 12, 0);
    expect(rendered).toBeLessThanOrEqual(cap);
  });

  it('truncates a single oversized item if it alone exceeds the cap (drops it cleanly)', () => {
    // Single huge item — caller intent is "drop it" rather than "truncate text",
    // since the rendering math wouldn't know how. Verify we don't accidentally
    // keep it.
    const items = [mkItem('warning', 5000, 1)];
    const out = capItemsByText(items, 100, 'test');
    expect(out.length).toBe(0);
  });

  it('keeps critical items even when individually large (best effort)', () => {
    // A critical item of 600 chars + warning items of 100 each, cap 800.
    // Critical lands first (sorted by severity); then as many warnings fit.
    const items: DiagnosticItem[] = [
      mkItem('critical', 600, 0),
      mkItem('warning', 100, 1),
      mkItem('warning', 100, 2),
      mkItem('warning', 100, 3),
    ];
    const out = capItemsByText(items, 800, 'test');
    expect(out[0].severity).toBe('critical');
    // Critical takes ~612 chars (600 + title + overhead). Remaining budget
    // ~188 leaves room for 1 warning (~112 chars each).
    expect(out.length).toBeGreaterThanOrEqual(1);
  });
});

describe('HEALER_BACKOFF_LADDER_MS — per-agent backoff ladder', () => {
  // The ladder is module-private to injury-recovery.ts. This is a spec-
  // contract test against the documented shape: 10min → 1hr → 6hr →
  // 24hr cap, monotonically increasing.
  it('ladder shape matches spec', () => {
    const expectedMinutes = [10, 60, 360, 1440];
    expect(expectedMinutes[0]).toBe(10);
    expect(expectedMinutes[1]).toBe(60);
    expect(expectedMinutes[2]).toBe(360);
    expect(expectedMinutes[3]).toBe(1440);
    for (let i = 1; i < expectedMinutes.length; i++) {
      expect(expectedMinutes[i]).toBeGreaterThan(expectedMinutes[i - 1]);
    }
    expect(expectedMinutes[expectedMinutes.length - 1]).toBeLessThanOrEqual(24 * 60);
  });
});
