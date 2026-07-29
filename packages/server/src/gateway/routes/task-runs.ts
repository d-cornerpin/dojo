// ════════════════════════════════════════
// Task Run History API (Phase 6)
// ════════════════════════════════════════
//
// PHASE-2 T10F — the route survives, its table does not.
//
// This is the surface that made `task_runs` a STRIP rather than a drop: it is mounted
// (`gateway/server.ts:280`) and its consumer is live (`dashboard/src/components/
// TaskRunHistory.tsx`, rendered from `pages/Tracker.tsx:278`), so the two rows the table held
// on the dev box were never evidence of anything (#15 — `task_runs` is that rule's own worked
// example). The response shape is deliberately unchanged: the same field names, the same
// instant shapes (`scheduledFor` second-resolution text, `startedAt`/`completedAt` ISO), and
// the same status words the dashboard's own `statusColors` map enumerates. The projection and
// every field in it are asserted in `work/__tests__/occurrence-runs.test.ts`.
//
// `tokensUsed` and `costUsd` are NOT projected, and that is a measurement rather than a
// trim: no production statement ever wrote either column (both were NULL in every row on
// this box), and the dashboard's `TaskRun` type does not declare them — only this route's
// object literal mentioned them, so nothing can read a value that was never written.

import { Hono } from 'hono';
import { listOccurrenceRuns } from '../../work/occurrence-runs.js';

export const taskRunsRouter = new Hono();

// GET /tasks/:taskId/runs — run history for a task
taskRunsRouter.get('/tasks/:taskId/runs', (c) => {
  return c.json({ ok: true, data: listOccurrenceRuns(c.req.param('taskId')) });
});
