// Run history for a task; tokensUsed and costUsd are not projected because nothing writes them.

import { Hono } from 'hono';
import { listOccurrenceRuns } from '../../work/occurrence-runs.js';

export const taskRunsRouter = new Hono();

taskRunsRouter.get('/tasks/:taskId/runs', (c) => {
  return c.json({ ok: true, data: listOccurrenceRuns(c.req.param('taskId')) });
});
