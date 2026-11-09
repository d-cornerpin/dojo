// An upgraded box wakes nothing: right after 901 the ladder's sweep and the PM's review send no hint, mark,
// card, text or turn. A row idle under 14 days is clocked from the upgrade, so it is hinted one bound later;
// a row held at the upgrade, idle 14 days or more, or whose worker is gone, is never touched, however long the box runs.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/done-db.js')).connectionMock());
vi.mock('../../../gateway/ws.js', async () => (await import('./helpers/ladder-world.js')).wsMock());
vi.mock('../../../agent/runtime.js', async () => (await import('./helpers/ladder-world.js')).runtimeMock());
vi.mock('../../../services/imessage-bridge.js', async (orig) => ({ ...(await orig<object>()), sendAlert: (await import('./helpers/ladder-world.js')).texts }));
vi.mock('../../../tracker/pm-agent.js', async (orig) => ({ ...(await orig<object>()), armDebouncedReview: vi.fn() }));
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

import { runLadder, LADDER_ENTRY } from '../ladder.js';
import { runPMReview } from '../../../tracker/pm-agent.js';
import { FXID } from '../../../../../../deploy/checks/fixture-vocabulary.mjs';
import { boxBefore901, seedRow, fileClose, enter, upgrade, PM, GONE, DELETED, DAY } from '../../../db/__tests__/helpers/a-box-before-901.js';
import { hintsTo, cards, texts, entries, pmCanRun, resetLadderWorld, turn } from './helpers/ladder-world.js';
import { doneDb } from './helpers/done-db.js';

const FRESH = FXID.n7;
const OLD = FXID.n8;
const messages = (): number => (doneDb().prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n;
let turns = 0;
let rows: string[];

beforeEach(() => {
  boxBefore901();
  for (const a of [FRESH, OLD]) doneDb().prepare("INSERT INTO agents (id, name, status) VALUES (?, ?, 'idle')").run(a, a);
  pmCanRun(PM);
  resetLadderWorld();
  turns = 0;
  turn.during = () => { turns += 1; };
  const now = Date.now();
  rows = [
    seedRow({ id: 'young-claimed', state: 'claimed', worker: FRESH, idleDays: 2 }, now),
    seedRow({ id: 'young-blocked', state: 'blocked', worker: FRESH, idleDays: 3 }, now),
    seedRow({ id: 'old-claimed', state: 'claimed', worker: OLD, idleDays: 30 }, now),
    seedRow({ id: 'old-blocked', state: 'blocked', worker: OLD, idleDays: 20 }, now),
    seedRow({ id: 'old-close-on-blocked', state: 'blocked', worker: OLD, idleDays: 40 }, now),
    seedRow({ id: 'gone-claimed', state: 'claimed', worker: GONE, idleDays: 2 }, now),
    seedRow({ id: 'deleted-claimed', state: 'claimed', worker: DELETED, idleDays: 2 }, now),
  ];
  enter('young-blocked', 'claimed', 'blocked', 'waiting on a reply', now - 3 * DAY);
  enter('old-blocked', 'claimed', 'blocked', 'waiting on a reply', now - 20 * DAY);
  fileClose('old-close-on-blocked', now - 40 * DAY);
});

const quiet = (workers: string[]): void => {
  for (const w of workers) expect(hintsTo(w), w).toEqual([]);
  for (const id of rows.filter((r) => !r.startsWith('young'))) {
    for (const e of Object.values(LADDER_ENTRY)) expect(entries(id, e), `${id} ${e}`).toBe(0);
  }
};

describe('an upgraded box wakes nothing', () => {
  it('the migration and the first sweep and review after it send no hint, mark, card, text or turn', async () => {
    const sent = messages();
    upgrade();
    await runLadder(Date.now());
    await runPMReview();
    quiet([FRESH, OLD, GONE, DELETED, PM]);
    for (const id of rows) for (const e of Object.values(LADDER_ENTRY)) expect(entries(id, e), `${id} ${e}`).toBe(0);
    expect(cards).toEqual([]);
    expect(texts).not.toHaveBeenCalled();
    expect(turns).toBe(0);
    expect(messages()).toBe(sent);
  });

  it('a row idle under 14 days is hinted one bound after the upgrade; one held then, idle 14 days or more, or whose worker is gone, never', async () => {
    upgrade();
    await runLadder(Date.now() + 2 * 60_000);
    expect(hintsTo(FRESH)).toEqual([]);
    await runLadder(Date.now() + DAY);
    expect(hintsTo(FRESH)).toHaveLength(1);
    expect(hintsTo(FRESH)[0]).toContain('[young-claimed]');
    expect(hintsTo(FRESH)[0]).not.toContain('[young-blocked]');
    for (const later of [2 * DAY, 30 * DAY]) await runLadder(Date.now() + later);
    quiet([OLD, GONE, DELETED]);
  });
});
