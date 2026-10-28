// A technique_read search must not surface the technique's own versions/ snapshots (stale
// instructions an agent could follow); a folder named versions deeper inside the technique
// belongs to the author and is still searched.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The temp folder is created per clause, so the store stub reads it at call time.
const tmp = vi.hoisted(() => ({ dir: '' }));

vi.mock('../store.js', () => ({
  createTechnique: vi.fn(),
  getTechnique: vi.fn(),
  getTechniqueDetail: vi.fn(() => ({
    id: 't1',
    name: 'Demo',
    description: null,
    state: 'published',
    enabled: true,
    buildSquadId: null,
    directoryPath: tmp.dir,
    instructions: '# Demo\nbody without the word',
    files: [],
  })),
  listTechniques: vi.fn(),
  updateTechnique: vi.fn(),
  updateTechniqueInstructions: vi.fn(),
  updateTechniqueDependencies: vi.fn(),
  publishTechnique: vi.fn(),
  recordTechniqueUsage: vi.fn(),
  resolveTechniqueRef: vi.fn(() => ({ ok: true, id: 't1' })),
  TechniqueValidationError: class TechniqueValidationError extends Error {},
}));

vi.mock('../../agent/access/read.js', () => ({
  mayUseTechnique: vi.fn(() => true),
}));

vi.mock('../import-setup.js', () => ({
  readImportManifest: vi.fn(),
  applyPlaceholderToTechnique: vi.fn(),
  findRemainingPlaceholders: vi.fn(),
  finalizeImportedTechnique: vi.fn(),
}));

// The effects facade refuses every path outside an authorized tool call, which a plain
// unit test never is — pass it through to node:fs so the walk sees the real folder.
vi.mock('../../agent/effects/fs.js', async () => {
  const realFs = await import('node:fs');
  return { ...realFs };
});

import { executeTechniqueRead } from '../tools.js';

beforeEach(() => {
  tmp.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dojo-technique-search-'));
  fs.mkdirSync(path.join(tmp.dir, 'docs', 'versions'), { recursive: true });
  fs.mkdirSync(path.join(tmp.dir, 'versions'));
  fs.writeFileSync(path.join(tmp.dir, 'TECHNIQUE.md'), '# Demo\nbody without the word');
  fs.writeFileSync(path.join(tmp.dir, 'docs', 'notes.txt'), 'a needle lives here\nand a second line');
  fs.writeFileSync(path.join(tmp.dir, 'docs', 'versions', 'old.txt'), 'a needle in an author-owned versions folder');
  fs.writeFileSync(path.join(tmp.dir, 'versions', 'TECHNIQUE_v1.md'), 'a needle in a stale version snapshot');
});

afterEach(() => {
  fs.rmSync(tmp.dir, { recursive: true, force: true });
  tmp.dir = '';
});

describe('technique_read search beside version snapshots', () => {
  it('skips the top-level versions/ folder but still searches an author-owned one deeper in', () => {
    const text = executeTechniqueRead('agent-1', 'Agent', null, { name: 't1', action: 'search', query: 'needle' });
    expect(text).toContain('[docs/notes.txt:L1]');
    expect(text).toContain('[docs/versions/old.txt:L1]');
    expect(text).not.toContain('versions/TECHNIQUE_v1.md');
  });
});
