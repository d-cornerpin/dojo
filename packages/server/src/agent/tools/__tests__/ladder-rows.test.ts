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

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { gatesForCall, ungatedEffectKinds, PRIMARY_ONLY_TOOLS, type ToolGate } from '../gates.js';

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

  // ── ROW 3 IS TWO DOORS SINCE PHASE-5 T3, AND BOTH CARRY ITS REQUIREMENT ──
  // The ladder's row 3 was *"exec allow/deny + sensitive-file command scan"* on
  // ONE tool. T3 split that tool into `exec({argv})` and `shell({script})`, so
  // the requirement is carried by two gates: `3` (proc) and `3s` (shell). The
  // covered-set clause below asserts BOTH exist, so losing either fails a test
  // rather than silently un-gating a door.
  it('row 3 — exec({argv}): the proc grant, argv-no-shell', () => {
    const g = covers('3', rowsFor('exec', { argv: ['ls'] }));
    expect(g.kind).toBe('proc');
    // The gate exists even for a MALFORMED call — the shape is refused at the
    // gate, never skipped into the handler. (P5-R3's empty-string class.)
    expect(rowsFor('exec', {}).map((r) => r.row)).toEqual(['3']);
  });

  it('row 3s — shell({script}): the shell grant, the /bin/zsh door', () => {
    const g = covers('3s', rowsFor('shell', { script: 'ls | wc -l' }));
    expect(g.kind).toBe('shell');
    // The two doors are DISJOINT: neither tool picks up the other's gate.
    expect(rowsFor('exec', { argv: ['ls'] }).map((r) => r.row)).toEqual(['3']);
    expect(rowsFor('shell', { script: 'ls' }).map((r) => r.row)).toEqual(['3s']);
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

  it('row 15 — the HID / screen family, with the CATEGORY derived', () => {
    const expected: Record<string, string> = {
      mouse_click: 'mouse', mouse_move: 'mouse', keyboard_type: 'keyboard',
      screen_screenshot: 'screen',
    };
    for (const [name, category] of Object.entries(expected)) {
      const g = covers('15', rowsFor(name, {}));
      expect(g.kind).toBe('system_control');
      expect(g.kind === 'system_control' && g.category, `${name} must derive category ${category}`).toBe(category);
    }
  });

  // ── ROW 15's applescript HALF IS ITS OWN GATE SINCE PHASE-5 T3 ──
  // osascript is a second interpreter, and what has to be authorized about it is
  // the SCRIPT — which `system_control`'s category compare never looked at. The
  // row id is unchanged (this is row 15's requirement, not a sixteenth), the
  // gate KIND is not.
  it('row 15 — applescript_run is its OWN class, not a system_control category', () => {
    const g = covers('15', rowsFor('applescript_run', { script: 'display dialog "hi"' }));
    expect(g.kind).toBe('applescript');
    // and it is still exactly one gate, not two
    expect(rowsFor('applescript_run', { script: 'x' }).map((r) => r.row)).toEqual(['15']);
  });

  it('ALL FIFTEEN ROWS ARE ACCOUNTED — no more, no fewer (row 3 now has two doors)', () => {
    expect([...covered].sort()).toEqual(
      ['1', '10', '11', '12', '13', '14a', '14b', '15', '2', '3', '3s', '4', '5', '6', '7', '8', '9'],
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
      expect(rowsFor(name, { path: '/tmp/x', url: 'https://example.com', command: 'ls', argv: ['ls'], script: 'ls' })).toEqual([]);
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

describe('Step 4’s staging window is DELETED (PHASE-5 T7) — enforcement is structural', () => {
  // ══════════════════════════════════════════════════════════════════════════
  // WHAT THIS REPLACED, AND THE REQUIREMENT IT KEEPS.
  //
  // T2 Step 4 shipped `logOnly(agentId, verdict)`: a refusal could be RECORDED
  // instead of APPLIED, for sub-agents only. RULING P5-R6 then narrowed it twice
  // — a global deny is never staged, a `ladder-parity` refusal is never staged
  // for a sub-agent — which left the staged set EMPTY, and T5's census
  // (`brokers/__tests__/staged-set.test.ts`) is what holds it empty rather than
  // merely believing it.
  //
  // T7 deletes the branch by name, which is this phase's own exit gate: *a
  // staging flag that survives its stage is the band-aid this phase exists to
  // kill.* The requirement it encoded — **every refusal the brokers compute is
  // applied, to every agent, and no refusal is recorded-but-not-applied** — is
  // now STRUCTURAL: the executor has one refusal path and it does not ask who
  // the agent is. These clauses hold that, and `staged-set.test.ts` holds the
  // other half (that no broker refusal WOULD have been staged, i.e. that this
  // deletion changed no behaviour on the day it landed).
  // ══════════════════════════════════════════════════════════════════════════

  const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
        walk(full, out);
      } else if (entry.name.endsWith('.ts')) out.push(full);
    }
    return out;
  }

  it('`logOnly` is GREP-ZERO in production source — the exit gate, held as a test', () => {
    // The gate is honest in both directions only because the identifier was
    // grep-zero BEFORE T2 created it (§T0-PINS P9 measured 0 hits at `d0b3320`).
    // Asserting it here is what stops it coming back unannounced.
    const hits = walk(SRC)
      .filter((f) => /\blogOnly\b/.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(SRC, f));
    expect(hits, 'the staged-enablement branch is deleted, not flag-disabled').toEqual([]);
  });

  it('the executor’s gate loop has NO staging arm — a refusal is a refusal', () => {
    const executor = fs.readFileSync(path.join(SRC, 'agent', 'tools', 'index.ts'), 'utf8');
    const loopStart = executor.indexOf('const { verdict } = outcome;');
    expect(loopStart, 'the gate loop’s verdict read must still be there').toBeGreaterThan(-1);
    const refusal = executor.indexOf('return {', loopStart);
    const between = executor.slice(loopStart, refusal);
    // Exactly ONE `continue` — the allow. Anything else is a second way for a
    // computed refusal to end up not applied, which is what this deletes.
    expect(
      (between.match(/\bcontinue;/g) ?? []).length,
      'the only `continue` between the verdict and the refusal is the ALLOW',
    ).toBe(1);
    expect(/if \(verdict\.allowed\) continue;/.test(between)).toBe(true);
  });

  it('⚠ the refusal path does NOT ask who the agent is — that was the staging bug’s door', () => {
    // The incident P5-R6 was written for: a refusal that computed itself and
    // then did not apply, because of WHO asked. There is no identity test on
    // this path any more, so a sub-agent and the primary get the same answer by
    // construction rather than by a predicate somebody has to keep correct.
    const executor = fs.readFileSync(path.join(SRC, 'agent', 'tools', 'index.ts'), 'utf8');
    const loopStart = executor.indexOf('const { verdict } = outcome;');
    const refusal = executor.indexOf('return {', loopStart);
    const between = executor.slice(loopStart, refusal);
    for (const identity of ['isPrimaryAgent', 'isHealerAgent', 'logOnly']) {
      expect(
        between.includes(identity),
        `${identity} must not decide whether a computed refusal is applied`,
      ).toBe(false);
    }
  });
});
