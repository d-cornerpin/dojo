// When the tool catalog or the connected-account list could not be read, the Access panel says so with a
// Retry and the controls that depend on them do nothing: "Individual" never turns "every tool group"
// into an empty list, and an empty account list is never shown as "nothing is connected".
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const getAccessCatalog = vi.hoisted(() => vi.fn());
const request = vi.hoisted(() => vi.fn());
const updateAgentConfig = vi.hoisted(() => vi.fn());
vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../lib/api');
  return { ...actual, getAccessCatalog, request, updateAgentConfig };
});
vi.mock('../hooks/useToast', async () => {
  const { fakeToast } = await import('./helpers/frames');
  const stub = fakeToast();
  return { useToast: () => stub.value };
});
vi.mock('../components/TechniqueSelector', () => ({ TechniqueSelector: () => null }));

import { AccessPanel } from '../components/AccessPanel';
import type { AgentDetail } from '@dojo/shared';

const grants = {
  v: 1,
  tools: { categories: '*', allow: [], deny: [] },
  integrations: { plaud: false, credentials: false, google: { agent: 'read', user: 'read' }, microsoft: { agent: 'none', user: 'none' } },
  channels: { master: true, imessage: 'owner', sms: 'none', voice: 'none', email: 'none', teams: 'none' },
  techniques: '*',
};
const agent = { id: 'a', name: 'Agent-One', effectiveGrants: grants, permissions: {}, toolsPolicy: null, config: {} } as unknown as AgentDetail;
const CATALOG = { ok: true, data: { categories: [{ label: 'Files (read)', tools: 2 }], presets: [], channelGroups: {}, techniques: [] } };

beforeEach(() => {
  getAccessCatalog.mockReset(); request.mockReset(); updateAgentConfig.mockReset();
  localStorage.setItem('agent.access.collapse', JSON.stringify({ access: false, do: false, reach: false }));
  request.mockResolvedValue({ ok: true, data: { accounts: [] } });
});
const mount = () => render(<AccessPanel agent={agent} onUpdated={() => {}} manifestEditable={false} manifestNote="" />);

describe('the Access panel', () => {
  it('a failed catalog says so, and Individual does not strip the tool groups', async () => {
    getAccessCatalog.mockResolvedValue({ ok: false, error: 'down' });
    mount();
    await screen.findByText(/Could not load the tool list/);
    expect(screen.getByText('Retry')).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: 'Individual tool access' }));
    expect(screen.getByRole('radio', { name: 'Full tool access' }).getAttribute('aria-checked')).toBe('true');
    expect((screen.getByText('Save access') as HTMLButtonElement).disabled).toBe(true);
    expect(updateAgentConfig).not.toHaveBeenCalled();
  });

  it('a failed account list says so instead of "Nothing is connected yet"', async () => {
    getAccessCatalog.mockResolvedValue(CATALOG);
    request.mockImplementation(async (path: string) => path === '/google/status' ? { ok: false, error: 'down' } : { ok: true, data: { accounts: [] } });
    mount();
    await screen.findByText(/Could not load your connected Google accounts/);
    expect(screen.getAllByText(/Nothing is connected yet/).length).toBe(2);   // Microsoft only (two kinds); Google is not claimed empty
  });

  it('Retry reloads the catalog', async () => {
    getAccessCatalog.mockResolvedValueOnce({ ok: false, error: 'down' }).mockResolvedValue(CATALOG);
    mount();
    fireEvent.click(await screen.findByText('Retry'));
    await waitFor(() => expect(screen.queryByText(/Could not load the tool list/)).toBeNull());
  });
});
