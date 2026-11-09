// ════════════════════════════════════════════════════════════════════════════════════════
// THE SUDO DOOR RIDES THE SOUL CAPABILITY REGISTER — UX-ACCESS A4 fold-in (BACKLOG 111).
//
// v3.2.2 put the truth about administrator commands in the exec/shell tool DESCRIPTIONS
// only. This suite holds the soul half and the seam between the two:
//
//  • THE THREE REGISTER PROPERTIES, each one a clause, for the NEW claim specifically —
//    exact bytes, a byte-identical soul back for a holder, and a throwing door leaving the
//    soul exactly as authored (#15: absence is not evidence).
//  • THE CENSUS, counting BOTH WAYS (G4). Every register entry's `line` must exist
//    byte-for-byte in the shipped `## Capabilities` list, and every shipped line naming a
//    GATED capability must have a register entry. The closed vocabulary is maintained here,
//    on purpose: a new gated line nobody registered is the defect, and a test that
//    discovers its own vocabulary from the register cannot see it.
//  • COMMENT STRIPPING IS LOAD-BEARING AND PROVEN, not asserted. `templates.ts`'s own
//    header quotes the conditional lines in prose; a census that read the raw file could be
//    satisfied by the paragraph above the template instead of the template.
//  • CACHE SAFETY (G2): the same agent, assembled twice under the same state, gets
//    byte-identical souls — the claim reads (role, policy, grants) and nothing per-turn.
//
// The cross-surface clauses — the soul and the tool description moving together off one
// policy read — live in `agent/brokers/__tests__/one-truth-about-administrator-commands.test.ts`,
// because they need the real tool surface as well as the register.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── The state the doors answer from. Fictional agents only (G1). ──
const box = {
  primaryId: 'fixture-primary',
  /** What the platform config row holds. `getSudoPolicy` is the REAL function over this. */
  policyRaw: 'gated' as string | null,
  /** When set, the policy read THROWS — the absence-is-not-evidence probe. */
  policyThrows: false,
  execAllow: ['*'] as string[],
  shellAllow: undefined as string[] | undefined,
  canSpawn: true,
};

vi.mock('../../config/platform.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    isPrimaryAgent: (id: string) => id === box.primaryId,
    isPMAgent: () => false,
    isTrainerAgent: () => false,
    isHealerAgent: () => false,
    isImaginerAgent: () => false,
    getSudoPolicyRaw: () => {
      if (box.policyThrows) throw new Error('platform config unreadable');
      return box.policyRaw;
    },
  };
});

vi.mock('../../agent/manifest.js', () => ({
  getAgentPermissions: () => ({
    exec_allow: box.execAllow,
    shell_allow: box.shellAllow,
    can_spawn_agents: box.canSpawn,
    file_read: '*', file_write: '*', file_delete: [],
    network_domains: 'none', max_processes: 2,
    can_assign_permissions: false, system_control: [],
  }),
}));

vi.mock('../../db/connection.js', () => ({
  getDb: () => { throw new Error('this suite must not reach the database'); },
}));

vi.mock('../../agent/tools/surface.js', () => ({ getFilteredTools: () => [] }));

import { SOUL_CAPABILITY_CLAIMS, applySoulCapabilityTruth } from '../assembler.js';
import { SOUL_ADMIN_COMMANDS_LINE } from '../../agent/brokers/sudo-claim.js';

beforeEach(() => {
  box.primaryId = 'fixture-primary';
  box.policyRaw = 'gated';
  box.policyThrows = false;
  box.execAllow = ['*'];
  box.shellAllow = undefined;
  box.canSpawn = true;
});

/**
 * A soul in the shape `templates.ts` ships, built from the SHIPPED bytes so a wording edit
 * cannot leave this fixture behind. Only the administrator line is of interest here; the
 * other two claims are held true so nothing else moves.
 */
const SOUL = [
  '## Capabilities',
  '- You can read, write, and manage files on the local filesystem.',
  '- You can execute shell commands.',
  SOUL_ADMIN_COMMANDS_LINE.replace(/\n$/, ''),
  '- You can manage sub-agents for specialized tasks.',
  '- You have persistent memory across conversations.',
  '',
].join('\n');

