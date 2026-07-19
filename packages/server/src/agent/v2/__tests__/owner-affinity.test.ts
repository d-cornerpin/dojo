// RC-10: owner-channel affinity + promotion rate-limit tests.
//
// resolveOwnerAffinityChannel follows the channel the owner most recently conversed on
// (iMessage within 48h → promote a dashboard-default reply to iMessage). The rate limit
// bounds promotions to one per conversation per cooldown so a background-wake storm
// can't become a text storm.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };

vi.mock('../../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));

import {
  resolveOwnerAffinityChannel,
  affinityPromotionAllowed,
  recordAffinityPromotion,
  affinityPromotionRefusedNoBasis,
} from '../owner-affinity.js';

let rowid = 0;
function insertInbound(agentId: string, content: string, inboundMeta: string | null, ageMinutes = 1): void {
  mockDb.current!.prepare(
    `INSERT INTO messages (id, agent_id, role, content, inbound_meta, created_at)
       VALUES (?, ?, 'user', ?, ?, datetime('now', ?))`,
  ).run(`m${++rowid}`, agentId, content, inboundMeta, `-${ageMinutes} minutes`);
}

const ownerImessageMeta = JSON.stringify({
  channel: 'imessage', authorized: true, sender: 'Sam', relation: 'owner',
});

beforeEach(() => {
  rowid = 0;
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT,
      source TEXT,
      source_agent_id TEXT,
      a2a_thread_id TEXT,
      a2a_intent TEXT,
      a2a_requires_response INTEGER,
      inbound_meta TEXT,
      origin_kind TEXT,
      origin_intent TEXT,
      conv_key TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
  `);
  mockDb.current = db;
});

describe('RC-10 resolveOwnerAffinityChannel', () => {
  it('returns iMessage when the newest owner inbound was iMessage within 48h and the bridge is configured', () => {
    insertInbound('a1', '[SOURCE: IMESSAGE FROM Sam] hey', ownerImessageMeta, 30);
    expect(resolveOwnerAffinityChannel('a1', { imessageBridgeConfigured: true })).toBe('imessage');
  });

  it('returns null when the bridge is not configured', () => {
    insertInbound('a1', '[SOURCE: IMESSAGE FROM Sam] hey', ownerImessageMeta, 30);
    expect(resolveOwnerAffinityChannel('a1', { imessageBridgeConfigured: false })).toBeNull();
  });

  it('returns null when the newest owner inbound was the dashboard (plain text)', () => {
    insertInbound('a1', '[SOURCE: IMESSAGE FROM Sam] hey', ownerImessageMeta, 120); // older iMessage
    insertInbound('a1', 'what is on my calendar today?', null, 5);                    // newest = dashboard
    expect(resolveOwnerAffinityChannel('a1', { imessageBridgeConfigured: true })).toBeNull();
  });

  it('returns null when there is no owner inbound in the window', () => {
    expect(resolveOwnerAffinityChannel('a1', { imessageBridgeConfigured: true })).toBeNull();
  });

  it('ignores an iMessage that is older than the 48h window', () => {
    insertInbound('a1', '[SOURCE: IMESSAGE FROM Sam] hey', ownerImessageMeta, 60 * 60); // ~2.5 days
    expect(resolveOwnerAffinityChannel('a1', { imessageBridgeConfigured: true })).toBeNull();
  });
});

describe('RC-10 promotion rate-limit', () => {
  it('allows a promotion when none recorded, then blocks within the cooldown', () => {
    expect(affinityPromotionAllowed('a1', 'owner')).toBe(true);
    recordAffinityPromotion('a1', 'owner');
    expect(affinityPromotionAllowed('a1', 'owner')).toBe(false);
  });

  it('is scoped per conversation', () => {
    recordAffinityPromotion('a1', 'owner');
    expect(affinityPromotionAllowed('a1', 'owner')).toBe(false);
    expect(affinityPromotionAllowed('a1', 'imessage:someone')).toBe(true);
  });

  it('allows again once the cooldown has elapsed', () => {
    // Seed a promotion timestamp older than the 4h cooldown directly.
    mockDb.current!.prepare(
      `INSERT INTO config (key, value, updated_at) VALUES (?, datetime('now', '-5 hours'), datetime('now'))`,
    ).run('owner_affinity_last_promo:a1:owner');
    expect(affinityPromotionAllowed('a1', 'owner')).toBe(true);
  });
});

// Turn-anchored auto-route basis (phantom-outreach fix, 2026-07-18). Pure predicate:
// the affinity-only iMessage promotion is refused exactly when affinity resolved to
// iMessage but there was NO inbound this turn AND the owner is not away.
describe('affinityPromotionRefusedNoBasis (route-basis decision)', () => {
  it('REFUSES the phantom shape: affinity iMessage, no inbound this turn, owner not away', () => {
    expect(
      affinityPromotionRefusedNoBasis({ ownerAffinityChannel: 'imessage', inboundChannel: null, presence: 'in_dojo' }),
    ).toBe(true);
  });

  it('keeps the promotion when the owner is away (away override is an affirmative basis)', () => {
    expect(
      affinityPromotionRefusedNoBasis({ ownerAffinityChannel: 'imessage', inboundChannel: null, presence: 'away' }),
    ).toBe(false);
  });

  it('keeps the promotion when there is a real inbound this turn (inbound is an affirmative basis)', () => {
    expect(
      affinityPromotionRefusedNoBasis({ ownerAffinityChannel: 'imessage', inboundChannel: 'dashboard', presence: 'in_dojo' }),
    ).toBe(false);
    expect(
      affinityPromotionRefusedNoBasis({ ownerAffinityChannel: 'imessage', inboundChannel: 'imessage', presence: 'in_dojo' }),
    ).toBe(false);
  });

  it('is vacuously not-refused when no affinity resolved (nothing to promote)', () => {
    expect(
      affinityPromotionRefusedNoBasis({ ownerAffinityChannel: null, inboundChannel: null, presence: 'in_dojo' }),
    ).toBe(false);
    expect(
      affinityPromotionRefusedNoBasis({ ownerAffinityChannel: null, inboundChannel: null, presence: 'away' }),
    ).toBe(false);
  });
});
