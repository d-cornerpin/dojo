// PDF: table entries like every other tool, so their results pass the executor's tail (outside-text
// fence, view limit, unknown-argument warning).

import { pdfToolNames, executePdfTool } from '../../pdf-tools.js';
import { openFileInCanvas } from '../util.js';
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

export const documentHandlers: ToolHandlerMap = Object.fromEntries(pdfToolNames.map((n) => [n, pdfBody]));
