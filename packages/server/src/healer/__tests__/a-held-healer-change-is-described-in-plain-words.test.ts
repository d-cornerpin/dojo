// A held Healer change reaches the owner in plain words: the Vitals card and the text message carry the same
// sentence about what will be done and what it affects, with no first person and no raw tool call.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import os from 'node:os';

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
  it('names the real targets, from argv or a quoted shell line, and looks through sudo', () => {
    const app = '/Users/example/Library/Application Support/Foo';
    expect(say('exec', { argv: ['rm', '-rf', app] })).toBe(`Delete ${app}, including everything inside. ${GONE}`);
    expect(say('shell', { script: `rm -rf "${app}"` })).toBe(`Delete ${app}, including everything inside. ${GONE}`);
    expect(say('exec', { argv: ['rm', '/tmp/a.log', '/tmp/b.log'] })).toBe(`Delete /tmp/a.log, /tmp/b.log. ${GONE}`);
    expect(say('exec', { argv: ['sudo', '-n', 'rm', '-r', '/var/old'] })).toBe(`Delete /var/old, including everything inside. ${GONE}`);
  });

  it('never names a target it cannot read exactly: escapes and globs stay generic, a redirect or several commands only say what they touch', () => {
    const generic = 'Run a command on this Mac that can delete or overwrite files.';
    expect(say('shell', { script: 'rm -rf /a/b\\ c' })).toBe(generic);
    expect(say('shell', { script: 'rm -rf /tmp/x/*' })).toBe(generic);
    expect(say('shell', { script: 'rm -rf /tmp/x > /dev/null' })).toBe(`${generic} It touches /tmp/x, /dev/null.`);
    expect(say('shell', { script: 'cd /a && rm -rf build' })).toBe(`${generic.replace('command', 'command line')} It touches /a.`);
    expect(say('shell', { script: 'find /Users/example/project -name "*.log" | xargs rm' })).toBe(`${generic.replace('command', 'command line')} It touches /Users/example/project.`);
    expect(say('exec', { argv: ['git', 'clean', '-fdx', '/Users/example/project'] })).toBe(`${generic} It touches /Users/example/project.`);
    expect(say('file_write', { path: '/Users/example/.dojo/prompts/SOUL.md', content: 'x' })).toBe('Change the file "SOUL.md" in /Users/example/.dojo/prompts. It holds an agent\'s identity or the Dojo\'s settings, and its current contents would change.');
  });

  it('a long list is cut by whole targets, ends with the count and keeps the warning', () => {
    const t = say('exec', { argv: ['rm', ...Array.from({ length: 40 }, (_, i) => `/tmp/long-file-name-${i}`)] });
    expect(t).toMatch(/\/tmp\/long-file-name-\d+ and \d+ more\. Deleted files do not go to the Trash and cannot be brought back\.$/);
    expect(t.length).toBeLessThanOrEqual(300);
  });

  it('a held call is described on the card by what it says: quoted tilde, odd argv, a very long or a relative target', async () => {
    const held = async (args: Record<string, unknown>) => { freshDoneDb(); runMigrations(); await hold('exec', args, 'destructive shell command'); return card().proposed_fix; };
    const generic = 'Run a command on this Mac that can delete or overwrite files.';
    expect(await held({ command: 'rm -rf "~/x"' })).toBe(generic);
    expect(await held({ argv: ['rm', 5] })).toBe(generic);
    const long = `/Users/example/${'deep-folder-name/'.repeat(40)}file.bin`;
    const sentence = await held({ argv: ['rm', '-rf', long] });
    expect(sentence.length).toBeLessThanOrEqual(300);
    expect(sentence).toMatch(/^Delete \/Users\/example\/.*\.\.\..*file\.bin, including everything inside\. Deleted files do not go to the Trash/);
    expect(await held({ argv: ['rm', '-rf', '../shared'] })).toBe(`${generic} It touches ../shared.`);
    expect(await held({ argv: ['rm', '-rf', 'build'], cwd: os.tmpdir() })).toBe(`Delete "build" in ${os.tmpdir()}, including everything inside. ${GONE}`);
  });

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
