// ════════════════════════════════════════════════════════════════════════════════════════
// THE BROKER'S SECRETS BLOCK SEES THROUGH SHELL QUOTES (field fix 3, re-review 4).
//
// The owner's ruling: password and credential data stays hidden from every agent. The broker's
// sensitive-path checks (`proc.ts`: the secrets.yaml substring and the sensitive-file reader scan)
// read the line as typed, so a path split apart with quotes or a backslash, which the shell joins
// back into the same path, was not seen. Both checks now also read the line as the shell will
// unquote it, through the one lexer the database door uses (`shell-words.ts`).
//
// Each row is a command string and whether the broker's sensitive checks refuse it. Nothing runs.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import { commandReadsSensitiveFile, globalExecDeny } from '../proc.js';
import { SENSITIVE_LOCATIONS, isSensitivePath } from '../deny.js';
import path from 'node:path';
import { homeDir } from '../../../home.js';

const refused = (line: string): boolean => globalExecDeny(line) !== null || commandReadsSensitiveFile(line).blocked;

const ROWS: Array<{ line: string; want: boolean; why: string }> = [
  // ── controls: the plain forms, refused before and after ──
  { line: 'cat ~/.dojo/secrets.yaml', want: true, why: 'the plain secrets file' },
  { line: 'cat ~/.ssh/id_rsa', want: true, why: 'the plain key file' },
  // ── the quote-split forms ──
  { line: "cat ~/.dojo/secr''ets.yaml", want: true, why: 'an empty quote pair inside the name' },
  { line: 'cat ~/.dojo/"secrets".yaml', want: true, why: 'part of the name double-quoted' },
  { line: "cat ~/.dojo/'secrets.yaml'", want: true, why: 'the name single-quoted' },
  { line: 'cat ~/.dojo/secr\\ets.yaml', want: true, why: 'a backslash inside the name' },
  { line: "cat ~/.ssh/id''_rsa", want: true, why: 'the key file split by a quote pair' },
  { line: 'head -5 ~/.ss"h"/id_rsa', want: true, why: 'the folder split by quotes' },
  { line: "ls /tmp; cat ~/.ssh/'id_rsa'", want: true, why: 'a quoted name in a later segment' },
  // ── re-review 5 P2: a search PATTERN or an edit SCRIPT is not a file the command reads ──
  { line: 'grep -rn ".env" ~/project', want: false, why: 'the grep pattern is text to search for' },
  { line: 'rg ".env" ~/project', want: false, why: 'the rg pattern' },
  { line: 'cat package.json | grep ".env"', want: false, why: 'a pattern on piped input, no file at all' },
  { line: 'grep "~/.ssh/config" ~/notes.txt', want: false, why: 'a pattern that looks like a path' },
  { line: 'grep "id_rsa" ~/notes.txt', want: false, why: 'a pattern that is a key file name' },
  { line: 'grep -e "id_rsa" ~/notes.txt', want: false, why: 'the pattern given with -e' },
  { line: 'grep --regexp=id_rsa ~/notes.txt', want: false, why: 'the pattern given with --regexp=' },
  { line: 'egrep -i -A 2 "id_rsa|.env" ~/notes.txt', want: false, why: 'the pattern after options' },
  { line: 'sed -n "/id_rsa/p" ~/notes.txt', want: false, why: 'the sed script is not a file' },
  { line: 'grep -A 3 id_rsa ~/notes.txt', want: false, why: 'an option value (-A 3) is not the pattern' },
  { line: "awk -v n=1 '/id_rsa/ {print}' ~/notes.txt", want: false, why: 'awk -v takes a value before the program' },
  { line: "awk '/id_rsa/ {print}' ~/notes.txt", want: false, why: 'the awk program is not a file' },
  // ── the FILE arguments are still read, so these stay refused ──
  { line: 'grep foo ~/.ssh/id_rsa', want: true, why: 'the file grep reads is the key file' },
  { line: 'grep ".env" ~/.dojo/secrets.yaml', want: true, why: 'the file is the secrets file' },
  { line: 'grep -e foo ~/.ssh/id_rsa', want: true, why: 'with -e, every operand is a file' },
  { line: 'grep -f ~/.ssh/id_rsa ~/notes.txt', want: true, why: 'a -f pattern FILE is read too' },
  { line: 'rg foo ~/.ssh/id_rsa', want: true, why: 'the rg file operand' },
  { line: 'sed -n 1p ~/.ssh/id_rsa', want: true, why: 'the sed file operand' },
  { line: 'awk 1 ~/.ssh/id_rsa', want: true, why: 'the awk file operand' },
  { line: 'cat ~/.ssh/id_rsa | grep foo', want: true, why: 'cat still reads the key file' },
  // ── re-review 6 Q1: an option the scan does not know exactly (a long-name prefix) means every word is scanned ──
  { line: 'grep --regex=. ~/.ssh/id_rsa', want: true, why: 'a prefix of --regexp is not a known option, so the key file is scanned' },
  { line: 'grep --reg=. ~/.ssh/id_rsa', want: true, why: 'a shorter prefix' },
  { line: 'grep --rege=. ~/project/.env', want: true, why: 'a prefix, and a dotenv file' },
  { line: 'egrep --regex=. ~/.ssh/id_ed25519', want: true, why: 'egrep, the same' },
  { line: 'grep --regex . ~/.ssh/id_rsa', want: true, why: 'a prefix with its value as the next word' },
  { line: 'sed -i p ~/.ssh/id_rsa', want: true, why: 'sed -i takes a value on one system and not on another, so every word is scanned' },
  { line: 'awk --source=1 ~/.ssh/id_rsa', want: true, why: 'an awk long option the scan does not know' },
  // ── re-review 6: a recursive read of a sensitive folder, or of a folder that contains one ──
  { line: 'grep -r . ~/.ssh', want: true, why: 'a recursive grep of the key folder' },
  { line: 'grep -rn x ~/.ssh/', want: true, why: 'the folder with a trailing slash' },
  { line: 'rg -e . ~/.ssh', want: true, why: 'rg reads folders recursively' },
  { line: 'rg --files ~/.ssh', want: true, why: 'rg over the key folder' },
  { line: 'grep -R token ~/.dojo', want: true, why: 'the Dojo folder holds the secrets file' },
  { line: 'grep -r token ~', want: true, why: 'the home folder holds the key folder' },
  { line: 'rg token ~/.config', want: true, why: 'a folder that holds the cloud credentials folder' },
  { line: 'cp -r ~/.ssh /tmp/k', want: true, why: 'a recursive copy of the key folder' },
  { line: 'grep --recur x ~/.ssh', want: true, why: 'an option prefix counts as recursive' },
  // ── controls ──
  { line: 'ls ~/.ssh', want: false, why: 'a listing of the folder, not its contents' },
  { line: 'ls -la ~/.ssh', want: false, why: 'the same' },
  { line: 'cat ~/.ssh/id_rsa.pub', want: false, why: 'the public half of a key' },
  { line: 'grep -rn TODO ~/projects/site', want: false, why: 'a recursive grep elsewhere' },
  { line: 'grep -r error ~/.dojo/logs', want: false, why: 'a folder that holds no sensitive location' },
  { line: 'grep x ~/notes.txt', want: false, why: 'a plain grep' },
  { line: 'cp notes.txt ~/', want: false, why: 'the home folder as a copy destination is written, not read' },
  { line: 'grep --ignore-case --line-number "id_rsa" ~/notes.txt', want: false, why: 'exact known long options still let the pattern be text' },
  // ── nothing else changes ──
  { line: 'cat ~/notes.txt', want: false, why: 'an ordinary file' },
  { line: "grep 'error' ~/.dojo/logs/dojo.log", want: false, why: 'a quoted pattern on the platform log' },
  { line: "echo 'hello world'", want: false, why: 'quoted data' },
];

describe('the broker\'s secrets block reads the line as the shell will unquote it', () => {
  it.each(ROWS)('$line', ({ line, want, why }) => {
    expect(refused(line), why).toBe(want);
  });
});

describe('every fixed sensitive location is on the sensitive list, itself or its contents', () => {
  it.each(SENSITIVE_LOCATIONS)('%s', (rel) => {
    const abs = path.join(homeDir(), rel);
    expect(isSensitivePath(abs) || isSensitivePath(path.join(abs, 'x'))).toBe(true);
  });
});
