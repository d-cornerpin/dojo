// ════════════════════════════════════════════════════════════════════════════════════════
// SUDO CANNOT BE SPELLED AROUND — the v3.2.2 security review's corpus, through the REAL door.
//
// ── S4 IS WHY THIS FILE EXISTS, AND IT IS THE LESSON OF THE ROUND ────────────────────────────
// All 478 lines of `sudo-is-a-policy-not-a-wall.test.ts` drive `authorizeShellCommandText`, a HELPER
// that calls `authorizeOneCommand` on the raw text and performs NO grammar unpack. The `parts` loop in
// `authorizeProc` — where the whole defect lived — was never once exercised. The suite was green, the
// feature was bypassed by `true; `, and no clause could have noticed. So every clause below goes
// through `authorizeShellScript` and `authorizeArgv` with a real `ResolvedCommand`/`ResolvedArgv`,
// built the way `resolve.ts` builds them, and the old file keeps its unit-level job.
//
// ── THE MEASUREMENT THAT OPENED THE ROUND (mine, reproducing the review before changing anything) ──
// Non-primary agent, `sudo_policy = blocked`, through `authorizeShellScript`:
//   sudo rm -rf /                   denied     ← the control
//   true; sudo rm -rf /             ALLOWED
//   true && sudo rm -rf /           ALLOWED
//   ls | sudo tee /etc/sudoers.d/x  ALLOWED
//   (sudo rm -rf /)                 ALLOWED
//   $(sudo whoami)                  ALLOWED
//   SUDO / Sudo / env sudo / env X=1 sudo / command sudo / \sudo / "sudo"   ALLOWED
// Thirteen of fourteen escaped WITH PRIVILEGE. §1 is that table, every row now a caught row.
//
// ── THE SHAPE OF THE FIX, SO A READER KNOWS WHAT EACH SECTION PINS ───────────────────────────
//   §1 the evasion corpus × 3 policies × primary/sub-agent — the whole review table
//   §2 the harmless-data exemption: what fail-closed must NOT refuse
//   §3 the `gated` hold, segmented (a hold that only sees head position executes unasked)
//   §4 no capability lost — the grant question is unchanged
//   §5 the argv door, which shares the authority
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, vi } from 'vitest';

const policyRow: { current: string | null } = { current: null };
const PRIMARY = 'primary-agent';
const WORKER = 'some-worker';

vi.mock('../../../config/platform.js', async (orig) => ({
  ...(await orig<typeof import('../../../config/platform.js')>()),
  getSudoPolicyRaw: () => policyRow.current,
  isPrimaryAgent: (id: string) => id === PRIMARY,
}));

import { grantForManifest } from '../grants.js';
import { authorizeArgv, authorizeShellScript } from '../proc.js';
import { resolveArgvArg, resolveCommandArg } from '../resolve.js';
import { SUDO_NOT_PRIMARY_REASON, SUDO_UNPLACEABLE_REASON, isSudoHoldRequired } from '../sudo-policy.js';
import type { PermissionManifest } from '@dojo/shared';

const base = {
  file_read: '*', file_write: '*', file_delete: 'none', exec_deny: [],
  network_domains: 'none', max_processes: 1,
  can_spawn_agents: false, can_assign_permissions: false,
} as const;
const wideOpen = ({ ...base, exec_allow: ['*'] } as unknown) as PermissionManifest;
const scoped = ({ ...base, exec_allow: ['ls', 'cat', 'echo', 'git *', 'node'] } as unknown) as PermissionManifest;

/** ⚠ THE REAL DOOR. `resolveCommandArg` is what the shell tool's dispatch uses. */
function shell(script: string, agentId = PRIMARY, manifest: PermissionManifest = wideOpen) {
  const r = resolveCommandArg(script);
  if (!r.ok) throw new Error(`fixture did not resolve: ${script}`);
  return authorizeShellScript(grantForManifest(agentId, manifest), r.value);
}
const shellAllows = (script: string, agentId = PRIMARY, m: PermissionManifest = wideOpen): boolean =>
  shell(script, agentId, m).allowed;

