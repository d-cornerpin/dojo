// A helper holding Google at the read level is refused a form delete before anything reaches Google.
// The main agent deletes it, even with a narrower grant stored: it holds every account.
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { MOST_RESTRICTIVE_GRANTS, cloneGrants } from '@dojo/shared';

const sent = vi.fn();
vi.mock('../../../google/client.js', () => {
  const answer = async (...a: unknown[]) => { sent(...a); return { ok: true, data: {}, apiEndpoint: 'x' }; };
  return { googleRead: answer, googleWrite: answer, googleSilentFetch: answer };
});

import { scratchDojo, MAIN, HELPER, OPEN_SCOPE } from '../../tools/__tests__/scratch-dojo.js';
import { getDb } from '../../../db/connection.js';
import { getFilteredTools } from '../../tools/surface.js';

const readOnly = cloneGrants(MOST_RESTRICTIVE_GRANTS);
readOnly.tools.categories = '*';
readOnly.integrations.google = { agent: 'read', user: 'read' };
const dojo = await scratchDojo('read-level-form', {}, { ...OPEN_SCOPE, grants: readOnly });

beforeAll(() => {
  getDb().prepare("INSERT INTO google_accounts (id, kind, position, email, enabled, connected) VALUES ('ga', 'agent', 1, 'agent@example.com', 1, 1)").run();
});
beforeEach(() => sent.mockClear());

describe('a read-level helper cannot delete a form', () => {
  it('the helper is refused and nothing is sent', async () => {
    const r = await dojo.run(HELPER, 'forms_delete_form', { form_id: 'f1' });
    expect(dojo.blocked(r)).toBe(true);
    expect(sent).not.toHaveBeenCalled();
  });

  it('the helper still reads the form', async () => {
    const r = await dojo.run(HELPER, 'forms_get', { form_id: 'f1' });
    expect(dojo.blocked(r)).toBe(false);
    expect(sent).toHaveBeenCalled();
  });

  it('the main agent is offered the Slides writes and a Google read with a read or none grant stored', () => {
    for (const level of ['read', 'none'] as const) {
      const g = cloneGrants(readOnly);
      g.integrations.google = { agent: level, user: level };
      getDb().prepare('UPDATE agents SET permissions = ? WHERE id = ?').run(JSON.stringify({ grants: g }), MAIN);
      const names = getFilteredTools(MAIN).map((t) => t.name);
      if (process.env.R08_PROBE) console.log('PROBE', level, names.length);
      expect(names, level).toContain('slides_add_slide');
      expect(names, level).toContain('gmail_search');
    }
  });

  it('the main agent deletes it even with a read-level grant stored', async () => {
    getDb().prepare('UPDATE agents SET permissions = ? WHERE id = ?').run(JSON.stringify({ grants: readOnly }), MAIN);
    const r = await dojo.run(MAIN, 'forms_delete_form', { form_id: 'f1' });
    expect(dojo.blocked(r)).toBe(false);
    expect(sent).toHaveBeenCalled();
  });
});
