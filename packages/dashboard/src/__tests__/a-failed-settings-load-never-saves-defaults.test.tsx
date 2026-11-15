// Every settings editor that loads a value and writes it back: when the read FAILS the card says so with a
// Retry, shows no editor and no Save, and writes nothing. (The defaults an editor shows while it has not read
// the real value must never become the base of a save.)
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const fns = vi.hoisted(() => ({
  getSetting: vi.fn(), setSetting: vi.fn(),
  getDreamingConfig: vi.fn(), updateDreamingConfig: vi.fn(), getModels: vi.fn(), getLatestDream: vi.fn(),
  getHealerConfig: vi.fn(), updateHealerConfig: vi.fn(), getHealerDiagnostic: vi.fn(),
  getSearchConfig: vi.fn(), setSearchConfig: vi.fn(),
  getIdentity: vi.fn(), updateIdentity: vi.fn(),
}));
vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../lib/api');
  return { ...actual, ...fns };
});
vi.mock('../hooks/useToast', async () => {
  const { fakeToast } = await import('./helpers/frames');
  const stub = fakeToast();
  return { useToast: () => stub.value };
});

import { OllamaSettings, AgentLimitsSettings, SearchSettings } from '../components/settings/PlatformTab';
import { DreamingTab } from '../components/settings/DreamingTab';
import { HealerCard } from '../components/settings/CapabilityModelCards';
import { ProfileTab } from '../components/settings/ProfileTab';

const FAIL = { ok: false, error: 'down' };
const ok = (data: unknown) => ({ ok: true, data });

beforeEach(() => {
  for (const f of Object.values(fns)) f.mockReset();
  fns.setSetting.mockResolvedValue(ok({}));
  fns.getModels.mockResolvedValue(ok([]));
  fns.getLatestDream.mockResolvedValue(ok(null));
  fns.getHealerDiagnostic.mockResolvedValue(ok(null));
});

const writes = () => [fns.setSetting, fns.updateDreamingConfig, fns.updateHealerConfig, fns.setSearchConfig, fns.updateIdentity]
  .reduce((n, f) => n + f.mock.calls.length, 0);

describe('a failed read leaves no editor and no write', () => {
  it('Ollama concurrency', async () => {
    fns.getSetting.mockResolvedValue(FAIL);
    render(<OllamaSettings />);
    await screen.findByText('Retry');
    expect(screen.queryByText('Save')).toBeNull();
    expect(writes()).toBe(0);
  });

  it('Dojo capacity (all four limits)', async () => {
    fns.getSetting.mockImplementation(async (k: string) => k === 'spawn_max_children' ? FAIL : ok({ key: k, value: '7' }));
    render(<AgentLimitsSettings />);
    await screen.findByText('Retry');
    expect(screen.queryByText('Save Limits')).toBeNull();
    expect(writes()).toBe(0);
  });

  it('Dreaming', async () => {
    fns.getDreamingConfig.mockResolvedValue(FAIL);
    render(<DreamingTab />);
    await screen.findByText('Retry');
    expect(screen.queryByText('Save')).toBeNull();
    expect(writes()).toBe(0);
  });

  it('Healer', async () => {
    fns.getHealerConfig.mockResolvedValue(FAIL);
    render(<HealerCard models={[]} />);
    await screen.findByText('Retry');
    expect(screen.queryByText('Save')).toBeNull();
    expect(writes()).toBe(0);
  });

  it('Search', async () => {
    fns.getSearchConfig.mockResolvedValue(FAIL);
    render(<SearchSettings />);
    await screen.findByText('Retry');
    expect(screen.queryByText('Save')).toBeNull();
    expect(writes()).toBe(0);
  });

  it('Profile: no About You editor, no Save', async () => {
    fns.getSetting.mockResolvedValue(ok({ key: 'owner_name', value: 'Sam' }));
    fns.getIdentity.mockResolvedValue(FAIL);
    const { container } = render(<ProfileTab />);
    await screen.findByText('Retry');
    expect(container.querySelector('textarea')).toBeNull();
    expect(fns.updateIdentity).not.toHaveBeenCalled();
  });
});

describe('a good read saves on top of what was read', () => {
  it('Profile names the text it was built on', async () => {
    fns.getSetting.mockResolvedValue(ok({ key: 'owner_name', value: 'Sam' }));
    fns.getIdentity.mockResolvedValue(ok({ content: 'REAL PROFILE', mailboxes: [] }));
    fns.updateIdentity.mockResolvedValue(ok({}));
    render(<ProfileTab />);
    const box = await screen.findByDisplayValue('REAL PROFILE');
    fireEvent.change(box, { target: { value: 'REAL PROFILE and more' } });
    fireEvent.click(screen.getAllByText('Save')[1]);
    await waitFor(() => expect(fns.updateIdentity).toHaveBeenCalled());
    expect(fns.updateIdentity.mock.calls[0]).toEqual(['USER.md', 'REAL PROFILE and more', 'REAL PROFILE']);
  });

  it('Ollama saves the value it read, changed', async () => {
    fns.getSetting.mockResolvedValue(ok({ key: 'k', value: '3' }));
    render(<OllamaSettings />);
    await screen.findByDisplayValue('3');
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(fns.setSetting).toHaveBeenCalledWith('ollama_max_concurrent_models', '3'));
  });
});

describe('a failed profile save keeps what the owner typed', () => {
  it('the typed profile stays, and the saved text loads only on request', async () => {
    fns.getSetting.mockResolvedValue(ok({ key: 'owner_name', value: 'Sam' }));
    fns.getIdentity.mockResolvedValue(ok({ content: 'SAVED PROFILE', mailboxes: [] }));
    fns.updateIdentity.mockResolvedValue({ ok: false, error: 'This document changed since you loaded it, so it was not saved.' });
    render(<ProfileTab />);
    const box = await screen.findByDisplayValue('SAVED PROFILE');
    fireEvent.change(box, { target: { value: 'MY LONG PROFILE EDIT' } });
    fireEvent.click(screen.getAllByText('Save')[1]);
    await screen.findByText('Load the saved version');
    expect(screen.getByDisplayValue('MY LONG PROFILE EDIT')).toBeTruthy();
    fns.getIdentity.mockResolvedValue(ok({ content: 'NEWER PROFILE', mailboxes: [] }));
    fireEvent.click(screen.getByText('Load the saved version'));
    await screen.findByDisplayValue('NEWER PROFILE');
  });
});

describe('a name save never replaces profile text typed while it ran', () => {
  it('the profile box keeps what was typed during the save', async () => {
    fns.getSetting.mockResolvedValue(ok({ key: 'owner_name', value: 'Sam' }));
    fns.getIdentity.mockResolvedValue(ok({ content: 'SAVED PROFILE', mailboxes: [] }));
    let finish: (v: unknown) => void = () => undefined;
    fns.setSetting.mockReturnValue(new Promise((r) => { finish = r; }));
    render(<ProfileTab />);
    const box = await screen.findByDisplayValue('SAVED PROFILE');
    fireEvent.click(screen.getAllByText('Save')[0]);
    fireEvent.change(box, { target: { value: 'TYPED DURING THE SAVE' } });
    fns.getIdentity.mockClear();
    finish(ok({}));
    await waitFor(() => expect(screen.queryByText('Saving...')).toBeNull());
    expect(fns.getIdentity).not.toHaveBeenCalled();
    expect(screen.getByDisplayValue('TYPED DURING THE SAVE')).toBeTruthy();
  });
});
