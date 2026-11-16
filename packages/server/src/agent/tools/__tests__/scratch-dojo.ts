// A scratch Dojo for tests that drive the real tool executor: a fresh home with made-up files, a migrated
// database with the main agent, one helper and the Healer, and the calls that run a tool or the turn loop's dispatch step.
// The calling file keeps its own vi.mock lines (they are hoisted per file).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, vi } from 'vitest';

export const MAIN = 'agent-main';
export const HELPER = 'agent-helper';
export const HEALER = 'agent-healer';
/** A helper allowed every file, command and AppleScript: only the engine's own checks stand in its way. */
export const OPEN_SCOPE = { file_read: '*', file_write: '*', exec_allow: ['*'], exec_deny: [], shell_allow: ['*'], shell_deny: [], network_domains: 'none', max_processes: 1, can_spawn_agents: false, can_assign_permissions: false, system_control: ['applescript'] };

/** Make the scratch home (files are paths under it with their contents), migrate, and seed the agents. */
export async function scratchDojo(name: string, files: Record<string, string> = {}, helperScope: object | null = OPEN_SCOPE) {
  const home = fs.mkdtempSync(path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), `${name}-`));
  vi.stubEnv('DOJO_HOME', home);
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(home, rel)), { recursive: true });
    fs.writeFileSync(path.join(home, rel), body, { mode: 0o600 });
  }
  const connection = await import('../../../db/connection.js');
  const migrations = await import('../../../db/migrations.js');
  const platform = await import('../../../config/platform.js');
  const tools = await import('../index.js');
  const { recordDispatchAndHold } = await import('../../v2/steps/execute/dispatch-bookkeeping.js');
  const { initState } = await import('../../v2/state.js');

  beforeAll(() => {
    migrations.runMigrations();
    const db = connection.getDb();
    const add = db.prepare("INSERT INTO agents (id, name, status, config, classification, permissions, spawn_depth, created_by) VALUES (?, ?, 'idle', '{}', ?, ?, 1, ?)");
    add.run(MAIN, 'main', 'sensei', null, MAIN);
    add.run(HELPER, 'helper', 'apprentice', helperScope ? JSON.stringify(helperScope) : null, MAIN);
    add.run(HEALER, 'healer', 'sensei', JSON.stringify(OPEN_SCOPE), MAIN);
    db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('primary_agent_id', ?), ('healer_agent_id', ?)").run(MAIN, HEALER);
    platform.clearPlatformConfigCache();
  });
  afterAll(() => {
    connection.closeDb();
    vi.unstubAllEnvs();
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 });
  });

  const run = (agentId: string, tool: string, args: Record<string, unknown>) => tools.executeTool(agentId, { id: `call-${tool}`, name: tool, arguments: args });
  /** What the call returned as text. */
  const text = async (agentId: string, tool: string, args: Record<string, unknown>) => tools.toolResultOf(await run(agentId, tool, args)).content;
  /** The turn loop's dispatch step: the refusal (a hold among them) it returns, or null when the call goes ahead. */
  const dispatch = async (agentId: string, tool: string, args: Record<string, unknown>) => (await recordDispatchAndHold(initState({
    agentId, contextWindow: 200_000, isAutoRouted: false, configuredModelId: 'test', turnNumber: 1, triggeredByIMessage: false,
    triggeredByA2AReplyIntent: null, lastUserMessageContent: null, lastUserMessageId: null, inboundChannel: null, inboundContext: null, pendingTechniqueAck: null,
  }), { id: `tc-${tool}`, name: tool, arguments: args } as never, { agentId, db: connection.getDb() } as never)).refusal;
  return { home, run, text, dispatch, blocked: tools.toolWasBlocked };
}

/** Every tool that sends or uploads a file the caller names, with valid arguments naming that file. */
export const UPLOADS = (file: string): Array<[string, Record<string, unknown>]> => [
  ['gmail_send', { to: 'someone@example.com', subject: 'Report', body: 'Attached.', attachments: [file] }],
  ['gmail_draft', { to: 'someone@example.com', subject: 'Report', body: 'Attached.', attachments: [file] }],
  ['user_gmail_draft', { to: 'someone@example.com', subject: 'Report', body: 'Attached.', attachments: [file] }],
  ['outlook_send', { to: 'someone@example.com', subject: 'Report', body: 'Attached.', attachments: [file] }],
  ['outlook_draft', { to: 'someone@example.com', subject: 'Report', body: 'Attached.', attachments: [file] }],
  ['imessage_send', { recipient: 'someone@example.com', text: 'Attached.', attachments: [file] }],
  ['drive_upload', { file_path: file }],
  ['user_drive_upload', { file_path: file }],
  ['onedrive_upload', { file_path: file }],
  ['onedrive_upload_batch', { file_paths: [file] }],
  ['slides_add_image_from_local_path', { presentation_id: 'p1', slide_id: 's1', file_path: file, x_pt: 0, y_pt: 0, width_pt: 10, height_pt: 10 }],
  ['slides_build_slide', { presentation_id: 'p1', elements: [{ kind: 'image_local', x_pt: 0, y_pt: 0, width_pt: 10, height_pt: 10, file_path: file }] }],
];
