// The edit tools ping the canvas; weak models' shell edits bypass that, so the disk itself is watched.
// Polling stat() (not fs.watch) catches in-place writes AND atomic rename-replaces, on every platform.
// node:fs stays: its timer callback is outside any dispatch, where a converted site holds no capability.

import fs from 'node:fs';
import { broadcast } from '../gateway/ws.js';

// Two agents may watch one file: stopping passes its exact listener; a bare unwatchFile drops them all.
const watchedPathByAgent = new Map<string, { path: string; listener: (curr: fs.Stats, prev: fs.Stats) => void }>();

export function stopCanvasWatch(agentId: string): void {
  const watched = watchedPathByAgent.get(agentId);
  if (watched) {
    try { fs.unwatchFile(watched.path, watched.listener); } catch { /* best effort */ }
    watchedPathByAgent.delete(agentId);
  }
}

export function startCanvasWatch(agentId: string, filePath: string): void {
  if (watchedPathByAgent.get(agentId)?.path === filePath) return;
  stopCanvasWatch(agentId);
  try {
    const listener = (curr: fs.Stats, prev: fs.Stats): void => {
      if (curr.mtimeMs !== prev.mtimeMs) {
        try { broadcast({ type: 'canvas:updated', agentId, data: { path: filePath } }); } catch { /* best effort */ }
      }
    };
    fs.watchFile(filePath, { interval: 700 }, listener);
    watchedPathByAgent.set(agentId, { path: filePath, listener });
  } catch { /* best effort, never let watching break a canvas open */ }
}
