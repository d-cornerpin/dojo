// ════════════════════════════════════════════════════════════════════════════
// T83 — THE BATTERY RESIDUE PURGE.
//
// The behavioural battery's `account-setup-verify-use` family mints deliberately live-looking
// `sk-live-<runId>-<marker>-<rand>` secrets and instructs the agent to SAVE them. The agent
// obliges, against the LIVE store, under REAL service names drawn from a bank (OpenWeather, a
// GitHub, a Stripe, a SendGrid, a NewsAPI). The family has no cleanup, so every draw since
// 2026-08-02 has left a permanent live-looking credential in the owner's Credentials tab.
//
// TWO OUTCOMES, AND THE DIFFERENCE IS WHOSE SLOT IT IS:
//
//   DELETE — a row the battery CREATED. Nothing of the owner's is in it; it is litter, and
//     the only honest thing to do with litter is remove it.
//   ANNOTATE, NEVER DELETE — a row the battery OVERWROTE whose SLOT is still the owner's. The
//     value in it is junk, but the ROW is theirs: its name, its age, its description are the
//     only surviving record of what the slot was for and that something happened to it.
//     Deleting it would erase the evidence of the damage along with the damage.
//
// EVERY ROW IS CHECKED AGAINST THE EVIDENCE THAT NAMED IT — BOTH LISTS. The inventories below
// carry, per row, the `created_by_agent_id` and `created_at` verified against
// `~/.dojo/data/dojo.db`. A row whose provenance does not match is KEPT and reported under
// `keptForReview` — a purge that acts on name alone is a purge that eats a real credential the
// day somebody reuses a name. `stripe` and the owner's `stripe_live` / `stripe_test` are
// exactly that hazard, one letter apart.
//
// ⚠ FIX ROUND (review CRITICAL B-2) — THE ANNOTATE LIST HAD NO SUCH CHECK, AND IT WROTE A
// FALSE STATEMENT INTO THE OWNER'S DASHBOARD. It matched on `service_name` alone — the single
// failure mode the delete path was written to avoid — and on that basis told the owner that
// "your real OpenWeather key" had been overwritten and that "the original, created 2026-08-04"
// was unrecoverable. The live row says otherwise, and re-deriving it settles the question:
//
//     2026-08-04 09:22:06  a battery fixture prompt hands over `sk-live-bmseg8813yo-…`
//     2026-08-04 09:22:11  credential_add("openweather")     → "already exists"
//     2026-08-04 09:22:15  credential_update("openweather")  → whatever stood there is destroyed
//     2026-08-04 09:25:43  credential_add("openweather")     → "stored (id: a9427f42)"
//
// The CURRENT row is `a9427f42`, `created_at = 2026-08-04 09:25:43`,
// `created_by_agent_id = 57b52025-…` (BehaviorBot) — created by the battery, from a
// battery-minted secret, after something deleted the slot between 09:22:15 and 09:25:43 (an
// `add` cannot succeed against an existing name). That is litter by this file's own DELETE
// rule, and the date the note showed the owner as "their" key's creation was the battery's.
// So `openweather` moves to TO_DELETE and its false note goes with it.
//
// WHAT IS TRUE, AND STATED RATHER THAN GUESSED: a credential DID exist under `openweather`
// before the battery era — the 2026-08-02 08:44:32 `credential_add` was refused with "already
// exists", so something was there — and it was destroyed six seconds later by the first
// `credential_update`. Whose it was is UNRECOVERABLE: there are zero `openweather` credential
// tool calls anywhere before 2026-08-02 08:44, and the `messages` table itself only begins
// 2026-07-26 21:00:30, so the row predates every surviving record. The engine cannot honestly
// tell the owner "you lost a key here", and it will not invent one. It is written down here
// instead, which is the right place for a fact nobody can act on.
//
// Idempotent by construction: a deletion that finds no row reports nothing, and an annotation
// whose marker is already present is skipped rather than re-applied.
// ════════════════════════════════════════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { annotateCredential, deleteCredentialByService, listCredentials } from './store.js';
import { createLogger } from '../logger.js';

