// ════════════════════════════════════════════════════════════════════════════
// OFFICE DOCUMENTS (PHASE-5 T4 — relocated from `agent/tools.ts`)
//
// Word, Excel and PowerPoint, local files and OneDrive alike: NINETEEN dispatch
// keys that were nineteen `case` labels on ONE case body, which branches on
// `name` internally. The handler table is keyed on the dispatch key, so all
// nineteen keys must resolve — to the SAME function, which is what the
// fall-through meant. They are listed one per line rather than generated from a
// loop, so `git grep` still finds each tool at its own line.
//
// ── THE SECOND HANDLER-BODY `checkPermission`, MOVED WITH ITS HANDLER ──
// §T0-PINS P6 found exactly TWO permission checks buried inside handler bodies
// rather than declared as gates. `show_to_user`'s went with the comms category;
// THIS IS THE OTHER ONE: for a LOCAL office document the body computes the
// destination (an explicit `path` for an edit, else the agent's uploads dir for
// a create) and puts it through `checkPermission(agentId, { type: 'file_write',
// path: localDest })` — the same floor `file_write` itself enforces. It is
// preserved verbatim. A relocation that dropped it would let any agent that can
// reach an office tool write a file its manifest forbids. Converting it into a
// declared gate is a change of MECHANISM and belongs to T7, which already owns
// this site by name.
//
// The OneDrive branch's own refusal (`isMicrosoftConnected` / `isPrimaryAgent`)
// is likewise the body's, and likewise unchanged.
//
// RELOCATION, NOT REWRITE. The canvas auto-open tail — the ten-name
// `OFFICE_LOCAL_CANVAS_TOOLS` set and the "is now open"/"has been updated"
// wording it appends — is byte-faithful; that string is what stops the model
// calling `share_file` on a document the user is already looking at.
// ════════════════════════════════════════════════════════════════════════════

import os from 'node:os';
import path from 'node:path';
import { getDb } from '../../../db/connection.js';
import { isPrimaryAgent } from '../../../config/platform.js';
import { isMicrosoftConnected } from '../../../microsoft/auth.js';
import { executeOfficeTool } from '../../../microsoft/tools-office.js';
import { checkPermission } from '../../permissions.js';
import { auditLog, permissionDeniedMessage, openFileInCanvas, localOfficePathFromResult } from '../util.js';
import type { ToolHandler, ToolHandlerMap } from '../handler.js';

const officeBody: ToolHandler = async ({ agentId, name, args }) => {
    let content = '';
    let isError = false;
    // ── Local vs Microsoft-account office split (owner decision 2026-07-03) ──
    // The office_* tools are DUAL-destination. A create writes to the agent's
    // LOCAL uploads dir when Microsoft is NOT connected, but UPLOADS to the
    // owner's OneDrive when it is (saveOfficeBuffer → isMicrosoftConnected).
    // An edit/read works on a LOCAL `path` or, when handed a `file_id`, on
    // the OneDrive item; the presentation edit/read tools are file_id-only
    // (always the Microsoft account).
    //   • Anything that writes/edits the connected MICROSOFT account stays
    //     PRIMARY-ONLY: the owner's cloud is the owner's; a sub-agent must
    //     not mutate it.
    //   • A LOCAL office doc is just a file on disk: allowed for ANY agent,
    //     governed by its permission manifest (file_write), exactly like the
    //     file_write tool. No hard primary-only gate (that was the defect the
    //     manifest now enforces after the spawn_depth fix).
    const OFFICE_CREATE_TOOLS = new Set([
      'office_create_word_document', 'office_create_spreadsheet', 'office_create_presentation',
    ]);
    // OneDrive/Graph-only ops with no local mode (they operate on a file_id).
    const OFFICE_MS_ACCOUNT_ONLY_TOOLS = new Set([
      'office_get_presentation_outline', 'office_read_presentation',
      'office_replace_in_presentation', 'office_insert_slide', 'office_delete_slide',
    ]);
    const usesOneDriveFileId = typeof args.file_id === 'string' && (args.file_id as string).trim().length > 0;
    // A create goes to OneDrive only when Microsoft is connected AND the
    // caller is the primary agent; saveOfficeBuffer routes every other
    // agent's create to the LOCAL uploads path. Pre-fix this keyed on the
    // connection alone, so connecting Microsoft flipped every sub-agent
    // create from "local file, manifest-governed" to "account write,
    // denied", the exact split the 2026-07-03 decision forbids. The
    // primary-only wall below still guards every REAL account write
    // (file_id edits and the Graph-only presentation ops).
    const createGoesToOneDrive = OFFICE_CREATE_TOOLS.has(name) && isMicrosoftConnected('agent') && isPrimaryAgent(agentId);
    const targetsMicrosoftAccount = OFFICE_MS_ACCOUNT_ONLY_TOOLS.has(name) || usesOneDriveFileId || createGoesToOneDrive;

    if (targetsMicrosoftAccount) {
      if (!isPrimaryAgent(agentId)) {
        content = 'Permission denied: only the primary agent can create or edit Office documents on the connected Microsoft account.';
        isError = true;
        auditLog(agentId, name, null, 'denied', 'Microsoft-account office tool restricted to primary agent');
        return { content, isError };
      }
    } else {
      // Local office document: enforce the agent's file_write manifest on the
      // destination (an explicit local `path` for an edit, or the agent's
      // uploads dir for a create), the same floor file_write itself enforces.
      const localFilename = typeof args.filename === 'string' && (args.filename as string).trim().length > 0
        ? (args.filename as string).trim()
        : 'document';
      const localDest = typeof args.path === 'string' && (args.path as string).trim().length > 0
        ? (args.path as string).trim()
        : path.join(os.homedir(), '.dojo', 'uploads', agentId, localFilename);
      const perm = checkPermission(agentId, { type: 'file_write', path: localDest });
      if (!perm.allowed) {
        auditLog(agentId, name, localDest, 'denied', perm.reason);
        content = permissionDeniedMessage(perm.reason, agentId);
        isError = true;
        return { content, isError };
      }
    }
    const agentRow = getDb().prepare('SELECT name FROM agents WHERE id = ?').get(agentId) as { name: string } | undefined;
    content = await executeOfficeTool(name, args, agentId, agentRow?.name ?? agentId);
    isError = content.startsWith('Error');
    // Auto-open / refresh the canvas for Word & Excel writes that touch a
    // LOCAL file, creates AND in-place edits (replace/insert/delete/append
    // save back to the same path). The canvas renders them as a formatted
    // preview; for an edit to the already-open doc openFileInCanvas just
    // refreshes it. PowerPoint isn't canvas-renderable, so it's excluded.
    // OneDrive results carry no local path, so this is a no-op for them.
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

// One body, nineteen labels — the switch's fall-through, written down.
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
