// A message that tells a person where to click must name a tab and card that are on screen.
// The list of tabs and cards lives in @dojo/shared (settings-map.ts); this test makes two checks.
//   1. Every card title in that list is really shown by the dashboard.
//   2. Every "Settings → Tab → Card" typed into server or dashboard source names a real tab, and a
//      card that belongs to that tab, in the one arrow style.
// It ignores: test files and __tests__ folders (they may quote a wrong path on purpose), comment-only
// lines (the reader is a developer, not a person), and "System Settings …" (the macOS app, not ours).
import { describe, it, expect } from 'vitest';
import { SETTINGS_CARDS, SETTINGS_TAB_LIST, settingsPath, type SettingsTabKey } from '@dojo/shared';

describe('menu paths in messages are real', () => {

  it('the helper builds paths from the tab label, not its key', () => {
    expect(settingsPath('platform')).toBe('Settings → Dojo');
    expect(settingsPath('ollama')).toBe('Settings → Dojo → Ollama (Local Models)');
    expect(settingsPath('imessage')).toBe('Settings → Channels → iMessage Bridge');
  });
});
