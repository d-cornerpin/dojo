// ════════════════════════════════════════════════════════════════════════════
// THE PUBLISH FAMILY, AND THE CENSUS THAT KEEPS IT COMPLETE (PHASE-5 T8 Step 7).
//
// `registerSharedFile()` is the platform's ONE publish primitive: it inserts a
// row into `shared_files` and hands back an `/api/upload/download/<uuid>` URL
// that the download route serves WITHOUT a sign-in (an unguessable id is the
// whole of its protection). Every call to it therefore turns a path on this
// machine into bytes somebody outside can fetch.
//
// The requirement, and it is the owner's (2026-08-03, "Close it now"): **every
// publish-path tool runs the same sanctioned guard its siblings run.** Three
// members asked `sharePathGuard` and one — `canvas_render` — never did, on a
// path the AGENT names. That member's behaviour is held by
// `agent/__tests__/share-guards.test.ts`; this file holds the FAMILY.
//
// ── WHY A CENSUS AND NOT FOUR ASSERTIONS ──
// The failure mode being closed is not "this one tool forgot". It is that
// nothing anywhere said what the family IS, so the fifth member could be added
// tomorrow with no guard and every existing test would stay green. The census
// below is derived from SOURCE — it walks the production tree, finds every call
// to the publish primitive, and refuses any call site that is not in the table
// with a disposition and a reason. A new publish site fails this test naming
// itself; an existing one that loses its guard fails the ordering clause.
//
// **Four dispositions, and "nobody looked" is not one of them:**
//   sharePathGuard      the agent names the path; the sibling guard runs first.
//   declared-gate       the resource was authorized by a DECLARED gate row at
//                       the executor's gate loop before the handler ran.
//   sibling-body-guard  a different sanctioned check owns it, named here, held
//                       by its own test (RULING P5-R5 refuses re-classifying
//                       the refusal a model reads, so these are NOT converted).
//   platform-named      the path is a platform literal the agent cannot
//                       influence; the clause proves the caller set, so this
//                       disposition cannot quietly acquire an agent-named one.
// ════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

vi.mock('../../../config/platform.js', async () => {
  const actual = await vi.importActual<typeof import('../../../config/platform.js')>('../../../config/platform.js');
  return {
    ...actual,
    isPrimaryAgent: (id: string) => id === 'primary',
    isHealerAgent: (id: string) => id === 'healer',
    isPMAgent: (id: string) => id === 'pm',
    isTrainerAgent: () => false,
  };
});

import { gatesForCall } from '../gates.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..', '..', '..');

const PUBLISH_PRIMITIVE = 'registerSharedFile(';
const SANCTIONED_GUARD = 'sharePathGuard(';

/** Every production `.ts` under `packages/server/src` — tests excluded, exactly
 *  as `eslint.config.js` and `packages/server/tsconfig.json` exclude them. */
function productionSources(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__' || entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) productionSources(full, out);
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

/** Call sites of `token`, as `{file, line}` — import lines and the declaration
 *  itself are not calls and are skipped by shape, never by filename. */
function callSites(token: string): Array<{ file: string; line: string }> {
  const found: Array<{ file: string; line: string }> = [];
  for (const file of productionSources(SRC)) {
    const rel = path.relative(SRC, file);
    for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
      const line = raw.trim();
      if (!line.includes(token)) continue;
      if (line.startsWith('import ') || line.startsWith('export {') || line.startsWith('*') || line.startsWith('//')) continue;
      if (line.startsWith('export function ') || line.startsWith('export async function ')) continue;
      found.push({ file: rel, line });
    }
  }
  return found;
}

