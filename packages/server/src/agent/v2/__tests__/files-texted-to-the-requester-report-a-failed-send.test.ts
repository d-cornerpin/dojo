// A file texted to the iMessage requester that did not go is told to the agent, once.

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../../services/imessage-bridge.js', () => ({ sendIMessageWithAttachment: vi.fn() }));
vi.mock('../../agent-notice.js', () => ({ postAgentNotice: vi.fn() }));

import { textFilesToRequester } from '../steps/text-files-to-requester.js';
import { sendIMessageWithAttachment } from '../../../services/imessage-bridge.js';
import { postAgentNotice } from '../../agent-notice.js';

const sendSpy = vi.mocked(sendIMessageWithAttachment);
const noticeSpy = vi.mocked(postAgentNotice);

beforeEach(() => {
  sendSpy.mockReset();
  noticeSpy.mockReset();
});

describe('textFilesToRequester', () => {
  it('posts no notice when every send lands, and captions only the first file', async () => {
    sendSpy.mockResolvedValue(true);
    await textFilesToRequester('a1', '+15550100', [
      { path: '/fake/one.png' }, { path: '/fake/two.png' },
    ], 'Here you go');
    expect(sendSpy.mock.calls.map((c) => c[2])).toEqual(['Here you go', '']);
    expect(noticeSpy).not.toHaveBeenCalled();
  });

  it('tells the agent once, naming the file, when the second of three fails', async () => {
    sendSpy.mockResolvedValueOnce(true).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await textFilesToRequester('a1', '+15550100', [
      { path: '/fake/one.png' }, { path: '/fake/two.png', filename: 'two.png' }, { path: '/fake/three.png' },
    ]);
    expect(sendSpy).toHaveBeenCalledTimes(3);
    expect(noticeSpy).toHaveBeenCalledTimes(1);
    expect(noticeSpy.mock.calls[0][0].brief).toContain('two.png');
    expect(noticeSpy.mock.calls[0][0].brief).not.toContain('one.png');
  });

  it('counts a throwing send as not delivered and still resolves', async () => {
    sendSpy.mockRejectedValue(new Error('imsg missing'));
    await expect(textFilesToRequester('a1', '+15550100', [{ path: '/fake/one.png' }])).resolves.toBe(false);
    expect(noticeSpy).toHaveBeenCalledTimes(1);
  });

  it('skips a file without a path', async () => {
    sendSpy.mockResolvedValue(true);
    await textFilesToRequester('a1', '+15550100', [{ filename: 'x.png' }, { path: '/fake/one.png' }], 'cap');
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy.mock.calls[0][2]).toBe('cap');
  });
});
