// Tracker: moving a card to another column. The card moves at once; if the server refuses, only
// THAT card goes back (other cards may have been updated by agents meanwhile) and the owner is told why.

import type { Dispatch, SetStateAction } from 'react';
import type { Task } from '@dojo/shared';
import * as api from '../lib/api';

export const cardMover = (
  tasks: Task[],
  setTasks: Dispatch<SetStateAction<Task[]>>,
  showError: (message: string) => void,
) => async (taskId: string, newStatus: Task['status']) => {
  const before = tasks.find((t) => t.id === taskId);
  setTasks((prev) =>
    prev.map((t) => (t.id === taskId ? { ...t, status: newStatus, updatedAt: new Date().toISOString() } : t)),
  );

  const result = await api.updateTask(taskId, { status: newStatus });
  if (!result.ok) {
    setTasks((prev) => prev.map((t) => (t.id === taskId && before ? { ...t, status: before.status, updatedAt: before.updatedAt } : t)));
    showError(result.error ?? 'That move was not allowed.');
  }
};
