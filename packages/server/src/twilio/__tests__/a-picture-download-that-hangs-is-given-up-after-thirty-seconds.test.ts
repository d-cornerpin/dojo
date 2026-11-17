import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
vi.mock('../auth.js', () => ({ isSmsEnabled: () => true, getTwilioCreds: () => ({ sid: 'AC1', token: 'tok-test' }) }));
const { downloadMmsMedia } = await import('../sms-inbound.js');

const payload = {
  messageSid: 'SM-pic-1', fromNumber: '+15550100002', toNumber: '+15550100900',
  body: '', numMedia: 1, mediaUrls: ['https://api.twilio.example/media/1'], mediaContentTypes: ['image/jpeg'],
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', vi.fn((_url: string, init: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
  })));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('a picture download that hangs', () => {
  it('is given up after thirty seconds and listed as a link', async () => {
    const p = downloadMmsMedia(payload, 'primary');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await p).toEqual({ files: [], failedUrls: ['https://api.twilio.example/media/1'] });
  });
});
