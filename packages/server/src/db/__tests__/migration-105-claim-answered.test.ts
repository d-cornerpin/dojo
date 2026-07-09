// Migration 105 (fleet-upgrade duplicate-reply guard) verified against the ACTUAL
// SQL file, run on an in-memory DB. 105 stamps swept_at on legacy (conv_key NULL)
// user rows that were ALREADY answered before the upgrade, so the first boot does
// not re-serve them and text a duplicate reply. The heuristic must claim ONLY
// already-answered rows and leave genuinely-open asks to be served once.

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_105 = fs.readFileSync(
  path.join(HERE, '..', 'migrations', '105_claim_answered_legacy_rows.sql'),
  'utf-8',
);

let db: Database.Database;

// Insert a row with created_at set to `datetime('now', offset)`.
function insert(row: {
  id: string; agentId: string; role: string; content: string;
  createdOffset: string; convKey?: string | null; retiredAt?: string | null;
}): void {
  db.prepare(
    `INSERT INTO messages (id, agent_id, role, content, conv_key, swept_at, retired_at, created_at)
     VALUES (@id, @agentId, @role, @content, @convKey, NULL, @retiredAt, datetime('now', @createdOffset))`,
  ).run({
    id: row.id, agentId: row.agentId, role: row.role, content: row.content,
    convKey: row.convKey ?? null, retiredAt: row.retiredAt ?? null, createdOffset: row.createdOffset,
  });
}

const sweptOf = (id: string): string | null =>
  (db.prepare('SELECT swept_at FROM messages WHERE id = ?').get(id) as { swept_at: string | null }).swept_at;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      conv_key TEXT,
      swept_at TEXT,
      retired_at TEXT,
      created_at TEXT NOT NULL
    );
  `);

  // A: answered (plain-text reply 5 min later, within 30 min) → SWEPT
  insert({ id: 'a-user', agentId: 'A', role: 'user', content: 'what is the plan?', createdOffset: '-60 minutes' });
  insert({ id: 'a-reply', agentId: 'A', role: 'assistant', content: 'Here is the plan.', createdOffset: '-55 minutes' });

  // B: genuinely unanswered final message (no assistant after) → NOT swept
  insert({ id: 'b-user', agentId: 'B', role: 'user', content: 'are you there?', createdOffset: '-40 minutes' });

  // C: only a tool_use assistant row (structured content-block array) → NOT swept
  insert({ id: 'c-user', agentId: 'C', role: 'user', content: 'book the flight', createdOffset: '-60 minutes' });
  insert({ id: 'c-toolstep', agentId: 'C', role: 'assistant', content: '[{"type":"tool_use","name":"x"}]', createdOffset: '-58 minutes' });

  // D: reply exists but 40 min later (outside the 30-min window) → NOT swept
  insert({ id: 'd-user', agentId: 'D', role: 'user', content: 'slow question', createdOffset: '-120 minutes' });
  insert({ id: 'd-latereply', agentId: 'D', role: 'assistant', content: 'sorry for the delay', createdOffset: '-80 minutes' });

  // E: in-flight ask during the upgrade boot (younger than 2 min) → NOT swept even though answered
  insert({ id: 'e-user', agentId: 'E', role: 'user', content: 'quick one', createdOffset: '-30 seconds' });
  insert({ id: 'e-reply', agentId: 'E', role: 'assistant', content: 'on it', createdOffset: '-10 seconds' });

  // F: retired row (mig 102/104 relocation) with a nearby reply → NOT touched
  insert({ id: 'f-user', agentId: 'F', role: 'user', content: 'legacy a2a', createdOffset: '-60 minutes', retiredAt: '2026-07-01 00:00:00' });
  insert({ id: 'f-reply', agentId: 'F', role: 'assistant', content: 'ack', createdOffset: '-55 minutes' });

  // G: already claimed (conv_key set = delivered) → NOT touched
  insert({ id: 'g-user', agentId: 'G', role: 'user', content: 'answered already', createdOffset: '-60 minutes', convKey: 'owner' });
  insert({ id: 'g-reply', agentId: 'G', role: 'assistant', content: 'yes', createdOffset: '-55 minutes' });
});

describe('migration 105: claim answered legacy rows', () => {
  it('sweeps an already-answered legacy user row', () => {
    db.exec(MIGRATION_105);
    expect(sweptOf('a-user')).not.toBeNull();
  });

  it('leaves a genuinely unanswered final message unswept (served once after upgrade)', () => {
    db.exec(MIGRATION_105);
    expect(sweptOf('b-user')).toBeNull();
  });

  it('does not count a structured tool_use step as a delivered reply', () => {
    db.exec(MIGRATION_105);
    expect(sweptOf('c-user')).toBeNull();
  });

  it('does not sweep when the only reply is outside the 30-minute window', () => {
    db.exec(MIGRATION_105);
    expect(sweptOf('d-user')).toBeNull();
  });

  it('does not sweep an in-flight ask younger than 2 minutes', () => {
    db.exec(MIGRATION_105);
    expect(sweptOf('e-user')).toBeNull();
  });

  it('never touches a retired row', () => {
    db.exec(MIGRATION_105);
    expect(sweptOf('f-user')).toBeNull();
  });

  it('never touches an already-claimed (conv_key set) row', () => {
    db.exec(MIGRATION_105);
    expect(sweptOf('g-user')).toBeNull();
  });

  it('never sweeps an assistant row (role=user only)', () => {
    db.exec(MIGRATION_105);
    expect(sweptOf('a-reply')).toBeNull();
  });

  it('is idempotent (a second run sweeps nothing new and does not re-stamp)', () => {
    db.exec(MIGRATION_105);
    const firstStamp = sweptOf('a-user');
    const sweptCount1 = (db.prepare('SELECT COUNT(*) AS c FROM messages WHERE swept_at IS NOT NULL').get() as { c: number }).c;
    db.exec(MIGRATION_105);
    const sweptCount2 = (db.prepare('SELECT COUNT(*) AS c FROM messages WHERE swept_at IS NOT NULL').get() as { c: number }).c;
    expect(sweptCount2).toBe(sweptCount1);
    // The already-swept stamp is preserved (the WHERE swept_at IS NULL guard skips it).
    expect(sweptOf('a-user')).toBe(firstStamp);
  });
});
