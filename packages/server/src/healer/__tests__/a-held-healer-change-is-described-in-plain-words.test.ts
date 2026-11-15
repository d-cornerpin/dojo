// A held Healer change reaches the owner in plain words: the Vitals card and the text message carry the same
// sentence about what will be done and what it affects, with no first person and no raw tool call.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', () => ({ getDb: () => mockDb.current!, closeDb: vi.fn(), getDbPath: () => ':memory:' }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => undefined, stampPersistedRow: (e: unknown) => e }));
const presence = vi.hoisted(() => ({ away: false }));
vi.mock('../../services/presence.js', () => ({
  getPresence: () => (presence.away ? 'away' : 'in_dojo'),
  isImessageEnabled: () => presence.away,
}));
const texts = vi.hoisted(() => ({ sent: [] as string[] }));
vi.mock('../../services/imessage-bridge.js', () => ({
  getDefaultSender: () => 'owner-number',
  sendIMessage: async (_to: string, text: string) => { texts.sent.push(text); return true; },
}));
vi.mock('../../agent/dojo-voice.js', () => ({ tellAgentWhatDojoSent: () => undefined }));

const { runMigrations } = await import('../../db/migrations.js');
const { fileHealerApprovalProposal } = await import('../approval-routing.js');

const FIRST_PERSON = /\b(I|I'm|I've|I'll|me|my)\b/;
const RAW_CALL = /exec\(|file_write\(|[{}]|"command"|"argv"|\bscript\b/;

const hold = (toolName: string, args: Record<string, unknown>, kind: string, engineSeverity: 'critical' | null = null) =>
  fileHealerApprovalProposal({
    agentId: 'healer', agentName: 'Healer', toolName, signature: 'sig', kind,
    heldDirectDestructiveCall: true, engineSeverity, argsJson: JSON.stringify(args),
  });
const card = () => mockDb.current!.prepare('SELECT title, description, proposed_fix FROM healer_proposals').get() as { title: string; description: string; proposed_fix: string };

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  presence.away = false;
  texts.sent = [];
});

describe('a held Healer change', () => {
  it('a folder delete reads as what it deletes, on the card', async () => {
    await hold('exec', { argv: ['rm', '-rf', '/tmp/old-cache'] }, 'destructive shell command');
    const c = card();
    expect(c.proposed_fix).toBe('Delete the folder /tmp/old-cache and everything inside. Deleted files do not go to the Trash and cannot be brought back.');
    expect(c.description).toContain(c.proposed_fix);
    for (const t of [c.title, c.description, c.proposed_fix]) {
      expect(t).not.toMatch(FIRST_PERSON);
      expect(t).not.toMatch(RAW_CALL);
    }
  });

  it('an edit to a settings file names the file and what happens to it', async () => {
    await hold('file_write', { path: '/Users/example/.dojo/prompts/SOUL.md', content: 'x' }, 'edit to an owner identity or config file');
    expect(card().proposed_fix).toBe('Change the file "SOUL.md" in /Users/example/.dojo/prompts. It holds an agent\'s identity or the Dojo\'s settings, and its current contents would be replaced.');
  });

  it('a command it cannot read in detail still says it could delete or overwrite, without the call', async () => {
    await hold('shell', { script: 'find . -name "*.log" | xargs rm' }, 'destructive shell command');
    expect(card().proposed_fix).toBe('Run a "find" command on this Mac. It could delete or overwrite the files it touches.');
  });

  it('the text message carries the same sentence as the card, with the reply code', async () => {
    presence.away = true;
    const { proposalId } = await hold('exec', { command: 'rm /tmp/a.log' }, 'destructive shell command', 'critical');
    expect(texts.sent).toHaveLength(1);
    expect(texts.sent[0]).toContain(card().proposed_fix);
    expect(texts.sent[0]).toContain(`yes ${proposalId.slice(0, 8)}`);
    expect(texts.sent[0]).not.toMatch(FIRST_PERSON);
    expect(texts.sent[0]).not.toMatch(RAW_CALL);
  });
});