const POLICIES = ['blocked', 'gated', 'free'] as const;
const underEach = (fn: (p: string) => void): void => {
  for (const p of POLICIES) { policyRow.current = p; fn(p); }
};

beforeEach(() => { policyRow.current = null; });

// ════════════════════════════════════════════════════════════════════════════════════════
// §1 — THE EVASION CORPUS. Every row of the review's table, both agents, all three policies.
// ════════════════════════════════════════════════════════════════════════════════════════

/** Every spelling the reviewer measured as escaping WITH privilege, plus the ones already caught. */
const EVASIONS: readonly string[] = [
  // the control
  'sudo rm -rf /',
  // S1 — separators the old grammar never unpacked
  'true; sudo rm -rf /',
  'true && sudo rm -rf /',
  'true || sudo whoami',
  'ls | sudo tee /etc/sudoers.d/x',
  '(sudo rm -rf /)',
  '$(sudo whoami)',
  '`sudo whoami`',
  'echo x; sudo whoami',
  'git clone x && cd x && make && sudo cp bin/imsg /opt/homebrew/bin/',
  // S3 — case, wrappers, quoting, escapes
  'SUDO rm -rf /',
  'Sudo rm -rf /',
  'env sudo whoami',
  'env X=1 sudo whoami',
  'command sudo whoami',
  '\\sudo whoami',
  '"sudo" whoami',
  'doas whoami',
  // S2 — the long-form prompt that blinded the floor
  'sudo --prompt="pw: " rm -rf /',
  // already caught before this round, kept so a regression is visible
  '/usr/bin/sudo whoami',
  'sudo sudo rm -rf /',
  'sudo -u root rm -rf /',
  'for i in 1; do sudo rm -rf /; done',
  'sh -c "sudo whoami"',
];

