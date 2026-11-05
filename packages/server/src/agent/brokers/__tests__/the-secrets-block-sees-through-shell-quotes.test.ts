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
import { commandReadsSensitiveFile, globalExecDenyPublic } from '../proc.js';

const refused = (line: string): boolean => globalExecDenyPublic(line) !== null || commandReadsSensitiveFile(line).blocked;

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
