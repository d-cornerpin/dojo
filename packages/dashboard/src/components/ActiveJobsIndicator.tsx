import { useEffect, useState, useCallback } from 'react';
import { useWebSocket } from '../hooks/useWebSocket';
import { listActiveGenerationJobs, cancelGenerationJob, type GenJobDto } from '../lib/api';
import { formatElapsed } from '../lib/dates';

// ════════════════════════════════════════
// ActiveJobsIndicator — in-flight media generation jobs (image / audio /
// music / video).
//
// Lives in the chat input icon row (next to voice / wordy mode). Hidden
// entirely when the current agent has no active jobs. When one or more are
// in flight it shows a spinning icon with a count badge; clicking opens a
// popover listing each job with a per-row Stop. The icon reflects the kind
// when a single kind is in flight, falling back to a generic spinner when
// kinds are mixed.
//
// State is kept fresh two ways: an initial fetch on mount, and the
// `video_job:update` + `generation_job:update` WebSocket events. On any
// update we refetch the merged active list (events are rare, so a refetch
// is cheap and keeps the list authoritative instead of merging partials).
// ════════════════════════════════════════

// Elapsed from a client-side millisecond timestamp. Engine-activity items are
// purely event-driven (no DB row to refetch), so we stamp the moment the
// 'start' event arrives.
function elapsedFromMs(startedAtMs: number): string {
  const secs = Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  return `${mins}m ${rem}s`;
}

type Kind = GenJobDto['kind'];

// Engine-managed background sequences surfaced alongside media jobs. These are
// not user-cancellable (no Stop button) and show regardless of selected agent.
type EngineKind = 'compaction' | 'dreamer' | 'healer';
interface EngineItem {
  id: string;
  kind: EngineKind;
  label: string;
  startedAtMs: number;
}

const KIND_LABEL: Record<Kind, string> = {
  image: 'image',
  audio: 'audio',
  music: 'music',
  video: 'video',
};

function statusLabel(job: GenJobDto): string {
  if (job.status === 'queued') return 'Queued';
  if (job.kind === 'video') return 'Rendering';
  if (job.kind === 'image') return 'Generating';
  return 'Generating';
}

// Per-kind glyph (Lucide paths). Each is rendered inside a spinning <svg>.
function KindGlyph({ kind }: { kind: Kind | EngineKind | 'mixed' }) {
  const common = {
    width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none',
    stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const, className: 'animate-spin',
    style: { animationDuration: '3s' },
  };
  if (kind === 'video') {
    return (
      <svg {...common}>
        <rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18" />
        <line x1="7" y1="2" x2="7" y2="22" />
        <line x1="17" y1="2" x2="17" y2="22" />
        <line x1="2" y1="12" x2="22" y2="12" />
        <line x1="2" y1="7" x2="7" y2="7" />
        <line x1="2" y1="17" x2="7" y2="17" />
        <line x1="17" y1="17" x2="22" y2="17" />
        <line x1="17" y1="7" x2="22" y2="7" />
      </svg>
    );
  }
  if (kind === 'image') {
    return (
      <svg {...common}>
        <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
        <circle cx="8.5" cy="8.5" r="1.5" />
        <polyline points="21 15 16 10 5 21" />
      </svg>
    );
  }
  if (kind === 'music') {
    return (
      <svg {...common}>
        <path d="M9 18V5l12-2v13" />
        <circle cx="6" cy="18" r="3" />
        <circle cx="18" cy="16" r="3" />
      </svg>
    );
  }
  if (kind === 'audio') {
    // Waveform-ish (Lucide audio-lines).
    return (
      <svg {...common}>
        <path d="M2 10v3" />
        <path d="M6 6v11" />
        <path d="M10 3v18" />
        <path d="M14 8v7" />
        <path d="M18 5v13" />
        <path d="M22 10v3" />
      </svg>
    );
  }
  if (kind === 'compaction') {
    // Archive box — folding memory into summaries.
    return (
      <svg {...common}>
        <polyline points="21 8 21 21 3 21 3 8" />
        <rect x="1" y="3" width="22" height="5" />
        <line x1="10" y1="12" x2="14" y2="12" />
      </svg>
    );
  }
  if (kind === 'dreamer') {
    // Moon — the dream / distillation cycle.
    return (
      <svg {...common}>
        <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
      </svg>
    );
  }
  if (kind === 'healer') {
    // Activity pulse line.
    return (
      <svg {...common}>
        <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
      </svg>
    );
  }
  // mixed — generic sparkles.
  return (
    <svg {...common}>
      <path d="M12 3v18" />
      <path d="M3 12h18" />
      <path d="M5.6 5.6l12.8 12.8" />
      <path d="M18.4 5.6L5.6 18.4" />
    </svg>
  );
}

