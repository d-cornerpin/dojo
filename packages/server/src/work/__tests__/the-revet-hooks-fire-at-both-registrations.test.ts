// ════════════════════════════════════════════════════════════════════════════════════════
// t119 — THE TWO RE-VET HOOKS ARE DRIVEN, NOT READ.
//
// WHAT THIS FILE ADDS, AND WHY IT IS NOT A DUPLICATE. t118 round 2 closed the ask-title
// first-introduction race with a re-vet and TWO registration hooks, and proved the re-vet
// itself thoroughly: `an-ask-title-is-re-vetted-when-the-credential-lands.test.ts` §2 drives
// `revetOpenAskTitles` directly over all three orderings. What it could NOT prove is that
// anything CALLS it. Its §4 pins both hooks by CORPUS TEXT — `toContain('revetOpenAskTitles
// (agentId)')` plus a co-location and an ordering assertion — and a text pin has one blind
// spot that matters here: a rename, or any refactor that moves the call and the pin together,
// stays green while the hook is gone. The judge's non-blocking follow-up asked for the
// behavioural half, and this is it.
//
// THE OBSERVABLE IS A ROW, NOT A SPY. Each arm opens a REAL ask whose title carries a
// credential value the process does not know yet — the state the race produces — then drives
// the REAL registration door and asserts `work.title` came back to the ask's own identifier.
// No arm calls `revetOpenAskTitles`, so with its hook removed the row simply keeps the leaked
// title and the clause reds. That is the whole point: the pin fails on behaviour, not on text.
//
// THE TWO DOORS ARE DIFFERENT DOORS, which is why neither arm covers the other:
//
//   ARM A — the WRITE side (`agent/v2/steps/call-llm/model-call.ts`). A model result whose
//           tool calls DECLARE a secret field. Driven through `callWithRetryAndFallback`,
//           the real function, with the real `noteDeclaredSecretsFromToolCalls` behind it.
//   ARM B — the READ side (`credentials/tools.ts`, `credential_get`). A value stored in an
//           earlier session entering this process for the first time — a fresh boot. Driven
//           through the real `executeCredentialTool`.
//
// ONE PREMISE CORRECTION for the record: the two hooks are one in EACH file, not two in
// `credentials/tools.ts`. `grep -rn revetOpenAskTitles src` at this head returns the writer
// (`model-call.ts:474`), the reader (`credentials/tools.ts:143`) and the definition.
//
// WHAT IS MOCKED AND WHY. Only the things that are neither the hook nor the re-vet: the DB
// connection, the provider dial, the broadcast, the assembler and the tool-doc measurer in
// ARM A, and the encrypted credential STORE in ARM B (so the arm needs no keychain). Both
// `credentials/secret-fields.ts` and `credentials/secret-values.ts` are REAL in this file —
// they are the registration, and mocking them would be mocking the subject.
//
// FIXTURE DISCIPLINE (G1): fictional credential-shaped strings, invented here.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
  closeDb: vi.fn(),
}));

vi.mock('../../gateway/ws.js', () => ({ broadcast: () => undefined }));

// ── ARM A's seams: the provider dial and the two assembly helpers ──
const callModelSpy = vi.fn();
vi.mock('../../agent/model.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../agent/model.js')>()),
  callModel: (...a: unknown[]) => callModelSpy(...(a as [])),
}));
vi.mock('../../tools/tool-docs.js', () => ({ measureAgentToolPayloadTokens: async () => 0 }));
vi.mock('../../memory/assembler.js', () => ({
  assembleContext: async () => ({
    systemPrompt: 'system', messages: [{ role: 'user', content: 'hi' }],
    systemVolatile: '', reserveTokens: 0,
  }),
}));

// ── ARM B's seam: the encrypted store. The HOOK is what this file pins, not the cipher. ──
const storedCredential: { current: Record<string, unknown> | null } = { current: null };
vi.mock('../../credentials/store.js', () => ({
  getCredentialByService: (serviceName: string) => (
    storedCredential.current
      ? {
        id: 'cred-1', serviceName, description: null, createdByAgentId: null,
        createdAt: '2026-10-06', updatedAt: '2026-10-06', lastAccessedAt: null,
        lastAccessedByAgentId: null, accessCount: 0,
        credentials: storedCredential.current,
      }
      : null
  ),
  listCredentials: () => [],
  addCredential: vi.fn(),
  updateCredential: vi.fn(),
  deleteCredentialByService: vi.fn(),
}));

