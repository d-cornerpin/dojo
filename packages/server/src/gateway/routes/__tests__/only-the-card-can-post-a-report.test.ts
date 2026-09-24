// ════════════════════════════════════════════════════════════════════════════════════════
// ONLY THE CARD CAN POST A REPORT (DOJO-REPORT T6).
//
// Owner ruling D4 — *"the user sees the exact text before anything posts; no preview, no
// post"* — is not a sentence printed on a card. It is FOUR separable properties, and only the
// first is obvious:
//
//   1. ONE DOOR. `approveOnce` is reachable from exactly one place in the tree, and that place
//      is the route behind the owner's Post button. The census below is static and says so;
//      the IMPORT half of the same claim is held next door by
//      `agent/tools/__tests__/the-report-tool-reaches-no-new-door.test.ts`, whose
//      ALLOWED_CONSENT_CALLERS this task appends one line to. The two guards compose: that one
//      answers "who may bind the door", this one answers "who may call it".
//
//   2. THE APPROVER SAW THE TEXT THAT POSTS. The edit door is narrow (the five brief fields,
//      T66b's "a field the user did not touch is never mentioned in any request"), it REFUSES
//      the columns other doors own BY NAME, and it closes the moment the row leaves
//      `awaiting_approval`. An edited brief then posts the EDITED text — measured byte for
//      byte against the bytes the card was served, not eyeballed.
//
//   3. CANCEL IS TERMINAL. A cancelled report is not approvable, not editable, not re-openable.
//
//   4. THERE IS NO AGENT-FACING TWIN. `destructive-gate.ts` has `requestApproval()`, which wakes
//      the primary agent to approve over A2A. Copying that shape here would let an agent approve
//      its own report, so it is NOT copied, and the clause at the bottom says so rather than
//      leaving the absence to be noticed.
//
// ── WHY THE DASHBOARD'S OWN RULES ARE IN THIS FILE ──
// `packages/dashboard` has NO test runner. The v3.1.27/T5 arrangement is to split the card at
// the only seam that can be argued with — the ROUTE, driven here for real, and the DECISIONS it
// renders (`dashboard/src/lib/report-edits.ts`), imported here directly, exactly as
// `the-provider-editor-sends-only-what-changed.test.ts` does for `lib/provider-edits.ts` and
// `the-github-card-reports-connection-truth.test.ts` does for `lib/github-card.ts`. Holding both
// in ONE file is the point: the form's only-what-moved rule and the door's only-what-moved rule
// are checked AGAINST EACH OTHER, which is the only place that agreement can be observed.
//
// ── WHAT THIS FILE HONESTLY DOES NOT HOLD ──
// The card's JSX, its two `subscribe()` wirings, its `loadedRef` mount-once and its `busy`
// disabling need a DOM runner. They are listed as unheld in the T6 report rather than implied
// to be covered by this file's name. The one static substitute that was cheap — T5's
// setStatus-style census, refusing a second state-setter outside the refetch — is below.
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

vi.mock('../../../logger.js', () => {
  const noop = (): void => {};
  return {
    createLogger: () => ({ debug: noop, info: noop, warn: noop, error: noop }),
    setLogLevel: noop, setLogBroadcast: noop, readLogEntries: () => [],
  };
});

const mockDb: { current: Database.Database | null } = { current: null };

vi.mock('../../../db/connection.js', async () => {
  const os = await import('node:os');
  const p = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => p.join(os.tmpdir(), 'dojo-t6-report-card', 'dojo.db'),
  };
});

/** Every frame the routes emit, in order. A consent decision that tells nobody is half a gate. */
const frames: Array<{ type: string; data?: unknown }> = [];
vi.mock('../../ws.js', () => ({
  broadcast: (e: { type: string; data?: unknown }) => { frames.push(e); },
  stampPersistedRow: (e: unknown) => e,
}));

import { runMigrations } from '../../../db/migrations.js';
import { reportsRouter } from '../reports.js';
import {
  createReport, attachDraft, submitForApproval, getReport, listOpenReports, type ReportBrief,
} from '../../../report/store.js';
import { saveGithubAccount, disconnectGithub } from '../../../github/account.js';
import { briefEditsFor, briefIsPostable, duplicateQuestion, postTargetSentence, type BriefFields }
  from '../../../../../dashboard/src/lib/report-edits.js';

const SRC = path.resolve(__dirname, '..', '..', '..');
const CARD = path.resolve(SRC, '../../dashboard/src/components/ReportPreviewCard.tsx');
const DELIVERY_PANEL = path.resolve(SRC, '../../dashboard/src/components/ReportDeliveryPanel.tsx');

// ── THE STUBBED GITHUB ───────────────────────────────────────────────────────────────────
// Installed for EVERY clause in this file, not only the ones that mean to post. The approve
// route reaches the network the moment a token is present, and a suite that leaves the real
// `fetch` in place would file issues on a public tracker from a test run. The default script
// is "no duplicate, then the issue is created", so a clause that does not care about GitHub
// still gets a plausible answer rather than a socket error.
interface GithubCall { method: string; url: string; body: string }
let ghCalls: GithubCall[] = [];
let searchAnswer: () => Promise<Response> | Response = () => jsonRes(200, { items: [] });
let writeAnswer: () => Promise<Response> | Response =
  () => jsonRes(201, { number: 7, html_url: 'https://github.com/d-cornerpin/dojo/issues/7' });

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  });
}

const realFetch = globalThis.fetch;
const ghWrites = (): GithubCall[] => ghCalls.filter(c => c.method === 'POST');

function installFetch(): void {
  globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    ghCalls.push({
      method: (init?.method ?? 'GET').toUpperCase(), url,
      body: typeof init?.body === 'string' ? init.body : '',
    });
    return url.includes('/search/issues') ? await searchAnswer() : await writeAnswer();
  }) as unknown as typeof fetch;
}

