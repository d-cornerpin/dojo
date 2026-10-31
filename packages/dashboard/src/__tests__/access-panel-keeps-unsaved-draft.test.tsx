// Unsaved edits on the Access panel survive a parent refetch that hands back the same stored
// access under new object identities (what happens after the equipped-technique picker saves and
// the page reloads the agent). A genuinely different stored value still replaces the draft.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import type { AgentDetail } from '@dojo/shared';
import { MOST_RESTRICTIVE_GRANTS } from '@dojo/shared';

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../lib/api');
  return {
    ...actual,
    getAccessCatalog: vi.fn(async () => ({ ok: true, data: { categories: [], techniques: [], presets: [], channelGroups: {} } })),
    request: vi.fn(async () => ({ ok: true, data: { accounts: [] } })),
    updateAgentConfig: vi.fn(async () => ({ ok: true, data: {} })),
  };
});
vi.mock('../hooks/useToast', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }) }));

import { AccessPanel } from '../components/AccessPanel';

const grantsWith = (categories: '*' | string[]) => {
  const g = JSON.parse(JSON.stringify(MOST_RESTRICTIVE_GRANTS));
  g.tools.categories = categories;
  return g;
};
const agentWith = (categories: '*' | string[]): AgentDetail => ({
  id: 'a1', name: 'Dock Desk', permissions: null, toolsPolicy: null, config: {}, equippedTechniques: [],
  effectiveGrants: grantsWith(categories),
} as unknown as AgentDetail);

const panel = (agent: AgentDetail) => (
  <AccessPanel agent={agent} onUpdated={() => {}} manifestEditable={false} manifestNote="" />
);
const radio = (name: string) => screen.getByRole('radio', { name });

beforeEach(() => {
  localStorage.setItem('agent.access.collapse', JSON.stringify({ access: false, do: false }));
});

describe('the Access panel keeps unsaved edits across a parent refetch', () => {
  it('keeps the draft when the stored access is the same content in new objects', async () => {
    const { rerender } = render(panel(agentWith('*')));
    await waitFor(() => expect(radio('Full tool access').getAttribute('aria-checked')).toBe('true'));
    fireEvent.click(radio('Individual tool access'));
    expect(radio('Individual tool access').getAttribute('aria-checked')).toBe('true');
    expect((screen.getByText('Save access') as HTMLButtonElement).disabled).toBe(false);

    rerender(panel(agentWith('*')));
    expect(radio('Individual tool access').getAttribute('aria-checked')).toBe('true');
    expect((screen.getByText('Save access') as HTMLButtonElement).disabled).toBe(false);
  });

  it('follows genuinely different stored access', async () => {
    const { rerender } = render(panel(agentWith('*')));
    await waitFor(() => expect(radio('Full tool access').getAttribute('aria-checked')).toBe('true'));
    fireEvent.click(radio('Individual tool access'));
    rerender(panel(agentWith([])));
    await waitFor(() => expect(radio('Individual tool access').getAttribute('aria-checked')).toBe('true'));
    expect((screen.getByText('Save access') as HTMLButtonElement).disabled).toBe(true);
    rerender(panel(agentWith('*')));
    await waitFor(() => expect(radio('Full tool access').getAttribute('aria-checked')).toBe('true'));
  });
});
