// The one list of Settings tabs and the cards a message may name. The dashboard tab bar reads it and
// the server builds every "Settings → Tab → Card" line from it, so a message cannot name a path that
// is not on screen. A source test (server/src/__tests__/settings-paths-are-real.test.ts) checks the
// card titles here against the dashboard and scans both packages for hand-typed paths.

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
  remoteAccess: { tab: 'platform', title: 'Remote Access' },
  webSearch: { tab: 'platform', title: 'Web Search Provider' },
  fallbackVision: { tab: 'models', title: 'Fallback Vision Model' },
  imageGeneration: { tab: 'models', title: 'Image Generation Model' },
  videoGeneration: { tab: 'models', title: 'Video Generation Model' },
  textToSpeech: { tab: 'models', title: 'Text-to-Speech (TTS) Model' },
  musicGeneration: { tab: 'models', title: 'Music Generation Model' },
  transcription: { tab: 'models', title: 'Transcription Model' },
  yourMailboxes: { tab: 'profile', title: 'Your Mailboxes' },
  sudoPolicy: { tab: 'security', title: 'Administrator privileges' },
  healing: { tab: 'sensei', title: 'Healing' },
  imessage: { tab: 'channels', title: 'iMessage Bridge' },
  twilio: { tab: 'channels', title: 'Twilio' },
  agentGoogle: { tab: 'channels', title: "Agent's Google Accounts" },
  userGoogle: { tab: 'channels', title: "User's Google Accounts" },
  agentMicrosoft: { tab: 'channels', title: "Agent's Microsoft Accounts" },
  userMicrosoft: { tab: 'channels', title: "User's Microsoft Accounts" },
  screenSharing: { tab: 'integrations', title: 'Screen Sharing' },
  plaud: { tab: 'integrations', title: 'Plaud' },
  github: { tab: 'integrations', title: 'GitHub' },
  baselineDelivery: { tab: 'voice', title: 'Baseline delivery' },
} as const satisfies Record<string, { tab: SettingsTabKey; title: string }>;

const settingsTabLabel = (tab: SettingsTabKey): string =>
  SETTINGS_TAB_LIST.find((t) => t.key === tab)?.label ?? tab;

/** "Settings → Dojo" for a tab, "Settings → Dojo → Ollama (Local Models)" for a card on it. */
export function settingsPath(target: SettingsTabKey | keyof typeof SETTINGS_CARDS): string {
  const card = (SETTINGS_CARDS as Record<string, { tab: SettingsTabKey; title: string }>)[target];
  if (card) return `Settings → ${settingsTabLabel(card.tab)} → ${card.title}`;
  return `Settings → ${settingsTabLabel(target as SettingsTabKey)}`;
}
