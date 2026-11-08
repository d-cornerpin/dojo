// ── v3.5 (fix round 1): choosing a model for an agent, the way the server will judge it ──
//
// The Dojo's decision model answers yes/no questions; it is never an agent's, a tier's or the voice
// opener's model, so no picker offers it. A role agent's default is the cheapest model the server would
// ACCEPT for an agent (the memory fit and the 32K floor), asked of the server rather than guessed here,
// and a save that the server refuses says why instead of saying "saved".
import type { Model } from '@dojo/shared';
import { request } from './door';

/** May a person pick this model for an agent? (Enabled, and not the Dojo's decision model.) */
export const isPickableAgentModel = (m: Model): boolean => m.isEnabled && !m.capabilities.includes('decision');

/** The cheapest pickable model the server accepts for an agent — free ones first — or '' when none does. */
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
