// A message that tells a person where to click names the tab by its label and the card by its title,
// both from the one list in @dojo/shared (settings-map.ts).
import { describe, it, expect } from 'vitest';
import { settingsPath } from '@dojo/shared';

describe('menu paths in messages are real', () => {
  it('the helper builds paths from the tab label, not its key', () => {
    expect(settingsPath('platform')).toBe('Settings → Dojo');
    expect(settingsPath('ollama')).toBe('Settings → Dojo → Ollama (Local Models)');
    expect(settingsPath('agentGoogle')).toBe("Settings → Channels → Agent's Google Accounts");
  });
});
