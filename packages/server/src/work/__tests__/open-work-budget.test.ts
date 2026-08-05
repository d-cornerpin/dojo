// ════════════════════════════════════════════════════════════════════════════════════════
// WHAT THE OPEN WORK BUDGET IS ALLOWED TO DROP — SWEEP-A TB4 (JOB 2).
//
// THE DEFECT, MEASURED BEFORE IT WAS FIXED. Full battery `bmsgc3l0cnb` took
// `promise-survives-the-turn` from GREEN to 1-of-3. On the two failing attempts the platform
// DID record the promise (a real `cmt:` row, bound to that attempt's own inbound, outcome
// RECORDED) and the model still never saw it on turn 2 — the scenario's own words: *"turn 2
// carried the promise id only as the turn-1 tool_result ECHO — the OPEN WORK block did not put
// it in front of the model"*. The battery reported one co-variate without a causal claim: the
// open queue grew across attempts, and the attempt that passed was the one with the smallest
// queue.
//
// THE CAUSE, and it is one line of arithmetic. `buildOpenWorkInjection` renders the current
// conversation's obligations in `opened_at ASC` (`store.ts:openObligations`) and fills a
// 600-character budget with a `break`: the FIRST line that does not fit ends the loop and every
// remaining line is replaced by a bare `…`. A commitment made during the turn that is running
// has the LARGEST `opened_at` of anything in its conversation, so it always sorts LAST and is
// always the FIRST thing the budget discards. The block whose entire purpose is to carry an
// obligation into the next turn was structurally guaranteed to drop the freshest one.
//
// That inverts the budget's own stated reason ("a character budget so a backlog cannot eat the
// volatile lane on a floor model" — `obligations.ts` header): the backlog was eating the block.
//
// THE THREE FIXTURES BELOW ARE THE RUN, NOT AN ANALOGY. Every id, title length and timestamp
// is transcribed from `~/.dojo/data/dojo.db` for agent `57b52025…` (BehaviorBot), reconstructed
// at each attempt's turn-2 instant (`opened_at <= T`, `closed_at IS NULL OR closed_at > T`):
//
//   attempt 1  turn 2 at 1785953406000 — the promise is the 3rd current-conversation row  PASS
//   attempt 2  turn 2 at 1785953487000 — the promise is the 4th                           FAIL
//   attempt 3  turn 2 at 1785953608000 — the promise is the 5th                           FAIL
//
// The queue grew because each attempt's own promise stayed open behind the next one. The
// battery's PASS/FAIL/FAIL is reproduced here with no server, no model and no clock.
//
// WHAT THE BOUND SHOULD DO, and what is deliberately NOT changed. The budget stays 600
// characters and the cross-conversation overflow stays 3 rows: no threshold is invented, the
// volatile lane does not grow, and the block still rides the TAIL past the cached prefix
// (`pre-call-injections.ts`, lane `engine.open-work` inside the protected `lane.loop-tail`), so
// there is no prompt-prefix impact and both golden reference files stay byte-identical. What
// changes is WHICH rows a bound budget keeps and whether an elision is allowed to be silent:
//   · when the budget binds, the LIVE rows are kept and the oldest give way — an obligation
//     older than the ageing horizon already has its own surface (`buildAgedWorkBriefSection`,
//     requirement 4b: ageing demotes, it never closes), while the row the running turn just
//     created has no other way into the next turn;
//   · an elision now SAYS HOW MANY it dropped. A bare `…` told the model nothing; a count is
//     the difference between "there is more" and a silent loss, and it is the same honesty rule
//     the rest of this spine is built on.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };

vi.mock('../../db/connection.js', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => path.join(os.tmpdir(), 'dojo-open-work-budget-test', 'dojo.db'),
  };
});

import { runMigrations } from '../../db/migrations.js';
import { buildOpenWorkInjection } from '../obligations.js';

const AGENT = '57b52025-0b0f-40a6-b916-9efdb9a642a3';
const CUR = '616f857b-2026-44f3-b64e-943032f913ec';

/** The eight cross-conversation rows the box carried through the whole run — id, conversation,
 *  `opened_at` and title VERBATIM from `~/.dojo/data/dojo.db`: five channel-inbound asks with
 *  long `[SOURCE: …]` titles and three of TB3 §8.2's structurally unservable rows whose title IS
 *  an ask id. They are the "routed-away debris" half of the question, and they are here so the
 *  measurement can tell crowding apart from selection. */