describe('§1 the evasion corpus, through the real shell door', () => {
  it('a SUB-AGENT is refused every spelling, under every policy', () => {
    underEach((p) => {
      for (const line of EVASIONS) {
        expect(shellAllows(line, WORKER), `${p}: ${line}`).toBe(false);
      }
    });
  });

  it('the PRIMARY is refused every spelling under `blocked`', () => {
    policyRow.current = 'blocked';
    for (const line of EVASIONS) {
      expect(shellAllows(line, PRIMARY), line).toBe(false);
    }
  });

  it('⚠ THE FLOOR BITES INSIDE EVERY SPELLING, EVEN UNDER `free` FOR THE PRIMARY', () => {
    // This is the claim `sudo-policy.ts` calls "the whole security argument", and before this round it
    // was false for every separator: `true; sudo rm -rf /` ran.
    policyRow.current = 'free';
    for (const line of [
      'sudo rm -rf /', 'true; sudo rm -rf /', 'true && sudo rm -rf /', '(sudo rm -rf /)',
      'ls | sudo rm -rf /', 'SUDO rm -rf /', 'env sudo rm -rf /', '\\sudo rm -rf /',
      'sudo --prompt="pw: " rm -rf /', 'sudo -u root rm -rf ~', 'echo a; sudo chmod 777 /etc',
    ]) {
      expect(shellAllows(line, PRIMARY), line).toBe(false);
    }
  });

  it('⚠ THE PERSISTENCE PRIMITIVE the feature forbids is no longer silent', () => {
    // `ls | sudo tee /etc/sudoers.d/x` let the agent write its own NOPASSWD drop-in — the one act
    // `sudo-policy.ts` says must never be automated — with NO refusal and NO card. What the fix
    // guarantees is that it is now SEEN, and what happens next is the policy's business:
    const line = 'echo "x ALL=(ALL) NOPASSWD: ALL" | sudo tee /etc/sudoers.d/dojo';
    // a sub-agent: refused under every policy, full stop
    underEach((p) => expect(shellAllows(line, WORKER), `${p}/worker`).toBe(false));
    // the primary: refused under `blocked`…
    policyRow.current = 'blocked';
    expect(shellAllows(line, PRIMARY)).toBe(false);
    // …HELD under `gated`, which is the owner deciding rather than the agent proceeding…
    policyRow.current = 'gated';
    expect(isSudoHoldRequired('shell', { script: line }), 'it must reach the owner\'s card').toBe(true);
    // …and allowed under `free`, because that is precisely what `free` means. The owner who sets it is
    // told so on the dropdown; the point of the fix is that the other two modes are no longer bypassed.
    policyRow.current = 'free';
    expect(shellAllows(line, PRIMARY)).toBe(true);
  });

  it('a NARROW GRANT does not become a way in', () => {
    // The review: `exec_allow: ['echo']` still reached root, because the whole-line grant check only
    // ever saw the head program.
    underEach((p) => {
      expect(shellAllows('echo x; sudo whoami', WORKER, scoped), `${p}`).toBe(false);
      expect(shellAllows('echo x; sudo whoami', PRIMARY, scoped), `${p}`).toBe(false);
    });
  });

  it('the refusal NAMES which wall bit, so an operator can tell a role wall from an unreadable line', () => {
    policyRow.current = 'free';
    // placed and privileged, wrong role ⇒ the role wall
    const role = shell('true; sudo whoami', WORKER);
    expect(role.allowed).toBe(false);
    expect(role.allowed === false && role.reason).toBe(SUDO_NOT_PRIMARY_REASON);
    // present but unplaceable ⇒ the fail-closed refusal, even for the primary under `free`
    const unplaced = shell('$(sudo whoami)', PRIMARY);
    expect(unplaced.allowed).toBe(false);
    expect(unplaced.allowed === false && unplaced.reason).toBe(SUDO_UNPLACEABLE_REASON);
    expect(SUDO_UNPLACEABLE_REASON).toContain('cannot place');
    expect(SUDO_UNPLACEABLE_REASON).toContain('is not run as root');
  });

  it('`doas` is treated as the same privilege escalation', () => {
    // Not installed on stock macOS today. A floor that waits for it to be installed is wrong once.
    underEach(() => expect(shellAllows('doas rm -rf /', PRIMARY)).toBe(false));
    policyRow.current = 'blocked';
    expect(shellAllows('true; doas whoami', PRIMARY)).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §2 — WHAT FAIL-CLOSED MUST NOT REFUSE. The harmless-data exemption, and it is narrow.
//
// A floor that refuses `echo "sudo cp …"` would make the product unable to quote its OWN setup
// instructions — `IMSG_INSTALL_HINT` is exactly that sentence. These are the rows a careless
// "contains sudo ⇒ refuse" would have broken, and each is an ordinary line.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§2 the harmless spellings still run', () => {
  it('the platform quoting its OWN sudo instructions is data, not a command', () => {
    policyRow.current = 'blocked';
    for (const line of [
      'echo "sudo cp bin/imsg /opt/homebrew/bin/"',
      "echo 'run sudo apt-get install -y ffmpeg'",
      'echo sudo',
      'printf "%s\\n" "sudo cp x y"',
    ]) {
      expect(shellAllows(line, WORKER), line).toBe(true);
    }
  });

  it('a word that merely CONTAINS the letters is not the token', () => {
    policyRow.current = 'blocked';
    for (const line of ['sudoku --help', 'echo pseudo', 'cat sudo_policy.md', 'ls pseudocode/']) {
      expect(shellAllows(line, WORKER), line).toBe(true);
    }
  });

  it('but an INTERPRETER makes a quoted span code, so it is refused', () => {
    // The one place quoting does not mean data.
    underEach((p) => {
      for (const line of ['sh -c "sudo whoami"', 'bash -c \'sudo whoami\'', 'zsh -c "sudo rm -rf /"']) {
        expect(shellAllows(line, PRIMARY), `${p}: ${line}`).toBe(false);
      }
    });
  });

  it('ordinary multi-command work is untouched', () => {
    policyRow.current = 'gated';
    for (const line of [
      'ls -la | grep notes', 'cd /tmp && ls', 'echo a; echo b',
      'for i in 1 2 3; do echo $i; done', 'git status && git diff --stat',
    ]) {
      expect(shellAllows(line, PRIMARY), line).toBe(true);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §3 — THE `gated` HOLD IS SEGMENTED, or `gated` executes unasked.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§3 the hold sees sudo wherever it is', () => {
  it('every mid-line spelling HOLDS under `gated`', () => {
    policyRow.current = 'gated';
    for (const script of [
      'sudo whoami', 'true; sudo whoami', 'true && sudo whoami', 'ls | sudo tee /etc/x',
      '(sudo whoami)', '$(sudo whoami)', 'env sudo whoami', 'env X=1 sudo whoami',
      'command sudo whoami', 'SUDO whoami', '\\sudo whoami', 'doas whoami',
    ]) {
      expect(isSudoHoldRequired('shell', { script }), script).toBe(true);
    }
  });

  it('and does NOT hold on data or on ordinary lines', () => {
    policyRow.current = 'gated';
    for (const script of ['echo "sudo cp x y"', 'echo sudo', 'ls -la', 'sudoku', 'ls | grep notes']) {
      expect(isSudoHoldRequired('shell', { script }), script).toBe(false);
    }
  });

  it('`blocked` and `free` still do not hold', () => {
    for (const p of ['blocked', 'free']) {
      policyRow.current = p;
      expect(isSudoHoldRequired('shell', { script: 'true; sudo whoami' }), p).toBe(false);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §4 — NO CAPABILITY LOST. The grant question is exactly what it was.
//
// The first cut of this fix deleted the grammar's construct gate outright, which made every segment
// the GRANT question too — and an agent granted `['ls','cat','echo','git *','node']` lost `ls | grep`.
// Taking a capability away is the owner's decision (RULING P5-R5), not a fix round's.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§4 the allowlist behaves as it did', () => {
  it('a scoped agent still pipes into a program its manifest never lists', () => {
    policyRow.current = 'gated';
    expect(shellAllows('ls -la | grep notes', PRIMARY, scoped)).toBe(true);
    expect(shellAllows('cat a.txt | wc -l', PRIMARY, scoped)).toBe(true);
  });

  it('⚠ AND THE FLOOR NOW BITES INSIDE THOSE SAME LINES, which it did not before', () => {
    // Measured while writing this file: `ls | rm -rf /` was ALLOWED for a scoped agent, because the
    // floor read the head program of the whole line. The review saw the sudo-flavoured version
    // (`sudo;rm -rf /` — "an unchecked `rm -rf /`") and called it a pre-existing property; the plain
    // pipe is the same hole without sudo in it. Safe to close in this round: nobody loses a capability
    // when `rm -rf /` is refused.
    policyRow.current = 'gated';
    for (const line of [
      'ls | rm -rf /', 'echo a; rm -rf ~', 'true && chmod 777 /etc', '(rm -rf /)',
      'sudo;rm -rf /', 'cat x | cat ~/.dojo/secrets.yaml',
    ]) {
      expect(shellAllows(line, PRIMARY, scoped), line).toBe(false);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §5 — THE ARGV DOOR shares the authority, so it shares the corpus.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§5 the argv door', () => {
  const argv = (parts: string[], agentId = PRIMARY) => {
    const r = resolveArgvArg(parts);
    if (!r.ok) throw new Error('fixture did not resolve');
    return authorizeArgv(grantForManifest(agentId, wideOpen), r.value).allowed;
  };

  it('a sub-agent cannot sudo through argv either', () => {
    underEach((p) => {
      expect(argv(['sudo', 'whoami'], WORKER), p).toBe(false);
      expect(argv(['env', 'sudo', 'whoami'], WORKER), p).toBe(false);
      expect(argv(['SUDO', 'whoami'], WORKER), p).toBe(false);
    });
  });

  it('the floor bites inside argv sudo for the primary under `free`', () => {
    policyRow.current = 'free';
    expect(argv(['sudo', 'rm', '-rf', '/'], PRIMARY)).toBe(false);
    expect(argv(['ls', '-la'], PRIMARY)).toBe(true);
  });
});
