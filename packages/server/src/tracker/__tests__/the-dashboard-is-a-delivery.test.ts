// ════════════════════════════════════════════════════════════════════════════════
// UX-REPAIR ROUND 4 T19 / D7 — THE LINE THE MODEL READS, AND IT WAS A FALSE NEGATIVE.
//
// `composeTurnDeliverySummary` selects `channel NOT IN ('dashboard','voice')`, so EVERY
// reminder answered in dashboard chat — the owner's primary channel — is stamped
// `(no delivery recorded)` for ever. Measured on the body: every `activity` row for the
// incident's schedule carries `delivery_summary: null` except the two that wrote files.
//
// It is not a cosmetic string. At 13:45:25 the model read ONE tool result carrying BOTH:
//
//     State: replied T4601 3h ago (no delivery recorded)
//     [ENGINE RECORD: this task's work appears ALREADY DELIVERED … do NOT redo or re-deliver]
//
// (the second from `tracker/delivery-evidence.ts`, which does NOT exclude the dashboard) and
// spent ~700 words of reasoning trying to reconcile them. A contributing cause of the
// incident, independently reproduced by the driven repro at 18:50 (seq 60034).
//
// ── AND THE GUARD THAT MUST SURVIVE, BECAUSE IT HAS ITS OWN INCIDENT ──
// The TANGIBILITY RULE (battery catch 2026-07-22): a bare reply is not a handover, and
// nudging CLOSE on one *"strangled a delegation synthesis task mid-wait"*. Four consumers
// key on `last_delivery_summary` being non-null and every one of them means TANGIBLE:
// the CLOSE-if-done nudge, the ALREADY-DELIVERED block, the close-out gate's evidence
// consult, and the strike-0 same-turn close. So the summary becomes TRUE without becoming
// a licence: a dashboard-only delivery is named, and it is named as a value the tangibility
// predicate declares NOT tangible. One writer, one reader, a closed declared set — never a
// prose test.
// ════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };

vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));

import {
  composeTurnDeliverySummary, renderTaskStamps, isTangibleDeliverySummary,
  NON_TANGIBLE_DELIVERY_SUMMARIES,
} from '../task-stamps.js';

const AGENT = 'kevin';
const TURN = 4601;

const db = (): Database.Database => mockDb.current!;

function seedMessage(id: string, displayKind: string): string {
  db().prepare('INSERT INTO messages (id, display_kind, content) VALUES (?, ?, ?)')
    .run(id, displayKind, 'routine.');
  return id;
}

