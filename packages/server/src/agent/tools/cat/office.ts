// OFFICE DOCUMENTS: Word, Excel, PowerPoint, local files and OneDrive alike.
// NINETEEN dispatch keys onto ONE body that branches on `name`: all resolve
// to the same function (the old fall-through), each on its own line for `git grep`.
// Account writes are primary-only here (the owner's cloud is the owner's); a local
// document's path is asked by the one file check, from the declared effects.

import { getDb } from '../../../db/connection.js';
import { isPrimaryAgent } from '../../../config/platform.js';
import { isMicrosoftConnected } from '../../../microsoft/auth.js';
import { executeOfficeTool } from '../../../microsoft/tools-office.js';
import { auditLog, openFileInCanvas, localOfficePathFromResult } from '../util.js';
import type { ToolHandler, ToolHandlerMap } from '../handler.js';

const officeBody: ToolHandler = async ({ agentId, name, args }) => {
    let content = '';
    let isError = false;
    // Anything that writes/edits the connected MICROSOFT account stays
    // PRIMARY-ONLY: the owner's cloud is the owner's; a sub-agent must not mutate it.
    const OFFICE_CREATE_TOOLS = new Set([
      'office_create_word_document', 'office_create_spreadsheet', 'office_create_presentation',
    ]);
    // OneDrive/Graph-only ops with no local mode (they operate on a file_id).
    const OFFICE_MS_ACCOUNT_ONLY_TOOLS = new Set([
      'office_get_presentation_outline', 'office_read_presentation',
      'office_replace_in_presentation', 'office_insert_slide', 'office_delete_slide',
    ]);
    const usesOneDriveFileId = typeof args.file_id === 'string' && (args.file_id as string).trim().length > 0;
    // A create reaches OneDrive only when Microsoft is connected AND the caller
    // is primary; every other create lands in local uploads via `saveOfficeBuffer`.
    const createGoesToOneDrive = OFFICE_CREATE_TOOLS.has(name) && isMicrosoftConnected('agent') && isPrimaryAgent(agentId);
    const targetsMicrosoftAccount = OFFICE_MS_ACCOUNT_ONLY_TOOLS.has(name) || usesOneDriveFileId || createGoesToOneDrive;

    if (targetsMicrosoftAccount && !isPrimaryAgent(agentId)) {
      auditLog(agentId, name, null, 'denied', 'Microsoft-account office tool restricted to primary agent');
      return { content: 'Permission denied: only the primary agent can create or edit Office documents on the connected Microsoft account.', isError: true };
    }
    const agentRow = getDb().prepare('SELECT name FROM agents WHERE id = ?').get(agentId) as { name: string } | undefined;
    content = await executeOfficeTool(name, args, agentId, agentRow?.name ?? agentId);
    isError = content.startsWith('Error');
    // Canvas auto-open for Word & Excel LOCAL writes (creates and in-place
    // edits); the appended line stops `share_file` on a doc the user can see.
    const OFFICE_LOCAL_CANVAS_TOOLS = new Set([
      'office_create_word_document', 'office_append_to_word_document',
      'office_replace_in_word_document', 'office_insert_in_word_document',
      'office_delete_block_in_word_document', 'office_create_spreadsheet',
      'office_write_spreadsheet_range', 'office_append_spreadsheet_rows',
      'office_add_sheet', 'office_delete_sheet',
    ]);
    if (!isError && OFFICE_LOCAL_CANVAS_TOOLS.has(name)) {
      const localPath = localOfficePathFromResult(content);
      if (localPath && openFileInCanvas(agentId, localPath).opened) {
        const verb = name === 'office_create_word_document' || name === 'office_create_spreadsheet' ? 'is now open' : 'has been updated';
        content += `\n\nThis document ${verb} in the canvas, the user can see it as a formatted preview. No need to call canvas_render, show_to_user, or share_file; just tell them it is on the canvas (share the download link only if they ask to save it).`;
      }
    }
    return { content, isError };
  };

export const officeHandlers: ToolHandlerMap = {
  office_create_word_document: officeBody,
  office_append_to_word_document: officeBody,
  office_get_word_document_outline: officeBody,
  office_read_word_document: officeBody,
  office_replace_in_word_document: officeBody,
  office_insert_in_word_document: officeBody,
  office_delete_block_in_word_document: officeBody,
  office_create_spreadsheet: officeBody,
  office_get_spreadsheet_range: officeBody,
  office_write_spreadsheet_range: officeBody,
  office_append_spreadsheet_rows: officeBody,
  office_add_sheet: officeBody,
  office_delete_sheet: officeBody,
  office_create_presentation: officeBody,
  office_get_presentation_outline: officeBody,
  office_read_presentation: officeBody,
  office_replace_in_presentation: officeBody,
  office_insert_slide: officeBody,
  office_delete_slide: officeBody,
};
