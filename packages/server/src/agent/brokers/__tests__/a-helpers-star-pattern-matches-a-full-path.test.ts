// A folder the owner grants a helper as `folder/*` covers everything under it, however deep, and a command
// granted as `*/bin/tool` covers that tool by its full path.
import { describe, it, expect, vi } from 'vitest';
import type { PermissionManifest } from '@dojo/shared';

vi.mock('../../squad-workspace.js', () => ({ hasSquadWorkspaceAccess: () => false }));
vi.mock('../../../config/platform.js', () => ({ isTrainerAgent: () => false, isPrimaryAgent: () => false, isHealerAgent: () => false }));

import { grantForManifest } from '../grants.js';
import { authorizeFs } from '../fs.js';
import { authorizeProc } from '../proc.js';
import { resolvePathArg, resolveCommandArg } from '../resolve.js';

const manifest: PermissionManifest = {
  file_read: ['/Users/example/project/*'], file_write: [], exec_allow: ['*/bin/tool'], exec_deny: [],
  network_domains: 'none', can_spawn_agents: false, can_assign_permissions: false, system_control: [],
} as PermissionManifest;
const grant = grantForManifest('helper', manifest);

const reads = (raw: string) => {
  const p = resolvePathArg(raw);
  if (!p.ok) throw new Error(raw);
  return authorizeFs(grant, 'fs_read', p.value).allowed;
};
const runs = (raw: string) => {
  const c = resolveCommandArg(raw);
  if (!c.ok) throw new Error(raw);
  return authorizeProc(grant, c.value).allowed;
};

describe('a helper\'s star pattern matches a full path', () => {
  it('a folder star covers files several folders down, and nothing outside the folder', () => {
    expect(reads('/Users/example/project/notes.txt')).toBe(true);
    expect(reads('/Users/example/project/src/app/main.ts')).toBe(true);
    expect(reads('/Users/example/other/notes.txt')).toBe(false);
  });

  it('a command star covers the tool by its full path', () => {
    expect(runs('/usr/local/bin/tool --version')).toBe(true);
    expect(runs('/usr/local/bin/other')).toBe(false);
  });
});
