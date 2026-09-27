// ════════════════════════════════════════════════════════════════════════════════════════
// SUDO IS A POLICY, NOT A WALL — owner ruling, 2026-09-26 (ships v3.2.2).
//
// ── THE RULING ───────────────────────────────────────────────────────────────────────────────
// `sudo *` leaves the hardcoded `GLOBAL_EXEC_DENY` floor and becomes a PER-BOX SETTING:
// `blocked | gated | free`, shipped default **gated**.
//
// ── THE PREMISE, IN HIS WORDS: the agent's own Mac mini means the main agent controls the
// machine, and the blanket block contradicted that. THE PLATFORM CONTRADICTED ITSELF OUT LOUD ──
// `services/imessage-bridge.ts`'s `IMSG_INSTALL_HINT` is a setup instruction the platform prints
// FOR THE AGENT TO RUN:
//
//     git clone …/imsg.git && cd imsg && make build &&
//     sudo cp bin/imsg /opt/homebrew/bin/ &&
//     sudo cp .build/*/release/PhoneNumberKit_PhoneNumberKit.bundle /opt/homebrew/bin/
//
// Two `sudo` lines, printed by the platform, which the platform then refused to let the agent
// execute. `migration/dependency-script.ts:53` prints `sudo apt-get install -y <pkg>` for the same
// reason. A floor that forbids the very command the product hands over is not a safety property; it
// is a contradiction the owner has now resolved.
//
// ── ⚠ THE NON-NEGOTIABLE, AND IT IS THE WHOLE SECURITY ARGUMENT ──────────────────────────────
// SUDO IS A TRANSPARENT WRAPPER FOR AUTHORIZATION PURPOSES. The other three floor entries
// (`rm -rf /`, `rm -rf ~`, `chmod 777 *`) and EVERYTHING ELSE IN THE BROKER PIPELINE — the
// `secrets.yaml` substring, the tokenized sensitive-path scan, the agent's own grant rows — must
// bite INSIDE a sudo line under EVERY policy, including `free`. So the decision is:
//
//     1. strip `sudo` AND ITS OPTIONS off the front → the INNER command
//     2. re-run the ENTIRE authorization over the inner command, as if sudo were not there
//     3. only if that passes does POLICY apply, ON TOP
//
// `sudo rm -rf /` is therefore refused under `free`, and a deny-all agent still cannot run
// `sudo ls` — step 2 is where both of those happen. Anything else would make `free` a hole through
// the floor, and `gated` a hole the owner could open by clicking a dropdown.
//
// ⚠ STEP 1 IS THE SECURITY-CRITICAL PART AND IT IS NOT `slice(5)`. `sudo -u root rm -rf /` with a
// naive prefix strip leaves `-u root rm -rf /`, which matches no floor pattern at all — the floor
// would silently stop biting the moment anybody passed a flag. `parseSudo` below skips sudo's
// options, including the ones that TAKE A VALUE, and its fixture table carries every shape.
//
// ── ⚠ OWNER RULING, 2026-09-27, AND IT NARROWS THE FEATURE: "ONLY the main agent gets Sudo access
// ever." ──────────────────────────────────────────────────────────────────────────────────────
// So there are now TWO independent walls, and the order matters:
//
//   THE ROLE WALL   a NON-PRIMARY agent's sudo line is refused under EVERY policy. Unoverridable,
//                   not a grant row, and NOT a policy outcome — no setting reaches it, which is why
//                   its refusal speaks in the floor's own voice rather than the policy's.
//   THE POLICY      governs the PRIMARY ONLY. For everybody else it is not consulted at all.
//
// A CONSEQUENCE WORTH STATING, because it is what makes `gated` real: since only the primary can
// sudo, `gated` MUST hold the primary or the mode is empty. It does, and the hold goes to the
// HUMAN's approval card — never to the primary itself, which would be asking a caller to approve
// its own call. The route is the one the Healer already uses for "answers to the owner".
//
// AND SUDO IS STILL SUBJECT TO THE PRIMARY'S OWN EXEC GRANTS. The policy widens what the FLOOR
// permits; it never widens a grant. A primary whose manifest denies a command cannot sudo it.
// ════════════════════════════════════════════════════════════════════════════════════════

import { getSudoPolicyRaw, isPrimaryAgent } from '../../config/platform.js';
import { commandWords, execSimpleCommands } from '../exec-grammar.js';
// `types.js` is a leaf (no broker imports), so the verdict helpers come from there rather than
// from `proc.ts` — which imports THIS module, and would be a cycle.
import { allow, deny, type Verdict } from './types.js';
// The vocabulary and every word an agent reads live in a LEAF — see that file's header for why.
import {
  SUDO_BLOCKED_REASON, SUDO_INTERACTIVE_SHELL_REASON, SUDO_NOT_PRIMARY_REASON, SUDO_POLICY_DEFAULT,
  SUDO_UNPARSEABLE_REASON, type SudoPolicy,
} from './sudo-copy.js';

/**
 * The box's policy, read through the platform-config cache.
 *
 * AN UNRECOGNISED VALUE READS AS THE DEFAULT rather than as `free`. A typo in a config row, or a
 * downgrade that wrote a word this build does not know, must never widen authority — the same
 * direction every other fail-safe in this tree takes.
 */
export function getSudoPolicy(): SudoPolicy {
  const raw = getSudoPolicyRaw();
  return raw === 'blocked' || raw === 'gated' || raw === 'free' ? raw : SUDO_POLICY_DEFAULT;
}

/**
 * sudo options that CONSUME THE NEXT ARGUMENT. Getting this list wrong is how the floor stops
 * biting: an unlisted value-taking option leaves its value as the apparent inner command, so
 * `sudo -u root rm -rf /` would authorize `root` and run `rm -rf /`.
 *
 * From sudo(8). The short forms are what a model actually writes; the long forms are included
 * because `--user=root` and `--user root` are both legal and the second needs the skip.
 */
const SUDO_OPTS_WITH_VALUE: ReadonlySet<string> = new Set([
  '-u', '--user', '-g', '--group', '-h', '--host', '-p', '--prompt', '-C', '--close-from',
  '-D', '--chdir', '-R', '--chroot', '-T', '--command-timeout', '-U', '--other-user',
  '-r', '--role', '-t', '--type',
]);

/**
 * ⚠ OPTIONS WHOSE VALUE **IS** THE COMMAND TO BE RUN AS ROOT — `su -c "…"`, `su --command="…"`.
 *
 * SEPARATE FROM `SUDO_OPTS_WITH_VALUE` BECAUSE THE VALUE MUST BE *READ*, NOT SKIPPED. Every other
 * option's value is metadata the broker has no interest in (a prompt string, a user, a chdir), so
 * skipping it is right and a quote it cannot balance means fail closed. Here the value is the whole
 * question: it is the command the floor, the sensitive-read scan and the grant all have to see.
 *
 * ⚠ AND IT WAS A LIVE HOLE — MY OWN PROBE, not review's, measured through the real door:
 *     su root -c "rm -rf /"          ALLOWED   free + gated, primary, rule `exec-grant`
 *     su root -c "cat ~/.ssh/id_rsa" ALLOWED   the sensitive-read scan never bit either
 *     su root                        ALLOWED   an unbounded interactive ROOT SHELL
 * Two causes, one shape: `su`'s FIRST BARE OPERAND IS A USERNAME, not a command, so the option loop
 * broke on `root` and handed `root -c "rm -rf /"` back as the inner — whose program is `root`, which a
 * `*` grant allows and whose PREFIX no floor pattern matches. This is `sudo`'s operand grammar assumed
 * for a program that does not share it, and the owner's non-negotiable (the other three floor entries
 * bite INSIDE a privileged line under EVERY policy) was false for every `su` spelling that used it.
 */
const COMMAND_OPTS: ReadonlySet<string> = new Set(['-c', '--command']);

/** A quote-aware token keeps its quotes and the VALUE inside them is the command. Not `bareWord`:
 *  that also takes a basename, and `"rm -rf /"` must not come back as `"`. */
