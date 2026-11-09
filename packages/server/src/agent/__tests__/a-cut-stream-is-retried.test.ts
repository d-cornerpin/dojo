// t185 (Run 17 S4 attempt 2): DeepSeek cut a streamed reply mid-flight; undici throws `TypeError: terminated`
// (cause: "other side closed"). The classifier did not know the word, so the call was not retried and the turn
// failed ("v2 agent loop failed: OpenAI call failed: terminated"). A cut stream is a network drop: retryable.
import { describe, it, expect } from 'vitest';
import { classifyProviderError, classifyProviderErrorText, isRetryableProviderClass } from '../provider-error.js';

describe('t185: a cut stream is a network drop and is retried', () => {
  it('the measured text "OpenAI call failed: terminated" is network, retryable', () => {
    const f = classifyProviderErrorText('OpenAI call failed: terminated');
    expect(f.class).toBe('network');
    expect(isRetryableProviderClass(f.class)).toBe(true);
  });
  it('undici\'s own TypeError("terminated") with an "other side closed" cause is network', () => {
    const err = Object.assign(new TypeError('terminated'), { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) });
    expect(classifyProviderError(err).class).toBe('network');
  });
  it('CONTROL: "Request was aborted" (an owner Stop / teardown) is NOT made retryable by this', () => {
    expect(classifyProviderErrorText('OpenAI call failed: Request was aborted.').class).not.toBe('network');
  });
  it('CONTROL: a sentence merely containing the word ("the contract terminated in May") is not network', () => {
    expect(classifyProviderErrorText('400 Bad Request: the contract terminated in May').class).not.toBe('network');
  });
});
