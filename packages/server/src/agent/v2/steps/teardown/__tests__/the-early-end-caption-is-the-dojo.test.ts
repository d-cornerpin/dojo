// OR-ENGINE-LABELLED: files flushed because a turn ended early carry NO engine words in the agent's voice
// ("Here are the files I prepared ..."); the row is "Dojo: ..." and the agent is told what was posted.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const insertMock = vi.hoisted(() => vi.fn(() => ({ seq: 1 })));
const noticeMock = vi.hoisted(() => vi.fn());
const drainMock = vi.hoisted(() => vi.fn());
vi.mock('../../../../../logger.js', () => { const n = (): void => {}; return { createLogger: () => ({ debug: n, info: n, warn: n, error: n }) }; });
vi.mock('../../../../../gateway/ws.js', () => ({ broadcast: vi.fn() }));
vi.mock('../../../../../memory/message-store.js', () => ({ insertMessageIfAbsent: insertMock }));
vi.mock('../../../engine-exit.js', () => ({ turnParkedTheJob: () => false }));
vi.mock('../../../../pending-attachments.js', () => ({ drainPendingAttachmentsWithCaptions: drainMock }));
vi.mock('../../../../agent-notice.js', () => ({ postAgentNotice: noticeMock }));

import { flushStrandedAttachments } from '../attachment-flush.js';

const ctx = { agentId: 'a1', turnNumber: 4, chosenConversationId: 'c1', counterparty: { kind: 'user' } } as never;
beforeEach(() => { insertMock.mockClear(); noticeMock.mockClear(); drainMock.mockReset(); });

describe('files flushed at an early turn end', () => {
  it('with no caption from the agent: a "Dojo:" row, never first person, and the agent is told after it was posted', async () => {
    drainMock.mockReturnValue({ attachments: [{ filename: 'plan.pdf', path: '/x/plan.pdf' }], captions: [] });
    await flushStrandedAttachments(ctx);
    const content = (insertMock.mock.calls[0] as unknown as [{ content: string }])[0].content;
    expect(content).toMatch(/^Dojo: /);
    expect(content).not.toMatch(/\bI\b/);
    expect(noticeMock).toHaveBeenCalledTimes(1);
    const brief = (noticeMock.mock.calls[0] as unknown as [{ brief: string }])[0].brief;
    expect(brief).toContain(content);
    expect(brief).toContain('plan.pdf');
  });
  it('with the agent\'s own caption: its words are kept and nothing is added', async () => {
    drainMock.mockReturnValue({ attachments: [{ filename: 'plan.pdf', path: '/x/plan.pdf' }], captions: ['Here is the plan.'] });
    await flushStrandedAttachments(ctx);
    expect((insertMock.mock.calls[0] as unknown as [{ content: string }])[0].content).toBe('Here is the plan.');
    expect(noticeMock).not.toHaveBeenCalled();
  });
});
