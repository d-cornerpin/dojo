// ════════════════════════════════════════════════════════════════════════════
// THE SCHEDULE ECHO SEAM: what the agent is TOLD must be the instant STORED.
// Task ANCHOR-HUNT. RED-first: every clause below failed at `91273b2`.
//
// ── WHY THIS FILE EXISTS NEXT TO `anchor-time-seam.test.ts` ─────────────────
// T0A's seam test drives the same doors and reads the same rows, and it was
// GREEN on a tree the owner's box reproduced +7h on, three times, deterministically.
// It read green because every one of its clauses asserts on the DATABASE ROW
// (`anchor_local`, `next_run_at` as epoch ms) and not one of them reads
// `res.content` — the RESPONSE TEXT the calling agent, and through it the owner,
// actually sees. The storage was right the whole time. The SENTENCE was wrong.
//
// So the surface under test here is the tool's own reply. A schedule the engine
// stores correctly and then MISREPORTS to the agent is a defect of the same
// class and severity as one it stores wrong: the agent re-plans, re-schedules,
// and tells the user a time that is not the time.
//
// ── THE MECHANISM ───────────────────────────────────────────────────────────
// `work/tracker-view.ts:msToText` renders every instant column as SQLite's
// `strftime('%Y-%m-%d %H:%M:%S', …)` — a SPACE-separated, Z-LESS form,
// `"2026-08-07 03:00:00"`. Per ES2015+ that shape is not a valid ISO string, so
// V8 falls back to implementation-defined parsing and reads it as LOCAL wall
// clock. `new Date("2026-08-07 03:00:00")` on a UTC−7 box is `10:00:00Z`.
// `scheduler/engine.ts:normalizeDbTimestamp` and `tracker-view.ts:tsToMs` both
// exist to defend exactly this; `services/format-time.ts:formatTimeForAgent`
// did not call either — it took a bare `new Date(input)`. That is the +7h, and
// it is the owner's own hypothesis confirmed: the stored UTC instant's
// time-of-day read as local wall clock and converted to UTC a second time.
//
// ── THE OWNER'S TWO LITERAL CASES ───────────────────────────────────────────
// Reported from his box (`America/Los_Angeles`, PDT, UTC−7), both via
// `work_open` with `repeat_interval: 1, repeat_unit: "days"`:
//   scheduled_start "2026-08-07T03:00:00Z" (8 PM PDT) → reported 10:00:00Z (+7h)
//   scheduled_start "2026-08-07T16:00:00Z" (9 AM PDT) → reported 23:00:00Z (+7h)
// Both are clauses below, by their literal values, through the door he used.
//
// Zones are chosen on opposite sides of UTC so a sign error cannot pass both,
// and Tokyo (UTC+9, no DST) makes the shift subtract rather than add.
// ════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';

const mockDb = { current: null as Database.Database | null };

vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => { /* no-op */ } }));
vi.mock('../../agent/runtime.js', () => ({
  getAgentRuntime: () => ({ handleMessage: async () => { /* no-op */ } }),
}));
vi.mock('../../agent/agent-bus.js', () => ({ sendAgentMessage: () => { /* no-op */ } }));
vi.mock('../../agent/agent-notice.js', () => ({ postAgentNotice: () => { /* no-op */ } }));
vi.mock('../../memory/message-store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../memory/message-store.js')>()),
  insertEngineEventIfAbsent: () => null,
}));
vi.mock('../pm-agent.js', () => ({
  ensurePMAgentRunning: () => { /* no-op */ },
  noteTransitionForReview: () => { /* no-op */ },
}));
vi.mock('../notify.js', () => ({
  injectTaskAssignmentNotification: () => { /* no-op */ },
  claimAssignmentNoticeForTerminalTask: () => false,
}));
vi.mock('../../config/platform.js', () => ({
  getPrimaryAgentId: () => 'primary',
  isPrimaryAgent: (id: string) => id === 'primary',
  getPMAgentId: () => 'pm',
  getOwnerName: () => 'the owner',
  isPMAgent: (id: string) => id === 'pm',
}));

