// ════════════════════════════════════════════════════════════════════════════
// ALL FIFTEEN LADDER ROWS, ACCOUNTED (PHASE-5 T2 Step 3).
//
// §T0-PINS P1 tabled the fifteen branches `executeToolInner` carried and the
// requirement each one encoded. This file is the receipt: every row has a
// clause, the clause names the row, and the LAST clause asserts that the set of
// rows this file covers is exactly `1..15` — so a sixteenth requirement cannot
// be added without being covered, and a row cannot be dropped without failing
// here first.
//
// Non-negotiable #9: *a removal that cannot state its requirement does not
// merge.* Fifteen requirements, fifteen statements, one enumeration.
// ════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi } from 'vitest';

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

import { gatesForCall, ungatedEffectKinds, PRIMARY_ONLY_TOOLS, type ToolGate } from '../gates.js';
import { logOnly } from '../gate-eval.js';
import type { Verdict } from '../../brokers/index.js';

/** Which rows the clauses below claim to cover. Filled by `covers()`. */
const covered = new Set<string>();

function rowsFor(name: string, args: Record<string, unknown> = {}): ToolGate[] {
  return gatesForCall(name, args);
}

function covers(row: string, gates: ToolGate[]): ToolGate {
  covered.add(row);
  const gate = gates.find((g) => g.row === row);
  expect(gate, `row ${row} produced no gate`).toBeDefined();
  return gate as ToolGate;
}

