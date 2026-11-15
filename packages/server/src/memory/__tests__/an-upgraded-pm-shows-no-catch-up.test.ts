// An upgraded project manager shows no "Summarising older memory" indicator: its open catch-up record and old
// placeholders come from before it kept no summaries, and nothing will ever fold them, so the record is closed
// at boot and no turn start shows the frame.
import { it, expect, beforeEach, afterEach, vi } from 'vitest';

const frames = vi.hoisted(() => [] as string[]);
vi.mock('../../db/connection.js', async () => (await import('./helpers/one-writer-box.js')).connectionMock());
vi.mock('../../agent/model.js', async () => (await import('./helpers/one-writer-box.js')).modelMock());
vi.mock('../../gateway/ws.js', () => ({
  broadcast: (e: { type: string; data?: { label?: string; phase?: string } }) => { if (e.type === 'engine:activity') frames.push(`${e.data?.phase}:${e.data?.label}`); },
  stampPersistedRow: (e: unknown) => e,
}));

import { box, seedBox, OWN } from './helpers/one-writer-box.js';
import { writeUncondensedPlaceholders, assembleWithNothingOutOfViewUnsummarised } from '../out-of-view.js';
import { resumeCatchUpsAtBoot } from '../legacy-rebuild-boot.js';
import { assembleContext } from '../assembler.js';
import { insertMessage } from '../message-store.js';

const PM = 'pm';                 // config/platform.ts: `pm_agent_id` defaults to 'pm'

beforeEach(async () => {
  frames.length = 0;
  await seedBox();
  box.db!.prepare("INSERT INTO agents (id, name, status, model_id, config) VALUES (?, 'PM', 'idle', ?, '{}')").run(PM, OWN);
  for (let t = 1; t <= 12; t++) {
    insertMessage({ agentId: PM, role: 'user', lane: 'events', originIntent: 'pm_review', content: `Tracker review ${t}: ${'the report waits. '.repeat(40)}` });
  }
  const last = (box.db!.prepare('SELECT MAX(seq) AS s FROM messages WHERE agent_id = ?').get(PM) as { s: number }).s;
  writeUncondensedPlaceholders(PM, last - 2);
  box.db!.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, '{\"at\":1,\"askedThrough\":0}')").run(`memory_catch_up.${PM}`);
});
afterEach(() => { box.db?.close(); box.db = null; });

it('the boot closes the record and no turn start shows the frame', async () => {
  resumeCatchUpsAtBoot();
  for (const n of [1, 2]) {
    insertMessage({ agentId: PM, role: 'user', lane: 'events', originIntent: 'pm_review', content: `Tracker review after the upgrade ${n}.` });
    await assembleWithNothingOutOfViewUnsummarised(PM, 32_000, () => assembleContext(PM, OWN));
  }
  expect(frames.filter((f) => f.startsWith('start:'))).toEqual([]);
  expect(box.db!.prepare('SELECT 1 FROM config WHERE key = ?').get(`memory_catch_up.${PM}`)).toBeUndefined();
});
