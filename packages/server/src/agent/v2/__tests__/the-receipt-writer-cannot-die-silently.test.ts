// ════════════════════════════════════════════════════════════════════════════════════════
// UX-REPAIR ROUND 14 / T67 — THE CONTEXT-RECEIPT INSTRUMENT SAYS WHETHER IT IS RUNNING.
//
// ── THE INCIDENT, AND THE STEP-0 THAT CORRECTED IT ──────────────────────────────────────
// Receipts stopped at `t4978`, `2026-08-17T03:12:14Z`, and the whole round-14 review then ran
// unrecorded: S1 could not observe its own turn's context because no receipt for t4979 exists.
// The round read that as a writer that had died.
//
// IT HAD NOT. `config.context_receipt_mode` reads `off` and its `updated_at` is
// `2026-08-17 03:12:21` — seven seconds AFTER that last receipt. The kit's prefix gate
// (`checks/check-message-prefix.mjs`) turns the mode to `meta` for the turns it drives and
// restores the prior value on every path; the last four receipts on the box are its drive
// (t4975–t4978, eight seconds apart) and the "stop" is its restore. The mode was `off` for the
// rounds, as it has been by default since 2026-06-12. Nothing crashed.
//
// So the defect is THE SILENCE. Two questions were unanswerable from anywhere — "are receipts
// on?" and "is the writer working?" — and a review round was spent before either could be
// asked. The three clauses below are the three answers, and each fails at HEAD.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const logs: Array<{ level: string; msg: string; data: Record<string, unknown> }> = [];
const configValue: { current: string | null } = { current: null };

vi.mock('../../../logger.js', () => ({
  createLogger: () => ({
    debug: (msg: string, data: Record<string, unknown> = {}) => { logs.push({ level: 'debug', msg, data }); },
    info: (msg: string, data: Record<string, unknown> = {}) => { logs.push({ level: 'info', msg, data }); },
    warn: (msg: string, data: Record<string, unknown> = {}) => { logs.push({ level: 'warn', msg, data }); },
    error: (msg: string, data: Record<string, unknown> = {}) => { logs.push({ level: 'error', msg, data }); },
  }),
}));

vi.mock('../../../db/connection.js', () => ({
  getDb: () => ({
    prepare: () => ({
      get: () => (configValue.current === null ? undefined : { value: configValue.current }),
      all: () => [],
      run: () => ({ changes: 0 }),
    }),
  }),
}));

// t277: THE WRITER'S TOOL-LIST HELPERS ARE STUBBED BECAUSE EVERY CLAUSE HERE SENDS `useTools: false`.
// `receipt.ts` imports `getFilteredTools` (the whole tool-surface graph: definitions, google,
// microsoft, plaud, credentials...) only to name the tools a call was built with. Each clause needs
// a FRESH `receipt.js` (the announce latch and counters are module state, by design), so each one
// re-imported that whole graph inside its own 30 s budget: ~1.3 s idle, 13 s for the first clause
// on a loaded box, a timeout when several suites ran at once. The clauses never reach
// `toolNameLists`, so the stub changes nothing they observe and the fresh import is now small.
vi.mock('../../tools/surface.js', () => ({ getFilteredTools: () => [] }));
vi.mock('../../../tools/tool-docs.js', () => ({
  filterToolsForApiCall: () => [],
  getAgentAlwaysLoadedTools: () => [],
}));

/** A fresh module per test: the announce latch is module state by design. */
async function freshReceipt(): Promise<typeof import('../receipt.js')> {
  vi.resetModules();
  return import('../receipt.js');
}

const modeLines = (): Array<{ level: string; msg: string; data: Record<string, unknown> }> =>
  logs.filter((l) => /context receipts are (ON|OFF)/.test(l.msg));

const lossLines = (): Array<{ level: string; msg: string; data: Record<string, unknown> }> =>
  logs.filter((l) => /COULD NOT BE (WRITTEN|BUILT)/.test(l.msg));

const REAL_ENV = process.env.DOJO_RECEIPT_MODE;

beforeEach(() => {
  logs.length = 0;
  configValue.current = null;
  delete process.env.DOJO_RECEIPT_MODE;
});

afterEach(() => {
  vi.restoreAllMocks();
  if (REAL_ENV === undefined) delete process.env.DOJO_RECEIPT_MODE;
  else process.env.DOJO_RECEIPT_MODE = REAL_ENV;
});

// ── CLAUSE 1: THE EDGE IS ANNOUNCED ─────────────────────────────────────────────────────