describe('the fifteen rows, one clause each', () => {
  it('row 1 — file_read / file_list: manifest file-read scope on args.path', () => {
    for (const name of ['file_read', 'file_list']) {
      const g = covers('1', rowsFor(name, { path: '/tmp/x' }));
      expect(g.kind).toBe('fs');
      expect(g.kind === 'fs' && g.effect).toBe('fs_read');
    }
  });

  it('row 2 — file_write / file_append / file_patch: manifest file-write scope on args.path', () => {
    for (const name of ['file_write', 'file_append', 'file_patch']) {
      const g = covers('2', rowsFor(name, { path: '/tmp/x' }));
      expect(g.kind === 'fs' && g.effect).toBe('fs_write');
    }
    // file_patch reads AND writes; the ladder gated it on WRITE only, and adding
    // the read gate would be a new refusal (P5-R5). It stays write-only.
    expect(rowsFor('file_patch', { path: '/tmp/x' }).filter((g) => g.kind === 'fs')).toHaveLength(1);
  });

  it('row 3 — exec: allow/deny, and the sensitive-file command scan at the same door', () => {
    const g = covers('3', rowsFor('exec', { command: 'ls' }));
    expect(g.kind).toBe('shell');
  });

  it('row 4 — spawn_agent: can_spawn_agents', () => {
    const g = covers('4', rowsFor('spawn_agent', { name: 'w', system_prompt: 'x' }));
    expect(g.kind).toBe('spawn');
  });

  it('row 5 — web_fetch: network_domains on the URL host', () => {
    const g = covers('5', rowsFor('web_fetch', { url: 'https://example.com' }));
    expect(g.kind).toBe('net');
    expect(g.kind === 'net' && g.subAgentsOnly).toBeUndefined();
  });

  it('row 6 — web_search: net egress with NO url argument (a FIXED host)', () => {
    // §T0-PINS P1 flags this as one of the two gates easiest to lose: there is
    // no argument to scan, so only the DECLARATION can produce it. The gate
    // exists for a call with an empty argument object, which is the proof.
    const g = covers('6', rowsFor('web_search', {}));
    expect(g.kind).toBe('net');
  });

  it('row 7 — imessage_send / imessage_list_contacts: the primary-only wall', () => {
    for (const name of ['imessage_send', 'imessage_list_contacts']) {
      const g = covers('7', rowsFor(name, {}));
      expect(g.kind).toBe('primary_only');
    }
  });

  it('row 8 — the PM allowlist, keyed on the OPERATION and not the tool name', () => {
    // PHASE-2 T8V: three PM-only tools became three ACTIONS on one verb. A gate
    // keyed on `work_validate` alone would lock nothing the day a non-PM action
    // joins the verb.
    const g = covers('8', rowsFor('work_validate', { action: 'validate' }));
    expect(g.kind).toBe('pm_only_operation');
    expect(g.kind === 'pm_only_operation' && g.operation).toBe('work_validate:validate');
    // …and a work verb whose OPERATION is not on the PM list produces no gate,
    // which is the half a name-keyed rule gets wrong. Note that `work_validate`
    // is PM-only in EVERY one of its operations today — its absorb ladder ends
    // in `validate` — so the honest counter-example lives on `work_update`.
    expect(rowsFor('work_update', { action: 'get' }).some((x) => x.kind === 'pm_only_operation')).toBe(false);
    expect(rowsFor('work_update', { action: 'reassign' }).some((x) => x.kind === 'pm_only_operation')).toBe(false);
    // …while `work_validate` under any action is gated, because every one of its
    // operations is on the list. Measured, not assumed.
    for (const action of ['validate', 'retask', 'override', 'apply_user_verdict', 'get']) {
      expect(
        rowsFor('work_validate', { action }).some((x) => x.kind === 'pm_only_operation'),
        `work_validate(action=${action}) must still meet the PM gate`,
      ).toBe(true);
    }
  });

  it('row 9 — PRIMARY_ONLY_TOOLS: owner-facing controls', () => {
    for (const name of PRIMARY_ONLY_TOOLS) {
      const g = covers('9', rowsFor(name, {}));
      expect(g.kind).toBe('primary_only');
    }
    // The set is the SAME constant the surface strip uses; two lists here would
    // be the drift this phase deletes.
    expect(PRIMARY_ONLY_TOOLS.has('apply_update')).toBe(true);
    expect(PRIMARY_ONLY_TOOLS.has('reset_session'), 'reset_session is deliberately OUT — row 10 owns it').toBe(false);
  });

  it('row 10 — reset_session: primary OR the Healer, and the Healer keeps it', () => {
    const g = covers('10', rowsFor('reset_session', {}));
    expect(g.kind).toBe('primary_or_healer');
  });

  it('row 11 — kill_agent: only the creator dismisses', () => {
    const g = covers('11', rowsFor('kill_agent', { agent_id: 'a1' }));
    expect(g.kind).toBe('creator_only');
    expect(g.kind === 'creator_only' && g.entity).toBe('agent');
  });

  it('row 12 — delete_group: the same contract for squads', () => {
    const g = covers('12', rowsFor('delete_group', { group_id: 'g1' }));
    expect(g.kind).toBe('creator_only');
    expect(g.kind === 'creator_only' && g.entity).toBe('group');
    // delete_group is ALSO in PRIMARY_ONLY_TOOLS, so it carries both rows — the
    // ladder ran both too, in this order.
    expect(rowsFor('delete_group', { group_id: 'g1' }).map((x) => x.row)).toEqual(['9', '12']);
  });

  it('row 13 — dreamer_run_now / cost_summary: owner-facing', () => {
    for (const name of ['dreamer_run_now', 'cost_summary']) {
      const g = covers('13', rowsFor(name, {}));
      expect(g.kind).toBe('primary_only');
    }
  });

  it('rows 14a + 14b — web_browse holds TWO gates, and one authorize() cannot express it', () => {
    // The other gate §T0-PINS P1 flags as easy to lose. `system_control` always;
    // `network_domains` on the url ONLY when navigating, and only for sub-agents.
    const navigate = rowsFor('web_browse', { action: 'navigate', url: 'https://example.com' });
    const a = covers('14a', navigate);
    expect(a.kind).toBe('system_control');
    const b = covers('14b', navigate);
    expect(b.kind).toBe('net');
    expect(b.kind === 'net' && b.subAgentsOnly).toBe(true);

    // Not navigating → the second gate does not exist, exactly as before.
    const clicking = rowsFor('web_browse', { action: 'click' });
    expect(clicking.map((g) => g.row)).toEqual(['14a']);
    // Navigating with no url → likewise.
    expect(rowsFor('web_browse', { action: 'navigate' }).map((g) => g.row)).toEqual(['14a']);
  });

  it('row 15 — the HID / screen / applescript family, with the CATEGORY derived', () => {
    const expected: Record<string, string> = {
      mouse_click: 'mouse', mouse_move: 'mouse', keyboard_type: 'keyboard',
      screen_screenshot: 'screen', applescript_run: 'applescript',
    };
    for (const [name, category] of Object.entries(expected)) {
      const g = covers('15', rowsFor(name, {}));
      expect(g.kind).toBe('system_control');
      expect(g.kind === 'system_control' && g.category, `${name} must derive category ${category}`).toBe(category);
    }
  });

  it('ALL FIFTEEN ROWS ARE ACCOUNTED — no more, no fewer', () => {
    expect([...covered].sort()).toEqual(
      ['1', '10', '11', '12', '13', '14a', '14b', '15', '2', '3', '4', '5', '6', '7', '8', '9'],
    );
  });
});