// ── THE CENSUS ──────────────────────────────────────────────────────────────
// Read at PHASE-5 T8 (2026-08-03) by opening each call site AND the code that
// produces the path it publishes. Never by filename, never by directory.
const PUBLISH_CENSUS: ReadonlyArray<{
  file: string;
  line: string;
  occurrences: number;
  member: string;
  disposition: 'sharePathGuard' | 'declared-gate' | 'sibling-body-guard' | 'platform-named';
  reason: string;
}> = [
  {
    file: 'agent/tools/cat/canvas.ts',
    line: 'const registered = registerSharedFile(agentId, canvasPath);',
    occurrences: 1,
    member: 'canvas_render',
    disposition: 'sharePathGuard',
    reason: 'the path is args.path — the agent names it. THE MEMBER THIS TASK ADDED.',
  },
  {
    file: 'agent/tools/cat/canvas.ts',
    line: 'let pngUrl = registerSharedFile(agentId, pngPath);',
    occurrences: 1,
    member: 'open_browser',
    disposition: 'platform-named',
    reason: 'pngPath is a uuid under ~/.dojo/data/canvas-shots that this handler just wrote from its own screenshot; the agent names a URL, never a path.',
  },
  {
    file: 'agent/tools/cat/comms.ts',
    line: 'const downloadUrl = registerSharedFile(agentId, sharePath);',
    occurrences: 1,
    member: 'share_file',
    disposition: 'sharePathGuard',
    reason: 'the path is args.path; the guard has run here since PHASE-0 T10.',
  },
  {
    file: 'agent/tools/cat/comms.ts',
    line: 'const url = registerSharedFile(agentId, a.path);',
    occurrences: 1,
    member: 'show_to_user',
    disposition: 'sibling-body-guard',
    reason: "checkPermission(file_read) runs per path inside show_to_user's own loop, ahead of every fs touch — the T7 KEEP. Converting it would change the refusal a model reads (P5-R5 parity).",
  },
  {
    file: 'agent/tools/cat/fs.ts',
    line: 'const downloadUrl = registerSharedFile(agentId, filePath);',
    occurrences: 2,
    member: 'file_write / file_append',
    disposition: 'declared-gate',
    reason: 'the resource is the file this call just wrote, authorized by gate row 2 (fs_write, from args.path) before dispatch.',
  },
  {
    file: 'agent/tools/cat/fs.ts',
    line: 'const patchDownloadUrl = registerSharedFile(agentId, filePath);',
    occurrences: 1,
    member: 'file_patch',
    disposition: 'declared-gate',
    reason: 'same row 2 authorization; file_patch is in FS_WRITE_TOOLS.',
  },
  {
    file: 'agent/tools/util.ts',
    line: 'const registered = registerSharedFile(agentId, filePath);',
    occurrences: 1,
    member: 'openFileInCanvas',
    disposition: 'platform-named',
    reason: 'not a tool: the auto-open helper, called with a document the platform itself just produced. Its caller set is asserted below.',
  },
];

/** Every production caller of the auto-open helper, read at T8. Both pass a
 *  path the PLATFORM produced, which is what makes the census row above true. */
const AUTO_OPEN_CALLERS: ReadonlyArray<{ file: string; reason: string }> = [
  {
    file: 'agent/tools/cat/office.ts',
    reason: 'localPath, the document office_* just wrote; its destination went through the handler-body checkPermission(file_write) that handler-body-gates.test.ts holds.',
  },
  {
    file: 'agent/tools/index.ts',
    reason: 'pdfPath, the PDF the pdf_* interceptor just produced into the agent uploads dir; every pdf INPUT path was sharePathGuard-ed in the same block.',
  },
];

/** Every production call of the sanctioned guard, read at T8 — so the family is
 *  enumerable from BOTH ends and a guard cannot quietly disappear either. */
const GUARD_CALLERS: ReadonlyArray<{ file: string; tool: string }> = [
  { file: 'agent/tools/cat/canvas.ts', tool: "'canvas_render'" },
  { file: 'agent/tools/cat/comms.ts', tool: "'share_file'" },
  { file: 'agent/tools/cat/comms.ts', tool: "'share_publicly'" },
  { file: 'agent/tools/index.ts', tool: 'name' },
];

