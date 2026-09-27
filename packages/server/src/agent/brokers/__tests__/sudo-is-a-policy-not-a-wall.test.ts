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

/** The policy the broker will read. Set per clause; the accessor is mocked at the config seam so
 *  these clauses need no database. */
const policyRow: { current: string | null } = { current: null };

vi.mock('../../../config/platform.js', async (orig) => ({
  ...(await orig<typeof import('../../../config/platform.js')>()),
  getSudoPolicyRaw: () => policyRow.current,
}));

import { grantForManifest } from '../grants.js';
import { authorizeShellCommandText } from '../proc.js';
import {
  SUDO_BLOCKED_REASON, SUDO_POLICY_DEFAULT, getSudoPolicy, isSudoLine, parseSudo,
  sudoPasswordPromptMessage, sudoersDropInLine, type SudoPolicy,
} from '../sudo-policy.js';
import type { PermissionManifest } from '@dojo/shared';

const base = {
  file_read: '*', file_write: '*', file_delete: 'none', exec_deny: [],
  network_domains: 'none', max_processes: 1,
  can_spawn_agents: false, can_assign_permissions: false,
} as const;

/** An agent allowed to run anything its grants permit. */
const wideOpen = ({ ...base, exec_allow: ['*'] } as unknown) as PermissionManifest;
/** An agent allowed exactly nothing — the grants half of the matrix. */
const denyAll = ({ ...base, exec_allow: [] } as unknown) as PermissionManifest;

const verdict = (command: string, manifest: PermissionManifest = wideOpen) =>
  authorizeShellCommandText(grantForManifest('a', manifest), command);
const allowed = (command: string, manifest: PermissionManifest = wideOpen): boolean =>
  verdict(command, manifest).allowed;

const ALL_POLICIES: readonly SudoPolicy[] = ['blocked', 'gated', 'free'];
const underEach = (fn: (p: SudoPolicy) => void): void => {
  for (const p of ALL_POLICIES) { policyRow.current = p; fn(p); }
};

beforeEach(() => { policyRow.current = null; });

// ════════════════════════════════════════════════════════════════════════════════════════
// §1 — THE POLICY MATRIX.
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
