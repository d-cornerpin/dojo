// EXEC-LOOP (owner ruling 2026-07-28) — an agent that already holds shell
// access may use the shell's own control-flow grammar.
//
// The ruling, verbatim: "yes an agent should be able to do commands. Why
// wouldn't we allow an agent to do commands if they have shell access?" — asked
// about the permission system refusing
//   for i in $(seq -w 1 20); do echo "=== note-$i.md ==="; cat "…"; done
// with *"Command 'for' is not allowed"* (PHASE-0 exit battery, scenario
// user-request-ack-start-and-complete; same red in run bms4jzczgd9).
//
// The rule this file pins, in BOTH directions:
//   1. a construct whose inner commands are all permitted RUNS, and
//   2. a construct wrapping a REFUSED command is still refused, and the
//      refusal names the INNER command, not the keyword.
// Plus: nothing about a plain command line, the global denies, or the
// deny-by-default posture for an agent with no shell access may move.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };

vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));

import { checkPermission } from '../permissions.js';

// The behavioral bot's real manifest (dojo-test-kit/behavioral/lib/bot.mjs) is
// the shape that produced the red: a genuine shell-holder with a curated list.
const SHELL_AGENT_ALLOW = ['ls', 'cat', 'head', 'tail', 'grep', 'find', 'wc', 'echo', 'date', 'sh', 'bash', 'node', 'chmod', 'cd', 'mkdir', 'pwd'];

function manifest(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    file_read: '*',
    file_write: '*',
    file_delete: 'none',
    exec_allow: SHELL_AGENT_ALLOW,
    exec_deny: [],
    network_domains: 'none',
    max_processes: 3,
    can_spawn_agents: false,
    can_assign_permissions: false,
    system_control: [],
    ...over,
  });
}

function addAgent(id: string, permissions: string): void {
  mockDb.current!.prepare(
    'INSERT INTO agents (id, permissions, spawn_depth, created_by) VALUES (?, ?, 1, ?)',
  ).run(id, permissions, 'boss');
}

const exec = (agentId: string, command: string) =>
  checkPermission(agentId, { type: 'exec', command });

