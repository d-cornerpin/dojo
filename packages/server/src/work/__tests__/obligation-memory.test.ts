// ════════════════════════════════════════════════════════════════════════════════════════
// UX-REPAIR ROUND 3 T17 — NO PARALLEL MEMORY OF OBLIGATIONS.
//
// EVERY CLAUSE IN §2, §3 AND §4 FAILS AT THIS TASK'S BASE COMMIT `8b0a465`, and they fail
// for one reason: the vault and the commitment spine were structurally disjoint. Not one of
// a commitment's lifecycle exits touched `vault_entries`, no join between the two existed in
// either direction, and the recall lane rendered a vault hit as a bare present-tense
// sentence with no state, no age and no validity signal.
//
// THE LIVE BODY THIS REPLAYS (round-3 investigation, measured on the worn-in dev box):
// three vault entries — roof / fence / boiler — each "Commitment: email … to Bob
// (promise-…) once he sends his address. Waiting on Bob's address before proceeding.",
// `is_obsolete 0`, `confidence 1.0`, `retrieval_count` 1560 / 714 / 346, every one of them
// resolving to `cmt:` rows that are ALL `abandoned`. Every vault-hygiene arm is gated on
// `retrieval_count = 0`, so being recalled was exactly what kept them alive.
//
// §1 is the FALSE-POSITIVE GUARD for the writer refusal, and it is the reason the writer
// guard was allowed to be enabled at all: it carries the whole live vault corpus of the dev
// box (25 non-obsolete entries, verbatim) and asserts the classifier refuses the three
// commitment lines and NOTHING else. It is a corpus test on purpose — an allowlist of
// shapes a note is permitted to have would be the prose-keyed detector this project bans.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };

vi.mock('../../db/connection.js', async () => {
  const os = await import('node:os');
  const p = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => p.join(os.tmpdir(), 'dojo-obligation-memory-test', 'dojo.db'),
  };
});

import { runMigrations } from '../../db/migrations.js';
import {
  obligationShape, obligationTags, obligationVerdict, retireObligationMemory,
} from '../obligation-memory.js';
import { renderRecallLane, type RecallLaneContext } from '../../memory/recall-lane.js';
import { dismissCommitment, transition } from '../store.js';
import { executeVaultRemember } from '../../vault/tools.js';

const AGENT = 't17-agent';

let seq = 0;

function seedCommitment(p: { id: string; title: string; state: string; agentId?: string }): void {
  const db = mockDb.current!;
  const terminal = ['done', 'failed', 'abandoned'].includes(p.state);
  const at = Date.now();
  db.prepare(
    `INSERT INTO work (id, kind, agent_id, requester, requester_id, root_kind, root_id,
                       state, intent, wakes, closes_thread, title, opened_at, updated_at,
                       closed_at, provenance)
     VALUES (?, 'commitment', ?, 'agent', ?, 'commitment', ?, ?, 'commitment', 0, 0, ?, ?, ?, ?, 'live')`,
  ).run(p.id, p.agentId ?? AGENT, p.agentId ?? AGENT, `turn:${++seq}`, p.state, p.title, at, at,
    terminal ? at : null);
}

function seedVault(p: { id: string; content: string; type?: string; agentId?: string }): void {
  mockDb.current!.prepare(
    `INSERT INTO vault_entries (id, agent_id, type, content, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'agent', datetime('now'), datetime('now'))`,
  ).run(p.id, p.agentId ?? AGENT, p.type ?? 'note', p.content);
}

const isObsolete = (id: string): number =>
  (mockDb.current!.prepare('SELECT is_obsolete AS o FROM vault_entries WHERE id = ?')
    .get(id) as { o: number }).o;

function laneWith(hits: Array<{ id: string; type: string; content: string }>): string {
  const ctx: RecallLaneContext = {
    agentId: AGENT,
    includeVault: true,
    excludeIds: new Set<string>(),
    msgHits: [],
    vaultHits: hits,
    alreadyAnsweredAskIds: new Set<string>(),
  };
  const r = renderRecallLane(ctx);
  return (r?.messages?.[0]?.content as string | undefined) ?? '';
}

