import { describe, it, expect, vi, afterEach } from 'vitest';
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
vi.mock('../components/settings/SecurityTab', () => ({ SecurityTab: stub('security') }));
vi.mock('../components/settings/DreamingTab', () => ({ DreamingTab: stub('sensei') }));
vi.mock('../components/settings/UpdateTab', () => ({ UpdateTab: stub('update') }));
vi.mock('../components/settings/VoiceTab', () => ({ VoiceTab: stub('voice') }));
vi.mock('../components/settings/IMBridgeSettings', () => ({ IMBridgeSettings: stub('channels') }));
vi.mock('../components/TwilioSettings', () => ({ TwilioSettings: stub('twilio') }));
vi.mock('../components/GoogleWorkspaceSettings', () => ({ GoogleWorkspaceSettings: stub('google') }));
vi.mock('../components/MicrosoftWorkspaceSettings', () => ({ MicrosoftWorkspaceSettings: stub('microsoft') }));

import { Settings } from '../pages/Settings';

const at = (url: string) => render(<MemoryRouter initialEntries={[url]}><Settings /></MemoryRouter>);

const NOTE = /open the dashboard on the Mac that runs the Dojo/;
const setUrl = (u: string) => (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL(u);
afterEach(() => { setUrl('http://localhost:3000/'); });

describe('the Channels sign-in note', () => {
  it('is not shown on this Mac', () => {
    setUrl('http://localhost:3001/settings?tab=channels');
    at('/settings?tab=channels');
    expect(screen.queryByText(NOTE)).toBeNull();
    expect(screen.queryByText(/localhost:3000/)).toBeNull();
  });
  it('is shown, with no address in it, from another device', () => {
    setUrl('https://dojo.example.com/settings?tab=channels');
    at('/settings?tab=channels');
    expect(screen.getByText(NOTE)).toBeTruthy();
    expect(screen.queryByText(/localhost/)).toBeNull();
  });
});
