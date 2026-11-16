// PDF, Google Slides and Google Forms: table entries like every other tool, so their results pass the
// executor's tail (outside-text fence, view limit, unknown-argument warning).

import { getDb } from '../../../db/connection.js';
import { isPrimaryAgent, isPMAgent } from '../../../config/platform.js';
import { getAgentGoogleAccessLevel } from '../../../google/auth.js';
import { slidesToolNames, executeGoogleSlidesTool } from '../../../google/tools-slides.js';
import { formsToolNames, executeGoogleFormsTool } from '../../../google/tools-forms.js';
import { pdfToolNames, executePdfTool } from '../../pdf-tools.js';
import { auditLog, openFileInCanvas } from '../util.js';
import type { ToolHandler, ToolHandlerMap } from '../handler.js';

const pdfBody: ToolHandler = async ({ agentId, name, args }) => {
  let content = await executePdfTool(name, args, agentId);
  const isError = content.startsWith('Error');
  // Auto-open a PRODUCED pdf; read-only PDF tools produce no file and must not re-open an input.
  const pdfPath = isError || name === 'pdf_read' || name === 'pdf_get_info' ? undefined : content.match(/(\/\S+\.pdf)\b/i)?.[1];
  if (pdfPath && openFileInCanvas(agentId, pdfPath).opened) {
    content += '\n\nThis PDF is now open in the canvas, the user can see it. No need to call canvas_render, show_to_user, or share_file to show it; just tell them it is on the canvas (share the download link only if they ask to save it).';
  }
  return { content, isError };
};

/** Primary AND read-level agents; PM agents ('none') are refused. */
const googleDocBody = (label: string, run: typeof executeGoogleSlidesTool): ToolHandler => async ({ agentId, name, args }) => {
  if (getAgentGoogleAccessLevel(agentId, isPrimaryAgent(agentId), isPMAgent(agentId)) === 'none') {
    auditLog(agentId, name, null, 'denied', `Google ${label} tool blocked: no Google access`);
    return { content: `Permission denied: this agent does not have Google ${label} access.`, isError: true };
  }
  const agentRow = getDb().prepare('SELECT name FROM agents WHERE id = ?').get(agentId) as { name: string } | undefined;
  const content = await run(name, args, agentId, agentRow?.name ?? agentId);
  return { content, isError: content.startsWith('Error') };
};

const slidesBody = googleDocBody('Slides', executeGoogleSlidesTool);
const formsBody = googleDocBody('Forms', executeGoogleFormsTool);

export const documentHandlers: ToolHandlerMap = Object.fromEntries([
  ...pdfToolNames.map((n) => [n, pdfBody] as const),
  ...slidesToolNames.map((n) => [n, slidesBody] as const),
  ...formsToolNames.map((n) => [n, formsBody] as const),
]);