const logger = createLogger('credentials');

/** The marker the owner will see. Also the idempotence check. */
const NEEDS_REENTRY = '⚠ NEEDS RE-ENTRY —';

interface ResidueRow {
  readonly serviceName: string;
  /** The `created_by_agent_id` the audit verified for this row. */
  readonly createdBy: string | null;
  /** The `created_at` date (YYYY-MM-DD) the audit verified. Guards against a name reused later. */
  readonly createdOn: string;
  /** Why this row is litter — carried into the log line so a deletion is never anonymous. */
  readonly evidence: string;
}

/**
 * The SIX rows the audit enumerated as safe to purge. BehaviorBot's agent id on this box is
 * `57b52025-0b0f-40a6-b916-9efdb9a642a3`; the two `t6b_*` probes were written with no agent
 * attribution at all, which is itself part of their fingerprint.
 */
const TO_DELETE: ResidueRow[] = [
  { serviceName: 'acme_t5b', createdBy: '57b52025-0b0f-40a6-b916-9efdb9a642a3', createdOn: '2026-08-02',
    evidence: 'T5B probe row; "ACME" names no real service the owner has ever connected.' },
  { serviceName: 't6_probe', createdBy: '57b52025-0b0f-40a6-b916-9efdb9a642a3', createdOn: '2026-08-03',
    evidence: 'T6 probe row, self-described as a probe.' },
  { serviceName: 't6b_probe', createdBy: null, createdOn: '2026-08-03',
    evidence: 'T6B probe row, description "T6B probe", no agent attribution.' },
  { serviceName: 't6b_atrest', createdBy: null, createdOn: '2026-08-03',
    evidence: 'T6B at-rest audit row, description "T6B at-rest audit", no agent attribution.' },
  { serviceName: 'stripe', createdBy: '57b52025-0b0f-40a6-b916-9efdb9a642a3', createdOn: '2026-09-21',
    evidence: 'Round-1 account-setup draw (run started 06:28:12); the row\'s own description records the sk-live prefix. The owner\'s real Stripe rows are stripe_live and stripe_test, created 2026-06 by kevin, and are NOT touched.' },
  { serviceName: 'newsapi', createdBy: '57b52025-0b0f-40a6-b916-9efdb9a642a3', createdOn: '2026-09-21',
    evidence: 'Round-3 draw (messages seq 79507, 07:04:24); the row\'s own description says the value is sk-live-shaped and does not match NewsAPI\'s key format.' },
  { serviceName: 'openweather', createdBy: '57b52025-0b0f-40a6-b916-9efdb9a642a3', createdOn: '2026-08-04',
    evidence: 'FIX ROUND (review CRITICAL B-2): row a9427f42 was CREATED by the battery at 09:25:43 from the fixture secret handed over at 09:22:06 — not a slot of the owner\'s that the battery merely overwrote. See this file\'s header for the four-line reconstruction and for what is known about the pre-2026-08-02 row.' },
];

/**
 * The TWO rows the battery overwrote. Annotated, never deleted. The note is PREPENDED so the
 * original description survives underneath it — that text is the only remaining statement of
 * what the slot was for.
 */
interface AnnotateRow extends ResidueRow { readonly note: string }

const TO_ANNOTATE: AnnotateRow[] = [
  // The ONLY row that survives the provenance check as the owner's own: created four months
  // before the battery era, by kevin, from a key the owner provisioned.
  { serviceName: 'sendgrid', createdBy: 'kevin', createdOn: '2026-06-21',
    evidence: 'Created 2026-06-21 03:03:03 by kevin; overwritten 2026-09-21 06:42:22 (messages seq 79103) by a battery-minted sk-live value.',
    note:
    `${NEEDS_REENTRY} the value in this slot is NOT yours. A test run overwrote your real SendGrid key ` +
    `on 2026-09-21 06:42:22 with a synthetic "sk-live-…" value (it returns 401/403 against SendGrid). ` +
    `Your original key, created 2026-06-21, is unrecoverable — there was no prior version. ` +
    `Generate a fresh SendGrid key (SG.<id>.<secret>) and save it over this row. ` +
    `Original description follows.` },
];