const BRIEF: ReportBrief = {
  title: 't', whatHappened: 'a', whatShouldHaveHappened: 'b',
  whyItWentWrong: 'c', fixIdeas: 'd',
};
const TELEMETRY = { report: { schema: 'dojo-telemetry-1' } };

/** An invented literal. No real token appears in this file. */
const TOKEN = 'gho_fixture-token-value-never-real';

const db = (): Database.Database => mockDb.current!;

/** A report sitting exactly where the Post button finds it. */
function awaiting(signature = 'ds1-aaaaaaaaaaaa', brief: ReportBrief = BRIEF): string {
  const r = createReport('agent-1', 'tool-error', signature);
  attachDraft(r.id, brief, TELEMETRY, '/tmp/x/bundle.json');
  submitForApproval(r.id);
  return r.id;
}

const get = async (p: string): Promise<Response> => reportsRouter.request(p);
const post = async (p: string, body?: unknown): Promise<Response> =>
  reportsRouter.request(p, body === undefined ? { method: 'POST' } : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
const patch = async (p: string, body: unknown): Promise<Response> =>
  reportsRouter.request(p, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

interface Body { ok: boolean; data?: Record<string, unknown>; error?: string }
const bodyOf = async (res: Response): Promise<Body> => await res.json() as Body;

beforeEach(() => {
  const d = new Database(':memory:');
  d.pragma('foreign_keys = ON');
  mockDb.current = d;
  runMigrations();
  frames.length = 0;
  ghCalls = [];
  searchAnswer = () => jsonRes(200, { items: [] });
  writeAnswer = () => jsonRes(201, { number: 7, html_url: 'https://github.com/d-cornerpin/dojo/issues/7' });
  installFetch();
  disconnectGithub();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  mockDb.current?.close();
  mockDb.current = null;
});

// ── 1. ONE DOOR ─────────────────────────────────────────────────────────────────────────

describe('nothing but the approve route may spend an approval', () => {
  it('every door that mints, spends or returns an approval has exactly one call site', () => {
    // T7 WIDENED THIS FROM `approveOnce` ALONE. The import half of the claim (prong A of
    // `the-report-tool-reaches-no-new-door.test.ts`) has always covered all three consent
    // doors; this half only ever covered the mint, so `markPosted` — the door that SPENDS the
    // approval — could have grown a second caller at full green. `releaseApproval` is here for
    // the opposite reason: it hands a decision BACK, and a second caller could quietly
    // un-approve rows the owner had decided.
    const OWNERS: Readonly<Record<string, string>> = {
      approveOnce: 'gateway/routes/reports.ts',
      markExported: 'gateway/routes/reports.ts',
      releaseApproval: 'gateway/routes/reports.ts',
      markPosted: 'report/post.ts',
      // ── ADDED IN FIX ROUND 2 (G2), BECAUSE THE IMPORT CENSUS CITES THIS CLAUSE ──
      // `cancelReport` is deliberately NOT a consent export over there: it destroys an approval
      // rather than moving it toward delivery, and its comment hands the residual hazard — a
      // second module making somebody's pending report disappear — to "the call-site census".
      // That citation was writing a cheque this map did not cover: `cancelReport` was not in it,
      // so the hazard was assigned to a guard that was not watching. It is now.
      cancelReport: 'gateway/routes/reports.ts',
    };
    // Derived, never a second list: a name in OWNERS with no bucket was a silent pass.
    const hits: Record<string, string[]> = Object.fromEntries(Object.keys(OWNERS).map(k => [k, []]));
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== '__tests__') walk(p); continue; }
        if (!p.endsWith('.ts') || p.includes('.test.') || p.endsWith('report/store.ts')) continue;
        const src = fs.readFileSync(p, 'utf8');
        for (const name of Object.keys(OWNERS)) {
          if (new RegExp(`\\b${name}\\s*\\(`).test(src)) hits[name].push(path.relative(SRC, p));
        }
      }
    };
    walk(SRC);
    for (const [name, owner] of Object.entries(OWNERS)) {
      expect(
        hits[name].sort(),
        `a second module CALLS ${name}. The owner's one approval is minted, spent and returned `
        + 'in one place each (D4). If this is a legitimate new door, it must also be added to '
        + 'ALLOWED_CONSENT_CALLERS in '
        + 'agent/tools/__tests__/the-report-tool-reaches-no-new-door.test.ts.',
      ).toEqual([owner]);
    }
  });

  it('the PATCH door calls editBrief and can never reach attachDraft (contract C2)', () => {
    const route = fs.readFileSync(path.join(SRC, 'gateway', 'routes', 'reports.ts'), 'utf8');
    expect(route, 'the edit route must go through editBrief').toContain('editBrief');
    expect(
      route.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n'),
      'attachDraft is the AGENT\'s write door, legal only from `drafting`. A route that reached '
      + 'it could swap the brief a human is looking at — that is exactly what D4 forbids.',
    ).not.toContain('attachDraft');
  });

  it('a submitted report is not posted until a human approves', () => {
    const id = awaiting();
    expect(getReport(id)?.status).toBe('awaiting_approval');
    expect(getReport(id)?.issueUrl).toBeNull();
    expect(getReport(id)?.postedAt).toBeNull();
    expect(getReport(id)?.exportPath).toBeNull();
  });

  it('a second approve is refused — no retry, no engine event, no second issue', async () => {
    const id = awaiting();
    const first = await post(`/${id}/approve`);
    expect(first.status).toBe(200);
    expect((await bodyOf(first)).data?.status).toBe('posted');

    const second = await post(`/${id}/approve`);
    expect(second.status).toBe(409);
    const body = await bodyOf(second);
    expect(body.ok).toBe(false);
    // C4: the row EXISTS. "Already decided" is not "not found".
    expect(second.status).not.toBe(404);
    expect(String(body.error).toLowerCase()).toContain('already');
    expect(getReport(id)?.status).toBe('posted');
  });

  it('refuses approval on a report that was never submitted', async () => {
    const r = createReport('agent-1', 'other', 'ds1-cccccccccccc');
    attachDraft(r.id, BRIEF, TELEMETRY, '/tmp/x/bundle.json');
    const res = await post(`/${r.id}/approve`);
    expect(res.status).toBe(409);
    expect(getReport(r.id)?.status).toBe('drafting');
  });

  it('answers 404 — not 409 — for an id that does not exist', async () => {
    const res = await post('/00000000-0000-4000-8000-000000000000/approve');
    expect(res.status).toBe(404);
  });

  it('a delivery that could not happen spends no approval, and strands no report', async () => {
    // ── THE T7 REPLACEMENT OF T6's F1 CLAUSE — SAME PROPERTY, REAL NETWORK REFUSAL ──
    // T6 stood a 503 ahead of `approveOnce` because there was no sender, and this clause held
    // the ORDERING rather than the answer: review moved that block one statement down and rode
    // 39/39 green, which left a connected box's Post SPENDING the owner's one approval on a
    // delivery that could not happen. T7 deleted the 503 — so the clause is REPLACED, NOT
    // DELETED, because the property was never "a 503 happens". It is:
    //
    //    THE OWNER'S ONE APPROVAL IS NEVER SPENT ON A DELIVERY THAT CANNOT HAPPEN.
    //
    // Now driven the way it will actually fail in the world: GitHub is connected, the report is
    // approved, and the network refuses. `postApprovedReport` leaves the row alone by design, so
    // it is the ROUTE that must hand the decision back — otherwise the row sits in `approved`,
    // off `listOpenReports()` (C1) and refused by `approveOnce` forever, delivered to nobody.
    saveGithubAccount('octocat', TOKEN, 'public_repo');
    searchAnswer = () => { throw new Error('connect ECONNREFUSED 140.82.121.6:443'); };
    const id = awaiting('ds1-502502502502');

    const res = await post(`/${id}/approve`);
    expect(res.status, 'an upstream refusal was reported as something other than a bad gateway')
      .toBe(502);
    expect(String((await bodyOf(res)).error).length).toBeGreaterThan(10);
    expect(ghWrites(), 'the duplicate check failed and the report was filed anyway').toEqual([]);

    const row = getReport(id)!;
    expect(row.status, 'the approval was spent on a delivery that could not happen — D4')
      .toBe('awaiting_approval');
    expect(listOpenReports().map(r => r.id),
      'the report left the card without ever being delivered').toContain(id);
    expect(row.approvedAt, 'a decision was recorded that nobody made').toBeNull();
    expect(row.postedAt).toBeNull();
    expect(row.issueUrl).toBeNull();
    expect(row.exportPath ?? null).toBeNull();

    // ...and it is still the owner's to decide the moment the network comes back. Pressing Post
    // again is a fresh human act, not a retry (P3) — and it is only possible because the row is
    // still there to press Post on.
    searchAnswer = () => jsonRes(200, { items: [] });
    const later = await post(`/${id}/approve`);
    expect(later.status, 'the report could not be decided after the refusal').toBe(200);
    expect(getReport(id)?.status).toBe('posted');
    expect(getReport(id)?.issueNumber).toBe(7);
  });

  it('a credential GitHub refuses leaves the report decidable and the card honest', async () => {
    saveGithubAccount('octocat', TOKEN, 'public_repo');
    writeAnswer = () => jsonRes(401, { message: 'Bad credentials' });
    const id = awaiting('ds1-401401401401');

    expect((await post(`/${id}/approve`)).status).toBe(502);
    expect(getReport(id)?.status).toBe('awaiting_approval');
    expect(listOpenReports().map(r => r.id)).toContain(id);
  });

  // ── THE ROUTE-LEVEL [1,0] MATRIX (T6 §10.1a2, the reviewer's C3 caveat) ────────────────
  // T2 holds this at the STORE: two doors that both read an awaiting row produce exactly one
  // approval. T6 could only drive the approve→approve half, because `markPosted` had no route
  // until now. Both orders are driven here, at the route, with a GENUINE overlap — the second
  // request arrives while the first is still waiting on GitHub — and the measurement is the
  // same one T2 makes: the deliveries that actually happened, counted, `[1, 0]`.

  it('post-then-export: a second door arrives mid-flight and delivers nothing', async () => {
    saveGithubAccount('octocat', TOKEN, 'public_repo');
    const id = awaiting('ds1-aaaa0000aaaa');

    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    searchAnswer = async () => { await held; return jsonRes(200, { items: [] }); };

    const posting = post(`/${id}/approve`);          // connection A: connected, in flight
    await new Promise(r => setTimeout(r, 5));

    // Mid-flight the row is APPROVED and OFF the card, so no second press can be offered...
    expect(getReport(id)?.status).toBe('approved');
    expect(listOpenReports().map(r => r.id)).not.toContain(id);

    // ...and a second connection that takes the OTHER delivery door is refused anyway. (The
    // account is put back before A resumes: this is a second tab pressing Disconnect, not a
    // box that lost its token.)
    disconnectGithub();
    const exporting = await post(`/${id}/approve`);
    saveGithubAccount('octocat', TOKEN, 'public_repo');
    release();
    const posted = await posting;

    expect(posted.status).toBe(200);
    expect(exporting.status, 'the export door delivered a report the poster had already won')
      .toBe(409);
    const row = getReport(id)!;
    expect([row.issueUrl === null ? 0 : 1, row.exportPath === null ? 0 : 1],
      'one approval produced more or fewer than one delivery').toEqual([1, 0]);
    expect(ghWrites()).toHaveLength(1);
  });

  it('export-then-post: the file wins and the poster never reaches the network', async () => {
    const id = awaiting('ds1-bbbb0000bbbb');       // unconnected: the export door
    const exporting = await post(`/${id}/approve`);
    expect(exporting.status).toBe(200);

    saveGithubAccount('octocat', TOKEN, 'public_repo');
    ghCalls = [];
    const posting = await post(`/${id}/approve`);

    expect(posting.status).toBe(409);
    expect(ghCalls, 'a delivered report reached GitHub on a second press').toEqual([]);
    const row = getReport(id)!;
    expect([row.issueUrl === null ? 0 : 1, row.exportPath === null ? 0 : 1],
      'one approval produced more or fewer than one delivery').toEqual([0, 1]);
  });

  it('a decision broadcasts report:resolved so a second tab stops showing the card', async () => {
    const id = awaiting();
    await post(`/${id}/approve`);
    expect(frames.map(f => f.type)).toContain('report:resolved');
    expect(frames.find(f => f.type === 'report:resolved')?.data)
      .toEqual({ id, status: 'posted' });
  });
});