describe('the publish family is complete, and the census says so from source', () => {
  it('every call to the publish primitive is in the census — a new one fails naming itself', () => {
    const sites = callSites(PUBLISH_PRIMITIVE);
    expect(sites.length, 'the walk must find call sites at all').toBeGreaterThan(0);

    const key = (file: string, line: string): string => `${file} :: ${line}`;
    const measured = new Map<string, number>();
    for (const s of sites) measured.set(key(s.file, s.line), (measured.get(key(s.file, s.line)) ?? 0) + 1);

    const recorded = new Map<string, number>();
    for (const c of PUBLISH_CENSUS) recorded.set(key(c.file, c.line), c.occurrences);

    const unrecorded = [...measured.keys()].filter((k) => !recorded.has(k));
    expect(
      unrecorded,
      'a publish site with no census row: read it, decide its disposition, and add it — never delete this clause',
    ).toEqual([]);

    const vanished = [...recorded.keys()].filter((k) => !measured.has(k));
    expect(vanished, 'a census row whose call site is gone: remove the row in the same change').toEqual([]);

    for (const [k, n] of recorded) {
      expect(measured.get(k), `${k} — occurrence count moved`).toBe(n);
    }
  });

  it('every census row carries a disposition AND a reason — "nobody looked" is not a disposition', () => {
    for (const c of PUBLISH_CENSUS) {
      expect(c.member.length, `${c.file} row has no member`).toBeGreaterThan(0);
      expect(c.reason.length, `${c.member} row has no reason`).toBeGreaterThan(20);
    }
  });

  it('the sharePathGuard members run the guard BEFORE the URL is minted', () => {
    for (const c of PUBLISH_CENSUS) {
      if (c.disposition !== 'sharePathGuard') continue;
      const src = fs.readFileSync(path.join(SRC, c.file), 'utf8');
      const guard = src.indexOf(`sharePathGuard(agentId, '${c.member}'`);
      const mint = src.indexOf(c.line);
      expect(guard, `${c.member} must call the sanctioned guard by name`).toBeGreaterThan(-1);
      expect(mint, `${c.member}'s publish line must still be there`).toBeGreaterThan(-1);
      expect(guard, `${c.member} must ask the guard BEFORE it mints the URL`).toBeLessThan(mint);
    }
  });

  it('canvas_render — the member this task added — refuses on the guard rather than falling through', () => {
    const src = fs.readFileSync(path.join(SRC, 'agent/tools/cat/canvas.ts'), 'utf8');
    // The refusal must RETURN. A guard whose verdict is computed and then
    // ignored is the shape this project keeps finding and deleting.
    expect(/if \(!canvasGuard\.allowed\) \{/.test(src)).toBe(true);
    expect(/return \{ content, isError, errorCode: 'PERMISSION_DENIED' \};/.test(src)).toBe(true);
    // And it audits the refusal, exactly as share_file does.
    expect(/auditLog\(agentId, 'canvas_render', canvasGuard\.absPath, 'denied', canvasGuard\.reason\)/.test(src)).toBe(true);
  });

  it('the declared-gate members really are covered by a declared gate row', () => {
    // Positive evidence, not an absence: ask the gate table itself.
    for (const tool of ['file_write', 'file_append', 'file_patch']) {
      const gates = gatesForCall(tool, { path: '/tmp/x.txt' });
      expect(
        gates.some((g) => g.kind === 'fs' && g.effect === 'fs_write'),
        `${tool} must still carry the declared fs_write gate the census row rests on`,
      ).toBe(true);
    }
  });

  it('the sibling-body-guard member still has its check, and its own test still holds it', () => {
    const comms = fs.readFileSync(path.join(SRC, 'agent/tools/cat/comms.ts'), 'utf8');
    expect(
      /checkPermission\(agentId, \{ type: 'file_read', path: srcPath \}\)/.test(comms),
      'show_to_user’s per-path file_read check is the disposition this census records',
    ).toBe(true);
    const bodyGates = fs.readFileSync(path.join(HERE, 'handler-body-gates.test.ts'), 'utf8');
    expect(
      bodyGates.includes("checkPermission\\(agentId, \\{ type: 'file_read', path: srcPath \\}\\)"),
      'the clause that holds it must still exist in handler-body-gates.test.ts',
    ).toBe(true);
  });

  it('the platform-named members cannot quietly acquire an agent-named path', () => {
    // open_browser: the published file is the screenshot this handler wrote.
    const canvas = fs.readFileSync(path.join(SRC, 'agent/tools/cat/canvas.ts'), 'utf8');
    expect(/const shotsDir = path\.join\(os\.homedir\(\), '\.dojo', 'data', 'canvas-shots'\)/.test(canvas)).toBe(true);
    expect(/const pngPath = path\.join\(shotsDir, `\$\{uuidv4\(\)\}\.png`\)/.test(canvas)).toBe(true);

    // openFileInCanvas: its caller set is the census, and it is complete.
    const measured = callSites('openFileInCanvas(')
      .filter((s) => s.file !== 'agent/tools/util.ts')
      .map((s) => s.file)
      .sort();
    expect(
      [...new Set(measured)],
      'a new caller of the auto-open helper must be read and dispositioned here',
    ).toEqual(AUTO_OPEN_CALLERS.map((c) => c.file).sort());
    for (const c of AUTO_OPEN_CALLERS) expect(c.reason.length).toBeGreaterThan(20);
  });

  it('the sanctioned guard is enumerable from its own end too', () => {
    const measured = callSites(SANCTIONED_GUARD).map((s) => s.file).sort();
    expect(
      measured,
      'a sharePathGuard call site that is not in GUARD_CALLERS: read it and record it',
    ).toEqual(GUARD_CALLERS.map((g) => g.file).sort());
    for (const g of GUARD_CALLERS) {
      const src = fs.readFileSync(path.join(SRC, g.file), 'utf8');
      expect(src.includes(`sharePathGuard(agentId, ${g.tool}`), `${g.file} calls the guard as recorded`).toBe(true);
    }
  });
});
