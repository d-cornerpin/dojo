// RC-2 open-loops unit tests.
//
// Open loops moved out of immortal summary prose into structured, retirable rows.
// These pin the load-bearing behaviors: defensive parsing + stripping of the fenced
// OPEN-LOOPS section, deterministic dedup, the store-contradiction guard that kills
// the 7/12 "your message was lost" poison, resolution (by RESOLVED/CLOSED match and
// by id-prefix tool), staleness that surfaces instead of dropping, and the volatile
// injection block (current conversation + capped cross-conversation overflow).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { Message, MessageOrigin } from '@dojo/shared';

const mockDb = { current: null as Database.Database | null };

vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));

// party-label.ts -> config/platform.ts getOwnerName(); keep it off the real config.
vi.mock('../../config/platform.js', () => ({
  getOwnerName: () => 'the owner',
}));

import {
  parseSummaryLoops,
  stripOpenLoopsSection,
  insertOpenLoop,
  resolveMatchingLoops,
  resolveOpenLoopByPrefix,
  markStaleLoops,
  getStaleLoops,
  buildStaleLoopsBriefSection,
  buildOpenLoopsInjection,
  ingestSummaryOpenLoops,
  loopDescriptionsSimilar,
  assertsMissingInbound,
  type OpenLoopRow,
} from '../open-loops.js';

beforeEach(() => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      turn_number INTEGER,
      conv_key TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    ,
      conversation_id TEXT);
    -- PHASE-2 T3: "is any inbound still unserved?" is a work-spine question now, not a
    -- conv_key scan. Only the columns the guard reads are modelled here.
    CREATE TABLE work (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      state TEXT NOT NULL,
      opened_at INTEGER NOT NULL
    );
    CREATE TABLE open_loops (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      conv_key TEXT,
      description TEXT NOT NULL,
      source_message_id TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      resolved_by_message_id TEXT,
      conversation_id TEXT,
      answered_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  mockDb.current = db;
});

const AGENT = 'primary';

function allLoops(): OpenLoopRow[] {
  return mockDb.current!.prepare('SELECT * FROM open_loops ORDER BY created_at ASC').all() as OpenLoopRow[];
}

function seedUser(convKey: string | null): void {
  mockDb.current!.prepare(
    `INSERT INTO messages (id, agent_id, role, content, conv_key) VALUES (?, ?, 'user', 'x', ?)`,
  ).run(`u-${Math.random().toString(36).slice(2)}`, AGENT, convKey);
}

/** An inbound nobody has picked up. T3: that is an OPEN ASK, not a NULL conv_key. */
function seedUnservedAsk(): void {
  mockDb.current!.prepare(
    `INSERT INTO work (id, agent_id, kind, state, opened_at) VALUES (?, ?, 'ask', 'open', ?)`,
  ).run(`ask:${Math.random().toString(36).slice(2)}`, AGENT, Date.now());
}

const selfOrigin: MessageOrigin = {
  kind: 'self', relation: 'agent', channel: null,
  senderName: null, senderId: null, threadId: null, intent: null, authorized: true,
};

function selfMsg(id: string, convKey: string): Message {
  return {
    id, agentId: AGENT, role: 'assistant', content: 'x',
    tokenCount: null, modelId: null, cost: null, latencyMs: null,
    createdAt: '2026-07-15 12:00:00', convKey, origin: selfOrigin,
  } as Message;
}

// ── parsing ──

describe('parseSummaryLoops', () => {
  it('extracts fenced OPEN-LOOPS entries and strips the section', () => {
    const text = [
      '[2026-07-12] The owner asked for the Delta number.',
      '',
      'RESOLVED: nothing yet',
      '',
      'OPEN-LOOPS:',
      '- (the owner) asked Sam for his Delta SkyMiles number for their spouse',
      '- (Maya (imessage)) wants the hotel confirmation code',
      'END-OPEN-LOOPS',
    ].join('\n');
    const p = parseSummaryLoops(text);
    expect(p.parsedOk).toBe(true);
    expect(p.openLoops).toHaveLength(2);
    expect(p.openLoops[0]).toContain('Delta SkyMiles');
    expect(p.strippedText).not.toContain('OPEN-LOOPS');
    expect(p.strippedText).toContain('Delta number'); // body preserved
    expect(p.strippedText).toContain('RESOLVED:');     // other sections preserved
  });

  it('treats "- none" as no open loops', () => {
    const text = 'Body.\n\nOPEN-LOOPS:\n- none\nEND-OPEN-LOOPS';
    const p = parseSummaryLoops(text);
    expect(p.openLoops).toEqual([]);
    expect(p.strippedText).not.toContain('OPEN-LOOPS');
  });

  it('handles a missing OPEN-LOOPS section without stripping', () => {
    const text = 'Just a summary body with no loops section.';
    const p = parseSummaryLoops(text);
    expect(p.parsedOk).toBe(true);
    expect(p.openLoops).toEqual([]);
    expect(p.strippedText).toBe(text);
  });

  it('does not swallow the rest of the summary when END marker is missing', () => {
    const text = [
      'OPEN-LOOPS:',
      '- (the owner) still owe the owner the flight codes',
      '',
      'Some later narrative paragraph that must survive.',
    ].join('\n');
    const p = parseSummaryLoops(text);
    expect(p.openLoops).toHaveLength(1);
    expect(p.strippedText).toContain('later narrative paragraph');
  });

  it('parses RESOLVED and CLOSED entries', () => {
    const text = 'RESOLVED: sent the number to Maya, done\nCLOSED: hotel booking, completed';
    const p = parseSummaryLoops(text);
    expect(p.resolved.some((r) => r.includes('sent the number'))).toBe(true);
    expect(p.resolved.some((r) => r.includes('hotel booking'))).toBe(true);
  });

  it('stripOpenLoopsSection is a no-op when absent', () => {
    expect(stripOpenLoopsSection('no section here')).toBe('no section here');
  });
});

