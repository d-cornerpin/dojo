// No summary is written for the project manager, through any door: the routine gate, the turn-budget check, a
// forced pass, the validator's until-it-fits pass and the background placeholder folder make no writer call. After
// a forced pass its next view fits half its budget. A fresh helper's forced pass still folds.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('./helpers/one-writer-box.js')).connectionMock());
vi.mock('../../agent/model.js', async () => (await import('./helpers/one-writer-box.js')).modelMock());
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

import { box, seedBox, AGENT, OWN } from './helpers/one-writer-box.js';
import { checkAndCompact } from '../compaction.js';
import { writeUncondensedPlaceholders, replacePlaceholdersInBackground } from '../out-of-view.js';
import { condenseForTheDialedModel } from '../../agent/v2/steps/pre-call-gates/context-gates.js';
import { measureView } from '../assembler.js';
import { insertMessage } from '../message-store.js';

const PM = 'pm';                 // config/platform.ts: `pm_agent_id` defaults to 'pm'
const summaries = (agentId: string): number => (box.db!.prepare('SELECT COUNT(*) AS n FROM summaries WHERE agent_id = ?').get(agentId) as { n: number }).n;

beforeEach(async () => {
  await seedBox();
  box.db!.prepare("INSERT INTO agents (id, name, status, model_id, config) VALUES (?, 'PM', 'idle', ?, '{}')").run(PM, OWN);
  for (let t = 1; t <= 6; t++) {
    insertMessage({ agentId: PM, role: 'user', lane: 'a2a', sourceAgentId: AGENT, a2aThreadId: `thread-${t}`, content: `[q${t}] ${'Which bay is the next crate for? '.repeat(40)}` });
    insertMessage({ agentId: PM, role: 'assistant', lane: 'a2a', subjectKind: 'a2a_thread', a2aThreadId: `thread-${t}`, content: `[r${t}] ${'Bay four, after the seal check. '.repeat(40)}` });
  }
});
afterEach(() => { vi.restoreAllMocks(); box.db?.close(); box.db = null; });

describe('the PM writes no summary', () => {
  it('no door asks a writer, and no summary row is written', async () => {
    const last = (box.db!.prepare('SELECT MAX(seq) AS s FROM messages WHERE agent_id = ?').get(PM) as { s: number }).s;
    expect(writeUncondensedPlaceholders(PM, last - 6), 'the PM placeholders a box already holds').toBeGreaterThan(0);
    const held = summaries(PM);
    await condenseForTheDialedModel({ agentId: PM, dialedModelId: OWN, contextWindow: 32_000, writerModelId: OWN });
    await checkAndCompact(PM, OWN, 32_000);
    await checkAndCompact(PM, OWN, 32_000, { force: true });
    await checkAndCompact(PM, OWN, 32_000, { force: true, untilItFits: true, inTurn: true });
    expect(replacePlaceholdersInBackground(PM)).toBe(false);
    await new Promise((r) => setTimeout(r, 50));
    expect(box.calls, 'a writer was asked for the PM').toEqual([]);
    expect(summaries(PM)).toBe(held);
  });

  it('after a forced pass the next view fits half its budget', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3_600_000);   // past any earlier forced pass's bound
    const before = await measureView(PM, OWN);
    expect(before.tailKeptTokens, 'the view already fits half').toBeGreaterThan(before.budgetTokens / 2);
    await checkAndCompact(PM, OWN, 32_000, { force: true });
    expect((await measureView(PM, OWN)).tailKeptTokens).toBeLessThanOrEqual(before.budgetTokens / 2);
  });

  it("a fresh helper's forced pass still folds", async () => {
    const r = await checkAndCompact(AGENT, OWN, 32_000, { force: true });
    expect(r.leafCreated).toBeGreaterThan(0);
    expect(summaries(AGENT)).toBeGreaterThan(0);
  });
});
