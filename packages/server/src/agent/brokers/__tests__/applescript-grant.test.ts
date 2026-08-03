// ════════════════════════════════════════════════════════════════════════════
// APPLESCRIPT LEAVES THE BLANKET GRANT (PHASE-5 T5, T3 INBOUND (b)).
//
// The plan's own direction, written at T3 Step 2: *"osascript is an unrestricted
// second shell — never again inside `system_control:'*'`"*. T3 made `applescript`
// a separate audited grant class but left `'*'` covering it, because removing it
// blind would have stripped AppleScript off a live agent. T5 executes the
// direction the preserving way: the `'*'` HOLDERS gain an explicit
// `'applescript'` grant first, and only then does `'*'` stop meaning it.
//
// ⚠ WHO THE HOLDERS ARE WAS RE-DERIVED, AND THE INHERITED ANSWER WAS WRONG ON
// BOTH HALVES. The plan says *"the only two `'*'` holders are the PRIMARY and the
// Healer"*. Measured against the live body at this task's HEAD:
//
//   - the HEALER holds `system_control: []`. It has no system control at all and
//     no AppleScript, so "grant it applescript explicitly" would have WIDENED a
//     manifest, not preserved one;
//   - two live SUB-AGENTS hold `system_control: ["*"]`, inherited verbatim from
//     the primary at spawn (`spawner.ts` copies the parent's manifest when the
//     caller passes none). They hold AppleScript TODAY.
//
// So the preserved set is "the primary, in code" plus "every stored manifest
// whose `system_control` contains `'*'`, in the migration" — which is why this
// flip and migration 155 are one change and cannot be separated. The command and
// its output are in `.superpowers/sdd/PHASE-5/task-T5-report.md` §3.
// ════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import { projectManifestToRules, grantForManifest } from '../grants.js';
import { authorizeAppleScript } from '../applescript.js';
import { authorizeSystemControl } from '../index.js';
import { resolveCommandArg } from '../resolve.js';
import { PRIMARY_AGENT_PERMISSIONS } from '../../manifest.js';
import type { PermissionManifest } from '@dojo/shared';

const base = {
  file_read: '*', file_write: '*', file_delete: 'none', exec_allow: [], exec_deny: [],
  network_domains: 'none', max_processes: 1,
  can_spawn_agents: false, can_assign_permissions: false,
} as const;

const withControl = (system_control: unknown): PermissionManifest =>
  ({ ...base, system_control } as unknown as PermissionManifest);

/** Does this manifest actually get to run a benign AppleScript? */
function mayRunAppleScript(manifest: PermissionManifest, agentId = 'a'): boolean {
  const resolved = resolveCommandArg('display dialog "hello"');
  if (!resolved.ok) throw new Error('fixture did not resolve');
  return authorizeAppleScript(grantForManifest(agentId, manifest), resolved.value).allowed;
}

const applescriptRows = (system_control: unknown): number =>
  projectManifestToRules(withControl(system_control)).filter((r) => r.effectKind === 'applescript').length;

describe('T3 INBOUND (b) — `system_control:\'*\'` stops meaning AppleScript', () => {
  it('a bare `\'*\'` no longer grants AppleScript, in either spelling', () => {
    // Both spellings, because a stored manifest legitimately holds either — the
    // ladder's branch 14/15 read it both ways and the projection kept that.
    expect(applescriptRows('*')).toBe(0);
    expect(applescriptRows(['*'])).toBe(0);
    expect(mayRunAppleScript(withControl('*'))).toBe(false);
    expect(mayRunAppleScript(withControl(['*']))).toBe(false);
  });

  it('an EXPLICIT grant still does, in both accepted spellings', () => {
    // Unchanged, and this is what the ladder's category compare already required
    // of a LIST — so a manifest that named it keeps working untouched.
    expect(applescriptRows(['applescript'])).toBe(1);
    expect(applescriptRows(['applescript_run'])).toBe(1);
    expect(mayRunAppleScript(withControl(['applescript']))).toBe(true);
    expect(mayRunAppleScript(withControl(['applescript_run']))).toBe(true);
  });

  it('a `\'*\'` holder that ALSO names it keeps it — the shape the migration writes', () => {
    // `["*","applescript"]` is exactly what migration 155 turns `["*"]` into, and
    // this clause is the reason the migration is not optional: without it the two
    // live `'*'` sub-agents lose a capability they have today.
    expect(applescriptRows(['*', 'applescript'])).toBe(1);
    expect(mayRunAppleScript(withControl(['*', 'applescript']))).toBe(true);
  });

  it('THE PRIMARY LOSES NOTHING — its own manifest carries the explicit grant', () => {
    // The positive test the posture requires beside the flip. If this fails the
    // owner's own agent just lost AppleScript.
    expect(PRIMARY_AGENT_PERMISSIONS.system_control).toContain('applescript');
    expect(mayRunAppleScript(PRIMARY_AGENT_PERMISSIONS, 'kevin')).toBe(true);
  });

  it('THE HEALER GAINS NOTHING — it never held `\'*\'`, so the flip is silent for it', () => {
    // The negative the brief asks for. The plan's premise named the Healer as a
    // `'*'` holder; the live row is `system_control: []`. Granting it AppleScript
    // to satisfy a stale sentence would have been a widening nobody decided.
    const healerShaped = withControl([]);
    expect(applescriptRows([])).toBe(0);
    expect(mayRunAppleScript(healerShaped, 'healer')).toBe(false);
  });

  it('`\'*\'` still means every OTHER system-control class — only AppleScript left', () => {
    // The flip must be surgical: a wildcard holder keeps mouse, keyboard and
    // screen. If this fails, the change narrowed far more than its one branch.
    for (const spelling of ['*', ['*']] as const) {
      const grant = grantForManifest('a', withControl(spelling));
      for (const category of ['mouse', 'keyboard', 'screen', 'web_browse']) {
        expect(
          authorizeSystemControl(grant, category, 'x').allowed,
          `'*' must still grant ${category}`,
        ).toBe(true);
      }
    }
  });

  it('the system_control rows themselves are untouched by the flip', () => {
    // `'*'` still projects its system_control allow row; what changed is only
    // that it no longer ALSO projects an applescript row.
    expect(projectManifestToRules(withControl('*')).filter((r) => r.effectKind === 'system_control')).toHaveLength(1);
    expect(projectManifestToRules(withControl(['*'])).filter((r) => r.effectKind === 'system_control')).toHaveLength(1);
  });
});
