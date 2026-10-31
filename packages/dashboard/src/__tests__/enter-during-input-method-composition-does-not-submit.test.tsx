// ════════════════════════════════════════════════════════════════════════════
// ENTER THAT CONFIRMS AN INPUT-METHOD CANDIDATE MUST NOT SUBMIT.
//
// A chat box that sends on Enter is the whole point of the box — until the user
// is typing Japanese, Chinese or Korean. Then the browser runs an input method:
// you type romaji, a candidate list opens, and Enter ACCEPTS the highlighted word
// instead of meaning "done". The browser still fires `keydown` with `key === 'Enter'`
// — but it marks that one `isComposing`. The composer read only `key`, so the
// confirmation both sent the unfinished half-word AND swallowed the confirmation
// the user was mid-way through. A Japanese user literally cannot finish a sentence.
//
// The tell is `nativeEvent.isComposing` (and the legacy `keyCode === 229`), never
// `key`. The rule lives in `lib/enter-key.ts` so the nine submit-on-Enter sites
// that had the bug — and every future one — read the SAME tell. This file pins the
// rule as a unit, then drives a real `Dojo3Composer` through both enters.
// ════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// The composer mounts a voice session and a toast sink. Neither is the subject here,
// and both would reach the network/mic if left real (the setup file refuses `fetch`
// outright). A disabled voice and a no-op toast let the text composer mount clean.
vi.mock('../hooks/useVoiceMode', () => ({
  useVoiceMode: () => ({
    enabled: false,
    state: 'idle',
    error: null,
    notice: null,
    lastTranscript: null,
    partialTranscript: null,
    wakeWordEnabled: false,
    wakePhrase: '',
    bargeInEnabled: false,
    soundEffectsEnabled: false,
    audioLevel: 0,
    muted: false,
    setMuted: async () => {},
    toggleMute: async () => {},
    toggle: async () => {},
    stop: async () => {},
    setupNeeded: null,
    completeSetup: async () => {},
    cancelSetup: () => {},
  }),
}));
vi.mock('../hooks/useToast', () => ({
  useToast: () => ({
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  }),
}));

import { isPlainEnter, isEnterNotComposing } from '../lib/enter-key';
import { Dojo3Composer } from '../components/Dojo3Composer';

describe('isPlainEnter — the composer send', () => {
  it('is true for a plain Enter', () => {
    expect(isPlainEnter({ key: 'Enter' })).toBe(true);
  });
  it('is false for Shift+Enter (that means newline, not send)', () => {
    expect(isPlainEnter({ key: 'Enter', shiftKey: true })).toBe(false);
  });
  it('is false while an input method is composing the word (nativeEvent)', () => {
    expect(isPlainEnter({ key: 'Enter', nativeEvent: { isComposing: true } })).toBe(false);
  });
  it('is false while an input method is composing the word (legacy keyCode 229)', () => {
    expect(isPlainEnter({ key: 'Enter', nativeEvent: { keyCode: 229 } })).toBe(false);
  });
  it('is still true on a plain Enter the DOM gives a keyCode of 0 for', () => {
    expect(isPlainEnter({ key: 'Enter', nativeEvent: { keyCode: 0 } })).toBe(true);
  });
  it('is false for any other key', () => {
    expect(isPlainEnter({ key: 'a' })).toBe(false);
  });
});

describe('isEnterNotComposing — the single-line submit (shift never mattered here)', () => {
  it('is true for a plain Enter', () => {
    expect(isEnterNotComposing({ key: 'Enter' })).toBe(true);
  });
  it('is true for Shift+Enter (these inputs never treated shift specially)', () => {
    expect(isEnterNotComposing({ key: 'Enter', shiftKey: true })).toBe(true);
  });
  it('is false while an input method is composing (nativeEvent)', () => {
    expect(isEnterNotComposing({ key: 'Enter', nativeEvent: { isComposing: true } })).toBe(false);
  });
  it('is false while an input method is composing (top-level isComposing, no nativeEvent)', () => {
    expect(isEnterNotComposing({ key: 'Enter', isComposing: true })).toBe(false);
  });
  it('is false for any other key', () => {
    expect(isEnterNotComposing({ key: 'Escape' })).toBe(false);
  });
});

describe('Dojo3Composer — Enter against a real textarea', () => {
  it('a plain Enter sends the message once', () => {
    const onSend = vi.fn();
    render(<Dojo3Composer agentId="a" onSend={onSend} />);
    const box = screen.getByRole('textbox');
    fireEvent.change(box, { target: { value: 'こんにちは' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0][0]).toBe('こんにちは');
  });

  it('⚠ THE RED: Enter that CONFIRMS an input-method candidate does not send', () => {
    const onSend = vi.fn();
    render(<Dojo3Composer agentId="a" onSend={onSend} />);
    const box = screen.getByRole('textbox');
    fireEvent.change(box, { target: { value: 'にほん' } });
    // The IME is mid-composition: this Enter accepts the candidate word. It must be
    // swallowed, NOT read as "send the half-typed message".
    fireEvent.keyDown(box, { key: 'Enter', isComposing: true });
    expect(onSend).not.toHaveBeenCalled();
    // Once composition is done, a plain Enter does its normal job.
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledTimes(1);
  });
});
