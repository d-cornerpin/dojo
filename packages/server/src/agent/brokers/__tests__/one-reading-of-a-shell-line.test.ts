// The command splitter reads quotes, braces and redirects as the shell does, so no command on a line goes unseen.
import { describe, it, expect } from 'vitest';
import { execSimpleCommands } from '../../exec-grammar.js';

const heads = (line: string): string[] => execSimpleCommands(line).map((c) => c.split(/\s+/)[0]);

describe('one reading of a shell line', () => {
  it.each([
    ['an escaped redirect sign before & is a background job', 'echo \\>& touch x', ['echo', 'touch']],
    ['a quoted redirect sign before & is a background job', "echo '>'& touch x", ['echo', 'touch']],
    ['an ANSI quote reads backslash escapes', "echo $'\\''; touch x; echo 'z'", ['echo', 'touch', 'echo']],
    ['an escaped dollar does not open an ANSI quote', "echo \\$'a\\' ; touch x ; echo 'b'", ['echo', 'touch', 'echo']],
    ['a bare brace inside ${ } does not nest', 'echo ${a:-{}; touch x; echo }', ['echo', 'touch', 'echo']],
  ])('%s', (_name, line, want) => { expect(heads(line)).toEqual(want); });

  it.each([
    ['2>&1 stays a redirect', 'ls 2>&1', ['ls']],
    ['&> stays a redirect', 'ls &>out.txt', ['ls']],
    ['>| is a redirect, not a pipe', 'ls >| out.txt', ['ls']],
    ['${ } nests on ${', 'echo ${a:-${b}} ; ls', ['echo', 'ls']],
  ])('%s', (_name, line, want) => { expect(heads(line)).toEqual(want); });

  it('a heredoc body is kept for the floor and cut for the allow rules', () => {
    const line = "bash <<'EOF'\ntouch x\nEOF";
    expect(heads(line)).toEqual(['bash']);
    expect(execSimpleCommands(line, false).map((c) => c.split(/\s+/)[0])).toContain('touch');
  });
});