beforeEach(() => {
  const db = new Database(':memory:');
  mockDb.current = db;
  runMigrations();
  db.prepare(
    `INSERT INTO agents (id, name, status, session_started_at)
     VALUES (?, ?, 'idle', '1970-01-01')`,
  ).run(AGENT, AGENT);
  seq = 0;
});

// The three lines from the live body, verbatim, with their real ids and tags.
const BOB_ROOF = '[2026-08-01] Commitment: email the roof quote to Bob (promise-bmsbcibqqem) once he sends his address. Waiting on Bob\'s address before proceeding.';
const BOB_FENCE = '[2026-08-05] Commitment: email the fence estimate to Bob (promise-bmsggcuttdo) once he sends his address. Waiting on Bob\'s address before proceeding.';
const BOB_BOILER = '[2026-08-06] Commitment: email the boiler invoice to Bob (promise-bmsh708xse7) once he sends his address. Waiting on Bob\'s address before proceeding.';

/** Every non-obsolete vault entry on the dev box at 2026-08-10, verbatim. The three
 *  commitment lines above are the only ones that may be refused. */
const LIVE_CORPUS_NON_OBLIGATION = [
  'orbit biscuit driox4',
  'orbit biscuit xw184i',
  '[2026-07-28] Morning walks boost mental clarity and reduce stress throughout the day.',
  'orbit biscuit kfw2e8',
  'orbit biscuit 3ttlh3',
  'orbit biscuit g6iega',
  '[2026-08-05] t14-calm arm2: piece delivered by Kevin, codeword CALM-ARM2.',
  'Remember this exact phrase : "orbit biscuit 439cdv"',
  '[2026-08-05] Codeword piece one (from TB5Worker-tb59yg6z, thread 25e47f29, received Aug 5 2026): TB5WORD-TB59YG6Z',
  '[2026-08-06] Codeword ECHO-XSE7-33 delivered by Kevin (re-send) thread a2a00afd (closed, no reply).',
  '[2026-08-06] orbit biscuit idpw8d',
  'Remember this exact phrase : "orbit biscuit zth1yw"',
  '[2026-08-06] Remember this exact phrase : "orbit biscuit u5ygd5"',
  '[2026-08-06] Solar-battery 4e520793: summary delivered David chat 14:56 UTC (74681ab2); fd35e92d/2028bb17/b3bd894a auto-closed, retries Task not found.',
  '[2026-08-06] For your records: my beekeeping club membership number is BEE-YGD5-42.',
  'Remember this exact phrase : "orbit biscuit wf6qe5"',
  '[2026-08-09] David\'s beekeeping club membership number is BEE-VNAD-42.',
  '[2026-08-09] David\'s locker code at the north gym is GYM-O1VNAD-DC2.',
  '[2026-08-10] T7 status probe ran on Aug 9, 2026 (logged per David\'s request via BehaviorBot\'s task "Log T7 status probe").',
  '[2026-08-10] Asana brief (Kevin 8/10, thr 49ca907e): Free=2-user cap; Starter $10.99/u/mo ann (3 seats ≈$395/yr); Advanced ≈$900/yr; 1-assignee; 2-3 team: heavy.',
  '[2026-08-10] Pick: Squarespace Core ~$276/yr — zero maintenance; WordPress only if heavy SEO/customization + maintenance budget. Sources: Ticky 1a952a39, Kevin 34430191.',
  'My car is at 86,900 miles and the oil change is due at 87,500.',
];

