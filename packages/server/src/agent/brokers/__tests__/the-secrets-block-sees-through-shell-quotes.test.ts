// ════════════════════════════════════════════════════════════════════════════════════════
// THE BROKER'S SECRETS BLOCK SEES THROUGH SHELL QUOTES.
//
// The owner's ruling: password and credential data stays hidden from every agent. The one hidden-file
// check on a shell line reads it as the shell will unquote it, so a path split apart with quotes or a
// backslash is still the path. Each row is a helper's command line and whether it is refused. Nothing runs.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import { SENSITIVE_LOCATIONS, isSensitivePath, shellLineNamesHidden } from '../deny.js';
import path from 'node:path';
import { homeDir } from '../../../home.js';

const refused = (line: string): boolean => shellLineNamesHidden(line, 'other') !== null;

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
  // ── a search pattern is not a file: a bare word names a file only where the working directory holds one ──
  { line: 'grep -rn ".env" ~/project', want: false, why: 'the grep pattern is text to search for' },
  { line: 'rg ".env" ~/project', want: false, why: 'the rg pattern' },
  { line: 'cat package.json | grep ".env"', want: false, why: 'a pattern on piped input, no file at all' },
  { line: 'grep "id_rsa" ~/notes.txt', want: false, why: 'a pattern that is a key file name' },
  { line: 'grep id_rsa notes.txt', want: false, why: 'the same, unquoted' },
  { line: 'grep -e "id_rsa" ~/notes.txt', want: false, why: 'the pattern given with -e' },
  { line: 'grep --regexp=id_rsa ~/notes.txt', want: false, why: 'the pattern given with --regexp=' },
  { line: 'egrep -i -A 2 "id_rsa|.env" ~/notes.txt', want: false, why: 'the pattern after options' },
  { line: 'sed -n "/id_rsa/p" ~/notes.txt', want: false, why: 'the sed script is not a file' },
  { line: "awk -v n=1 '/id_rsa/ {print}' ~/notes.txt", want: false, why: 'awk -v takes a value before the program' },
  { line: "awk '/id_rsa/ {print}' ~/notes.txt", want: false, why: 'the awk program is not a file' },
  { line: 'echo credentials', want: false, why: 'a word, not a file' },
  { line: 'git log -- .npmrc', want: false, why: 'a file name with no file here' },
  { line: 'grep "~/.ssh/config" ~/notes.txt', want: true, why: 'a pattern spelled as a hidden path is read as that path' },
  // ── a word naming a hidden location, and folders above one ──
  { line: 'grep -r . ~/.ssh', want: true, why: 'a recursive grep of the key folder' },
  { line: 'grep -rn x ~/.ssh/', want: true, why: 'the folder with a trailing slash' },
  { line: 'rg -e . ~/.ssh', want: true, why: 'rg reads folders recursively' },
  { line: 'grep -R token ~/.dojo', want: false, why: 'a folder above a hidden file: what it prints is blanked' },
  { line: 'grep -r token ~', want: false, why: 'the home folder, above the key folder' },
  { line: 'rg token ~/.config/gcloud', want: true, why: 'the cloud credentials folder itself' },
  { line: 'cp -r ~/.ssh /tmp/k', want: true, why: 'a recursive copy of the key folder' },
  // ── controls ──
  { line: 'ls ~/.ssh', want: true, why: 'a helper does not name the key folder' },
  { line: `python3 -c "print(open('~/.ssh/id_rsa').read())"`, want: true, why: 'a path inside a script\'s text' },
  { line: 'cat ~/.ssh/id_rsa.pub', want: false, why: 'the public half of a key' },
  { line: 'grep -rn TODO ~/projects/site', want: false, why: 'a recursive grep elsewhere' },
  { line: 'grep -r error ~/.dojo/logs', want: false, why: 'a folder that holds no sensitive location' },
  { line: 'grep x ~/notes.txt', want: false, why: 'a plain grep' },
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
