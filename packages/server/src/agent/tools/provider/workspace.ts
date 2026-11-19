// GOOGLE AND MICROSOFT: one handler per definition, so no account tool runs unasked. The account is resolved
// as its executor resolves it, then the one account door (`access/workspace.ts`) answers before anything runs.

import type { AccountKind } from '@dojo/shared';
import { getDb } from '../../../db/connection.js';
import { googleReadToolDefinitions, executeGoogleReadTool } from '../../../google/tools-read.js';
import { googleWriteToolDefinitions, executeGoogleWriteTool } from '../../../google/tools-write.js';
import { slidesToolDefinitions, executeGoogleSlidesTool } from '../../../google/tools-slides.js';
import { formsToolDefinitions, executeGoogleFormsTool } from '../../../google/tools-forms.js';
import { resolveGoogleAccountForRead, resolveGoogleAccountForTool } from '../../../google/accounts.js';
import { microsoftReadToolDefinitions, executeMicrosoftReadTool } from '../../../microsoft/tools-read.js';
import { microsoftWriteToolDefinitions, executeMicrosoftWriteTool } from '../../../microsoft/tools-write.js';
import { resolveMicrosoftAccountForRead, resolveMicrosoftAccountForTool } from '../../../microsoft/accounts.js';
import { accountKindForTool, accountRefusal, type WorkspaceProvider } from '../../access/workspace.js';
import { prependMailboxOwnerHeader } from './mailbox-banner.js';
import { auditLog } from '../util.js';
import type { ToolDefinition } from '../types.js';
import type { ToolHandler, ToolHandlerMap } from '../handler.js';

type Run = (name: string, args: Record<string, unknown>, agentId: string, agentName: string) => Promise<string>;
type Resolve = (kind: AccountKind, email?: string) =>
  { account: { id: string | null; enabledServices: string | null } } | { error: string };

function handlersFor(defs: readonly ToolDefinition[], provider: WorkspaceProvider, run: Run, resolve: Resolve) {
  return defs.map((def): [string, ToolHandler] => [def.name, async ({ agentId, name, args }) => {
    const kind = accountKindForTool(name);
    const resolved = resolve(kind, args.account as string | undefined);
    // An account that does not resolve is asked on the kind's grant; the executor then explains why.
    const account = 'error' in resolved ? { id: null, enabledServices: null } : resolved.account;
    const refusal = accountRefusal(agentId, def, provider, { ...account, kind });
    if (refusal) {
      auditLog(agentId, name, null, 'denied', refusal);
      return { content: refusal, isError: true, errorCode: 'PERMISSION_DENIED' };
    }
    const agentRow = getDb().prepare('SELECT name FROM agents WHERE id = ?').get(agentId) as { name: string } | undefined;
    const content = prependMailboxOwnerHeader(await run(name, args, agentId, agentRow?.name ?? agentId), name, args);
    return { content, isError: content.startsWith('Error') };
  }]);
}

// Executors and resolvers are called through, so their modules are read when a tool runs, not at table build.
export const workspaceHandlers: ToolHandlerMap = Object.fromEntries([
  ...handlersFor(googleReadToolDefinitions, 'google', (...a) => executeGoogleReadTool(...a), (k, e) => resolveGoogleAccountForRead(k, e)),
  ...handlersFor(googleWriteToolDefinitions, 'google', (...a) => executeGoogleWriteTool(...a), (k, e) => resolveGoogleAccountForTool(k, e)),
  ...handlersFor(slidesToolDefinitions, 'google', (...a) => executeGoogleSlidesTool(...a), (k, e) => resolveGoogleAccountForTool(k, e)),
  ...handlersFor(formsToolDefinitions, 'google', (...a) => executeGoogleFormsTool(...a), (k, e) => resolveGoogleAccountForTool(k, e)),
  ...handlersFor(microsoftReadToolDefinitions, 'microsoft', (...a) => executeMicrosoftReadTool(...a), (k, e) => resolveMicrosoftAccountForRead(k, e)),
  ...handlersFor(microsoftWriteToolDefinitions, 'microsoft', (...a) => executeMicrosoftWriteTool(...a), (k, e) => resolveMicrosoftAccountForTool(k, e)),
]);
