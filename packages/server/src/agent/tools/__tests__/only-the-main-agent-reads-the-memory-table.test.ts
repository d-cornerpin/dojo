// The main agent reads its own memory table (vault_entries) through the sqlite3 door and dojo_inspect;
// the Healer and any other agent are refused it as before, and the account tables stay refused for all.
// The dojo_inspect view is asked directly, under the grant gate, so a helper stands for one that holds it.

import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';

vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

const { scratchDojo, MAIN, HELPER, HEALER } = await import('./scratch-dojo.js');
const { home } = await scratchDojo('memory-table');
const { authorizeExecShapedCall, grantFor } = await import('../../brokers/index.js');
const { dojoInspect } = await import('../../../inspect/index.js');

const shell = (agent: string, table: string) =>
  authorizeExecShapedCall(grantFor(agent), 'shell', `sqlite3 -readonly ${path.join(home, '.dojo', 'data', 'dojo.db')} "SELECT * FROM ${table} LIMIT 5"`).allowed;
const inspect = (agent: string, table: string) => dojoInspect({ what: 'sql', query: `SELECT * FROM ${table} LIMIT 5` }, agent);

describe('only the main agent reads the memory table', () => {
  it('the main agent reads vault_entries on both doors', async () => {
    expect(shell(MAIN, 'vault_entries')).toBe(true);
    expect(await inspect(MAIN, 'vault_entries')).not.toMatch(/^Refused/);
  });

  it.each([HEALER, HELPER])('%s is refused vault_entries', async (agent) => {
    if (agent === HEALER) expect(shell(agent, 'vault_entries')).toBe(false);
    expect(await inspect(agent, 'vault_entries')).toMatch(/vault_entries, which holds credentials \(or the owner's private memory\)/);
  });

  it.each(['agent_credentials', 'google_accounts', 'plaud'])('every agent is refused %s', async (table) => {
    expect(shell(MAIN, table)).toBe(false);
    expect(await inspect(MAIN, table)).toMatch(/^Refused/);
  });
});