// ── a duplicate is a QUESTION, and the approval waits for the answer ────────────────────

describe('someone already reported this — the owner chooses, the platform does not', () => {
  const MATCH = {
    number: 42, title: 'work_open refuses a granted category', state: 'open',
    html_url: 'https://github.com/d-cornerpin/dojo/issues/42',
  };
  const withMatch = (signature: string): void => {
    searchAnswer = () => jsonRes(200, { items: [{ ...MATCH, body: `dojo-sig: ${signature}` }] });
  };

  it('offers the existing issue, posts nothing, and gives the decision back', async () => {
    saveGithubAccount('octocat', TOKEN, 'public_repo');
    const signature = 'ds1-dddd0000dddd';
    withMatch(signature);
    const id = awaiting(signature);

    const res = await post(`/${id}/approve`);
    expect(res.status).toBe(200);
    const data = (await bodyOf(res)).data!;
    expect(data.duplicate, 'the card was given nothing to ask about').toMatchObject({ number: 42 });
    expect(data.issueUrl).toBeNull();
    expect(ghWrites(), 'a second issue was filed while the owner was being asked').toEqual([]);

    // The question can only be ASKED if the report is still on the card to ask about.
    expect(getReport(id)?.status).toBe('awaiting_approval');
    expect(getReport(id)?.approvedAt).toBeNull();
    expect(listOpenReports().map(r => r.id)).toContain(id);
  });

  it('“add to it” comments on that issue and records the delivery against it', async () => {
    saveGithubAccount('octocat', TOKEN, 'public_repo');
    writeAnswer = () => jsonRes(201, { html_url: `${MATCH.html_url}#issuecomment-9` });
    const id = awaiting('ds1-eeee0000eeee');

    const res = await post(`/${id}/approve`, { addToExisting: 42 });
    expect(res.status).toBe(200);
    expect((await bodyOf(res)).data?.issueNumber).toBe(42);
    expect(ghWrites()).toHaveLength(1);
    expect(ghWrites()[0].url).toContain('/issues/42/comments');
    expect(getReport(id)?.status).toBe('posted');
    expect(frames.find(f => f.type === 'report:resolved')?.data).toEqual({ id, status: 'posted' });
  });

  it('“post separately” files its own issue even with a match on the tracker', async () => {
    saveGithubAccount('octocat', TOKEN, 'public_repo');
    const signature = 'ds1-ffff0000ffff';
    withMatch(signature);
    const id = awaiting(signature);

    const res = await post(`/${id}/approve`, { postSeparately: true });
    expect(res.status).toBe(200);
    expect((await bodyOf(res)).data?.issueNumber).toBe(7);
    expect(ghWrites()[0].url.endsWith('/issues')).toBe(true);
  });

  it('refuses an answer it does not recognise, before anything is approved', async () => {
    saveGithubAccount('octocat', TOKEN, 'public_repo');
    const id = awaiting('ds1-9999aaaa9999');
    for (const body of [
      { addToExisting: 'the first one' }, { addToExisting: -3 }, { postSeparately: 'yes' },
      { addToExisting: 42, postSeparately: true }, { somethingElse: true }, [1, 2],
    ]) {
      const res = await post(`/${id}/approve`, body);
      expect(res.status, `a body of ${JSON.stringify(body)} was accepted`).toBe(400);
    }
    expect(getReport(id)?.status, 'an unreadable answer spent the owner\'s approval')
      .toBe('awaiting_approval');
    expect(ghCalls, 'an unreadable answer reached the network').toEqual([]);
  });
});

