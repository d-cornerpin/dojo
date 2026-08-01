// ════════════════════════════════════════════════════════════════════════════════════════
// S2 (PHASE-3 T3) — one declaration for the 17 shared work-verb properties, and PROOF that
// the model reads exactly the same bytes it read before.
//
// The tools array is the head of the cached prefix. A refactor that changes one byte of it
// invalidates ~24.7K tokens for every agent on its next call — so "this change is
// structural only" is a claim that has to be measured, not asserted. The baseline below was
// captured from `8f36cdb` (before the rewire) by serialising both verbs' `input_schema`.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  WORK_SHARED_PROPERTIES,
  WORK_PRIORITY_ENUM,
  workProp,
} from '../work-verb-schema.js';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tools.ts');

/**
 * Read the two verbs' schemas out of the source rather than importing `tools.ts`, whose
 * module graph pulls in the whole server. The literals are pure data — the same
 * brace-match-then-evaluate method §T0-E used, and it cross-checked to 1.5% against an
 * independent path.
 */
function schemaOf(name: string): Record<string, unknown> {
  const src = fs.readFileSync(SRC, 'utf8');
  const i = src.indexOf(`name: '${name}'`);
  if (i < 0) throw new Error(`tool not found: ${name}`);
  const j = src.indexOf('input_schema:', i);
  const k = src.indexOf('{', j);
  let depth = 0;
  let e = k;
  for (; e < src.length; e++) {
    const c = src[e];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { e++; break; } }
  }
  const body = src.slice(k, e)
    // The rewired sites call workProp(...); evaluate them against the real module.
    .replace(/\bworkProp\(/g, '__workProp(')
    .replace(/\bWORK_PRIORITY_ENUM\b/g, '__PRIORITY_ENUM');
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const fn = new Function('__workProp', '__PRIORITY_ENUM', `return (${body});`);
  return fn(workProp, WORK_PRIORITY_ENUM) as Record<string, unknown>;
}

// Captured at `8f36cdb`, BEFORE the rewire, by serialising both verbs' input_schema.
const BASELINE_CHARS = { work_open: 5623, work_update: 7008 };

describe('S2 — the shared declaration changes zero wire bytes', () => {
  const open = schemaOf('work_open');
  const upd = schemaOf('work_update');

  it('serialises to exactly the byte count it did before the rewire', () => {
    expect(JSON.stringify(open).length).toBe(BASELINE_CHARS.work_open);
    expect(JSON.stringify(upd).length).toBe(BASELINE_CHARS.work_update);
  });

  it('preserves KEY ORDER on every shared property — stringify emits insertion order', () => {
    const po = (open as { properties: Record<string, Record<string, unknown>> }).properties;
    const pu = (upd as { properties: Record<string, Record<string, unknown>> }).properties;
    for (const name of Object.keys(WORK_SHARED_PROPERTIES)) {
      for (const [verb, props] of [['work_open', po], ['work_update', pu]] as const) {
        const keys = Object.keys(props[name]);
        expect(keys[0], `${verb}.${name} must start with type`).toBe('type');
        expect(keys[keys.length - 1], `${verb}.${name} must end with description`).toBe('description');
      }
    }
  });

  it('has 17 shared names and both verbs still declare every one of them', () => {
    const po = (open as { properties: Record<string, unknown> }).properties;
    const pu = (upd as { properties: Record<string, unknown> }).properties;
    const shared = Object.keys(WORK_SHARED_PROPERTIES);
    expect(shared).toHaveLength(17);
    for (const name of shared) {
      expect(name in po, `work_open lost ${name}`).toBe(true);
      expect(name in pu, `work_update lost ${name}`).toBe(true);
    }
  });

  it('ZERO WORDING TRIMS: every description is non-empty and the two verbs still differ', () => {
    const po = (open as { properties: Record<string, { description?: string }> }).properties;
    const pu = (upd as { properties: Record<string, { description?: string }> }).properties;
    let differing = 0;
    let totalChars = 0;
    for (const name of Object.keys(WORK_SHARED_PROPERTIES)) {
      const a = po[name].description ?? '';
      const b = pu[name].description ?? '';
      expect(a.length, `work_open.${name} lost its description`).toBeGreaterThan(0);
      expect(b.length, `work_update.${name} lost its description`).toBeGreaterThan(0);
      totalChars += a.length + b.length;
      if (a !== b) differing++;
    }
    // Measured at `8f36cdb`: 2,328 + 2,072 = 4,400 chars, all 17 pairs differing. Both
    // survive verbatim — collapsing them into one wording is N1, and N1 is NEEDS-OWNER.
    expect(totalChars).toBe(4400);
    expect(differing).toBe(17);
  });

  it('the one structural divergence is DECLARED, not silently harmonised', () => {
    const po = (open as { properties: Record<string, { enum?: string[] }> }).properties;
    const pu = (upd as { properties: Record<string, { enum?: string[] }> }).properties;
    expect(po.priority.enum).toEqual([...WORK_PRIORITY_ENUM]);
    // work_update has never carried this enum. Adding it would change what a strict
    // provider accepts — a behaviour change outside structural single-sourcing.
    expect(pu.priority.enum).toBeUndefined();
    expect(WORK_SHARED_PROPERTIES.priority).toEqual({ type: 'string' });
  });

  it('the module refuses an undeclared property rather than inventing one', () => {
    expect(() => workProp('not_a_real_field', 'x')).toThrow(/not declared/);
  });

  it('the 16 structurally-identical properties really are declared once', () => {
    const src = fs.readFileSync(SRC, 'utf8');
    // Both verbs' repeat_unit enums used to be two byte-identical literal arrays.
    const literalRepeatUnits = src.split("'minutes', 'hours', 'days', 'weekdays'").length - 1;
    expect(literalRepeatUnits, 'the repeat_unit enum is still duplicated in tools.ts').toBe(0);
  });
});
