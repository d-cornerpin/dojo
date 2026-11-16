// A helper granted `sqlite3 *` runs sqlite3 on a file named by its absolute path, on the argv door and the
// shell door alike: a command pattern's `*` spans any text, slashes included. A program named by its own
// absolute path matches a pattern that names that path; a bare program name matches only the bare name.
import { describe, it, expect, vi } from 'vitest';
import type { PermissionManifest } from '@dojo/shared';

vi.mock('../../squad-workspace.js', () => ({ hasSquadWorkspaceAccess: () => false }));
vi.mock('../../../config/platform.js', () => ({ isTrainerAgent: () => false, isPrimaryAgent: () => false, isHealerAgent: () => false }));

import { grantForManifest } from '../grants.js';
import { authorizeArgv, authorizeProc } from '../proc.js';
import { resolveArgvArg, resolveCommandArg } from '../resolve.js';

const helper = (allow: string[]) => grantForManifest('helper', {
  file_read: [], file_write: [], exec_allow: allow, exec_deny: [], shell_allow: allow, shell_deny: [],
  network_domains: 'none', can_spawn_agents: false, can_assign_permissions: false, system_control: [],
} as PermissionManifest);

const argvRuns = (allow: string[], argv: string[]) => {
  const r = resolveArgvArg(argv);
  if (!r.ok) throw new Error(argv.join(' '));
  return authorizeArgv(helper(allow), r.value).allowed;
};
const shellRuns = (allow: string[], line: string) => {
  const r = resolveCommandArg(line);
  if (!r.ok) throw new Error(line);
  return authorizeProc(helper(allow), r.value).allowed;
};

describe('a helper\'s command pattern covers an absolute path', () => {
  it('`sqlite3 *` runs on a file named by its absolute path, on both doors', () => {
    expect(argvRuns(['sqlite3 *'], ['sqlite3', '/Users/example/data/app.db', 'select 1'])).toBe(true);
    expect(shellRuns(['sqlite3 *'], 'sqlite3 /Users/example/data/app.db "select 1"')).toBe(true);
    expect(shellRuns(['sqlite3 *'], 'curl https://example.com/x')).toBe(false);
  });

  it('a program named by its absolute path matches a pattern that names that path', () => {
    expect(argvRuns(['/usr/bin/sqlite3 *'], ['/usr/bin/sqlite3', '/Users/example/data/app.db', 'select 1'])).toBe(true);
    expect(shellRuns(['/usr/bin/sqlite3 *'], '/usr/bin/sqlite3 /Users/example/data/app.db "select 1"')).toBe(true);
    expect(shellRuns(['*/bin/tool'], '/usr/local/bin/tool')).toBe(true);
    // The pattern is matched on the line or its first word as written, so a bare name does not cover a path.
    expect(shellRuns(['sqlite3 *'], '/usr/bin/sqlite3 /tmp/a.db "select 1"')).toBe(false);
  });
});
