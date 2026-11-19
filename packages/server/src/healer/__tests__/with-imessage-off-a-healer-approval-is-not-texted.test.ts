// While iMessage is switched off in Settings, an urgent Healer approval waits in Vitals and is not texted:
// being reachable by iMessage asks the switch, not whether an approved sender is on file.
import { describe, it, expect, vi, beforeAll } from 'vitest';

const runMock = vi.hoisted(() => vi.fn(async (_program: string, _argv: readonly string[]) => ''));
vi.mock('../../services/imessage-run.js', async (orig) => ({
  ...(await orig<typeof import('../../services/imessage-run.js')>()),
  getImsgPath: () => null,
  runMessagesProgram: runMock,
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => undefined, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../db/migrations.js';
import { getDb } from '../../db/connection.js';
import { fileHealerApprovalProposal } from '../approval-routing.js';

const OWNER = '+15550100198';
const setConfig = (key: string, value: string) =>
  getDb().prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run(key, value);

beforeAll(() => {
  runMigrations();
  setConfig('imessage_approved_senders', JSON.stringify([{ address: OWNER, name: 'Owner', is_primary: true, sharing_level: 'open_book' }]));
  setConfig('user_presence', 'away');
  setConfig('imessage_enabled', 'false');
});

describe('with iMessage switched off', () => {
  it('an urgent Healer approval waits in Vitals and is not texted', async () => {
    const out = await fileHealerApprovalProposal({
      agentId: 'healer', agentName: 'Healer', toolName: 'exec', signature: 'sig-1', kind: 'command',
      heldDirectDestructiveCall: true, engineSeverity: 'critical', argsJson: JSON.stringify({ command: 'rm -rf ~/old-files' }),
    });
    expect(out.surface).toBe('vitals');
    expect(runMock).not.toHaveBeenCalled();
  });
});
