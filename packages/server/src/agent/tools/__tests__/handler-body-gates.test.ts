// ════════════════════════════════════════════════════════════════════════════
// THE PERMISSION CHECKS THAT LIVE IN HANDLER BODIES (PHASE-5 T7 demolition).
//
// The phase's demolition list names *"the scattered permission checks inside
// handlers (now registry-declared)"*. **Measured at this HEAD, the parenthesis
// is FALSE and that is why this file exists rather than a deletion.** There are
// exactly two such checks (§T0-PINS P6, re-derived here), and neither duplicates
// a declared gate: `gatesForCall()` returns NO row that covers either resource,
// so each body is the ONLY thing standing between the tool and a path the
// agent's manifest forbids. Deleting them would remove a live protection;
// converting them into declared gates would change the refusal a model reads
// (message, `errorCode`, audit row, and — for `show_to_user` — per-path rather
// than per-call), which is the re-classification RULING P5-R5's parity clause
// refuses.
//
// **VERDICT: KEEP, and the requirement becomes a test here** — until now the
// class was held by nothing but two module-header comments, which is the shape
// this phase keeps converting into checks. The sibling family (the four
// outbound-send walls `sms_send` / `voice_call` / `voice_call_end` /
// `voice_call_status`) is already held the same way in
// `agent/__tests__/child-scope.test.ts:124`; this file completes the set.
//
// The census reads SOURCE TEXT deliberately: a body-internal check has no
// exported seam to call, so the only honest way to hold it is to assert the call
// is still there, in the right function, ahead of the work it guards.
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

const CAT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'cat');
const read = (file: string): string => fs.readFileSync(path.join(CAT, file), 'utf8');

describe('the two handler-body permission checks — the demolition list’s third family', () => {
  it('`show_to_user` still checks file_read on EVERY path it is asked to show', () => {
    const src = read('comms.ts');
    // The call itself, in the per-path loop, ahead of every fs touch.
    expect(
      /for \(const srcPath of filePaths\)/.test(src),
      'show_to_user must still walk its paths one at a time',
    ).toBe(true);
    expect(
      /checkPermission\(agentId, \{ type: 'file_read', path: srcPath \}\)/.test(src),
      'the per-path file_read check is the only gate on show_to_user’s paths',
    ).toBe(true);
    // …and it refuses BEFORE the file is opened, stat-ed or copied. The check
    // sits above the first existence probe in that loop; if a future edit moves
    // it below, an agent learns whether a forbidden file exists.
    //
    // PHASE-5 T8 Step 3: the probe's SPELLING changed when the comms door
    // converted — `fs.existsSync` became `effectFs.existsSync`, the facade entry
    // that performs the same call behind the per-call capability. The
    // REQUIREMENT this clause holds is unchanged (the permission check runs
    // first), and the token is the current one on purpose: matching both
    // spellings would let a revert to raw `node:fs` pass silently.
    const loop = src.slice(src.indexOf('for (const srcPath of filePaths)'));
    const check = loop.indexOf("checkPermission(agentId, { type: 'file_read', path: srcPath })");
    const firstTouch = loop.indexOf('effectFs.existsSync(srcPath)');
    expect(check, 'the check must be inside the loop').toBeGreaterThan(-1);
    expect(firstTouch, 'the existence probe must be inside the loop').toBeGreaterThan(-1);
    expect(check, 'the permission check must run BEFORE the file is touched').toBeLessThan(firstTouch);
  });

  it('the local office destination still goes through file_write', () => {
    const src = read('office.ts');
    expect(
      /checkPermission\(agentId, \{ type: 'file_write', path: localDest \}\)/.test(src),
      'the local office destination check is the only gate on that write',
    ).toBe(true);
    // The destination is the explicit `args.path` when given, else the agent's
    // own uploads dir — so the checked resource is the one the agent chose.
    expect(/const localDest = typeof args\.path === 'string'/.test(src)).toBe(true);
    const decl = src.indexOf('const localDest =');
    const check = src.indexOf("checkPermission(agentId, { type: 'file_write', path: localDest })");
    const call = src.indexOf('await executeOfficeTool(');
    expect(decl).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(decl);
    expect(check, 'the check must run before the document is written').toBeLessThan(call);
  });

  it('⚠ NEITHER IS A DUPLICATE — the gate table covers neither resource', () => {
    // This is the clause that refutes the demolition list's own parenthesis, and
    // it is the reason both survive T7. RULING P5-R5 derived the gate rows from
    // the ladder's fifteen branches; `show_to_user` and the office family were
    // never ladder rows, so no declared gate answers for their paths. If a later
    // task DOES declare one, this clause fails and whoever wrote it must decide
    // deliberately which mechanism owns the refusal — never both, never neither.
    expect(gatesForCall('show_to_user', { file_paths: ['/tmp/x.png'] })).toEqual([]);
    for (const name of ['office_create_document', 'office_edit_document', 'office_create_spreadsheet']) {
      expect(gatesForCall(name, { path: '/tmp/x.docx' }), `${name} has no declared gate row`).toEqual([]);
    }
  });

  it('the third family — the four outbound-send walls — is held elsewhere and still is', () => {
    // Recorded here so the SET is enumerable from one place. The clause that
    // holds them lives with the scope tests, because that is where the danger
    // set they belong to is defined.
    const scopeTest = fs.readFileSync(
      path.join(CAT, '..', '..', '__tests__', 'child-scope.test.ts'), 'utf8',
    );
    for (const tool of ['sms_send', 'voice_call', 'voice_call_end', 'voice_call_status']) {
      expect(scopeTest.includes(`'${tool}'`), `${tool}'s wall must stay held by a clause`).toBe(true);
    }
  });
});
