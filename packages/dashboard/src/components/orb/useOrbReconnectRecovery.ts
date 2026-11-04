import { useEffect, useRef, type MutableRefObject } from 'react';
import { getAgents } from '../../lib/api';
import { engineRoleOf, loadEngineRoleIds } from '../../lib/engine-role-ids';

/** `agentId`: whose work it is (null or absent: the box's own, like the nightly maintenance). */
export interface EngineItem { id: string; kind: 'compaction' | 'dreamer' | 'healer'; agentId?: string | null; }

/** After a reconnect, rebuild the orb's engine items from what the agents are doing now. */
export function useOrbReconnectRecovery(
  reconnectCount: number,
  engineRef: MutableRefObject<EngineItem[]>,
  sync: () => void,
  refetch: () => Promise<void>,
): void {
  // Frames sent while the socket was down are gone: forget the engine items we were holding.
  const seenReconnect = useRef(reconnectCount);
  const latestEngineRead = useRef(0);
  useEffect(() => {
    if (seenReconnect.current === reconnectCount) return;
    seenReconnect.current = reconnectCount;
    const mine = ++latestEngineRead.current;
    engineRef.current = [];
    sync();
    void refetch();
    void (async () => {
      await loadEngineRoleIds();
      const r = await getAgents();
      if (mine !== latestEngineRead.current || !r.ok) return;
      const working: EngineItem[] = [];
      for (const a of r.data) {
        const kind = engineRoleOf(a.id);
        if (kind && a.status === 'working') working.push({ id: a.id, kind });
      }
      engineRef.current = [...working, ...engineRef.current.filter((it) => !working.some((w) => w.id === it.id))];
      sync();
    })();
  }, [reconnectCount, refetch, sync]);
}
