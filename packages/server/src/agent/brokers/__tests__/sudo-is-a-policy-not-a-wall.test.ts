// ════════════════════════════════════════════════════════════════════════════════════════
// SUDO IS A POLICY, NOT A WALL — owner ruling 2026-09-26, ships v3.2.2.
//
// `sudo *` left the hardcoded `GLOBAL_EXEC_DENY` floor and became a per-box setting
// (`blocked | gated | free`, default gated). The premise, in the owner's words: the agent's own Mac
// mini means the main agent controls the machine, and the blanket block contradicted that — the
// platform's own `IMSG_INSTALL_HINT` prints two `sudo cp` lines FOR THE AGENT TO RUN and then
// refused to let it.
//
// ── §2 IS THE NON-NEGOTIABLE AND IT IS WHY THIS FILE EXISTS ──────────────────────────────────
// The other three floor entries must bite INSIDE a sudo line under EVERY policy, including `free`.
// The mechanism is that sudo is a TRANSPARENT WRAPPER for authorization: it is stripped, the entire
// broker pipeline re-runs over the inner command, and only then does policy apply. Every clause in
// §2 runs under all three policies, so a regression cannot hide in one of them.
//
// ⚠ AND §2 PINS THE PARSER, because the strip is the security-critical part and it is not
// `slice(5)`: `sudo -u root rm -rf /` under a naive prefix strip leaves `-u root rm -rf /`, which
// matches no floor pattern at all. The fixture table carries the value-taking options, the `--`
// terminator, the `=` form, a nested wrapper and an absolute-path spelling.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, vi } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRCDIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** The policy the broker will read. Set per clause; the accessor is mocked at the config seam so
 *  these clauses need no database. */
const policyRow: { current: string | null } = { current: null };

/** Which agent id counts as the primary. The role wall reads this. */
const PRIMARY = 'primary-agent';

vi.mock('../../../config/platform.js', async (orig) => ({
  ...(await orig<typeof import('../../../config/platform.js')>()),
  getSudoPolicyRaw: () => {
    if (policyRow.current === '__throw__') throw new Error('config unavailable');
    return policyRow.current;
  },
  isPrimaryAgent: (id: string) => id === PRIMARY,
}));

import { grantForManifest } from '../grants.js';
import { authorizeShellCommandText } from '../proc.js';
import {
  SUDO_BLOCKED_REASON, SUDO_NOT_PRIMARY_REASON, SUDO_POLICY_DEFAULT, getSudoPolicy, isSudoLine,
  isSudoHoldRequired, parseSudo, sudoOwnerCardCopy, sudoPasswordPromptMessage, sudoersDropInLine,
  type SudoPolicy,
} from '../sudo-policy.js';
import type { PermissionManifest } from '@dojo/shared';
import { engineFileContaining } from '../../v2/__tests__/engine-sources.js';

const base = {
  file_read: '*', file_write: '*', file_delete: 'none', exec_deny: [],
  network_domains: 'none', max_processes: 1,
  can_spawn_agents: false, can_assign_permissions: false,
} as const;

/** An agent allowed to run anything its grants permit. */
const wideOpen = ({ ...base, exec_allow: ['*'] } as unknown) as PermissionManifest;
/** An agent allowed exactly nothing — the grants half of the matrix. */
const denyAll = ({ ...base, exec_allow: [] } as unknown) as PermissionManifest;

/** ⚠ DEFAULTS TO THE PRIMARY, because after the 2026-09-27 ruling nobody else can sudo at all and a
 *  policy matrix run as a sub-agent would measure the role wall on every row. §0 is the sub-agent half. */
const verdict = (command: string, manifest: PermissionManifest = wideOpen, agentId = PRIMARY) =>
  authorizeShellCommandText(grantForManifest(agentId, manifest), command);
const allowed = (command: string, manifest: PermissionManifest = wideOpen, agentId = PRIMARY): boolean =>
  verdict(command, manifest, agentId).allowed;

const ALL_POLICIES: readonly SudoPolicy[] = ['blocked', 'gated', 'free'];
const underEach = (fn: (p: SudoPolicy) => void): void => {
  for (const p of ALL_POLICIES) { policyRow.current = p; fn(p); }
};

beforeEach(() => { policyRow.current = null; });