function seedDelivery(o: {
  id: string; channel?: string; turn?: number; displayKind?: string | null; outcome?: string;
}): void {
  const messageId = o.displayKind === null ? null : seedMessage(`m-${o.id}`, o.displayKind ?? 'agent-text');
  db().prepare(
    `INSERT INTO deliveries (id, agent_id, turn_number, channel, outcome, message_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(o.id, AGENT, o.turn ?? TURN, o.channel ?? 'dashboard', o.outcome ?? 'delivered', messageId);
}

beforeEach(() => {
  const fresh = new Database(':memory:');
  fresh.exec(`
    CREATE TABLE messages (id TEXT PRIMARY KEY, display_kind TEXT, content TEXT);
    CREATE TABLE deliveries (
      id TEXT PRIMARY KEY, agent_id TEXT, turn_number INTEGER, channel TEXT,
      outcome TEXT, message_id TEXT
    );
    CREATE TABLE turn_artifacts (
      agent_id TEXT, turn_number INTEGER, kind TEXT, path TEXT, payload_json TEXT, delivered_at TEXT
    );
  `);
  mockDb.current = fresh;
});

// ══════════════════════════════════════════════════════════════════════════════
describe('D7 — a message the owner read on the dashboard is a delivery', () => {
  it('a dashboard answer is NAMED, not erased (the false negative)', () => {
    seedDelivery({ id: 'd1', channel: 'dashboard', displayKind: 'agent-text' });
    expect(composeTurnDeliverySummary(AGENT, TURN)).toBe('via dashboard');
  });

  it('the state line stops saying "no delivery recorded" when there was one', () => {
    const line = renderTaskStamps({
      last_activity_turn: TURN, last_activity_at: '2026-08-10 10:45:00', last_activity_outcome: 'answered',
      last_answered_turn: TURN, last_answered_at: '2026-08-10 10:45:00',
      last_delivery_summary: 'via dashboard',
    });
    expect(line).not.toContain('no delivery recorded');
    expect(line).toContain('via dashboard');
  });

  it('and it does NOT push CLOSE — the 2026-07-22 tangibility rule is unchanged', () => {
    const line = renderTaskStamps({
      last_activity_turn: TURN, last_activity_at: '2026-08-10 10:45:00', last_activity_outcome: 'answered',
      last_answered_turn: TURN, last_answered_at: '2026-08-10 10:45:00',
      last_delivery_summary: 'via dashboard',
    });
    expect(line).not.toContain('CLOSE if done');
    expect(isTangibleDeliverySummary('via dashboard')).toBe(false);
  });

  it('a voice answer is named the same way', () => {
    seedDelivery({ id: 'd1', channel: 'voice', displayKind: 'agent-text' });
    expect(composeTurnDeliverySummary(AGENT, TURN)).toBe('via voice');
  });

  it('a tool-call CHIP is not a delivery of anything (D2\'s set, one owner)', () => {
    seedDelivery({ id: 'd1', channel: 'dashboard', displayKind: 'tool-turn' });
    expect(composeTurnDeliverySummary(AGENT, TURN)).toBe('');
  });

  it('a working-note is not a delivery either', () => {
    seedDelivery({ id: 'd1', channel: 'dashboard', displayKind: 'working-note' });
    expect(composeTurnDeliverySummary(AGENT, TURN)).toBe('');
  });

  it('NEGATIVE: a turn with nothing delivered still reads "no delivery recorded"', () => {
    expect(composeTurnDeliverySummary(AGENT, TURN)).toBe('');
    const line = renderTaskStamps({
      last_activity_turn: TURN, last_activity_at: '2026-08-10 10:45:00', last_activity_outcome: 'answered',
      last_answered_turn: TURN, last_answered_at: '2026-08-10 10:45:00',
      last_delivery_summary: null,
    });
    expect(line).toContain('no delivery recorded');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('the tangibility rule survives verbatim', () => {
  it('CONTROL: an out-of-band channel is a TANGIBLE handover and still pushes CLOSE', () => {
    seedDelivery({ id: 'd1', channel: 'imessage', displayKind: null });
    const summary = composeTurnDeliverySummary(AGENT, TURN);
    expect(summary).toBe('via imessage');
    expect(isTangibleDeliverySummary(summary)).toBe(true);
    const line = renderTaskStamps({
      last_activity_turn: TURN, last_activity_at: '2026-08-10 10:45:00', last_activity_outcome: 'answered',
      last_answered_turn: TURN, last_answered_at: '2026-08-10 10:45:00',
      last_delivery_summary: summary,
    });
    expect(line).toContain('CLOSE if done');
  });

  it('CONTROL: a file artifact is tangible and still names the file', () => {
    db().prepare(
      `INSERT INTO turn_artifacts VALUES (?, ?, 'file', '/tmp/report.md', NULL, '2026-08-10 10:45:00')`,
    ).run(AGENT, TURN);
    const summary = composeTurnDeliverySummary(AGENT, TURN);
    expect(summary).toBe('file report.md');
    expect(isTangibleDeliverySummary(summary)).toBe(true);
  });

  it('a file PLUS a dashboard bubble is tangible: the dashboard never demotes a real handover', () => {
    db().prepare(
      `INSERT INTO turn_artifacts VALUES (?, ?, 'file', '/tmp/report.md', NULL, '2026-08-10 10:45:00')`,
    ).run(AGENT, TURN);
    seedDelivery({ id: 'd1', channel: 'dashboard', displayKind: 'agent-text' });
    const summary = composeTurnDeliverySummary(AGENT, TURN);
    expect(summary).toBe('file report.md');
    expect(isTangibleDeliverySummary(summary)).toBe(true);
  });

  it('the non-tangible set is CLOSED and declared, never inferred from the prose', () => {
    expect([...NON_TANGIBLE_DELIVERY_SUMMARIES].sort()).toEqual(['via dashboard', 'via voice']);
    expect(isTangibleDeliverySummary(null)).toBe(false);
    expect(isTangibleDeliverySummary('')).toBe(false);
    expect(isTangibleDeliverySummary('via imessage')).toBe(true);
  });

  it('every consumer of the finished-work predicate asks the ONE helper', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const url = await import('node:url');
    // The ENGINE's two consumers (the close-out gate's evidence consult and the strike-0
    // same-turn close) live inside step packages that PHASE-6 moves, so the corpus is the
    // shared engine derivation, never a path — `guard-corpus-census`'s rule.
    const { engineText } = await import('../../agent/v2/__tests__/engine-sources.js');
    const engine = engineText();
    expect((engine.match(/isTangibleDeliverySummary/g) ?? []).length,
      'the close-out gate AND the strike-0 close both ask the helper').toBeGreaterThanOrEqual(2);
    // The tool door is not a step package and is read directly.
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const tools = fs.readFileSync(path.resolve(here, '../tools.ts'), 'utf8');
    expect(tools).toContain('isTangibleDeliverySummary');
  });
});
