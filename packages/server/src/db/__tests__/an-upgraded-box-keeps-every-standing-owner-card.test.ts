// An upgraded box keeps every owner card that stood in its own store before 901: each one stands after the upgrade in
// the notices table, under the key and words its site writes, a dismissed one stays dismissed, and nothing is pushed.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../connection.js', async () => (await import('../../work/done/__tests__/helpers/done-db.js')).connectionMock());
const frames = vi.hoisted(() => [] as unknown[]);
vi.mock('../../gateway/ws.js', () => ({ broadcast: (f: unknown) => { frames.push(f); }, stampPersistedRow: (e: unknown) => e }));
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

import { boxBefore901, upgrade, HELPER, MAIN, SENSEI } from './helpers/a-box-before-901.js';
import { doneDb } from '../../work/done/__tests__/helpers/done-db.js';
import { standingOwnerNotices } from '../../healer/owner-notice-kinds.js';

const notice = (words: string, dismissedAt?: number): string => JSON.stringify({ at: Date.now(), words, ...(dismissedAt ? { dismissedAt } : {}) });

beforeEach(() => {
  boxBefore901();
  frames.length = 0;
  const db = doneDb();
  const nowS = Math.floor(Date.now() / 1000);
  db.prepare("INSERT INTO google_accounts (id, kind, position, email, connected, owner_notice) VALUES ('g-1', 'user', 0, 'owner@example.com', 0, ?)").run(notice('The Google sign-in expired.'));
  db.prepare("INSERT INTO google_accounts (id, kind, position, email, connected, enabled, watch_email) VALUES ('g-2', 'agent', 1, 'agent@example.com', 1, 1, 1)").run();
  db.prepare("INSERT INTO microsoft_accounts (id, kind, position, email, connected, owner_notice) VALUES ('m-1', 'user', 0, 'owner@example.com', 0, ?)").run(notice('The Microsoft sign-in expired.', Date.now()));
  db.prepare("UPDATE agents SET status = 'rate_limited', rate_limit_notice = ? WHERE id = ?").run(notice('Rate-limited for six hours.'), HELPER);
  db.prepare('UPDATE agents SET broken_notice = ?, silent_notice = ? WHERE id = ?').run(notice('It stopped: the key was refused.'), notice('It has been quiet past its window.'), MAIN);
  db.prepare("UPDATE agents SET status = 'paused' WHERE id = ?").run(SENSEI);
  db.prepare("INSERT INTO error_loop_state (agent_id, kind, at_ms) VALUES (?, 'paused', ?)").run(SENSEI, Date.now());
  db.prepare("INSERT INTO config (key, value) VALUES ('openrouter_threshold_alerted', ?), ('owner_notice_memory_low', ?), ('owner_notice_watcher_gmail', ?)")
    .run(notice('The balance is at its warning line.'), JSON.stringify({ at: Date.now() }), JSON.stringify({ 'g-2': { at: Date.now(), words: 'Gmail watching has been failing.' }, 'g-3': 'not a card' }));
  db.prepare("UPDATE budgets SET alert_90_sent = ?, alert_words = 'Spend is at 90% of the daily limit.' WHERE id = 'global_daily'").run(nowS);
});

describe('an upgraded box keeps every standing owner card', () => {
  it('each store\'s card stands after 901 in its words; the dismissed one stays dismissed; nothing is pushed', () => {
    upgrade();
    const cards = Object.fromEntries(standingOwnerNotices().map((c) => [c.cardKey, c.words]));
    expect(cards, 'a rate-limited agent is idle after the update, so its card no longer stands').not.toHaveProperty(`ratelimit:${HELPER}`);
    expect(cards).toEqual({
      'signin:google:g-1': 'The Google sign-in expired.',
      [`broken:${MAIN}`]: 'It stopped: the key was refused.',
      [`silent:${MAIN}`]: 'It has been quiet past its window.',
      [`paused:${SENSEI}`]: `${SENSEI} has been paused after repeated errors. Open the Vitals page to investigate, or resume it from its detail page.`,
      'balance:openrouter_threshold_alerted': 'The balance is at its warning line.',
      'memory-low': 'Critical: System memory below 512MB. Terminate idle sub-agents.',
      'watcher:gmail:g-2': 'Gmail watching has been failing.',
      'budget:global_daily': 'Spend is at 90% of the daily limit.',
    });
    expect(doneDb().prepare("SELECT 1 FROM healer_state WHERE scope = 'owner_dismissed' AND key = 'signin:microsoft:m-1'").get()).toBeTruthy();
    expect(frames).toEqual([]);
  });
});
