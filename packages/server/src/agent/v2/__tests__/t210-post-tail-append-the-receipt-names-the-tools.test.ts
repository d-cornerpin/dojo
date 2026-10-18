// ════════════════════════════════════════════════════════════════════════════════════════
// t210 (t206 hand-up) — THE RECEIPT NAMES THE TOOLS THE CALL WAS BUILT WITH.
//
// t206 saw `sys.tools` flip between two sizes at turn starts and could not say why: the
// generator is a pure function of the agent's tool list, and the receipt did not record the
// list. Each receipt now carries a hash and a count of the PERMITTED tool names (what the
// system prompt's tool section is built from) and of the SENT ones (the definitions block),
// so the next measurement can name the cause. And on an appended call (decision 37) the
// turn's own conversation rows past `volatileFrom` are not counted as loop tail.
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const permitted = { names: ['web_search', 'work_update'] };
vi.mock('../../tools/surface.js', () => ({
  getFilteredTools: () => permitted.names.map((name) => ({ name, description: '', input_schema: {} })),
}));
vi.mock('../../../tools/tool-docs.js', () => ({
  filterToolsForApiCall: (_a: string, all: Array<{ name: string }>) => all.slice(0, 1),
  getAgentAlwaysLoadedTools: () => [],
}));

const AGENT = 'agent-receipt';
const REAL_HOME = process.env.DOJO_HOME;
const REAL_MODE = process.env.DOJO_RECEIPT_MODE;
afterEach(() => { process.env.DOJO_HOME = REAL_HOME; process.env.DOJO_RECEIPT_MODE = REAL_MODE; });

type Rec = { tools: Record<string, string | number> | null; assembly: { lanes: Array<{ id: string; reason: string }> } };

async function writeOne(messageEntryIds: Array<string | null>, volatileFrom: number): Promise<Rec> {
  const scratch = fs.mkdtempSync(path.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-t210-receipt-'));
  process.env.DOJO_HOME = scratch;
  process.env.DOJO_RECEIPT_MODE = 'meta';
  const { writeContextReceipt } = await import('../receipt.js');
  writeContextReceipt({
    agentId: AGENT, modelId: 'm', turnNumber: 1, loopCount: 2, useTools: true, systemPrompt: 'sys',
    messages: messageEntryIds.map((_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i} ${'x'.repeat(400)}` })),
    messageEntryIds, volatileFrom,
    allocation: {
      budgetTokens: 1000, reservedTokens: 0, spentTokens: 0, offTheTopTokens: 0, admittedIds: [], overBudget: [],
      grants: [{ id: 'lane.loop-tail', slot: 1850, priority: Number.MAX_SAFE_INTEGER, requested: 0, granted: 0, status: 'empty', reason: 'did not fire' }],
    },
  });
  const dir = path.join(scratch, '.dojo', 'receipts', AGENT);
  for (let i = 0; i < 200; i++) {
    try {
      const file = fs.readdirSync(dir)[0];
      if (file) return JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as Rec;
    } catch { /* not written yet */ }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('the receipt never appeared');
}

describe('t210 — the receipt names the tools', () => {
  it('records a hash and a count of the permitted and the sent tool names, and the hash moves with the list', async () => {
    const a = await writeOne(['lane.fresh-tail', 'msg.current-time'], 1);
    expect(a.tools).toMatchObject({ permittedCount: 2, sentCount: 1 });
    expect(typeof a.tools?.permittedSha256).toBe('string');
    permitted.names = ['web_search', 'work_update', 'outlook_search'];
    const b = await writeOne(['lane.fresh-tail', 'msg.current-time'], 1);
    expect(b.tools?.permittedCount).toBe(3);
    expect(b.tools?.permittedSha256).not.toBe(a.tools?.permittedSha256);
    expect(b.tools?.sentSha256, 'the sent head did not change').toBe(a.tools?.sentSha256);
  });

  it('an appended call: the turn\'s own conversation rows past the boundary are not counted as loop tail', async () => {
    const r = await writeOne(['lane.fresh-tail', 'msg.current-time', 'lane.fresh-tail', 'lane.fresh-tail', 'msg.current-time'], 1);
    const loopTail = r.assembly.lanes.find((l) => l.id === 'lane.loop-tail');
    expect(loopTail?.reason).toContain('2 message(s) (msg.current-time)');
  });
});