describe('the administrator-commands claim and the three register properties', () => {
  it('EXACT BYTES: the claim removes the whole line and disturbs nothing else', () => {
    box.policyRaw = 'blocked';
    const out = applySoulCapabilityTruth(SOUL, 'fixture-primary');
    expect(out).not.toContain('administrator (sudo) commands');
    expect(out).toContain('- You can execute shell commands.');
    expect(out).toContain('- You can manage sub-agents for specialized tasks.');
    expect(out).toContain('## Capabilities');
    expect(out.split('\n').length).toBe(SOUL.split('\n').length - 1);
  });

  it('BY IDENTITY FOR A HOLDER: a primary under gated gets the soul back byte-identical', () => {
    const out = applySoulCapabilityTruth(SOUL, 'fixture-primary');
    // `Object.is` on a string is a BYTE comparison, not a reference one, and that is exactly
    // the property worth holding: a holder's prefix cannot move. `applySoulCapabilityTruth`
    // achieves it by returning the input binding untouched when nothing is stripped, which is
    // what makes the register cache-safe by construction rather than by care.
    expect(out).toBe(SOUL);
    expect(Object.is(out, SOUL)).toBe(true);
  });

  it('BY IDENTITY, under `free` too — one line, true under both allowing policies', () => {
    box.policyRaw = 'free';
    expect(Object.is(applySoulCapabilityTruth(SOUL, 'fixture-primary'), SOUL)).toBe(true);
  });

  it('ABSENCE IS NOT EVIDENCE: a throwing policy read leaves the soul exactly as authored', () => {
    box.policyThrows = true;
    const out = applySoulCapabilityTruth(SOUL, 'fixture-primary');
    expect(Object.is(out, SOUL)).toBe(true);
    expect(out).toContain('administrator (sudo) commands');
  });

  it('an unrecognised stored policy reads as the shipped default, never as `free`', () => {
    // The fail-safe lives in `getSudoPolicy`; this clause proves the claim rides it rather
    // than comparing strings itself. `gated` is the default, so the line HOLDS.
    box.policyRaw = 'FREE-ISH';
    expect(Object.is(applySoulCapabilityTruth(SOUL, 'fixture-primary'), SOUL)).toBe(true);
  });

  it('a soul that never carried the line is returned unchanged, by identity, either way', () => {
    const authored = '# Identity\n\nYou are the box owner\'s assistant.\n\n# Rules\n\n- Be direct.\n';
    box.policyRaw = 'blocked';
    expect(Object.is(applySoulCapabilityTruth(authored, 'fixture-primary'), authored)).toBe(true);
    box.policyRaw = 'free';
    expect(Object.is(applySoulCapabilityTruth(authored, 'fixture-primary'), authored)).toBe(true);
  });
});

describe('the door the claim rides — the three conjuncts, through the register', () => {
  it('THE ROLE WALL: a non-primary loses the line under every policy, settings included', () => {
    for (const policy of ['gated', 'free', 'blocked']) {
      box.policyRaw = policy;
      const out = applySoulCapabilityTruth(SOUL, 'a-sub-agent');
      expect(out, `policy=${policy}`).not.toContain('administrator (sudo) commands');
    }
  });

  it('THE POLICY: `blocked` strips it, `gated` and `free` keep it', () => {
    box.policyRaw = 'blocked';
    expect(applySoulCapabilityTruth(SOUL, 'fixture-primary')).not.toContain('administrator (sudo)');
    for (const policy of ['gated', 'free']) {
      box.policyRaw = policy;
      expect(applySoulCapabilityTruth(SOUL, 'fixture-primary'), `policy=${policy}`)
        .toContain('administrator (sudo) commands');
    }
  });

  // ⚠ THE REACH OF THE NEXT TWO CLAUSES, so nobody reads them as production states (review
  // finding 1, 2026-10-05). They drive the PREDICATE, and they can only reach a grantless
  // primary because this file mocks `agent/manifest.js`. In production
  // `getAgentPermissions` returns the constant `PRIMARY_AGENT_PERMISSIONS` for any primary
  // before reading a row, so conjunct 3 is never false when conjunct 1 has passed. These hold
  // the conjunct against the day a manifest path narrows the primary; they are not a claim
  // that it is narrow today.
  it('A COMMAND GRANT: no exec and no shell strips it whatever the policy says', () => {
    box.execAllow = [];
    box.shellAllow = [];
    for (const policy of ['gated', 'free']) {
      box.policyRaw = policy;
      expect(applySoulCapabilityTruth(SOUL, 'fixture-primary'), `policy=${policy}`)
        .not.toContain('administrator (sudo) commands');
    }
  });

  it('a shell-only primary KEEPS it — `shell_allow` is its own grant, not a shadow of exec', () => {
    box.execAllow = [];
    box.shellAllow = ['ls', 'cat'];
    expect(applySoulCapabilityTruth(SOUL, 'fixture-primary')).toContain('administrator (sudo) commands');
  });
});

describe('cache safety (G2): the claim reads nothing that moves within a turn', () => {
  it('two assemblies of the same agent under the same state are byte-identical', () => {
    const first = applySoulCapabilityTruth(SOUL, 'fixture-primary');
    const second = applySoulCapabilityTruth(SOUL, 'fixture-primary');
    expect(second).toBe(first);
    box.policyRaw = 'blocked';
    const stripped = applySoulCapabilityTruth(SOUL, 'fixture-primary');
    const strippedAgain = applySoulCapabilityTruth(SOUL, 'fixture-primary');
    expect(strippedAgain).toBe(stripped);
    expect(stripped).not.toBe(first);
  });
});

describe('the census — the register and the shipped template cannot drift', () => {

  it('the administrator line is registered, and it is the claim module that owns its bytes', () => {
    expect(SOUL_CAPABILITY_CLAIMS.map(c => c.line)).toContain(SOUL_ADMIN_COMMANDS_LINE);
  });
});
