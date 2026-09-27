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
import { authorizeAppleScript } from '../applescript.js';
import { resolveArgvArg, resolveCommandArg } from '../resolve.js';
import {
  PRIVILEGE_PROGRAMS, SUDO_NOT_PRIMARY_REASON, SUDO_UNPLACEABLE_REASON, isSudoHoldRequired,
  mentionsPrivilegeToken, osascriptBodyIsUnseeable,
} from '../sudo-policy.js';
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
  // ── RE-REVIEW RC1: the fallthrough that excused a substitution as prose. EVERY ROW HERE WAS
  //    ALLOWED at `b5865c9b`, and `echo $(sudo rm -rf /)` was allowed to a SUB-AGENT under `blocked`.
  'echo $(sudo rm -rf /)',
  'echo $(sudo whoami)',
  'echo "$(sudo whoami)"',
  'x=$(sudo whoami)',
  'printf "%s" $(sudo whoami)',
  // ── RC1's proof that the DEFAULT is right rather than the LIST being long: three wrappers the
  //    reviewer invented, none of them in `EXEC_WRAPPERS`, all dying by the inversion alone.
  'flock /tmp/l sudo whoami',
  'script -q /dev/null sudo whoami',
  'unbuffer sudo whoami',
  // ── one MORE of my own invention, never listed anywhere, to prove the same thing again
  'chrt -f 99 sudo whoami',
  // ── the token in a CONSTRUCT HEADER, which the segmenter drops: no segment word carries it, so the
  //    only thing refusing these is the inversion's empty-conjunction guard.
  'for x in $(sudo whoami); do echo $x; done',
  'case $(sudo whoami) in root) echo yes;; esac',
  'while $(sudo true); do echo x; done',
  // ── RC2: the two resolvers disagreed, so the floor matched nothing
  'env X=1 sudo rm -rf /',
  'env FOO=bar BAZ=1 sudo rm -rf ~',
  // ── RC3: a wrapper's OWN arguments ended the walk
  'timeout 5 sudo rm -rf /',
  'nice -n 10 sudo whoami',
  'stdbuf -o0 sudo whoami',
  'xargs -I{} sudo whoami',
  // ── OWNER RULING "one policy": the osascript admin door, exec'd
  `osascript -e 'do shell script "whoami" with administrator privileges'`,
  `osascript -e 'do shell script "rm -rf /" with administrator privileges'`,
  // case and whitespace, which AppleScript tolerates and so must the detector
  `osascript -e 'do shell script "id" With Administrator Privileges'`,
  `osascript -e 'do shell script "id" with admin privileges'`,
  // ── OR-SUDO-2, final micro-round: `su` is an admin door and it SHIPS on macOS
  'su -c "whoami" root',
  'su root -c whoami',
  'su - root -c whoami',
  'true; su -c "rm -rf /" root',
  'echo $(su -c whoami root)',
  '/usr/bin/su -c whoami root',
  'SU -c whoami root',
  // ── OR-SUDO-2's doctrine on an UNSEEABLE body: an admin-capable interpreter invoked on content the
  //    broker cannot read is NOT proven inert, so the policy governs it.
  'osascript /tmp/x.scpt',
  'osascript -l JavaScript /tmp/x.js',
  'osascript -',
  'osascript /dev/stdin',
  'osascript',
  'cat /tmp/x.scpt | osascript',
  'osascript < /tmp/x.scpt',
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
      // RC2 — the two resolvers disagreed here, and the floor matched nothing: ALLOWED under `free`
      'env X=1 sudo rm -rf /', 'env FOO=bar BAZ=1 sudo rm -rf ~',
      // RC3 — a wrapper's own argument ended the walk
      'timeout 5 sudo rm -rf /', 'nice -n 10 sudo rm -rf /', 'stdbuf -o0 sudo rm -rf ~',
      'xargs -I{} sudo rm -rf /',
      // RC1 — the fallthrough excused these as prose
      'echo $(sudo rm -rf /)', 'echo "$(sudo rm -rf /)"', 'flock /tmp/l sudo rm -rf /',
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

  it('an UNPLACEABLE `doas` needs the DETECTOR, not the walker', () => {
    // MUTATION GAP: dropping `doas` from the sound detector left every clause green, because the
    // precise walker names it too — so the mutant was only half applied. The shape that needs the
    // DETECTOR is the one the walker cannot see: a privilege token inside a substitution.
    underEach((p) => {
      expect(shellAllows('$(doas whoami)', PRIMARY), `${p}`).toBe(false);
      expect(shellAllows('`doas rm -rf /`', PRIMARY), `${p}`).toBe(false);
    });
  });

  it('A WRAPPED sudo ROUTES THROUGH THE POLICY, it is not merely refused', () => {
    // MUTATION GAP (MI4/MI5): un-sharing the resolver or dropping the wrapper's own-argument scan left
    // every clause green, because the inversion refuses these lines ANYWAY — as unplaceable. Refusing
    // for the wrong reason is not the same as recognising: the whole point of the walk is that a wrapped
    // sudo is a SUDO LINE, so the policy and the role wall govern it like any other.
    policyRow.current = 'free';
    for (const line of [
      'timeout 5 sudo whoami', 'nice -n 10 sudo whoami', 'stdbuf -o0 sudo whoami',
      'xargs -I{} sudo whoami', 'env X=1 sudo whoami', 'env FOO=bar BAZ=1 sudo whoami',
    ]) {
      expect(shellAllows(line, PRIMARY), `free/primary: ${line}`).toBe(true);
      // …and the SAME line is role-walled for a sub-agent, which only happens if it was RECOGNISED
      const v = shell(line, WORKER);
      expect(v.allowed === false && v.reason, `worker: ${line}`).toBe(SUDO_NOT_PRIMARY_REASON);
    }
    // under `gated` each one reaches the owner's card rather than executing
    policyRow.current = 'gated';
    for (const script of ['timeout 5 sudo whoami', 'env X=1 sudo whoami', 'nice -n 10 sudo whoami']) {
      expect(isSudoHoldRequired('shell', { script }), script).toBe(true);
    }
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

  it('PROSE ABOUT admin privileges is prose — the construct is not a magic word', () => {
    // The first cut short-circuited on the phrase anywhere in the line, which refused this. The
    // occurrence machinery gets it right for the same reason `echo sudo` is allowed: an inert program,
    // an argument position, no executing context. `osascript` is still caught, by the program check.
    policyRow.current = 'blocked';
    for (const line of [
      'echo "with administrator privileges"',
      'grep -r "with administrator privileges" docs/',
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

// ════════════════════════════════════════════════════════════════════════════════════════
// §6 — THE SECOND ADMIN DOOR. Owner ruling 2026-09-27, verbatim: "one policy".
//
// `do shell script "…" with administrator privileges` is macOS root through Apple's own prompt, with no
// `sudo` token anywhere. The re-review found it open to any agent holding applescript — which made the
// role wall's stated purpose ("only the main agent gets administrator rights") untrue by a different
// spelling. Both doors answer to the same policy, the same wall and the same card now.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§6 the AppleScript admin-privileges door', () => {
  const script = (body: string, agentId = PRIMARY) => {
    const r = resolveCommandArg(body);
    if (!r.ok) throw new Error('fixture did not resolve');
    const manifest = ({ ...base, exec_allow: ['*'], system_control: ['*', 'applescript'] } as unknown) as PermissionManifest;
    return authorizeAppleScript(grantForManifest(agentId, manifest), r.value);
  };
  const scriptAllows = (body: string, agentId = PRIMARY): boolean => script(body, agentId).allowed;

  /** Spellings AppleScript accepts. The LAST one is invented and listed nowhere in the product. */
  const ADMIN_SPELLINGS: readonly string[] = [
    'do shell script "whoami" with administrator privileges',
    'do shell script "whoami" WITH ADMINISTRATOR PRIVILEGES',
    'do shell script "whoami" With Administrator Privileges',
    'do shell script "whoami" with admin privileges',
    'do shell script "whoami" with   administrator   privileges',
    'tell application "Finder"\n  do shell script "whoami" with administrator privileges\nend tell',
    'do shell script "whoami" ¬\n  with administrator privileges',
    // ⚠ INVENTED FOR THIS CLAUSE and deliberately absent from every list in the product — it must die
    // by the INVERTED DEFAULT, not by enumeration. That is the test that the default is right.
    'tell app "System Events" to do shell script "id" with Admin Privileges',
  ];

  it('a SUB-AGENT is refused every spelling, under every policy, in the SAME voice as sudo', () => {
    underEach((p) => {
      for (const body of ADMIN_SPELLINGS) {
        const v = script(body, WORKER);
        expect(v.allowed, `${p}: ${body.slice(0, 48)}`).toBe(false);
        expect(v.allowed === false && v.reason, 'the role wall speaks once, for both doors')
          .toBe(SUDO_NOT_PRIMARY_REASON);
      }
    });
  });

  it('the PRIMARY answers to the POLICY, exactly as for sudo', () => {
    policyRow.current = 'blocked';
    for (const body of ADMIN_SPELLINGS) expect(scriptAllows(body, PRIMARY), body.slice(0, 40)).toBe(false);
    policyRow.current = 'free';
    for (const body of ADMIN_SPELLINGS) expect(scriptAllows(body, PRIMARY), body.slice(0, 40)).toBe(true);
    // `gated` allows at the broker and HOLDS upstream — the same layering as the sudo path
    policyRow.current = 'gated';
    expect(scriptAllows(ADMIN_SPELLINGS[0], PRIMARY)).toBe(true);
    expect(isSudoHoldRequired('shell', { script: ADMIN_SPELLINGS[0] })).toBe(true);
  });

  it('ORDINARY AppleScript is untouched — the construct is the privilege, not the binary', () => {
    underEach((p) => {
      for (const body of [
        'display dialog "hello"',
        'do shell script "ls -la"',
        'tell application "Music" to play',
        'do shell script "echo administrator privileges are not requested here"',
      ]) {
        expect(scriptAllows(body, WORKER), `${p}: ${body}`).toBe(true);
      }
    });
  });

  it('and the exec\'d `osascript` form answers the same way', () => {
    const line = `osascript -e 'do shell script "whoami" with administrator privileges'`;
    underEach(() => expect(shellAllows(line, WORKER)).toBe(false));
    policyRow.current = 'blocked';
    expect(shellAllows(line, PRIMARY)).toBe(false);
    policyRow.current = 'free';
    expect(shellAllows(line, PRIMARY)).toBe(true);
    // an ordinary osascript is NOT privileged — refusing it would lose a capability nobody gave up
    policyRow.current = 'blocked';
    expect(shellAllows(`osascript -e 'display dialog "hi"'`, WORKER)).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §7 — THE LAST TWO DOORS (OR-SUDO-2, final micro-round). Both resolve under the existing ruling.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§7 `su`, and a body the broker cannot read', () => {
  const SU_ROWS: readonly string[] = [
    'su -c "whoami" root', 'su root -c whoami', 'su - root -c whoami',
    '/usr/bin/su -c whoami root', 'SU -c whoami root', 'env su -c whoami root',
    'true; su -c whoami root', 'echo $(su -c whoami root)',
  ];
  const UNSEEABLE: readonly string[] = [
    'osascript /tmp/x.scpt', 'osascript -l JavaScript /tmp/x.js', 'osascript -',
    'osascript /dev/stdin', 'osascript', 'cat /tmp/x.scpt | osascript', 'osascript < /tmp/x.scpt',
  ];

  it('`su` is refused to a SUB-AGENT under every policy — it is the same role boundary', () => {
    underEach((p) => {
      for (const line of SU_ROWS) {
        const v = shell(line, WORKER);
        expect(v.allowed, `${p}: ${line}`).toBe(false);
      }
    });
  });

  it('`su` answers to the POLICY for the primary, like every other door', () => {
    policyRow.current = 'blocked';
    for (const line of SU_ROWS) expect(shellAllows(line, PRIMARY), line).toBe(false);
    policyRow.current = 'gated';
    for (const script of ['su -c whoami root', 'su root -c whoami']) {
      expect(isSudoHoldRequired('shell', { script }), script).toBe(true);
    }
    policyRow.current = 'free';
    expect(shellAllows('su root -c whoami', PRIMARY)).toBe(true);
  });

  it('⚠ `su -c "rm -rf /" root` FAILS CLOSED rather than slipping the floor', () => {
    // `-c` carries a COMMAND STRING, so it is value-taking and the shared quote check catches it. Without
    // that, the inner would be `"rm -rf /" root` — the stray quote in front of the floor prefix, exactly
    // the `--prompt="pw: "` shape. Refused under every policy, for both roles.
    for (const who of [WORKER, PRIMARY]) {
      underEach((p) => expect(shellAllows('su -c "rm -rf /" root', who), `${p}/${who}`).toBe(false));
    }
  });

  it('AN UNSEEABLE BODY IS NOT PROVEN INERT, so the policy governs it', () => {
    // The doctrine, not a new rule: admin-shaped and not proven inert ⇒ refuse or hold.
    underEach((p) => {
      for (const line of UNSEEABLE) expect(shellAllows(line, WORKER), `${p}: ${line}`).toBe(false);
    });
    policyRow.current = 'blocked';
    for (const line of UNSEEABLE) expect(shellAllows(line, PRIMARY), line).toBe(false);
    policyRow.current = 'gated';
    for (const script of ['osascript /tmp/x.scpt', 'osascript -']) {
      expect(isSudoHoldRequired('shell', { script }), script).toBe(true);
    }
    policyRow.current = 'free';
    expect(shellAllows('osascript /tmp/x.scpt', PRIMARY)).toBe(true);
  });

  it('⚠ AN INLINE `-e` BODY IS SEEABLE AND STILL RUNS — the capability is not lost', () => {
    // The line between the two is whether the phrase check can READ the body. Refusing ordinary
    // automation would delete a capability the owner never gave up.
    underEach((p) => {
      for (const line of [
        `osascript -e 'display dialog "hi"'`,
        `osascript -e 'tell application "Music" to play'`,
        `osascript -l JavaScript -e 'Application("Finder").name()'`,
        `osascript -e 'do shell script "ls -la"'`,
      ]) {
        expect(shellAllows(line, WORKER), `${p}: ${line}`).toBe(true);
      }
    });
  });

  it('⚠ THE SOUND FLOOR AND THE PROGRAM SET ARE THE SAME SET — they drifted once', () => {
    // `su` and `osascript` went into `PRIVILEGE_PROGRAMS` and not into the detector regex, so the walk
    // saw them and the floor did not — and `echo $(su -c whoami root)` escaped, because a substitution
    // is precisely the case only the floor can catch. Every program must be a token the floor knows.
    for (const program of PRIVILEGE_PROGRAMS) {
      expect(mentionsPrivilegeToken(`echo $(${program} x)`), program).toBe(true);
      expect(mentionsPrivilegeToken(`true; ${program} x`), program).toBe(true);
    }
    // and the short one does not swallow the long one
    expect(PRIVILEGE_PROGRAMS.has('su') && PRIVILEGE_PROGRAMS.has('sudo')).toBe(true);
    expect(mentionsPrivilegeToken('echo sudoku')).toBe(false);
    expect(mentionsPrivilegeToken('echo subdirectory')).toBe(false);
  });

  it('the seeable/unseeable boundary is decided by the OPERANDS, and it is a unit', () => {
    expect(osascriptBodyIsUnseeable(['-e', `'display dialog "hi"'`])).toBe(false);
    expect(osascriptBodyIsUnseeable(['-l', 'JavaScript', '-e', `'x'`])).toBe(false);
    expect(osascriptBodyIsUnseeable(['/tmp/x.scpt'])).toBe(true);
    expect(osascriptBodyIsUnseeable(['-'])).toBe(true);
    expect(osascriptBodyIsUnseeable(['/dev/stdin'])).toBe(true);
    expect(osascriptBodyIsUnseeable([])).toBe(true);           // bare osascript reads stdin
    expect(osascriptBodyIsUnseeable(['-l', 'JavaScript', '/tmp/x.js'])).toBe(true);
  });
});