// ── the list the card draws ─────────────────────────────────────────────────────────────

describe('the card is shown exactly the rows that still hold a decision (contract C1)', () => {
  it('lists awaiting_approval only — never a draft, never an already-decided row', async () => {
    const open = awaiting('ds1-111111111111');
    const drafting = createReport('agent-1', 'other', 'ds1-222222222222');
    attachDraft(drafting.id, BRIEF, TELEMETRY, '/tmp/x/bundle.json');
    const decided = awaiting('ds1-333333333333');
    await post(`/${decided}/approve`);

    const body = await bodyOf(await get('/'));
    const ids = (body.data as unknown as Array<{ id: string }>).map(r => r.id);
    expect(ids).toEqual([open]);
    expect(ids).not.toContain(drafting.id);
    expect(ids).not.toContain(decided);
  });

  it('GET /:id serves the brief and the telemetry the card renders', async () => {
    const id = awaiting();
    const body = await bodyOf(await get(`/${id}`));
    expect(body.ok).toBe(true);
    expect(body.data?.brief).toEqual(BRIEF);
    expect(body.data?.telemetry).toEqual(TELEMETRY);
  });

  it('GET /:id on an unknown id is 404', async () => {
    expect((await get('/00000000-0000-4000-8000-000000000000')).status).toBe(404);
  });
});