// ════════════════════════════════════════════════════════════════════════════════════════
// §1 — THE CLASSIFIER, MEASURED BEFORE IT REFUSES ANYTHING
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§1 obligation shape is narrow enough to refuse on', () => {
  it('fires on all three live commitment lines', () => {
    for (const c of [BOB_ROOF, BOB_FENCE, BOB_BOILER]) {
      expect(obligationShape(c), c.slice(0, 40)).not.toBeNull();
    }
  });

  it('ZERO false positives across the whole live vault corpus of the dev box', () => {
    const refused = LIVE_CORPUS_NON_OBLIGATION
      .map((c) => ({ c, marker: obligationShape(c) }))
      .filter((r) => r.marker !== null);
    expect(refused, `false positives: ${JSON.stringify(refused)}`).toEqual([]);
  });

  it('does not fire on the near-miss shapes the corpus contains', () => {
    // "due" is a fact about the world; a third party's future act is not the agent's
    // obligation; a past delivery is a record, not a promise.
    expect(obligationShape('My car is at 86,900 miles and the oil change is due at 87,500.')).toBeNull();
    expect(obligationShape('David will send the address when he has it.')).toBeNull();
    expect(obligationShape('Bob promised to send his address.')).toBeNull();
    expect(obligationShape('Delivered the roof quote to Bob on Aug 1.')).toBeNull();
    expect(obligationShape('The user prefers a follow-up email over a call.')).toBeNull();
  });

  it('fires on first-person commissives and on the two join tokens', () => {
    expect(obligationShape("I'll email Bob the quote once he sends his address")).not.toBeNull();
    expect(obligationShape('I need to send the invoice to Bob')).not.toBeNull();
    expect(obligationShape('I promised to send the invoice')).not.toBeNull();
    expect(obligationShape('see cmt:5a0d68d9039e for the details')).not.toBeNull();
    expect(obligationShape('run tag promise-bmsbcibqqem')).not.toBeNull();
  });

  it('extracts both token forms and nothing else', () => {
    expect(obligationTags(BOB_ROOF)).toEqual(['promise-bmsbcibqqem']);
    expect(obligationTags('cmt:5a0d68d9039e and promise-bmsh708xse7 and cmt:5A0D68D9039E'))
      .toEqual(['cmt:5a0d68d9039e', 'promise-bmsh708xse7']);
    expect(obligationTags('no tokens here at all')).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §2 — RESOLUTION AGAINST THE SPINE. The spine is the only truth about what is owed.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§2 a vault line is resolved against the spine before it is believed', () => {
  it('the S6 body: every commitment the tag names is abandoned -> CLOSED', () => {
    seedCommitment({ id: 'cmt:5a0d68d9039e', title: 'Email the roof quote to Bob (promise-bmsbcibqqem) once he sends his address.', state: 'abandoned' });
    seedCommitment({ id: 'cmt:da4ac6b4ca6d', title: 'email the boiler invoice to Bob (promise-bmsbcibqqem) once he sends his address.', state: 'abandoned' });
    seedCommitment({ id: 'cmt:7ede3a1b1f09', title: 'email the fence estimate to Bob (promise-bmsbcibqqem) once he sends his address.', state: 'abandoned' });
    const v = obligationVerdict(BOB_ROOF);
    expect(v.kind).toBe('closed');
    expect(v.kind === 'closed' && v.states).toEqual(['abandoned']);
  });

  it('ONE still-owed sibling on a shared tag keeps the whole memory LIVE', () => {
    seedCommitment({ id: 'cmt:aaaaaaaaaaaa', title: 'Email the roof quote to Bob (promise-bmsbcibqqem).', state: 'abandoned' });
    seedCommitment({ id: 'cmt:bbbbbbbbbbbb', title: 'Email the fence estimate to Bob (promise-bmsbcibqqem).', state: 'open' });
    const v = obligationVerdict(BOB_ROOF);
    expect(v.kind).toBe('live');
  });

  it('a tag that resolves to no row is UNRESOLVABLE, never dead', () => {
    expect(obligationVerdict(BOB_FENCE).kind).toBe('unresolvable');
  });

  it('a non-obligation line is never resolved at all', () => {
    expect(obligationVerdict('David\'s locker code at the north gym is GYM-O1VNAD-DC2.').kind)
      .toBe('not-an-obligation');
  });

  it('resolves by the printable commitment id too', () => {
    seedCommitment({ id: 'cmt:0123456789ab', title: 'Send the report', state: 'failed' });
    const v = obligationVerdict('Commitment: send the report (cmt:0123456789ab)');
    expect(v.kind).toBe('closed');
    expect(v.kind === 'closed' && v.states).toEqual(['failed']);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §3 — THE RECALL LANE STOPS SERVING DEAD PROMISES AS LIVE
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§3 the recall lane render', () => {
  it('RED->GREEN: the S6 line is no longer served present-tense as a live obligation', () => {
    seedCommitment({ id: 'cmt:5a0d68d9039e', title: 'Email the roof quote to Bob (promise-bmsbcibqqem) once he sends his address.', state: 'abandoned' });
    const out = laneWith([{ id: 'v1', type: 'note', content: BOB_ROOF }]);
    expect(out).not.toContain("Waiting on Bob's address before proceeding");
    expect(out).not.toContain('email the roof quote to Bob');
  });

  it('a LIVE commitment recalls exactly as before — byte-identical line', () => {
    seedCommitment({ id: 'cmt:cccccccccccc', title: 'Email the roof quote to Bob (promise-bmsbcibqqem).', state: 'open' });
    const out = laneWith([{ id: 'v1', type: 'note', content: BOB_ROOF }]);
    expect(out).toContain(`- [vault:note] ${BOB_ROOF}`);
    expect(out).not.toContain('no live commitment matches');
  });

  it('an obligation whose tag resolves to nothing carries an explicit validity marker', () => {
    const out = laneWith([{ id: 'v1', type: 'note', content: BOB_BOILER }]);
    expect(out).toContain(BOB_BOILER);
    expect(out).toContain('no live commitment matches');
    expect(out).toContain('verify before repeating as owed');
  });

  it('non-obligation vault notes are byte-identical in the lane', () => {
    const notes = LIVE_CORPUS_NON_OBLIGATION.slice(0, 5)
      .map((c, i) => ({ id: `v${i}`, type: 'note', content: c }));
    const out = laneWith(notes);
    for (const n of notes) expect(out).toContain(`- [vault:${n.type}] ${n.content}`);
  });

  it('dropping every hit drops the vault section, not the lane', () => {
    seedCommitment({ id: 'cmt:5a0d68d9039e', title: 'roof (promise-bmsbcibqqem)', state: 'abandoned' });
    const out = laneWith([{ id: 'v1', type: 'note', content: BOB_ROOF }]);
    expect(out).not.toContain('From your long-term vault');
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §4 — THE TERMINAL EXIT RETIRES THE MEMORY (A-lite: tag-keyed, no schema, no guessing)
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§4 retirement at the terminal exit', () => {
  it('retires the vault entry that carries the closing commitment\'s own id', () => {
    seedVault({ id: 'v-id', content: 'Commitment: send the report (cmt:0123456789ab)' });
    seedCommitment({ id: 'cmt:0123456789ab', title: 'Send the report', state: 'abandoned' });
    expect(retireObligationMemory({
      workId: 'cmt:0123456789ab', agentId: AGENT, title: 'Send the report', state: 'abandoned',
    })).toBe(1);
    expect(isObsolete('v-id')).toBe(1);
  });

  it('retires by the promise tag when every sibling is closed', () => {
    seedVault({ id: 'v-roof', content: BOB_ROOF });
    seedCommitment({ id: 'cmt:5a0d68d9039e', title: 'Email the roof quote to Bob (promise-bmsbcibqqem).', state: 'abandoned' });
    seedCommitment({ id: 'cmt:7ede3a1b1f09', title: 'Email the fence estimate to Bob (promise-bmsbcibqqem).', state: 'abandoned' });
    expect(retireObligationMemory({
      workId: 'cmt:5a0d68d9039e', agentId: AGENT,
      title: 'Email the roof quote to Bob (promise-bmsbcibqqem).', state: 'abandoned',
    })).toBe(1);
    expect(isObsolete('v-roof')).toBe(1);
  });

  it('a shared tag with ONE still-owed sibling retires NOTHING', () => {
    seedVault({ id: 'v-roof', content: BOB_ROOF });
    seedCommitment({ id: 'cmt:5a0d68d9039e', title: 'Email the roof quote to Bob (promise-bmsbcibqqem).', state: 'abandoned' });
    seedCommitment({ id: 'cmt:7ede3a1b1f09', title: 'Email the fence estimate to Bob (promise-bmsbcibqqem).', state: 'open' });
    expect(retireObligationMemory({
      workId: 'cmt:5a0d68d9039e', agentId: AGENT,
      title: 'Email the roof quote to Bob (promise-bmsbcibqqem).', state: 'abandoned',
    })).toBe(0);
    expect(isObsolete('v-roof')).toBe(0);
  });

  it('never reaches another agent\'s vault', () => {
    seedVault({ id: 'v-other', content: 'Commitment: send the report (cmt:0123456789ab)', agentId: 'someone-else' });
    seedCommitment({ id: 'cmt:0123456789ab', title: 'Send the report', state: 'abandoned' });
    expect(retireObligationMemory({
      workId: 'cmt:0123456789ab', agentId: AGENT, title: 'Send the report', state: 'abandoned',
    })).toBe(0);
    expect(isObsolete('v-other')).toBe(0);
  });

  it('a commitment with no tag anywhere retires nothing and does not throw', () => {
    seedVault({ id: 'v-prose', content: 'Commitment: email the roof quote to Bob once he sends his address.' });
    seedCommitment({ id: 'cmt:dddddddddddd', title: 'Email the roof quote to Bob', state: 'abandoned' });
    expect(retireObligationMemory({
      workId: 'cmt:dddddddddddd', agentId: AGENT, title: 'Email the roof quote to Bob', state: 'abandoned',
    })).toBe(0);
    expect(isObsolete('v-prose')).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §5 — THROUGH THE DOOR. The ONE writer of `work.state` carries the retirement, so no
// commitment closer can forget it and none of them had to be edited.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§5 the spine writer retires the memory', () => {
  it('dismissCommitment (abandoned) retires the tagged vault line', () => {
    seedVault({ id: 'v-roof', content: BOB_ROOF });
    seedCommitment({ id: 'cmt:5a0d68d9039e', title: 'Email the roof quote to Bob (promise-bmsbcibqqem).', state: 'open' });
    const out = dismissCommitment('cmt:5a0d68d9039e', { agentId: AGENT, reason: 'the owner dropped it' });
    expect(out.kind).toBe('applied');
    expect(isObsolete('v-roof')).toBe(1);
  });

  it('a NON-terminal move retires nothing', () => {
    seedVault({ id: 'v-roof', content: BOB_ROOF });
    seedCommitment({ id: 'cmt:5a0d68d9039e', title: 'Email the roof quote to Bob (promise-bmsbcibqqem).', state: 'open' });
    const out = transition('cmt:5a0d68d9039e', {
      to: 'paused', by: 'agent', actorId: AGENT, reason: 'waiting on Bob',
    });
    expect(out.kind).toBe('applied');
    expect(isObsolete('v-roof')).toBe(0);
  });

  it('a TASK going terminal never touches the vault', () => {
    seedVault({ id: 'v-roof', content: BOB_ROOF });
    mockDb.current!.prepare(
      `INSERT INTO work (id, kind, agent_id, requester, requester_id, root_kind, root_id, state,
                         intent, wakes, closes_thread, title, opened_at, updated_at, provenance)
       VALUES ('task-1','task',?, 'agent', ?, 'tracker','t','claimed','work',0,0,
               'Email the roof quote to Bob (promise-bmsbcibqqem).', ?, ?, 'live')`,
    ).run(AGENT, AGENT, Date.now(), Date.now());
    transition('task-1', { to: 'failed', by: 'agent', actorId: AGENT, reason: 'it fell over' });
    expect(isObsolete('v-roof')).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §6 — THE WRITER GUARD. The refusal family `vault/tools.ts` already carries (technique
// text, credentials) gains its third member: an obligation belongs on the spine.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§6 vault_remember refuses obligation-shaped content', () => {
  const remember = (content: string) => executeVaultRemember(AGENT, { content, type: 'note' });

  it('refuses the S6 line and names work_open(kind="commitment")', async () => {
    const out = await remember('Commitment: email the roof quote to Bob once he sends his address.');
    expect(out).toMatch(/^Refused:/);
    expect(out).toContain('work_open');
    expect(out).toContain('commitment');
    expect(out).toContain('nothing was written');
    expect(mockDb.current!.prepare('SELECT count(*) AS c FROM vault_entries').get())
      .toEqual({ c: 0 });
  });

  it('lets every entry of the live corpus through', async () => {
    for (const c of LIVE_CORPUS_NON_OBLIGATION) {
      const out = await remember(c);
      expect(out, c.slice(0, 50)).not.toMatch(/^Refused:/);
    }
  });
});