describe('P5-R5 — what the loop deliberately does NOT gate', () => {
  it('a tool with no ladder row gets no gate, however many effects it declares', () => {
    // `image_create` writes into the calling agent's uploads directory and
    // declares `fs_write`; nothing gated it before T2, so nothing gates it now.
    // Wiring "declared ⇒ granted" would narrow what the owner's agents can do,
    // which the phase's posture makes an owner decision.
    for (const name of ['image_create', 'send_to_agent', 'work_update', 'vault_remember']) {
      expect(rowsFor(name, { path: '/tmp/x', url: 'https://example.com', command: 'ls' })).toEqual([]);
    }
  });

  it('the ungated effects are RECORDED, which is the other half of the ruling', () => {
    // A tool whose declared effect no row gates reports it, so the enumeration
    // exists when somebody decides one of them should gate.
    const kinds = ungatedEffectKinds('image_create', rowsFor('image_create', {}));
    expect(kinds).toContain('fs_write');
    // …and a fully-gated tool reports nothing.
    expect(ungatedEffectKinds('file_read', rowsFor('file_read', { path: '/tmp/x' }))).toEqual([]);
  });
});

describe('Step 4 — the staging window, and the regression it refuses to be', () => {
  const parity: Verdict = { allowed: false, basis: 'ladder-parity', rule: 'r', reason: 'x', blockedMessage: null };
  const hardening: Verdict = { allowed: false, basis: 'bypass-hardening', rule: 'r', reason: 'x', blockedMessage: null };

  it('a PARITY refusal enforces for EVERY agent — sub-agents included', () => {
    // This is the clause that stops the obvious reading of "sub-agents run
    // log-only" from silently un-gating the ladder for the untrusted side of
    // the platform.
    for (const agent of ['primary', 'healer', 'sub-agent-1', 'pm', 'trainer']) {
      expect(logOnly(agent, parity), `${agent} must be ENFORCED on a parity refusal`).toBe(false);
    }
  });

  it('a HARDENING refusal enforces for the primary and the Healer immediately', () => {
    expect(logOnly('primary', hardening)).toBe(false);
    expect(logOnly('healer', hardening)).toBe(false);
  });

  it('a HARDENING refusal is LOG-ONLY for a sub-agent until T5 fixes the manifest', () => {
    expect(logOnly('sub-agent-1', hardening)).toBe(true);
  });

  it('an ALLOW is never log-only (there is nothing to stage)', () => {
    expect(logOnly('sub-agent-1', { allowed: true, rule: 'ok' })).toBe(false);
  });
});
