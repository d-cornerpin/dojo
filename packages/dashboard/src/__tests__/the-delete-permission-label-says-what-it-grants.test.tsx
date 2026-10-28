// ════════════════════════════════════════════════════════════════════════════
// THE DELETE LABEL SAYS WHAT IT GRANTS.
//
// The radio label is the whole of what the owner reads before ticking a
// destructive permission. In the old editor the Delete Files row offers
// "All files", but `buildOutput` writes `file_delete: ['/tmp/**']` for that
// choice — only the temporary folder. A label that overstates the grant is the
// one UI bug an owner can never take back, and the newer access panel already
// names the same option "The temporary folder" (AccessManifest). So the label
// and the bytes have to agree, in this editor too.
// ════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PermissionsEditor } from '../components/PermissionsEditor';

// Only the Delete row is switched on: `hasPath(['/tmp/**'])` is true, so its
// sub-options render; read and write are off, so their own "All files" labels
// are not drawn and the two assertions below can only be about Delete.
const onlyDeleteOn = () => (
  <PermissionsEditor
    permissions={{ file_read: [], file_write: [], file_delete: ['/tmp/**'], exec_allow: [], exec_deny: [], network_domains: 'none', max_processes: 3, can_spawn_agents: false, can_assign_permissions: false, system_control: [] }}
    onChange={() => {}}
  />
);

describe('the Delete Files row labels its all-scope with what it grants', () => {
  it('the delete all-scope option names the temporary folder, not every file', () => {
    render(onlyDeleteOn());
    expect(screen.getByText('The temporary folder')).toBeTruthy();
  });

  it('no "All files" label is drawn, because nothing here grants all files', () => {
    render(onlyDeleteOn());
    expect(screen.queryByText('All files')).toBeNull();
  });

  it('the sibling specific-scope option is still there', () => {
    render(onlyDeleteOn());
    expect(screen.getByText('Specific folders')).toBeTruthy();
  });
});
