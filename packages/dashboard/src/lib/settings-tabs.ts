export type Tab = 'platform' | 'providers' | 'models' | 'profile' | 'security' | 'router' | 'sensei' | 'channels' | 'integrations' | 'voice' | 'update';

/** The Settings tabs in display order. The tab bar and the link check both read this one list. */
export const SETTINGS_TABS: { key: Tab; label: string }[] = [
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

export const TAB_KEYS: Tab[] = SETTINGS_TABS.map((t) => t.key);

export const isTab = (v: string | null): v is Tab => v !== null && (TAB_KEYS as string[]).includes(v);
