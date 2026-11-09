// ════════════════════════════════════════════════════════════════════════════
// t189 B5: AN AGENT CAN LIST ITS OWN UPLOADS FOLDER, NOT JUST READ A FILE IN IT.
//
// The grant is `~/.dojo/uploads/<agentId>/**`, which `matchPathPattern` anchors as
// `^…/<agentId>/.*$`. It needs the trailing slash, so a file INSIDE matches and the
// directory itself does not: `file_read` of a file worked and `file_list` of the
// folder was refused (`no-grant`). The fix grants the bare directory too, on
// `file_read` only (listing is a read), for the agent's own id only. The matcher
// is deliberately NOT widened: `X/**` matching `X` would change every grant.
// ════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, vi } from 'vitest';
import type { PermissionManifest } from '@dojo/shared';

vi.mock('../squad-workspace.js', () => ({ hasSquadWorkspaceAccess: () => false }));
vi.mock('../../config/platform.js', () => ({ isTrainerAgent: () => false, isPrimaryAgent: () => false }));

import { PRIMARY_AGENT_PERMISSIONS, artifactPathFor } from '../manifest.js';
import { defaultScopeFor, defaultChildScope } from '../scope.js';
import { grantForManifest } from '../brokers/grants.js';
import { authorizeFs } from '../brokers/fs.js';
import { resolvePathArg } from '../brokers/resolve.js';

const ME = 'upload-owner';
const OTHER = 'someone-else';

function verdict(manifest: PermissionManifest, kind: 'fs_read' | 'fs_write', raw: string) {
  const resolved = resolvePathArg(raw);
  if (!resolved.ok) throw new Error(`fixture did not resolve: ${raw}`);
  return authorizeFs(grantForManifest(ME, manifest), kind, resolved.value);
}

/** `~/.dojo/uploads/<id>` — the directory itself, from the grant's own spelling. */
const dirOf = (id: string) => artifactPathFor(id).replace(/\/\*\*$/, '');

describe('t189 B5: the agent lists its own uploads directory', () => {
  const scope = defaultScopeFor(ME);

  it('file_read of a file inside is allowed (the control that always worked)', () => {
    expect(verdict(scope, 'fs_read', `${dirOf(ME)}/photo.png`).allowed).toBe(true);
  });

  it('listing (a read of) the directory itself is allowed', () => {
    const v = verdict(scope, 'fs_read', dirOf(ME));
    expect(v.allowed, v.reason ?? '').toBe(true);
  });

  it('another agent\'s uploads directory stays refused, directory and contents', () => {
    expect(verdict(scope, 'fs_read', dirOf(OTHER)).allowed).toBe(false);
    expect(verdict(scope, 'fs_read', `${dirOf(OTHER)}/x.png`).allowed).toBe(false);
  });

  it('a sibling that merely shares the prefix is not granted', () => {
    expect(verdict(scope, 'fs_read', `${dirOf(ME)}-evil`).allowed).toBe(false);
    expect(verdict(scope, 'fs_read', dirOf(ME).replace(/\/[^/]+$/, '')).allowed).toBe(false);
  });

  it('the grant is a READ grant: the bare directory is not added to file_write', () => {
    expect(verdict(scope, 'fs_write', dirOf(ME)).allowed).toBe(false);
  });

  it('a child scope inherits the same grant for its own id', () => {
    const child = defaultChildScope({ ...PRIMARY_AGENT_PERMISSIONS, file_read: ['/tmp/**'] }, ME);
    expect(verdict(child, 'fs_read', dirOf(ME)).allowed).toBe(true);
  });

  it('deny-all stays deny-all (no bare-directory grant for `none`)', () => {
    const none = defaultChildScope({ ...PRIMARY_AGENT_PERMISSIONS, file_read: 'none' }, ME);
    expect(none.file_read).toBe('none');
    expect(verdict(none, 'fs_read', dirOf(ME)).allowed).toBe(false);
  });
});
