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

/** The three values, and the only three. */
export type SudoPolicy = 'blocked' | 'gated' | 'free';

/** Shipped default, per the ruling. A box that has never been configured GATES. */
export const SUDO_POLICY_DEFAULT: SudoPolicy = 'gated';

/** The config row's key. One spelling, exported, so the route, the cache and the UI agree. */
export const SUDO_POLICY_KEY = 'sudo_policy';

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
function privilegeWordIndex(words: readonly string[]): number | null {
  let i = 0;
  let wrapped = false;
  while (i < words.length) {
    const w = bareWord(words[i]).toLowerCase();
    if (PRIVILEGE_PROGRAMS.has(w)) return i;
    if (EXEC_WRAPPERS.has(w)) { wrapped = true; i += 1; continue; }
    // Inside a wrapper's own argv (its flags, its values, `VAR=value`) keep looking; outside one, the
    // first ordinary program ends the walk — `echo sudo` is data, not a privileged line.
    if (wrapped) { i += 1; continue; }
    return null;
  }
  return null;
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
 * ⚠ AN INLINE `-e` BODY IS STILL SEEABLE AND STILL ALLOWED. `osascript -e 'display dialog "hi"'` runs
 * for any agent under every policy, because the phrase check can read it — refusing it would delete an
 * ordinary automation capability the owner never gave up.
 */
export function osascriptBodyIsUnseeable(operands: readonly string[]): boolean {
  // ⚠ NAMED `operands`, NOT `args`: `effects-conformance.test.ts` walks handler modules for `args.<name>`
  // to census which tool parameters are read, and `args.length` here was reported as an undeclared
  // parameter called `length`. The census is pattern-based and right to be; the collision was mine.
  let sawInline = false;
  for (let i = 0; i < operands.length; i++) {
    const o = operands[i];
    if (o === '-e' || o === '--expression') { sawInline = true; i += 1; continue; }
    if (o === '-l' || o === '--language' || o === '-s') { i += 1; continue; }
    if (o === '-' || o === '/dev/stdin' || o.startsWith('<')) return true;   // stdin or a redirect
    if (o.startsWith('-')) continue;                                         // an ordinary flag
    return true;                                                            // a FILE operand
  }
  // No operand at all: seeable if an inline body was given, and a bare `osascript` reads stdin.
  return !sawInline;
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

/** The refusal for a privilege token the grammar cannot place — fail closed by construction. */
export const SUDO_UNPLACEABLE_REASON =
  'Global deny: this line contains `sudo` (or `doas`) somewhere the permission broker cannot place — '
  + 'inside a substitution, a nested quote or a construct it does not parse. A line whose structure '
  + 'cannot be read is not run as root. Write the privileged command as its own plain line so the '
  + 'floor, your grants and the box policy can all see it.';

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
    if (SUDO_SHELL_OPTS.has(t)) {
      // `sudo -i` / `sudo -s` MAY be followed by a command; with nothing after it, it is a shell.
      const rest = tokens.slice(i + 1).join(' ');
      return rest.length === 0
        ? { inner: '', interactiveShell: true, nonInteractive, quotedOptionValue }
        : { ...parseInner(rest), nonInteractive, quotedOptionValue };
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
    if (SUDO_OPTS_WITH_VALUE.has(t)) {
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
    return { ...parseInner(commandFromOption), nonInteractive, quotedOptionValue };
  }
  const rest = tokens.slice(i).join(' ');
  // Nothing left to run: `su`, `su root`, `sudo -i` — an unbounded INTERACTIVE ROOT SHELL, refused
  // under every policy including `free`, because there is no inner command to reason about.
  if (rest.length === 0) return { inner: '', interactiveShell: true, nonInteractive, quotedOptionValue };
  return { ...parseInner(rest), nonInteractive, quotedOptionValue };
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
  if (parsed.inner.length === 0) return [];
  const out: string[] = [];
  const visit = (command: string, depth: number): void => {
    for (const seg of execSimpleCommands(command)) {
      out.push(seg);
      const body = depth < 3 ? interpreterBody(seg) : null;
      if (body !== null && body.length > 0) visit(body, depth + 1);
    }
  };
  visit(parsed.inner, 0);
  return out;
}

/** The command string an interpreter was handed, or `null` if this is not an interpreter call. */
function interpreterBody(seg: string): string | null {
  const words = commandWords(seg);
  if (!INTERPRETERS.has(bareWord(words[0] ?? '').toLowerCase())) return null;
  for (let w = 1; w < words.length; w += 1) {
    const word = words[w];
    if (word.startsWith('--command=')) return unquoteValue(word.slice('--command='.length));
    // ⚠ ANY SHORT-FLAG CLUSTER ENDING IN `c`, because `-lc` and `-ec` are the same option spelled
    // shorter and a floor that only knows `-c` is a floor with a documented spelling and an
    // undocumented one. That is precisely how the `--prompt="pw: "` bug hid.
    if (word === '--command' || /^-[a-z]*c$/i.test(word)) return unquoteValue(words[w + 1] ?? '');
  }
  return null;
}

/** One more layer, for a nested wrapper. */
function parseInner(rest: string): { inner: string; interactiveShell: boolean } {
  if (isSudoLine(rest)) {
    const again = parseSudo(rest);
    return { inner: again.inner, interactiveShell: again.interactiveShell };
  }
  return { inner: rest, interactiveShell: false };
}

/** The `blocked` refusal, VERBATIM what the floor said before this change. */
export const SUDO_BLOCKED_REASON = 'Global deny: command starting with "sudo" is prohibited';

/**
 * THE ROLE WALL (owner ruling 2026-09-27: *"ONLY the main agent gets Sudo access ever."*).
 *
 * It speaks in the FLOOR's voice — "Global deny" — and not in the policy's, because that is what it
 * is: no value of `sudo_policy` reaches this refusal, so telling a sub-agent that the policy refused
 * it would be false and would send it to the owner asking for a setting change that cannot help.
 * It names the ONE route that exists instead, which is the same courtesy every other floor refusal in
 * this tree extends: say what is impossible, then say what is possible.
 */
export const SUDO_NOT_PRIMARY_REASON =
  'Global deny: sudo is reserved to the primary agent and no permission setting changes that. This '
  + 'is a role boundary, not a grant you can be given. If the work genuinely needs administrator '
  + 'rights, hand it to the primary agent (send_to_agent) and let it decide.';

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

/** The refusal for a sudo line whose options this parser cannot read — see `authorizeSudoLine`. */
export const SUDO_UNPARSEABLE_REASON =
  'Refused: this sudo line has a quoted option value, and the permission broker cannot reliably tell '
  + 'where sudo\'s own options end and your command begins — so it will not guess. Rewrite it with the '
  + 'command plain after sudo (for example `sudo cp a b` rather than `sudo -p "…" cp a b`).';

/** The interactive-root-shell refusal — no inner command exists to authorize. */
export const SUDO_INTERACTIVE_SHELL_REASON =
  'Refused: `sudo` with no command asks for an interactive root shell, which has nothing the '
  + 'permission broker can check. Run the specific command you need through sudo instead, so the '
  + 'floor and your grants can both see it.';

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

/**
 * THE OWNER'S CARD for a held primary sudo call (`gated`).
 *
 * Plain language, engine-fixed, never model-authored — the same discipline the Healer's card states.
 * It says WHAT was asked, that nothing has happened, what declining costs (nothing), and it does NOT
 * recommend approval: an administrator command on the owner's own Mac is his call, and a card that
 * nudges is a card that gets clicked through.
 */
export function sudoOwnerCardCopy(command: string): {
  title: string; description: string; proposedFix: string; evidence: readonly string[];
} {
  return {
    title: 'Your agent wants to run an administrator command',
    description:
      'Your main agent is asking to run something as administrator (sudo) on this Mac. Nothing has '
      + 'run yet, and nothing will unless you approve it. Declining changes nothing at all. Approve it '
      + 'only if you recognise this as something you asked for — and if you would rather not be asked '
      + 'each time, Settings → Security → sudo policy has a setting for that in both directions.',
    proposedFix: `Run this as administrator: ${command}`,
    evidence: [
      'Administrator commands can change or remove anything on this Mac, so the agent pauses first.',
      'The platform\'s hard limits still apply: it cannot erase the disk or read your credentials '
      + 'file, whatever you choose here.',
    ],
  };
}

// ════════════════════════════════════════════════════════════════════════════════════════
// HONEST FAILURE — the password prompt, and the ONE command a human runs once.
//
// A non-interactive `sudo` on a box without a NOPASSWD rule does not fail: it BLOCKS on a password
// prompt nobody will ever type into, and the turn dies on a timeout with no explanation. That is
// the failure mode `gated` and `free` would otherwise ship with, and it looks like the feature is
// broken rather than unconfigured.
//
// ⚠ NO AUTOMATIC SUDOERS WRITING IN v1, by instruction and on merit: a process that edits its own
// sudoers to grant itself root is the shape every hardening guide exists to prevent, and it would
// have to run as root to do it. The platform PRINTS ONE LINE; a human runs it once.
// ════════════════════════════════════════════════════════════════════════════════════════

/** How long a probe may take before the box is treated as password-gated. */
export const SUDO_PROBE_TIMEOUT_MS = 1_500;

/**
 * The sudoers drop-in the message tells the human to install, and the scope is argued rather than
 * maximal.
 *
 * SCOPED TO THE USER, NOT TO A COMMAND LIST. A command-scoped rule (`NOPASSWD: /bin/cp`) reads
 * safer and is not: the whole point of the policy is that the agent runs the commands the OWNER's
 * box needs, which is not a list anybody can write in advance, and a half-list produces exactly the
 * silent hang this message exists to end — for the commands somebody forgot. The real boundary is
 * the one the broker enforces on every line (the floor, the sensitive-path scan, the agent's
 * grants), and `blocked` remains the setting for a box that wants no sudo at all.
 */
export function sudoersDropInLine(username: string): string {
  return `${username} ALL=(ALL) NOPASSWD: ALL`;
}

/**
 * The truthful, actionable answer when sudo would hang.
 *
 * It names WHAT happened (not a refusal — an unconfigured box), the ONE command to run, where it
 * goes, and the alternative (set the policy to `blocked`) so the reader is not cornered into
 * granting root to make a message go away.
 */
export function sudoPasswordPromptMessage(username: string, policy: SudoPolicy): string {
  return 'Refused, and this is a box-setup gap rather than a permission denial: `sudo` on this '
    + 'machine wants a password, and nothing here can type one — a non-interactive sudo would hang '
    + 'at the prompt until the turn times out, so it is not attempted.\n\n'
    + `The sudo policy is \`${policy}\`, so the command is allowed in principle. To make it actually `
    + 'work, a HUMAN runs this ONCE, by hand, in a terminal on this Mac:\n\n'
    + `    echo '${sudoersDropInLine(username)}' | sudo tee /etc/sudoers.d/dojo && sudo chmod 0440 /etc/sudoers.d/dojo\n\n`
    + 'That grants passwordless sudo to this user account. Nothing in the platform writes that file '
    + 'for you, on purpose. If you would rather not grant it, set Settings → Security → sudo policy '
    + 'to `blocked` and the agent will stop asking.';
}