// ── similarity / dedup ──

describe('loopDescriptionsSimilar + dedup', () => {
  it('matches paraphrases with high word overlap', () => {
    expect(loopDescriptionsSimilar(
      'asked Sam for his Delta SkyMiles number',
      'asked Sam for the Delta SkyMiles number',
    )).toBe(true);
    expect(loopDescriptionsSimilar('hotel code', 'car rental receipt')).toBe(false);
  });

  it('insertOpenLoop dedups a similar description in the same conversation', () => {
    const id1 = insertOpenLoop({ agentId: AGENT, convKey: 'imessage:maya', description: 'get the hotel confirmation code for Maya', sourceMessageId: null });
    const id2 = insertOpenLoop({ agentId: AGENT, convKey: 'imessage:maya', description: 'get the hotel confirmation code for maya', sourceMessageId: null });
    expect(id1).toBeTruthy();
    expect(id2).toBeNull();
    expect(allLoops()).toHaveLength(1);
  });

  it('keeps distinct descriptions in the same conversation', () => {
    insertOpenLoop({ agentId: AGENT, convKey: 'imessage:maya', description: 'get the hotel code', sourceMessageId: null });
    insertOpenLoop({ agentId: AGENT, convKey: 'imessage:maya', description: 'book the rental car', sourceMessageId: null });
    expect(allLoops()).toHaveLength(2);
  });
});

// ── store-contradiction guard ──

describe('store-contradiction guard', () => {
  it('assertsMissingInbound matches the poison family', () => {
    expect(assertsMissingInbound('your last message got lost in a context compression')).toBe(true);
    expect(assertsMissingInbound('your iMessage got eaten by a memory compaction')).toBe(true);
    expect(assertsMissingInbound('my memory ate your last message')).toBe(true);
    expect(assertsMissingInbound('owe the owner the flight codes')).toBe(false);
  });

  it('rejects a missing-inbound loop when every recent inbound was served', () => {
    seedUser('imessage:sam'); // served (its ask was claimed); NO open ask exists
    const id = insertOpenLoop({
      agentId: AGENT, convKey: 'imessage:sam',
      description: "Sam texted something I never read; it got eaten by compaction",
      sourceMessageId: null,
    });
    expect(id).toBeNull();
    expect(allLoops()).toHaveLength(0);
  });

  it('allows a missing-inbound loop when an unserved inbound exists', () => {
    seedUser('imessage:sam'); // served
    seedUnservedAsk();          // genuinely unserved inbound present
    const id = insertOpenLoop({
      agentId: AGENT, convKey: 'imessage:sam',
      description: "Sam texted something I never read; it got eaten by compaction",
      sourceMessageId: null,
    });
    expect(id).toBeTruthy();
  });

  it('does not touch loops that make no missing-inbound claim', () => {
    seedUser('imessage:sam');
    const id = insertOpenLoop({
      agentId: AGENT, convKey: 'imessage:sam',
      description: 'still owe Sam the answer about the offsite budget',
      sourceMessageId: null,
    });
    expect(id).toBeTruthy();
  });
});

// ── resolution ──

describe('resolution', () => {
  it('resolveMatchingLoops closes a matching open loop', () => {
    insertOpenLoop({ agentId: AGENT, convKey: 'imessage:maya', description: 'send the hotel confirmation code to Maya', sourceMessageId: null });
    const closed = resolveMatchingLoops(AGENT, ['sent the hotel confirmation code to maya']);
    expect(closed).toBe(1);
    expect(allLoops()[0].status).toBe('resolved');
  });

  it('resolveOpenLoopByPrefix resolves by id prefix', () => {
    const id = insertOpenLoop({ agentId: AGENT, convKey: 'imessage:maya', description: 'book the rental car', sourceMessageId: null })!;
    const res = resolveOpenLoopByPrefix(AGENT, id.slice(0, 8));
    expect(res.ok).toBe(true);
    expect(allLoops()[0].status).toBe('resolved');
  });

  it('resolveOpenLoopByPrefix reports a missing prefix', () => {
    const res = resolveOpenLoopByPrefix(AGENT, 'deadbeef');
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/No open loop/);
  });

  it('resolveOpenLoopByPrefix rejects a too-short prefix', () => {
    const res = resolveOpenLoopByPrefix(AGENT, 'ab');
    expect(res.ok).toBe(false);
  });
});