// ── 2. THE EDIT DOOR ────────────────────────────────────────────────────────────────────

describe('the edit door is narrow and only-what-changed (T66b)', () => {
  it('refuses fields another door owns, by name, pointing at the right door', async () => {
    const id = awaiting();
    for (const [field, value] of [
      ['status', 'posted'], ['signature', 'ds1-x'], ['telemetry', {}],
      ['issueUrl', 'https://example.invalid/1'], ['lane', 'tool-error'],
    ] as Array<[string, unknown]>) {
      const res = await patch(`/${id}`, { [field]: value });
      expect(res.status, `PATCH {${field}} was not refused`).toBe(400);
      const body = await bodyOf(res);
      expect(String(body.error), `the refusal does not name \`${field}\``).toContain(field);
    }
    // ...and the row is untouched by all five attempts.
    expect(getReport(id)?.brief).toEqual(BRIEF);
    expect(getReport(id)?.status).toBe('awaiting_approval');
  });

  it('refuses a body that names nothing, and one that names something invented', async () => {
    const id = awaiting();
    expect((await patch(`/${id}`, {})).status).toBe(400);
    expect((await patch(`/${id}`, { nonsense: 'x' })).status).toBe(400);
  });

  it('a PATCH naming only the title leaves every other field byte-identical', async () => {
    const id = awaiting('ds1-bbbbbbbbbbbb');
    const res = await patch(`/${id}`, { title: 'a better title' });
    expect(res.status).toBe(200);
    const after = getReport(id)!;
    expect(after.brief!.title).toBe('a better title');
    expect(after.brief!.whatHappened).toBe(BRIEF.whatHappened);
    expect(after.brief!.whatShouldHaveHappened).toBe(BRIEF.whatShouldHaveHappened);
    expect(after.brief!.whyItWentWrong).toBe(BRIEF.whyItWentWrong);
    expect(after.brief!.fixIdeas).toBe(BRIEF.fixIdeas);
    expect(after.telemetry).toEqual(TELEMETRY);
    expect(after.signature).toBe('ds1-bbbbbbbbbbbb');
    expect(after.status).toBe('awaiting_approval');
  });

  it('the form sends only what moved, and what it sends is what the door accepts', async () => {
    const original: BriefFields = { ...BRIEF };
    const edited: BriefFields = { ...BRIEF, title: 'a better title' };
    const edits = briefEditsFor(original, edited);
    // The form's rule: a key is PRESENT only when that field actually moved.
    expect(Object.keys(edits)).toEqual(['title']);

    const id = awaiting();
    const res = await patch(`/${id}`, edits);
    expect(res.status, 'the door refused the exact body the form builds').toBe(200);
    const after = getReport(id)!;
    expect(after.brief!.title).toBe('a better title');
    expect(after.brief!.fixIdeas).toBe(BRIEF.fixIdeas);
  });

  it('an unchanged form sends nothing at all, and the door refuses an empty patch', async () => {
    expect(briefEditsFor({ ...BRIEF }, { ...BRIEF })).toEqual({});
    const id = awaiting();
    expect((await patch(`/${id}`, briefEditsFor({ ...BRIEF }, { ...BRIEF }))).status).toBe(400);
  });

  it('refuses any edit once the row is approved or posted — the approver saw the text', async () => {
    const id = awaiting();
    await post(`/${id}/approve`);
    const res = await patch(`/${id}`, { title: 'sneak' });
    expect(res.status).toBe(409);
    expect(String((await bodyOf(res)).error).toLowerCase()).toContain('frozen');
    expect(getReport(id)!.brief!.title).toBe(BRIEF.title);
  });

  it('refuses an edit on a report nobody has been asked about yet', async () => {
    const r = createReport('agent-1', 'other', 'ds1-dddddddddddd');
    attachDraft(r.id, BRIEF, TELEMETRY, '/tmp/x/bundle.json');
    expect((await patch(`/${r.id}`, { title: 'x' })).status).toBe(409);
    expect(getReport(r.id)!.brief!.title).toBe(BRIEF.title);
  });

  it('answers a plain sentence when the edit door THROWS, not only when it returns null (C8)', async () => {
    const id = awaiting();
    // `editBrief` is the one door with a transaction: under concurrent writers SQLite raises
    // SQLITE_BUSY_SNAPSHOT rather than answering. A trigger that ABORTs the UPDATE reproduces
    // the shape through the REAL code path — the SELECTs still work, so the route gets past its
    // existence check and into the door, which is exactly where the throw happens in production.
    db().prepare(
      `CREATE TRIGGER t6_busy BEFORE UPDATE ON dojo_reports
       BEGIN SELECT RAISE(ABORT, 'SQLITE_BUSY_SNAPSHOT: database is locked'); END`,
    ).run();
    const res = await patch(`/${id}`, { title: 'x' });
    db().prepare('DROP TRIGGER t6_busy').run();
    expect(res.status, 'a throw from editBrief reached the client as a crash').toBe(500);
    const body = await bodyOf(res);
    expect(body.ok).toBe(false);
    expect(String(body.error).length, 'the client was told nothing').toBeGreaterThan(10);
    expect(getReport(id)!.brief!.title).toBe(BRIEF.title);
  });
});

// ── 3. CANCEL IS TERMINAL ───────────────────────────────────────────────────────────────

