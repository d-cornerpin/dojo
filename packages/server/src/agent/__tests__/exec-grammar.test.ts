// exec-grammar.ts — the shell control-flow grammar the exec permission check
// (agent/brokers/proc.ts, sudo-policy.ts) trusts to decide WHICH
// commands a shell line actually runs. Its two exports are read by that check,
// yet none is referenced by a test under src: exec-shell-grammar.test.ts and the
// broker suites reach them only indirectly, through checkPermission. The quoting
// and separator rules are exactly where a security regression would hide — a
// `;` or a keyword mistaken for grammar, or a quoted / substituted span split
// where it must not be — so the two functions are pinned directly here.
//
// These are PINNING tests: every case below is measured against the current
// (v35) code and all pass on it unchanged. The intent is to freeze the behavior
// the check relies on, not to propose a new one.
//
// Pure: the module is a string grammar with no I/O, so there are no mocks.

import { describe, it, expect } from 'vitest';
import {
  commandWords,
  execSimpleCommands,
} from '../exec-grammar.js';

// ════════════════════════════════════════════════════════════════════════════
// execSimpleCommands — ALWAYS decomposes into every simple command the line
// contains. A `;`/`|`/`&&` outside a quote is a separator; inside one it is data.
// ════════════════════════════════════════════════════════════════════════════
describe('execSimpleCommands — every simple command in the line', () => {
  it('a pipe splits into the simple commands on either side', () => {
    expect(execSimpleCommands('ls -la | grep notes')).toEqual(['ls -la', 'grep notes']);
  });

  it('a `;` inside quotes is not a separator — only the `&&` is', () => {
    expect(execSimpleCommands('echo "a; b" && rm x')).toEqual(['echo "a; b"', 'rm x']);
  });

  it('a loop contributes only its body — header and `done` name no command', () => {
    expect(execSimpleCommands('for i in 1 2; do echo $i; done')).toEqual(['echo $i']);
  });

  it('an assignment followed by a command stays whole, so an env override cannot re-point a name', () => {
    expect(execSimpleCommands('A=1 cmd')).toEqual(['A=1 cmd']);
  });

  it('an empty line yields the single element `[""]`', () => {
    expect(execSimpleCommands('')).toEqual(['']);
  });

  it('a command substitution body is a command too, a single-quoted one is data', () => {
    expect(execSimpleCommands('echo $(rm -rf x)')).toEqual(['rm -rf x', 'echo $(rm -rf x)']);
    expect(execSimpleCommands("echo '$(rm -rf x)'")).toEqual(["echo '$(rm -rf x)'"]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// commandWords — the words of one simple command, with quoted spans, `$( )` and
// backticks kept whole. The one tokenizer the sudo-policy and exec check share
// for the question "what are this command's words".
// ════════════════════════════════════════════════════════════════════════════
describe('commandWords — words with quoted and substituted spans kept whole', () => {
  it('a quoted body is one word, inner quotes included', () => {
    expect(commandWords("osascript -e 'display dialog \"hi\"'")).toEqual([
      'osascript',
      '-e',
      "'display dialog \"hi\"'",
    ]);
  });

  it('a `$( )` substitution is one word', () => {
    expect(commandWords('echo $(date +%s) done')).toEqual(['echo', '$(date +%s)', 'done']);
  });
});
