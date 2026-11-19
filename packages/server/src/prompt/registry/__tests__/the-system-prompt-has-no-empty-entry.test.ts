import { describe, it, expect } from 'vitest';
import '../entries.js';
import { getSystemEntries } from '../registry.js';

describe('the system prompt has no empty entry', () => {
  it('none of the five moved sections is registered as a system entry', () => {
    const ids = getSystemEntries().map((e) => e.id);
    for (const gone of ['sys.integration-reconnect', 'sys.reply-destination', 'sys.channel-landscape', 'sys.phone-conduct', 'sys.voice-conduct']) {
      expect(ids).not.toContain(gone);
    }
  });
});
