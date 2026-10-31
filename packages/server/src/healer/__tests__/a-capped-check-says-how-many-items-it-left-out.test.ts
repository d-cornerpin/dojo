// P3: the Healer report never silently drops items. A check that leaves items out shows one visible line saying how many.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { capItemsShowingOmissions, type DiagnosticItem } from '../diagnostic.js';

const mk = (severity: DiagnosticItem['severity'], i: number): DiagnosticItem =>
  ({ severity, code: 'T', title: `Item ${i}`, detail: 'x'.repeat(80) });

describe('a capped check says how many items it left out', () => {
  it('adds one visible line naming the count when items were dropped', () => {
    const items = [mk('critical', 0), ...Array.from({ length: 10 }, (_, i) => mk('info', i + 1))];
    const out = capItemsShowingOmissions(items, 300, 'error_digest');
    const kept = out.filter((i) => i.code !== 'items_left_out');
    const notes = out.filter((i) => i.code === 'items_left_out');
    expect(notes).toHaveLength(1);
    expect(notes[0].detail + notes[0].title).toContain(String(items.length - kept.length));
    expect(notes[0].title).toMatch(/left out/i);
  });
  it('adds nothing when nothing was dropped', () => {
    const out = capItemsShowingOmissions([mk('warning', 1)], 10_000, 'x');
    expect(out).toHaveLength(1);
  });
  it('WIRE: every collector in the report goes through the visible version', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'diagnostic.ts'), 'utf8');
    const compile = src.slice(src.indexOf('export function compileDiagnosticReport'));
    expect(compile.slice(0, compile.indexOf('// Sort:'))).not.toContain('capItemsByText(');
  });
});
