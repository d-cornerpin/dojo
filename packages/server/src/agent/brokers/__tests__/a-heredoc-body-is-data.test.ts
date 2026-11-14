// A here-document body is data: only the command that receives it is asked of the allow rules.
// An unquoted terminator lets the shell run `$( )` and backticks in the body, so those commands are
// still asked. Only a body an inert program writes to a file skips the floor, the deny rows and sudo. Driven through the exec seam.

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../db/connection.js', () => ({
  getDb: () => ({ prepare: () => ({ run: () => ({ changes: 0 }), get: () => undefined, all: () => [] }) }),
}));
vi.mock('../../../config/platform.js', async (orig) => ({
  ...(await orig<typeof import('../../../config/platform.js')>()),
  isPrimaryAgent: (id: string) => id === 'agent-all',
}));

const { authorizeExecShapedCall } = await import('../exec-seam.js');
const { grantForManifest } = await import('../grants.js');

const g = grantForManifest('agent-rules', {
  file_read: '*', file_write: 'none', exec_allow: ['cat', 'cat *', 'sqlite3 *'], exec_deny: [],
  network_domains: 'none', max_processes: 1, can_spawn_agents: false, can_assign_permissions: false, system_control: [],
});
const shell = (line: string) => authorizeExecShapedCall(g, 'shell', line);