const OTHER_ROWS: Array<[string, string, number, string]> = [
  ['ask:83ab7e8f-5121-445a-9c55-512b00e79662', 'conv-email-1', 1785386152000, '[SOURCE: GMAIL NOTIFICATION — agent inbox]\n\nFrom notifications@example.com, subject: Scheduled maintenance tonight:\nHead'],
  ['ask:7988084f-1eb5-4e31-b15a-e33cdfe7e81d', 'conv-imsg-1', 1785387138000, '[SOURCE: IMESSAGE FROM behav-mt-bms70kfw2e8]\n\nplease remember my gate codeword: FALCON-W2E8. just confirm you have it.'],
  ['ask:91825175-92e5-4b4d-a6ae-bc202cc8be15', 'conv-imsg-1', 1785387149000, '[SOURCE: IMESSAGE FROM behav-mt-bms70kfw2e8]\n\nquick follow-up: what is the codeword I gave you a moment ago? reply with '],
  ['ask:9734679f-f545-4744-b70d-52a5f82daaaf', 'conv-imsg-1', 1785387161000, '[SOURCE: IMESSAGE FROM behav-mt-bms70kfw2e8]\n\nthanks, one more: what is 58 + 17? just the number.'],
  ['ask:3647deac-ed53-4658-8496-3eb8326a7e06', 'conv-email-2', 1785573965000, '[SOURCE: GMAIL NOTIFICATION — agent inbox]\n\nFrom notifications@example.com, subject: Scheduled maintenance tonight:\nHead'],
  ['ask:69f636ec-bf09-4fe4-a4af-2451bb70b516', 'conv-imsg-2', 1785909452000, 'ask:69f636ec-bf09-4fe4-a4af-2451bb70b516'],
  ['ask:f49ae4ea-8598-451a-8056-450e2b50556e', 'conv-imsg-2', 1785950511000, 'ask:f49ae4ea-8598-451a-8056-450e2b50556e'],
  ['ask:5ced5eb2-eb77-4a65-a2b2-6fd751fc98aa', 'conv-imsg-3', 1785950539000, 'ask:5ced5eb2-eb77-4a65-a2b2-6fd751fc98aa'],
];

function seedConversation(id: string, channel = 'dashboard', counterparty = 'owner'): void {
  mockDb.current!.prepare(
    `INSERT OR IGNORE INTO conversations (id, agent_id, channel, counterparty_id, created_at)
     VALUES (?, ?, ?, ?, datetime('now'))`,
  ).run(id, AGENT, channel, counterparty);
}

function seedRow(id: string, kind: 'ask' | 'commitment', conv: string, openedAt: number, title: string): void {
  mockDb.current!.prepare(`
    INSERT INTO work (id, kind, agent_id, requester, requester_id, conversation_id,
                      root_kind, root_id, state, intent, wakes, closes_thread,
                      title, opened_at, updated_at, provenance)
    VALUES (?, ?, ?, 'owner', 'owner', ?, 'message', ?, 'open', ?, 1, 0, ?, ?, ?, 'live')
  `).run(id, kind, AGENT, conv, `root-${id}`, kind === 'ask' ? 'ask' : 'commitment', title, openedAt, openedAt);
}

/** The run's clock, shifted so the 7-day ageing cutoff behaves as it did on the day. */
const RUN_NOW = 1785953700000;
const shift = (ms: number): number => ms + (Date.now() - RUN_NOW);

beforeEach(() => {
  mockDb.current?.close();
  mockDb.current = new Database(':memory:');
  runMigrations();
  mockDb.current.prepare(
    `INSERT INTO agents (id, name, status, session_started_at) VALUES (?, 'BehaviorBot', 'idle', '1970-01-01')`,
  ).run(AGENT);
  seedConversation(CUR);
  seedConversation('conv-other');
  seedConversation('conv-email-1', 'email', 'notifications@example.com');
  seedConversation('conv-email-2', 'email', 'notifications@example.com');
  seedConversation('conv-imsg-1', 'imessage', 'behav-mt-bms70kfw2e8');
  seedConversation('conv-imsg-2', 'imessage', '+15559990001');
  seedConversation('conv-imsg-3', 'imessage', '+15559990042');
  for (const [id, conv, at, title] of OTHER_ROWS) seedRow(id, 'ask', conv, shift(at), title);
  seedCurrentBaseline();
});

