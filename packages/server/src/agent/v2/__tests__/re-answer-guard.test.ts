import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { findCrossConvReAnswer, contentOverlap, normalizeForSimilarity } from '../re-answer-guard.js';

// Real texts from the 2026-07-10 dev reproduction: the original answer and two
// independent model rewordings of it, produced on unrelated wake turns.
const ORIGINAL =
  "About 35.4 inches - just under 3 feet. That's the diagonal math: your 6'2\" (74\") is the hypotenuse, " +
  "the 5'5\" bed (65\") is the base. Height comes out to sqrt(74^2 - 65^2) = sqrt(1251) = 35.4\". " +
  "So your head would be sitting nearly 3 feet above the tailgate. Pretty steep angle. If you're planning " +
  "to sleep back there, you'd be more comfortable curled up slightly rather than at a full rigid incline.";
const REWORDING_A =
  "Two options, depending on how you angle it. Straight along the length: not great. You'd need your head " +
  "propped up ~35 inches (nearly 3 ft) off the bed floor, a 29 degree incline. Basically a deep recline. " +
  "The math: you are 74 inches, the bed is 65 inches, so the height at your head is sqrt(74^2 - 65^2) " +
  "which is sqrt(1251), about 35.4 inches above the tailgate at the head end.";
const REWORDING_B =
  "Let me clean that up. He is 6'2\" (74\" tall). The bed is 5'5\" (65\" long). This is a right triangle: " +
  "his body is the hypotenuse, the bed floor is one leg, and the height at his head is the other leg. " +
  "sqrt(74^2 - 65^2) = sqrt(1251) which comes to roughly 35.4 inches, so his head sits about 3 feet up.";
const UNRELATED =
  "Here's the summary of this week's newsletter: five new listings appeared in the area, two price drops " +
  "on homes you bookmarked earlier, and an open house scheduled for Saturday morning at ten. Nothing needs " +
  "a reply; the subscription renews on Friday and no action is needed from you before then.";

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE messages (
    id TEXT PRIMARY KEY, agent_id TEXT, role TEXT, content TEXT,
    conversation_id TEXT, lane TEXT NOT NULL DEFAULT 'owner',
    created_at INTEGER DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
  );`);
  return db;
}

// T6b: `created_at` is epoch-ms INTEGER on the spine (migration 131), so the fixture's
// clock has to speak the same units as the guard's lookback predicate. Written as a
// SQLite expression, exactly as before, so the test still reads as "30 hours ago".
function seed(db: Database.Database, id: string, conversationId: string, content: string, createdAt = "'now'"): void {
  db.prepare(
    `INSERT INTO messages (id, agent_id, role, content, conversation_id, created_at) VALUES (?, 'a1', 'assistant', ?, ?, (CAST(strftime('%s', ${createdAt}) AS INTEGER) * 1000))`,
  ).run(id, content, conversationId);
}

describe('re-answer-guard', () => {
  it('scores rewordings high and unrelated prose low', () => {
    const a = normalizeForSimilarity(ORIGINAL);
    const simA = contentOverlap(a, normalizeForSimilarity(REWORDING_A));
    const simB = contentOverlap(a, normalizeForSimilarity(REWORDING_B));
    const simU = contentOverlap(a, normalizeForSimilarity(UNRELATED));
    expect(simA).toBeGreaterThanOrEqual(0.5);
    expect(simB).toBeGreaterThanOrEqual(0.5);
    expect(simU).toBeLessThan(0.3);
  });

  it('flags a reworded duplicate of a settled answer from another conversation', () => {
    const db = makeDb();
    seed(db, 'm1', 'conv-owner', ORIGINAL);
    const match = findCrossConvReAnswer(db as never, 'a1', REWORDING_B, 'conv-list');
    expect(match).not.toBeNull();
    expect(match!.conversationId).toBe('conv-owner');
  });

  it('flags the other rewording too', () => {
    const db = makeDb();
    seed(db, 'm1', 'conv-owner', ORIGINAL);
    const match = findCrossConvReAnswer(db as never, 'a1', REWORDING_A, 'conv-list');
    expect(match).not.toBeNull();
  });

  it('does not flag unrelated prose', () => {
    const db = makeDb();
    seed(db, 'm1', 'conv-owner', ORIGINAL);
    expect(findCrossConvReAnswer(db as never, 'a1', UNRELATED, 'conv-list')).toBeNull();
  });

  it('never compares against the turn\'s own trigger conversation (re-asks stay answerable)', () => {
    const db = makeDb();
    seed(db, 'm1', 'conv-owner', ORIGINAL);
    expect(findCrossConvReAnswer(db as never, 'a1', REWORDING_B, 'conv-owner')).toBeNull();
  });

  it('ignores short texts entirely', () => {
    const db = makeDb();
    seed(db, 'm1', 'conv-owner', ORIGINAL);
    expect(findCrossConvReAnswer(db as never, 'a1', 'About 35.4 inches, just under 3 feet.', 'email:x@example.com')).toBeNull();
  });

  it('ignores tool-array rows and old history', () => {
    const db = makeDb();
    seed(db, 'm1', 'owner', `[{"type":"tool_use","content":"${ORIGINAL.slice(0, 200)}"}]`);
    seed(db, 'm2', 'owner', ORIGINAL, `'now', '-30 hours'`);
    expect(findCrossConvReAnswer(db as never, 'a1', REWORDING_B, 'email:x@example.com')).toBeNull();
  });
});