function unquoteValue(word: string): string {
  const w = word.startsWith('\\') ? word.slice(1) : word;
  if ((w.startsWith('"') && w.endsWith('"')) || (w.startsWith("'") && w.endsWith("'"))) {
    return w.slice(1, -1).trim();
  }
  return w;
}

/**
 * sudo options that request an INTERACTIVE ROOT SHELL rather than running a command. There is no
 * inner command to authorize, so there is nothing the broker can reason about — an unbounded root
 * shell is refused under every policy, including `free`.
 */
const SUDO_SHELL_OPTS: ReadonlySet<string> = new Set(['-i', '--login', '-s', '--shell']);

/**
 * ⚠ `su`'S OPTIONS ARE NOT `sudo`'S, AND THE THIRD REVIEW CAUGHT ME PORTING ONE TABLE TO BOTH (F1).
 *
 * Measured, primary under `free`: `su - root`, `su -l root`, `su -m root`,
 * `su --preserve-environment root`, `su --shell=/bin/sh root` and `su --login=x root` were all refused
 * — and `su --login root` and `su -s /bin/sh root` were **ALLOWED**, an unbounded interactive root
 * shell. SIX SPELLINGS OF ONE OPTION FAMILY CAUGHT AND THE PLAIN LONG FORM NOT, which is the exact
 * failure this file already carries a paragraph about (`--prompt="pw: "`): one option, a caught
 * spelling and an uncaught one. It recurred in the table I added one round earlier.
 *
 * TWO DIFFERENCES, BOTH REAL GRAMMAR rather than defensive guessing:
 *   · `su -s`/`--shell` TAKES A VALUE (which shell to start). `sudo -s` is a boolean asking for one.
 *     Reading su's `-s` as sudo's left `/bin/sh root` looking like the command to run.
 *   · `su`'s ONLY command source is `-c`/`--command`. Everything else it accepts — `-l`, `--login`,
 *     `-`, `-m`, `-p`, `-f`, a bare username — starts an INTERACTIVE ROOT SHELL, so there is nothing
 *     for the floor, the grants or the scan to read and the answer is the one `sudo -i` already gets:
 *     refused under every policy, `free` included. Trailing operands are still handed to the floor as
 *     the inner text, because `su root sh -c "rm -rf /"` must be refused by the most specific true
 *     thing about it rather than by the shell rule.
 * An UNKNOWN `su` option that really takes a value fails in the safe direction: it does not swallow
 * its value, the value reads as the username, and the line lands on the interactive-shell refusal.
 */
const SU_OPTS_WITH_VALUE: ReadonlySet<string> = new Set([
  '-c', '--command', '-s', '--shell', '-g', '--group', '-G', '--supp-group',
  '-w', '--whitelist-environment',
]);

export interface ParsedSudo {
  /** The command as it would read with sudo and its options removed. '' when there is none. */
  readonly inner: string;
  /** True when the line asks for an interactive root shell instead of running a command. */
  readonly interactiveShell: boolean;
  /** True when `-n`/`--non-interactive` was already passed by the caller. */
  readonly nonInteractive: boolean;
  /** True when an option's value carried a quote, so the whitespace split cannot be trusted. */
  readonly quotedOptionValue: boolean;
}

/**
 * ⚠ THE SOUND FLOOR — a privilege token ANYWHERE in the raw line, before any parsing.
 *
 * THE v3.2.2 SECURITY REVIEW'S S1 AND S3 IN ONE FUNCTION. The old recognizer tested token 0 of the
 * string the authorizer was handed, and the grammar only decomposed `for`/`while`/`if` — so `;`, `&&`,
 * `||`, a pipe, a subshell and `$( )` all delivered the whole line and sudo in any non-head position
 * was invisible. Measured through the real shell door, non-primary agent, policy `blocked`:
 * `sudo rm -rf /` denied and `true; sudo rm -rf /` ALLOWED. Thirteen of fourteen spellings in the
 * reviewer's table escaped WITH PRIVILEGE.
 *
 * This answers a deliberately CRUDE question — "does a privilege word appear here at all?" — and it is
 * asked FIRST and of the RAW LINE, so nothing about quoting, nesting or separators can hide it. It is
 * sound in the direction that matters: it cannot MISS a spelling the shell would execute. It can
 * over-report (a line that merely mentions the word), which is why the precise layer below gets to
 * prove otherwise before anything is refused.
 *
 * CASE-INSENSITIVE, because a stock macOS volume is case-insensitive and `SUDO rm -rf /` executes
 * `/usr/bin/sudo`. A LEADING BACKSLASH and SURROUNDING QUOTES are stripped, because `\sudo` and
 * `"sudo"` are the same program to the shell. `doas` is included: it is the same privilege escalation,
 * it is not installed on stock macOS today, and a floor that waits for it to be installed is a floor
 * that will be wrong once.
 *
 * NOT matched, and each is a real word a model writes: `sudoku`, `pseudo`, `sudo_policy`,
 * `mysudo` — the boundary is a shell word boundary, not a substring.
 */
/**
 * ⚠ THE SET HERE MUST MATCH `PRIVILEGE_PROGRAMS`, AND IT DRIFTED ONCE. `su` and `osascript` were added
 * to the program set and not to this regex, so the precise walk saw them and the SOUND FLOOR did not —
 * which meant `echo $(su -c whoami root)` escaped, because a substitution is exactly the case only the
 * floor can catch. Caught by the corpus row for it. The clause below pins the two lists as the same set
 * so the next addition cannot drift the same way.
 *
 * `sudo` precedes `su` in the alternation and the trailing boundary excludes a letter, so `sudo` is
 * never matched as `su` + `do`.
 */
