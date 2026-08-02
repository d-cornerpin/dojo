import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import type { Project, Task, AgentDetail } from '@dojo/shared';
import type { WsEvent, TrackerTaskUpdatedEvent, TrackerProjectUpdatedEvent } from '@dojo/shared';
import * as api from '../lib/api';
import { formatDate } from '../lib/dates';
import { useWebSocket } from '../hooks/useWebSocket';
import { KanbanBoard } from '../components/KanbanBoard';
import { TaskRunHistory } from '../components/TaskRunHistory';
import { TaskScheduleForm, DEFAULT_SCHEDULE, type ScheduleConfig } from '../components/TaskScheduleForm';

// ── Task Detail Slide-Out Panel ──

const TaskDetailPanel = ({
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
  const [status, setStatus] = useState(task.status);
  const [priority, setPriority] = useState(task.priority);
  const [assignedTo, setAssignedTo] = useState(task.assignedTo || '');
  const [noteInput, setNoteInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [logEntries, setLogEntries] = useState<api.TaskLogEntry[]>([]);
  const [logLoading, setLogLoading] = useState(false);

  useEffect(() => {
    setStatus(task.status);
    setPriority(task.priority);
    setAssignedTo(task.assignedTo || '');
  }, [task]);

  // Phase B.0: load the structured audit log for this task.
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

  const handleFieldUpdate = async (updates: Record<string, string | null | undefined>) => {
    setSaving(true);
    const result = await api.updateTask(task.id, updates);
    if (result.ok) {
      onUpdate();
    }
    setSaving(false);
  };

  const handleAddNote = async () => {
    if (!noteInput.trim()) return;
    setSaving(true);
    // Phase B.0: user observations now go into task_log as structured
    // entries (entry_kind='observation', from_entity='user') instead of
    // being appended to the legacy tasks.notes column.
    const result = await api.addTaskObservation(task.id, noteInput.trim());
    if (result.ok) {
      setNoteInput('');
      // Refresh the task_log feed.
      const logRes = await api.getTaskLog(task.id, { limit: 50 });
      if (logRes.ok) setLogEntries(logRes.data);
      onUpdate();
    }
    setSaving(false);
  };

  const priorityColors: Record<string, string> = {
    high: 'text-cp-coral',
    normal: 'text-cp-amber',
    low: 'text-cp-teal',
  };

  return (
    <div className="glass-modal-backdrop" onClick={onClose}>
      <div
        className="glass-modal max-w-lg w-full mx-4 max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
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

          {/* Validation context (Phase B.1). Goal / result / evidence are
              what the PM agent (and a user reviewing manually) read when
              deciding whether to validate. Showing them here so the human
              has the same information the PM sees. */}
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
              onChange={(e) => {
                const newStatus = e.target.value;
                setStatus(newStatus as Task['status']);
                handleFieldUpdate({ status: newStatus });
              }}
              disabled={saving}
              className="glass-select w-full"
            >
              <option value="on_deck">Pending</option>
              <option value="in_progress">In Progress</option>
              <option value="paused">Paused</option>
              <option value="complete">Complete</option>
              <option value="blocked">Blocked</option>
              <option value="fallen">Failed</option>
            </select>
            {/* Awaiting-validation chip + manual validate button. */}
            {((task.status === 'complete' && task.completeValidated === 0) ||
              (task.status === 'paused' && task.pauseValidated === 0) ||
              (task.status === 'blocked' && task.blockedValidated === 0)) && (
              <div className="mt-2 glass-nested rounded-lg p-2 border border-cp-amber/30">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 text-xs text-cp-amber">
                    <span>{'⚠'}</span>
                    <span>Awaiting validation</span>
                    {task.validationEscalatedAt && (
                      <span className="text-ui/55">(user has been asked)</span>
                    )}
                  </div>
                  <button
                    onClick={async () => {
                      setSaving(true);
                      const res = await api.userValidateTask(task.id);
                      if (res.ok) {
                        onUpdate();
                      }
                      setSaving(false);
                    }}
                    disabled={saving}
                    className="px-2 py-1 text-xs glass-btn-primary rounded disabled:opacity-50"
                  >
                    Mark validated
                  </button>
                </div>
                <div className="text-[10px] text-ui/55 mt-1">
                  Neither PM nor you has validated this status yet. If you confirm, this clears the bug.
                </div>
              </div>
            )}
          </div>

          {/* Priority */}
          <div>
            <h3 className="text-xs font-semibold text-ui/55 uppercase tracking-wide mb-1">Priority</h3>
            <select
              value={priority}
              onChange={(e) => {
                const newPriority = e.target.value;
                setPriority(newPriority as Task['priority']);
                handleFieldUpdate({ priority: newPriority });
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
              onChange={(e) => {
                const newAgent = e.target.value;
                setAssignedTo(newAgent);
                handleFieldUpdate({ assignedTo: newAgent || null });
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

          {/* Schedule — editable */}
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
            <div>Phase: {task.phase}</div>
            <div>Created: {formatDate(task.createdAt)}</div>
            <div>Updated: {formatDate(task.updatedAt)}</div>
            {task.completedAt && <div>Completed: {formatDate(task.completedAt)}</div>}
          </div>

          {/* Activity log (Phase B.0). Renders task_log entries in newest-first order. */}
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
                    override: 'text-cp-amber',
                    smell_flag: 'text-cp-coral',
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
                        <span className="text-ui/55">[{e.fromEntity}]</span>
                        <span className={`font-semibold uppercase tracking-wide ${k}`}>{e.entryKind}</span>
                        {e.fromStatus && e.toStatus && (
                          <span className="text-ui/55">{e.fromStatus} → {e.toStatus}</span>
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
                <summary className="text-xs text-ui/55 cursor-pointer">Legacy notes (pre-Phase B.0)</summary>
                <pre className="text-xs text-ui/55 whitespace-pre-wrap font-sans mt-2 p-2 glass-nested rounded">{task.notes}</pre>
              </details>
            )}
          </div>
        </div>
      </div>
    </div>
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
    <div className="glass-modal-backdrop">
      <div className="glass-modal p-6 max-w-lg w-full mx-4 max-h-[80vh] overflow-y-auto">
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
                onKeyDown={(e) => e.key === 'Enter' && addTask()}
                className="glass-input flex-1"
              />
              <select
                value={taskAssignee}
                onChange={(e) => setTaskAssignee(e.target.value)}
                className="glass-select"
              >
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
      </div>
    </div>
  );
};

// ── Main Tracker Component ──

// ── Override request queue (Phase B.1, Wordy Mode only) ──
// Renders pending override requests with approve/deny buttons.
// Lives at the top of the Tracker page so it's impossible to miss when
// the user is power-user-mode and an agent is asking for an override.
const OverrideQueuePanel = ({
  overrides,
  onResolved,
}: {
  overrides: api.OverrideRequestRow[];
  onResolved: () => void;
}) => {
  const [resolving, setResolving] = useState<string | null>(null);
  const handle = async (id: string, approve: boolean) => {
    const reason = window.prompt(
      approve
        ? 'Reason for approving (one sentence):'
        : 'Reason for denying (one sentence). The agent will be notified.'
    );
    if (!reason || !reason.trim()) return;
    setResolving(id);
    const res = await api.resolveOverrideRequest(id, approve, reason.trim());
    setResolving(null);
    if (res.ok) onResolved();
  };
  return (
    <div className="tile" style={{ marginBottom: 16, padding: 16 }}>
      <h2 style={{ font: '500 10.5px/1 var(--dojo3-font-mono)', letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--dojo3-amber-deep)', marginBottom: 12 }}>
        Override requests ({overrides.length})
      </h2>
      <div className="space-y-3">
        {overrides.map((o) => (
          <div key={o.id} className="glass-nested rounded-lg p-3">
            <div className="text-xs text-ui/55 mb-1">
              from <span className="text-ui font-medium">{o.requested_by}</span>
              {' · '}
              wants <span className="text-cp-teal">{o.requested_status}</span>
              {o.attempts_attached > 1 && (
                <span className="ml-2 text-cp-coral">(circuit-breaker auto-fired x{o.attempts_attached})</span>
              )}
            </div>
            <div className="text-sm text-ui font-medium mb-1">
              Task: {o.task_title ?? o.task_id.slice(0, 8)}
            </div>
            {o.task_goal && (
              <div className="text-xs text-ui/70 mb-1">Goal: {o.task_goal}</div>
            )}
            <div className="text-xs text-ui/80 mb-1">
              <span className="text-ui/55">Justification:</span> {o.justification}
            </div>
            {o.last_engine_error && (
              <div className="text-xs text-ui/55 italic mb-2">
                Engine: {o.last_engine_error}
              </div>
            )}
            <div className="flex gap-2 mt-2">
              <button
                type="button"
                disabled={resolving === o.id}
                onClick={() => handle(o.id, true)}
                className="btn btn--primary btn--sm"
              >
                Approve
              </button>
              <button
                type="button"
                disabled={resolving === o.id}
                onClick={() => handle(o.id, false)}
                className="btn btn--sm"
              >
                Deny
              </button>
              <span className="text-xs text-ui/55 self-center ml-2">
                queued {formatDate(o.created_at)}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

// ── Tracker hygiene + telemetry (Phase D, Wordy Mode only) ──
// Renders rolled-up validate rates, smell flag counts, override rollup,
// elevated tasks, and PM cost-per-model. Lets the owner see at a glance
// whether the system is healthy or something needs attention.
const HygienePanel = ({
  hygiene,
  expanded,
  onToggle,
  onTaskClick,
}: {
  hygiene: api.TrackerHygiene;
  expanded: boolean;
  onToggle: () => void;
  onTaskClick: (id8: string) => void;
}) => {
  // One-glance summary numbers for the collapsed header row.
  const totalValidates = hygiene.validateOutcomes.reduce((s, v) => s + v.validates, 0);
  const totalRejects = hygiene.validateOutcomes.reduce((s, v) => s + v.rejects, 0);
  const totalSmells = hygiene.smellFlags.reduce((s, v) => s + v.count, 0);
  const pendingOverrides = hygiene.overrideRollup.find((o) => o.status === 'pending')?.count ?? 0;
  const elevatedCount = hygiene.elevated.length;
  const totalPmCost = hygiene.pmCost.reduce((s, p) => s + (p.cost_24h ?? 0), 0);

  return (
    <div className="tile tile--ok anim" style={{ marginBottom: 16, '--ci': '0ms' } as React.CSSProperties}>
      <button
        type="button"
        onClick={onToggle}
        className="hygiene"
        style={{ margin: 0, padding: 0, width: '100%', background: 'transparent', border: 0, cursor: 'pointer' }}
        aria-expanded={expanded}
      >
        <span className="hygiene__title">
          <span style={{ display: 'inline-block', transition: 'transform .2s ease', transform: expanded ? 'rotate(90deg)' : 'none' }}>{'▶'}</span>
          Tracker Hygiene
        </span>
        <div className="hygiene__stats">
          <span><b className="ok">{totalValidates}</b> blessed</span>
          {totalRejects > 0 && <span><b className="bad">{totalRejects}</b> rejected</span>}
          {totalSmells > 0 && <span><b className="warn">{totalSmells}</b> smell</span>}
          {pendingOverrides > 0 && <span><b className="warn">{pendingOverrides}</b> overrides</span>}
          {elevatedCount > 0 && <span><b className="warn">{elevatedCount}</b> elevated</span>}
          {totalPmCost > 0 && <span>${totalPmCost.toFixed(2)}/24h</span>}
        </div>
      </button>

      {!expanded ? null : (
      <div className="px-4 pb-4" style={{ marginTop: 14 }}>
      <div className="text-xs text-ui/55 mb-2">7-day window</div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        <div className="glass-nested rounded-lg p-3">
          <div className="text-xs text-ui/55 uppercase tracking-wide mb-2">Validate outcomes</div>
          {hygiene.validateOutcomes.length === 0 ? (
            <div className="text-xs text-ui/55 italic">none yet</div>
          ) : (
            <div className="space-y-1">
              {hygiene.validateOutcomes.map((v) => (
                <div key={v.from_entity} className="text-xs">
                  <span className="text-ui font-medium">{v.from_entity}:</span>{' '}
                  <span className="text-cp-teal">{v.validates} blessed</span>{' / '}
                  <span className="text-cp-coral">{v.rejects} rejected</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="glass-nested rounded-lg p-3">
          <div className="text-xs text-ui/55 uppercase tracking-wide mb-2">Smell flags</div>
          {hygiene.smellFlags.length === 0 ? (
            <div className="text-xs text-ui/55 italic">none</div>
          ) : (
            <div className="space-y-1">
              {hygiene.smellFlags.map((s) => (
                <div key={s.category} className="text-xs">
                  <span className="text-cp-amber font-medium">{s.category}:</span>{' '}
                  <span className="text-ui/80">{s.count}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="glass-nested rounded-lg p-3">
          <div className="text-xs text-ui/55 uppercase tracking-wide mb-2">Override rollup</div>
          {hygiene.overrideRollup.length === 0 ? (
            <div className="text-xs text-ui/55 italic">none</div>
          ) : (
            <div className="space-y-1">
              {hygiene.overrideRollup.map((o) => (
                <div key={o.status} className="text-xs">
                  <span className="text-ui font-medium">{o.status}:</span>{' '}
                  <span className="text-ui/80">{o.count}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="glass-nested rounded-lg p-3">
          <div className="text-xs text-ui/55 uppercase tracking-wide mb-2">PM cost (24h)</div>
          {hygiene.pmCost.length === 0 ? (
            <div className="text-xs text-ui/55 italic">no PM model calls</div>
          ) : (
            <div className="space-y-1">
              {hygiene.pmCost.map((p) => (
                <div key={p.modelId ?? 'unknown'} className="text-xs">
                  <span className="text-ui font-medium">{p.modelId ?? 'unknown'}:</span>{' '}
                  <span className="text-ui/80">{p.calls} calls</span>{' / '}
                  <span className="text-cp-amber">${(p.cost_24h ?? 0).toFixed(4)}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="glass-nested rounded-lg p-3 md:col-span-2 lg:col-span-2">
          <div className="text-xs text-ui/55 uppercase tracking-wide mb-2">
            Elevated tasks ({hygiene.elevated.length})
          </div>
          {hygiene.elevated.length === 0 ? (
            <div className="text-xs text-ui/55 italic">no tasks need attention</div>
          ) : (
            <div className="space-y-1 max-h-32 overflow-y-auto">
              {hygiene.elevated.map((t) => (
                <button
                  key={t.id8}
                  type="button"
                  onClick={() => onTaskClick(t.id8)}
                  className="text-xs text-left w-full hover:bg-ui/5 rounded px-1 py-0.5"
                >
                  <span className="text-ui/55">{t.id8}</span>{' '}
                  <span className="text-ui font-medium underline-offset-2 hover:underline">{t.title}</span>{' '}
                  <span className="text-ui/70">[{t.status}]</span>
                  {t.revert_count > 0 && (
                    <span className="ml-2 text-cp-coral">↺{t.revert_count}</span>
                  )}
                  {t.awaiting_user_verdict === 1 && (
                    <span className="ml-2 text-cp-amber">verdict?</span>
                  )}
                  {t.last_smell_flag && (
                    <div className="text-ui/55 italic ml-3 text-[10px]">{t.last_smell_flag}</div>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      </div>
      )}
    </div>
  );
};

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
  const { subscribe } = useWebSocket();

  // Phase B.1 / Q5 (corrected): override queue and hygiene panel are
  // tracker-page concerns and always visible here. Wordy Mode is a chat-page
  // toggle for showing tool-call mechanics inline; it does not apply here.
  const [overrides, setOverrides] = useState<api.OverrideRequestRow[]>([]);
  const [hygiene, setHygiene] = useState<api.TrackerHygiene | null>(null);
  const [hygieneExpanded, setHygieneExpanded] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const loadOverrides = () => {
      api.getOverrideRequests('pending').then((res) => {
        if (cancelled) return;
        if (res.ok) setOverrides(res.data);
      });
    };
    const loadHygiene = () => {
      api.getTrackerHygiene().then((res) => {
        if (cancelled) return;
        if (res.ok) setHygiene(res.data);
      });
    };
    loadOverrides();
    loadHygiene();
    const interval = setInterval(() => { loadOverrides(); loadHygiene(); }, 30_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  const loadData = useCallback(async () => {
    const [projectsResult, agentsResult] = await Promise.all([
      api.getProjects(),
      api.getAgents(),
    ]);

    if (projectsResult.ok) setProjects(projectsResult.data);
    if (agentsResult.ok) setAgents(agentsResult.data);

    // Load tasks based on selected project
    const filter = selectedProjectId !== 'all' ? { projectId: selectedProjectId } : undefined;
    const tasksResult = await api.getTasks(filter);
    if (tasksResult.ok) setTasks(tasksResult.data);

    setLoading(false);
  }, [selectedProjectId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // WebSocket subscriptions
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
      setTasks((prev) => {
        const idx = prev.findIndex((t) => t.id === e.data.id);
        if (idx >= 0) {
          const updated = [...prev];
          updated[idx] = e.data;
          return updated;
        }
        return [...prev, e.data];
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

  const handleStatusChange = async (taskId: string, newStatus: Task['status']) => {
    // Optimistic update — move card immediately
    const previousTasks = tasks;
    setTasks((prev) =>
      prev.map((t) => (t.id === taskId ? { ...t, status: newStatus, updatedAt: new Date().toISOString() } : t)),
    );

    const result = await api.updateTask(taskId, { status: newStatus });
    if (!result.ok) {
      // Revert on failure
      setTasks(previousTasks);
    }
  };

  const selectedTask = selectedTaskId ? tasks.find((t) => t.id === selectedTaskId) : null;

  // Project selector only lists active projects — completed/cancelled
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

      {/* Phase B.1: override request queue. Visible whenever there are
          pending requests; this is actionable work the user should see. */}
      {overrides.length > 0 && (
        <OverrideQueuePanel
          overrides={overrides}
          onResolved={() => {
            api.getOverrideRequests('pending').then((res) => {
              if (res.ok) setOverrides(res.data);
            });
          }}
        />
      )}

      {/* Phase D: tracker hygiene + telemetry banner. Collapsed by default;
          click to expand. */}
      {hygiene && (
        <HygienePanel
          hygiene={hygiene}
          expanded={hygieneExpanded}
          onToggle={() => setHygieneExpanded((v) => !v)}
          onTaskClick={(id8) => {
            const match = tasks.find((t) => t.id.startsWith(id8));
            if (match) setSelectedTaskId(match.id);
          }}
        />
      )}

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

      {/* Project action bar — shows when a specific project is selected. */}
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
              title="Mark the project and every open task as resolved in one call — leaves an audit note on each task. Use when the project was abandoned, duplicated, or finished but never closed out."
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
                    await api.deleteProject(selectedProjectId);
                    setSelectedProjectId('all');
                    setConfirmDeleteProject(false);
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
    <div className="glass-modal-backdrop">
      <div className="glass-modal p-6 max-w-md w-full mx-4">
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
              <option value="cancelled">Cancelled — abandoned, duplicated, or scope changed</option>
              <option value="complete">Complete — all work was actually done</option>
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
      </div>
    </div>
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
    <div className="glass-modal-backdrop">
      <div className="glass-modal p-6 max-w-lg w-full mx-4">
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
      </div>
    </div>
  );
};

// ── Schedule Editor for Task Detail Panel ──

const ScheduleEditor = ({ task, onUpdate }: { task: Task; onUpdate: () => void }) => {
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

  const handleChange = (config: ScheduleConfig) => {
    setSchedule(config);
    setDirty(true);
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

    await api.updateTask(task.id, body as Parameters<typeof api.updateTask>[1]);
    setDirty(false);
    setSaving(false);
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
          <button onClick={handleSave} disabled={saving}
            className="glass-btn glass-btn-primary text-xs mt-3 w-full py-2">
            {saving ? 'Saving...' : 'Save Schedule'}
          </button>
        )}
      </div>
    </div>
  );
};