describe('cancel is the safe direction, and it is terminal', () => {
  it('cancels, says so, and tells the other tabs', async () => {
    const id = awaiting();
    const res = await post(`/${id}/cancel`);
    expect(res.status).toBe(200);
    expect((await bodyOf(res)).data).toEqual({ status: 'cancelled' });
    expect(frames.find(f => f.type === 'report:resolved')?.data)
      .toEqual({ id, status: 'cancelled' });
  });

  it('a cancelled report cannot be approved, edited, or cancelled twice', async () => {
    const id = awaiting();
    await post(`/${id}/cancel`);
    expect((await post(`/${id}/approve`)).status).toBe(409);
    expect((await patch(`/${id}`, { title: 'x' })).status).toBe(409);
    expect((await post(`/${id}/cancel`)).status).toBe(409);
    expect(getReport(id)?.status).toBe('cancelled');
    expect(getReport(id)?.exportPath).toBeNull();
  });

  it('a status this release does not recognise is terminal, never repaired (contract C5)', async () => {
    const id = awaiting();
    db().prepare("UPDATE dojo_reports SET status = 'from_the_future' WHERE id = ?").run(id);
    expect(getReport(id)?.status).toBe('cancelled');
    expect((await post(`/${id}/approve`)).status).toBe(409);
    expect((await patch(`/${id}`, { title: 'x' })).status).toBe(409);
    // ...and the route did not "fix" the column on its way past.
    expect((db().prepare('SELECT status FROM dojo_reports WHERE id = ?').get(id) as { status: string }).status)
      .toBe('from_the_future');
  });
});

// ── the text the owner approved is the text that leaves ─────────────────────────────────

describe('what the card shows is what leaves, byte for byte', () => {
  // Characters a renderer is most likely to "help" with: markdown emphasis, a heading, a fence,
  // HTML, and a trailing space. D4 says the user sees the EXACT text; a card or an exporter that
  // mangles any of these shows one thing and publishes another.
  const HOSTILE: ReportBrief = {
    title: '*work_open* refused #14 — <b>the grant floor</b>',
    whatHappened: 'The tool answered:\n```\nnot granted\n```\nand the turn ended.  ',
    whatShouldHaveHappened: '# It should have opened a task\n\n- one\n- two',
    whyItWentWrong: 'The floor omitted `Work Tracker`, and _nothing_ re-checked it.',
    fixIdeas: 'Add the label. <script>alert(1)</script> 100% of the time.',
  };

  // ⚠ WHERE THE TITLE GOES CHANGED IN T7, AND THE CLAUSE HAD TO LEARN IT RATHER THAN DROP IT.
  // One renderer now serves both doors, and its output is an ISSUE BODY — which carries no
  // title, because an issue carries its title in its own field. So the title is checked where
  // it actually rides now: the prefilled link on the export path, and the POSTed `title` on the
  // GitHub path. Four fields in the body plus one in the title is still all five; a clause that
  // quietly stopped checking the title would be the same claim with a hole in it.

  it('the bytes the card is served are the bytes that reach the exported file', async () => {
    const id = awaiting('ds1-eeeeeeeeeeee', HOSTILE);
    const served = (await bodyOf(await get(`/${id}`))).data?.brief as ReportBrief;
    for (const key of Object.keys(HOSTILE) as Array<keyof ReportBrief>) {
      expect(served[key], `the route transformed \`${key}\` on the way to the card`)
        .toBe(HOSTILE[key]);
    }

    const res = await post(`/${id}/approve`);
    expect(res.status).toBe(200);
    const data = (await bodyOf(res)).data!;
    const written = fs.readFileSync(String(data.exportPath), 'utf8');
    for (const key of Object.keys(HOSTILE) as Array<keyof ReportBrief>) {
      if (key === 'title') continue;
      expect(written, `\`${key}\` was mangled between the card and the file`)
        .toContain(HOSTILE[key]);
    }
    // ...and the title reaches the issue form, verbatim, inside the prefilled link.
    const prefilled = new URL(String(data.newIssueUrl)).searchParams;
    expect(String(prefilled.get('title')), 'the owner\'s title never reached the issue form')
      .toContain(HOSTILE.title);
    expect(prefilled.get('body'), 'the link carries a different body from the file')
      .toBe(written);
  });

  it('an edited brief posts the EDITED text exactly', async () => {
    // A distinctive original, so "the old text is gone" is a real claim: the shared fixture's
    // one-letter fields appear inside almost any English sentence.
    saveGithubAccount('octocat', TOKEN, 'public_repo');
    const ORIGINAL = { ...BRIEF, title: 'THE-TITLE-THE-AGENT-WROTE', fixIdeas: 'THE-FIX-THE-AGENT-WROTE' };
    const id = awaiting('ds1-ffffffffffff', ORIGINAL);
    const EDITED = 'a title the owner wrote, with *stars* and a #hash';
    const EDITED_FIX = 'the fix the OWNER wrote instead';
    expect((await patch(`/${id}`, { title: EDITED, fixIdeas: EDITED_FIX })).status).toBe(200);

    // The card re-reads before the owner presses Post: saving is never approving.
    const reread = (await bodyOf(await get(`/${id}`))).data?.brief as ReportBrief;
    expect(reread.title).toBe(EDITED);

    expect((await post(`/${id}/approve`)).status).toBe(200);
    const sent = JSON.parse(ghWrites()[0].body) as { title: string; body: string };
    expect(sent.title).toContain(EDITED);
    expect(sent.title, 'the title the owner replaced was published anyway')
      .not.toContain(ORIGINAL.title);
    expect(sent.body).toContain(EDITED_FIX);
    expect(sent.body, 'the text the owner replaced was published anyway')
      .not.toContain(ORIGINAL.fixIdeas);
  });
});

// ── the delivery the card promises is the delivery the route performs ───────────────────

