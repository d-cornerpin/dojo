// A request the spin brake cuts every time stands down at the sixth hand-back: no further model call is made for it,
// and the owner is told once, on the request's own record, in the Dojo's voice.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('../../agent/v2/__tests__/helpers/reply-sender.js')).connectionMock());
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {} }));

import { runMigrations } from '../../db/migrations.js';
import { freshReplyDb, testDb, AGENT, T0 } from '../../agent/v2/__tests__/helpers/reply-sender.js';
import { samAsks, servedBy, turnEnds, askOf, countsOf } from './helpers/a-request-handed-back.js';

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  freshReplyDb(runMigrations);
  samAsks('m-1');
});

const toldRecords = (): number => (testDb().prepare(`SELECT COUNT(*) AS n FROM work_events WHERE work_id = 'ask:m-1'
  AND kind = 'floor_ghosted' AND json_extract(payload, '$.floor') = 'request-stood-down'`).get() as { n: number }).n;
const ownerLines = (): string[] => (testDb().prepare("SELECT content FROM messages WHERE role = 'system' AND content LIKE '%stopped trying%'")
  .all() as Array<{ content: string }>).map((r) => r.content);

describe('a request the brake keeps cutting stands down at the sixth and the owner is told once', () => {
  it('five cuts re-open it, the sixth holds it owed and tells the owner once', () => {
    for (let turn = 1; turn <= 5; turn++) {
      servedBy('m-1', turn);
      turnEnds(turn, 'brake');
      expect(askOf('m-1').state, `cut ${turn}`).toBe('open');
    }
    expect(toldRecords()).toBe(0);
    servedBy('m-1', 6);
    turnEnds(6, 'brake');
    expect(askOf('m-1').state).toBe('blocked');
    expect(toldRecords()).toBe(1);
    expect(ownerLines()).toHaveLength(1);
    expect(ownerLines()[0]).toContain(`${AGENT} could not answer Sam's message ("Compare the three quotes`);
    expect(ownerLines()[0]).toContain('after 6 tries, so it has stopped trying. It answers when Sam writes again.');
    turnEnds(7, 'brake');
    expect(toldRecords(), 'a later finalize tells nothing more').toBe(1);
    expect(countsOf('m-1')).toEqual({ silence: 0, engine: 5 });
  });
});
