// ════════════════════════════════════════════════════════════════════════════════════════
// DOC-FRESHNESS FAILED OPEN: A BOX THAT WRITES NO MANUALS SAID "Tool docs generated".
//
// ── THE DEFECT, READ OFF THE TREE (installed-box audit) ──
// `tools/index-generator.ts` writes one `~/.dojo/tools/<tool>.md` per registered tool so
// `load_tool_docs` has something to read. Every write sat inside its OWN try/catch that logged
// `warn` and moved on (`index-generator.ts:111-115`), and `count` was incremented only on
// success. So on a box whose `~/.dojo/tools` is not writable — the directory already exists, so
// `mkdirSync(…, {recursive:true})` does NOT throw — every write failed, `count` stayed 0, the
// function RETURNED NORMALLY, and boot logged:
//
//     info  Tool docs generated { count: 0 }
//
// at INFO. Nothing anywhere compared what was WRITTEN against what the registry DECLARES, so the
// one number that would have named the failure was never computed. The consequence is not a
// missing log line: `load_tool_docs` goes on serving whatever `.md` files are already on disk, so
// an upgraded box serves the PREVIOUS version's manuals — stale parameter lists, renamed tools —
// for ever, and every agent reads them as current.
//
// ── WHAT IS PINNED HERE ──
//  1. The generator REPORTS BOTH NUMBERS (`expected` from the registry, `written` from the disk),
//     so a shortfall is computable at all.
//  2. A genuinely unwritable directory produces `written: 0` with `expected > 0` and carries the
//     first real error text — measured against a REAL chmod'd directory, not a mocked `fs`,
//     because the field condition is a permission bit and a stubbed writer cannot prove a
//     permission bit is handled.
//  3. The shortfall is DECIDED by one shared rule (`@dojo/shared`'s `toolDocsShortfall`) that both
//     boot and the dashboard's Vitals card read, so the owner cannot be told two different things
//     about one fact. The rule is silent when nothing is missing and when boot has not reported.
//  4. Boot USES that rule rather than re-deriving the comparison.
//
// ── THE SWALLOW IS THE MUTANT ──
// Restoring the old shape — dropping `expected` so nothing can be compared, or returning early
// without recording — turns clause 1/2/4 RED. That is the point: the bug was not a wrong number,
// it was the ABSENCE of a number.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
// (os no longer needed: the temp path is built in the hoisted block above)
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const logLines: string[] = [];
vi.mock('../../logger.js', () => ({
  createLogger: (component: string) => {
    const write = (level: string) => (message: string, meta?: unknown) => {
      logLines.push(`${level} ${component}: ${message} ${meta === undefined ? '' : JSON.stringify(meta)}`);
    };
    return { info: write('info'), warn: write('warn'), error: write('error'), debug: write('debug') };
  },
}));

// The docs directory is a module-load constant in `tools/tool-doc-read.ts`. Point it at a real
// temp directory so the permission bit below is a real permission bit.
//
// `vi.hoisted` because `vi.mock` is lifted above ordinary top-level consts, and the path is built
// from globals alone for the same reason (no `fs`/`os` import is in scope that early). The REST of
// the module is spread through from the original: `tools/tool-docs.ts` imports `readToolDoc` from
// it, so a partial mock would break an unrelated module's import graph.
const DOCS_TARGET = vi.hoisted(() => {
  const base = (process.env.TMPDIR || '/tmp').replace(/\/+$/, '');
  return `${base}/dojo-doc-freshness-${process.pid}/tools`;
});
vi.mock('../tool-doc-read.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../tool-doc-read.js')>();
  return { ...actual, TOOLS_DIR: DOCS_TARGET, getToolsDir: () => DOCS_TARGET };
});

import { generateToolDocs } from '../index-generator.js';
import { toolDocsStatus, resetToolDocsStatusForTests } from '../doc-freshness.js';
import { toolDocsShortfall } from '@dojo/shared';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

beforeEach(() => {
  logLines.length = 0;
  resetToolDocsStatusForTests();
  fs.rmSync(DOCS_TARGET, { recursive: true, force: true });
  fs.mkdirSync(DOCS_TARGET, { recursive: true });
});

afterEach(() => {
  // Always restore write permission or the cleanup itself cannot run.
  try { fs.chmodSync(DOCS_TARGET, 0o700); } catch { /* already gone */ }
});