describe('T67 — every change of the switch says so, which is the line that did not exist at 03:12:21', () => {
  it('RED→GREEN: OFF is announced once, naming where the answer came from', async () => {
    const { getReceiptMode } = await freshReceipt();
    configValue.current = 'off';
    expect(getReceiptMode()).toBe('off');
    expect(modeLines()).toHaveLength(1);
    expect(modeLines()[0].msg).toMatch(/context receipts are OFF/);
    expect(modeLines()[0].data).toMatchObject({ source: 'config', from: null });
  });

  it('RED→GREEN: the RESTORE that ended the round — meta then off — is two lines, not silence', async () => {
    const { getReceiptMode } = await freshReceipt();
    configValue.current = 'meta';
    expect(getReceiptMode()).toBe('meta');
    // The kit's restore, and the 30s mode cache stepped over the way the real clock does.
    configValue.current = 'off';
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000);
    expect(getReceiptMode()).toBe('off');

    expect(modeLines().map((l) => l.msg.slice(0, 30))).toEqual([
      'context receipts are ON — ever',
      'context receipts are OFF — no ',
    ]);
    expect(modeLines()[1].data, 'the line states what it changed FROM, so a log reader sees the flip').toMatchObject({ from: 'meta' });
  });

  it('it speaks on the EDGE only — a hundred calls at one setting is one line', async () => {
    const { getReceiptMode } = await freshReceipt();
    configValue.current = 'meta';
    for (let i = 0; i < 100; i++) getReceiptMode();
    expect(modeLines()).toHaveLength(1);
  });

  it('the env override is reported as the env, because that is a different thing to debug', async () => {
    const { getReceiptMode } = await freshReceipt();
    configValue.current = 'off';
    process.env.DOJO_RECEIPT_MODE = 'full';
    expect(getReceiptMode()).toBe('full');
    expect(modeLines()[0].data).toMatchObject({ source: 'env', mode: 'full' });
  });
});

// ── CLAUSE 2: A DEATH IS LOUD ───────────────────────────────────────────────────────────

describe('T67 — an ENABLED writer that writes nothing is a warning, not a debug line', () => {
  it('RED→GREEN: a failed write WARNS and names the file', async () => {
    const mod = await freshReceipt();
    configValue.current = 'meta';
    vi.spyOn(fs.promises, 'mkdir').mockRejectedValue(new Error('EACCES: permission denied'));

    mod.writeContextReceipt({
      agentId: 'harnessbot', modelId: 'm', turnNumber: 1, loopCount: 1,
      systemPrompt: 'you are a bot', messages: [{ role: 'user', content: 'hi' }], useTools: false,
    });
    await new Promise((r) => setTimeout(r, 10));

    expect(lossLines()).toHaveLength(1);
    expect(lossLines()[0].level, 'debug is a level nobody reads — that is the whole defect').toBe('warn');
    expect(lossLines()[0].data).toMatchObject({ agentId: 'harnessbot', mode: 'meta' });
    expect(String(lossLines()[0].data.error)).toMatch(/EACCES/);
  });

  it('CONTROL: the turn is never affected — a failing writer throws nothing into its caller', async () => {
    const mod = await freshReceipt();
    configValue.current = 'full';
    vi.spyOn(fs.promises, 'mkdir').mockRejectedValue(new Error('disk gone'));
    expect(() => mod.writeContextReceipt({
      agentId: 'harnessbot', modelId: 'm', turnNumber: 1, loopCount: 1,
      systemPrompt: 's', messages: [{ role: 'user', content: 'hi' }], useTools: false,
    })).not.toThrow();
  });

  it('CONTROL: with the instrument OFF nothing is attempted and nothing is said — off is not a fault', async () => {
    const mod = await freshReceipt();
    configValue.current = 'off';
    const mkdir = vi.spyOn(fs.promises, 'mkdir');
    mod.writeContextReceipt({
      agentId: 'harnessbot', modelId: 'm', turnNumber: 1, loopCount: 1,
      systemPrompt: 's', messages: [{ role: 'user', content: 'hi' }], useTools: false,
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(mkdir).not.toHaveBeenCalled();
    expect(lossLines()).toHaveLength(0);
  });
});

describe('a receipt file is never visible half-written', () => {
  it('the bytes go to a temporary name and the receipt takes its final name whole', async () => {
    const mod = await freshReceipt();
    configValue.current = 'meta';
    const written = vi.spyOn(fs.promises, 'writeFile');
    mod.writeContextReceipt({
      agentId: 'wholebot', modelId: 'm', turnNumber: 1, loopCount: 1,
      systemPrompt: 's', messages: [{ role: 'user', content: 'hi' }], useTools: false,
    });
    await vi.waitFor(() => expect(written).toHaveBeenCalled());
    const dir = path.dirname(String(written.mock.calls[0][0]));
    expect(String(written.mock.calls[0][0]).endsWith('.json'), 'a reader lists *.json: nothing is written under that name').toBe(false);
    await vi.waitFor(() => expect(fs.readdirSync(dir).filter((f) => f.endsWith('.json'))).toHaveLength(1));
    const [final] = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    expect(() => JSON.parse(fs.readFileSync(path.join(dir, final), 'utf-8'))).not.toThrow();
  });
});

describe('the receipt sweep', () => {
  it('removes an orphan temporary file left by a failed write along with the oldest receipts', async () => {
    const mod = await freshReceipt();
    configValue.current = 'meta';
    const dir = path.join(process.env.DOJO_HOME ?? '', '.dojo', 'receipts', 'sweepbot');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '1-t1-i1.json.tmp'), '{');
    for (let i = 2; i < 210; i++) fs.writeFileSync(path.join(dir, `${i}-t1-i1.json`), '{}');
    for (let i = 0; i < 20; i++) {
      mod.writeContextReceipt({
        agentId: 'sweepbot', modelId: 'm', turnNumber: 1, loopCount: i,
        systemPrompt: 's', messages: [{ role: 'user', content: 'hi' }], useTools: false,
      });
    }
    await vi.waitFor(() => expect(fs.existsSync(path.join(dir, '1-t1-i1.json.tmp'))).toBe(false));
  });
});
