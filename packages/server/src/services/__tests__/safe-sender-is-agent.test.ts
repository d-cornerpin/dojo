// ════════════════════════════════════════
// RC-4/RC-8: safe-sender is_agent flag round-trip (owner ruled 2026-07-16)
//
// The Settings checkbox and the add_safe_sender tool both persist is_agent
// into the config JSON; this pins the server-side parse contract so a saved
// flag survives the round-trip: explicit true kept, explicit false wins over
// the description heuristic, absent defaults false, heuristic backfills only
// on an AI-agent-shaped description.
// ════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import { parseSafeSenders } from '../imessage-bridge.js';

const base = {
  address: '+15550000001',
  name: 'Counterpart',
  is_primary: false,
  sharing_level: 'open_book',
};

describe('parseSafeSenders is_agent round-trip', () => {
  it('keeps an explicit true', () => {
    const [s] = parseSafeSenders(JSON.stringify([{ ...base, is_agent: true }]));
    expect(s.is_agent).toBe(true);
  });

  it('defaults to false when absent and description is ordinary', () => {
    const [s] = parseSafeSenders(JSON.stringify([{ ...base, description: 'a family friend' }]));
    expect(s.is_agent ?? false).toBe(false);
  });

  it('backfills true from an AI-agent-shaped description when the flag is absent', () => {
    const [s] = parseSafeSenders(JSON.stringify([{ ...base, description: 'the household AI agent for scheduling' }]));
    expect(s.is_agent).toBe(true);
  });

  it('explicit false wins over the description heuristic', () => {
    const [s] = parseSafeSenders(JSON.stringify([{ ...base, is_agent: false, description: 'an AI agent contact' }]));
    expect(s.is_agent ?? false).toBe(false);
  });

  it('legacy string entries parse with the flag unset/false', () => {
    const [s] = parseSafeSenders(JSON.stringify(['+15550000002']));
    expect(s.is_agent ?? false).toBe(false);
  });
});