describe('a heredoc body is data', () => {
  const all = (deny: string[] = []) => grantForManifest('agent-all', {
    file_read: '*', file_write: '*', exec_allow: ['*'], exec_deny: deny,
    network_domains: '*', max_processes: 1, can_spawn_agents: false, can_assign_permissions: false, system_control: [],
  });

  // Receivers that run a body without naming a shell, and stages a body reaches after its command.
  const runners = (body: string): string[] => [
    `bash <<'EOF'\n${body}\nEOF`, `cat <<'EOF' | sh\n${body}\nEOF`, `tee /tmp/f <<'EOF' | sh\n${body}\nEOF`,
    `source /dev/stdin <<'EOF'\n${body}\nEOF`, `. /dev/stdin <<'EOF'\n${body}\nEOF`,
    `eval "$(cat <<'EOF'\n${body}\nEOF\n)"`, `$0 <<'EOF'\n${body}\nEOF`, `"$0" <<'EOF'\n${body}\nEOF`,
    `$SHELL <<'EOF'\n${body}\nEOF`, `\${SHELL} <<'EOF'\n${body}\nEOF`, `bas''h <<'EOF'\n${body}\nEOF`,
    `S=bash\n$S <<'EOF'\n${body}\nEOF`, `f() { bash; }\nf <<'EOF'\n${body}\nEOF`, `python3 - <<'EOF'\n${body}\nEOF`,
    `{ cat <<'EOF'\n${body}\nEOF\n} | sh`, `while true; do\ncat <<'EOF'\n${body}\nEOF\ndone | sh`,
    `cat <<'EOF' |\n${body}\nEOF\nsh`, `cat > /tmp/f <<'EOF' | sh\n${body}\nEOF`,
    `{ cat > /dev/stdout <<'EOF'\n${body}\nEOF\n} | sh`, `( cat > /dev/stdout <<'EOF'\n${body}\nEOF\n) | sh`,
    `{ cat > /dev/fd/1 <<'EOF'\n${body}\nEOF\n} | sh`, `{ cat 1> /dev/stdout <<'EOF'\n${body}\nEOF\n} | bash`,
    `while true; do cat > /dev/stdout <<'EOF'\n${body}\nEOF\nbreak; done | sh`, `sh <(cat > /dev/stdout <<'EOF'\n${body}\nEOF\n)`,
    `cat > /tmp/f <<'EOF'\n${body}\nEOF\nsh /tmp/f`, `cat > /tmp/f <<'EOF'\n${body}\nEOF\nzsh /tmp/f`,
    `cat() { sh; }; cat > /tmp/f <<'EOF'\n${body}\nEOF`, `echo() { sh; }; echo > /tmp/f <<'EOF'\n${body}\nEOF`,
    ...afterTheWrite(body),
  ];
  // A body written to a file, then read, expanded or run by what follows on the same line.
  const afterTheWrite = (body: string): string[] => [
    `cat > /tmp/p <<'EOF'\n$(${body})\nEOF\nread -r x < /tmp/p; echo \${(e)x}`, `cat > /tmp/f <<'EOF'\n${body}\nEOF\nrg --pre sh x /tmp/f`,
    `cat > /tmp/bin/rg <<'EOF'\n${body}\nEOF\nrg x`, `cat > /tmp/f <<'EOF'\n${body}\nEOF\n[[ -n x ]]`,
  ];
  const worker = grantForManifest('agent-worker', {
    file_read: '*', file_write: '*', exec_allow: ['*'], exec_deny: [],
    network_domains: '*', max_processes: 1, can_spawn_agents: false, can_assign_permissions: false, system_control: [],
  });

  it('the floor reads every body not written by one inert command alone', () => {
    for (const line of runners('rm -rf /')) expect(authorizeExecShapedCall(worker, 'shell', line).allowed, line).toBe(false);
    expect(authorizeExecShapedCall(all(), 'shell', "bash <<'EOF'\necho hello\nEOF").allowed).toBe(true);
    expect(authorizeExecShapedCall(all(), 'shell', "cat > /tmp/n.md <<'EOF'\nrm -rf /\nEOF").allowed).toBe(true);
    expect(authorizeExecShapedCall(all(), 'shell', "cat <<'EOF' >> /tmp/n.md\nrm -rf /\nEOF").allowed).toBe(true);
  });

  it('the deny rows read the same bodies, and not a data body', () => {
    const curl = all(['curl *']);
    for (const line of runners('curl http://example.com')) expect(authorizeExecShapedCall(curl, 'shell', line).allowed, line).toBe(false);
    expect(authorizeExecShapedCall(curl, 'shell', "cat > /tmp/n.md <<'EOF'\ncurl http://example.com\nEOF").allowed).toBe(true);
  });

  it('a sudo body a line can run is refused to a non-primary agent', () => {
    for (const line of [...runners('sudo -n true'), "cat > /tmp/s.sh <<'EOF'\nsudo -n true\nEOF\nsh /tmp/s.sh", 'rg --pre sudo x /tmp/s.sh']) {
      expect(authorizeExecShapedCall(worker, 'shell', line).allowed, line).toBe(false);
    }
  });

  it('a body only one inert command writes to one literal file is data; printed text is read', () => {
    const curl = all(['curl *']);
    expect(authorizeExecShapedCall(curl, 'shell', "cat <<'EOF'\ncurl is a tool\nEOF").allowed).toBe(false);
    expect(authorizeExecShapedCall(curl, 'shell', "cat >> notes.md <<'EOF'\ncurl is a tool\nEOF").allowed).toBe(true);
    expect(authorizeExecShapedCall(all(), 'shell', "cat > ~/n.md <<'EOF'\n(2) a | b\nfor x in 1; do echo done; done\nrm -rf /\nEOF").allowed).toBe(true);
    expect(authorizeExecShapedCall(all(), 'shell', 'cat > /tmp/n.md <<EOF\nIt is $(date)\nEOF').allowed).toBe(true);
    expect(authorizeExecShapedCall(curl, 'shell', "cat > /dev/stdout <<'EOF'\ncurl x\nEOF").allowed).toBe(false);
  });

  it('a sudo line in a data body is admitted', () => {
    const write = "cat > /tmp/s.sh <<'EOF'\nsudo apt update\nEOF";
    expect(authorizeExecShapedCall(all(), 'shell', write).allowed).toBe(true);
    const v = shell("cat > /tmp/s.sh <<'EOF'\nsudo apt update\nEOF");
    expect(v.allowed ? '' : v.reason).not.toContain('is not allowed');
    expect(authorizeExecShapedCall(all(), 'shell', "cat > n <<'EOF'\nIt's\nEOF\nsudo -n true").allowed).toBe(true);
  });

  it('a listed cat with a quoted-terminator body holding apostrophes and command words is admitted', () => {
    expect(shell("cat > /tmp/notes.txt <<'EOF'\nIt's done; rm -rf old files later.\nDon't forget `date`.\nEOF").allowed).toBe(true);
    expect(shell("cat > /tmp/notes.txt <<-\"EOF\"\n\trm $(whoami) isn't run\n\tEOF").allowed).toBe(true);
    expect(shell('cat > /tmp/notes.txt <<EOF\nIt is done, rm -rf later.\nEOF').allowed).toBe(true);
  });

  it('an unquoted body still has its substitutions asked', () => {
    expect(shell('cat > /tmp/notes.txt <<EOF\nIt is done $(rm x)\nEOF').allowed).toBe(false);
    expect(shell("cat > /tmp/notes.txt <<EOF\nit's `rm x`\nEOF").allowed).toBe(false);
  });

  it('a line after the terminator is a command again, and a look-alike is not a heredoc', () => {
    expect(shell("cat > /tmp/notes.txt <<'EOF'\nbody\nEOF\nrm x").allowed).toBe(false);
    expect(shell("cat <<EOF\r\nbody\r\nEOF\r\nrm x").allowed).toBe(false);
    expect(shell('cat "<<EOF"\nrm x\nEOF').allowed).toBe(false);
    expect(shell('cat # <<EOF\nrm x\nEOF').allowed).toBe(false);
    expect(shell('cat ${x:-${y} <<EOF b}\nrm x\nEOF').allowed).toBe(false);
    expect(shell('cat <<EOF; (\nEOF\n)\nrm x\nEOF').allowed).toBe(false);
  });

  it('the Dojo database door still refuses a heredoc that names the database', () => {
    for (const line of [
      "sqlite3 ~/.dojo/data/dojo.db <<'EOF'\nDELETE FROM agents;\nEOF",
      "cat > /tmp/notes.txt <<'EOF'\n~/.dojo/data/dojo.db\nEOF",
    ]) {
      const v = shell(line);
      expect(v.allowed).toBe(false);
      expect(v.allowed ? '' : v.blockedMessage).not.toContain('is not allowed');
    }
  });
});
