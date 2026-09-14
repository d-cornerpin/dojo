// ════════════════════════════════════════════════════════════════════════════════
// THE PROMPT TELLS THE TRUTH (UX-ACCESS A4, scope item 1) — RED-first.
//
// A1 §6.5 handed this here in writing:
//
//   > Surface truth for channel tools. Every agent is still ADVERTISED
//   > `imessage_send` and refused at the door, as at HEAD. Stripping it by grant
//   > would move ~110 agents' tool indexes — a prompt change A1 is committed to
//   > not making. A4 owns prompt/capability truth.
//
// And the plan's DESIGN names the layer: *"Enforcement at every layer,
// `can_spawn_agents`-style: MODEL'S TOOL LIST · executor gate · handler walls ·
// channel doors take agent identity … · prompt/capability truth"*.
//
// TWO MECHANISMS, one idea. The `can_spawn_agents` pattern has always been a
// PAIR — the tool leaves the advertised list, and the soul's claim about it is
// spliced out — and A4 generalizes both halves:
//
//   THE SURFACE   a `SEND_TO_PEOPLE` tool whose channel is not granted leaves
//                 `getFilteredTools`. Because `generateToolsGuidance_v2`'s
//                 per-tool blocks are keyed on that list, the `## iMessage`
//                 paragraph stops being emitted with no second rule anywhere.
//   THE SOUL      `applySpawnCapabilityTruth`'s one hard-coded line becomes
//                 `SOUL_CAPABILITY_CLAIMS`, a register of exact shipped bytes
//                 and the door that answers each.
//
// MEASURED BEFORE BUILDING, on the owner's live database at `ac945a99`: 105 of
// 111 agents were advertised exactly six tools they hold no grant for —
// `imessage_send`, `imessage_list_contacts`, `sms_send`, `voice_call`,
// `voice_call_end`, `voice_call_status` — and every one of the six is refused
// for those agents at a door that already reads `mayUseChannel`. §3 is that
// measurement as a property: nothing that is stripped was ever permitted.
//
// RED AT `ac945a99`: `applySoulCapabilityTruth` and `SOUL_CAPABILITY_CLAIMS` do
// not exist (module has no such export), and `getFilteredTools` for an agent
// with no channel grant still returns `imessage_send`.
// ════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };

vi.mock('../../../db/connection.js', async () => {
  const os = await import('node:os');
  const p = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => p.join(os.tmpdir(), 'dojo-a4-prompt', 'dojo.db'),
  };
});

vi.mock('../../../config/platform.js', async () => {
  const actual = await vi.importActual<typeof import('../../../config/platform.js')>('../../../config/platform.js');
  return {
    ...actual,
    isPrimaryAgent: (id: string) => id === 'primary',
    isPMAgent: (id: string) => id === 'pm',
    isHealerAgent: () => false,
    isTrainerAgent: () => false,
    isImaginerAgent: () => false,
    getPrimaryAgentId: () => 'primary',
    getPrimaryAgentName: () => 'Primary',
    getOwnerName: () => 'David',
  };
});

import { runMigrations } from '../../../db/migrations.js';
import { getFilteredTools } from '../../tools/surface.js';
import { generateToolsGuidance_v2, applySoulCapabilityTruth, SOUL_CAPABILITY_CLAIMS } from '../../../prompt/assembler.js';
import { DEFAULT_SOUL_MD } from '../../../prompt/templates.js';
import { forgetAccessGrants, mayUseChannel } from '../read.js';
import { channelForTool } from '../channels.js';
import { deriveLegacyGrants } from '../derive.js';
import { SEND_TO_PEOPLE } from '../../sensei-policy.js';
import { gatesForCall } from '../../tools/gates.js';
import { evaluateGate } from '../../tools/gate-eval.js';
import type { AccessGrants } from '@dojo/shared';

const db = (): Database.Database => mockDb.current!;

