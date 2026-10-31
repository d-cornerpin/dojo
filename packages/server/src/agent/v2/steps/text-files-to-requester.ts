// Text a reply's files to the iMessage requester, and say so when one did not go.
// `sendIMessageWithAttachment` answers false on a failed send (it does not throw), so the
// answer is read here; a dropped false left the dashboard showing a file the person never got.

import path from 'node:path';
import { createLogger } from '../../../logger.js';

const logger = createLogger('v2-loop');

/** Text each file to the iMessage requester. Never throws. A file that did not go is logged and the agent is told once, so it does not claim it arrived. Resolves true when every file went. */
export async function textFilesToRequester(
  agentId: string,
  recipient: string,
  files: ReadonlyArray<{ path?: string; filename?: string }>,
  firstCaption = '',
): Promise<boolean> {
  const failed: string[] = [];
  let first = true;
  try {
    const { sendIMessageWithAttachment } = await import('../../../services/imessage-bridge.js');
    for (const file of files) {
      if (!file.path) continue;
      const caption = first ? firstCaption : '';
      first = false;
      let landed = false;
      try {
        landed = (await sendIMessageWithAttachment(recipient, file.path, caption)) === true;
      } catch (err) {
        logger.warn('iMessage file delivery threw', { agentId, error: err instanceof Error ? err.message : String(err) }, agentId);
      }
      if (!landed) failed.push(file.filename || path.basename(file.path));
    }
  } catch (err) {
    logger.warn('iMessage file delivery could not start', { agentId, error: err instanceof Error ? err.message : String(err) }, agentId);
    return false;
  }
  if (failed.length === 0) return true;
  try {
    const { postAgentNotice } = await import('../../agent-notice.js');
    postAgentNotice({
      toAgentId: agentId,
      fromName: 'File delivery',
      brief:
        `texting these file(s) to the requester over iMessage failed: ${failed.join(', ')}. They are in the dashboard only. ` +
        `If you reply to the requester, say so; do not tell them the files were sent.`,
      intent: 'file_delivery_outcome',
      selfIntro: false,
    });
  } catch (err) {
    logger.warn('file delivery notice could not be posted', { agentId, error: err instanceof Error ? err.message : String(err) }, agentId);
  }
  return false;
}
