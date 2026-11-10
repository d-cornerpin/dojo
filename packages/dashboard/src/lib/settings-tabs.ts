import { SETTINGS_TAB_LIST, type SettingsTabKey } from '@dojo/shared';

export type Tab = SettingsTabKey;

export const SETTINGS_TABS: { key: Tab; label: string }[] = SETTINGS_TAB_LIST;

export const TAB_KEYS: Tab[] = SETTINGS_TABS.map((t) => t.key);

export const isTab = (v: string | null): v is Tab => v !== null && (TAB_KEYS as string[]).includes(v);
