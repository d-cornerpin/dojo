import { useCallback, useEffect, useRef } from 'react';
import { useWebSocket } from '../../hooks/useWebSocket';
import { listActiveGenerationJobs, type GenJobDto } from '../../lib/api';
import { engineRoleOf, loadEngineRoleIds } from '../../lib/engine-role-ids';
import { useOrbReconnectRecovery } from './useOrbReconnectRecovery';
import { useDojoOrb } from './OrbProvider';
import type { OrbTaskName } from './dojoOrbEngine';

/*
 * Drives the orb's task indicator from real engine work (Phase 7).
 *
 * The orb shows one task at a time: a spinning glyph inside the glass (plus a
 * progress line for measured "jobs"). We source the active set the same way
 * ActiveJobsIndicator does:
 *   - media generation jobs (image / audio / music / video) via the
 *     generation_job:update + video_job:update events (refetch the active
 *     list on any update, since events are rare and the list is authoritative)
 *   - engine sequences (compaction / dreamer / healer) via engine:activity,
 *     plus agent:status for the dreamer/healer agents.
 * Media jobs take priority over engine agents; when nothing is active we end
 * the task. chat:error nudges the orb to a "confused" demeanor.
 *
 * v3.5 field fix 3 (#10): an agent's memory work (kind `compaction` with an
 * `agentId`) is shown only while that agent is the one being viewed. The orb
 * speaks for the agent on screen, so a service agent's housekeeping (the PM's,
 * the Healer's) no longer reads as the owner's agent compacting. Work that
 * belongs to the box (no `agentId`, the nightly maintenance) and the Dreamer's
 * and Healer's own glyphs stay box-wide.
 */

import type { EngineItem } from './useOrbReconnectRecovery';
type EngineKind = EngineItem['kind'];

function jobToTask(kind: GenJobDto['kind']): OrbTaskName {
  return kind === 'music' ? 'song' : kind;
}

/** Is this engine item the viewed agent's to show? (header, field fix 3 #10) */
function shownFor(item: EngineItem, viewedAgentId: string | undefined): boolean {
  return item.kind !== 'compaction' || !item.agentId || item.agentId === viewedAgentId;
}

export function useOrbActivity(viewedAgentId?: string): void {
  const dojoOrb = useDojoOrb();
  const viewedRef = useRef(viewedAgentId);
  viewedRef.current = viewedAgentId;
  const { subscribe, reconnectCount } = useWebSocket();
  const jobsRef = useRef<GenJobDto[]>([]);
  const engineRef = useRef<EngineItem[]>([]);
  const currentRef = useRef<OrbTaskName | null>(null);

  const sync = useCallback(() => {
    const job = jobsRef.current[0];
    const eng = engineRef.current.find((it) => shownFor(it, viewedRef.current));
    const next: OrbTaskName | null = job ? jobToTask(job.kind) : eng ? eng.kind : null;
    if (next === currentRef.current) return;
    if (next) {
      // GenJobDto carries no percentage, so jobs run as an indeterminate sweep;
      // dreamer/healer ignore the progress line by design (ambient demeanor).
      dojoOrb.startTask(next, { progress: -1 });
    } else {
      dojoOrb.endTask();
    }
    currentRef.current = next;
  }, [dojoOrb]);

  // Another agent on screen: its own memory work, not the last one's (field fix 3 #10).
  useEffect(() => { sync(); }, [viewedAgentId, sync]);

  // A new orb engine (or a remount) has no task running: forget what the old one was told.
  useEffect(() => () => { currentRef.current = null; }, [dojoOrb]);

  // Latest-issued wins: an older list landing late must not overwrite a newer one.
  const latestRefetch = useRef(0);
  const refetch = useCallback(async () => {
    const mine = ++latestRefetch.current;
    const r = await listActiveGenerationJobs();
    if (mine !== latestRefetch.current) return;
    if (r.ok) jobsRef.current = r.data;
    sync();
  }, [sync]);

  useOrbReconnectRecovery(reconnectCount, engineRef, sync, refetch);

  // Which agents are the Dreamer and the Healer is a setting; a failed read is asked again on a reconnect.
  useEffect(() => { void loadEngineRoleIds(); }, [reconnectCount]);

  useEffect(() => {
    void refetch();

    const unsubGen = subscribe('generation_job:update', () => { void refetch(); });
    const unsubVideo = subscribe('video_job:update', () => { void refetch(); });

    const unsubEngine = subscribe('engine:activity', (event) => {
      if (event.type !== 'engine:activity') return;
      const d = event.data;
      if (d.phase === 'start') {
        if (!engineRef.current.some((it) => it.id === d.id)) {
          engineRef.current = [...engineRef.current, { id: d.id, kind: d.kind, agentId: d.agentId }];
        }
      } else {
        engineRef.current = engineRef.current.filter((it) => it.id !== d.id);
      }
      sync();
    });

    const unsubStatus = subscribe('agent:status', (event) => {
      if (event.type !== 'agent:status') return;
      const kind: EngineKind | null = engineRoleOf(event.agentId);
      if (!kind) return;
      const id = event.agentId;
      if (event.status === 'working') {
        if (!engineRef.current.some((it) => it.id === id)) {
          engineRef.current = [...engineRef.current, { id, kind }];
        }
      } else {
        engineRef.current = engineRef.current.filter((it) => it.id !== id);
      }
      sync();
    });

    const unsubErr = subscribe('chat:error', () => { dojoOrb.setEmotion('confused'); });

    return () => { unsubGen(); unsubVideo(); unsubEngine(); unsubStatus(); unsubErr(); };
  }, [subscribe, refetch, sync, dojoOrb]);
}
