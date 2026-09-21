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
//   ANNOTATE, NEVER DELETE — a row the battery OVERWROTE. `sendgrid` (the owner's, created
//     2026-06-21 by kevin, clobbered 2026-09-21 06:42:22) and `openweather` (clobbered
//     2026-09-20 23:29:08). The value in them is junk, but the ROW is the owner's: its name,
//     its age, its description are the only surviving record of what the slot was for and
//     that something happened to it. Deleting it would erase the evidence of the damage
//     along with the damage. The owner must re-enter these, and the row is how they find out.
//
// EVERY DELETION IS CHECKED AGAINST THE EVIDENCE THAT NAMED IT. The inventory below carries,
// per row, the `created_by_agent_id` and `created_at` the audit independently verified against
// `~/.dojo/data/dojo.db`. A row whose provenance does not match is KEPT and reported under
// `keptForReview` — a purge that deletes on name alone is a purge that eats a real credential
// the day somebody reuses a name. `stripe` and the owner's `stripe_live` / `stripe_test` are
// exactly that hazard, one letter apart.
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
];

/**
 * The TWO rows the battery overwrote. Annotated, never deleted. The note is PREPENDED so the
 * original description survives underneath it — that text is the only remaining statement of
 * what the slot was for.
 */
const TO_ANNOTATE: Array<{ serviceName: string; note: string }> = [
  { serviceName: 'sendgrid', note:
    `${NEEDS_REENTRY} the value in this slot is NOT yours. A test run overwrote your real SendGrid key ` +
    `on 2026-09-21 06:42:22 with a synthetic "sk-live-…" value (it returns 401/403 against SendGrid). ` +
    `Your original key, created 2026-06-21, is unrecoverable — there was no prior version. ` +
    `Generate a fresh SendGrid key (SG.<id>.<secret>) and save it over this row. ` +
    `Original description follows.` },
  { serviceName: 'openweather', note:
    `${NEEDS_REENTRY} the value in this slot is NOT yours. A test run overwrote your real OpenWeather key ` +
    `on 2026-09-20 23:29:08 with a synthetic "sk-live-…" value. The original, created 2026-08-04, ` +
    `is unrecoverable — there was no prior version. Re-issue an OpenWeather key and save it over this row. ` +
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
    deleteCredentialByService(target.serviceName, null);
    logger.warn('Battery-residue purge: deleted a synthetic credential row', {
      serviceName: target.serviceName, createdAt: row.created_at, evidence: target.evidence,
    });
  }

  const described = new Map(listCredentials().map((r) => [r.serviceName, r.description ?? '']));
  for (const target of TO_ANNOTATE) {
    const current = described.get(target.serviceName);
    if (current === undefined) { absent.push(target.serviceName); continue; }
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
