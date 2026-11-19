// A request that stood down is served again when its person writes again: the next turn's pickup re-opens it beside
// the new message. Its count is already at the bound, so if that turn fails too it stands down again at once.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('../../agent/v2/__tests__/helpers/reply-sender.js')).connectionMock());
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {} }));
vi.mock('../../router/router-window.js', () => ({ agentTurnWindow: () => 128_000 }));

import { runMigrations } from '../../db/migrations.js';
import { runTurnTrigger } from '../../agent/v2/steps/preflight/turn-trigger.js';
import { openTurnContext, endTurnContext } from '../../agent/turn-context.js';
import { freshReplyDb, testDb, AGENT, T0 } from '../../agent/v2/__tests__/helpers/reply-sender.js';
import { samAsks, servedBy, turnEnds, askOf } from './helpers/a-request-handed-back.js';

/** The next turn's pickup, as the preflight runs it. */
function nextPickup(): void {
  const turnCtx = openTurnContext(AGENT);
  try {
    runTurnTrigger(turnCtx, { agentId: AGENT, setAgentStatus: () => {}, startStatusHeartbeat: () => {}, stopStatusHeartbeat: () => {}, engineStartAckAfterMs: 30_000 });
  } finally { endTurnContext(AGENT); }
}

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  freshReplyDb(runMigrations);
  testDb().prepare("INSERT INTO providers (id, name, type, auth_type) VALUES ('p-1', 'P', 'anthropic', 'api_key')").run();
  testDb().prepare("INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, is_enabled) VALUES ('m-1', 'p-1', 'M', 'm', '[]', 128000, 1)").run();
  testDb().prepare("UPDATE agents SET model_id = 'm-1' WHERE id = ?").run(AGENT);
  samAsks('m-1');
  for (let turn = 1; turn <= 6; turn++) { servedBy('m-1', turn); turnEnds(turn, 'brake'); }
});

describe('a stood-down request comes back when the person writes again', () => {
  it('nothing else lifts it; Sam writing again re-opens it with the new message', () => {
    expect(askOf('m-1').state).toBe('blocked');
    nextPickup();
    expect(askOf('m-1').state, 'no new message: it stays held').toBe('blocked');
    samAsks('m-2');
    nextPickup();
    expect(askOf('m-2').state, 'the new message is the trigger').toBe('claimed');
    expect(askOf('m-1').state, 'the stood-down request is served with it').toBe('open');
  });

  it('if that turn fails as well, it stands down again at once', () => {
    samAsks('m-2');
    nextPickup();
    servedBy('m-1', 7);
    turnEnds(7, 'brake');
    expect(askOf('m-1').state).toBe('blocked');
  });
});
