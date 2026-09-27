// ── ONE SET OF FULL-DISK-ACCESS WORDS, AND THEY NAME THE RIGHT THING ──────────────────────
//
// ── WHAT WAS WRONG (fresh-box audit, finding 5) ──
// Two surfaces gave three different instructions and none of them was correct for a packaged
// install:
//   Settings.tsx:419  "Requires Full Disk Access for Terminal"
//   Settings.tsx:663  "ensure Terminal has Full Disk Access … > Enable Terminal"
//   SetupDeps.tsx:588 'macOS … add "node" to the list … look for "node" and toggle it ON'
//
// MEASURED: `deploy/install.sh:231` resolves `NODE_PATH=$(which node)` and writes a LaunchAgent
// whose `ProgramArguments` are `[<that node>, <platform>/packages/server/dist/index.js]`. So the
// server runs under launchd as the **node binary at a specific absolute path** — there is no
// Terminal in the picture at all (Terminal is only involved if a developer starts the server by
// hand), and "node" alone is ambiguous because the list shows a name, not a path, and a box can
// easily have several. On the audited machine that path is under `~/.nvm/versions/node/<ver>/bin`,
// which the user cannot guess and cannot find by browsing.
//
// So the copy must NAME THE PATH, and the only component that knows it is the running server —
// `process.execPath`. `GET /api/setup/permissions/check` now returns it as `serverExecPath` and
// both surfaces render it into the same sentence from here.
//
// ── WHY A SHARED CONSTANT RATHER THAN TWO CAREFUL EDITS ──
// The two surfaces disagreed for the same reason they were written twice. One function, imported
// by both, is why they cannot drift again; `__tests__` pins that neither surface writes its own.

/** The Privacy pane the user has to reach, spelled the way macOS spells it. */
export const FULL_DISK_ACCESS_PANE =
  'System Settings > Privacy & Security > Full Disk Access';

/**
 * The instruction, with the exact executable to add.
 *
 * @param execPath the server's own `process.execPath`, from
 *                 `GET /api/setup/permissions/check`. When it is unknown we say so rather than
 *                 guessing a path — a wrong path is worse than an absent one here, because the
 *                 user would grant access to something that is not doing the reading.
 */
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

/** The one-line "why" that sits next to the iMessage toggle. */
export function fullDiskAccessWhy(): string {
  return (
    'iMessage needs Full Disk Access because the bridge reads your Messages database. macOS grants '
    + 'that to a specific executable, and for a Dojo install that is the Node binary launchd starts '
    + '— not Terminal.'
  );
}

/**
 * How the grant is verified, in words, for a surface that wants to explain the check.
 *
 * The grant IS testable and is tested: the server attempts to read
 * `~/Library/Messages/chat.db` and reports `granted` or `denied`
 * (`setup-deps.ts`'s `checkPermission('full-disk-access')`). That is the very read the permission
 * protects, so a pass is proof rather than an inference — which is why there is no
 * "we cannot verify this automatically" line here. There is one thing it cannot see, and it is
 * stated instead of hidden: a grant made while the server is running is not picked up until the
 * server restarts, so a `denied` immediately after granting means "restart", not "it failed".
 */
export const FULL_DISK_ACCESS_VERIFY =
  'Dojo verifies this by actually reading your Messages database, so a green check is proof, not a '
  + 'guess. If it still says denied right after you granted it, restart the Dojo server — macOS '
  + 'only applies a new grant to a freshly started process.';
