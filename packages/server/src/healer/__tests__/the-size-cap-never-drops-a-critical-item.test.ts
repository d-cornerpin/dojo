// capItemsByText must never drop a critical item: critical items are kept
// even when, alone, they exceed the char budget; the lower severities of the
// same check are what get dropped to make room.

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

describe('capItemsByText never drops a critical item', () => {
  it('keeps every critical item even when they alone exceed the cap', () => {
    // 20 critical items of 300 chars (~320 chars each) blow the 1000 budget,
    // but a critical item is never the one dropped.
    const items: DiagnosticItem[] = [];
    for (let i = 0; i < 20; i++) items.push(mkItem('critical', 300, i));
    const out = capItemsByText(items, 1000, 'test');
    expect(out.length).toBe(20);
    expect(out.every((i) => i.severity === 'critical')).toBe(true);
  });

  it('keeps all criticals and drops the non-criticals that would pass the cap', () => {
    // 5 critical of 100 chars (~590 total) fit; the 10 info of 100 chars that
    // follow cannot fit, so none of them is kept.
    const items: DiagnosticItem[] = [];
    for (let i = 0; i < 5; i++) items.push(mkItem('critical', 100, i));
    for (let i = 0; i < 10; i++) items.push(mkItem('info', 100, i + 5));
    const cap = 700;
    const out = capItemsByText(items, cap, 'test');
    expect(out.filter((i) => i.severity === 'critical').length).toBe(5);
    expect(out.every((i) => i.severity === 'critical')).toBe(true);
    const rendered = out.reduce((sum, i) => sum + i.title.length + i.detail.length + 12, 0);
    expect(rendered).toBeLessThanOrEqual(cap);
  });

  it('keeps criticals even when their total alone exceeds the cap, dropping all warnings', () => {
    // 2 critical of 600 chars (~1236 total) blow the 800 budget on their own,
    // so no warning that follows can fit — but both criticals still come back.
    const items: DiagnosticItem[] = [
      mkItem('critical', 600, 0),
      mkItem('critical', 600, 1),
      mkItem('warning', 50, 2),
      mkItem('warning', 50, 3),
      mkItem('warning', 50, 4),
    ];
    const out = capItemsByText(items, 800, 'test');
    expect(out.length).toBe(2);
    expect(out.every((i) => i.severity === 'critical')).toBe(true);
  });

  it('passes everything through unchanged when under the cap', () => {
    const items: DiagnosticItem[] = [
      mkItem('info', 100, 1),
      mkItem('critical', 100, 2),
      mkItem('warning', 100, 3),
    ];
    const out = capItemsByText(items, 10_000, 'test');
    expect(out.length).toBe(3);
    expect(out.map((i) => i.severity)).toEqual(['info', 'critical', 'warning']);
  });
});