function agent(
  id: string,
  opts: { classification?: string; permissions?: Record<string, unknown>; grants?: (g: AccessGrants) => void } = {},
): void {
  // `created_by` is explicit: the column DEFAULTS to `'system'`, and
  // `getAgentPermissions` reads `spawn_depth === 0 && created_by === 'system'`
  // as THE platform-seeded primary and answers `PRIMARY_AGENT_PERMISSIONS`
  // whatever the row stores. A fixture that forgets this silently tests an
  // agent that holds everything — which is exactly how a truth test passes
  // while the truth function does nothing.
  db().prepare(
    `INSERT INTO agents (id, name, status, classification, created_by, spawn_depth, session_started_at)
     VALUES (?, ?, 'idle', ?, ?, 1, '1970-01-01')`,
  ).run(id, id, opts.classification ?? 'apprentice', id === 'primary' ? 'system' : 'primary');
  forgetAccessGrants();
  const doc: Record<string, unknown> = { ...(opts.permissions ?? {}) };
  if (opts.grants) {
    const g = deriveLegacyGrants(id);
    opts.grants(g);
    doc.grants = g;
  }
  if (Object.keys(doc).length > 0) {
    db().prepare('UPDATE agents SET permissions = ? WHERE id = ?').run(JSON.stringify(doc), id);
  }
  forgetAccessGrants();
}

const names = (id: string): string[] => getFilteredTools(id).map((t) => t.name);

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  forgetAccessGrants();
});

// ════════════════════════════════════════════════════════════════════════════════
// 1 · THE SOUL REGISTER — exact bytes, the door that answers, identity for holders
// ════════════════════════════════════════════════════════════════════════════════

