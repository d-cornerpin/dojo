
/** The Privacy pane the user has to reach, spelled the way macOS spells it. */
export const AUTOMATION_PANE =
  'System Settings → Privacy & Security → Automation';

/** An Automation grant is a pair (who asks, what it drives); this is the target and the checkbox to tick. */
export const AUTOMATION_TARGET_APP = 'Messages';

/** execPath is the server's process.execPath; unknown is stated, never guessed: a wrong target misleads. */
export function automationInstructions(execPath?: string | null): string {
  const known = typeof execPath === 'string' && execPath.trim() !== '';
  const asker = known
    ? `the Node binary that runs the Dojo server (${execPath.trim()})`
    : 'the Node binary that runs the Dojo server (it reports its exact path on this screen once it is running)';
  return (
    'This one is granted by USING it, not by adding it. macOS only lists an app under '
    + `${AUTOMATION_PANE} once that app has actually asked, and this pane has no "+" button, so `
    + 'opening it before anything has tried shows nothing, which is normal rather than broken. '
    + `Checking this row is itself the asking: Dojo puts one harmless question to ${AUTOMATION_TARGET_APP}, `
    + `so expect a macOS popup the first time asking whether to let Dojo control `
    + `${AUTOMATION_TARGET_APP}, click OK. After that the row appears in ${AUTOMATION_PANE}, filed `
    + `under ${asker}, and the switch to leave ON is the one named ${AUTOMATION_TARGET_APP}. If you `
    + `clicked "Don't Allow" the first time, the popup will not come back, turn `
    + `${AUTOMATION_TARGET_APP} back on there instead.`
  );
}

/** The probe performs the very operation the permission governs; a first popup is the check working. */
export const AUTOMATION_VERIFY =
  `Dojo checks this one for real: it asks ${AUTOMATION_TARGET_APP} for its own name, which sends `
  + 'nothing and changes nothing, so a green check here is proof rather than a guess. The first '
  + 'check is also what makes macOS ask, so a popup the first time is this check working. If this '
  + `row says denied, the ${AUTOMATION_TARGET_APP} switch really is off; if it says unknown, `
  + `${AUTOMATION_TARGET_APP} could not be reached at all and the steps above are the way in.`;

export const AUTOMATION_SEND_HINT =
  `If macOS asked whether to let Dojo control ${AUTOMATION_TARGET_APP} and the answer was no, the `
  + `send is blocked until ${AUTOMATION_TARGET_APP} is switched back on under ${AUTOMATION_PANE}.`;