import { runMigrations } from '../../db/migrations.js';
import { openAsk, askIdForMessage } from '../store.js';
import { forgetHandedCredentialValues } from '../../credentials/secret-values.js';
import { callWithRetryAndFallback, type ModelCallInputs } from '../../agent/v2/steps/call-llm/model-call.js';
import { advance, initState, type AgentTurnState } from '../../agent/v2/state.js';
import { executeCredentialTool } from '../../credentials/tools.js';
// STATIC on purpose (t119): the READ-side hook reaches this module through a DYNAMIC import,
// so keeping it in the registry makes that hook's import resolve from cache instead of a cold
// transform — which is both what makes the flush below deterministic and the exposure that
// wedged `recovery-single-owner.test.ts` for six merge gates. Nothing here CALLS the re-vet;
// the symbol is referenced once, in the non-vacuity clause, to pin the name the hooks use.
import * as askTitle from '../ask-title.js';

const AGENT = 'agent-revet-t119';
const CLOUD_MODEL = 'cloud-a';
const CONTEXT_WINDOW = 200_000;

// ── THE FICTIONAL CREDENTIAL (G1) ──
const FAKE_KEY = 'sk-live-t119hook-Qr7Ld2Wm9Xb4Fp1Ez';
/** The title the system model answered with before anything was registered: it copied the
 *  value, which is exactly what the race produces and what no mint-time scrub can see yet. */
const LEAKY_TITLE = `Store ${FAKE_KEY} for the billing provider`;

const db = (): Database.Database => mockDb.current!;

const titleOf = (workId: string): string | null =>
  (db().prepare('SELECT title FROM work WHERE id = ?').get(workId) as { title: string | null } | undefined)
    ?.title ?? null;

/** Open a real ask carrying the leaked title. The row is durable and nothing is registered. */
function openLeakyAsk(messageId: string): string {
  return openAsk({
    agentId: AGENT, messageId, requesterId: 'owner', conversationId: null,
    title: LEAKY_TITLE, openedAt: Date.now(),
  });
}

function seedAgentAndModel(d: Database.Database): void {
  d.prepare(
    `INSERT INTO agents (id, name, status, created_at) VALUES (?, 'Asker', 'idle', datetime('now'))`,
  ).run(AGENT);
  d.prepare(
    `INSERT INTO providers (id, name, type, auth_type) VALUES ('cloud', 'Cloud', 'openai', 'api_key')`,
  ).run();
  d.prepare(`
    INSERT INTO models (id, provider_id, name, api_model_id, is_enabled, capabilities,
                        context_window, input_cost_per_m, output_cost_per_m)
    VALUES (?, 'cloud', 'Cloud A', ?, 1, '["tools","text"]', ?, 0, 0)
  `).run(CLOUD_MODEL, CLOUD_MODEL, CONTEXT_WINDOW);
  d.prepare('INSERT INTO router_tier_models (tier_id, model_id, priority) VALUES (?, ?, ?)')
    .run('standard', CLOUD_MODEL, 0);
}

/** The READ-side hook is fire-and-forget (`void import(...).then(...)`), so its write lands a
 *  few turns after the tool returns. Draining macrotasks settles the already-cached import
 *  without asserting any duration — there is no sleep and no wall-clock in this file. */
async function flushFireAndForget(): Promise<void> {
  for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
}

function ctxFor(): ModelCallInputs {
  return {
    agentId: AGENT,
    turnCtx: {} as ModelCallInputs['turnCtx'],
    turnNumber: 1,
    messageId: 'msg-hook-a',
    messages: [{ role: 'user', content: 'set up billing' }] as unknown as ModelCallInputs['messages'],
    systemPrompt: 'system',
    useTools: true,
    isAutoRouted: true,
    isA2ATurn: false,
    excludedModels: [],
    revertTriggerStampOnAbort: () => undefined,
    assembled: { systemVolatile: '', reserveTokens: 0 } as unknown as ModelCallInputs['assembled'],
    routerTier: 'standard',
    counterparty: { kind: 'user', id: 'owner', displayName: 'Owner' } as unknown as ModelCallInputs['counterparty'],
    volatileFrom: 1,
    assemblyTurnContext: { latestUserSource: null },
  };
}

const freshState = (): AgentTurnState => advance(initState(AGENT, CLOUD_MODEL), { loopCount: 1 });

/** A model result that DECLARES a secret field, which is what makes it a registration. */
const RESULT_DECLARING_A_SECRET = {
  content: 'saved it',
  toolCalls: [{
    name: 'credential_add',
    arguments: { service_name: 'billing', credentials: { api_key: FAKE_KEY } },
  }],
  inputTokens: 10, outputTokens: 3, stopReason: 'end_turn',
};

beforeEach(() => {
  vi.clearAllMocks();
  storedCredential.current = null;
  mockDb.current = new Database(':memory:');
  runMigrations();
  seedAgentAndModel(db());
  forgetHandedCredentialValues();
});

afterEach(() => {
  forgetHandedCredentialValues();
  mockDb.current?.close();
  mockDb.current = null;
});

