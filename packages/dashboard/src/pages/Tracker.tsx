import { useState, useEffect, useCallback, useRef } from 'react';
import { Link } from 'react-router-dom';
import type { Project, Task, AgentDetail } from '@dojo/shared';
import type { WsEvent, TrackerTaskUpdatedEvent, TrackerProjectUpdatedEvent } from '@dojo/shared';
import * as api from '../lib/api';
import { formatDate } from '../lib/dates';
import { isEnterNotComposing } from '../lib/enter-key';
import { useWebSocket } from '../hooks/useWebSocket';
import { useToast } from '../hooks/useToast';
import { cardMover } from './tracker-card-move';
import { KanbanBoard } from '../components/KanbanBoard';
import { HOLD_WORDS, STATUS_WORDS, entryWords, statusWords, whoWords } from '../lib/task-status';
import { TaskRunHistory } from '../components/TaskRunHistory';
import { TaskScheduleForm, DEFAULT_SCHEDULE, type ScheduleConfig } from '../components/TaskScheduleForm';
import { ModalShell } from '../components/ModalShell';

// ── Task Detail Slide-Out Panel ──

export const TaskDetailPanel = ({
  task,
  agents,
  allTasks,
  onClose,
  onUpdate,
}: {
  task: Task;
  agents: AgentDetail[];
  allTasks: Task[];
  onClose: () => void;
  onUpdate: () => void;
}) => {
  const toast = useToast();
  const [status, setStatus] = useState<string>(task.hold ?? task.status);
  const [priority, setPriority] = useState(task.priority);
  const [assignedTo, setAssignedTo] = useState(task.assignedTo || '');
  const [noteInput, setNoteInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [decisionReason, setDecisionReason] = useState('');
  const [logEntries, setLogEntries] = useState<api.TaskLogEntry[]>([]);
  const [logLoading, setLogLoading] = useState(false);

  useEffect(() => {
    setStatus(task.hold ?? task.status);
    setPriority(task.priority);
    setAssignedTo(task.assignedTo || '');
  }, [task]);

  // Load the structured audit log for this task.
  useEffect(() => {
    let cancelled = false;
    setLogLoading(true);
    api.getTaskLog(task.id, { limit: 50 }).then((res) => {
      if (cancelled) return;
      if (res.ok) setLogEntries(res.data);
      setLogLoading(false);
    });
    return () => { cancelled = true; };
  }, [task.id, task.updatedAt]);

  const handleFieldUpdate = async (updates: Record<string, string | null | undefined>): Promise<boolean> => {
    setSaving(true);
    const result = await api.updateTask(task.id, updates);
    if (result.ok) {
      onUpdate();
    } else {
      toast.error(result.error ?? 'The change could not be saved.');
    }
    setSaving(false);
    return result.ok;
  };

  const handleAddNote = async () => {
    if (!noteInput.trim()) return;
    setSaving(true);
    // User observations go into task_log as entries, not the legacy tasks.notes column.
    const result = await api.addTaskObservation(task.id, noteInput.trim());
    if (result.ok) {
      setNoteInput('');
      // Refresh the task_log feed.
      const logRes = await api.getTaskLog(task.id, { limit: 50 });
      if (logRes.ok) setLogEntries(logRes.data);
      onUpdate();
    } else {
      toast.error(result.error ?? 'That did not go through.');
    }
    setSaving(false);
  };

  const priorityColors: Record<string, string> = {
    high: 'text-cp-coral',
    normal: 'text-cp-amber',
    low: 'text-cp-teal',
  };

  return (
    <ModalShell
      onClose={onClose}
      label={task.title}
      backdropClassName="glass-modal-backdrop"
      panelClassName="glass-modal max-w-lg w-full mx-4 max-h-[85vh] overflow-y-auto"
      closeOnEscape={!saving}
      closeOnBackdrop={!saving}
    >
        <div className="p-6 space-y-6">
          {/* Header */}
          <div className="flex items-start justify-between">
            <h2 className="text-lg font-semibold text-ui pr-4">{task.title}</h2>
            <button
              onClick={onClose}
              className="text-ui/40 hover:text-ui/70 transition-colors text-xl leading-none"
            >
              &times;
            </button>
          </div>

          {/* Description */}
          {task.description && (
            <div>
              <h3 className="text-xs font-semibold text-ui/55 uppercase tracking-wide mb-1">Description</h3>
              <p className="text-sm text-ui/70 whitespace-pre-wrap">{task.description}</p>
            </div>
          )}

          {/* Goal, result and evidence: what a decider reads before deciding. */}
          {(task.goal || task.result || task.evidence.length > 0) && (
            <div className="space-y-3 glass-nested rounded-lg p-3 border border-ui/10">
              {task.goal && (
                <div>
                  <h3 className="text-xs font-semibold text-ui/55 uppercase tracking-wide mb-1">Goal</h3>
                  <p className="text-sm text-ui/80 whitespace-pre-wrap">{task.goal}</p>
                </div>
              )}
              {task.result && (
                <div>
                  <h3 className="text-xs font-semibold text-ui/55 uppercase tracking-wide mb-1">Agent result</h3>
                  <p className="text-sm text-ui/80 whitespace-pre-wrap">{task.result}</p>
                </div>
              )}
              {task.evidence.length > 0 && (
                <div>
                  <h3 className="text-xs font-semibold text-ui/55 uppercase tracking-wide mb-1">Evidence</h3>
                  <div className="space-y-1.5">
                    {task.evidence.map((ev, i) => {
                      const { kind, ...rest } = ev;
                      const detail = Object.entries(rest)
                        .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
                        .join(' / ');
                      return (
                        <div key={i} className="text-xs">
                          <span className="text-cp-amber uppercase tracking-wide mr-2">{kind}</span>
                          <span className="text-ui/70 whitespace-pre-wrap">{detail || '(no detail)'}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Status */}
          <div>
            <h3 className="text-xs font-semibold text-ui/55 uppercase tracking-wide mb-1">Status</h3>
            <select
              value={status}
              onChange={async (e) => {
                const prevStatus = status;
                const newStatus = e.target.value;
                setStatus(newStatus);
                const ok = await handleFieldUpdate({ status: newStatus });
                if (!ok) setStatus(prevStatus);
              }}
              disabled={saving}
              className="glass-select w-full"
            >
              <option value="on_deck">{STATUS_WORDS.on_deck}</option>
              <option value="in_progress">{STATUS_WORDS.in_progress}</option>
              <option value="paused">{HOLD_WORDS.paused}</option>
              <option value="blocked">{HOLD_WORDS.blocked}</option>
              {(['handed_in', 'sent_back', 'fallen'] as string[]).includes(task.status) && <option value={task.status} disabled>{STATUS_WORDS[task.status]}</option>}
              <option value="complete">{STATUS_WORDS.complete}</option>
              <option value="cancelled">{STATUS_WORDS.cancelled}</option>
            </select>
            {task.status === 'handed_in' && (
              <div className="mt-2 glass-nested rounded-lg p-2 border border-cp-amber/30">
                <div className="text-xs text-cp-amber mb-1">Handed in: waiting for a decision</div>
                {task.handIn && (
                  <div className="text-xs text-ui/70 mb-2 space-y-1">
                    <div className="whitespace-pre-wrap">{task.handIn.outcome === 'finished' ? 'Finished' : "Can't be done"}: {task.handIn.note}</div>
                    {task.handIn.proof.map((line, i) => <div key={i} className="whitespace-pre-wrap">{i + 1}. {line}</div>)}
                  </div>
                )}
                <input
                  value={decisionReason}
                  onChange={(e) => setDecisionReason(e.target.value)}
                  placeholder="Reason, one line"
                  className="w-full px-2 py-1 text-xs glass-input rounded"
                />
                <div className="flex gap-2 mt-2">
                  {(['approve', 'send_back'] as const).map((verdict) => (
                    <button
                      key={verdict}
                      onClick={async () => {
                        setSaving(true);
                        const res = await api.decideTask(task.id, verdict, decisionReason);
                        if (res.ok) { setDecisionReason(''); onUpdate(); } else toast.error(res.error ?? 'That did not go through.');
                        setSaving(false);
                      }}
                      disabled={saving || decisionReason.trim() === ''}
                      className="px-2 py-1 text-xs glass-btn-primary rounded disabled:opacity-50"
                    >
                      {verdict === 'approve' ? 'Approve' : 'Send back'}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Priority */}
          <div>
            <h3 className="text-xs font-semibold text-ui/55 uppercase tracking-wide mb-1">Priority</h3>
            <select
              value={priority}
              onChange={async (e) => {
                const prevPriority = priority;
                const newPriority = e.target.value;
                setPriority(newPriority as Task['priority']);
                const ok = await handleFieldUpdate({ priority: newPriority });
                if (!ok) setPriority(prevPriority);
              }}
              disabled={saving}
              className={`glass-select w-full ${priorityColors[priority] || ''}`}
            >
              <option value="high">High</option>
              <option value="normal">Normal</option>
              <option value="low">Low</option>
            </select>
          </div>

          {/* Assigned Agent */}
          <div>
            <h3 className="text-xs font-semibold text-ui/55 uppercase tracking-wide mb-1">Assigned Agent</h3>
            <select
              value={assignedTo}
              onChange={async (e) => {
                const prevAgent = assignedTo;
                const newAgent = e.target.value;
                setAssignedTo(newAgent);
                const ok = await handleFieldUpdate({ assignedTo: newAgent || null });
                if (!ok) setAssignedTo(prevAgent);
              }}
              disabled={saving}
              className="glass-select w-full"
            >
              <option value="">Unassigned</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
            {task.assignedTo && (
              <Link
                to={`/agents/${task.assignedTo}`}
                className="text-xs text-cp-blue hover:text-cp-blue/80 mt-1 inline-block"
              >
                View agent details
              </Link>
            )}
          </div>

          {/* Dependencies */}
          {task.dependsOn.length > 0 && (
            <div>
              <h3 className="text-xs font-semibold text-ui/55 uppercase tracking-wide mb-1">Dependencies</h3>
              <div className="space-y-1">
                {task.dependsOn.map((depId) => {
                  const depTask = allTasks.find(t => t.id === depId);
                  return (
                    <div key={depId} className="text-sm text-ui/55 flex items-center gap-2">
                      <span className={`w-2 h-2 rounded-full shrink-0 ${depTask?.status === 'complete' ? 'bg-cp-teal' : depTask?.status === 'in_progress' ? 'bg-cp-blue' : 'bg-ui/[0.12]'}`} />
                      {depTask?.title ?? depId}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Schedule, editable */}
          <ScheduleEditor task={task} onUpdate={onUpdate} />

          {/* Run History */}
          {task.scheduleStatus && task.scheduleStatus !== 'unscheduled' && task.runCount > 0 && (
            <div>
              <h3 className="text-xs font-semibold text-ui/55 uppercase tracking-wide mb-2">Run History</h3>
              <TaskRunHistory taskId={task.id} />
            </div>
          )}

          {/* Meta */}
          <div className="text-xs text-ui/40 space-y-1">
            {task.stepNumber && (
              <div>Step {task.stepNumber}{task.totalSteps ? ` of ${task.totalSteps}` : ''}</div>
            )}
            <div>Created: {formatDate(task.createdAt)}</div>
            <div>Updated: {formatDate(task.updatedAt)}</div>
            {task.completedAt && <div>Completed: {formatDate(task.completedAt)}</div>}
          </div>

          {/* Activity log: task_log entries, newest first. */}
          <div>
            <h3 className="text-xs font-semibold text-ui/55 uppercase tracking-wide mb-2">Activity log</h3>
            {logLoading ? (
              <div className="text-sm text-ui/55 italic">loading...</div>
            ) : logEntries.length === 0 ? (
              <div className="text-sm text-ui/55 italic">no entries yet</div>
            ) : (
              <div className="glass-nested rounded-xl p-3 mb-3 max-h-72 overflow-y-auto space-y-2">
                {logEntries.map((e) => {
                  const kindColor: Record<string, string> = {
                    transition: 'text-cp-teal',
                    observation: 'text-ui/80',
                    reject: 'text-cp-coral',
                    user_verdict_request: 'text-cp-amber',
                    user_verdict_applied: 'text-cp-teal',
                    auto_sweep: 'text-ui/55',
                    legacy_note: 'text-ui/55',
                  };
                  const k = kindColor[e.entryKind] ?? 'text-ui/70';
                  return (
                    <div key={e.id} className="text-xs text-ui/70 border-l-2 border-ui/20 pl-2">
                      <div className="flex items-baseline gap-2">
                        <span className="text-ui/50">{formatDate(e.createdAt)}</span>
                        <span className="text-ui/55">{whoWords(e.fromEntity, (id) => agents.find((a) => a.id === id)?.name)}</span>
                        <span className={`font-semibold ${k}`}>{entryWords(e.entryKind)}</span>
                        {e.fromStatus && e.toStatus && (
                          <span className="text-ui/55">{statusWords(e.fromStatus)} → {statusWords(e.toStatus)}</span>
                        )}
                      </div>
                      {e.actionTaken && <div className="text-ui/70 mt-0.5">{e.actionTaken}</div>}
                      {e.reason && <div className="text-ui/70 italic mt-0.5">reason: {e.reason}</div>}
                      {e.note && <div className="text-ui/80 mt-1 whitespace-pre-wrap">{e.note}</div>}
                    </div>
                  );
                })}
              </div>
            )}
            <textarea
              value={noteInput}
              onChange={(e) => setNoteInput(e.target.value)}
              placeholder="Add an observation..."
              rows={3}
              className="glass-textarea w-full resize-none"
            />
            <button
              onClick={handleAddNote}
              disabled={saving || !noteInput.trim()}
              className="mt-2 px-3 py-1.5 text-sm glass-btn-primary rounded-lg transition-colors"
            >
              Add observation
            </button>
            {task.notes && (
              <details className="mt-3">
                <summary className="text-xs text-ui/55 cursor-pointer">Earlier notes</summary>
                <pre className="text-xs text-ui/55 whitespace-pre-wrap font-sans mt-2 p-2 glass-nested rounded">{task.notes}</pre>
              </details>
            )}
          </div>
        </div>
    </ModalShell>
  );
};

// ── Create Project Modal ──

interface NewTask {
  title: string;
  description: string;
  priority: string;
  assignedTo: string;
}

const CreateProjectModal = ({
  onClose,
  onCreate,
  agents,
}: {
  onClose: () => void;
  onCreate: () => void;
  agents: AgentDetail[];
}) => {
  const activeAgents = agents.filter(a => a.status !== 'terminated' && a.agentType !== 'archived');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [level, setLevel] = useState(1);
  const [tasks, setTasks] = useState<NewTask[]>([]);
  const [taskTitle, setTaskTitle] = useState('');
  const [taskAssignee, setTaskAssignee] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const addTask = () => {
    if (!taskTitle.trim()) return;
    setTasks([...tasks, { title: taskTitle.trim(), description: '', priority: 'normal', assignedTo: taskAssignee }]);
    setTaskTitle('');
  };

  const removeTask = (index: number) => {
    setTasks(tasks.filter((_, i) => i !== index));
  };

  const handleCreate = async () => {
    if (!title.trim()) return;
    setSaving(true);
    setError(null);

    const result = await api.createProject({
      title: title.trim(),
      description: description.trim() || undefined,
      level,
      tasks: tasks.length > 0
        ? tasks.map((t, i) => ({
            title: t.title,
            description: t.description || undefined,
            priority: t.priority,
            assignedTo: t.assignedTo || undefined,
            stepNumber: i + 1,
          }))
        : undefined,
    });

    if (result.ok) {
      onCreate();
      onClose();
    } else {
      setError(result.error);
    }
    setSaving(false);
  };

  return (
    <ModalShell
      onClose={onClose}
      label="Create Project"
      backdropClassName="glass-modal-backdrop"
      panelClassName="glass-modal p-6 max-w-lg w-full mx-4 max-h-[80vh] overflow-y-auto"
      closeOnEscape={!saving}
      closeOnBackdrop={false}
    >
        <h3 className="text-lg font-semibold text-ui mb-4">Create Project</h3>

        {error && (
          <div className="alert-banner alert-error mb-4">
            {error}
          </div>
        )}

        <div className="space-y-4">
          <div>
            <label className="text-xs font-semibold text-ui/55 uppercase tracking-wide block mb-1">Title</label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Project title"
              className="glass-input w-full"
            />
          </div>

          <div>
            <label className="text-xs font-semibold text-ui/55 uppercase tracking-wide block mb-1">Description</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional description"
              rows={3}
              className="glass-textarea w-full resize-none"
            />
          </div>

          <div>
            <label className="text-xs font-semibold text-ui/55 uppercase tracking-wide block mb-1">Level</label>
            <select
              value={level}
              onChange={(e) => setLevel(Number(e.target.value))}
              className="glass-select w-full"
            >
              <option value={1}>Level 1 - Simple</option>
              <option value={2}>Level 2 - Medium</option>
              <option value={3}>Level 3 - Complex</option>
            </select>
          </div>

          {/* Task builder */}
          <div>
            <label className="text-xs font-semibold text-ui/55 uppercase tracking-wide block mb-1">Tasks</label>
            {tasks.length > 0 && (
              <div className="space-y-1 mb-2">
                {tasks.map((t, i) => (
                  <div key={i} className="flex items-center gap-2 glass-nested rounded-xl px-3 py-2">
                    <span className="text-xs text-ui/40 font-mono w-6">{i + 1}.</span>
                    <span className="text-sm text-ui/90 flex-1 truncate">{t.title}</span>
                    <select
                      value={t.assignedTo}
                      onChange={(e) => {
                        const updated = [...tasks];
                        updated[i] = { ...t, assignedTo: e.target.value };
                        setTasks(updated);
                      }}
                      className="glass-select"
                    >
                      <option value="">Unassigned</option>
                      {activeAgents.map((a) => (
                        <option key={a.id} value={a.id}>{a.name}</option>
                      ))}
                    </select>
                    <button
                      onClick={() => removeTask(i)}
                      className="text-ui/40 hover:text-cp-coral transition-colors text-sm"
                    >
                      &times;
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="flex gap-2">
              <input
                value={taskTitle}
                onChange={(e) => setTaskTitle(e.target.value)}
                placeholder="Add a task..."
                onKeyDown={(e) => isEnterNotComposing(e) && addTask()}
                className="glass-input flex-1"
              />
              <select
                value={taskAssignee}
                onChange={(e) => setTaskAssignee(e.target.value)}
                className="glass-select"
              >
                <option value="">Unassigned</option>
                {activeAgents.map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
              <button
                onClick={addTask}
                disabled={!taskTitle.trim()}
                className="px-3 py-2 text-sm bg-ui/[0.08] hover:bg-ui/[0.12] disabled:opacity-50 text-ui/90 rounded-lg transition-colors"
              >
                Add
              </button>
            </div>
          </div>
        </div>

        <div className="flex gap-3 justify-end mt-6">
          <button type="button" onClick={onClose} className="btn">
            Cancel
          </button>
          <button
            type="button"
            onClick={handleCreate}
            disabled={saving || !title.trim()}
            className="btn btn--primary"
          >
            {saving ? 'Creating...' : 'Create Project'}
          </button>
        </div>
    </ModalShell>
  );
};

// ── Main Tracker Component ──

export const Tracker = () => {
  const [projects, setProjects] = useState<Project[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [agents, setAgents] = useState<AgentDetail[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string>('all');
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showCreateProject, setShowCreateProject] = useState(false);
  const [showCreateTask, setShowCreateTask] = useState(false);
  const [confirmDeleteProject, setConfirmDeleteProject] = useState(false);
  const [closeProjectModalOpen, setCloseProjectModalOpen] = useState(false);
  const { subscribe, reconnectCount } = useWebSocket();
  const toast = useToast();

  // Switching projects while a load is in flight would otherwise let the old
  // fetch answer last and redraw the board for a project that was left. Each
  // run stamps itself and bails once a newer run has started.
  const latestLoad = useRef(0);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    const mine = ++latestLoad.current;
    const [projectsResult, agentsResult] = await Promise.all([
      api.getProjects(),
      api.getAgents(),
    ]);
    if (mine !== latestLoad.current) return;

    if (projectsResult.ok) setProjects(projectsResult.data);
    if (agentsResult.ok) setAgents(agentsResult.data);

    // Load tasks based on selected project
    const filter = selectedProjectId !== 'all' ? { projectId: selectedProjectId } : undefined;
    const tasksResult = await api.getTasks(filter);
    if (mine !== latestLoad.current) return;
    if (tasksResult.ok) { setTasks(tasksResult.data); setLoadError(null); setClosedHasOlder(tasksResult.closedHasOlder === true); }
    else { setTasks([]); setLoadError(tasksResult.error); setClosedHasOlder(false); }

    setLoading(false);
  }, [selectedProjectId]);

  // Finished tasks come a page at a time; the older page is asked for with the
  // oldest finished task the board holds, so nothing older is fetched unasked.
  const [closedHasOlder, setClosedHasOlder] = useState(false);
  const loadingOlder = useRef(false);
  const showOlderFinished = useCallback(async () => {
    if (loadingOlder.current) return;
    const finished = tasks.filter((t) => ['complete', 'fallen', 'cancelled'].includes(t.status) && t.completedAt);
    const oldest = finished.reduce<Task | null>((o, t) => (!o || `${t.completedAt}|${t.id}` < `${o.completedAt}|${o.id}` ? t : o), null);
    if (!oldest?.completedAt) { setClosedHasOlder(false); return; }
    loadingOlder.current = true;
    const mine = latestLoad.current;
    const filter = selectedProjectId !== 'all' ? { projectId: selectedProjectId } : {};
    const result = await api.getTasks({ ...filter, closedBefore: oldest.completedAt, closedBeforeId: oldest.id });
    loadingOlder.current = false;
    if (mine !== latestLoad.current || !result.ok) return;   // a failed page says nothing: the button stays to retry
    setTasks((prev) => [...prev, ...result.data.filter((t) => !prev.some((p) => p.id === t.id))]);
    setClosedHasOlder(result.closedHasOlder === true);
  }, [tasks, selectedProjectId]);

  useEffect(() => {
    loadData();
  }, [loadData, reconnectCount]); // a reconnect re-asks (frames sent in the gap are gone); silent

  // WebSocket subscriptions
  // The subscriptions must not re-fire when the filter changes, so the task
  // handler below reads the current filter through this ref.
  const selectedProjectIdRef = useRef(selectedProjectId);
  selectedProjectIdRef.current = selectedProjectId;
  useEffect(() => {
    const unsubTask = subscribe('tracker:task_updated', (event: WsEvent) => {
      const e = event as TrackerTaskUpdatedEvent;
      // Guard against a missing/partial payload. The canonical emitters send a
      // full task row under data:, but a drifted emitter could send an empty or
      // partial one; ignore it rather than throw (which the WS dispatch would
      // otherwise swallow, freezing the card until a manual reload).
      if (!e.data || !e.data.id) {
        console.warn('[Tracker] tracker:task_updated missing data payload; ignoring', event);
        return;
      }
      // A frame carries the task's own project; the board only shows the
      // selected one. A foreign task already on the board has just been moved
      // away, it leaves. One not yet held is not this board's news at all.
      const sel = selectedProjectIdRef.current;
      const belongs = sel === 'all' || e.data.projectId === sel;
      setTasks((prev) => {
        const idx = prev.findIndex((t) => t.id === e.data.id);
        if (idx >= 0) {
          if (!belongs) return prev.filter((t) => t.id !== e.data.id);
          const updated = [...prev];
          updated[idx] = e.data;
          return updated;
        }
        return belongs ? [...prev, e.data] : prev;
      });
    });

    const unsubProject = subscribe('tracker:project_updated', (event: WsEvent) => {
      const e = event as TrackerProjectUpdatedEvent;
      setProjects((prev) => {
        const idx = prev.findIndex((p) => p.id === e.data.id);
        if (idx >= 0) {
          const updated = [...prev];
          updated[idx] = e.data;
          return updated;
        }
        return [...prev, e.data];
      });
    });

    // Track agent working status in real-time so task card animations
    // reflect whether the assigned agent is ACTUALLY working right now.
    const unsubAgentStatus = subscribe('agent:status', (event: WsEvent) => {
      const e = event as { agentId: string; status: string };
      setAgents((prev) => prev.map(a =>
        a.id === e.agentId ? { ...a, status: e.status as AgentDetail['status'] } : a
      ));
    });

    return () => {
      unsubTask();
      unsubProject();
      unsubAgentStatus();
    };
  }, [subscribe]);

  const handleStatusChange = cardMover(tasks, setTasks, toast.error);

  const selectedTask = selectedTaskId ? tasks.find((t) => t.id === selectedTaskId) : null;

  // Project selector only lists active projects, completed/cancelled
  // clutter is filtered out so the dropdown reflects "what am I working on,"
  // not project history. Selected-project lookup falls back to the full
  // project list so the action bar still resolves the name even when the
  // selected project transitions out of 'active' (e.g. just got closed).
  const activeProjects = projects.filter(p => p.status === 'active');

  if (loading) return <div className="loading-state">Loading...</div>;

  const selectedProjectTitle = projects.find(p => p.id === selectedProjectId)?.title;

  return (
    <>
      {/* Self-headered panel: the page owns its prototype .phead. */}
      <header className="phead">
        <h2 className="phead__title">Tracker</h2>
        <span className="phead__meta">{tasks.length} task{tasks.length !== 1 ? 's' : ''}</span>
        <div className="phead__actions">
          <button type="button" className="btn" onClick={() => setShowCreateTask(true)}>+ Create Task</button>
          <button type="button" className="btn btn--primary" onClick={() => setShowCreateProject(true)}>+ Create Project</button>
        </div>
      </header>
      {loadError && <div className="note--warn">Could not load the tasks: {loadError}</div>}

      {/* Toolbar: project filter. Dropdown lists active projects only;
          closed/cancelled ones live in history, not the working view. */}
      <div className="toolbar">
        <span className="toolbar__label">View project</span>
        <select
          className="field field--select"
          aria-label="Project filter"
          value={selectedProjectId}
          onChange={(e) => { setSelectedProjectId(e.target.value); setConfirmDeleteProject(false); }}
        >
          <option value="all">All active projects</option>
          {activeProjects.map((p) => (
            <option key={p.id} value={p.id}>{p.title}</option>
          ))}
        </select>
      </div>

      {/* Project action bar, shows when a specific project is selected. */}
      {selectedProjectId !== 'all' && (
        <div className="tile" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', padding: '11px 16px', margin: '0 2px 16px' }}>
          <div style={{ font: '400 12px/1.4 var(--dojo3-font-body)', color: 'var(--dojo3-ink-2)' }}>
            Project: <b style={{ color: 'var(--dojo3-ink)' }}>{selectedProjectTitle}</b>
            <span style={{ marginLeft: 12, color: 'var(--dojo3-ink-4)' }}>{tasks.length} task{tasks.length !== 1 ? 's' : ''}</span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => setCloseProjectModalOpen(true)}
              title="Mark the project and every open task as resolved in one call, leaves an audit note on each task. Use when the project was abandoned, duplicated, or finished but never closed out."
            >
              Close + Resolve Open Tasks
            </button>

            {confirmDeleteProject ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ font: '500 11px/1 var(--dojo3-font-mono)', color: 'var(--dojo3-rust)' }}>Delete this project and all its tasks?</span>
                <button
                  type="button"
                  className="btn btn--sm"
                  onClick={async () => {
                    let res = await api.deleteProject(selectedProjectId);
                    setConfirmDeleteProject(false);
                    // Tasks being worked on: the server names them and he may go on.
                    if (!res.ok && res.status === 409) {
                      if (!window.confirm(res.error)) return;
                      res = await api.deleteProject(selectedProjectId, true);
                    }
                    if (!res.ok) {
                      toast.error(res.error || 'The project could not be deleted.');
                      return;
                    }
                    setSelectedProjectId('all');
                    loadData();
                  }}
                >
                  Yes, delete
                </button>
                <button type="button" className="btn btn--sm" onClick={() => setConfirmDeleteProject(false)}>
                  Cancel
                </button>
              </div>
            ) : (
              <button type="button" className="btn btn--sm" onClick={() => setConfirmDeleteProject(true)}>
                Delete Project
              </button>
            )}
          </div>
        </div>
      )}

      {/* Kanban Board */}
      <KanbanBoard
        tasks={tasks}
        workingAgentIds={new Set(agents.filter(a => a.status === 'working').map(a => a.id))}
        onTaskClick={(taskId) => setSelectedTaskId(taskId)}
        onStatusChange={handleStatusChange}
        onTaskDeleted={loadData}
        onShowOlderFinished={closedHasOlder ? showOlderFinished : undefined}
      />

      {/* Task Detail Panel */}
      {selectedTask && (
        <TaskDetailPanel
          task={selectedTask}
          agents={agents}
          allTasks={tasks}
          onClose={() => setSelectedTaskId(null)}
          onUpdate={loadData}
        />
      )}

      {/* Create Project Modal */}
      {showCreateProject && (
        <CreateProjectModal
          onClose={() => setShowCreateProject(false)}
          onCreate={loadData}
          agents={agents}
        />
      )}

      {/* Create Task Modal */}
      {showCreateTask && (
        <CreateTaskModal
          onClose={() => setShowCreateTask(false)}
          onCreate={loadData}
          agents={agents}
          projects={projects}
        />
      )}

      {/* Close Project Modal */}
      {closeProjectModalOpen && selectedProjectId !== 'all' && (
        <CloseProjectModal
          projectId={selectedProjectId}
          projectTitle={projects.find(p => p.id === selectedProjectId)?.title ?? 'this project'}
          openTaskCount={tasks.filter(t => !['complete', 'fallen', 'cancelled'].includes(t.status)).length}
          onClose={() => setCloseProjectModalOpen(false)}
          onClosed={() => {
            setCloseProjectModalOpen(false);
            loadData();
          }}
        />
      )}
    </>
  );
};

// ── Close Project Modal ──

const CloseProjectModal = ({
  projectId,
  projectTitle,
  openTaskCount,
  onClose,
  onClosed,
}: {
  projectId: string;
  projectTitle: string;
  openTaskCount: number;
  onClose: () => void;
  onClosed: () => void;
}) => {
  const [status, setStatus] = useState<'complete' | 'cancelled'>('cancelled');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleClose = async () => {
    if (reason.trim().length < 4) {
      setError('Reason is required (≥ 4 characters).');
      return;
    }
    setSaving(true);
    setError(null);
    const result = await api.closeProject(projectId, { status, reason: reason.trim() });
    if (result.ok) {
      onClosed();
    } else {
      setError(result.error);
    }
    setSaving(false);
  };

  return (
    <ModalShell
      onClose={onClose}
      label={`Close project: ${projectTitle}`}
      backdropClassName="glass-modal-backdrop"
      panelClassName="glass-modal p-6 max-w-md w-full mx-4"
      closeOnEscape={!saving}
      closeOnBackdrop={false}
    >
        <h3 className="text-lg font-semibold text-ui mb-4">Close project: {projectTitle}</h3>

        {error && (
          <div className="alert-banner alert-error mb-4">{error}</div>
        )}

        <div className="text-sm text-ui/70 mb-4">
          This closes the project AND every still-open task on it ({openTaskCount} open). Each task gets an audit note explaining who closed it and why.
        </div>

        <div className="space-y-4">
          <div>
            <label className="text-xs font-semibold text-ui/55 uppercase tracking-wide block mb-1">Resolution</label>
            <select
              value={status}
              onChange={e => setStatus(e.target.value as 'complete' | 'cancelled')}
              className="glass-select w-full"
            >
              <option value="cancelled">Cancelled, abandoned, duplicated, or scope changed</option>
              <option value="complete">Complete, all work was actually done</option>
            </select>
          </div>

          <div>
            <label className="text-xs font-semibold text-ui/55 uppercase tracking-wide block mb-1">Reason (required)</label>
            <textarea
              value={reason}
              onChange={e => setReason(e.target.value)}
              placeholder='e.g. "Duplicate of project xyz" or "Scope shifted to project abc"'
              rows={3}
              className="glass-textarea w-full resize-none"
            />
          </div>
        </div>

        <div className="flex gap-3 justify-end mt-6">
          <button type="button" onClick={onClose} className="btn">
            Cancel
          </button>
          <button
            type="button"
            onClick={handleClose}
            disabled={saving || reason.trim().length < 4}
            className="btn btn--primary"
          >
            {saving ? 'Closing...' : `Close & resolve ${openTaskCount} task${openTaskCount === 1 ? '' : 's'}`}
          </button>
        </div>
    </ModalShell>
  );
};

// ── Create Task Modal (with scheduling) ──

const CreateTaskModal = ({
  onClose,
  onCreate,
  agents,
  projects,
}: {
  onClose: () => void;
  onCreate: () => void;
  agents: AgentDetail[];
  projects: Project[];
}) => {
  const activeAgents = agents.filter(a => a.status !== 'terminated' && a.agentType !== 'archived');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState('normal');
  const [assignedTo, setAssignedTo] = useState('');
  const [projectId, setProjectId] = useState('');
  const [schedule, setSchedule] = useState<ScheduleConfig>(DEFAULT_SCHEDULE);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCreate = async () => {
    if (!title.trim()) return;
    setSaving(true);
    setError(null);

    const taskData: Record<string, unknown> = {
      title: title.trim(),
      description: description.trim() || undefined,
      priority,
      assignedTo: assignedTo || undefined,
      projectId: projectId || undefined,
    };

    // Add schedule data if enabled
    if (schedule.scheduledStart) {
      taskData.scheduled_start = schedule.scheduledStart;
      if (schedule.repeatInterval && schedule.repeatUnit) {
        taskData.repeat_interval = schedule.repeatInterval;
        taskData.repeat_unit = schedule.repeatUnit;
        taskData.repeat_end_type = schedule.repeatEndType;
        taskData.repeat_end_value = schedule.repeatEndValue;
        taskData.repeat_days_of_week = schedule.repeatDaysOfWeek;
        taskData.anchor_time = schedule.anchorTime ?? schedule.scheduledStart;
      }
    }

    const result = await api.createTask(taskData as unknown as Parameters<typeof api.createTask>[0]);
    if (result.ok) {
      onCreate();
      onClose();
    } else {
      setError(result.error);
    }
    setSaving(false);
  };

  return (
    <ModalShell
      onClose={onClose}
      label="Create Task"
      backdropClassName="glass-modal-backdrop"
      panelClassName="glass-modal p-6 max-w-lg w-full mx-4"
      closeOnEscape={!saving}
      closeOnBackdrop={false}
    >
        <h3 className="text-lg font-semibold text-ui mb-4">Create Task</h3>

        {error && <div className="mb-4 px-3 py-2 rounded-xl bg-cp-coral/10 border border-cp-coral/20 text-cp-coral text-sm">{error}</div>}

        <div className="space-y-4">
          <div>
            <label className="text-xs font-semibold text-ui/55 uppercase tracking-wide block mb-1">Title</label>
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Task title"
              className="glass-input" autoFocus />
          </div>

          <div>
            <label className="text-xs font-semibold text-ui/55 uppercase tracking-wide block mb-1">Description</label>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What needs to be done..."
              className="glass-textarea" rows={3} />
          </div>

          <div className="flex gap-3">
            <div className="flex-1">
              <label className="text-xs font-semibold text-ui/55 uppercase tracking-wide block mb-1">Priority</label>
              <select value={priority} onChange={(e) => setPriority(e.target.value)} className="glass-select w-full">
                <option value="high">High</option>
                <option value="normal">Normal</option>
                <option value="low">Low</option>
              </select>
            </div>
            <div className="flex-1">
              <label className="text-xs font-semibold text-ui/55 uppercase tracking-wide block mb-1">Assign To</label>
              <select value={assignedTo} onChange={(e) => setAssignedTo(e.target.value)} className="glass-select w-full">
                <option value="">Unassigned</option>
                {activeAgents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </div>
          </div>

          {projects.length > 0 && (
            <div>
              <label className="text-xs font-semibold text-ui/55 uppercase tracking-wide block mb-1">Project</label>
              <select value={projectId} onChange={(e) => setProjectId(e.target.value)} className="glass-select w-full">
                <option value="">No project (standalone task)</option>
                {projects.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
              </select>
            </div>
          )}

          {/* Schedule */}
          <div className="glass-nested rounded-xl p-3">
            <TaskScheduleForm value={schedule} onChange={setSchedule} />
          </div>
        </div>

        <div className="flex gap-3 justify-end mt-6">
          <button type="button" onClick={onClose} className="btn">Cancel</button>
          <button type="button" onClick={handleCreate} disabled={saving || !title.trim()} className="btn btn--primary">
            {saving ? 'Creating...' : 'Create Task'}
          </button>
        </div>
    </ModalShell>
  );
};

// ── Schedule Editor for Task Detail Panel ──

export const ScheduleEditor = ({ task, onUpdate }: { task: Task; onUpdate: () => void }) => {
  const [schedule, setSchedule] = useState<ScheduleConfig>({
    scheduledStart: task.scheduledStart,
    repeatInterval: task.repeatInterval,
    repeatUnit: task.repeatUnit,
    repeatEndType: task.repeatEndType ?? 'never',
    repeatEndValue: task.repeatEndValue ?? null,
    repeatDaysOfWeek: task.repeatDaysOfWeek ?? null,
    anchorTime: task.anchorTime ?? null,
  });
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const handleChange = (config: ScheduleConfig) => {
    setSchedule(config);
    setDirty(true);
    setSaveError(null);
  };

  const handleSave = async () => {
    setSaving(true);
    const body: Record<string, unknown> = {};

    if (schedule.scheduledStart) {
      body.scheduled_start = schedule.scheduledStart;
      body.repeat_interval = schedule.repeatInterval;
      body.repeat_unit = schedule.repeatUnit;
      body.repeat_end_type = schedule.repeatEndType;
      body.repeat_end_value = schedule.repeatEndValue;
      body.repeat_days_of_week = schedule.repeatDaysOfWeek;
      body.anchor_time = schedule.anchorTime ?? schedule.scheduledStart;
    } else {
      body.scheduled_start = null;
    }

    setSaveError(null);
    const res = await api.updateTask(task.id, body as Parameters<typeof api.updateTask>[1]);
    setSaving(false);
    if (!res.ok) {
      // The server refused the schedule: keep the owner's edit on screen and
      // show why, instead of discarding it and reloading the old one.
      setSaveError(res.error);
      return;
    }
    setDirty(false);
    onUpdate();
  };

  return (
    <div>
      <h3 className="text-xs font-semibold text-ui/55 uppercase tracking-wide mb-2">Schedule</h3>
      <div className="glass-nested rounded-xl p-3">
        <TaskScheduleForm value={schedule} onChange={handleChange} />

        {task.scheduleStatus && task.scheduleStatus !== 'unscheduled' && (
          <div className="mt-3 pt-3 border-t border-ui/[0.06] space-y-1 text-xs">
            {task.nextRunAt && (
              <div className="flex justify-between text-ui/55">
                <span>Next Run</span>
                <span className="text-cp-blue">{formatDate(task.nextRunAt)}</span>
              </div>
            )}
            <div className="flex justify-between text-ui/55">
              <span>Status</span>
              <span className={task.isPaused ? 'text-cp-amber' : 'text-cp-teal'}>
                {task.isPaused ? 'Paused' : task.scheduleStatus}
              </span>
            </div>
            <div className="flex justify-between text-ui/55">
              <span>Completed Runs</span>
              <span>{task.runCount}</span>
            </div>
          </div>
        )}

        {dirty && (
          <>
            {saveError && <p className="text-xs text-cp-coral mt-2">{saveError}</p>}
            <button onClick={handleSave} disabled={saving}
              className="glass-btn glass-btn-primary text-xs mt-3 w-full py-2">
              {saving ? 'Saving...' : 'Save Schedule'}
            </button>
          </>
        )}
      </div>
    </div>
  );
};
