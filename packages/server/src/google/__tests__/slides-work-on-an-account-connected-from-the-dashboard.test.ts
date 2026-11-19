// On a box whose Google account was connected from the dashboard, the account's id is random. Slides
// tools ask Google with that account's own id, so creating a deck works there.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';
import { homeDir } from '../../home.js';
import { mintCallCapability, attachCallCapability, type ResourceGrant } from '../../agent/effects/capability.js';
import { runWithToolCallId } from '../../agent/turn-state.js';

const DASHBOARD_ID = '5f1c2a7e-9b3d-4e8f-a1c6-0d2e4f6a8b90';
const googleRead = vi.fn(async (..._a: unknown[]) => ({ ok: true, data: { slides: [] } }));
const googleWrite = vi.fn(async (..._a: unknown[]) => ({ ok: true, data: { presentationId: 'deck-1', slides: [] } }));
vi.mock('../client.js', () => ({
  googleRead: (...a: unknown[]) => googleRead(...a),
  googleWrite: (...a: unknown[]) => googleWrite(...a),
}));
vi.mock('../accounts.js', () => ({
  resolveGoogleAccountForTool: (_kind: string, email?: string) => (email === 'nobody@example.com'
    ? { error: 'No connected agent Google account matches "nobody@example.com". Available: agent@example.com.' }
    : { account: { id: DASHBOARD_ID, email: 'agent@example.com', connected: true, enabledServices: null } }),
}));

const { executeGoogleSlidesTool, slidesToolDefinitions } = await import('../tools-slides.js');

/** The real per-call context the gate loop opens, with the style-store resources slides_create_presentation declares. */
function inCall<T>(body: () => T | Promise<T>): Promise<T> {
  const store = path.join(homeDir(), '.dojo', 'data', 'slides_styles.json');
  const grants: ResourceGrant[] = [
    { kind: 'fs_read', at: 'path', lexical: store, real: store },
    { kind: 'fs_write', at: 'path', lexical: store, real: store },
  ];
  return runWithToolCallId('agent-main', 'call-1', async () => {
    attachCallCapability(mintCallCapability({ agentId: 'agent-main', tool: 'slides_create_presentation', callId: 'call-1', grants }));
    return body();
  });
}

beforeEach(() => {
  googleRead.mockClear();
  googleWrite.mockClear();
});

describe('slides work on an account connected from the dashboard', () => {
  it('creating a deck asks Google with the account id', async () => {
    const out = await inCall(() => executeGoogleSlidesTool('slides_create_presentation', { title: 'Plan' }, 'agent-main', 'Main'));
    expect(out).toContain('deck-1');
    expect(googleWrite.mock.calls[0][8]).toBe(DASHBOARD_ID);
  });

  it('an account that does not resolve is refused before any call', async () => {
    const out = await executeGoogleSlidesTool('slides_create_presentation', { title: 'Plan', account: 'nobody@example.com' }, 'agent-main', 'Main');
    expect(out).toBe('Error: No connected agent Google account matches "nobody@example.com". Available: agent@example.com.');
    expect(googleWrite).not.toHaveBeenCalled();
  });

  it('every Slides tool offers the account parameter', () => {
    for (const def of slidesToolDefinitions) {
      expect((def.input_schema as { properties: Record<string, unknown> }).properties.account, def.name).toBeTruthy();
    }
  });
});
