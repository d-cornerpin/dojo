// ════════════════════════════════════════════════════════════════════════════════════════
// THE TWILIO VOICE FIELDS KEEP WHAT IS TYPED.
//
// The max-minutes input and the voicemail greeting sit in `VoiceSettingsSection`, and every
// PATCH answer replaces `config`. Typing straight into `config` means React puts the old
// value back after each key press and the new value only arrives with the network answer —
// so fast typing loses characters, the caret jumps, and a half-typed value goes to the
// server. Each field keeps a local draft; the draft saves on blur.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type * as api from '../lib/api';

import { VoiceSettingsSection } from '../components/TwilioSettings';

const config = (): api.TwilioConfigDto =>
  ({
    voiceUnknownCallerAction: 'voicemail',
    voiceMaxMinutesPerCall: 10,
    voiceVoicemailGreeting: 'Hello',
  }) as unknown as api.TwilioConfigDto;

const minutesField = (): HTMLInputElement =>
  screen.getByLabelText(/Max call duration/i) as HTMLInputElement;
const greetingField = (): HTMLTextAreaElement =>
  screen.getByLabelText(/Voicemail greeting/i) as HTMLTextAreaElement;

describe('the voice settings fields', () => {
  it('typing into the greeting keeps the draft and does not patch until blur', () => {
    const onPatch = vi.fn(async () => {});
    render(<VoiceSettingsSection config={config()} onPatch={onPatch} />);
    fireEvent.change(greetingField(), { target: { value: 'Hello there' } });
    expect(onPatch).not.toHaveBeenCalled();
    expect(greetingField().value).toBe('Hello there');
  });

  it('blurring the greeting patches once with the typed text', () => {
    const onPatch = vi.fn(async () => {});
    render(<VoiceSettingsSection config={config()} onPatch={onPatch} />);
    fireEvent.change(greetingField(), { target: { value: 'Hello there' } });
    fireEvent.blur(greetingField());
    expect(onPatch).toHaveBeenCalledTimes(1);
    expect(onPatch).toHaveBeenCalledWith({ voiceVoicemailGreeting: 'Hello there' });
  });

  it('the minutes input saves on blur, and a refused value puts the stored one back', () => {
    const onPatch = vi.fn(async () => {});
    render(<VoiceSettingsSection config={config()} onPatch={onPatch} />);
    fireEvent.change(minutesField(), { target: { value: '15' } });
    expect(onPatch).not.toHaveBeenCalled();
    fireEvent.blur(minutesField());
    expect(onPatch).toHaveBeenCalledWith({ voiceMaxMinutesPerCall: 15 });
    fireEvent.change(minutesField(), { target: { value: '' } });
    fireEvent.blur(minutesField());
    expect(onPatch).toHaveBeenCalledTimes(1);
    expect(minutesField().value).toBe('10');
    fireEvent.change(minutesField(), { target: { value: '500' } });
    fireEvent.blur(minutesField());
    expect(onPatch).toHaveBeenCalledTimes(1);
    expect(minutesField().value).toBe('10');
  });
});
