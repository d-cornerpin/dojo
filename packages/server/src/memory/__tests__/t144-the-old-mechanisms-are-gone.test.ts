// ════════════════════════════════════════════════════════════════════════════════════════
// t144 — IS THE OLD MECHANISM GONE? A census, comments stripped (G4), counted in both directions.
//
// Deleted: agent-wide mixed chunking, the modal-lineage majority vote, the "pending tasks" instruction,
// the "[USER] = the human operator" line, the condenser's agent-wide batching and its private input
// builder, the nightly rebuild's second copy of that builder, and the 30-per-night count. Census of
// the summary writers: every INSERT into `summaries` writes `subject_key`, so every note written after
// the cut carries exactly one subject (or the truthful `several` of OR-COMPACT-1's last resort).
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDepthPrompt } from '../summarize.js';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const code = (rel: string): string => strip(fs.readFileSync(path.join(SRC, rel), 'utf8'));
const count = (s: string, re: RegExp): number => (s.match(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`)) ?? []).length;

function shipped(dir = SRC): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== '__tests__' && e.name !== 'migrations') out.push(...shipped(p)); }
    else if (/\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}

describe('t144 census — the deleted mechanisms count to zero', () => {
  it('dag.ts: no majority vote names a note (the lineage is the note\'s one key)', () => {
    const dag = code('memory/dag.ts');
    expect(count(dag, /dominantMessageLineage/)).toBe(0);
    expect(count(dag, /const modal\b/)).toBe(0);
    expect(count(dag, /subjectKeyOfIds\(messageIds\)/)).toBe(1);
  });

  it('compaction.ts: chunking groups by conversation before it cuts by size', () => {
    const c = code('memory/compaction.ts');
    const body = c.slice(c.indexOf('export function chunkMessages'));
    expect(body.slice(0, body.indexOf('\n}'))).toMatch(/groupBySubject\(messages\[0\]\.agentId, messages\)\.flatMap/);
  });

  it('the condenser batches per conversation through the one input builder', () => {
    const c = code('memory/condense-until-fits.ts');
    expect(count(c, /function batchesOf|function summaryInput/)).toBe(0);
    expect(count(c, /subjectBatches\(rows, minFanout\)/)).toBe(1);
    expect(count(c, /condensedSummaryInput\(/)).toBe(2);
    const r = code('memory/summary-rebuild.ts');
    expect(count(r, /buildCondensedInput|NIGHTLY_SUMMARY_REBUILD_LIMIT|\blimit\b/)).toBe(0);
    expect(count(r, /condensedSummaryInput\(children\)/)).toBe(1);
  });

  it('the prompts, at every depth: no operator line, no pending tasks', () => {
    for (const depth of [0, 1, 2]) {
      const p = getDepthPrompt(depth, 1000);
      expect(p, `depth ${depth}`).not.toMatch(/human operator/i);
      expect(p, `depth ${depth}`).not.toMatch(/pending task/i);
      expect(p, `depth ${depth}`).toMatch(/RESOLVED/);
    }
    expect(count(code('memory/summarize.ts'), /config WHERE key = 'user_name'/)).toBe(0);
  });

  it('every writer of a note writes its subject: INSERT INTO summaries lives in dag.ts only, twice, both with subject_key', () => {
    const sites: string[] = [];
    for (const f of shipped()) {
      const n = count(code(path.relative(SRC, f)), /INSERT INTO summaries\s*\(/);
      for (let i = 0; i < n; i++) sites.push(path.relative(SRC, f));
    }
    expect(sites).toEqual(['memory/dag.ts', 'memory/dag.ts']);
    const dag = code('memory/dag.ts');
    expect(count(dag, /INSERT INTO summaries \([^)]*subject_key[^)]*\)/)).toBe(2);
  });
});
