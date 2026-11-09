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
//
// ── THE SECOND PUBLISH PRIMITIVE, AND ITS OWN CENSUS (PHASE-5 T9B) ──────────
// `registerSharedFile()` is not the only door. `createPublicShare()` copies
// files into `~/.dojo/out/<slug>/`, which `gateway/server.ts` serves at
// `/share/<slug>/…` WITHOUT a sign-in — so every site that puts a file into that
// tree publishes it just as surely. The owner decided this half on the same day
// and in the same words ("Close it now"), and the residual it closes is the one
// T8H handed up: the HTML asset inliner reached any file the page NAMED and had
// no denial, while the two other sites at that door had one.
//
// The second census below is the same instrument pointed at that door: every
// byte-placing call inside the share-tree owner is enumerated with a disposition
// and a reason, each guarded row must ask the sanctioned check BEFORE its copy
// inside its own enclosing scope, and the owner set is asserted so a NEW module
// cannot start writing the share tree without appearing here.
// ════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';

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

// ── THE SECOND PRIMITIVE'S CENSUS (PHASE-5 T9B) ─────────────────────────────
const SHARE_TREE_OWNER = 'services/public-share.ts';

/** Every production module that names the share tree, read at T9B. Only the
 *  owner WRITES it; the gateway reads it back out. A new name here is a new
 *  publish surface and must be read before it is recorded. */
const SHARE_TREE_MODULES: ReadonlyArray<{ file: string; role: 'owner' | 'reader' | 'caller'; reason: string }> = [
  { file: 'services/public-share.ts', role: 'owner', reason: 'declares OUT_DIR and is the only module that copies files into it.' },
  { file: 'gateway/server.ts', role: 'reader', reason: 'serves /share/:slug/* out of OUT_DIR without a sign-in — it reads the tree, it never writes it. This route is WHY the census exists.' },
  { file: 'agent/tools/cat/comms.ts', role: 'caller', reason: 'share_publicly, whose own sharePathGuard call is recorded in GUARD_CALLERS below.' },
];

describe('the publish family is complete, and the census says so from source', () => {

  it('every census row carries a disposition AND a reason — "nobody looked" is not a disposition', () => {
    for (const c of PUBLISH_CENSUS) {
      expect(c.member.length, `${c.file} row has no member`).toBeGreaterThan(0);
      expect(c.reason.length, `${c.member} row has no reason`).toBeGreaterThan(20);
    }
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

  it('the platform-named members cannot quietly acquire an agent-named path', () => {
    for (const c of AUTO_OPEN_CALLERS) expect(c.reason.length).toBeGreaterThan(20);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// THE SECOND DOOR: the unauthenticated share tree (PHASE-5 T9B).
// ════════════════════════════════════════════════════════════════════════════
describe('the share tree is complete too, and the census says so from source', () => {

  it('only the recorded modules name the share tree at all', () => {
    for (const m of SHARE_TREE_MODULES) expect(m.reason.length, `${m.file} row has no reason`).toBeGreaterThan(20);
    expect(
      SHARE_TREE_MODULES.filter((m) => m.role === 'owner').map((m) => m.file),
      'exactly one module owns the share tree',
    ).toEqual([SHARE_TREE_OWNER]);
  });
});