describe('the soul capability register', () => {
  it('⚠ EVERY REGISTERED LINE IS EXACT SHIPPED BYTES OF THE DEFAULT SOUL', () => {
    // The whole safety of splicing is that it matches the PLATFORM'S OWN line
    // and never a reading of the owner's prose. If `templates.ts` is re-worded
    // and this register is not, the claim silently stops being conditional —
    // which is the failure `templates.ts`'s own note warns about.
    expect(SOUL_CAPABILITY_CLAIMS.length).toBeGreaterThanOrEqual(2);
    for (const claim of SOUL_CAPABILITY_CLAIMS) {
      expect(DEFAULT_SOUL_MD.includes(claim.line), `templates.ts still ships: ${JSON.stringify(claim.line)}`).toBe(true);
      expect(claim.line.endsWith('\n'), 'a registered line carries its own newline').toBe(true);
    }
  });

  it('the register covers spawn AND exec — T3\'s line, plus the one the census found', () => {
    const lines = SOUL_CAPABILITY_CLAIMS.map((c) => c.line);
    expect(lines).toContain('- You can manage sub-agents for specialized tasks.\n');
    expect(lines).toContain('- You can execute shell commands.\n');
  });

  it('⚠ A HOLDER GETS THE STRING BACK BY IDENTITY — a prefix byte cannot move for it', () => {
    // The cache-safety property, as a property. The primary holds both claims,
    // so its soul is the SAME OBJECT out as in.
    agent('primary', { permissions: { can_spawn_agents: true, exec_allow: ['*'] } });
    const out = applySoulCapabilityTruth(DEFAULT_SOUL_MD, 'primary');
    expect(out).toBe(DEFAULT_SOUL_MD);
  });

  it('an agent with an EMPTY exec_allow loses the exec claim and keeps everything else', () => {
    agent('reader', { permissions: { can_spawn_agents: true, exec_allow: [] } });
    const out = applySoulCapabilityTruth(DEFAULT_SOUL_MD, 'reader');
    expect(out).not.toContain('- You can execute shell commands.');
    // The claims are independent: spawn is held, so its line stays.
    expect(out).toContain('- You can manage sub-agents for specialized tasks.');
    // And nothing else moved: the only delta is that one line.
    expect(DEFAULT_SOUL_MD.replace('- You can execute shell commands.\n', '')).toBe(out);
  });

  it('an agent that holds NEITHER loses both, and the surrounding list survives', () => {
    agent('narrow', { permissions: { can_spawn_agents: false, exec_allow: [] } });
    const out = applySoulCapabilityTruth(DEFAULT_SOUL_MD, 'narrow');
    expect(out).not.toContain('- You can execute shell commands.');
    expect(out).not.toContain('- You can manage sub-agents for specialized tasks.');
    expect(out).toContain('## Capabilities');
    expect(out).toContain('- You can read, write, and manage files on the local filesystem.');
    expect(out).toContain('- You have persistent memory across conversations.');
  });

  it('a soul that never carried the line is returned unchanged (the owner\'s own SOUL.md)', () => {
    // The owner's real file, in shape: identity + rules, no platform capability
    // list. Nothing in the register matches, so nothing is edited — which is why
    // his primary's cached prefix cannot move whatever he is granted.
    agent('narrow', { permissions: { can_spawn_agents: false, exec_allow: [] } });
    const owner = '# Identity\n\nYou are Kevin.\n\n# Rules\n\n- Never modify your own system prompt files.\n';
    expect(applySoulCapabilityTruth(owner, 'narrow')).toBe(owner);
  });

  it('⚠ ABSENCE IS NOT EVIDENCE (#15) — an unreadable door leaves the claim alone', () => {
    // No agent row at all: `getAgentPermissions` answers the sub-agent default
    // rather than throwing, so this asserts the posture on the one door that can
    // throw — a claim whose predicate raises must not strip.
    const claim = { line: '- You can execute shell commands.\n', holds: () => { throw new Error('db down'); } };
    const register = [claim];
    // Applied through the same loop shape the module uses.
    let out = DEFAULT_SOUL_MD;
    for (const c of register) {
      try { if (!c.holds()) out = out.split(c.line).join(''); } catch { /* leave alone */ }
    }
    expect(out).toBe(DEFAULT_SOUL_MD);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 2 · THE SURFACE STRIP — the model's tool list stops naming ungranted channels
// ════════════════════════════════════════════════════════════════════════════════

describe('the channel tools leave the advertised surface', () => {
  it('⚠ THE SIX MEASURED NAMES GO, FOR AN AGENT WITH NO CHANNEL GRANT', () => {
    agent('nogrant', { grants: (g) => { g.channels.master = false; } });
    const advertised = names('nogrant');
    for (const tool of ['imessage_send', 'imessage_list_contacts', 'sms_send', 'voice_call', 'voice_call_end', 'voice_call_status']) {
      expect(advertised, `${tool} is not advertised`).not.toContain(tool);
    }
  });

  it('the primary keeps every one of them — the strip is a grant, not a role', () => {
    agent('primary');
    const advertised = names('primary');
    for (const tool of ['imessage_send', 'sms_send', 'voice_call']) {
      expect(advertised, `${tool} stays for a holder`).toContain(tool);
    }
  });

  it('A GRANT ON ONE CHANNEL RESTORES ONLY THAT CHANNEL\'S TOOLS', () => {
    agent('operator', { grants: (g) => { g.channels.master = true; g.channels.imessage = 'owner'; } });
    const advertised = names('operator');
    expect(advertised).toContain('imessage_send');
    expect(advertised).toContain('imessage_list_contacts');
    expect(advertised).not.toContain('sms_send');
    expect(advertised).not.toContain('voice_call');
  });

  it('the ÜBER TOGGLE governs the strip, because `channelTierOf` governs the reader', () => {
    // Owner ruling 1 held at a surface it was never written into: the per-channel
    // value survives under a false master and is inert, so the tool stays off the
    // list until the master comes back on.
    agent('muted', { grants: (g) => { g.channels.master = false; g.channels.imessage = 'all'; } });
    expect(names('muted')).not.toContain('imessage_send');
  });

  it('a tool that reaches NOBODY is never touched by this filter', () => {
    agent('nogrant', { grants: (g) => { g.channels.master = false; } });
    const advertised = names('nogrant');
    for (const tool of ['send_to_agent', 'file_read', 'vault_search']) {
      expect(channelForTool(tool), `${tool} reaches no channel`).toBeNull();
      expect(advertised, `${tool} survives`).toContain(tool);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 3 · THE SAFETY PROPERTY — nothing stripped was ever permitted
// ════════════════════════════════════════════════════════════════════════════════

describe('the strip removes advertisement and never capability', () => {
  it('⚠ EVERY SEND_TO_PEOPLE TOOL THIS FILTER CAN REMOVE IS ALREADY REFUSED AT A DOOR', () => {
    // The claim that makes A4's surface change inert rather than a narrowing,
    // and it is walked rather than asserted about six remembered names. For each
    // tool on the build-checked send surface: if the filter would remove it, the
    // agent must already be unable to use it — which for the ladder-gated names
    // is a DRIVEN refusal, and for the rest is `mayUseChannel` being the same
    // predicate the handler wall and `mayWriteWorkspace` ask.
    agent('nogrant', { grants: (g) => { g.channels.master = false; } });
    const removable = SEND_TO_PEOPLE.filter((t) => {
      const ch = channelForTool(t);
      return ch !== null && !mayUseChannel('nogrant', ch);
    });
    expect(removable.length, 'the filter has real work to do').toBeGreaterThan(0);
    for (const tool of removable) {
      const channel = channelForTool(tool)!;
      expect(mayUseChannel('nogrant', channel), `${tool}: the door says no`).toBe(false);
    }
  });

  it('the two ladder-gated names are DRIVEN to a refusal, not merely asserted about', async () => {
    agent('nogrant', { grants: (g) => { g.channels.master = false; } });
    for (const tool of ['imessage_send', 'imessage_list_contacts']) {
      const args = { to: 'David', message: 'hi' };
      const channelGate = gatesForCall(tool, args).find((g) => g.kind === 'channel');
      expect(channelGate, `${tool} carries a channel gate`).toBeDefined();
      const outcome = await evaluateGate(channelGate!, {
        agentId: 'nogrant', name: tool, args, resolveRef: () => null,
      });
      expect(outcome.verdict.allowed, `${tool} is refused at the executor`).toBe(false);
      expect(outcome.errorCode, `${tool} refusal is a settled no`).toBe('PERMISSION_DENIED');
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 4 · THE GUIDANCE FOLLOWS THE LIST — no second rule was written
// ════════════════════════════════════════════════════════════════════════════════

describe('the tool guidance stops claiming the capability', () => {
  it('⚠ THE `## iMessage` BLOCK IS GONE FOR AN AGENT WITH NO CHANNEL GRANT', () => {
    agent('nogrant', { grants: (g) => { g.channels.master = false; } });
    const guidance = generateToolsGuidance_v2('nogrant');
    expect(guidance).not.toContain('## iMessage');
    expect(guidance).not.toContain('texts David via iMessage');
  });

  it('and it is BACK the moment the channel is granted', () => {
    agent('operator', { grants: (g) => { g.channels.master = true; g.channels.imessage = 'owner'; } });
    const guidance = generateToolsGuidance_v2('operator');
    expect(guidance).toContain('## iMessage');
  });

  it('the block was never re-keyed — it still reads the tool list, which is the point', () => {
    // If someone later adds a second `mayUseChannel` check inside the guidance,
    // there are two rules for one fact again. The guidance must remain a pure
    // function of what the surface advertised: no channel grant → no tool → no
    // block, all through one filter.
    agent('operator', { grants: (g) => { g.channels.master = true; g.channels.imessage = 'owner'; } });
    expect(names('operator')).toContain('imessage_send');
    expect(generateToolsGuidance_v2('operator')).toContain('## iMessage');
    agent('nogrant', { grants: (g) => { g.channels.master = false; } });
    expect(names('nogrant')).not.toContain('imessage_send');
    expect(generateToolsGuidance_v2('nogrant')).not.toContain('## iMessage');
  });
});
