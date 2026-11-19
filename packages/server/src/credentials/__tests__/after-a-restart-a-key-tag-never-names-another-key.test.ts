// A saved key shown to the agent is stored as a tagged placeholder. After a restart the tags start
// again; a tag must never be handed out a second time, or a command repeated from before the restart
// would be filled with a different key.

import { describe, it, expect, vi } from 'vitest';

const WEATHER_KEY = 'zq9FakeWeatherKey000000000042';
const CODE_HOST_KEY = 'zq9FakeCodeHostKey00000000042';

describe('after a restart', () => {
  it('a new key never gets the tag an old key had', async () => {
    const before = await import('../secret-values.js');
    before.noteHandedCredentialValues('agent-1', [WEATHER_KEY]);
    const oldPlaceholder = before.redactedPlaceholderFor('agent-1', WEATHER_KEY);

    vi.resetModules();
    const after = await import('../secret-values.js');
    after.noteHandedCredentialValues('agent-1', [CODE_HOST_KEY]);
    const newPlaceholder = after.redactedPlaceholderFor('agent-1', CODE_HOST_KEY);

    expect(newPlaceholder).toMatch(/^<redacted-credential:[0-9a-f]{8}>$/);
    expect(newPlaceholder).not.toBe(oldPlaceholder);
    expect(after.hydrateHandedCredentials('agent-1', oldPlaceholder)).not.toContain(CODE_HOST_KEY);
  });

  it('a placeholder still comes back as its own key in the same run', async () => {
    const m = await import('../secret-values.js');
    m.noteHandedCredentialValues('agent-2', [WEATHER_KEY]);
    const placeholder = m.redactedPlaceholderFor('agent-2', WEATHER_KEY);
    expect(m.hydrateHandedCredentials('agent-2', `curl -H "key: ${placeholder}"`)).toBe(`curl -H "key: ${WEATHER_KEY}"`);
  });
});