// ── staleness (surface, never drop) ──

describe('staleness', () => {
  function insertAged(desc: string, daysAgo: number): string {
    const id = `loop-${Math.random().toString(36).slice(2)}`;
    mockDb.current!.prepare(
      `INSERT INTO open_loops (id, agent_id, conv_key, description, status, created_at, updated_at)
        VALUES (?, ?, 'owner', ?, 'open', datetime('now', ?), datetime('now'))`,
    ).run(id, AGENT, desc, `-${daysAgo} days`);
    return id;
  }

  it('flips loops past the threshold to stale (not dropped) and leaves fresh ones open', () => {
    insertAged('old unanswered ask', 8);
    insertAged('fresh ask', 1);
    const flipped = markStaleLoops(AGENT);
    expect(flipped).toBe(1);
    const stale = getStaleLoops(AGENT);
    expect(stale).toHaveLength(1);
    expect(stale[0].description).toBe('old unanswered ask');
    // still present, not deleted
    expect(allLoops()).toHaveLength(2);
  });

  it('buildStaleLoopsBriefSection lists stale loops with the ask-again prompt', () => {
    insertAged('old unanswered ask', 9);
    markStaleLoops(AGENT);
    const section = buildStaleLoopsBriefSection(AGENT);
    expect(section).toContain('Still open, no answer: old unanswered ask');
    expect(section).toContain('ask again or drop?');
  });

  it('stale loops are NOT injected per turn', () => {
    insertAged('old unanswered ask', 10);
    markStaleLoops(AGENT);
    expect(buildOpenLoopsInjection(AGENT, 'owner')).toBeNull();
  });
});

// ── injection ──

describe('buildOpenLoopsInjection', () => {
  it('shows the current conversation loops and caps cross-conversation overflow at 3', () => {
    insertOpenLoop({ agentId: AGENT, convKey: 'imessage:maya', description: 'current conv loop', sourceMessageId: null });
    for (let i = 0; i < 5; i++) {
      insertOpenLoop({ agentId: AGENT, convKey: `imessage:other${i}`, description: `other loop ${i}`, sourceMessageId: null });
    }
    const block = buildOpenLoopsInjection(AGENT, 'imessage:maya')!;
    expect(block).toContain('OPEN LOOPS (unresolved; resolve when answered):');
    expect(block).toContain('current conv loop');
    // 1 current + 3 overflow = 4 numbered lines
    const numbered = block.split('\n').filter((l) => /^\d+\. \[/.test(l));
    expect(numbered).toHaveLength(4);
    expect(block).toContain('[other conversation]');
  });

  it('caps the block near 600 chars', () => {
    // Distinct word content per loop so dedup does not merge them (shared padding
    // words stay under both the Jaccard and coverage thresholds).
    for (let i = 0; i < 20; i++) {
      insertOpenLoop({
        agentId: AGENT, convKey: 'imessage:maya',
        description: `topic${i} k${i}aa k${i}bb k${i}cc k${i}dd k${i}ee pending owner reply awaited`,
        sourceMessageId: null,
      });
    }
    const block = buildOpenLoopsInjection(AGENT, 'imessage:maya')!;
    expect(block.length).toBeLessThanOrEqual(610);
    expect(block).toContain('…');
  });

  it('returns null when there are no open loops', () => {
    expect(buildOpenLoopsInjection(AGENT, 'owner')).toBeNull();
  });
});

// ── end-to-end ingest ──

describe('ingestSummaryOpenLoops', () => {
  it('upserts attributed loops, resolves matches, and returns stripped text', () => {
    // a pre-existing open loop that the summary will resolve
    insertOpenLoop({ agentId: AGENT, convKey: 'imessage:maya', description: 'send the flight codes to Maya', sourceMessageId: null });

    const summaryText = [
      '[2026-07-15] Maya asked for the flight codes and the hotel code.',
      '',
      'RESOLVED: sent the flight codes to Maya, done',
      '',
      'OPEN-LOOPS:',
      '- (Maya (imessage)) still owe Maya the hotel confirmation code',
      'END-OPEN-LOOPS',
    ].join('\n');

    const chunk = [selfMsg('m1', 'imessage:maya')];
    const stripped = ingestSummaryOpenLoops({ agentId: AGENT, summaryText, chunk });

    expect(stripped).not.toContain('OPEN-LOOPS');
    expect(stripped).toContain('Maya asked');

    const loops = allLoops();
    // the flight-codes loop resolved; the hotel-code loop newly open
    const resolved = loops.find((l) => l.description.includes('flight codes'));
    const open = loops.find((l) => l.description.includes('hotel confirmation code'));
    expect(resolved?.status).toBe('resolved');
    expect(open?.status).toBe('open');
    expect(open?.conv_key).toBe('imessage:maya'); // attributed via the chunk
  });

  it('stores the summary unchanged when parsing finds no section', () => {
    const summaryText = 'A plain summary with no loops section at all.';
    const out = ingestSummaryOpenLoops({ agentId: AGENT, summaryText, chunk: [] });
    expect(out).toBe(summaryText);
    expect(allLoops()).toHaveLength(0);
  });
});
