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
import { fileURLToPath } from 'node:url';

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

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = (rel: string): string => fs.readFileSync(path.resolve(HERE, rel), 'utf8');

/** A fresh module per test: the announce latch and the counters are module state by design. */
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
  it('RED→GREEN: a failed write WARNS, names the file, and is remembered as the last error', async () => {
    const mod = await freshReceipt();
    configValue.current = 'meta';
    vi.spyOn(fs.promises, 'mkdir').mockRejectedValue(new Error('EACCES: permission denied'));

    mod.writeContextReceipt({
      agentId: 'behaviorbot', modelId: 'm', turnNumber: 1, loopCount: 1,
      systemPrompt: 'you are a bot', messages: [{ role: 'user', content: 'hi' }], useTools: false,
    });
    await new Promise((r) => setTimeout(r, 10));

    expect(lossLines()).toHaveLength(1);
    expect(lossLines()[0].level, 'debug is a level nobody reads — that is the whole defect').toBe('warn');
    expect(lossLines()[0].data).toMatchObject({ agentId: 'behaviorbot', mode: 'meta' });
    expect(String(lossLines()[0].data.error)).toMatch(/EACCES/);
    expect(mod.receiptStatus().lastError).toMatch(/EACCES/);
  });

  it('CONTROL: the turn is never affected — a failing writer throws nothing into its caller', async () => {
    const mod = await freshReceipt();
    configValue.current = 'full';
    vi.spyOn(fs.promises, 'mkdir').mockRejectedValue(new Error('disk gone'));
    expect(() => mod.writeContextReceipt({
      agentId: 'behaviorbot', modelId: 'm', turnNumber: 1, loopCount: 1,
      systemPrompt: 's', messages: [{ role: 'user', content: 'hi' }], useTools: false,
    })).not.toThrow();
  });

  it('CONTROL: with the instrument OFF nothing is attempted and nothing is said — off is not a fault', async () => {
    const mod = await freshReceipt();
    configValue.current = 'off';
    const mkdir = vi.spyOn(fs.promises, 'mkdir');
    mod.writeContextReceipt({
      agentId: 'behaviorbot', modelId: 'm', turnNumber: 1, loopCount: 1,
      systemPrompt: 's', messages: [{ role: 'user', content: 'hi' }], useTools: false,
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(mkdir).not.toHaveBeenCalled();
    expect(lossLines()).toHaveLength(0);
    expect(mod.receiptStatus().lastError).toBeNull();
  });
});

// ── CLAUSE 3: THE QUESTION IS ASKABLE ───────────────────────────────────────────────────

describe('T67 — "are receipts on?" is answerable without a sqlite3 session', () => {
  it('RED→GREEN: the status states mode, source, count, last write and last error', async () => {
    const mod = await freshReceipt();
    configValue.current = 'meta';
    expect(mod.receiptStatus()).toMatchObject({
      mode: 'meta', source: 'config', writtenThisProcess: 0, lastWriteAt: null, lastError: null,
    });
    expect(mod.receiptStatus().root).toMatch(/\.dojo[/\\]receipts$/);
  });

  it('RED→GREEN: `/health` carries it, so the surface the kit already curls answers the question', () => {
    const system = SRC('../../../gateway/routes/system.ts');
    expect(system, 'the route must READ the writer\'s own status, never recompute it').toContain('receipts: receiptStatus()');
    expect(system).toContain("import { receiptStatus } from '../../agent/v2/receipt.js';");
    const shared = SRC('../../../../../shared/src/types.ts');
    expect(shared, 'and the wire type must declare what the route sends').toMatch(/receipts\?: \{/);
  });

  it('NO CARD CLAIMS IT: the owner\'s Health page draws no receipts row, deliberately', () => {
    // The instrument is off on every shipped box, so a card would draw a permanent "disabled"
    // row for a debug tool the owner never uses — and `the-health-page-tells-the-truth.test.ts`
    // refuses rows with nothing behind them. If someone later wants the row, this clause is
    // where the argument gets re-opened.
    const page = SRC('../../../../../dashboard/src/pages/Health.tsx');
    expect(page).not.toMatch(/receipt/i);
  });
});