// ════════════════════════════════════════════════════════════════════════════════════════
// ARM A — THE WRITE SIDE. The engine's per-result registration drives the re-vet.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('t119 ARM A — the write-side hook fires from the real model call', () => {
  it('a declared secret on a model result re-vets the title minted before it (HOOK DRIVEN)', async () => {
    const workId = openLeakyAsk('msg-hook-a');
    // Non-vacuity: the race's state really is on the row before the turn registers anything.
    expect(titleOf(workId), 'the leaked title must be live before the drive').toBe(LEAKY_TITLE);

    callModelSpy.mockResolvedValue(RESULT_DECLARING_A_SECRET);
    const out = await callWithRetryAndFallback(freshState(), CLOUD_MODEL, ctxFor());
    expect(out.abandoned, 'the turn must actually complete, or nothing was driven').toBeUndefined();

    // REFUSAL PARITY: the ticket's own identifier back, not a scrubbed title.
    expect(
      titleOf(workId),
      'the write-side hook did not re-vet: a model result that declared a secret left the '
      + 'credential-bearing title live on the work spine',
    ).toBe(workId);
    expect(titleOf(workId)).toBe(askIdForMessage('msg-hook-a'));
  });

  it('CONTROL: a result declaring NO secret leaves the title alone (the hook is not a rewriter)', async () => {
    const workId = openLeakyAsk('msg-hook-a-ctl');
    callModelSpy.mockResolvedValue({
      content: 'nothing to save',
      toolCalls: [{ name: 'write_file', arguments: { path: '/tmp/x', content: FAKE_KEY } }],
      inputTokens: 10, outputTokens: 3, stopReason: 'end_turn',
    });

    await callWithRetryAndFallback(freshState(), CLOUD_MODEL, ctxFor());

    // `write_file.content` is not a DECLARED secret field, so nothing is registered and the
    // re-vet has nothing to match. Without this control, ARM A could pass on a hook that
    // rewrote every recent title unconditionally.
    expect(titleOf(workId)).toBe(LEAKY_TITLE);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// ARM B — THE READ SIDE. `credential_get` on a fresh boot is a first learning too.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('t119 ARM B — the read-side hook fires from the real credential_get', () => {
  it('fetching a credential stored in an earlier session re-vets the title (HOOK DRIVEN)', async () => {
    const workId = openLeakyAsk('msg-hook-b');
    expect(titleOf(workId)).toBe(LEAKY_TITLE);

    // The fresh-boot shape: the value is in the store and has NEVER been in this process.
    storedCredential.current = { api_key: FAKE_KEY };
    const out = await executeCredentialTool('credential_get', { service_name: 'billing' }, AGENT);
    expect(out, 'the tool must actually have handed the value over').toContain(FAKE_KEY);
    await flushFireAndForget();

    expect(
      titleOf(workId),
      'the read-side hook did not re-vet: a credential_get on a fresh boot registered the '
      + 'value it handed the model but left the credential-bearing title live',
    ).toBe(workId);
  });

  it('CONTROL: fetching a credential no title carries leaves every title alone', async () => {
    const workId = openAsk({
      agentId: AGENT, messageId: 'msg-hook-b-ctl', requesterId: 'owner', conversationId: null,
      title: 'Set up the billing provider', openedAt: Date.now(),
    });
    storedCredential.current = { api_key: FAKE_KEY };

    await executeCredentialTool('credential_get', { service_name: 'billing' }, AGENT);
    await flushFireAndForget();

    expect(titleOf(workId)).toBe('Set up the billing provider');
  });

  it('a credential_get that finds NOTHING registers nothing and re-vets nothing', async () => {
    const workId = openLeakyAsk('msg-hook-b-miss');
    storedCredential.current = null;

    const out = await executeCredentialTool('credential_get', { service_name: 'billing' }, AGENT);
    expect(out).toContain('No credential found');
    await flushFireAndForget();

    // The miss path must not reach the re-vet at all: there is no value to have learned.
    expect(titleOf(workId)).toBe(LEAKY_TITLE);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// THE NAME THE HOOKS CALL
// ════════════════════════════════════════════════════════════════════════════════════════

describe('t119 — the re-vet keeps the name both hooks reach for', () => {
  it('`revetOpenAskTitles` is still the exported entry point', () => {
    // Deliberately the ONLY text-shaped assertion in this file, and it is about the module's
    // own surface rather than about a call site: the two arms above fail on behaviour, so a
    // rename that carried its call sites with it reds nothing here — it reds nothing anywhere,
    // which is correct, because a consistent rename is not a defect. What would be a defect is
    // the entry point disappearing while a caller still expects it, and that is this line.
    expect(typeof askTitle.revetOpenAskTitles).toBe('function');
  });
});
