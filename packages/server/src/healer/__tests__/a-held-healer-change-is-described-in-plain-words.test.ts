// A held Healer change reaches the owner in plain words: the Vitals card and the text message carry the same
// sentence about what will be done and what it affects, with no first person and no raw tool call.
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
const { fileHealerApprovalProposal, describeHeldAction } = await import('../approval-routing.js');
const { approvedProposals, approvedProposalsSection } = await import('../healer-agent.js');
const { resolveHealerProposal } = await import('../../gateway/routes/healer.js');
const { consumeApproval } = await import('../../agent/destructive-gate.js');
const { canonicalToolSignature } = await import('../../agent/v2/classifiers/loop.js');

const FIRST_PERSON = /\b(I|I'm|I've|I'll|me|my)\b/;
const RAW_CALL = /exec\(|file_write\(|[{}]|"command"|"argv"|\bscript\b/;

const hold = (toolName: string, args: Record<string, unknown>, kind: string, engineSeverity: 'critical' | null = null) =>
  fileHealerApprovalProposal({
    agentId: 'healer', agentName: 'Healer', toolName, signature: canonicalToolSignature(toolName, args), kind,
    heldDirectDestructiveCall: true, engineSeverity, argsJson: JSON.stringify(args),
  });
const card = () => doneDb().prepare('SELECT title, description, proposed_fix FROM healer_proposals').get() as { title: string; description: string; proposed_fix: string };

beforeEach(() => {
  freshDoneDb();
  runMigrations();
  presence.away = false;
  texts.sent = [];
});
const say = (tool: string, args: Record<string, unknown>) => describeHeldAction(tool, JSON.stringify(args));
const GONE = 'Deleted files do not go to the Trash and cannot be brought back.';

describe('a held Healer change', () => {
  it('names the real targets, claims file or folder only as the call says, and looks through sudo', () => {
    expect(say('exec', { argv: ['rm', '-rf', '/Users/example/Library/Application Support/Old App'] })).toBe(`Delete /Users/example/Library/Application Support/Old App and everything inside it. ${GONE}`);
    expect(say('exec', { argv: ['rm', '--recursive', '/tmp/x'] })).toBe(`Delete /tmp/x and everything inside it. ${GONE}`);
    expect(say('exec', { argv: ['rm', '/tmp/a.log', '/tmp/b.log'] })).toBe(`Delete /tmp/a.log, /tmp/b.log. ${GONE}`);
    expect(say('exec', { argv: ['sudo', '-n', 'rm', '-r', '/var/old'] })).toBe(`Delete /var/old and everything inside it. ${GONE}`);
  });

  it('a call it cannot read into parts says so plainly and shows the paths it found', () => {
    expect(say('shell', { script: 'find /Users/example/project -name "*.log" | xargs rm' })).toBe('Run a command line on this Mac that can delete or overwrite files. It touches /Users/example/project.');
    expect(say('exec', { argv: ['git', 'clean', '-fdx', '/Users/example/project'] })).toBe('Run a command on this Mac that can delete or overwrite files. It touches /Users/example/project.');
    expect(say('file_write', { path: '/Users/example/.dojo/prompts/SOUL.md', content: 'x' })).toBe('Change the file "SOUL.md" in /Users/example/.dojo/prompts. It holds an agent\'s identity or the Dojo\'s settings, and its current contents would change.');
  });

  it('stays short however many targets there are', () => expect(say('exec', { argv: ['rm', ...Array.from({ length: 40 }, (_, i) => `/tmp/long-file-name-${i}`)] }).length).toBeLessThanOrEqual(300));

  it('the card and the text carry the sentence once, plain, with no first person or raw call', async () => {
    presence.away = true;
    const { proposalId } = await hold('exec', { argv: ['rm', '/tmp/a.log'] }, 'destructive shell command', 'critical');
    const c = card();
    for (const t of [c.title, c.description, c.proposed_fix, texts.sent[0]]) {
      expect(t).not.toMatch(FIRST_PERSON);
      expect(t).not.toMatch(RAW_CALL);
    }
    expect(c.description.match(/It would:/g)).toHaveLength(1);
    expect(texts.sent[0]).toContain(c.proposed_fix);
    expect(texts.sent[0]).toContain(`yes ${proposalId.slice(0, 8)}`);
  });

  it('after the owner approves, the Healer is told the exact call, and re-running it is granted once', async () => {
    vi.useFakeTimers();
    const args = { argv: ['rm', '-rf', '/tmp/old cache'] };
    const { proposalId } = await hold('exec', args, 'destructive shell command');
    expect(resolveHealerProposal({ id: proposalId, action: 'approve' }).ok).toBe(true);
    const told = approvedProposalsSection(approvedProposals());
    expect(told).toContain(`tool exec, arguments ${JSON.stringify(args)}`);
    expect(told).not.toContain('Delete /tmp');
    const sig = canonicalToolSignature('exec', args);
    expect(consumeApproval('healer', sig, JSON.stringify(args))).toBe(true);
    expect(consumeApproval('healer', sig, JSON.stringify(args))).toBe(false);
    vi.useRealTimers();
  });
});
