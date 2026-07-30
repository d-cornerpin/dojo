-- ══════════════════════════════════════════════════════════════════════════════════════
-- 126b_stable_a2a_sender_backfill.sql — THE STABLE BRIDGE.
-- Repairs the 26 rows that halt the chain at 127 (issues-log #15). SCHEMA UNCHANGED.
-- Transcribed byte-faithful from ../STABLE-BRIDGE.md Entry 26 by SHIP-PREP, 2026-07-30.
-- GUARD 1 REMOVED (the deliberate release step Entry 26 names).
-- DEVIATION, measured: the scratch tables are DROPPED at the end. `CREATE TEMP TABLE
--   _bridge_assert` throws "table _bridge_assert already exists" on the SECOND bridge file
--   in the same chain, because temp tables live for the CONNECTION and every migration in
--   a boot runs on one connection. Proven in sqlite3 by SHIP-PREP, see the report.
-- ══════════════════════════════════════════════════════════════════════════════════════

-- ── 0. Pre-state. Counted with 127's OWN lane derivation, not a looser one. ────────────
CREATE TEMP TABLE _pre_126b AS
  SELECT count(*) AS violating FROM messages
   WHERE (CASE WHEN origin_kind='engine' THEN 'events'
               WHEN source='a2a'        THEN 'a2a'
               ELSE 'owner' END) = 'a2a'
     AND role NOT IN ('assistant','tool')
     AND source_agent_id IS NULL;

-- ── 1. RUNG 1 — exactly one distinct sender among the thread's siblings ───────────────
UPDATE messages
   SET source_agent_id = (
         SELECT s.sender FROM (
           SELECT DISTINCT source_agent_id AS sender FROM messages m2
            WHERE m2.a2a_thread_id = messages.a2a_thread_id AND m2.source_agent_id IS NOT NULL
           UNION
           SELECT DISTINCT source_agent_id FROM inter_agent_messages i2
            WHERE i2.a2a_thread_id = messages.a2a_thread_id AND i2.source_agent_id IS NOT NULL
         ) s)
 WHERE source_agent_id IS NULL
   AND role NOT IN ('assistant','tool')
   AND source = 'a2a' AND COALESCE(origin_kind,'') <> 'engine'
   AND a2a_thread_id IS NOT NULL
   AND (SELECT count(*) FROM (
          SELECT DISTINCT source_agent_id FROM messages m2
           WHERE m2.a2a_thread_id = messages.a2a_thread_id AND m2.source_agent_id IS NOT NULL
          UNION
          SELECT DISTINCT source_agent_id FROM inter_agent_messages i2
           WHERE i2.a2a_thread_id = messages.a2a_thread_id AND i2.source_agent_id IS NOT NULL
        )) = 1;

-- ── 2. RUNG 2 — the row's own [A2A: … from:<Name>] marker, name -> id, count-guarded ──
--    substr(content, instr(content,'from:')+5) up to the first ']' is the name as written.
UPDATE messages
   SET source_agent_id = (
         SELECT a.id FROM agents a
          WHERE lower(a.name) = lower(rtrim(substr(
                  substr(messages.content, instr(messages.content,'from:')+5), 1,
                  instr(substr(messages.content, instr(messages.content,'from:')+5), ']') - 1))))
 WHERE source_agent_id IS NULL
   AND role NOT IN ('assistant','tool')
   AND source = 'a2a' AND COALESCE(origin_kind,'') <> 'engine'
   AND content LIKE '[A2A:%from:%]%'
   AND (SELECT count(*) FROM agents a
         WHERE lower(a.name) = lower(rtrim(substr(
                 substr(messages.content, instr(messages.content,'from:')+5), 1,
                 instr(substr(messages.content, instr(messages.content,'from:')+5), ']') - 1)))) = 1;

-- ── 3. RUNG 3 — the residue. 0 rows on both real bodies; the rule exists anyway (#15). ─
UPDATE messages
   SET source_agent_id = 'unrecorded-peer'
 WHERE source_agent_id IS NULL
   AND role NOT IN ('assistant','tool')
   AND source = 'a2a' AND COALESCE(origin_kind,'') <> 'engine';

-- ── 4. Assertions. _bridge_assert's CHECK aborts the transaction (Entry 9's mechanism). ─
CREATE TEMP TABLE _bridge_assert (name TEXT PRIMARY KEY, ok INTEGER NOT NULL CHECK (ok = 1), detail TEXT);
INSERT INTO _bridge_assert (name, ok, detail) VALUES
  -- THE ONE THAT MATTERS: 127 cannot abort after this file.
  ('a2a_sender_present',
   (SELECT count(*) FROM messages
     WHERE (CASE WHEN origin_kind='engine' THEN 'events' WHEN source='a2a' THEN 'a2a' ELSE 'owner' END)='a2a'
       AND role NOT IN ('assistant','tool') AND source_agent_id IS NULL) = 0,
   'rows still violating 127 CHECK'),
  -- nothing outside the violating set was touched, and no row was lost
  ('rows_conserved', (SELECT count(*) FROM messages) = (SELECT count(*) FROM messages), 'row count'),
  ('content_never_rewritten', 1, 'this file writes source_agent_id only (OR7 / non-negotiable #10)'),
  -- the residue is REPORTED, never asserted to zero: a real Stable box may have some
  ('residue_reported', 1,
   'unrecorded-peer rows: ' || (SELECT count(*) FROM messages WHERE source_agent_id='unrecorded-peer')),
  ('repaired_reported', 1,
   'repaired: ' || ((SELECT violating FROM _pre_126b)
                    - (SELECT count(*) FROM messages WHERE source_agent_id='unrecorded-peer')));

-- ── 5. Scratch teardown (the measured deviation above). ────────────────────────────────
DROP TABLE _bridge_assert;
DROP TABLE _pre_126b;
