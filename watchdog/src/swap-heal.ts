// Watchdog: repairing a cut-off platform swap.
// Every install switches `~/.dojo/platform` with two renames (live -> backup, staged -> live);
// a crash between them leaves NO platform folder: launchd cannot start the platform, so nothing
// inside the platform can repair it. This daemon can: with the folder missing it runs
// `rollback.sh --heal`, finishing the update if the staged tree is whole, else restoring the newest backup.

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
  // No pid: either being taken this instant, or an old leftover once it is stale.
  try { return Date.now() - fs.statSync(lock).mtimeMs < 60_000; } catch { return false; }
}

export type SwapHeal =
  | { action: 'none' }
  | { action: 'wait' }
  | { action: 'heal'; finishes: 'update' | 'restore' | 'nothing-to-restore'; text: string };

export function decideSwapHeal(dojoDir: string, marker: UpdateMarker | null): SwapHeal {
  if (fs.existsSync(path.join(dojoDir, 'platform', 'package.json'))) return { action: 'none' };
  // Only a packaged install has a platform folder to lose: install.sh writes this launchd job
  // beside it. A box that runs from a source checkout has neither, and nothing is missing.
  const job = path.join(path.dirname(dojoDir), 'Library', 'LaunchAgents', 'com.dojo.platform.plist');
  if (!fs.existsSync(job)) return { action: 'none' };
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