export const ActiveJobsIndicator = ({ agentId }: { agentId: string }) => {
  const { subscribe } = useWebSocket();
  const [jobs, setJobs] = useState<GenJobDto[]>([]);
  const [engineItems, setEngineItems] = useState<EngineItem[]>([]);
  const [open, setOpen] = useState(false);
  const [cancelling, setCancelling] = useState<Set<string>>(new Set());
  // Drives the elapsed-time re-render once a second while the popover is open.
  const [, setTick] = useState(0);

  const refetch = useCallback(async () => {
    const res = await listActiveGenerationJobs();
    if (res.ok) {
      setJobs(res.data.filter((j) => j.agentId === agentId));
    }
  }, [agentId]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  useEffect(() => {
    const unsubVideo = subscribe('video_job:update', (event) => {
      if (event.type !== 'video_job:update') return;
      if (event.data.agentId !== agentId) return;
      void refetch();
    });
    const unsubGen = subscribe('generation_job:update', (event) => {
      if (event.type !== 'generation_job:update') return;
      if (event.data.agentId !== agentId) return;
      void refetch();
    });
    // Engine sequences are platform-wide, shown regardless of the selected
    // agent. Dreamer + Healer are agents, so their `working` status IS the
    // in-flight signal; compaction (not an agent) emits engine:activity.
    const unsubStatus = subscribe('agent:status', (event) => {
      if (event.type !== 'agent:status') return;
      if (event.agentId !== 'dreamer' && event.agentId !== 'healer') return;
      const kind: EngineKind = event.agentId === 'dreamer' ? 'dreamer' : 'healer';
      const label = event.agentId === 'dreamer'
        ? 'Dreaming (distilling memory)'
        : 'Healer running diagnostics';
      const who = event.agentId;
      setEngineItems((prev) => {
        if (event.status === 'working') {
          if (prev.some((it) => it.id === who)) return prev;
          return [...prev, { id: who, kind, label, startedAtMs: Date.now() }];
        }
        return prev.filter((it) => it.id !== who);
      });
    });
    const unsubEngine = subscribe('engine:activity', (event) => {
      if (event.type !== 'engine:activity') return;
      const d = event.data;
      setEngineItems((prev) => {
        if (d.phase === 'start') {
          if (prev.some((it) => it.id === d.id)) return prev;
          return [...prev, { id: d.id, kind: d.kind, label: d.label, startedAtMs: Date.now() }];
        }
        return prev.filter((it) => it.id !== d.id);
      });
    });
    return () => { unsubVideo(); unsubGen(); unsubStatus(); unsubEngine(); };
  }, [subscribe, agentId, refetch]);

  // Tick once a second only while the popover is open, so elapsed times stay live.
  useEffect(() => {
    if (!open) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [open]);

  // Close the popover automatically once everything finishes.
  useEffect(() => {
    if (jobs.length === 0 && engineItems.length === 0 && open) setOpen(false);
  }, [jobs.length, engineItems.length, open]);

  const handleCancel = useCallback(async (job: GenJobDto) => {
    setCancelling((prev) => new Set(prev).add(job.id));
    await cancelGenerationJob(job.id, job.kind);
    // The cancel broadcast triggers a refetch, but refetch defensively too.
    await refetch();
    setCancelling((prev) => {
      const next = new Set(prev);
      next.delete(job.id);
      return next;
    });
  }, [refetch]);

  if (jobs.length === 0 && engineItems.length === 0) return null;

  const total = jobs.length + engineItems.length;

  // Pick the badge icon over media + engine kinds: a single kind shows its
  // glyph; a mix shows a generic spinner.
  const kinds = new Set<Kind | EngineKind>([
    ...jobs.map((j) => j.kind),
    ...engineItems.map((e) => e.kind),
  ]);
  const iconKind: Kind | EngineKind | 'mixed' = kinds.size === 1 ? [...kinds][0] : 'mixed';

  // Headline: media-only keeps its noun; anything with engine work reads as
  // "background activity".
  const headlineNoun =
    engineItems.length > 0
      ? 'background activity'
      : iconKind === 'mixed'
        ? 'media'
        : KIND_LABEL[iconKind as Kind];

  return (
    <>
      <button
        type="button"
        onPointerDown={(e) => e.preventDefault()}
        onClick={() => setOpen(true)}
        title={`${total} ${headlineNoun}${total > 1 ? ' items' : ''} in progress (click for details)`}
        className="relative shrink-0 flex items-center justify-center w-9 h-9 rounded-full transition-all bg-cp-purple/20 text-cp-purple hover:bg-cp-purple/30"
      >
        <KindGlyph kind={iconKind} />
        {total > 1 && (
          <span className="absolute -top-1 -right-1 flex items-center justify-center min-w-[16px] h-4 px-1 rounded-full bg-cp-purple text-white text-[10px] font-semibold">
            {total}
          </span>
        )}
      </button>

      {open && (
        <>
          {/* Invisible click-catcher so clicking anywhere else closes the
              popover. Sits below the popover, above everything else. */}
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          {/* Popover anchored to the input panel: bottom edge pinned just
              above the panel's top edge, flush to the right. The nearest
              positioned ancestor is the ChatInput panel wrapper (relative),
              not this button, so right-0 / bottom-full resolve against the
              panel. */}
          <div
            className="glass-modal-bg absolute bottom-full right-0 mb-2 z-50 w-80 max-w-[calc(100vw-1.5rem)] p-4 rounded-2xl shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-semibold text-ui/90">
                In progress{total > 1 ? ` (${total})` : ''}
              </h3>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="text-ui/40 hover:text-ui/80 transition-colors"
                title="Close"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>

            <div className="space-y-3">
              {jobs.map((job) => (
                <div key={job.id} className="flex items-start gap-3 p-3 rounded-xl bg-ui/[0.05]">
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-ui/85 line-clamp-2">
                      {job.title || job.prompt}
                    </p>
                    <div className="mt-1 flex items-center gap-2 text-[11px] text-ui/45">
                      <span className="inline-flex items-center gap-1">
                        <span className="inline-block w-1.5 h-1.5 rounded-full bg-cp-purple animate-pulse" />
                        {statusLabel(job)}
                      </span>
                      {iconKind === 'mixed' && (
                        <>
                          <span>·</span>
                          <span className="capitalize">{KIND_LABEL[job.kind]}</span>
                        </>
                      )}
                      <span>·</span>
                      <span>{formatElapsed(job.startedAt)}</span>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => { void handleCancel(job); }}
                    disabled={cancelling.has(job.id)}
                    className="shrink-0 px-2.5 py-1 rounded-lg text-[11px] font-medium bg-cp-coral/15 text-cp-coral hover:bg-cp-coral/25 transition-colors disabled:opacity-40"
                  >
                    {cancelling.has(job.id) ? 'Stopping…' : 'Stop'}
                  </button>
                </div>
              ))}

              {engineItems.map((item) => (
                <div key={item.id} className="flex items-start gap-3 p-3 rounded-xl bg-ui/[0.05]">
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-ui/85 line-clamp-2">{item.label}</p>
                    <div className="mt-1 flex items-center gap-2 text-[11px] text-ui/45">
                      <span className="inline-flex items-center gap-1">
                        <span className="inline-block w-1.5 h-1.5 rounded-full bg-cp-purple animate-pulse" />
                        Engine
                      </span>
                      <span>·</span>
                      <span>{elapsedFromMs(item.startedAtMs)}</span>
                    </div>
                  </div>
                  {/* No Stop button: engine-managed (compaction / dreamer / healer). */}
                </div>
              ))}
            </div>

            <p className="mt-4 text-[11px] text-ui/40 leading-relaxed">
              Media generates in the background and posts to chat when ready. Memory and maintenance run on their own.
            </p>
          </div>
        </>
      )}
    </>
  );
};
