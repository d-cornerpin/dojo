// A role agent save is three PUTs. A refused model was already reported; a failed LATER write must be
// reported too, so the owner never sees "saved" over a half-written agent. The door is a scripted `request`.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const server = vi.hoisted(() => ({ puts: [] as string[], failPath: '' as string }));
vi.mock('../lib/door', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../lib/door');
  return {
    ...actual,
    request: vi.fn(async (path: string, init?: { method?: string }) => {
      if (init?.method === 'PUT') {
        server.puts.push(path);
        if (path === server.failPath) return { ok: false, error: 'Could not write ' + path };
      }
      return { ok: true, data: {} };
    }),
  };
});

import { saveRoleAgent } from '../lib/role-models';

beforeEach(() => {
  server.puts.length = 0;
  server.failPath = '';
});

describe('saveRoleAgent', () => {
  it('a failed name write is reported', async () => {
    server.failPath = '/config/settings/trainer_agent_name';
    await expect(saveRoleAgent('trainer', 'Coach', 'm1')).resolves.toBe('Could not write /config/settings/trainer_agent_name');
  });

  it('a full success returns null and writes model, name, id in that order', async () => {
    await expect(saveRoleAgent('pm', 'Aide', 'm1')).resolves.toBeNull();
    expect(server.puts).toEqual([
      '/config/settings/pm_agent_model',
      '/config/settings/pm_agent_name',
      '/config/settings/pm_agent_id',
    ]);
  });

  it('with no name nothing is written', async () => {   // a blank name skips the model write too
    await expect(saveRoleAgent('pm', '  ', 'm1')).resolves.toBeNull();
    expect(server.puts).toEqual([]);
  });
});
