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
  createReport, attachDraft, submitForApproval, getReport, cancelReport, type ReportBrief,
} from '../../../report/store.js';
import { saveGithubAccount, disconnectGithub } from '../../../github/account.js';
import { briefEditsFor, briefIsPostable, postTargetSentence, type BriefFields }
  from '../../../../../dashboard/src/lib/report-edits.js';

const SRC = path.resolve(__dirname, '..', '..', '..');
const CARD = path.resolve(SRC, '../../dashboard/src/components/ReportPreviewCard.tsx');

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
const post = async (p: string): Promise<Response> => reportsRouter.request(p, { method: 'POST' });
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
  disconnectGithub();
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

// ── 1. ONE DOOR ─────────────────────────────────────────────────────────────────────────

describe('nothing but the approve route may spend an approval', () => {
  it('approveOnce is called from exactly one place in the tree', () => {
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== '__tests__') walk(p); continue; }
        if (!p.endsWith('.ts') || p.includes('.test.')) continue;
        const src = fs.readFileSync(p, 'utf8');
        if (/\bapproveOnce\s*\(/.test(src) && !p.endsWith('report/store.ts')) hits.push(p);
      }
    };
    walk(SRC);
    expect(
      hits.map(h => path.relative(SRC, h)).sort(),
      'a second module CALLS approveOnce. The owner\'s one approval is spent by the route '
      + 'behind the Post button and by nothing else (D4). If this is a legitimate new door, it '
      + 'must also be added to ALLOWED_CONSENT_CALLERS in '
      + 'agent/tools/__tests__/the-report-tool-reaches-no-new-door.test.ts.',
    ).toEqual(['gateway/routes/reports.ts']);
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

  it('a decision broadcasts report:resolved so a second tab stops showing the card', async () => {
    const id = awaiting();
    await post(`/${id}/approve`);
    expect(frames.map(f => f.type)).toContain('report:resolved');
    expect(frames.find(f => f.type === 'report:resolved')?.data)
      .toEqual({ id, status: 'posted' });
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

  it('the bytes the card is served are the bytes that reach the exported file', async () => {
    const id = awaiting('ds1-eeeeeeeeeeee', HOSTILE);
    const served = (await bodyOf(await get(`/${id}`))).data?.brief as ReportBrief;
    for (const key of Object.keys(HOSTILE) as Array<keyof ReportBrief>) {
      expect(served[key], `the route transformed \`${key}\` on the way to the card`)
        .toBe(HOSTILE[key]);
    }

    const res = await post(`/${id}/approve`);
    expect(res.status).toBe(200);
    const exportPath = String((await bodyOf(res)).data?.exportPath);
    const written = fs.readFileSync(exportPath, 'utf8');
    for (const key of Object.keys(HOSTILE) as Array<keyof ReportBrief>) {
      expect(written, `\`${key}\` was mangled between the card and the file`)
        .toContain(HOSTILE[key]);
    }
  });

  it('an edited brief posts the EDITED text exactly', async () => {
    // A distinctive original, so "the old text is gone" is a real claim: the shared fixture's
    // one-letter fields appear inside almost any English sentence.
    const ORIGINAL = { ...BRIEF, title: 'THE-TITLE-THE-AGENT-WROTE' };
    const id = awaiting('ds1-ffffffffffff', ORIGINAL);
    const EDITED = 'a title the owner wrote, with *stars* and a #hash';
    expect((await patch(`/${id}`, { title: EDITED })).status).toBe(200);

    // The card re-reads before the owner presses Post: saving is never approving.
    const reread = (await bodyOf(await get(`/${id}`))).data?.brief as ReportBrief;
    expect(reread.title).toBe(EDITED);

    const res = await post(`/${id}/approve`);
    const written = fs.readFileSync(String((await bodyOf(res)).data?.exportPath), 'utf8');
    expect(written).toContain(EDITED);
    expect(written, 'the text the owner replaced was published anyway').not.toContain(ORIGINAL.title);
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
