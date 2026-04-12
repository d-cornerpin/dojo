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

  useEffect(() => {
    setStatus(task.status);
    setPriority(task.priority);
    setAssignedTo(task.assignedTo || '');
  }, [task]);

  const handleFieldUpdate = async (updates: Record<string, string | undefined>) => {
    setSaving(true);
    const result = await api.updateTask(task.id, updates);
    if (result.ok) {
      onUpdate();
    }
    setSaving(false);
  };

  const handleAddNote = async () => {
    if (!noteInput.trim()) return;
    const existingNotes = task.notes || '';
    const timestamp = new Date().toLocaleString();
    const newNotes = existingNotes
      ? `${existingNotes}\n\n[${timestamp}]\n${noteInput.trim()}`
      : `[${timestamp}]\n${noteInput.trim()}`;
    setSaving(true);
    const result = await api.updateTask(task.id, { notes: newNotes });
    if (result.ok) {
      setNoteInput('');
      onUpdate();
    }
    setSaving(false);
  };

  const priorityColors: Record<string, string> = {
    high: 'text-red-400',
    normal: 'text-yellow-400',
    low: 'text-green-400',
  };

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />

      {/* Panel */}
      <div className="relative w-full max-w-md overflow-y-auto"
        style={{ background: 'rgba(255,255,255,0.06)', backdropFilter: 'blur(30px)', WebkitBackdropFilter: 'blur(30px)', borderLeft: '1px solid rgba(255,255,255,0.12)', boxShadow: '-8px 0 32px rgba(0,0,0,0.4), inset 1px 0 0 rgba(255,255,255,0.08)' }}>
        <div className="p-6 space-y-6">
          {/* Header */}
          <div className="flex items-start justify-between">
            <h2 className="text-lg font-semibold text-white pr-4">{task.title}</h2>
            <button
              onClick={onClose}
              className="white/40 hover:white/70 transition-colors text-xl leading-none"
            >
              &times;
            </button>
          </div>

          {/* Description */}
          {task.description && (
            <div>
              <h3 className="text-xs font-semibold white/55 uppercase tracking-wide mb-1">Description</h3>
              <p className="text-sm white/70 whitespace-pre-wrap">{task.description}</p>
            </div>
          )}

          {/* Status */}
          <div>
            <h3 className="text-xs font-semibold white/55 uppercase tracking-wide mb-1">Status</h3>
            <select
              value={status}
              onChange={(e) => {
                const newStatus = e.target.value;
                setStatus(newStatus as Task['status']);
                handleFieldUpdate({ status: newStatus });
              }}
              disabled={saving}
              className="w-full px-3 py-2 bg-white/[0.05] border white/[0.08] rounded-lg text-sm white/90 focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              <option value="on_deck">Pending</option>
              <option value="in_progress">In Progress</option>
              <option value="complete">Complete</option>
              <option value="blocked">Blocked</option>
              <option value="fallen">Failed</option>
            </select>
          </div>

          {/* Priority */}
          <div>
            <h3 className="text-xs font-semibold white/55 uppercase tracking-wide mb-1">Priority</h3>
            <select
              value={priority}
              onChange={(e) => {
                const newPriority = e.target.value;
                setPriority(newPriority as Task['priority']);
                handleFieldUpdate({ priority: newPriority });
              }}
              disabled={saving}
              className={`w-full px-3 py-2 bg-white/[0.05] border white/[0.08] rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 ${priorityColors[priority] || 'white/90'}`}
            >
              <option value="high">High</option>
              <option value="normal">Normal</option>
              <option value="low">Low</option>
            </select>
          </div>

          {/* Assigned Agent */}
          <div>
            <h3 className="text-xs font-semibold white/55 uppercase tracking-wide mb-1">Assigned Agent</h3>
            <select
              value={assignedTo}
              onChange={(e) => {
                const newAgent = e.target.value;
                setAssignedTo(newAgent);
                handleFieldUpdate({ assignedTo: newAgent || undefined });
              }}
              disabled={saving}
              className="w-full px-3 py-2 bg-white/[0.05] border white/[0.08] rounded-lg text-sm white/90 focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              <option value="">Unassigned</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
            {task.assignedTo && (
              <Link
                to={`/agents/${task.assignedTo}`}
                className="text-xs text-blue-400 hover:text-blue-300 mt-1 inline-block"
              >
                View agent details
              </Link>
            )}
          </div>

          {/* Dependencies */}
          {task.dependsOn.length > 0 && (
            <div>
              <h3 className="text-xs font-semibold text-white/55 uppercase tracking-wide mb-1">Dependencies</h3>
              <div className="space-y-1">
                {task.dependsOn.map((depId) => {
                  const depTask = allTasks.find(t => t.id === depId);
                  return (
                    <div key={depId} className="text-sm text-white/55 flex items-center gap-2">
                      <span className={`w-2 h-2 rounded-full shrink-0 ${depTask?.status === 'complete' ? 'bg-green-400' : depTask?.status === 'in_progress' ? 'bg-blue-400' : 'bg-white/20'}`} />
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
              <h3 className="text-xs font-semibold white/55 uppercase tracking-wide mb-2">Run History</h3>
              <TaskRunHistory taskId={task.id} />
            </div>
          )}

          {/* Meta */}
          <div className="text-xs white/40 space-y-1">
            {task.stepNumber && (
              <div>Step {task.stepNumber}{task.totalSteps ? ` of ${task.totalSteps}` : ''}</div>
            )}
            <div>Phase: {task.phase}</div>
            <div>Created: {formatDate(task.createdAt)}</div>
            <div>Updated: {formatDate(task.updatedAt)}</div>
            {task.completedAt && <div>Completed: {formatDate(task.completedAt)}</div>}
          </div>

          {/* Notes */}
          <div>
            <h3 className="text-xs font-semibold white/55 uppercase tracking-wide mb-2">Notes</h3>
            {task.notes && (
              <div className="glass-nested rounded-xl p-3 mb-3 max-h-48 overflow-y-auto">
                <pre className="text-sm white/70 whitespace-pre-wrap font-sans">{task.notes}</pre>
              </div>
            )}
            <textarea
              value={noteInput}
              onChange={(e) => setNoteInput(e.target.value)}
              placeholder="Add a note..."
              rows={3}
              className="w-full px-3 py-2 bg-white/[0.05] border white/[0.08] rounded-lg text-sm white/90 placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-500 resize-none"
            />
            <button
              onClick={handleAddNote}
              disabled={saving || !noteInput.trim()}
              className="mt-2 px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-700 disabled:bg-white/[0.08] disabled:white/40 text-white rounded-lg transition-colors"
            >
              Add Note
            </button>
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
        <h3 className="text-lg font-semibold text-white mb-4">Create Project</h3>

        {error && (
          <div className="mb-4 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
            {error}
          </div>
        )}

        <div className="space-y-4">
          <div>
            <label className="text-xs font-semibold white/55 uppercase tracking-wide block mb-1">Title</label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Project title"
              className="w-full px-3 py-2 bg-white/[0.05] border white/[0.08] rounded-lg text-sm white/90 placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>

          <div>
            <label className="text-xs font-semibold white/55 uppercase tracking-wide block mb-1">Description</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional description"
              rows={3}
              className="w-full px-3 py-2 bg-white/[0.05] border white/[0.08] rounded-lg text-sm white/90 placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-500 resize-none"
            />
          </div>

          <div>
            <label className="text-xs font-semibold white/55 uppercase tracking-wide block mb-1">Level</label>
            <select
              value={level}
              onChange={(e) => setLevel(Number(e.target.value))}
              className="w-full px-3 py-2 bg-white/[0.05] border white/[0.08] rounded-lg text-sm white/90 focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              <option value={1}>Level 1 - Simple</option>
              <option value={2}>Level 2 - Medium</option>
              <option value={3}>Level 3 - Complex</option>
            </select>
          </div>

          {/* Task builder */}
          <div>
            <label className="text-xs font-semibold white/55 uppercase tracking-wide block mb-1">Tasks</label>
            {tasks.length > 0 && (
              <div className="space-y-1 mb-2">
                {tasks.map((t, i) => (
                  <div key={i} className="flex items-center gap-2 glass-nested rounded-xl px-3 py-2">
                    <span className="text-xs white/40 font-mono w-6">{i + 1}.</span>
                    <span className="text-sm white/90 flex-1 truncate">{t.title}</span>
                    <select
                      value={t.assignedTo}
                      onChange={(e) => {
                        const updated = [...tasks];
                        updated[i] = { ...t, assignedTo: e.target.value };
                        setTasks(updated);
                      }}
                      className="px-2 py-0.5 bg-white/[0.08] border white/[0.10] rounded text-xs white/70 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    >
                      {activeAgents.map((a) => (
                        <option key={a.id} value={a.id}>{a.name}</option>
                      ))}
                    </select>
                    <button
                      onClick={() => removeTask(i)}
                      className="white/40 hover:text-red-400 transition-colors text-sm"
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
                className="flex-1 px-3 py-2 bg-white/[0.05] border white/[0.08] rounded-lg text-sm white/90 placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
              <select
                value={taskAssignee}
                onChange={(e) => setTaskAssignee(e.target.value)}
                className="px-2 py-2 bg-white/[0.05] border white/[0.08] rounded-lg text-sm white/90 focus:outline-none focus:ring-1 focus:ring-blue-500"
              >
                {activeAgents.map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
              <button
                onClick={addTask}
                disabled={!taskTitle.trim()}
                className="px-3 py-2 text-sm bg-white/[0.08] hover:bg-white/[0.12] disabled:opacity-50 white/90 rounded-lg transition-colors"
              >
                Add
              </button>
            </div>
          </div>
        </div>

        <div className="flex gap-3 justify-end mt-6">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm white/55 hover:white/90 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleCreate}
            disabled={saving || !title.trim()}
            className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-700 disabled:bg-white/[0.08] disabled:white/40 text-white rounded-lg transition-colors"
          >
            {saving ? 'Creating...' : 'Create Project'}
          </button>
        </div>
      </div>
    </div>
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
  const { subscribe } = useWebSocket();

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

    return () => {
      unsubTask();
      unsubProject();
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

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="white/40">Loading tracker...</p>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 p-6">
      {/* Top Bar */}
      <div className="shrink-0 mb-6 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <h1 className="text-lg sm:text-xl font-bold text-white">Tracker</h1>

            {/* Project selector */}
            <select
              value={selectedProjectId}
              onChange={(e) => { setSelectedProjectId(e.target.value); setConfirmDeleteProject(false); }}
              className="px-3 py-1.5 bg-white/[0.05] border white/[0.08] rounded-lg text-sm white/90 focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              <option value="all">All Tasks</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>{p.title}</option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-2">
            <button onClick={() => setShowCreateTask(true)} className="glass-btn glass-btn-secondary text-sm">+ Create Task</button>
            <button onClick={() => setShowCreateProject(true)} className="glass-btn glass-btn-primary text-sm">+ Create Project</button>
          </div>
        </div>

        {/* Project action bar — shows when a specific project is selected */}
        {selectedProjectId !== 'all' && (
          <div className="flex items-center justify-between glass-card px-4 py-2">
            <div className="text-sm white/70">
              Project: <span className="font-medium text-white">{projects.find(p => p.id === selectedProjectId)?.title}</span>
              <span className="white/40 ml-3">{tasks.length} task{tasks.length !== 1 ? 's' : ''}</span>
            </div>

            {confirmDeleteProject ? (
              <div className="flex items-center gap-3">
                <span className="text-sm text-red-400">Delete this project and all its tasks?</span>
                <button
                  onClick={async () => {
                    await api.deleteProject(selectedProjectId);
                    setSelectedProjectId('all');
                    setConfirmDeleteProject(false);
                    loadData();
                  }}
                  className="px-3 py-1 text-sm bg-red-600 hover:bg-red-700 text-white rounded-lg transition-colors"
                >
                  Yes, delete
                </button>
                <button
                  onClick={() => setConfirmDeleteProject(false)}
                  className="px-3 py-1 text-sm white/55 hover:white/90 transition-colors"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                onClick={() => setConfirmDeleteProject(true)}
                className="px-3 py-1 text-sm text-red-400 hover:text-red-300 border border-red-500/30 rounded-lg hover:border-red-500/50 transition-colors"
              >
                Delete Project
              </button>
            )}
          </div>
        )}
      </div>

      {/* Kanban Board */}
      <div className="flex-1 min-h-0">
        <KanbanBoard
          tasks={tasks}
          onTaskClick={(taskId) => setSelectedTaskId(taskId)}
          onStatusChange={handleStatusChange}
          onTaskDeleted={loadData}
        />
      </div>

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
      <div className="glass-modal p-6 max-w-lg w-full mx-4"
        style={{ boxShadow: '0 24px 64px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.1)' }}>
        <h3 className="text-lg font-semibold text-white mb-4">Create Task</h3>

        {error && <div className="mb-4 px-3 py-2 rounded-xl bg-cp-coral/10 border border-cp-coral/20 text-cp-coral text-sm">{error}</div>}

        <div className="space-y-4">
          <div>
            <label className="text-xs font-semibold text-white/55 uppercase tracking-wide block mb-1">Title</label>
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Task title"
              className="glass-input" autoFocus />
          </div>

          <div>
            <label className="text-xs font-semibold text-white/55 uppercase tracking-wide block mb-1">Description</label>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What needs to be done..."
              className="glass-textarea" rows={3} />
          </div>

          <div className="flex gap-3">
            <div className="flex-1">
              <label className="text-xs font-semibold text-white/55 uppercase tracking-wide block mb-1">Priority</label>
              <select value={priority} onChange={(e) => setPriority(e.target.value)} className="glass-select w-full">
                <option value="high">High</option>
                <option value="normal">Normal</option>
                <option value="low">Low</option>
              </select>
            </div>
            <div className="flex-1">
              <label className="text-xs font-semibold text-white/55 uppercase tracking-wide block mb-1">Assign To</label>
              <select value={assignedTo} onChange={(e) => setAssignedTo(e.target.value)} className="glass-select w-full">
                <option value="">Unassigned</option>
                {activeAgents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </div>
          </div>

          {projects.length > 0 && (
            <div>
              <label className="text-xs font-semibold text-white/55 uppercase tracking-wide block mb-1">Project</label>
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
          <button onClick={onClose} className="glass-btn glass-btn-ghost">Cancel</button>
          <button onClick={handleCreate} disabled={saving || !title.trim()} className="glass-btn glass-btn-primary">
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
      <h3 className="text-xs font-semibold white/55 uppercase tracking-wide mb-2">Schedule</h3>
      <div className="glass-nested rounded-xl p-3">
        <TaskScheduleForm value={schedule} onChange={handleChange} />

        {task.scheduleStatus && task.scheduleStatus !== 'unscheduled' && (
          <div className="mt-3 pt-3 border-t border-white/[0.06] space-y-1 text-xs">
            {task.nextRunAt && (
              <div className="flex justify-between text-white/50">
                <span>Next Run</span>
                <span className="text-cp-blue">{formatDate(task.nextRunAt)}</span>
              </div>
            )}
            <div className="flex justify-between text-white/50">
              <span>Status</span>
              <span className={task.isPaused ? 'text-cp-amber' : 'text-cp-teal'}>
                {task.isPaused ? 'Paused' : task.scheduleStatus}
              </span>
            </div>
            <div className="flex justify-between text-white/50">
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