const PRIVILEGE_TOKEN_RE =
  /(^|[\s;|&()<>{}`$'"\\/])\\?['"]?(sudo|doas|osascript|su)['"]?($|[\s;|&()<>=]|['"])/i;

export function mentionsPrivilegeToken(raw: string): boolean {
  return PRIVILEGE_TOKEN_RE.test(raw) || mentionsAdminPrivileges(raw);
}

/**
 * ⚠ THE SECOND ADMIN DOOR — OWNER RULING 2026-09-27, verbatim: **"one policy"**.
 *
 * The sudo policy governs EVERY administrator-privilege door, not just `sudo`. The re-review found the
 * one this branch had missed and it is real on this box: AppleScript's
 * `do shell script "…" with administrator privileges` reaches macOS root through Apple's own
 * authorization prompt, with no `sudo` token anywhere for the detector to see — and the tree already
 * ships an applescript broker and an `osascript` binary, so it was open to any agent holding either.
 *
 * SAME INVERTED DEFAULT AS THE SUDO SIDE: admin-shaped and not PROVEN inert ⇒ refuse or hold, per
 * policy and role. That is what makes the spelling list below unnecessary rather than exhaustive — a
 * spelling nobody enumerated still dies, because nothing about it can be proven inert.
 *
 * WHITESPACE-LIBERAL AND CASE-INSENSITIVE BY CONSTRUCTION, because AppleScript is both: the phrase can
 * be split across lines, indented inside a `tell` block, and written in any case. `\s+` between the
 * words covers newlines and tabs; `administrator` may be abbreviated `admin` in the wild, so both are
 * matched.
 */
const ADMIN_PRIVILEGES_RE = /\bwith\s+admin(?:istrator)?\s+privileges\b/i;

export function mentionsAdminPrivileges(raw: string): boolean {
  return ADMIN_PRIVILEGES_RE.test(raw);
}

/**
 * Commands that TAKE A COMMAND: if the privilege token follows one of these, it is in a program
 * position and the line runs sudo. `env` may carry `VAR=value` assignments first.
 *
 * Deliberately a LIST and not a heuristic, and the reason is the review's own finding: the first cut
 * of this feature guessed from head position and was wrong for every one of these.
 */
const EXEC_WRAPPERS: ReadonlySet<string> = new Set([
  'env', 'command', 'nice', 'nohup', 'timeout', 'time', 'stdbuf', 'setsid', 'xargs', 'ionice',
]);

/** Strip a leading backslash and surrounding quotes — the shell does, so the check must. */
function bareWord(word: string): string {
  let w = word.startsWith('\\') ? word.slice(1) : word;
  if ((w.startsWith('"') && w.endsWith('"')) || (w.startsWith("'") && w.endsWith("'"))) w = w.slice(1, -1);
  return w.includes('/') ? w.slice(w.lastIndexOf('/') + 1) : w;
}

/**
 * Is this ONE SIMPLE COMMAND a privileged one? Walks the wrappers to find the real program.
 *
 * Case-folded (S3), backslash- and quote-tolerant (S3), wrapper-aware (S3), and basename-aware as
 * before. `env X=1 sudo whoami` and `command sudo whoami` both resolve to sudo.
 */
/**
 * ⚠ THE ONE RESOLVER (re-review RC2/RC3). Index of the privilege word, or `null`.
 *
 * RC2: `isSudoLine` walked wrappers and `parseSudo` did not, so the two DISAGREED — `env X=1 sudo
 * rm -rf /` was recognised as privileged and then stripped from token 1, yielding
 * `inner = "X=1 sudo rm -rf /"`, which matches no floor prefix. Measured: ALLOWED to the primary under
 * `gated` AND `free`, with `rm -rf /` inside. Two readers of one fact is how that happens, so there is
 * ONE now and both callers ask it.
 *
 * RC3: after a wrapper the walk skipped only `VAR=value`, so the wrapper's OWN argument ended it —
 * `timeout 5 sudo …`, `nice -n 10 sudo …`, `xargs -I{} sudo …`, `stdbuf -o0 sudo …` all read as
 * unprivileged. It scans FORWARD past a wrapper's own words now, which is sound in the refusing
 * direction: the scan only ever runs after a word already known to be an exec wrapper, and finding the
 * privilege word later in that wrapper's argv is exactly what the wrapper would execute.
 */
function wrappedProgramIndex(words: readonly string[], wanted: (bare: string) => boolean): number | null {
  let i = 0;
  let wrapped = false;
  while (i < words.length) {
    const w = bareWord(words[i]).toLowerCase();
    if (wanted(w)) return i;
    if (EXEC_WRAPPERS.has(w)) { wrapped = true; i += 1; continue; }
    // Inside a wrapper's own argv (its flags, its values, `VAR=value`) keep looking; outside one, the
    // first ordinary program ends the walk — `echo sudo` is data, not a privileged line.
    if (wrapped) { i += 1; continue; }
    return null;
  }
  return null;
}

/**
 * ⚠ ONE WALK, TWO QUESTIONS — and RC2 is why it is one function rather than two copies. That round's
 * defect was `isSudoLine` walking wrappers while `parseSudo` did not: two readers of one fact, and
 * `env X=1 sudo rm -rf /` ran under `free`. My own probe then found the SAME shape one layer down —
 * `sudo env sh -c "rm -rf /"` was ALLOWED, because the body classifier tested word 0 (`env`) and
 * stopped. A second walk would have been a third reader; this is the first one, asked twice.
 */
function privilegeWordIndex(words: readonly string[]): number | null {
  return wrappedProgramIndex(words, (w) => PRIVILEGE_PROGRAMS.has(w));
}

/**
 * The programs that ARE the privilege — every admin-privilege door, per OR-SUDO-2.
 *
 * `osascript` and `su` are here by that ruling rather than by a new ask: `su -c "…" root` is plainly an
 * admin-privilege door and `su` SHIPS ON MACOS, so leaving it out would have made the wall's stated
 * purpose untrue by one more spelling. (`pkexec` and `runuser` are deliberately absent: they are not
 * installed on a stock macOS volume, and a floor entry for a program that cannot run is a line nobody
 * can test. The day either appears, this set is where it goes.)
 */
export const PRIVILEGE_PROGRAMS: ReadonlySet<string> = new Set(['sudo', 'doas', 'osascript', 'su']);

/**
 * Is this ONE SIMPLE COMMAND a privileged one? Wrapper-aware, case-folded, quote- and
 * backslash-tolerant, basename-aware.
 *
 * ⚠ `osascript` COUNTS ONLY WHEN THE SCRIPT ASKS FOR ADMINISTRATOR PRIVILEGES. The binary itself is an
 * ordinary automation tool and refusing every `osascript -e 'display dialog'` would delete a capability
 * the owner never asked to lose; `with administrator privileges` is the part that reaches root.
 */
export function isSudoLine(trimmed: string): boolean {
  const words = commandWords(trimmed);
  const at = privilegeWordIndex(words);
  if (at === null) return false;
  if (bareWord(words[at]).toLowerCase() !== 'osascript') return true;
  // The admin phrase in an INLINE body is seeable and decides the question.
  if (mentionsAdminPrivileges(trimmed)) return true;
  // …and a body the broker CANNOT READ is not proven inert, which is the doctrine.
  return osascriptBodyIsUnseeable(words.slice(at + 1));
}

/**
 * ⚠ AN ADMIN-CAPABLE INTERPRETER INVOKED ON CONTENT THE BROKER CANNOT READ (OR-SUDO-2's doctrine
 * applied, not a new rule): *admin-shaped and not proven inert ⇒ refuse or hold.*
 *
 * `osascript file.scpt`, `osascript -`, `osascript /dev/stdin`, `osascript < file` — the script body is
 * somewhere this function cannot see, and `with administrator privileges` inside it reaches root. It is
 * therefore NOT PROVEN INERT and the policy governs it: held under `gated`, refused for a sub-agent and
 * under `blocked`, allowed under `free`.
 *
 * ── ⚠ WHY NOT READ THE FILE AND PROVE IT PHRASE-FREE, which would be better if it were safe ──
 * MEASURED, AND THE RACE CANNOT BE CLOSED CHEAPLY. Proving inertness by reading is only sound if what
 * was read is what executes, and this tree has nowhere to bind that: `Verdict` carries `allowed`, a rule
 * id and a reason — no channel for a content hash — and the execution seam's own check
 * (`agent/effects/proc.ts` → `requireAuthorized({op:'proc', program})`) verifies the PROGRAM and never
 * the argument's content. So a read here would be a TOCTOU window an agent can drive: write a benign
 * script, get it authorized, rewrite it before `osascript` opens it. Closing it means threading a hash
 * from the broker to the exec seam and re-hashing there — a real plumbing change to two modules and a
 * shared type, which is not a micro-round. SO THIS SHIPS THE HOLD, and the cheaper proof is left as a
 * named improvement rather than a quiet risk.
 *
 * ⚠ AND THE HASH IS NOT THE ONLY ROAD — the third review's alternative, recorded so the next author
 * does not inherit my option space as if it were the whole one: DON'T AUTHORIZE A PATH, AUTHORIZE
 * CONTENT. If the broker reads the script and the EXECUTION CARRIES THOSE BYTES — fed on stdin from the
 * broker's own buffer, or through a retained fd (`/dev/fd/N`) — then what was read IS what executes,
 * with no new `Verdict` field, no exec-seam re-hash and no shared type. It is a different shape of
 * change rather than obviously a smaller one (the exec seam would have to accept a body instead of a
 * path, and `sudo sh -s` on a stream is precisely what this file refuses), but it binds read-to-executed
 * without a comparison step, which is the part a hash only checks and this makes structural.
 *
 * ⚠ AN INLINE `-e` BODY IS STILL SEEABLE AND STILL ALLOWED. `osascript -e 'display dialog "hi"'` runs
 * for any agent under every policy, because the phrase check can read it — refusing it would delete an
 * ordinary automation capability the owner never gave up.
 */
export function osascriptBodyIsUnseeable(operands: readonly string[]): boolean {
  // ⚠ NOW A READING OF THE ONE CLASSIFIER rather than a second answer to the same question (F3). It
  // kept its name and its clauses because the osascript door asks it by name, but `unseeable` and
  // `interactive` both mean the same thing here: not proven inert.
  const body = interpreterBody(['osascript', ...operands].join(' '));
  return body === null ? false : body.kind !== 'readable';
}

/**
 * ⚠ IS EVERY OCCURRENCE **PROVEN** INERT? (re-review RC1 — the inversion.)
 *
 * THIS FUNCTION USED TO FAIL OPEN, AND IT IS THE WHOLE OF THE SECOND NO-GO. Its loop returned `false`
 * ("not data ⇒ refuse") ONLY when the token sat at word 0 of a segment; every other position fell
 * through to `return true`. So the sound detector fired, the precise walk placed nothing, and instead
 * of UNPLACEABLE ⇒ REFUSE the line was excused as prose. Measured:
 *
 *     echo $(sudo rm -rf /)          ALLOWED to a SUB-AGENT under `blocked`
 *     echo "$(sudo whoami)"          ALLOWED
 *     flock /tmp/l sudo whoami       ALLOWED     (an unlisted wrapper)
 *     script -q /dev/null sudo …     ALLOWED
 *     unbuffer sudo whoami           ALLOWED
 *
 * And the module's own comment asserted the opposite of the code — it claimed a `$( )` substitution
 * "is NOT data and is refused", which held only when the substitution was the WHOLE segment. My 12
 * mutants and 24 clauses were green because every corpus row put the token at word 0.
 *
 * ── THE DEFAULT IS NOW REFUSE, AND THAT IS THE DESIGN RATHER THAN A PATCH ────────────────────
 * `true` is returned only when EVERY occurrence is proven inert, and "proven" means all three of:
 *   1. it is NOT in a program position (word 0 of its segment);
 *   2. its word contains no EXECUTING CONTEXT — no `$(`, no `${`, no backtick. `echo $(sudo …)` fails
 *      here, and so does `echo "$(sudo …)"`, which the old quoted-span shortcut waved through because
 *      stripping the double-quoted span removed the token along with it;
 *   3. its segment's program is on a SHORT ALLOWLIST OF PROVABLY NON-EXECUTING PROGRAMS. An allowlist,
 *      not a wrapper denylist, is the inversion: `flock`, `script` and `unbuffer` — three wrappers the
 *      reviewer invented and I never listed — die here WITHOUT being enumerated, because `flock` is
 *      not provably inert. That is the test that the default is right.
 * …and no segment may run an INTERPRETER, because there a quoted string is code, not data.
 *
 * If the raw line mentions a privilege token that NO segment word carries (a construct header the
 * segmenter dropped, a shape the grammar reports opaquely), that is by definition not proven and the
 * answer is `false`.
 */
const INERT_PROGRAMS: ReadonlySet<string> = new Set([
  'echo', 'printf', 'cat', 'head', 'tail', 'wc', 'grep', 'egrep', 'fgrep', 'rg', 'comm',
  ':', 'true', 'false',
]);
const INTERPRETERS: ReadonlySet<string> = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'eval', 'source', '.']);
const EXECUTING_CONTEXT_RE = /\$\(|\$\{|`/;

export function privilegeTokenIsQuotedData(raw: string, segments: readonly string[]): boolean {
  // ⚠ WRITTEN AS ONE CONJUNCTION OVER THE OCCURRENCES, ON PURPOSE, and the mutation run is why.
  // The first cut of the inversion was a series of early `return false`s ending in `return covered` —
  // which LOOKED fail-closed and was not TESTABLE as such: flipping that last statement to `return
  // true` changed nothing, because every corpus row was already refused by an earlier branch. A default
  // nothing can flip is a default nobody has verified. The decision is now the LAST statement and the
  // whole of it, so "flip the default back to allow" is a mutant that reds across the corpus.
  if (segments.some((seg) => INTERPRETERS.has(bareWord(seg.trim().split(/\s+/)[0] ?? '').toLowerCase()))) {
    return false;
  }
  // ⚠ NO SHORT-CIRCUIT ON THE ADMIN PHRASE. The first cut refused any line mentioning it, which also
  // refused `echo "with administrator privileges"` — prose, and the same class as `echo sudo` which is
  // deliberately allowed. The occurrence machinery below is the right judge: `osascript -e '… with
  // administrator privileges'` refuses because `osascript` is not a provably inert program, while an
  // inert program quoting the phrase is data. The AppleScript door is separate and does not rely on this.
  const occurrences: Array<{ word: string; index: number; program: string; seg: string }> = [];
  for (const seg of segments) {
    const words = seg.trim().split(/\s+/).filter(Boolean);
    const program = bareWord(words[0] ?? '').toLowerCase();
    words.forEach((word, index) => {
      if (PRIVILEGE_TOKEN_RE.test(word)) occurrences.push({ word, index, program, seg });
    });
    // ⚠ THE ADMIN PHRASE IS THREE WORDS, so a per-word scan can never see it — and the empty-conjunction
    // guard then refused `echo "with administrator privileges"`, which is prose. Measured by the clause
    // that asserts prose stays allowed. It is collected as ONE occurrence, positioned at the word the
    // phrase starts on, judged by the same three conditions: an inert program quoting it is data, while
    // `osascript -e '… with administrator privileges'` refuses because `osascript` is not inert.
    if (mentionsAdminPrivileges(seg)) {
      const at = words.findIndex((w) => /^\W*with$/i.test(w) || /^\W*with\b/i.test(w));
      occurrences.push({ word: seg, index: at <= 0 ? 0 : at, program, seg });
    }
  }
  // Mentioned in the raw line and carried by NO segment word — a construct header the segmenter drops,
  // a shape it reports opaquely — is not proven, and the empty conjunction must not read as proof.
  if (occurrences.length === 0) return false;
  return occurrences.every((o) => {
    // ⚠ A WORD-0 OCCURRENCE IS PROVEN INERT WHEN THE PRECISE LAYER SAYS SO, and that exception exists
    // because `osascript` and `su` joined the crude detector: an ordinary
    // `osascript -e 'display dialog "hi"'` has the token in PROGRAM position, so the blanket word-0
    // refusal turned every benign automation line into an unplaceable refusal — measured by the clause
    // that keeps that capability. `isSudoLine` is the precise layer, it could READ this whole segment,
    // and it returned false: for `osascript` that means a seeable, phrase-free body, and for `sudo`/`su`
    // it never returns false at word 0 at all. A verdict from the layer that can see everything is proof;
    // this is not a hole, it is the one place the two layers are allowed to disagree.
    // THE EXECUTING-CONTEXT TEST BINDS FIRST, AT EVERY POSITION. `$(sudo whoami)` is ALSO a word-0
    // occurrence — the tokenizer hands the whole substitution back as one opaque word — so applying the
    // word-0 exception before this test excused it, and the corpus caught that immediately.
    if (EXECUTING_CONTEXT_RE.test(o.word)) return false;
    if (o.index === 0) return !isSudoLine(o.seg);
    return INERT_PROGRAMS.has(o.program);
  });
}

/** Programs proven not to execute their arguments — the allowlist the inversion rests on. */
export function isInertProgram(name: string): boolean {
  return INERT_PROGRAMS.has(bareWord(name).toLowerCase());
}

/**
 * THE ADMIN-PRIVILEGE REQUEST, decided by the same two walls as a sudo line.
 *
 * Used by the AppleScript door, where there is no inner shell command to re-run through the broker —
 * the script IS the request, and `authorizeAppleScript` has already put its `do shell script` payloads
 * through the floor, the sensitive-read scan and the shell grant before asking this.
 *
 * SAME ORDER, SAME VOICE: the role wall first (a non-primary agent gets the identical sentence it gets
 * for sudo, because it is the identical boundary), then the policy. `gated` ALLOWS here for the same
 * layering reason the sudo path does — the hold is filed upstream at dispatch — and `blocked` refuses
 * with the floor's wording.
 */
export function authorizeAdminPrivilegeRequest(agentId: string): Verdict {
  if (!isPrimaryAgent(agentId)) {
    return deny('ladder-parity', 'admin-privileges-not-primary', SUDO_NOT_PRIMARY_REASON);
  }
  const policy = getSudoPolicy();
  if (policy === 'blocked') {
    return deny('ladder-parity', 'admin-privileges-policy:blocked', SUDO_BLOCKED_REASON);
  }
  return allow(`admin-privileges-policy:${policy}`);
}

/**
 * Strip `sudo` and its options, returning the command sudo would actually run.
 *
 * ⚠ RECURSES ON A NESTED `sudo`, because `sudo sudo rm -rf /` is one command with two wrappers and
 * the floor has to see the bottom of the stack. Bounded by the token count, so it cannot spin.
 *
 * Crude by the same admission the sensitive-path scan makes: this is not a shell parser, and a
 * determined bypass through a heredoc or a base64 pipe gets past it. What it does guarantee is that
 * the ORDINARY spellings a model writes cannot slip a floor pattern past the broker.
 */
export function parseSudo(trimmed: string): ParsedSudo {
  const tokens = commandWords(trimmed);
  // RC2: START AFTER THE PRIVILEGE WORD THE ONE RESOLVER FOUND, not after token 0. `env X=1 sudo …`
  // used to leave `X=1 sudo …` as the inner command and the floor matched nothing.
  const at = privilegeWordIndex(tokens);
  let i = (at ?? 0) + 1;
  let nonInteractive = false;
  let quotedOptionValue = false;
  // ⚠ `su`'s OPERAND GRAMMAR IS NOT `sudo`'s, and assuming it was is the hole documented on
  // `COMMAND_OPTS`. `sudo [opts] <command…>` — the first bare operand STARTS the command.
  // `su [opts] [user] [-c <command>]` — the first bare operand is a USERNAME and the command arrives
  // through the option. So the loop steps over exactly one bare operand here and keeps reading
  // options, or `su root -c "rm -rf /"` never reaches the `-c` that carries the command.
  const isSu = bareWord(tokens[at ?? 0] ?? '').toLowerCase() === 'su';
  let sawSuUser = false;
  let commandFromOption: string | null = null;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t === '--') { i += 1; break; }
    if (!t.startsWith('-')) {
      if (isSu && !sawSuUser) { sawSuUser = true; i += 1; continue; }   // a USERNAME, not a command
      break;
    }
    if (COMMAND_OPTS.has(t)) {
      // ⚠ STOP READING OPTIONS HERE. The command is decided, so every remaining token is either the
      // username or something this parser cannot account for — and it must reach the check below as
      // itself. Continuing the loop let `su root -c rm -rf /` consume `-rf` as an ordinary boolean
      // flag, which is precisely how that ambiguity would have gone unnoticed.
      commandFromOption = unquoteValue(tokens[i + 1] ?? '');
      i += 2; break;
    }
    if (t.startsWith('--command=')) {
      // The long form with `=`, which the generic `=` branch below would only fail closed on. Same
      // spelling of the same option, so it gets the same reading — the lesson of the `--prompt="pw: "`
      // bug was that one option must not have a caught spelling and an uncaught one.
      commandFromOption = unquoteValue(t.slice('--command='.length));
      i += 1; break;
    }
    if (t === '-n' || t === '--non-interactive') { nonInteractive = true; i += 1; continue; }
    if (!isSu && SUDO_SHELL_OPTS.has(t)) {
      // `sudo -i` / `sudo -s` MAY be followed by a command; with nothing after it, it is a shell.
      // NOT for `su`, whose `-s` takes a value and whose `--login` is followed by a USERNAME: reading
      // this branch for su is what made `su --login root` authorize `root` as the command (F1).
      const rest = tokens.slice(i + 1).join(' ');
      return rest.length === 0
        ? { inner: '', interactiveShell: true, nonInteractive, quotedOptionValue }
        : finish(rest, nonInteractive, quotedOptionValue);
    }
    if (t.includes('=')) {
      // ⚠ S2: THIS BRANCH USED TO SHORT-CIRCUIT THE QUOTE CHECK BELOW, so `--prompt="pw: "` produced
      // `inner = '" rm -rf /'` with `quotedOptionValue` false — the floor matches a PREFIX, the stray
      // quote sat in front of it, and the PRIMARY was ALLOWED to run `sudo --prompt="pw: " rm -rf /`
      // under `free`. The short form `-p "pw: "` was caught, which is exactly how it hid: the author
      // fixed one spelling. BOTH FORMS SHARE ONE CHECK NOW.
      if (/['"]/.test(t.slice(t.indexOf('=') + 1))) quotedOptionValue = true;
      i += 1; continue;
    }
    if ((isSu ? SU_OPTS_WITH_VALUE : SUDO_OPTS_WITH_VALUE).has(t)) {
      // A value that opens a quote means the real value spans tokens we cannot count.
      if (/['"]/.test(tokens[i + 1] ?? '')) quotedOptionValue = true;
      i += 2; continue;
    }
    i += 1;                                               // an ordinary boolean flag
  }
  // ⚠ THE COMMAND OPTION WINS OVER THE TRAILING OPERANDS, because in `su -c "rm -rf /" root` the
  // trailing `root` is the USERNAME: re-running it as a command would ask the broker about the wrong
  // string entirely — `root` is not an executable and, under a `*` grant, not a refusal either.
  if (commandFromOption !== null) {
    // ⚠ WHAT MAY FOLLOW THE COMMAND VALUE IS **AT MOST A USERNAME**, and anything else fails closed.
    // `su root -c rm -rf /` hands `-c` the single word `rm` and leaves `-rf /` over. Real `su` passes
    // those to the shell as positional parameters, so `rm` would run with no arguments — but the floor
    // must not rest on this parser's reading of another program's argument handling. One bare operand
    // is the username (`su -c "…" root`, the documented order); a flag or a second operand means the
    // line means something this parser cannot state, and an unreadable privileged line is refused.
    const after = tokens.slice(i);
    if (after.length > 1 || after.some((w) => w.startsWith('-'))) quotedOptionValue = true;
    // `su root -c ""` needs no branch of its own: an EMPTY inner is already "nothing to run", and
    // `authorizeSudoLine` owns that question for every spelling at once. A mutant proved the branch
    // I first wrote here could not be falsified — nothing changed when it went — so it is gone rather
    // than kept as a second answer to a question already answered. The clause stays.
    return finish(commandFromOption, nonInteractive, quotedOptionValue);
  }
  const rest = tokens.slice(i).join(' ');
  // ⚠ F1: `su` WITHOUT `-c` IS A ROOT PROMPT, whatever else is on the line. `inner` still carries the
  // trailing text so the floor can read it first — `su root sh -c "rm -rf /"` is refused as the floor
  // pattern it is, not as a shell request — and `interactiveShell` is what makes the plain forms
  // (`su --login root`, `su -s /bin/sh root`, `su root`) refuse under every policy.
  if (isSu) return { inner: rest, interactiveShell: true, nonInteractive, quotedOptionValue };
  // Nothing left to run: `sudo -i`, `sudo -s` — an unbounded INTERACTIVE ROOT SHELL, refused under
  // every policy including `free`, because there is no inner command to reason about.
  if (rest.length === 0) return { inner: '', interactiveShell: true, nonInteractive, quotedOptionValue };
  return finish(rest, nonInteractive, quotedOptionValue);
}

/**
 * ⚠ EVERY COMMAND A PRIVILEGED LINE WOULD ACTUALLY RUN, so the floor can be asked about all of them.
 *
 * MY PROBE FOUND THIS TOO, AND IT IS A REGRESSION THIS BRANCH WOULD HAVE INTRODUCED — not a
 * pre-existing gap. While `sudo *` sat in `GLOBAL_EXEC_DENY`, every sudo line was refused outright, so
 * the floor's inability to read a QUOTED INTERPRETER BODY never mattered for root. Taking `sudo *` out
 * and replacing it with a policy makes it matter, and under `free` these were all ALLOWED:
 *     sudo sh -c "rm -rf /"          the floor's prefix sees `sh`, not `rm`
 *     su root sh -c "rm -rf /"
 *     sudo bash -lc "rm -rf /"       a combined short flag, the same thing spelled shorter
 *     su root -c "ls; rm -rf /"      the `;` is inside the quotes, so no SEGMENT carries `rm`
 * The owner's non-negotiable is that `rm -rf /` as root is refused under EVERY policy, `free` included,
 * so a privileged line is read ONE INTERPRETER DEEPER and its statements are floored individually —
 * the same argument that justifies flooring every segment of a pipeline: the floor is `rm -rf /`,
 * `rm -rf ~`, `chmod 777 *` and the credentials file, and none of those is a capability anyone loses.
 *
 * ⚠ DELIBERATELY PRIVILEGED-ONLY. `sh -c "rm -rf /"` WITHOUT sudo stays allowed under a `*` grant,
 * exactly as it is on `main` — unchanged behaviour, and it is the user's own uid rather than the
 * machine. Widening the floor for unprivileged lines is a live behaviour change beyond this feature.
 *
 * Bounded at three unwraps so a `sh -c "sh -c …"` stack cannot spin.
 */
export function privilegedInnerCommands(trimmed: string): string[] {
  // Only a PRIVILEGED line has privileged inner commands. `proc.ts` asks this after `isSudoLine`, so
  // the guard changes no behaviour there — it keeps the exported unit honest on its own, because
  // `parseSudo` on an ordinary line strips its first word and would name a command nobody is running.
  if (!isSudoLine(trimmed)) return [];
  const parsed = parseSudo(trimmed);
  return parsed.inner.length === 0 ? [] : unwrapBodies(parsed.inner).commands;
}

export interface Unwrapped {
  /** Every command the text would run, one interpreter deeper, for the floor to be asked about. */
  readonly commands: string[];
  /** A body at ANY depth whose quotes do not balance — what was extracted is not what runs. */
  readonly unparseable: boolean;
  /** A body at ANY depth that is a root prompt or arrives on a stream. */
  readonly interactive: boolean;
}

/**
 * ⚠ ONE WALK RETURNING BOTH THE COMMANDS AND THE FINDINGS, and a failing clause is why it is one.
 *
 * My first cut classified only the TOP body and collected commands separately, so
 * `sudo sh -c "sh -c \"rm -rf /\""` was ALLOWED: the outer body's quotes balance, the INNER one's do
 * not, and the finding had nowhere to travel. Two walks over one structure is the two-readers shape
 * this campaign keeps paying for — so the recursion happens once and reports everything it saw.
 *
 * Takes a COMMAND TEXT, never a privileged line, and calls no parser above it: `parseSudo` reaches
 * this through `parseInner`, and a walk that called back into `parseSudo` would not terminate.
 */
function unwrapBodies(command: string, depth = 0): Unwrapped {
  const commands: string[] = [];
  let unparseable = false;
  let interactive = false;
  for (const seg of execSimpleCommands(command)) {
    commands.push(seg);
    const body = interpreterBody(seg);
    if (body === null) continue;
    if (body.kind === 'unparseable') unparseable = true;
    if (body.kind === 'interactive') interactive = true;
    if (depth >= 3 || body.inline === null || body.inline.text.length === 0) continue;
    const deeper: string[] = [];
    // A SHELL body is commands; ANOTHER LANGUAGE's body reaches a shell through its string literals.
    if (body.inline.language === 'shell') deeper.push(body.inline.text);
    else {
      const literals = quotedLiterals(body.inline.text);
      deeper.push(...literals);
      // ⚠ AND THE LITERALS JOINED, because the ARGV form spells one command across several of them:
      // `subprocess.run(['rm','-rf','/'])` and `perl -e 'exec "rm", "-rf", "/"'` were both ALLOWED —
      // each literal alone is harmless and the floor pattern only exists in their sequence.
      if (literals.length > 1) deeper.push(literals.join(' '));
    }
    for (const text of deeper) {
      const below = unwrapBodies(text, depth + 1);
      commands.push(...below.commands);
      unparseable = unparseable || below.unparseable;
      interactive = interactive || below.interactive;
    }
  }
  return { commands, unparseable, interactive };
}

/** Interpreters whose inline body IS SHELL, so each statement in it is a command the floor knows. */
const SHELL_INTERPRETERS: ReadonlySet<string> = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash']);

/**
 * …and the interpreters whose body is ANOTHER LANGUAGE, with the option that carries it (F2).
 *
 * THE THIRD REVIEW MEASURED ALL OF THESE AS ALLOWED under `free`, and they are ordinary spellings a
 * model writes: `sudo python3 -c "import os; os.system('rm -rf /')"`, `sudo perl -e "system('…')"`,
 * `sudo ruby -e`, `sudo node -e "require('child_process').execSync('…')"`, `sudo php -r`,
 * `sudo awk "BEGIN{system(\"…\")}"`. Round 6b closed this class for `sh -c` and left its siblings
 * open; the ruling is about what runs as root, so they are in scope by the same sentence.
 *
 * ⚠ HOW A NON-SHELL BODY IS READ, without this file learning six languages: its SHELL REACH IS ITS
 * QUOTED STRING LITERALS. `os.system`, `system`, `execSync`, `exec`, backticks and `awk`'s `system()`
 * all take a SHELL COMMAND as a string, so every literal in the body is handed to the floor as a
 * command. It is crude in the direction that costs nothing — a literal that happens to read
 * `rm -rf /` is refused whether or not it reaches a shell, and that is the answer we want either way.
 */
const CODE_INTERPRETERS: ReadonlyMap<string, readonly string[]> = new Map([
  ['python', ['-c']], ['python3', ['-c']], ['python2', ['-c']],
  ['perl', ['-e', '-E']], ['ruby', ['-e']], ['node', ['-e', '--eval', '-p', '--print']],
  ['php', ['-r']], ['osascript', ['-e', '--expression']],
]);
/** Any interpreter this file knows how to ask about, by bare program name. */
const isInterpreterName = (bare: string): boolean =>
  SHELL_INTERPRETERS.has(bare) || CODE_INTERPRETERS.has(bare) || PROGRAM_TEXT_INTERPRETERS.has(bare);

/** `awk`'s program is its first bare operand rather than an option's value. */
const PROGRAM_TEXT_INTERPRETERS: ReadonlySet<string> = new Set(['awk', 'gawk', 'nawk']);

/**
 * ⚠ EACH INTERPRETER'S OPTIONS THAT TAKE A VALUE — and F1 is why this table exists at all rather than
 * being assumed: the SAME MISTAKE one layer down would read `osascript -l JavaScript -e '…'` as having
 * a FILE OPERAND called `JavaScript` and refuse ordinary automation, or read `awk -f prog.awk` as a
 * flag and miss that the program is in a file nobody here can see. The value is METADATA to step over.
 */
const INTERPRETER_METADATA_OPTS: ReadonlyMap<string, readonly string[]> = new Map([
  ['osascript', ['-l', '--language', '-s']],
  ['sh', ['-o']], ['bash', ['-o', '--rcfile', '--init-file']], ['zsh', ['-o']],
  ['dash', ['-o']], ['ksh', ['-o']], ['ash', ['-o']],
  ['python', ['-W', '-X']], ['python3', ['-W', '-X']], ['python2', ['-W', '-X']],
  ['node', ['-r', '--require', '--input-type']], ['perl', ['-I', '-M']],
  ['ruby', ['-I', '-r']], ['php', ['-d']], ['awk', ['-v', '--assign']],
  ['gawk', ['-v', '--assign']], ['nawk', ['-v', '--assign']],
]);
/** …and the options whose value is a PROGRAM FILE: the body, in a place the broker cannot read it. */
const INTERPRETER_FILE_OPTS: ReadonlyMap<string, readonly string[]> = new Map([
  ['awk', ['-f', '--file']], ['gawk', ['-f', '--file']], ['nawk', ['-f', '--file']],
  ['php', ['-f']], ['python', ['-m']], ['python3', ['-m']], ['python2', ['-m']],
]);

export interface PrivilegedBody {
  /**
   * `readable` — the broker holds the body text and the floor can be asked about it.
   * `unseeable` — a FILE or a redirect: nobody here can read it, but it has a NAME, so the policy
   *               governs it exactly as `osascript /tmp/x.scpt` has since round 6.
   * `interactive` — a root PROMPT, or a body arriving on a STREAM. Refused under every policy.
   * `unparseable` — a body whose quotes DO NOT BALANCE once escaping is undone, so the text this
   *               function extracted is not the text that will run. Refused under every policy, with
   *               the wording that says how to rewrite it — never called a shell request, because it
   *               is not one and the message an agent reads has to be true.
   */
  readonly kind: 'readable' | 'unseeable' | 'interactive' | 'unparseable';
  /** The inline body when there is one, EVEN IF `kind` is not `readable` — see the decoy note. */
  readonly inline: { readonly language: 'shell' | 'code'; readonly text: string } | null;
}

/**
 * ⚠ ONE CLASSIFIER FOR EVERY PRIVILEGED INTERPRETER (F2 + F3, and it unifies round 6's osascript rule).
 *
 * F3 was the doctrine applied to one door and not the other: `osascript /tmp/x.scpt` HELD while
 * `sudo sh /tmp/x.sh` ran, and bare `sudo sh` — an unbounded root shell reading stdin — was not
 * classified at all while `sudo -i` and `su root` both were. One rule now answers for all of them.
 *
 * THE LINE BETWEEN `unseeable` AND `interactive` IS WHETHER THE BODY HAS A NAME, and it is the whole
 * of the judgement here: a FILE can be inspected by the owner on the card and named in the audit trail,
 * so the policy may allow it under `free`; a body on a STREAM — stdin, `-`, `sh -s`, the receiving end
 * of a pipe — can never be read by anyone, not the broker and not the owner, so no policy setting can
 * make it reviewable and it is refused under every one. That also makes `curl … | sudo sh` refused
 * under `free`, which is a capability consequence the release note states rather than hides: the same
 * work is available as `curl -o f && sudo sh f`, where there is a path a human can look at.
 *
 * ⚠ AN UNREADABLE BODY BEATS AN INLINE ONE, which is round 6's decoy lesson generalised:
 * `osascript -e 'benign' -` and `sudo sh -s <<< "rm -rf /"` both LOOK readable and both also execute
 * something the broker never sees. The inline text is still returned so the floor gets everything it
 * can read — that is why `sudo sh -s <<< "rm -rf /"` is refused by the FLOOR naming `rm -rf /` rather
 * than by the shell rule — but the KIND is decided by the part nobody can read.
 */
export function interpreterBody(seg: string): PrivilegedBody | null {
  const words = commandWords(seg);
  const at = wrappedProgramIndex(words, isInterpreterName);
  if (at === null) return null;
  const program = bareWord(words[at]).toLowerCase();
  const isShell = SHELL_INTERPRETERS.has(program);
  const bodyOpts = CODE_INTERPRETERS.get(program);
  const programText = PROGRAM_TEXT_INTERPRETERS.has(program);
  const language: 'shell' | 'code' = isShell ? 'shell' : 'code';
  const metadata = INTERPRETER_METADATA_OPTS.get(program) ?? [];
  const fileOpts = INTERPRETER_FILE_OPTS.get(program) ?? [];
  const carriesBody = (word: string): boolean => isShell
    // ⚠ ANY SHORT-FLAG CLUSTER ENDING IN `c`, because `-lc` and `-ec` are the same option spelled
    // shorter and a floor that only knows `-c` is a floor with a documented spelling and an
    // undocumented one. That is precisely how the `--prompt="pw: "` bug hid.
    // ⚠ `c` ANYWHERE IN THE CLUSTER, not only last: `sh -cx 'rm -rf /'` runs the command with xtrace,
    // and my first cut required the `c` to END the cluster — so `-cx` read as an ordinary flag and its
    // body read as a FILE OPERAND. One option, a caught spelling and an uncaught one, for the third
    // time in this campaign; the pattern is the lesson, not the spelling.
    ? (word === '--command' || /^-[a-z]*c[a-z]*$/i.test(word))
    : (bodyOpts?.includes(word) ?? false);
  let inline: { language: 'shell' | 'code'; text: string } | null = null;
  let unreadable: 'stream' | 'file' | null = null;
  for (let w = at + 1; w < words.length; w += 1) {
    const word = words[w];
    const eq = word.indexOf('=');
    if (carriesBody(word)) {
      inline ??= { language, text: unquoteValue(words[w + 1] ?? '') };
      w += 1; continue;
    }
    if (eq > 0 && carriesBody(word.slice(0, eq))) {
      inline ??= { language, text: unquoteValue(word.slice(eq + 1)) };
      continue;
    }
    if (fileOpts.includes(word) || (eq > 0 && fileOpts.includes(word.slice(0, eq)))) {
      unreadable ??= 'file';                                            // the body, but in a file
      if (eq < 0) w += 1;
      continue;
    }
    if (metadata.includes(word)) { w += 1; continue; }                  // a value we do not care about
    if (eq > 0 && metadata.includes(word.slice(0, eq))) continue;
    // A HERE-STRING IS READABLE — it is right there in the line — so the floor gets its text.
    if (word === '<<<') { inline ??= { language, text: unquoteValue(words[w + 1] ?? '') }; w += 1; continue; }
    if (word.startsWith('<')) { unreadable ??= 'file'; continue; }      // `< file`, or a heredoc header
    if (word === '-' || word === '/dev/stdin' || (isShell && word === '-s')) { unreadable = 'stream'; continue; }
    if (word.startsWith('-')) continue;                                 // an ordinary flag
    if (programText) { inline ??= { language, text: unquoteValue(word) }; continue; }
    unreadable ??= 'file';                                              // a FILE operand
  }
  // ⚠ AN ESCAPED QUOTE DEFEATS THE WORD TOKENIZER, AND MY OWN PROBE CAUGHT IT: in
  // `su root -c "python3 -c \"os.system('rm -rf /')\""` the inner body's `\"` does not open a quoted
  // span, so the body arrives as the fragment `"os.system('rm` and the literal the floor needs is in
  // another token. The fragment's quotes do not balance, which is measurable, so the line is refused
  // as unreadable rather than judged on a fragment. Same rule for a shell body spelled that way.
  if (inline !== null && !quotesBalance(inline.text)) return { kind: 'unparseable', inline };
  if (unreadable === 'stream') return { kind: 'interactive', inline };
  if (unreadable === 'file') return { kind: 'unseeable', inline };
  // No body at all is a root PROMPT: `sudo sh`, `sudo bash`, `sudo python3` are `sudo -i` by another
  // name, and the review is right that the one classified and the others not was the sharpest gap.
  return inline === null ? { kind: 'interactive', inline: null } : { kind: 'readable', inline };
}

/** Escaping undone: a body written into another string carries `\"` where a quote is meant, and a
 *  literal ending `rm -rf /\` matches no floor pattern while `rm -rf /` does. Measured, not assumed —
 *  `sudo awk "BEGIN{system(\"rm -rf /\")}"` was ALLOWED until this existed. */
const unescape = (text: string): string => text.replace(/\\(.)/g, '$1');

/** Do the quotes balance once escaping is undone? If not, what was extracted is not what will run. */
function quotesBalance(text: string): boolean {
  const bare = unescape(text);
  return (bare.split('"').length - 1) % 2 === 0 && (bare.split("'").length - 1) % 2 === 0;
}

/** Every quoted string literal in a non-shell body — see `CODE_INTERPRETERS` for why these are it. */
function quotedLiterals(text: string): string[] {
  return [...unescape(text).matchAll(/'([^']*)'|"([^"]*)"/g)]
    .map((m) => (m[1] ?? m[2] ?? '').trim())
    .filter((s) => s.length > 0);
}

/** One more layer, for a nested wrapper. */
function parseInner(rest: string): { inner: string; interactiveShell: boolean; unparseable: boolean } {
  if (isSudoLine(rest)) {
    const again = parseSudo(rest);
    return { inner: again.inner, interactiveShell: again.interactiveShell, unparseable: again.quotedOptionValue };
  }
  // ⚠ F3: A PRIVILEGED INTERPRETER WITH NO READABLE BODY IS A ROOT PROMPT. `sudo sh`, `sudo sh -s`,
  // `echo … | sudo sh`, `sudo python3` — each is `sudo -i` spelled differently, and the review is
  // right that classifying one and not the others was the sharpest remaining gap. A NAMED body
  // (`sudo sh /tmp/x.sh`) is `unseeable` instead, which the policy already governs because the line
  // is a privileged line: refused under `blocked`, held under `gated`, allowed under `free`.
  // ⚠ AT ANY DEPTH, not only the top one: an inner body's unbalanced quotes are the same defect as an
  // outer one's, and `sudo sh -c "sh -c \"rm -rf /\""` is how that was measured.
  const found = unwrapBodies(rest);
  return { inner: rest, interactiveShell: found.interactive, unparseable: found.unparseable };
}

/** One place where a parsed inner becomes the result, so no call site can forget a signal. */
function finish(rest: string, nonInteractive: boolean, quotedOptionValue: boolean): ParsedSudo {
  const p = parseInner(rest);
  return {
    inner: p.inner,
    interactiveShell: p.interactiveShell,
    nonInteractive,
    quotedOptionValue: quotedOptionValue || p.unparseable,
  };
}

/**
 * THE DECISION, and the ORDER OF THESE THREE STEPS IS THE SECURITY PROPERTY.
 *
 * `reauthorize` is the broker's own per-command authority, handed in as a callback so this module
 * decides the POLICY without importing the broker (which imports this one). It runs the floor, the
 * `secrets.yaml` substring, the agent's grant rows — everything — over the INNER command.
 *
 * ⚠ THE SENSITIVE-PATH SCAN IS NOT RE-RUN HERE, AND THAT IS MEASURED RATHER THAN ASSUMED:
 * `commandReadsSensitiveFile` walks EVERY token looking for a reader, so it is position-independent
 * and already sees inside a sudo line — `sudo cat <secret>` and `sudo -u root cat /etc/shadow` both
 * match on the `cat` at token 1 or 3. Verified before the inner call was removed, and pinned by a
 * clause, so the reliance is a fact somebody checks rather than a habit.
 *
 * `gated` returns ALLOW. The consent hold is filed upstream of the broker, and ⚠ THIS SENTENCE WAS
 * STALE FOR A ROUND — it said `isDestructiveCall` classifies a sudo line as destructive, which was the
 * FIRST cut's design. The 2026-09-27 ruling made that arm dead code (no sub-agent can sudo; the
 * primary is not held by that gate) and it was REMOVED — `destructive-gate.ts` says so at the site.
 * THE HOLD IS FILED IN `agent/v2/steps/execute/dispatch-bookkeeping.ts`, for the PRIMARY, routed to the
 * OWNER's card via `fileHealerApprovalProposal`. Found by the blast author reading the two comments
 * against each other; recorded rather than quietly corrected, because a stale comment that names the
 * wrong owner is how the next reader debugs the wrong file.
 *
 * A deny here would refuse the post-approval retry — spending the one-shot approval for nothing, the
 * dead-end `manifestPermitsDestructiveCall` exists to prevent — and would stop the PRIMARY from ever
 * running sudo at all.
 */
export function authorizeSudoLine(
  trimmed: string,
  agentId: string,
  reauthorize: (inner: string) => Verdict,
): Verdict {
  const parsed = parseSudo(trimmed);
  if (parsed.interactiveShell || parsed.inner.length === 0) {
    return deny('ladder-parity', 'sudo-interactive-shell', SUDO_INTERACTIVE_SHELL_REASON);
  }
  // ⚠ FAIL CLOSED WHEN THE PARSE WAS DEFEATED, AND MY OWN FIXTURE TABLE IS WHY THIS EXISTS.
  // `parseSudo` splits on whitespace, so an option VALUE CONTAINING A QUOTED SPACE defeats it:
  // `sudo -p "pw: " rm -rf /` tokenizes to [sudo, -p, "pw:, ", rm, …]; the parser takes `"pw:` as
  // `-p`'s value and hands back `" rm -rf /` as the inner command — which matches NO floor pattern,
  // because the floor matches a PREFIX and the stray quote is now in front of it. The floor silently
  // stopped biting on a shape a model can write by accident.
  //
  // Two fixes were measured and one was rejected: re-scanning the line with the word `sudo` textually
  // removed does NOT help, because `-p "pw: " rm -rf /` still does not START with a floor pattern, and
  // widening the floor to a SUBSTRING match would refuse `echo "rm -rf /"` — a live behaviour change
  // beyond this feature's remit. So an unparseable sudo line is REFUSED rather than guessed at: the
  // command is unusual, the message says exactly how to rewrite it, and a floor that cannot read a
  // line must never assume the line is safe.
  if (parsed.quotedOptionValue) {
    return deny('ladder-parity', 'sudo-unparseable-options', SUDO_UNPARSEABLE_REASON);
  }
  const inner = reauthorize(parsed.inner);
  if (!inner.allowed) return inner;
  // ⚠ THE ROLE WALL, AFTER the inner re-run and BEFORE the policy. After, so that a sub-agent's
  // `sudo rm -rf /` is refused by the FLOOR — the most specific true thing about it — rather than by
  // a role message that would leave the reader thinking a different agent could run it. Before the
  // policy, because no setting may reach it: for a non-primary the policy is never consulted at all.
  if (!isPrimaryAgent(agentId)) {
    return deny('ladder-parity', 'sudo-not-primary', SUDO_NOT_PRIMARY_REASON);
  }
  const policy = getSudoPolicy();
  if (policy === 'blocked') return deny('ladder-parity', 'sudo-policy:blocked', SUDO_BLOCKED_REASON);
  return allow(`sudo-policy:${policy}(${inner.rule})`);
}

/**
 * Does THIS call need the owner's approval before it runs? `gated` + a sudo line, and nothing else.
 *
 * Asked of the CALL rather than of the command text alone, so both exec doors are covered by one
 * question. `blocked` never reaches here (the broker's floor refuses it) and `free` is the owner saying
 * he does not want to be asked — holding on a box configured not to hold is the defect this narrowness
 * prevents.
 */
export function isSudoHoldRequired(toolName: string, args: Record<string, unknown>): boolean {
  // ⚠ THE STRING WORK COMES FIRST, AND THAT ORDERING IS THE ROBUSTNESS. This runs on EVERY tool call
  // of every turn, and it used to read the policy first — so anything that made the config read throw
  // took the whole turn down, not just sudo. Found by the integration suite: 39 failures from one
  // undefined import. Parsing cannot throw, and it answers `false` for the overwhelming majority of
  // calls before any I/O happens.
  const raw = toolName === 'shell' ? args.script
    : Array.isArray(args.argv) ? (args.argv as unknown[]).join(' ')
      : args.command;
  if (!(typeof raw === 'string' && raw.length > 0)) return false;
  // ⚠ SEGMENTED, AND THE REVIEW IS EXPLICIT ABOUT WHY: "Apply the same splitting to
  // `isSudoHoldRequired`, or `gated` keeps executing unasked." Asking `isSudoLine` about the WHOLE
  // script tests its head word, so `true; sudo whoami` produced NO HOLD — no card, no
  // `destructive_approvals` row, root command executed. Measured that way at `27a3d091`.
  // The SOUND FLOOR decides the hold: any privilege token the line mentions is enough, unless the
  // precise walk places it as inert data. Erring toward a hold costs the owner one card; erring the
  // other way runs an administrator command he never saw.
  if (mentionsAdminPrivileges(raw)) return getSudoPolicy() === 'gated';
  const segments = execSimpleCommands(raw.trim());
  const privileged = segments.some((seg) => isSudoLine(seg));
  if (!privileged) {
    if (!mentionsPrivilegeToken(raw)) return false;
    if (privilegeTokenIsQuotedData(raw, segments)) return false;
  }
  // It IS a sudo line, so the policy decides — and an unreadable policy HOLDS rather than runs. A
  // read that fails must never be the reason an administrator command executed unasked.
  try {
    return getSudoPolicy() === 'gated';
  } catch {
    return true;
  }
}