/** The two long-lived current-conversation asks, open on the box throughout the battery. */
function seedCurrentBaseline(): void {
  seedRow('ask:fe6a7915-1cce-426f-9511-29527f2a017a', 'ask', CUR, shift(1785614591000), 'What time is it right now?');
  seedRow('ask:e759da4e-4cd6-4886-b094-c042c34ba6c2', 'ask', CUR, shift(1785614609000), 'What time is it right now?');
}

/** Each attempt's own current-conversation rows, in `opened_at` order, ending with the row the
 *  turn just made. Returns the promise id the block must name on turn 2. */
function seedAttempt(n: 1 | 2 | 3): string {
  seedRow('cmt:44165afe35b9', 'commitment', CUR, shift(1785953397996),
    "Email the roof quote to Bob (promise-bmsgc3l0cnb) once he sends his address. Waiting on Bob's address before proceeding.");
  if (n === 1) {
    seedRow('ask:e33a5932-e9ca-41ff-aa34-77d04f7906c8', 'ask', CUR, shift(1785953405000), 'Request for simple multiplication result');
    return 'cmt:44165afe35b9';
  }
  seedRow('cmt:7c973d5e06f7', 'commitment', CUR, shift(1785953475419),
    "Email the boiler invoice to Bob (promise-bmsgc3l0cnb) once he sends his address. Waiting on Bob's address before proceeding.");
  if (n === 2) {
    seedRow('ask:566e092b-9f99-41e3-b29c-a81d07c67023', 'ask', CUR, shift(1785953486000), 'Provide result of simple multiplication');
    return 'cmt:7c973d5e06f7';
  }
  seedRow('cmt:ef742a1a774f', 'commitment', CUR, shift(1785953600565),
    "Email the fence estimate to Bob (promise-bmsgc3l0cnb) once he sends his address. Waiting on Bob's address before proceeding.");
  seedRow('ask:45b71cc2-e39b-4bf3-98da-32813f0359e3', 'ask', CUR, shift(1785953607000), 'Calculate product of two numbers');
  return 'cmt:ef742a1a774f';
}

const namesPromise = (block: string | null, id: string): boolean =>
  block != null && block.includes(`[${id}] you promised:`);

