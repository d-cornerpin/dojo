import type { Model } from '@dojo/shared';
import { request } from './door';

/** May this model appear in an agent's model picker? Enabled and a chat model; a too-small one appears, disabled. */
export const isListedAgentModel = (m: Model): boolean => m.isEnabled && !m.notAChatModel;

/** May a person choose this model for an agent? Enabled, and the server names no reason against it. */
export const isPickableAgentModel = (m: Model): boolean => m.isEnabled && !m.notForAgents;

/** The cheapest pickable model the server accepts for an agent, free ones first, or '' when none. */
export async function defaultRoleModel(models: readonly Model[]): Promise<string> {
  const byCost = [...models].filter(isPickableAgentModel)
    .sort((a, b) => (a.inputCostPerM ?? 0) - (b.inputCostPerM ?? 0));
  for (const m of byCost) {
    const r = await request<{ refused: string | null }>(`/setup/model-fit/${encodeURIComponent(m.id)}`);
    if (r.ok && !r.data.refused) return m.id;
  }
  return '';
}

/** Save a role agent's model, name and id. The model goes first so a refusal writes nothing else;
 *  returns the server's sentence when it refused and any later write that fails. */
export async function saveRoleAgent(role: 'pm' | 'trainer', name: string, modelId: string): Promise<string | null> {
  const put = (key: string, value: string) => request(`/config/settings/${key}`, { method: 'PUT', body: JSON.stringify({ value }) });
  if (name.trim() && modelId) {
    const r = await put(`${role}_agent_model`, modelId);
    if (!r.ok) return r.error;
  }
  if (name.trim()) {
    const nm = await put(`${role}_agent_name`, name.trim());
    if (!nm.ok) return nm.error;
    const id = await put(`${role}_agent_id`, name.trim().toLowerCase().replace(/[^a-z0-9]/g, '-'));
    if (!id.ok) return id.error;
  }
  return null;
}