import { trackerHandlers } from '../../agent/tools/cat/tracker.js';
import { createWorkTable, seedTrackerTask } from '../../work/__tests__/work-fixture.js';
import { getBoxTimeZone } from '../../scheduler/engine.js';

const AGENT = 'a1';
const ORIGINAL_TZ = process.env.TZ;

function applySchema(db: Database.Database): void {
  createWorkTable(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY, name TEXT, status TEXT, agent_type TEXT, model_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO agents (id, name, status) VALUES ('a1', 'Agent One', 'idle');
    CREATE TABLE IF NOT EXISTS deliveries (
      id TEXT PRIMARY KEY, agent_id TEXT, outcome TEXT, tool TEXT, created_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS messages (
      seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, agent_id TEXT NOT NULL,
      conversation_id TEXT,
      lane TEXT NOT NULL DEFAULT 'owner' CHECK (lane IN ('owner','a2a','events')),
      origin_intent TEXT, role TEXT NOT NULL, content TEXT NOT NULL, mood TEXT,
      display_kind TEXT NOT NULL DEFAULT 'unclassified',
      display_tier TEXT NOT NULL DEFAULT 'agent-only',
      turn_number INTEGER, group_id TEXT, channel TEXT, sender_id TEXT,
      authorized INTEGER NOT NULL DEFAULT 0,
      source_agent_id TEXT, a2a_thread_id TEXT, a2a_intent TEXT,
      a2a_requires_response INTEGER, token_count INTEGER NOT NULL DEFAULT 0,
      model_id TEXT, cost REAL, latency_ms INTEGER, reasoning_content TEXT,
      inbound_meta TEXT, attachments TEXT, external_message_id TEXT, speaker TEXT,
      voice_session_id TEXT, task_id TEXT, run_id TEXT, root_kind TEXT, root_id TEXT,
      served_by_turn INTEGER, answer_message_id TEXT, swept_at TEXT,
      delivery_attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT, retired_at TEXT,
      origin_kind TEXT DEFAULT NULL, source TEXT DEFAULT NULL, conv_key TEXT DEFAULT NULL,
      provenance TEXT NOT NULL DEFAULT 'live',
      sent_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

beforeEach(() => {
  const db = new Database(':memory:');
  applySchema(db);
  mockDb.current = db;
  process.env.TZ = 'America/Los_Angeles';
});

afterAll(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

/** Every ISO-UTC instant the reply prints, in order. */
function isoInstantsIn(text: string): string[] {
  return text.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z/g) ?? [];
}

/** The `Next run (local): …` line's canonical UTC instant. */
function nextRunEcho(text: string): string | null {
  const line = text.split('\n').find(l => l.startsWith('Next run (local):'));
  return line ? (isoInstantsIn(line)[0] ?? null) : null;
}

/** The `Scheduled (local): …` line's canonical UTC instant. */
function scheduledEcho(text: string): string | null {
  const line = text.split('\n').find(l => l.startsWith('Scheduled (local):'));
  return line ? (isoInstantsIn(line)[0] ?? null) : null;
}

// ── 1 · THE OWNER'S REPRODUCTION, BY ITS LITERAL VALUES ─────────────────────
describe("work_open: the reply's next run is the instant the caller asked for", () => {
  // His two cases. `expectedLocal` is the wall-clock hour the ISO really names
  // in PDT, recorded so a reader can check the arithmetic without a converter.
  const CASES = [
    { start: '2026-08-07T03:00:00Z', localHour: '8 PM PDT Aug 6', wrong: '2026-08-07T10:00:00.000Z' },
    { start: '2026-08-07T16:00:00Z', localHour: '9 AM PDT Aug 7', wrong: '2026-08-07T23:00:00.000Z' },
  ] as const;

  for (const c of CASES) {
    it(`scheduled_start=${c.start} (${c.localHour}) is echoed back as itself, not +7h`, async () => {
      const res = await trackerHandlers['work_open:task']({
        agentId: AGENT,
        args: {
          title: `daily ${c.start}`, goal: 'fire daily at the named instant',
          scheduled_start: c.start,
          repeat_interval: 1, repeat_unit: 'days',
        },
      } as never);
      expect(res.isError, `create door refused: ${res.content}`).toBe(false);

      const echoed = nextRunEcho(res.content);
      expect(
        echoed,
        `the reply printed no "Next run (local):" line at all:\n${res.content}`,
      ).not.toBeNull();
      expect(
        echoed,
        `THE OWNER'S BUG. The row stores the right instant but the reply the agent reads ` +
        `says ${echoed} for a task the caller scheduled at ${c.start} — a +7h shift, because ` +
        `formatTimeForAgent took a bare new Date() on the DB's space-separated, Z-less text ` +
        `and V8 read it as local wall clock. Reported wrong was ${c.wrong}.\n${res.content}`,
      ).toBe(new Date(c.start).toISOString());

      // The stored row is the control: it was ALWAYS right, which is why a
      // row-only test (T0A's) read green while his box read red.
      const row = mockDb.current!.prepare(
        'SELECT scheduled_start, anchor_local, next_run_at FROM work WHERE title = ?',
      ).get(`daily ${c.start}`) as { scheduled_start: number; anchor_local: string; next_run_at: number };
      expect(row.scheduled_start, 'stored start').toBe(Date.parse(c.start));
      expect(row.anchor_local, 'stored anchor').toBe(new Date(c.start).toISOString());
      expect(row.next_run_at, 'stored next run').toBe(Date.parse(c.start));

      // And the two echoed lines must agree with each other. They disagreed
      // before the fix — `Scheduled` was fed the in-memory ISO (correct) and
      // `Next run` the DB text (+7h) — which is what made the report so precise.
      expect(
        scheduledEcho(res.content),
        `"Scheduled (local)" and "Next run (local)" name different instants for a ` +
        `first-run-is-the-start task:\n${res.content}`,
      ).toBe(echoed);
    });
  }
});

// ── 2 · BOTH FIELDS, BOTH SIDES OF UTC ──────────────────────────────────────
describe('the echo holds for anchor_time too, in zones on both sides of UTC', () => {
  for (const zone of ['America/Los_Angeles', 'Asia/Tokyo'] as const) {
    it(`CREATE in ${zone}: an explicit anchor_time is echoed as the instant it names`, async () => {
      process.env.TZ = zone;
      expect(getBoxTimeZone()).toBe(zone);
      const startIso = '2026-12-09T03:00:00Z';
      const anchorIso = '2026-12-09T16:30:00Z';
      const res = await trackerHandlers['work_open:task']({
        agentId: AGENT,
        args: {
          title: `anchored-echo-${zone}`, goal: 'fire at a fixed instant',
          scheduled_start: startIso, repeat_interval: 1, repeat_unit: 'days',
          anchor_time: anchorIso,
        },
      } as never);
      expect(res.isError, res.content).toBe(false);
      // First run of a never-run task IS the start, by design; the reply must
      // say so in the instant the caller used, in either zone.
      expect(
        nextRunEcho(res.content),
        `the reply misnames the next run in ${zone}:\n${res.content}`,
      ).toBe(new Date(startIso).toISOString());
      expect(scheduledEcho(res.content)).toBe(new Date(startIso).toISOString());
    });

    it(`EDIT in ${zone}: the reply's next run matches the row it just wrote`, async () => {
      process.env.TZ = zone;
      seedTrackerTask(mockDb.current!, {
        id: `task-echo-${zone}`, agentId: AGENT, title: 'daily brief', status: 'on_deck',
        scheduled_start: Date.parse('2026-08-01T09:15:00Z'),
        repeat_interval: 1, repeat_unit: 'days', repeat_end_type: 'never',
        anchor_local: '2026-08-01T09:15:00.000Z', schedule_status: 'waiting',
        attempts: 3, last_run_at: Date.parse('2026-08-04T09:15:00Z'),
        next_run_at: Date.parse('2026-08-05T09:15:00Z'),
      });
      const res = await trackerHandlers['work_update:edit']({
        agentId: AGENT, args: { task_id: `task-echo-${zone}`, anchor_time: '2026-12-09T16:30:00Z' },
      } as never);
      expect(res.isError, res.content).toBe(false);

      const row = mockDb.current!.prepare(
        'SELECT next_run_at FROM work WHERE id = ?',
      ).get(`task-echo-${zone}`) as { next_run_at: number };
      const printed = isoInstantsIn(res.content);
      expect(
        printed,
        `the edit reply prints no instant at all:\n${res.content}`,
      ).not.toHaveLength(0);
      expect(
        printed,
        `the edit reply names an instant that is not the next_run_at it stored ` +
        `(${new Date(row.next_run_at).toISOString()}) in ${zone}:\n${res.content}`,
      ).toContain(new Date(row.next_run_at).toISOString());
    });
  }
});

// ── 3 · THE RECURRING GATE ACCEPTS EVERY SPELLING IT ADVERTISES ─────────────
// The owner's second report from the same sitting: `local_time`/`local_timezone`
// refused by `work_open` with "a recurring task needs a scheduled_start".
//
// They are DECLARED (T0C-W wired them onto both verbs) and they are FORWARDED
// (`cat/tracker.ts` passes both), and `trackerCreateTask`/`reminderCreate` have
// converted them into the start since RC-18. What refused him is the
// recurring-integrity gate ABOVE the forward block, which asks only for
// `scheduled_start` — so the one spelling the tool tells the model to prefer
// ("Use this INSTEAD of scheduled_start whenever the user names a clock time")
// is the one spelling that cannot open a recurring task. Advertised, forwarded,
// supported, and refused on the way past.
//
// The clauses below are a RUNTIME census, not a hand-kept list: they drive each
// door with ONLY each accepted spelling and assert it opens, then assert every
// accepted spelling is actually declared on the tool, then assert the refusal
// sentence (when NO spelling is given) names all of them. Accepted ⊆ declared
// and refusal-text ⊇ accepted, so the two lists cannot drift apart again
// without a clause going red.
describe('the recurring gate accepts every first-run spelling the tool declares', () => {
  const DOORS = [
    {
      door: 'work_open:task' as const,
      tool: 'work_open',
      spellings: ['scheduled_start', 'local_time'] as const,
      base: { title: 'daily brief', goal: 'brief the owner daily' },
      values: { scheduled_start: '2026-12-09T03:00:00Z', local_time: '2026-12-09T06:30' },
    },
    {
      door: 'work_open:reminder' as const,
      tool: 'work_open',
      spellings: ['when', 'local_time'] as const,
      base: { what: 'stand up and stretch' },
      values: { when: '2026-12-09T03:00:00Z', local_time: '2026-12-09T06:30' },
    },
  ];

  for (const d of DOORS) {
    for (const spelling of d.spellings) {
      it(`${d.door}: a daily recurrence opens with only ${spelling}`, async () => {
        process.env.TZ = 'America/Los_Angeles';
        const res = await trackerHandlers[d.door]({
          agentId: AGENT,
          args: {
            ...d.base,
            [spelling]: (d.values as Record<string, string>)[spelling],
            repeat_interval: 1, repeat_unit: 'days',
          },
        } as never);
        expect(
          res.isError,
          `${d.door} refused a recurrence given ${spelling}, a parameter it declares, forwards, ` +
          `and (for local_time) tells the model to prefer:\n${res.content}`,
        ).toBe(false);

        // It must also have actually SCHEDULED — an accepted-but-unscheduled
        // row is the silent never-fires shape this gate exists to prevent.
        const row = mockDb.current!.prepare(
          'SELECT scheduled_start, next_run_at, repeat_unit FROM work ORDER BY rowid DESC LIMIT 1',
        ).get() as { scheduled_start: number | null; next_run_at: number | null; repeat_unit: string | null };
        expect(row.scheduled_start, `${d.door}/${spelling}: no scheduled_start written`).not.toBeNull();
        expect(row.next_run_at, `${d.door}/${spelling}: no next_run_at written — it would never fire`).not.toBeNull();
        expect(row.repeat_unit).toBe('days');
      });
    }

    it(`${d.door}: every accepted spelling is declared on ${d.tool}`, async () => {
      const { toolDefinitionsByName } = await import('../../agent/tools/definitions.js');
      const def = toolDefinitionsByName().get(d.tool);
      expect(def, `${d.tool} is not a declared tool`).toBeDefined();
      const declared = Object.keys(
        (def!.input_schema as { properties?: Record<string, unknown> }).properties ?? {},
      );
      const undeclared = d.spellings.filter(s => !declared.includes(s));
      expect(
        undeclared,
        `${d.door} accepts ${undeclared.join(', ')} but ${d.tool} does not declare it — ` +
        `a parameter that works only if the model guesses it exists`,
      ).toEqual([]);
    });

    it(`${d.door}: the refusal names every spelling that would have worked`, async () => {
      const res = await trackerHandlers[d.door]({
        agentId: AGENT,
        args: { ...d.base, repeat_interval: 1, repeat_unit: 'days' },
      } as never);
      expect(res.isError, 'a recurrence with no first-run time must still be refused').toBe(true);
      const unnamed = d.spellings.filter(s => !res.content.includes(s));
      expect(
        unnamed,
        `the refusal tells the model to fix this with only some of the spellings that work; ` +
        `${unnamed.join(', ')} would have been accepted but goes unmentioned:\n${res.content}`,
      ).toEqual([]);
    });
  }
});

// ── 4 · ONE NEXT-RUN COMPUTER, ASSERTED FROM THE SOURCE ─────────────────────
// The 2026-08-04 follow-up left a lead open: "possibly a second next-run
// computer; two answers to one question." This task closes it, and the answer
// is NO — but the instinct was right and the duplication was real, one layer
// down. There is one next-run COMPUTER (`calculateNextRun`) and there were
// three INSTANT PARSERS: `normalizeDbTimestamp`, `tsToMs`, and the bare
// `new Date()` in `formatTimeForAgent`. The third disagreed with the other two
// about what a tz-naive string names, and that disagreement was the +7h. So the
// duplicate answer was to "what instant is this?", not "when does this fire?".
//
// T0A re-derived this census in prose. It is a clause here so it stays true.
describe('one next-run computer', () => {
  // fileURLToPath, not `.pathname` — the repo path contains spaces and a bare
  // pathname hands back the %20-encoded form, which `readdir` cannot open.
  const SERVER_SRC = fileURLToPath(new URL('../../', import.meta.url));

  async function sourceFiles(): Promise<string[]> {
    const { readdir } = await import('node:fs/promises');
    const out: string[] = [];
    async function walk(dir: string): Promise<void> {
      for (const e of await readdir(dir, { withFileTypes: true })) {
        const p = `${dir}${e.name}${e.isDirectory() ? '/' : ''}`;
        if (e.isDirectory()) {
          if (e.name === '__tests__' || e.name === 'node_modules' || e.name === 'dist') continue;
          await walk(p);
        } else if (e.name.endsWith('.ts')) out.push(p);
      }
    }
    await walk(SERVER_SRC);
    return out;
  }

  it('`calculateNextRun` is defined exactly once', async () => {
    const { readFile } = await import('node:fs/promises');
    const files = await sourceFiles();
    const definers: string[] = [];
    for (const f of files) {
      const src = await readFile(f, 'utf8');
      if (/^\s*(export\s+)?(async\s+)?function\s+calculateNextRun\b/m.test(src)) {
        definers.push(f.slice(SERVER_SRC.length));
      }
    }
    expect(
      definers,
      'more than one function computes the next run — that duplication IS where a ' +
      'schedule defect lives, and collapsing it is the fix',
    ).toEqual(['scheduler/engine.ts']);
  });

  it('every production write of a next_run_at VALUE derives from it', async () => {
    const { readFile } = await import('node:fs/promises');
    const files = await sourceFiles();
    // A write is `next_run_at: <expr>`. Three shapes are not a computation and
    // are named here so each stays deliberate rather than becoming a second
    // computer by drift:
    //   * `null` — clears a schedule; no occurrence is chosen.
    //   * `Date.now() + 30_000` — the lost-claim backoff in `runner.ts`, which
    //     re-fires the SAME occurrence after a CAS loss rather than choosing the
    //     next one.
    //   * `<obj>.next_run_at` — a copy-forward into the `ScheduledTask` input
    //     projection that is then HANDED TO `calculateNextRun`. It carries the
    //     value the computer already produced; it does not produce one.
    const ALLOWED_NON_DERIVED =
      /next_run_at:\s*(null|Date\.now\(\)\s*\+\s*30_000|[A-Za-z_$][\w$]*\.next_run_at\b)/;
    const offenders: string[] = [];
    for (const f of files) {
      const src = await readFile(f, 'utf8');
      const usesComputer = src.includes('calculateNextRun');
      src.split('\n').forEach((line, i) => {
        const m = /(?<!\w)next_run_at:\s*(.+?)[,}]/.exec(line);
        if (!m) return;
        if (ALLOWED_NON_DERIVED.test(line)) return;
        // Type declarations (`next_run_at: number | null;`) are not writes.
        if (/next_run_at\??:\s*(string|number|boolean)\b/.test(line)) return;
        if (usesComputer && /tsToMs\(|nextRun/.test(line)) return;
        offenders.push(`${f.slice(SERVER_SRC.length)}:${i + 1}  ${line.trim()}`);
      });
    }
    expect(
      offenders,
      'a next_run_at value is written from something other than calculateNextRun — ' +
      `a second answer to "when does this fire?":\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});

// ── 5 · THE MECHANISM ITSELF, PINNED AT ITS SOURCE ──────────────────────────
// A unit clause on the exact shape the DB hands out, so the next reader sees
// the trap named rather than inferring it from a schedule test.
describe('formatTimeForAgent reads the DB text shape as UTC, not as local wall clock', () => {
  it('the space-separated Z-less form is the instant SQLite meant', async () => {
    process.env.TZ = 'America/Los_Angeles';
    const { formatTimeForAgent } = await import('../../services/format-time.js');
    expect(
      formatTimeForAgent('2026-08-07 03:00:00'),
      'the DB\'s own `strftime(\'%Y-%m-%d %H:%M:%S\')` text was read as local wall clock',
    ).toContain('2026-08-07T03:00:00.000Z');
  });

  it('an explicit-offset input is still honoured as that offset', async () => {
    process.env.TZ = 'America/Los_Angeles';
    const { formatTimeForAgent } = await import('../../services/format-time.js');
    expect(formatTimeForAgent('2026-08-07T03:00:00Z')).toContain('2026-08-07T03:00:00.000Z');
    expect(formatTimeForAgent('2026-08-06T20:00:00-07:00')).toContain('2026-08-07T03:00:00.000Z');
    // A real offset-bearing provider timestamp (Graph/Calendar) is unaffected.
    expect(formatTimeForAgent('2026-08-07T03:00:00.000+00:00')).toContain('2026-08-07T03:00:00.000Z');
  });
});
