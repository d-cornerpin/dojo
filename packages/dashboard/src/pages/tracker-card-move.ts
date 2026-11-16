// Tracker: moving a card to another column. The card moves at once; if the server refuses, only
// THAT card goes back (other cards may have been updated by agents meanwhile) and the owner is told why.
// Sent back is the owner's decision, so it asks him why and goes through the decision door.

import type { Dispatch, SetStateAction } from 'react';
import type { Task } from '@dojo/shared';
import * as api from '../lib/api';

export const cardMover = (
  tasks: Task[],
  setTasks: Dispatch<SetStateAction<Task[]>>,
  showError: (message: string) => void,
) => async (taskId: string, newStatus: Task['status']) => {
  const reason = newStatus === 'sent_back' ? window.prompt('Why are you sending it back? Its worker reads this.')?.trim() ?? '' : '';
  if (newStatus === 'sent_back' && !reason) return;
  const before = tasks.find((t) => t.id === taskId);
  setTasks((prev) =>
    prev.map((t) => (t.id === taskId ? { ...t, status: newStatus, updatedAt: new Date().toISOString() } : t)),
  );

  const result = newStatus === 'sent_back' ? await api.decideTask(taskId, 'send_back', reason) : await api.updateTask(taskId, { status: newStatus });
  if (!result.ok) {
    setTasks((prev) => prev.map((t) => (t.id === taskId && before ? { ...t, status: before.status, updatedAt: before.updatedAt } : t)));
    showError(result.error ?? 'That move was not allowed.');
  }
};
