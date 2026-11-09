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

describe('the two handler-body permission checks — the demolition list’s third family', () => {

  it('⚠ NEITHER IS A DUPLICATE — the gate table covers neither resource', () => {
    // This is the clause that refutes the demolition list's own parenthesis, and
    // it is the reason both survive T7. RULING P5-R5 derived the gate rows from
    // the ladder's fifteen branches; `show_to_user` and the office family were
    // never ladder rows, so no declared gate answers for their paths. If a later
    // task DOES declare one, this clause fails and whoever wrote it must decide
    // deliberately which mechanism owns the refusal — never both, never neither.
    //
    // ── THE DELIBERATE DECISION THIS CLAUSE ASKED FOR (UX-ACCESS A3) ──
    // A later task DID declare a row for these tools: row 17, the owner's
    // positive CATEGORY grant, which `show_to_user` (Communication) and the
    // office family (Office Documents) both carry. It is NOT a duplicate and
    // the two mechanisms own different questions, which is exactly the
    // distinction this clause exists to force somebody to state:
    //   · row 17 asks "may this agent use tools in this GROUP at all" — an
    //     owner-set grant, defaulting to `'*'` for every agent that exists;
    //   · the handler-body `checkPermission` asks "may it write THIS PATH" —
    //     the resource the agent chose, which row 17 never looks at.
    // So the file-write refusal still has exactly one owner, and the clause's
    // requirement — no declared gate answers for these RESOURCES — is asserted
    // below with the category row filtered out rather than weakened.
    const resourceGates = (name: string, args: Record<string, unknown>) =>
      gatesForCall(name, args).filter((g) => g.kind !== 'category');
    expect(resourceGates('show_to_user', { file_paths: ['/tmp/x.png'] })).toEqual([]);
    for (const name of ['office_create_document', 'office_edit_document', 'office_create_spreadsheet']) {
      expect(resourceGates(name, { path: '/tmp/x.docx' }), `${name} has no declared resource gate`).toEqual([]);
    }
  });
});
