// On a box whose Google account was connected from the dashboard, the account's id is random. Forms
// tools ask Google with that account's own id, so creating a form works there.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const DASHBOARD_ID = '8a2d4c6e-1f3b-4a5c-9e7d-2b4f6a8c0e13';
const googleRead = vi.fn(async (..._a: unknown[]) => ({ ok: true, data: {} }));
const googleWrite = vi.fn(async (..._a: unknown[]) => ({ ok: true, data: { formId: 'form-1', responderUri: 'https://forms.example.com/form-1' } }));
const googleSilentFetch = vi.fn(async (..._a: unknown[]) => ({ ok: true, data: { items: [] } }));
vi.mock('../client.js', () => ({
  googleRead: (...a: unknown[]) => googleRead(...a),
  googleWrite: (...a: unknown[]) => googleWrite(...a),
  googleSilentFetch: (...a: unknown[]) => googleSilentFetch(...a),
}));
vi.mock('../accounts.js', () => ({
  resolveGoogleAccountForTool: () => ({ account: { id: DASHBOARD_ID, email: 'agent@example.com', connected: true, enabledServices: null } }),
}));

const { executeGoogleFormsTool, formsToolDefinitions } = await import('../tools-forms.js');

beforeEach(() => {
  googleRead.mockClear();
  googleWrite.mockClear();
  googleSilentFetch.mockClear();
});

describe('forms work on an account connected from the dashboard', () => {
  it('creating a form asks Google with the account id', async () => {
    const out = await executeGoogleFormsTool('forms_create_form', { title: 'Survey' }, 'agent-main', 'Main');
    expect(out).toContain('form-1');
    expect(googleWrite.mock.calls[0][8]).toBe(DASHBOARD_ID);
  });

  it('every Forms tool offers the account parameter', () => {
    for (const def of formsToolDefinitions) {
      expect((def.input_schema as { properties: Record<string, unknown> }).properties.account, def.name).toBeTruthy();
    }
  });
});
