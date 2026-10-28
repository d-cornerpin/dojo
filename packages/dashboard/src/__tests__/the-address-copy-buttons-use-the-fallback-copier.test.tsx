// ── THE ADDRESS COPY BUTTONS ALSO WORK ON A PLAIN-HTTP ADDRESS.
//
// The async Clipboard API only exists in a secure context, so over a tunnel or a LAN address
// `navigator.clipboard` is undefined and a direct `writeText` throws. The card must go through
// `lib/clipboard`'s helper, which falls back to a hidden textarea and `execCommand('copy')`.
// Mounted for real with the Twilio config collapsed; the network doors and the toast queue
// are the only things replaced.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../lib/api');
  return {
    ...actual,
    getTwilioConfigApi: vi.fn(async () => ({
      ok: true,
      data: {
        configured: true, enabled: true, smsEnabled: false, voiceEnabled: false,
        numbers: [], accountSid: 'ACxxxxxxxxxxxxxxxx',
        voiceUnknownCallerAction: 'reject', voiceMaxMinutesPerCall: 10, voiceVoicemailGreeting: '',
        webhooks: { sms: 'https://x/sms', voice: 'https://x/voice', voiceStatus: 'https://x/status' },
        webhookError: null,
      },
    })),
    listTwilioSmsSafeSendersApi: vi.fn(async () => ({ ok: true, data: [] })),
    listTwilioVoiceSafeCallersApi: vi.fn(async () => ({ ok: true, data: [] })),
  };
});
const toasts = vi.hoisted(() => ({ info: [] as string[], error: [] as string[] }));
vi.mock('../hooks/useToast', () => ({
  useToast: () => ({
    info: (m: string) => { toasts.info.push(m); },
    error: (m: string) => { toasts.error.push(m); },
  }),
  ToastProvider: ({ children }: { children: ReactElement }) => children,
}));

import { TwilioSettings } from '../components/TwilioSettings';

beforeEach(() => {
  toasts.info.length = 0;
  toasts.error.length = 0;
  // A plain-http address: the browser refuses to provide the Clipboard API at all.
  Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
  document.execCommand = vi.fn(() => true);
});

describe('the webhook copy buttons', () => {
  it('copies through the fallback copier when the Clipboard API is absent', async () => {
    render(<TwilioSettings />);
    // The card opens collapsed; only the toggle's label names it.
    const toggle = await screen.findByRole('button', { name: /twilio/i });
    fireEvent.click(toggle);
    const copyButtons = await screen.findAllByRole('button', { name: 'Copy' });
    fireEvent.click(copyButtons[0]);
    await waitFor(() => expect(document.execCommand).toHaveBeenCalledWith('copy'));
    await waitFor(() => expect(toasts.info).toEqual(['SMS URL copied.']));
    expect(toasts.error).toEqual([]);
  });
});
