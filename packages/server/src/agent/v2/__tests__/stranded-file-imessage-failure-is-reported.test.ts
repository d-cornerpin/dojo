// When the end-of-turn net sends a stranded file to an iMessage requester and the send does not
// land (it says no, or it throws), the owner is told through the existing owner-notice door.
// A send that lands says nothing extra.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sendFileMock = vi.hoisted(() => vi.fn());
const sendAlertMock = vi.hoisted(() => vi.fn(async () => {}));
const noticeMock = vi.hoisted(() => vi.fn());

vi.mock('../../../logger.js', () => {
  const noop = (): void => {};
  return { createLogger: () => ({ debug: noop, info: noop, warn: noop, error: noop }), setLogLevel: noop, setLogBroadcast: noop, readLogEntries: () => [] };
});
vi.mock('../../../memory/message-store.js', () => ({ insertMessageIfAbsent: vi.fn() }));
vi.mock('../engine-exit.js', () => ({ turnParkedTheJob: () => false }));
vi.mock('../../pending-attachments.js', () => ({
  drainPendingAttachmentsWithCaptions: () => ({ attachments: [{ filename: 'report.pdf', path: '/tmp/fake/report.pdf' }], captions: [] }),
}));
vi.mock('../../../credentials/secret-fields.js', () => ({ redactHandedCredentials: (_a: string, t: string) => t }));
vi.mock('../../agent-notice.js', () => ({ postAgentNotice: noticeMock }));
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
  beforeEach(() => { sendFileMock.mockReset(); sendAlertMock.mockClear(); noticeMock.mockClear(); });
  void advance;

  it('is reported when the send answers no', async () => {
    sendFileMock.mockResolvedValue(false);
    await run();
    expect(sendAlertMock).toHaveBeenCalledTimes(1);
    expect(sendAlertMock.mock.calls[0][1]).toBe('notice');
    // the agent is told too, naming the file, so its reply does not claim it arrived
    expect(noticeMock).toHaveBeenCalledTimes(1);
    expect(noticeMock.mock.calls[0][0].toAgentId).toBe('agent-1');
    expect(noticeMock.mock.calls[0][0].brief).toContain('report.pdf');
  });

  it('is reported when the send throws', async () => {
    sendFileMock.mockRejectedValue(new Error('imsg down'));
    await run();
    expect(sendAlertMock).toHaveBeenCalledTimes(1);
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
