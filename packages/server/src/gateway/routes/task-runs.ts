// ════════════════════════════════════════
// Task Run History API (Phase 6)
// ════════════════════════════════════════

import { Hono } from 'hono';
import { getDb } from '../../db/connection.js';

export const taskRunsRouter = new Hono();

// GET /tasks/:taskId/runs — run history for a task
taskRunsRouter.get('/tasks/:taskId/runs', (c) => {
  const taskId = c.req.param('taskId');
  const db = getDb();

  const runs = db.prepare(`
    SELECT tr.*, a.name as agent_name
    FROM task_runs tr
    LEFT JOIN agents a ON a.id = tr.assigned_to
    WHERE tr.task_id = ?
    ORDER BY tr.run_number DESC
  `).all(taskId) as Array<Record<string, unknown>>;

  const data = runs.map(r => ({
    id: r.id,
    taskId: r.task_id,
    runNumber: r.run_number,
    scheduledFor: r.scheduled_for,
    startedAt: r.started_at,
    completedAt: r.completed_at,
    status: r.status,
    assignedTo: r.assigned_to,
    agentName: r.agent_name,
    resultSummary: r.result_summary,
    tokensUsed: r.tokens_used,
    costUsd: r.cost_usd,
    error: r.error,
    createdAt: r.created_at,
  }));

  return c.json({ ok: true, data });
});
