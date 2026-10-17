// ════════════════════════════════════════
// Watchdog: repairing a cut-off platform swap (v3.4, t197)
//
// Every install switches `~/.dojo/platform` with two renames (live -> backup, staged ->
// live). A crash between them leaves NO platform folder: launchd cannot start the platform,
// so nothing inside the platform can repair it. This daemon can. When the folder is missing
// it runs `rollback.sh --heal`, which finishes the update when the staged tree the record
// names is whole, and otherwise puts the newest whole backup back. Either way the box ends
// wholly on one version, and the owner is told which, in plain words.
//
// Pure decisions here (unit-driven against a scratch folder); index.ts does the sending and
// spawning. Independent of the platform like the rest of this package: the lock rule mirrors
// `packages/server/src/update/install-tree.ts` (`acquireSwapLock`) and `rollback.sh`.
// ════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { updateMarker, type UpdateMarker } from './auto-rollback.js';

const SWAP_LOCK = 'rollback.lock';
const BACKUP_PREFIX = 'platform.backup-';

function treeVersion(dir: string): string | null {
  try {
    const v = (JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8')) as { version?: unknown }).version;
    return typeof v === 'string' && v !== '' ? v : null;
  } catch { return null; }
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** Is a LIVE process moving the platform folder right now? A dead holder holds nothing. */
function swapInProgress(dojoDir: string): boolean {
  const lock = path.join(dojoDir, SWAP_LOCK);
  if (!fs.existsSync(lock)) return false;
  let holder: number | null = null;
  try { holder = Number(fs.readFileSync(path.join(lock, 'pid'), 'utf-8').trim()) || null; } catch { /* no pid */ }
  if (holder !== null) return pidAlive(holder);
  // No pid: being taken this instant, or a pre-v3.4 leftover once it is old.
  try { return Date.now() - fs.statSync(lock).mtimeMs < 60_000; } catch { return false; }
}

export type SwapHeal =
  | { action: 'none' }
  | { action: 'wait' }
  | { action: 'heal'; finishes: 'update' | 'restore' | 'nothing-to-restore'; text: string };

export function decideSwapHeal(dojoDir: string, marker: UpdateMarker | null): SwapHeal {
  if (fs.existsSync(path.join(dojoDir, 'platform', 'package.json'))) return { action: 'none' };
  if (swapInProgress(dojoDir)) return { action: 'wait' };

  const target = marker?.targetVersion ?? null;
  if (marker?.phase === 'pending-update' && marker.stagingDir && target && treeVersion(marker.stagingDir) === target) {
    return {
      action: 'heal', finishes: 'update',
      text: `Watchdog: a Dojo update to ${target} was cut off at its very last step, so Dojo's program folder was missing. `
        + `I am finishing the update now. Your data was not touched, and Dojo will start ${target} on its own in a minute.`,
    };
  }
  const recorded = marker?.backupDir ? treeVersion(marker.backupDir) : null;
  let anyBackup = recorded !== null;
  try {
    anyBackup ||= fs.readdirSync(dojoDir).some((n) => n.startsWith(BACKUP_PREFIX) && treeVersion(path.join(dojoDir, n)) !== null);
  } catch { /* unreadable: treated as none */ }
  if (anyBackup) {
    return {
      action: 'heal', finishes: 'restore',
      text: 'Watchdog: Dojo\'s program folder was missing because an install or a restore was cut off part-way. '
        + `I am putting back the saved copy of the previous version${recorded ? ` (${recorded})` : ''}. `
        + 'Your data was not touched, and Dojo will restart on its own in a minute. I will tell you when it is back.',
    };
  }
  return {
    action: 'heal', finishes: 'nothing-to-restore',
    text: 'Watchdog: Dojo\'s program folder is missing and there is no saved copy on this Mac to put back. '
      + 'Your data in ~/.dojo/data was not touched. Please run the Dojo installer again to restore the program.',
  };
}

/** What the owner is told when an update stopped before it switched anything. */
export function interruptedUpdateText(m: UpdateMarker): string {
  return `Watchdog: an update to ${m.targetVersion ?? 'a new version'} was interrupted before it changed anything. `
    + `Dojo is still on ${m.previousVersion ?? 'the version it had'}, exactly as it was. `
    + 'Nothing needs fixing; you can run the update again whenever you like.';
}

/** Take the one right to tell the owner about this interrupted update: true for exactly one caller. */
export function claimInterruptedNotice(seen: UpdateMarker, statePath?: string): boolean {
  let wrote = false;
  const after = updateMarker((m) => {
    if (m?.phase !== 'interrupted' || m.writeSeq !== seen.writeSeq) return null;
    wrote = true;
    return { ...m, phase: 'idle' };
  }, statePath);
  // A refused compare-and-swap means another writer moved first: not ours to send.
  return wrote && after?.phase === 'idle' && after.writeSeq === seen.writeSeq + 1;
}