describe('the card\'s sentence and the route\'s branch answer the same question', () => {
  it('an unconnected box promises a file, and gets a file', async () => {
    const id = awaiting();
    expect(postTargetSentence({ connected: false, login: null, loginInProgress: false }))
      .toContain('Nothing is sent');
    const res = await post(`/${id}/approve`);
    const data = (await bodyOf(res)).data!;
    expect(data.issueUrl).toBeNull();
    expect(String(data.exportPath)).toContain('report.md');
  });

  it('a connected box promises a PUBLIC issue under the owner\'s own name', () => {
    saveGithubAccount('octocat', TOKEN, 'public_repo');
    const sentence = postTargetSentence({ connected: true, login: 'octocat', loginInProgress: false });
    expect(sentence).toContain('public');
    expect(sentence, 'the card must name WHICH GitHub identity posts').toContain('octocat');
  });

  it('...and a sign-in open ON TOP of a live connection still promises the issue', () => {
    // ⚠ THE ONE CASE WHERE `githubCardState` IS THE WRONG PREDICATE, AND WHY THIS CLAUSE EXISTS.
    // T5's card answers "which of four cards to draw", and there `connecting` OUTRANKS
    // `connected` — correct for that question. The question here is different: "will pressing
    // Post publish, or write a file?" The route answers it from the TOKEN (`githubStatus()
    // .connected`), so a card that re-derived the promise from `githubCardState` would say
    // "saved as a file on this Mac, nothing is sent" at the exact moment the route publishes a
    // public issue. That is a consent gate telling the truth's opposite, which is D4 inverted.
    saveGithubAccount('octocat', TOKEN, 'public_repo');
    const sentence = postTargetSentence({ connected: true, login: 'octocat', loginInProgress: true });
    expect(sentence).toContain('public');
    expect(sentence).not.toContain('Nothing is sent');
  });

  it('a connection with no name says so instead of printing null', () => {
    const sentence = postTargetSentence({ connected: true, login: null, loginInProgress: false });
    expect(sentence).toContain('public');
    expect(sentence).not.toContain('null');
  });
});

// ── 4. NO AGENT-FACING TWIN ─────────────────────────────────────────────────────────────

describe('no agent-facing approval twin exists', () => {
  it('no tool and no A2A path can approve a report', () => {
    const toolSrc = fs.readFileSync(path.join(SRC, 'agent', 'tools', 'definitions.ts'), 'utf8');
    expect(/approve_report|report_approve|report_post/.test(toolSrc)).toBe(false);
  });

  it('the approve route does not wake an agent the way destructive-gate does', () => {
    const route = fs.readFileSync(path.join(SRC, 'gateway', 'routes', 'reports.ts'), 'utf8');
    for (const forbidden of ['requestApproval', 'handleMessage', 'getAgentRuntime', 'grantApprovalForSignature']) {
      expect(route, `the report route reached ${forbidden} — an agent must not be in this loop`)
        .not.toContain(forbidden);
    }
  });
});

// ── the router's own inventory ──────────────────────────────────────────────────────────

describe('the route list and the frame list check themselves', () => {
  const ROUTE_PATHS: ReadonlyArray<readonly [string, string]> = [
    ['GET', '/'], ['GET', '/:id'], ['PATCH', '/:id'],
    ['POST', '/:id/approve'], ['POST', '/:id/cancel'],
  ];

  it('the router exposes exactly the declared routes — it cannot go stale', () => {
    // T4's fix-round-3 lesson, inherited verbatim: filter middleware by METHOD AND PATH. A real
    // `.all('/x', h)` handler is recorded as `ALL /x` and discarding it by method alone is how a
    // route hides at full green.
    const middleware = reportsRouter.routes.filter(r => r.method === 'ALL' && r.path === '/*');
    expect(middleware, 'this router grew middleware — re-check that the filter below still only '
      + 'removes middleware, and that no `.all()` handler hides behind it').toEqual([]);
    const real = [...new Set(
      reportsRouter.routes
        .filter(r => !(r.method === 'ALL' && r.path === '/*'))
        .map(r => `${r.method} ${r.path}`),
    )].sort();
    expect(real.length, 'the router exposes no routes — this clause would pass over nothing')
      .toBeGreaterThan(0);
    expect(
      real,
      'a route exists that this file does not drive. Add it to ROUTE_PATHS — and if it can '
      + 'reach the approval, say why it is safe.',
    ).toEqual(ROUTE_PATHS.map(([m, p]) => `${m} ${p}`).sort());
  });

  it('no /api/reports answer carries the GitHub token', async () => {
    saveGithubAccount('octocat', TOKEN, 'public_repo');
    const id = awaiting();
    for (const [method, p] of ROUTE_PATHS) {
      const res = await reportsRouter.request(p.replace(':id', id), { method });
      const text = await res.text();
      expect(text.length, `${method} ${p} answered with an empty body`).toBeGreaterThan(0);
      expect(text, `${method} ${p} put the token in its response body`).not.toContain(TOKEN);
    }
  });

  it('the report frame types this server can emit are exactly the two declared', () => {
    // A SOURCE census (T4/T5's pattern), scoped to the `report:` prefix. It answers "what CAN be
    // emitted", which a behavioural sweep cannot: a sweep only ever proves what DID fire.
    const DECLARED = ['report:pending', 'report:resolved'];
    const emitted = new Set<string>();
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== '__tests__' && e.name !== 'node_modules') walk(p); continue; }
        if (!e.name.endsWith('.ts')) continue;
        const code = fs.readFileSync(p, 'utf8').split('\n')
          .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
        for (const m of code.matchAll(/type\s*:\s*['"`](report:[a-z_]+)['"`]/g)) emitted.add(m[1]);
      }
    };
    walk(SRC);
    expect(emitted.size, 'the frame reader found no report frames at all — it is broken')
      .toBeGreaterThan(0);
    expect(
      [...emitted].sort(),
      'the set of report frame types this server can broadcast changed. Declare it here, add it '
      + 'to `WsEvent` + `EVENT_BATCHABLE` in packages/shared/src/ws.ts, and say what the card '
      + 'should do with it.',
    ).toEqual(DECLARED);
    const ws = fs.readFileSync(path.resolve(SRC, '../../shared/src/ws.ts'), 'utf8');
    for (const t of DECLARED) {
      expect(ws, `${t} is broadcast but not declared in the WsEvent union`).toContain(`type: '${t}'`);
      expect(ws, `${t} has no EVENT_BATCHABLE row`).toContain(`'${t}':`);
    }
  });
});

