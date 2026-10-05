// ── ONE SET OF AUTOMATION-PERMISSION WORDS, AND THEY NAME THE RIGHT THING ────────────────
//
// ── WHAT WAS WRONG (BACKLOG line 27, reported twice) ──
// The fresh-box review's item D fixed the FULL DISK ACCESS copy, which had told the user to
// grant the permission to Terminal, or to an entry "just called node". The Automation hint has
// the same defect for a different permission, and the FDA clause says so in as many words:
// *"the Automation hint's 'node' is the same CLASS of vagueness and is reported rather than
// silently widened into here."* What shipped was:
//
//   SetupDeps.tsx  "You can also find it in System Settings > Privacy & Security >
//                   Automation > node."
//
// ── WHY THAT IS WRONG, MEASURED ──
//
// 1. THE PANE IS EMPTY UNTIL SOMETHING ASKS, AND IT HAS NO "+" BUTTON. Full Disk Access can be
//    pre-granted by hand, which is why its copy says click "+" and paste a path. Automation
//    cannot: macOS lists an app there only once that app has actually requested control of
//    another one. The server's own route is the proof of the asymmetry — for
//    `full-disk-access` it first ATTEMPTS the read (`fs.readFileSync(chat.db)`) specifically
//    "to trigger macOS to register the Node process ... Without this, the user won't see it in
//    the list to toggle on", and then opens the pane. For `automation` it only opens the pane
//    (`gateway/routes/setup-deps.ts`, `POST /permissions/request/:perm`). So the old hint sent
//    the owner to hunt for a row that does not exist yet, and "not listed" reads as "broken".
//
// 2. IT NAMED THE PARENT AND OMITTED THE SWITCH. An Automation grant is a PAIR — the process
//    asking, and the application it wants to drive — and the checkbox the user has to tick is
//    the TARGET, `Messages`. The old hint stopped at "node" and never said the word Messages,
//    so even a user who found the row did not know what to turn on.
//
// 3. THE ASKING PROCESS IS NOT THE DASHBOARD AND NOT TERMINAL. `services/imessage-bridge.ts`
//    sends either through the `imsg` CLI or, when that is not installed, through
//    `execSync("osascript -e '...tell application \"Messages\"...'")`. Both are helpers the
//    server SPAWNS; macOS holds the responsible process accountable, and for a packaged install
//    that is the Node binary launchd started — the same binary, at the same absolute path, that
//    item D already made the FDA copy name. `GET /api/setup/permissions/check` reports it as
//    `serverExecPath`, so this copy renders the same value rather than inventing a second idea
//    of what is running.
//
// ── WHY A MODULE AND NOT TWO CAREFUL EDITS ──
// Exactly item D's reason: the two surfaces that talk about this permission disagreed because
// they were written twice. One function, imported by both, is why they cannot drift again, and
// `src/__tests__/the-automation-hint-names-the-right-thing.test.ts` pins that neither surface
// writes its own copy. It lives here rather than in `@dojo/shared` because only dashboard
// surfaces read it and the clause that holds it runs in this package's own runner.

/** The Privacy pane the user has to reach, spelled the way macOS spells it. */
export const AUTOMATION_PANE =
  'System Settings > Privacy & Security > Automation';

/**
 * THE APPLICATION BEING DRIVEN — and therefore the checkbox that has to be ticked. An
 * Automation grant is a pair (who is asking, what they want to drive) and this is the half the
 * old hint never mentioned.
 */
export const AUTOMATION_TARGET_APP = 'Messages';

/**
 * The instruction.
 *
 * @param execPath the server's own `process.execPath`, from
 *                 `GET /api/setup/permissions/check`. Unknown means we say so rather than
 *                 guessing — the same rule item D set for Full Disk Access, for the same
 *                 reason: a wrong target is worse than an absent one, because the user grants
 *                 something that is not doing the asking and concludes the feature is broken.
 */
export function automationInstructions(execPath?: string | null): string {
  const known = typeof execPath === 'string' && execPath.trim() !== '';
  const asker = known
    ? `the Node binary that runs the Dojo server (${execPath.trim()})`
    : 'the Node binary that runs the Dojo server (it reports its exact path on this screen once it is running)';
  return (
    'This one is granted by USING it, not by adding it. macOS only lists an app under '
    + `${AUTOMATION_PANE} once that app has actually asked, and this pane has no "+" button — so `
    + 'opening it before anything has tried shows nothing, which is normal rather than broken. '
    + `Send a test iMessage: macOS then asks to let Dojo control ${AUTOMATION_TARGET_APP}, and you `
    + `click OK. After that the row appears in ${AUTOMATION_PANE}, filed under ${asker}, and the `
    + `switch to leave ON is the one named ${AUTOMATION_TARGET_APP}. If you clicked "Don't Allow" `
    + 'the first time, the popup will not come back — turn '
    + `${AUTOMATION_TARGET_APP} back on there instead.`
  );
}

/** The one-line "why", for a surface sitting next to the iMessage toggle. */
export function automationWhy(): string {
  return (
    `Sending an iMessage means driving ${AUTOMATION_TARGET_APP}, which macOS treats as automation. `
    + 'The request comes from the helper the Dojo server runs to do the sending — not from this '
    + 'dashboard, and not from Terminal.'
  );
}

/**
 * WHAT THE STATUS LIGHT ON THIS ROW CAN AND CANNOT SEE, stated rather than implied.
 *
 * ⚠ DELIBERATELY NOT the confident wording its Full Disk Access sibling gets. That one earns it:
 * `checkPermission('full-disk-access')` attempts the very read the permission protects, so a
 * pass is proof. The Automation probe does NOT — it runs `osascript -e "return 1"`, a script
 * that drives no application at all and therefore needs no Automation grant to succeed. So the
 * row is reporting that osascript can run, which is not the question. Rather than let the copy
 * imply a check that is not happening, the only real test is named: send one.
 * (The probe itself is `packages/server/src/gateway/routes/setup-deps.ts` and is handed up —
 * see this lane's report.)
 */
export const AUTOMATION_VERIFY =
  'Dojo cannot check this one for you from here: the only honest test is to send a message and '
  + 'see it arrive, so trust the iMessage test send rather than the status light on this row.';

/**
 * The short form, for a surface that has just FAILED to send and needs one sentence about why.
 * Names the switch, because that is the thing the reader can act on.
 */
export const AUTOMATION_SEND_HINT =
  `If macOS asked whether to let Dojo control ${AUTOMATION_TARGET_APP} and the answer was no, the `
  + `send is blocked until ${AUTOMATION_TARGET_APP} is switched back on under ${AUTOMATION_PANE}.`;
