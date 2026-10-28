import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function stripped(rel: string): string {
  const raw = fs.readFileSync(path.join(SRC, rel), 'utf8');
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n');
}

describe('the Healer log writer works in the built (ES module) server', () => {
  it('healer-agent.ts never calls require()', () => {
    expect(/\brequire\s*\(/.test(stripped('healer/healer-agent.ts'))).toBe(false);
  });
  it('the four role predicates are imported at the top of the file', () => {
    const src = stripped('healer/healer-agent.ts');
    const m = src.match(/import \{([^}]*)\} from '\.\.\/config\/platform\.js'/);
    expect(m).not.toBeNull();
    for (const name of ['isPrimaryAgent', 'isPMAgent', 'isTrainerAgent', 'isImaginerAgent']) {
      expect(m![1]).toContain(name);
    }
  });
  it('no other production file calls a bare require() either (the whole class, not one file)', () => {
    // Cross-runtime bodies (Worker/child sources) run as CommonJS inside their own thread or process and are the only allowed users.
    const ALLOWED = new Set(['inspect/sql-child.ts', 'memory/fts-health.ts', 'memory/reader-pool.ts', 'update/install-tree.ts']);
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(path.join(SRC, dir), { withFileTypes: true })) {
        const rel = path.posix.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== '__tests__') walk(rel); continue; }
        if (!rel.endsWith('.ts') || rel.endsWith('.test.ts') || ALLOWED.has(rel)) continue;
        if (/(^|[^.\w$])require\s*\(/m.test(stripped(rel))) offenders.push(rel);
      }
    };
    walk('');
    expect(offenders).toEqual([]);
  });
});