describe('the generator reports what it was ASKED to write, not only what it managed', () => {
  it('names both numbers on a healthy box, and they agree', async () => {
    const result = await generateToolDocs();

    expect(result.expected, 'the registry declares at least one tool').toBeGreaterThan(0);
    expect(result.written, 'a writable directory gets every manual').toBe(result.expected);

    const onDisk = fs.readdirSync(DOCS_TARGET).filter((f) => f.endsWith('.md'));
    expect(onDisk.length, 'the count is the disk, not a hopeful counter').toBe(result.expected);

    // Nothing is missing, so the owner is told nothing.
    expect(toolDocsShortfall(toolDocsStatus())).toBeNull();
  });

  it('an UNWRITABLE docs directory is a shortfall with a delta and a real error', async () => {
    // The field condition exactly: the directory exists, so `mkdirSync` is happy; it is the
    // WRITES that fail.
    fs.chmodSync(DOCS_TARGET, 0o500);

    const result = await generateToolDocs();

    expect(result.expected, 'the registry still declares its tools').toBeGreaterThan(0);
    expect(result.written, 'not one manual reached an unwritable directory').toBe(0);

    const status = toolDocsStatus();
    expect(status, 'boot recorded what happened').not.toBeNull();
    expect(status!.missing, 'the delta is the whole registry').toBe(result.expected);
    expect(status!.lastError, 'the real errno is carried, not swallowed').toBeTruthy();

    // THE SENTENCE THE OWNER READS — one rule, and it is not silent here.
    const said = toolDocsShortfall(status);
    expect(said, 'a shortfall must produce a sentence').not.toBeNull();
    expect(said!).toContain(String(result.expected));

    // …and it is said at ERROR, not warn, and not info.
    const errors = logLines.filter((l) => l.startsWith('error '));
    expect(errors.length, `a shortfall logs at ERROR; got: ${logLines.join(' | ')}`).toBeGreaterThan(0);
    expect(errors.join(' | '), 'the ERROR line carries the delta').toContain(String(result.expected));

    // The old shape's INFO claim must not also be made — "generated" is not true here.
    const infoClaims = logLines.filter((l) => l.startsWith('info ') && /generated/i.test(l));
    expect(infoClaims, 'a box that wrote nothing may not report success at INFO').toEqual([]);
  });
});

describe('the shortfall rule is shared, silent by default, and actually consulted', () => {
  it('says nothing when boot has not reported, and nothing when the set is complete', () => {
    expect(toolDocsShortfall(null), 'no report yet is not an alarm').toBeNull();
    expect(toolDocsShortfall(undefined)).toBeNull();
    expect(toolDocsShortfall({
      expected: 10, written: 10, missing: 0, dir: '/x', lastError: null, checkedAt: null,
    }), 'a complete set is silent').toBeNull();
  });

  it('speaks once anything is missing, naming how many', () => {
    const said = toolDocsShortfall({
      expected: 337, written: 325, missing: 12, dir: '/x/.dojo/tools', lastError: 'EACCES',
    checkedAt: null });
    expect(said).not.toBeNull();
    expect(said!, 'the number missing is named').toContain('12');
    expect(said!, 'the size of the surface is named').toContain('337');
  });

  it('THE SPEAKER USES THE SHARED RULE rather than re-deriving the comparison', () => {
    // A second opinion about "is a manual missing" is how the owner gets told two different
    // things about one fact. The recorder is the one speaker — it runs inside the generator on
    // every boot, so the comparison cannot be forgotten at a call site — and it must get its
    // wording from the shared rule rather than writing its own sentence.
    const speaker = fs.readFileSync(path.join(SRC, 'tools/doc-freshness.ts'), 'utf8');
    expect(speaker, 'the recorder reads the shared rule').toContain('toolDocsShortfall');
    expect(speaker, 'and it says a shortfall at ERROR').toMatch(/logger\.error\(/);
  });

  it('BOOT no longer claims success on its own, and records a THROW instead of swallowing it', () => {
    // Both arms of boot's step 3b failed open: the success arm logged `count` at INFO without
    // asking how many were owed, and the catch arm logged one `warn` that reached no surface.
    const boot = fs.readFileSync(path.join(SRC, 'index.ts'), 'utf8');
    expect(
      /logger\.info\('Tool docs generated'/.test(boot),
      'boot must not re-announce success; the recorder owns that line and its level',
    ).toBe(false);
    expect(boot, 'a throw is recorded, not just warned').toContain('recordToolDocsFailure');
  });

  it('THE VITALS CARD USES THE SAME RULE, so the two surfaces cannot drift', () => {
    const card = fs.readFileSync(
      path.resolve(SRC, '../../dashboard/src/pages/Health.tsx'), 'utf8',
    );
    expect(card, 'the dashboard reads the shared rule too').toContain('toolDocsShortfall');
  });
});
