import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as w from '../../services/__tests__/mail-world.js';

const alertCheck = vi.hoisted(() => vi.fn());
vi.mock('../../db/connection.js', async () => (await import('../../services/__tests__/mail-world.js')).dbModule());
vi.mock('../budget.js', () => ({ checkAlertsAfterCost: alertCheck }));

import { recordCost } from '../tracker.js';

beforeEach(async () => {
  await w.freshWorld();
  alertCheck.mockReset();
  const d = w.world.db!;
  d.prepare(`INSERT INTO providers (id, name, type, auth_type) VALUES ('lp', 'Local', 'openai', 'none')`).run();
  d.prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, is_enabled, input_cost_per_m, output_cost_per_m)
             VALUES ('free', 'lp', 'Free', 'free-1', '["tools"]', 8000, 1, 0, 0)`).run();
  d.prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, is_enabled, input_cost_per_m, output_cost_per_m)
             VALUES ('paid', 'lp', 'Paid', 'paid-1', '["tools"]', 8000, 1, 3, 15)`).run();
});

describe('a free call runs no budget alert check', () => {
  it('a $0 call is recorded and no alert check runs', () => {
    recordCost({ agentId: 'primary', modelId: 'free', providerId: 'lp', inputTokens: 1000, outputTokens: 200 });
    expect(alertCheck).toHaveBeenCalledTimes(0);
    expect(w.world.db!.prepare("SELECT cost_usd FROM cost_records WHERE model_id = 'free'").all()).toEqual([{ cost_usd: 0 }]);
  });

  it('a paid call still runs the alert check once', () => {
    recordCost({ agentId: 'primary', modelId: 'paid', providerId: 'lp', inputTokens: 1000, outputTokens: 200 });
    expect(alertCheck).toHaveBeenCalledTimes(1);
    expect(alertCheck).toHaveBeenCalledWith('primary');
  });
});
