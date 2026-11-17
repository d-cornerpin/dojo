// When a stranded file rides the reply to an iMessage requester and does not land (the send says no, or it
// throws), the agent is woken and told (no owner alert: the agent tells the person). A file that lands says nothing extra.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const woken = vi.hoisted(() => vi.fn(async (_n: { agentId: string; brief: string }) => {}));
const plainNotice = vi.hoisted(() => vi.fn());
const sendAlert = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../../../db/connection.js', async () => (await import('./helpers/reply-sender.js')).connectionMock());
vi.mock('../../../services/imessage-bridge.js', async (orig) => ({ ...(await import('./helpers/reply-sender.js')).bridgeMock(await orig()), sendAlert }));
vi.mock('../../../services/presence.js', () => ({ getPresence: () => 'in_dojo', isImessageConfigured: () => true }));
vi.mock('../../../config/platform.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), isPrimaryAgent: () => true }));
vi.mock('../../access/engine-route.js', () => ({ engineMayRouteTo: () => true, engineRouteRefusalReason: () => 'no grant' }));
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../wake-with-notice.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), tellAgentAndWake: woken }));
vi.mock('../../agent-notice.js', () => ({ postAgentNotice: plainNotice }));

import { runMigrations } from '../../../db/migrations.js';
import { queuePendingAttachments } from '../../pending-attachments.js';
import { deliverDueReplies } from '../channel-sender.js';
import { freshReplyDb, imessage, testDb, AGENT, PERSON } from './helpers/reply-sender.js';
import { imessageTurn } from './helpers/imessage-turn.js';

const report = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dojo-test-files-')), 'report.pdf');
fs.writeFileSync(report, 'a report');
const strand = () => queuePendingAttachments(AGENT, [{ fileId: 'f1', filename: 'report.pdf', mimeType: 'application/pdf', size: 8, path: report, category: 'pdf' }]);

async function replyWithStrandedFile(): Promise<void> {
  const turn = imessageTurn();
  await turn.say('The report is attached.');
  strand();
  await turn.finalize();
  await deliverDueReplies(Date.now());
}

beforeEach(() => { freshReplyDb(runMigrations); woken.mockClear(); plainNotice.mockClear(); sendAlert.mockClear(); });

describe('a stranded file that does not reach iMessage', () => {
  it('is reported when the send answers no', async () => {
    imessage.sendFile.mockResolvedValue(false);
    await replyWithStrandedFile();
    expect(sendAlert).not.toHaveBeenCalled();   // the platform does not message the owner; the agent tells the person
    expect(woken).toHaveBeenCalledTimes(1);
    const { agentId, brief } = woken.mock.calls[0][0];
    expect(agentId).toBe(AGENT);
    expect(brief).toContain('report.pdf');
    expect(brief).toContain('imessage_send');   // names how to reach the requester
    expect(brief).toContain(PERSON);
  });

  it('is reported when the send throws', async () => {
    imessage.sendFile.mockRejectedValue(new Error('imsg down'));
    await replyWithStrandedFile();
    expect(sendAlert).not.toHaveBeenCalled();
    expect(woken).toHaveBeenCalledTimes(1);
  });

  it('says nothing extra when the file landed', async () => {
    await replyWithStrandedFile();
    expect(imessage.sendFile).toHaveBeenCalledTimes(1);
    expect(sendAlert).not.toHaveBeenCalled();
    expect(woken).not.toHaveBeenCalled();
  });
});

describe('a stranded file after an early answer', () => {
  it('rides a row that is not the answer, and its failure is still told once, at its last try', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });   // only the passes below send, on a still clock
    imessage.sendFile.mockResolvedValue(false);
    const turn = imessageTurn();
    await turn.answerEarly('The report is ready.');
    strand();
    await turn.finalize();
    let now = Date.now() + 1000;
    for (const wait of [30_000, 120_000, 600_000, 1_800_000, 0]) { await deliverDueReplies(now); now += wait; }
    const rows = testDb().prepare('SELECT tool, outcome FROM deliveries WHERE payload_json IS NOT NULL ORDER BY rowid').all();
    expect(rows).toEqual([{ tool: 'auto-route', outcome: 'delivered' }, { tool: 'download-links', outcome: 'failed' }]);
    expect(imessage.sent.filter((s) => s === 'The report is ready.')).toHaveLength(1);
    expect(woken).toHaveBeenCalledTimes(1);
    expect(woken.mock.calls[0][0].brief).toContain('report.pdf');
    vi.useRealTimers();
  });
});

describe('a stranded file with no caption from the agent', () => {
  it('is shown and texted with NO engine-written words, and the agent is told it was delivered', async () => {
    const turn = imessageTurn();
    strand();
    await turn.finalize();
    await deliverDueReplies(Date.now());
    const shown = testDb().prepare("SELECT content FROM messages WHERE role = 'assistant' AND attachments IS NOT NULL").get() as { content: string };
    expect(shown.content).toBe('');
    expect(imessage.sent).toEqual([`file ${report}`]);   // no words on the channel either
    expect(plainNotice).toHaveBeenCalledTimes(1);
    expect(plainNotice.mock.calls[0][0].brief).toContain('report.pdf');
    expect(plainNotice.mock.calls[0][0].brief).toMatch(/no caption/i);
  });

  it('gets the normal retries: Messages fails once, and the file goes on the retry, once', async () => {
    imessage.sendFile.mockResolvedValueOnce(false);
    const turn = imessageTurn();
    strand();
    await turn.finalize();
    const now = Date.now() + 1000;
    await deliverDueReplies(now);
    await deliverDueReplies(now + 30_000);
    expect(imessage.sent).toEqual([`file ${report}`, `file ${report}`]);
    expect(testDb().prepare('SELECT outcome, attempts FROM deliveries WHERE payload_json IS NOT NULL').all()).toEqual([{ outcome: 'delivered', attempts: 2 }]);
  });
});
