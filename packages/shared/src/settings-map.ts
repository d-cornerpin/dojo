// The one list of Settings tabs, and the cards a message names. The dashboard tab bar reads the tabs and the
// server builds its "Settings → Tab → Card" lines from here. A card is listed only when a message names it.

export type SettingsTabKey = 'platform' | 'providers' | 'models' | 'router' | 'profile' | 'security' | 'sensei' | 'channels' | 'integrations' | 'voice' | 'update';

/** The tabs in display order. `label` is what the tab bar shows; `key` is only the URL/tool id. */
export const SETTINGS_TAB_LIST: { key: SettingsTabKey; label: string }[] = [
  { key: 'platform', label: 'Dojo' },
  { key: 'providers', label: 'Providers' },
  { key: 'models', label: 'Models' },
  { key: 'router', label: 'Router' },
  { key: 'profile', label: 'Profile' },
  { key: 'security', label: 'Security' },
  { key: 'sensei', label: 'Sensei' },
  { key: 'channels', label: 'Channels' },
  { key: 'integrations', label: 'Integrations' },
  { key: 'voice', label: 'Voice' },
  { key: 'update', label: 'Update' },
];

/** Cards a message may name: the tab that holds each, and the title the card shows. */
export const SETTINGS_CARDS = {
  ollama: { tab: 'platform', title: 'Ollama (Local Models)' },
  agentGoogle: { tab: 'channels', title: "Agent's Google Accounts" },
  userGoogle: { tab: 'channels', title: "User's Google Accounts" },
} as const satisfies Record<string, { tab: SettingsTabKey; title: string }>;

const settingsTabLabel = (tab: SettingsTabKey): string =>
  SETTINGS_TAB_LIST.find((t) => t.key === tab)?.label ?? tab;

/** "Settings → Dojo" for a tab, "Settings → Dojo → Ollama (Local Models)" for a card on it. */
export function settingsPath(target: SettingsTabKey | keyof typeof SETTINGS_CARDS): string {
  const card = (SETTINGS_CARDS as Record<string, { tab: SettingsTabKey; title: string }>)[target];
  if (card) return `Settings → ${settingsTabLabel(card.tab)} → ${card.title}`;
  return `Settings → ${settingsTabLabel(target as SettingsTabKey)}`;
}