// ── the card holds no copy of a rule the lib is guarding ────────────────────────────────

describe('the card renders, and decides nothing on its own', () => {
  // Comment lines dropped: this file's own header NAMES the things it refuses to do, and a
  // census that counted its documentation as a violation would teach the next author to delete
  // the explanation. Non-vacuity is asserted in each clause that uses it.
  const card = (): string => fs.readFileSync(CARD, 'utf8')
    .split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

  it('state is replaced from the door, never merged from a frame', () => {
    // T5's banked census, applied to the card that matters most. The feared edit has ONE visible
    // shape: a second `setReports(`. ⚠ DECLARED BOUNDARY, stated so nobody files it as a defect:
    // an ALIASED setter (`const s = setReports; subscribe('x', m => s(m))`) is invisible here.
    // That is a deliberate evasion, not the "optimise the refetch into a merge from the frame's
    // fields" edit this exists to catch.
    const src = card();
    const calls = [...src.matchAll(/setReports\(/g)];
    expect(calls.length, 'the card stopped setting its list at all — this census is broken')
      .toBeGreaterThan(0);
    expect(
      calls.length,
      'a second `setReports(` appeared. The frame is a PING carrying {id,title} and nothing '
      + 'else (T3); merging it would draw a card from a payload that has no brief in it.',
    ).toBe(1);
  });

  it('the consent sentences live in the lib, so this card cannot grow a second copy', () => {
    const src = card();
    expect(src.length, 'the comment stripper ate the card — this census is broken').toBeGreaterThan(1000);
    expect(src, 'the card must render the served sentence, not its own').toContain('postTargetSentence');
    // The two claims a wrong copy would make. Neither may be spelled out in the .tsx.
    expect(src.toLowerCase()).not.toContain('anyone can read it');
    expect(src.toLowerCase()).not.toContain('nothing is sent');
  });

  it('the card cannot post without the route, and names no host of its own', () => {
    const src = card();
    for (const forbidden of ['api.github.com', 'fetch(', 'approveOnce']) {
      expect(src, `the card reached ${forbidden} directly`).not.toContain(forbidden);
    }
  });

  // ── T7: the duplicate question is a SECOND consent sentence, and it lives in the lib too ──
  // The panel was split out of the card when this question arrived (the card was at 235 lines
  // against the growth detector's 240-line crossing). A split is only safe if the census follows
  // it: an unwatched .tsx is exactly where a second copy of a claim about the owner's words goes.

  it('the delivery panel decides nothing, names no host, and copies no sentence', () => {
    const src = fs.readFileSync(DELIVERY_PANEL, 'utf8')
      .split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    expect(src.length, 'the comment stripper ate the panel — this census is broken').toBeGreaterThan(800);
    expect(src, 'the panel must render the lib\'s question, not its own').toContain('duplicateQuestion');
    for (const forbidden of ['api.github.com', 'fetch(', 'approveOnce', 'useState']) {
      expect(src, `the delivery panel reached ${forbidden}`).not.toContain(forbidden);
    }
    expect(src.toLowerCase()).not.toContain('already reported this');
  });

  it('the question names the issue it is asking about, and offers both answers', () => {
    const asked = duplicateQuestion({
      number: 42, url: 'https://github.com/d-cornerpin/dojo/issues/42',
      title: 'work_open refuses a granted category',
    });
    expect(asked, 'the owner is asked to agree to an issue they cannot identify').toContain('42');
    expect(asked).toContain('work_open refuses a granted category');
    expect(asked.toLowerCase()).toContain('add your details');
    expect(asked.toLowerCase(), 'the second answer was not offered').toContain('separate');
  });

  it('a match with no title is still identified, and never prints an empty quotation', () => {
    const asked = duplicateQuestion({ number: 7, url: 'https://example.invalid/7', title: '   ' });
    expect(asked).toContain('#7');
    expect(asked).not.toContain('“”');
    expect(asked).not.toContain('undefined');
  });

  it('the brief is rendered verbatim — no markdown renderer stands between it and the owner', () => {
    // D4's sharpest edge, and the one a "polish the card" commit is most likely to cross. A
    // markdown renderer shows *emphasis* where the text says `*emphasis*`, so the owner would
    // approve one thing and publish another. The brief's fields go into `whitespace-pre-wrap`
    // and nothing else. (The paired behavioural half is the byte-for-byte clause above, which
    // drives the real route with markdown-hostile text and reads the exported file.)
    const src = card();
    expect(src, 'the card renders the brief with whitespace preserved and nothing interpreted')
      .toContain('whitespace-pre-wrap');
    for (const renderer of ['Markdown', 'dangerouslySetInnerHTML', 'marked', 'remark']) {
      expect(src, `the card ran the brief through ${renderer}`).not.toContain(renderer);
    }
  });
});

// ── the form's own rules ────────────────────────────────────────────────────────────────

describe('the form refuses to ask for consent to nothing', () => {
  it('a brief with an empty field is not postable, and the reason names the field', () => {
    const verdict = briefIsPostable({ ...BRIEF, whatHappened: '   ' });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain('whatHappened');
  });

  it('a whole brief is postable', () => {
    expect(briefIsPostable({ ...BRIEF }).ok).toBe(true);
  });

  it('every moved field is reported, and only the moved ones', () => {
    const edits = briefEditsFor(
      { ...BRIEF },
      { ...BRIEF, whatHappened: 'changed', fixIdeas: 'also changed' },
    );
    expect(Object.keys(edits).sort()).toEqual(['fixIdeas', 'whatHappened']);
    expect(edits.whatHappened).toBe('changed');
  });
});