// ════════════════════════════════════════════════════════════════════════════════════════
// §0 — THE ROLE WALL. Owner ruling 2026-09-27: "ONLY the main agent gets Sudo access ever."
//
// It is not a policy outcome and no setting reaches it, which is why every clause here runs under ALL
// THREE policies and why the refusal speaks in the FLOOR's voice. A sub-agent told "the policy refused
// you" would go to the owner asking for a setting change that cannot help it.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§0 only the primary agent may sudo, ever', () => {
  it('a SUB-AGENT is refused under blocked, gated AND free', () => {
    for (const line of ['sudo ls', 'sudo cp a b', 'sudo apt-get install -y ffmpeg']) {
      underEach((p) => {
        const v = verdict(line, wideOpen, 'some-worker');
        expect(v.allowed, `${p}: ${line}`).toBe(false);
        expect(v.allowed === false && v.reason, `${p}: ${line}`).toBe(SUDO_NOT_PRIMARY_REASON);
      });
    }
  });

  it('even a WILDCARD sub-agent is refused — it is a role wall, not a grant', () => {
    underEach(() => expect(allowed('sudo ls', wideOpen, 'some-worker')).toBe(false));
  });

  it('the refusal speaks in the FLOOR\'s voice and names the one route that exists', () => {
    expect(SUDO_NOT_PRIMARY_REASON).toContain('Global deny');
    expect(SUDO_NOT_PRIMARY_REASON).toContain('no permission setting changes that');
    expect(SUDO_NOT_PRIMARY_REASON).toContain('role boundary');
    expect(SUDO_NOT_PRIMARY_REASON).toContain('send_to_agent');
    // and it does NOT claim the policy did it
    expect(SUDO_NOT_PRIMARY_REASON).not.toMatch(/policy is|setting is|gated|blocked/);
  });

  it('THE FLOOR STILL SPEAKS FIRST for a sub-agent: `sudo rm -rf /` is a floor refusal', () => {
    // Ordering, and it is deliberate: the most specific true thing about `sudo rm -rf /` is that
    // `rm -rf /` is forbidden to everyone — not that this caller is the wrong role, which would leave
    // the reader thinking some other agent could run it.
    underEach(() => {
      const v = verdict('sudo rm -rf /', wideOpen, 'some-worker');
      expect(v.allowed).toBe(false);
      expect(v.allowed === false && v.reason).toMatch(/Global deny: command "rm -rf \/"|rm -rf/);
      expect(v.allowed === false && v.reason).not.toBe(SUDO_NOT_PRIMARY_REASON);
    });
  });

  it('the PRIMARY is the one exception, and the policy governs it', () => {
    policyRow.current = 'free';
    expect(allowed('sudo ls', wideOpen, PRIMARY)).toBe(true);
    expect(allowed('sudo ls', wideOpen, 'some-worker')).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §1 — THE POLICY MATRIX (the PRIMARY's, since it is the only agent the policy governs).
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§1 the policy decides an ordinary sudo line', () => {
  it('DEFAULT IS GATED, and an unset row reads as gated rather than as free', () => {
    policyRow.current = null;
    expect(getSudoPolicy()).toBe('gated');
    expect(SUDO_POLICY_DEFAULT).toBe('gated');
  });

  it('an UNRECOGNISED value reads as the default — never as free', () => {
    for (const junk of ['', 'FREE', 'allow', 'yes', 'true', 'unrestricted']) {
      policyRow.current = junk;
      expect(getSudoPolicy(), junk).toBe('gated');
    }
  });

  it('blocked REFUSES, with the floor\'s verbatim wording', () => {
    policyRow.current = 'blocked';
    const v = verdict('sudo cp bin/imsg /opt/homebrew/bin/');
    expect(v.allowed).toBe(false);
    // Verbatim what `GLOBAL_EXEC_DENY`'s `'sudo *'` entry said before it left the list, so a box on
    // `blocked` is byte-identical to the old behaviour the owner may still want.
    expect(v.allowed === false && v.reason).toBe(SUDO_BLOCKED_REASON);
  });

  it('gated ALLOWS AT THE BROKER — the consent hold is the dispatch gate\'s, upstream', () => {
    // If the broker denied here, the post-approval retry would be refused and the one-shot approval
    // spent for nothing, and the PRIMARY (which the gate does not hold) could never run sudo at all.
    policyRow.current = 'gated';
    const v = verdict('sudo cp bin/imsg /opt/homebrew/bin/');
    expect(v.allowed).toBe(true);
    expect(v.allowed && v.rule).toContain('sudo-policy:gated');
  });

  it('free ALLOWS', () => {
    policyRow.current = 'free';
    const v = verdict('sudo cp bin/imsg /opt/homebrew/bin/');
    expect(v.allowed).toBe(true);
    expect(v.allowed && v.rule).toContain('sudo-policy:free');
  });

  it('THE OWNER\'S OWN EXAMPLE runs on gated and free: the hint the platform prints', () => {
    // `services/imessage-bridge.ts`'s IMSG_INSTALL_HINT, the contradiction that motivated the ruling.
    for (const line of [
      'sudo cp bin/imsg /opt/homebrew/bin/',
      'sudo cp .build/release/PhoneNumberKit_PhoneNumberKit.bundle /opt/homebrew/bin/',
      'sudo apt-get install -y ffmpeg',
    ]) {
      policyRow.current = 'gated'; expect(allowed(line), `gated: ${line}`).toBe(true);
      policyRow.current = 'free'; expect(allowed(line), `free: ${line}`).toBe(true);
      policyRow.current = 'blocked'; expect(allowed(line), `blocked: ${line}`).toBe(false);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §2 — THE NON-NEGOTIABLE: THE FLOOR BITES INSIDE SUDO, UNDER EVERY POLICY.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§2 the floor is not escapable by prefixing sudo', () => {
  it('`sudo rm -rf /` is REFUSED under blocked, gated AND free', () => {
    underEach((p) => {
      expect(allowed('sudo rm -rf /'), `policy=${p}`).toBe(false);
    });
  });

  it('every remaining floor entry, inside sudo, under every policy', () => {
    for (const line of ['sudo rm -rf /', 'sudo rm -rf ~', 'sudo chmod 777 /etc']) {
      underEach((p) => expect(allowed(line), `${p}: ${line}`).toBe(false));
    }
  });

  it('THE PARSER: sudo\'s own options cannot carry a floor command past the floor', () => {
    // The mutation this pins: a naive `slice(5)` leaves `-u root rm -rf /`, which matches nothing.
    for (const line of [
      'sudo -u root rm -rf /',
      'sudo --user root rm -rf /',
      'sudo --user=root rm -rf /',
      'sudo -n rm -rf /',
      'sudo -E rm -rf /',
      'sudo -H -u root rm -rf /',
      'sudo -p "pw: " rm -rf /',          // refused by the fail-closed parse, not by a floor match
      'sudo -- rm -rf /',
      'sudo sudo rm -rf /',
      '/usr/bin/sudo rm -rf /',
      'sudo -u root -- rm -rf ~',
      'sudo   rm   -rf   /',
    ]) {
      underEach((p) => expect(allowed(line), `${p}: ${line}`).toBe(false));
    }
  });

  it('an UNPARSEABLE sudo line is refused under every policy, and says how to rewrite it', async () => {
    const { SUDO_UNPARSEABLE_REASON } = await import('../sudo-policy.js');
    underEach((p) => {
      const v = verdict('sudo -p "pw: " ls');
      expect(v.allowed, `policy=${p}`).toBe(false);
      expect(v.allowed === false && v.reason, `policy=${p}`).toBe(SUDO_UNPARSEABLE_REASON);
    });
    expect(SUDO_UNPARSEABLE_REASON).toContain('will not guess');
    expect(SUDO_UNPARSEABLE_REASON).toContain('Rewrite it');
  });

  it('the credentials file cannot be read through sudo, under every policy', () => {
    for (const line of [
      'sudo cat ~/.dojo/secrets.yaml',
      'sudo -u root cat ~/.dojo/secrets.yaml',
      'sudo cp ~/.dojo/secrets.yaml /tmp/x',
    ]) {
      underEach((p) => expect(allowed(line), `${p}: ${line}`).toBe(false));
    }
  });

  it('THE SENSITIVE-PATH SCAN IS POSITION-INDEPENDENT, and the broker relies on that', async () => {
    // `authorizeSudoLine` deliberately does NOT re-run `commandReadsSensitiveFile` on the inner
    // command, because that scan walks EVERY token and so already sees inside a sudo line. This
    // clause is the reliance made checkable rather than assumed — remove the property and it fails.
    const { commandReadsSensitiveFile } = await import('../proc.js');
    expect(commandReadsSensitiveFile('sudo cat ~/.dojo/secrets.yaml').blocked).toBe(true);
    expect(commandReadsSensitiveFile('sudo -u root cat ~/.dojo/secrets.yaml').blocked).toBe(true);
  });

  it('an interactive ROOT SHELL is refused under every policy — there is nothing to authorize', () => {
    for (const line of ['sudo', 'sudo -i', 'sudo -s', 'sudo --login', 'sudo -u root -i']) {
      underEach((p) => expect(allowed(line), `${p}: ${line}`).toBe(false));
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §3 — GRANTS STILL RULE. The policy is box-wide; it never widens an agent.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§3 sudo answers to the agent\'s own exec grants, as ever', () => {
  it('a DENY-ALL agent cannot sudo anything, even on free', () => {
    underEach((p) => {
      expect(allowed('sudo ls', denyAll), `policy=${p}`).toBe(false);
      expect(allowed('sudo cp a b', denyAll), `policy=${p}`).toBe(false);
    });
  });

  it('an agent granted ONLY `cp` can sudo cp and cannot sudo rm', () => {
    const cpOnly = ({ ...base, exec_allow: ['cp *'] } as unknown) as PermissionManifest;
    policyRow.current = 'free';
    expect(allowed('sudo cp a b', cpOnly)).toBe(true);
    expect(allowed('sudo rm a', cpOnly), 'rm is not granted; sudo does not grant it').toBe(false);
  });

  it('the refusal for an ungranted inner command is the GRANT\'s refusal, not the policy\'s', () => {
    // The inner re-run decides first, so the message names the real problem.
    policyRow.current = 'free';
    const v = verdict('sudo ls', denyAll);
    expect(v.allowed).toBe(false);
    expect(v.allowed === false && v.reason).toMatch(/not allowed|permitted commands/i);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §4 — THE PARSER'S OWN FIXTURE TABLE: what the inner command IS.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§4 parseSudo', () => {
  it('a fixture table of inner commands, caught and ignored', () => {
    const rows: Array<[string, string]> = [
      ['sudo ls -la', 'ls -la'],
      ['sudo -n ls', 'ls'],
      ['sudo -u root ls', 'ls'],
      ['sudo --user root ls', 'ls'],
      ['sudo --user=root ls', 'ls'],
      ['sudo -E -H ls', 'ls'],
      ['sudo -- ls -la', 'ls -la'],
      ['sudo sudo ls', 'ls'],
      ['/usr/bin/sudo ls', 'ls'],
      ['sudo -i ls', 'ls'],
    ];
    for (const [line, inner] of rows) {
      expect(parseSudo(line).inner, line).toBe(inner);
    }
  });

  it('A QUOTED OPTION VALUE IS FLAGGED, not silently mis-parsed', () => {
    // The gap my own §2 table found: `-p "pw: "` spans tokens, so the whitespace split hands back a
    // garbage inner command that matches no floor pattern. The parser now SAYS it could not read the
    // line, and `authorizeSudoLine` refuses on that flag.
    expect(parseSudo('sudo -p "pw: " rm -rf /').quotedOptionValue).toBe(true);
    expect(parseSudo('sudo -u root rm -rf /').quotedOptionValue).toBe(false);
    expect(parseSudo('sudo rm -rf /').quotedOptionValue).toBe(false);
  });

  it('`--` ENDS sudo\'s options, so a command that itself starts with `-` is the command', () => {
    // MUTATION GAP: turning `--`'s `break` into a `continue` is INVISIBLE on ordinary lines, because
    // the very next token does not start with `-` and the loop breaks anyway. The case `--` exists for
    // is a command whose own name or first word starts with a dash, and only that tells the two apart.
    expect(parseSudo('sudo -- -weird-tool x').inner).toBe('-weird-tool x');
    expect(parseSudo('sudo -- --help').inner).toBe('--help');
    // and without `--` those leading dashes are read as sudo's own flags, which is correct
    expect(parseSudo('sudo --help').interactiveShell).toBe(true);
  });

  it('the interactive-shell shapes, and the `-n` flag it records', () => {
    for (const line of ['sudo', 'sudo -i', 'sudo -s', 'sudo --shell', 'sudo -u root']) {
      expect(parseSudo(line).interactiveShell, line).toBe(true);
    }
    expect(parseSudo('sudo -n ls').nonInteractive).toBe(true);
    expect(parseSudo('sudo ls').nonInteractive).toBe(false);
  });

  it('`isSudoLine` is basename-aware and does not fire on lookalikes', () => {
    for (const yes of ['sudo ls', '/usr/bin/sudo ls', 'sudo']) expect(isSudoLine(yes), yes).toBe(true);
    for (const no of ['sudoku ls', 'pseudo ls', 'ls sudo', 'echo sudo', '']) {
      expect(isSudoLine(no), no).toBe(false);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §5 — THE HONEST FAILURE. A password prompt is answered, not waited on.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§5 the password-prompt message', () => {
  it('names the ONE command a human runs once, and the escape hatch', () => {
    const msg = sudoPasswordPromptMessage('dojo', 'gated');
    expect(msg).toContain('wants a password');
    expect(msg).toContain('a HUMAN runs this ONCE');
    expect(msg).toContain('/etc/sudoers.d/dojo');
    expect(msg).toContain(sudoersDropInLine('dojo'));
    expect(msg).toContain('chmod 0440');
    // the escape hatch, so the reader is not cornered into granting root
    expect(msg).toContain('`blocked`');
    // and it is honest about what it is: not a permission denial
    expect(msg).toContain('box-setup gap');
  });

  it('it carries the CURRENT policy, so the reader knows the command was allowed', () => {
    expect(sudoPasswordPromptMessage('dojo', 'free')).toContain('sudo policy is `free`');
    expect(sudoPasswordPromptMessage('dojo', 'gated')).toContain('sudo policy is `gated`');
  });

  it('NOTHING WRITES SUDOERS — the drop-in is a string the human runs', async () => {
    // v1 refuses to write its own sudoers, on instruction and on merit. Held structurally: no module
    // in the sudo family may reference the sudoers directory as a write target.
    const fs = await import('node:fs');
    const path = await import('node:path');
    const url = await import('node:url');
    const dir = path.dirname(url.fileURLToPath(import.meta.url));
    for (const f of ['sudo-policy.ts', 'sudo-probe.ts']) {
      const src = fs.readFileSync(path.join(dir, '..', f), 'utf8');
      expect(src, f).not.toMatch(/writeFile|appendFile|createWriteStream/);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §6 — THE GATED FLOW GOES THROUGH THE REAL APPROVAL MACHINERY.
//
// `gated` is not a refusal and it is not a new consent mechanism: the sudo line is classified
// DESTRUCTIVE, and from there the existing card, `approve_destructive_action`, the one-shot
// signature-bound approval and the 60-minute expiry all apply unchanged. These clauses hold the
// classification — the one seam this feature adds to that machinery — because the machinery behind it
// is already covered by its own suites and must not be re-proved here.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§6 `gated` holds the PRIMARY, and the hold goes to the OWNER', () => {
  it('gated REQUIRES A HOLD for a primary sudo line; blocked and free do not', () => {
    const call = { script: 'sudo cp bin/imsg /opt/homebrew/bin/' };
    policyRow.current = 'gated';
    expect(isSudoHoldRequired('shell', call), 'gated must hold, or the mode is empty').toBe(true);
    // `blocked` is refused at the floor, where a refusal belongs — holding it too would file an
    // approval for a call the broker refuses on retry, the unsatisfiable-approval dead-end.
    policyRow.current = 'blocked';
    expect(isSudoHoldRequired('shell', call)).toBe(false);
    // `free` is the owner saying he does not want to be asked.
    policyRow.current = 'free';
    expect(isSudoHoldRequired('shell', call)).toBe(false);
  });

  it('AN UNREADABLE POLICY HOLDS RATHER THAN RUNS', () => {
    // MUTATION GAP (MS16): the catch's direction was untested, because nothing in the file made the
    // config read throw. A failed read must never be the reason an administrator command executed
    // unasked — and the ordinary case is unaffected, because the string parse answers first.
    policyRow.current = '__throw__';
    expect(isSudoHoldRequired('shell', { script: 'sudo cp a b' }), 'sudo + unreadable ⇒ hold').toBe(true);
    expect(isSudoHoldRequired('shell', { script: 'ls -la' }), 'a non-sudo line never reads the policy').toBe(false);
  });

  it('it holds at BOTH doors and does not fire on an ordinary line', () => {
    policyRow.current = 'gated';
    expect(isSudoHoldRequired('shell', { script: 'sudo ls' })).toBe(true);
    expect(isSudoHoldRequired('exec', { argv: ['sudo', 'ls'] })).toBe(true);
    expect(isSudoHoldRequired('exec', { command: 'sudo ls' })).toBe(true);
    expect(isSudoHoldRequired('shell', { script: 'ls -la' })).toBe(false);
    expect(isSudoHoldRequired('exec', { argv: ['ls'] })).toBe(false);
    expect(isSudoHoldRequired('shell', {})).toBe(false);
  });

  it('THE HOLD IS FILED FOR THE PRIMARY, at the dispatch step, to the OWNER\'s card', () => {
    // Structural, because the filing needs a turn. Three facts: the branch runs FOR the primary (the
    // old gate skips it), it routes through the owner-approval proposal rather than `requestApproval`
    // (which wakes the PRIMARY — asking a caller to approve its own call), and it carries sudo's own
    // copy so the owner is not told his main agent is a self-healing helper.
    const site = engineFileContaining('isSudoHoldRequired')!.text;
    expect(site).toMatch(/isPrimaryAgent\(agentId\)\s*&&\s*isSudoHoldRequired/);
    expect(site).toContain('fileHealerApprovalProposal');
    expect(site).toContain('sudoOwnerCardCopy');
    // and it consumes a granted approval on the retry, so one approval means one run
    expect(site).toMatch(/consumeApproval\(agentId, sig/);
  });

  it('the owner card says what it is, promises nothing has run, and does not nudge', () => {
    const c = sudoOwnerCardCopy('sudo cp bin/imsg /opt/homebrew/bin/');
    expect(c.title).toContain('administrator command');
    expect(c.description).toContain('Nothing has run yet');
    expect(c.description).toContain('Declining changes nothing');
    expect(c.proposedFix).toContain('sudo cp bin/imsg');
    // it must NOT recommend approval — an admin command on his own Mac is his call
    expect(c.description.toLowerCase()).not.toContain('my suggestion');
    expect(c.description.toLowerCase()).not.toContain('we recommend');
    // and it tells him the floor still holds whatever he clicks
    expect(c.evidence.join(' ')).toContain('hard limits still apply');
  });

  it('THE JUNE DOCTRINE IS ANNOTATED where it is carved out, with the owner\'s sentence', () => {
    const site = engineFileContaining('isSudoHoldRequired')!.text;
    expect(site).toContain('ONLY the main agent gets Sudo access ever');
    expect(site).toMatch(/full reign — EXCEPT FOR SUDO/);
  });

  it('a genuinely destructive NON-sudo line is classified exactly as before', async () => {
    const { isDestructiveCall } = await import('../../destructive-gate.js');
    underEach((p) => {
      expect(isDestructiveCall('shell', { script: 'rm -rf /tmp/x' }), `policy=${p}`).not.toBeNull();
    });
  });

  it('and the gate no longer classifies sudo itself — that arm became dead code', async () => {
    // The first cut put a `gated` arm in `isDestructiveCall`. The ruling made it unreachable (no
    // sub-agent can sudo; the primary is held directly), and dead classification invites a debugging
    // session about why it never fires.
    const { isDestructiveCall } = await import('../../destructive-gate.js');
    policyRow.current = 'gated';
    expect(isDestructiveCall('shell', { script: 'sudo ls' })).toBeNull();
    const gate = engineFileContaining('DESTRUCTIVE_EXEC_RE')?.text
      ?? (await import('node:fs')).readFileSync(
        (await import('node:path')).join(SRCDIR, 'agent', 'destructive-gate.ts'), 'utf8');
    expect(gate).toContain('SUDO IS DELIBERATELY NOT CLASSIFIED HERE');
  });
});