export interface PurgeReport {
  /** Rows deleted this run. */
  readonly deleted: string[];
  /** Rows annotated this run (already-annotated rows are not repeated). */
  readonly annotated: string[];
  /** Enumerated rows whose provenance did NOT match the audit — left alone, for a human. */
  readonly keptForReview: string[];
  /** Enumerated rows that were simply not present (an earlier run, or a manual clean-up). */
  readonly absent: string[];
}

export function purgeBatteryResidue(opts?: { dryRun?: boolean }): PurgeReport {
  const dryRun = opts?.dryRun === true;
  const deleted: string[] = [];
  const annotated: string[] = [];
  const keptForReview: string[] = [];
  const absent: string[] = [];

  const rows = getDb().prepare(
    'SELECT service_name, created_by_agent_id, created_at FROM agent_credentials',
  ).all() as Array<{ service_name: string; created_by_agent_id: string | null; created_at: string }>;
  const byName = new Map(rows.map((r) => [r.service_name, r]));

  for (const target of TO_DELETE) {
    const row = byName.get(target.serviceName);
    if (!row) { absent.push(target.serviceName); continue; }
    // WHEN IN DOUBT, KEEP. Both halves must match the audit's own reading of the live table.
    const provenanceMatches =
      (row.created_by_agent_id ?? null) === target.createdBy &&
      row.created_at.startsWith(target.createdOn);
    if (!provenanceMatches) {
      keptForReview.push(target.serviceName);
      logger.warn('Battery-residue purge: KEPT a row whose provenance does not match the audit', {
        serviceName: target.serviceName,
        expectedCreatedBy: target.createdBy, actualCreatedBy: row.created_by_agent_id,
        expectedCreatedOn: target.createdOn, actualCreatedAt: row.created_at,
      });
      continue;
    }
    deleted.push(target.serviceName);
    if (dryRun) continue;
    // T83 FIX ROUND: `confirm: true` at the site, like every other non-agent destroyer. This
    // IS the sanctioned remediation — each row checked against its cited evidence immediately
    // above — and it says so rather than inheriting an exemption.
    deleteCredentialByService(target.serviceName, null, { confirm: true });
    logger.warn('Battery-residue purge: deleted a synthetic credential row', {
      serviceName: target.serviceName, createdAt: row.created_at, evidence: target.evidence,
    });
  }

  const described = new Map(listCredentials().map((r) => [r.serviceName, r.description ?? '']));
  for (const target of TO_ANNOTATE) {
    const current = described.get(target.serviceName);
    if (current === undefined) { absent.push(target.serviceName); continue; }
    // FIX ROUND (review CRITICAL B-2): the SAME check the delete list has, for the same reason
    // one level up. An annotation is a STATEMENT TO THE OWNER about whose value was destroyed;
    // making it on a name match alone is how "your real OpenWeather key" came to be written
    // about a row the battery had created itself.
    const row = byName.get(target.serviceName);
    if (!row || (row.created_by_agent_id ?? null) !== target.createdBy || !row.created_at.startsWith(target.createdOn)) {
      keptForReview.push(target.serviceName);
      logger.warn('Battery-residue purge: REFUSED to annotate a row whose provenance does not match the evidence', {
        serviceName: target.serviceName,
        expectedCreatedBy: target.createdBy, actualCreatedBy: row?.created_by_agent_id ?? null,
        expectedCreatedOn: target.createdOn, actualCreatedAt: row?.created_at ?? null,
      });
      continue;
    }
    if (current.includes(NEEDS_REENTRY)) continue; // already annotated — idempotence
    annotated.push(target.serviceName);
    if (dryRun) continue;
    annotateCredential(target.serviceName, `${target.note}\n\n${current}`);
    logger.warn('Battery-residue purge: annotated a clobbered credential slot for the owner', {
      serviceName: target.serviceName,
    });
  }

  return { deleted, annotated, keptForReview, absent };
}
