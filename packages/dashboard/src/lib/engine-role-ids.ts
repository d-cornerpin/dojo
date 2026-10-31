// Which agents are the Dreamer and the Healer is a setting (dreamer_agent_id / healer_agent_id), never a
// fixed name. The orb and the jobs list ask here. A failed read is not cached, so the next ask retries
// (the callers ask again on every socket reconnect).
import { getSetting } from './api';

export type EngineRole = 'dreamer' | 'healer';

let known: { dreamer: string | null; healer: string | null } | null = null;
let inflight: Promise<void> | null = null;

/** Read the two role ids once; resolves when they are known (or the read failed, leaving them unknown). */
export const loadEngineRoleIds = (): Promise<void> => {
  if (known) return Promise.resolve();
  if (!inflight) {
    inflight = (async () => {
      try {
        const [d, h] = await Promise.all([getSetting('dreamer_agent_id'), getSetting('healer_agent_id')]);
        if (d?.ok && h?.ok) known = { dreamer: d.data.value || null, healer: h.data.value || null };
      } catch { /* stays unknown; the next ask retries */ }
      inflight = null;
    })();
  }
  return inflight;
};

/** The engine role an agent id plays, or null (also null while the ids are not yet known). */
export const engineRoleOf = (agentId: string): EngineRole | null => {
  if (!known) return null;
  if (known.dreamer && agentId === known.dreamer) return 'dreamer';
  if (known.healer && agentId === known.healer) return 'healer';
  return null;
};

/** For tests: forget what was read. */
export const resetEngineRoleIds = (): void => { known = null; inflight = null; };
