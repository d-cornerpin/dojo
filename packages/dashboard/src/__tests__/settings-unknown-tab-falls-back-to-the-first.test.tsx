import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../hooks/useWebSocket', () => ({
  useWebSocket: () => ({ subscribe: () => () => undefined, reconnectCount: 0 }),
}));
const { stub } = vi.hoisted(() => ({ stub: (name: string) => () => <div>{`stub:${name}`}</div> }));
vi.mock('../components/settings/PlatformTab', () => ({ PlatformTab: stub('platform') }));
vi.mock('../components/settings/ProvidersTab', () => ({ ProvidersTab: stub('providers') }));
vi.mock('../components/settings/ModelsTab', () => ({ ModelsTab: stub('models') }));
vi.mock('../components/settings/ProfileTab', () => ({ ProfileTab: stub('profile') }));
vi.mock('../components/settings/RouterTab', () => ({ RouterTab: stub('router') }));
vi.mock('../components/settings/SecurityTab', () => ({ SecurityTab: stub('security'), SudoPolicyCard: stub('sudo') }));
vi.mock('../components/settings/DreamingTab', () => ({ DreamingTab: stub('sensei') }));
vi.mock('../components/settings/UpdateTab', () => ({ UpdateTab: stub('update') }));
vi.mock('../components/settings/VoiceTab', () => ({ VoiceTab: stub('voice') }));
vi.mock('../components/settings/IMBridgeSettings', () => ({ IMBridgeSettings: stub('channels') }));
vi.mock('../components/TwilioSettings', () => ({ TwilioSettings: stub('twilio') }));
vi.mock('../components/GoogleWorkspaceSettings', () => ({ GoogleWorkspaceSettings: stub('google') }));
vi.mock('../components/MicrosoftWorkspaceSettings', () => ({ MicrosoftWorkspaceSettings: stub('microsoft') }));

import { Settings } from '../pages/Settings';

const at = (url: string) => render(<MemoryRouter initialEntries={[url]}><Settings /></MemoryRouter>);

describe('Settings tab from the link', () => {
  it('an unknown tab falls back to the first (Dojo) tab', () => {
    at('/settings?tab=billing');
    expect(screen.getByText('stub:platform')).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Dojo' }).getAttribute('aria-selected')).toBe('true');
  });
  it('a real tab is honoured', () => {
    at('/settings?tab=voice');
    expect(screen.getByText('stub:voice')).toBeTruthy();
  });
  it('the old imessage name still maps to channels', () => {
    at('/settings?tab=imessage');
    expect(screen.getByText('stub:channels')).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Channels' }).getAttribute('aria-selected')).toBe('true');
  });
});
