// The urgency of a held Healer change comes from the held call itself: a log-file cleanup stays on the
// dashboard, while a call touching the Dojo's data or naming an agent in error or paused reaches the owner.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('../../work/done/__tests__/helpers/done-db.js')).connectionMock());
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => undefined, stampPersistedRow: (e: unknown) => e }));
const presence = vi.hoisted(() => ({ away: false }));
vi.mock('../../services/presence.js', () => ({ getPresence: () => (presence.away ? 'away' : 'in_dojo'), isImessageEnabled: () => presence.away }));
const texts = vi.hoisted(() => ({ sent: [] as string[] }));
vi.mock('../../services/imessage-bridge.js', () => ({
  getDefaultSender: () => 'owner-number',
  sendIMessage: async (_to: string, text: string) => { texts.sent.push(text); return true; },
}));
vi.mock('../../agent/dojo-voice.js', () => ({ tellAgentWhatDojoSent: () => undefined }));

const { runMigrations } = await import('../../db/migrations.js');
const { freshDoneDb, doneDb } = await import('../../work/done/__tests__/helpers/done-db.js');
const { fileHealerApprovalProposal, heldActionSeverity } = await import('../approval-routing.js');
const { canonicalToolSignature } = await import('../../agent/v2/classifiers/loop.js');

beforeEach(() => {
  freshDoneDb();
  runMigrations();
  presence.away = false;
  texts.sent = [];
});

describe('a held Healer call decides its own urgency', () => {
  it('a log file cleanup is routine', () => {
    expect(heldActionSeverity(JSON.stringify({ argv: ['rm', '/Users/example/.dojo/logs/old.log'] }))).toBe('warning');
  });

  it('a change to the Dojo database is critical', () => {
    expect(heldActionSeverity(JSON.stringify({ script: 'sqlite3 ~/.dojo/data/dojo.db "DELETE FROM messages WHERE id = 1"' }))).toBe('critical');
  });

  it('a call naming a paused agent is critical, the same call naming an idle one is not', () => {
    doneDb().prepare("INSERT INTO agents (id, name, status, config) VALUES ('agent-broken', 'broken one', 'paused', '{}')").run();
    const call = JSON.stringify({ argv: ['rm', '-rf', '/Users/example/work/agent-broken/scratch'] });
    expect(heldActionSeverity(call)).toBe('critical');
    doneDb().prepare("UPDATE agents SET status = 'idle' WHERE id = 'agent-broken'").run();
    expect(heldActionSeverity(call)).toBe('warning');
  });

  it('an unreadable call is routine', () => {
    expect(heldActionSeverity('not json')).toBe('warning');
  });

  it('with the owner away, a held log cleanup stays on the dashboard and texts nothing', async () => {
    presence.away = true;
    const args = { argv: ['rm', '/Users/example/.dojo/logs/old.log'] };
    const held = await fileHealerApprovalProposal({
      agentId: 'healer',
      agentName: 'Healer',
      toolName: 'exec',
      signature: canonicalToolSignature('exec', args),
      kind: 'destructive shell command',
      heldDirectDestructiveCall: true,
      engineSeverity: heldActionSeverity(JSON.stringify(args)),
      argsJson: JSON.stringify(args),
    });
    expect(held.surface).toBe('vitals');
    expect(texts.sent).toHaveLength(0);
  });
});
