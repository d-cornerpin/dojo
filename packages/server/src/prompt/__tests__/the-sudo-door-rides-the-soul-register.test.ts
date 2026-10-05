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
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../..');

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

// ════════════════════════════════════════════════════════════════════════════════════════
// THE CENSUS (D4) — both directions, comments stripped.
// ════════════════════════════════════════════════════════════════════════════════════════

/** Remove line comments and block comments. Full-line `//` only, so a markdown bullet or a
 *  URL inside a template literal is never touched. */
function stripTsComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter(line => !/^\s*\/\//.test(line))
    .join('\n');
}

/** The `## Capabilities` bullets of `DEFAULT_SOUL_MD`, read from SOURCE. */
function shippedCapabilityLines(templatesSource: string): string[] {
  const start = templatesSource.indexOf('export const DEFAULT_SOUL_MD = `');
  if (start < 0) throw new Error('DEFAULT_SOUL_MD is not declared the way this census reads it');
  const body = templatesSource.slice(start);
  const heading = body.indexOf('## Capabilities\n');
  if (heading < 0) throw new Error('DEFAULT_SOUL_MD no longer carries a `## Capabilities` heading');
  const after = body.slice(heading + '## Capabilities\n'.length);
  const out: string[] = [];
  for (const line of after.split('\n')) {
    if (!line.startsWith('- ')) break;
    out.push(line);
  }
  return out;
}

/**
 * THE CLOSED VOCABULARY, maintained here by hand and deliberately not derived.
 *
 * A capability is GATED when a door can prove the agent does not have it, which is the
 * register's whole subject. Deriving this list from the register would make the census
 * unable to see the one defect it exists for: a new gated line that nobody registered.
 * Files, the tracker and memory are NOT here — every agent has them, no door withholds them.
 */
const GATED_CAPABILITY_MARKERS = [
  'manage sub-agents',
  'execute shell commands',
  'administrator (sudo) commands',
] as const;

const TEMPLATES_SOURCE = fs.readFileSync(path.join(SRC, 'prompt/templates.ts'), 'utf-8');
const ASSEMBLER_SOURCE = fs.readFileSync(path.join(SRC, 'prompt/assembler.ts'), 'utf-8');
const SURFACE_SOURCE = fs.readFileSync(path.join(SRC, 'agent/tools/surface.ts'), 'utf-8');

describe('the census — the register and the shipped template cannot drift', () => {
  it('every register entry\'s line exists BYTE-FOR-BYTE in the shipped `## Capabilities` list', () => {
    const shipped = shippedCapabilityLines(stripTsComments(TEMPLATES_SOURCE));
    for (const claim of SOUL_CAPABILITY_CLAIMS) {
      expect(claim.line.endsWith('\n'), `claim ${JSON.stringify(claim.line)} must end in a newline`).toBe(true);
      expect(shipped, `register entry not in the shipped template: ${JSON.stringify(claim.line)}`)
        .toContain(claim.line.replace(/\n$/, ''));
    }
  });

  it('every shipped line naming a GATED capability has a register entry', () => {
    const shipped = shippedCapabilityLines(stripTsComments(TEMPLATES_SOURCE));
    const registered = new Set(SOUL_CAPABILITY_CLAIMS.map(c => c.line));
    const gated = shipped.filter(line => GATED_CAPABILITY_MARKERS.some(m => line.includes(m)));
    expect(gated.length, 'the closed vocabulary must match at least the three gated claims')
      .toBeGreaterThanOrEqual(GATED_CAPABILITY_MARKERS.length);
    for (const line of gated) {
      expect(registered, `shipped gated line with no register entry: ${JSON.stringify(line)}`)
        .toContain(`${line}\n`);
    }
  });

  it('the administrator line is registered, and it is the claim module that owns its bytes', () => {
    expect(SOUL_CAPABILITY_CLAIMS.map(c => c.line)).toContain(SOUL_ADMIN_COMMANDS_LINE);
    expect(shippedCapabilityLines(stripTsComments(TEMPLATES_SOURCE)))
      .toContain(SOUL_ADMIN_COMMANDS_LINE.replace(/\n$/, ''));
  });

  it('COMMENT STRIPPING IS DOING WORK, and a planted comment can neither satisfy nor break it', () => {
    // 1. The stripper removes real comments from this very file's input.
    expect(TEMPLATES_SOURCE).toMatch(/^\s*\/\//m);
    expect(stripTsComments(TEMPLATES_SOURCE)).not.toMatch(/^\s*\/\//m);
    // 2. A comment that LOOKS like a gated capability bullet changes no census answer —
    //    this is the clause that would otherwise be satisfiable by the prose (G4).
    const planted = TEMPLATES_SOURCE.replace(
      'export const DEFAULT_SOUL_MD = `',
      '// - You can manage sub-agents for specialized tasks (UNREGISTERED BAIT).\n'
      + 'export const DEFAULT_SOUL_MD = `',
    );
    expect(planted).not.toBe(TEMPLATES_SOURCE);
    expect(shippedCapabilityLines(stripTsComments(planted)))
      .toEqual(shippedCapabilityLines(stripTsComments(TEMPLATES_SOURCE)));
  });
});

describe('ONE module, two readers — neither surface spells the sentence itself', () => {
  it('the register imports the claim and does not re-declare the administrator line', () => {
    const stripped = stripTsComments(ASSEMBLER_SOURCE);
    expect(stripped).toMatch(
      /import\s*\{[^}]*\bSOUL_ADMIN_COMMANDS_CLAIM\b[^}]*\}\s*from\s*'\.\.\/agent\/brokers\/sudo-claim\.js'/,
    );
    // APPLICATION, not just presence: the claim is an element of the register array.
    expect(stripped).toMatch(/SOUL_CAPABILITY_CLAIMS[\s\S]*?\n\s*SOUL_ADMIN_COMMANDS_CLAIM,\n\s*\];/);
    expect(stripped).not.toContain('administrator (sudo) commands');
  });

  it('the tool surface asks the SAME door and renders the SAME sentence, and spells neither', () => {
    const stripped = stripTsComments(SURFACE_SOURCE);
    expect(stripped).toMatch(
      /import\s*\{[^}]*\bagentMayRunAdminCommands\b[^}]*\badminCommandsToolSentence\b[^}]*\}\s*from\s*'\.\.\/brokers\/sudo-claim\.js'/,
    );
    // APPLICATION: the door's answer gates the sentence, in that order, in one expression.
    expect(stripped).toMatch(/agentMayRunAdminCommands\(\s*agentId\s*,\s*sudoPolicy\s*\)/);
    expect(stripped).toMatch(/\?\s*adminCommandsToolSentence\(\s*sudoPolicy\s*,\s*finiteList\s*\)\s*:\s*''/);
    // And the v3.2.2 wording is GONE from this file — re-inlining it reds this clause.
    expect(stripped).not.toContain('Administrator commands:');
    expect(stripped).not.toContain('does not widen your command list');
  });
});
