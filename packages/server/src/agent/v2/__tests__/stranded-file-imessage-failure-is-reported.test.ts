// When the end-of-turn net sends a stranded file to an iMessage requester and the send does not
// land (it says no, or it throws), the agent is told (no owner alert: the agent tells the person).
// A send that lands says nothing extra.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sendFileMock = vi.hoisted(() => vi.fn());
const sendAlertMock = vi.hoisted(() => vi.fn(async () => {}));
const noticeMock = vi.hoisted(() => vi.fn());
const plainNoticeMock = vi.hoisted(() => vi.fn());
const insertMock = vi.hoisted(() => vi.fn());

vi.mock('../../../logger.js', () => {
  const noop = (): void => {};
  return { createLogger: () => ({ debug: noop, info: noop, warn: noop, error: noop }), setLogLevel: noop, setLogBroadcast: noop, readLogEntries: () => [] };
});
vi.mock('../../../memory/message-store.js', () => ({ insertMessageIfAbsent: insertMock }));
vi.mock('../../agent-notice.js', () => ({ postAgentNotice: plainNoticeMock }));
vi.mock('../engine-exit.js', () => ({ turnParkedTheJob: () => false }));
vi.mock('../../pending-attachments.js', () => ({
  drainPendingAttachmentsWithCaptions: () => ({ attachments: [{ filename: 'report.pdf', path: '/tmp/fake/report.pdf' }], captions: [] }),
}));
vi.mock('../../../credentials/secret-fields.js', () => ({ redactHandedCredentials: (_a: string, t: string) => t }));
vi.mock('../../wake-with-notice.js', () => ({ tellAgentAndWake: noticeMock, requesterReachSentence: async (a: string) => `Your written reply on this turn does NOT reach them; call imessage_send with recipient="${a}".` }));
vi.mock('../../../services/imessage-bridge.js', () => ({
  sendIMessageWithAttachment: sendFileMock,
  sendAlert: sendAlertMock,
}));

const { surfaceStrandedAttachments } = await import('../steps/finalize/stranded-attachments.js');
const { advance } = await import('../state.js');

const ctx = () => ({
  agentId: 'agent-1',
  turnNumber: 3,
  counterparty: { kind: 'user', channel: 'imessage', senderId: '+15550100198' },
  broadcast: vi.fn(),
  noteTerminalAnswer: vi.fn(),
}) as never;

const run = () => surfaceStrandedAttachments({} as never, ctx()).catch(() => undefined);

describe('a stranded file that does not reach iMessage', () => {
  beforeEach(() => { insertMock.mockClear(); plainNoticeMock.mockClear(); sendFileMock.mockReset(); sendAlertMock.mockClear(); noticeMock.mockClear(); });
  void advance;

  it('is reported when the send answers no', async () => {
    sendFileMock.mockResolvedValue(false);
    await run();
    expect(sendAlertMock).not.toHaveBeenCalled();   // C2: the platform does not message the owner; the agent is told and tells the person
    // the agent is told too, naming the file, so its reply does not claim it arrived
    expect(noticeMock).toHaveBeenCalledTimes(1);
    expect(noticeMock.mock.calls[0][0].agentId).toBe('agent-1');   // and the agent is WOKEN so it tells the person now
    expect(noticeMock.mock.calls[0][0].brief).toContain('report.pdf');
    expect(noticeMock.mock.calls[0][0].brief).toContain('imessage_send');   // R4: names how to reach the requester
    expect(noticeMock.mock.calls[0][0].brief).toContain('+15550100198');
  });

  it('is reported when the send throws', async () => {
    sendFileMock.mockRejectedValue(new Error('imsg down'));
    await run();
    expect(sendAlertMock).not.toHaveBeenCalled();
    expect(noticeMock).toHaveBeenCalledTimes(1);
  });

  it('says nothing extra when the file landed', async () => {
    sendFileMock.mockResolvedValue(true);
    await run();
    expect(sendFileMock).toHaveBeenCalledTimes(1);
    expect(sendAlertMock).not.toHaveBeenCalled();
    expect(noticeMock).not.toHaveBeenCalled();
  });
});

describe('a stranded file with no caption from the agent', () => {
  beforeEach(() => { insertMock.mockClear(); plainNoticeMock.mockClear(); sendFileMock.mockReset(); noticeMock.mockClear(); });
  it('is shown and texted with NO engine-written words, and the agent is told it was delivered', async () => {
    sendFileMock.mockResolvedValue(true);
    await run();
    expect(insertMock.mock.calls[0][0].content).toBe('');
    expect(sendFileMock.mock.calls[0][2]).toBe('');   // no caption on the text either
    expect(plainNoticeMock).toHaveBeenCalledTimes(1);
    expect(plainNoticeMock.mock.calls[0][0].brief).toContain('report.pdf');
    expect(plainNoticeMock.mock.calls[0][0].brief).toMatch(/no caption/i);
  });
});