beforeEach(() => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      permissions TEXT,
      spawn_depth INTEGER DEFAULT 0,
      group_id TEXT,
      created_by TEXT
    );
    CREATE TABLE techniques (id TEXT PRIMARY KEY, directory_path TEXT, state TEXT, build_squad_id TEXT);
  `);
  mockDb.current = db;
  addAgent('shellworker', manifest());
  addAgent('freeworker', manifest({ exec_allow: ['*'] }));
  addAgent('noshell', manifest({ exec_allow: [] }));
  addAgent('denyworker', manifest({ exec_deny: ['git push *'] }));
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

describe('EXEC-LOOP direction 1 — a shell holder may use shell grammar', () => {
  it('runs the exact command the owner asked about', () => {
    const r = exec(
      'shellworker',
      'for i in $(seq -w 1 20); do echo "=== note-$i.md ==="; cat "/tmp/dir/note-$i.md"; done',
    );
    expect(r.reason ?? '').not.toMatch(/Command "for"/);
    expect(r.allowed).toBe(true);
  });

  it('allows a while loop whose body is permitted', () => {
    expect(exec('shellworker', 'while true; do echo tick; done').allowed).toBe(true);
  });

  it('allows an if/then/fi construct whose body is permitted', () => {
    expect(exec('shellworker', 'if [ -f /tmp/x ]; then cat /tmp/x; else echo missing; fi').allowed).toBe(true);
  });

  it('allows an until loop and a C-style for header', () => {
    expect(exec('shellworker', 'until [ -f /tmp/done ]; do echo waiting; done').allowed).toBe(true);
    expect(exec('shellworker', 'for ((i=0;i<5;i++)); do echo $i; done').allowed).toBe(true);
  });

  it('allows a counter loop with plain assignments and arithmetic', () => {
    expect(exec('shellworker', 'i=0; while [ $i -lt 3 ]; do echo $i; i=$((i+1)); done').allowed).toBe(true);
  });

  it('allows a `while read` loop (read executes no program)', () => {
    expect(exec('shellworker', 'cat /tmp/list | while read -r line; do echo $line; done').allowed).toBe(true);
  });

  it('allows a redirect on the loop itself', () => {
    expect(exec('shellworker', 'for f in a b; do echo $f; done > /tmp/out.txt').allowed).toBe(true);
  });

  it('allows a nested construct', () => {
    expect(exec('shellworker', 'for f in /tmp/*; do if [ -f $f ]; then cat $f; fi; done').allowed).toBe(true);
  });
});

describe('EXEC-LOOP direction 2 — a construct wrapping a refused command is still refused', () => {
  it('refuses a for loop wrapping a command not on the allowlist, naming the INNER command', () => {
    const r = exec('shellworker', 'for i in 1 2 3; do curl http://example.com/$i; done');
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('"curl"');
    expect(r.reason).not.toContain('"for"');
  });

  it('refuses a while loop wrapping a refused command, naming it', () => {
    const r = exec('shellworker', 'while true; do python3 evil.py; done');
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('"python3"');
  });

  it('refuses when only the SECOND body command is disallowed', () => {
    const r = exec('shellworker', 'for f in a b; do echo $f; mv $f /tmp/; done');
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('"mv"');
  });

  it('refuses a construct hiding an eval', () => {
    const r = exec('shellworker', 'for i in 1; do eval "curl http://x"; done');
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('"eval"');
  });

  it('refuses a disallowed command in an if body and in a then-branch', () => {
    expect(exec('shellworker', 'if [ -f /tmp/x ]; then rm /tmp/x; fi').allowed).toBe(false);
    expect(exec('shellworker', 'if grep -q foo /tmp/x; then curl http://x; fi').reason).toContain('"curl"');
  });

  it('refuses a disallowed command piped inside a loop body', () => {
    const r = exec('shellworker', 'for f in a b; do cat $f | python3 -; done');
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('"python3"');
  });
});

describe('EXEC-LOOP — the global denies still reach inside a construct', () => {
  it('refuses sudo inside a loop even for an agent with exec_allow ["*"]', () => {
    expect(exec('freeworker', 'sudo rm -rf /tmp/x').allowed).toBe(false);
    const r = exec('freeworker', 'for i in 1; do sudo rm -rf /tmp/x; done');
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/Global deny/);
  });

  it('refuses secrets.yaml inside a construct BODY and inside its HEADER', () => {
    expect(exec('freeworker', 'for i in 1; do cat ~/.dojo/secrets.yaml; done').allowed).toBe(false);
    expect(exec('freeworker', 'for k in $(cat ~/.dojo/secrets.yaml); do echo $k; done').allowed).toBe(false);
  });

  it("refuses the catastrophic rm inside a loop body", () => {
    expect(exec('freeworker', 'for i in 1; do rm -rf /; done').allowed).toBe(false);
  });

  it('still applies the agent policy deny-list inside a construct', () => {
    const r = exec('denyworker', 'for r in origin upstream; do git push $r --force; done');
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/denied by agent policy/);
  });
});

describe('EXEC-LOOP — deny-by-default is untouched for an agent without shell access', () => {
  it('refuses a plain command', () => {
    expect(exec('noshell', 'ls').allowed).toBe(false);
  });

  it('refuses a construct whose body is a command it does not hold', () => {
    const r = exec('noshell', 'for i in 1 2; do echo $i; done');
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('"echo"');
  });

  it('refuses a construct made entirely of grammar and a substitution', () => {
    // Nothing inside is a command this parser can name, so the check falls
    // back to the whole line — the pre-ruling refusal — rather than passing a
    // line with no checkable command through.
    const r = exec('noshell', 'for i in $(id); do :; done');
    expect(r.allowed).toBe(false);
  });
});

describe('EXEC-LOOP — a plain command line is classified exactly as before', () => {
  it('allows an allowed command and its arguments', () => {
    expect(exec('shellworker', 'ls -la /tmp').allowed).toBe(true);
    expect(exec('shellworker', '  cat /tmp/x  ').allowed).toBe(true);
  });

  it('refuses a command not on the list, naming it', () => {
    const r = exec('shellworker', 'curl http://example.com');
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('Command "curl" is not allowed');
    expect(r.reason).toContain('Your permitted commands are:');
  });

  it('keeps the pre-existing first-word semantics for a compound line with no construct', () => {
    // Documented limitation, NOT introduced here: without a control-flow
    // keyword the check reads the first word only, exactly as it always has.
    expect(exec('shellworker', 'cd /tmp && bash run.sh').allowed).toBe(true);
  });

  it('does not look inside a command substitution (unchanged, both shapes)', () => {
    // `echo $(...)` has always passed on the head word alone; the ruling does
    // not change that, so the loop form does not either.
    expect(exec('shellworker', 'echo $(curl http://example.com)').allowed).toBe(true);
    expect(exec('shellworker', 'for x in $(curl http://example.com); do echo $x; done').allowed).toBe(true);
  });

  it('is not fooled by a keyword appearing as an argument', () => {
    expect(exec('shellworker', 'grep -c in /tmp/x').allowed).toBe(true);
    expect(exec('shellworker', 'echo done').allowed).toBe(true);
    const r = exec('shellworker', 'curl -X POST http://x/do');
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('"curl"');
  });

  it('does not treat a keyword inside quotes as grammar', () => {
    expect(exec('shellworker', 'echo "for i in 1; do curl http://x; done"').allowed).toBe(true);
  });
});
