// One set of Full Disk Access words for every surface. The server runs under launchd as the node binary at an
// absolute path (`process.execPath`), not Terminal, so the copy names that path.

export const FULL_DISK_ACCESS_PANE =
  'System Settings > Privacy & Security > Full Disk Access';

/** With no execPath it says so rather than guessing: a wrong path would grant a program that does not read. */
export function fullDiskAccessInstructions(execPath?: string | null): string {
  const target = execPath && execPath.trim() !== ''
    ? `the file at ${execPath}`
    : 'the Node executable that runs the Dojo server (the server reports its exact path on this screen once it is running)';
  return (
    `Open ${FULL_DISK_ACCESS_PANE}, click "+", press Cmd+Shift+G, and paste this path: ` +
    `${execPath && execPath.trim() !== '' ? execPath : '<the path shown above>'}. ` +
    `You are granting access to ${target} — not to Terminal, and not to an entry just called ` +
    '"node", which may be a different install. Restart the Dojo server afterwards so it picks the ' +
    'grant up.'
  );
}

export function fullDiskAccessWhy(): string {
  return (
    'iMessage needs Full Disk Access because the bridge reads your Messages database. macOS grants '
    + 'that to a specific executable, and for a Dojo install that is the Node binary launchd starts '
    + '— not Terminal.'
  );
}

// Verified by reading ~/Library/Messages/chat.db (setup-deps.ts); a new grant applies only after a restart.
export const FULL_DISK_ACCESS_VERIFY =
  'Dojo verifies this by actually reading your Messages database, so a green check is proof, not a '
  + 'guess. If it still says denied right after you granted it, restart the Dojo server — macOS '
  + 'only applies a new grant to a freshly started process.';
