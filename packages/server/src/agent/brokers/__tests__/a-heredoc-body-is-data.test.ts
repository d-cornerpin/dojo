// A here-document body is data: only the command that receives it is asked of the allow rules.
// An unquoted terminator lets the shell run `$( )` and backticks in the body, so those commands are
// still asked. Driven through the exec seam the broker uses.

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../db/connection.js', () => ({
  getDb: () => ({ prepare: () => ({ run: () => ({ changes: 0 }), get: () => undefined, all: () => [] }) }),
}));

const { authorizeExecShapedCall } = await import('../exec-seam.js');
const { grantForManifest } = await import('../grants.js');

const g = grantForManifest('agent-rules', {
  file_read: '*', file_write: 'none', file_delete: 'none', exec_allow: ['cat', 'cat *', 'sqlite3 *'], exec_deny: [],
  network_domains: 'none', max_processes: 1, can_spawn_agents: false, can_assign_permissions: false, system_control: [],
});
const shell = (line: string) => authorizeExecShapedCall(g, 'shell', line);

describe('a heredoc body is data', () => {
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