describe('the OPEN WORK budget never silently drops the obligation the turn just made', () => {
  it('THE BATTERY, REPLAYED: all three attempts carry the promise into turn 2', () => {
    // `bmsgc3l0cnb` scored PASS / FAIL / FAIL on exactly these three shapes. The scenario asks
    // one question — is the promise in the block the model was handed — and the answer must be
    // yes on all three, because the platform RECORDED all three.
    const verdicts = ([1, 2, 3] as const).map((n) => {
      mockDb.current!.prepare(`DELETE FROM work WHERE kind IN ('ask','commitment') AND conversation_id = ?`).run(CUR);
      seedCurrentBaseline();
      const id = seedAttempt(n);
      return { n, id, shown: namesPromise(buildOpenWorkInjection(AGENT, CUR), id) };
    });
    expect(verdicts.map((v) => `att${v.n}=${v.shown}`)).toEqual(['att1=true', 'att2=true', 'att3=true']);
  });

  it('the freshest current-conversation obligation survives a queue of any size', () => {
    // The generalisation of the same fact: crowding may cost the block its OLDEST lines, never
    // the line the running turn just created. Forty long rows is far past any budget.
    for (let i = 0; i < 40; i++) {
      seedRow(`ask:crowd-${i}`, 'ask', CUR, shift(1785900000000 + i * 1000),
        `a deliberately long inbound title number ${i} that exists to push this block past its character budget`);
    }
    seedRow('cmt:freshest', 'commitment', CUR, shift(1785953690000),
      'Send David the quarterly summary on Friday, and confirm when it has gone out');
    expect(namesPromise(buildOpenWorkInjection(AGENT, CUR), 'cmt:freshest')).toBe(true);
  });

  it('an elision is never silent — it says how many rows it did not show', () => {
    for (let i = 0; i < 40; i++) {
      seedRow(`ask:crowd-${i}`, 'ask', CUR, shift(1785900000000 + i * 1000),
        `a deliberately long inbound title number ${i} that exists to push this block past its character budget`);
    }
    const block = buildOpenWorkInjection(AGENT, CUR)!;
    expect(block).toMatch(/… and \d+ more open items not shown/);
    // NEGATIVE CONTROL: a block that fits announces no elision at all.
    mockDb.current!.prepare(`DELETE FROM work`).run();
    seedCurrentBaseline();
    expect(buildOpenWorkInjection(AGENT, CUR)!).not.toMatch(/not shown/);
  });

  it('THE BUDGET IS NOT WIDENED: the block stays inside its 600-character bound', () => {
    for (let i = 0; i < 40; i++) {
      seedRow(`ask:crowd-${i}`, 'ask', CUR, shift(1785900000000 + i * 1000),
        `a deliberately long inbound title number ${i} that exists to push this block past its character budget`);
    }
    const block = buildOpenWorkInjection(AGENT, CUR)!;
    // 600 for the lines themselves, plus the one elision line the budget does not have to pay
    // for — the same allowance the pre-change bare `…` had.
    expect(block.length).toBeLessThanOrEqual(700);
  });

  it('NEGATIVE CONTROL: crowding in OTHER conversations was never the cause', () => {
    // The battery flagged 19 structurally unservable open rows (TB3 §8.2) as a co-variate. They
    // live in other conversations, and the cross-conversation bucket is capped at 3 and rendered
    // AFTER the current conversation — so they could not, and did not, push the promise out.
    // This clause is what tells "crowded by routed-away debris" apart from "the selection is
    // wrong", and it PASSED at the broken HEAD too: naming it keeps the wrong cause from being
    // adopted later.
    for (let i = 0; i < 30; i++) {
      seedRow(`ask:debris-${i}`, 'ask', 'conv-other', shift(1785900000000 + i * 1000),
        `[SOURCE: IMESSAGE FROM a-stranger]\n\nan unservable row number ${i} that nobody can answer any more`);
    }
    seedRow('cmt:freshest', 'commitment', CUR, shift(1785953690000), 'Send David the quarterly summary on Friday');
    expect(namesPromise(buildOpenWorkInjection(AGENT, CUR), 'cmt:freshest')).toBe(true);
  });

  it('NEGATIVE CONTROL: the cross-conversation overflow is still capped at three', () => {
    for (let i = 0; i < 12; i++) {
      seedRow(`ask:many-${i}`, 'ask', 'conv-other', shift(1785952000000 + i * 1000), `other item ${i}`);
    }
    const block = buildOpenWorkInjection(AGENT, CUR)!;
    expect((block.match(/\[other conversation\]/g) ?? []).length).toBeLessThanOrEqual(3);
  });

  it('NEGATIVE CONTROL: the current conversation is still rendered before the others', () => {
    mockDb.current!.prepare(`DELETE FROM work`).run();
    seedRow('cmt:mine', 'commitment', CUR, shift(1785953690000), 'this conversation item');
    seedRow('ask:theirs', 'ask', 'conv-other', shift(1785953691000), 'other conversation item');
    const block = buildOpenWorkInjection(AGENT, CUR)!;
    expect(block.indexOf('this conversation item')).toBeLessThan(block.indexOf('other conversation item'));
  });

  it('NEGATIVE CONTROL: another agent’s obligations never enter this block', () => {
    mockDb.current!.prepare(
      `INSERT INTO agents (id, name, status, session_started_at) VALUES ('someone-else', 'Other', 'idle', '1970-01-01')`,
    ).run();
    mockDb.current!.prepare(`
      INSERT INTO work (id, kind, agent_id, requester, requester_id, conversation_id, root_kind, root_id,
                        state, intent, wakes, closes_thread, title, opened_at, updated_at, provenance)
      VALUES ('cmt:not-mine', 'commitment', 'someone-else', 'owner', 'owner', ?, 'message', 'r', 'open',
              'commitment', 1, 0, 'not this agents problem', ?, ?, 'live')
    `).run(CUR, shift(1785953690000), shift(1785953690000));
    expect(buildOpenWorkInjection(AGENT, CUR)!).not.toContain('not this agents problem');
  });
});
