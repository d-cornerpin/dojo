// Deliverable-claim classifier (2026-07-18 confabulation incident).
//
// The pure claim-shape predicate + the receipt-tier gate that grounds it. The
// floor in loop.ts pairs a positive match with a zero-receipt check before it
// steers once; these tests pin the two pieces the floor is built on.

import { describe, it, expect } from 'vitest';
import {
  detectDeliverableClaim,
  hadReceiptToolThisTurn,
  RECEIPT_TOOLS,
} from '../classifiers/deliverable-claim.js';

describe('detectDeliverableClaim: claim-shape predicate (pure)', () => {
  it('flags the production confabulation "Longhorizon report is compiled"', () => {
    const d = detectDeliverableClaim(
      '((mood: success)) Longhorizon report is compiled, assembled the contributions from both specialists into the final combined report',
    );
    expect(d.matched).toBe(true);
    expect(d.pattern).toBeTruthy();
  });

  it('flags the image confabulation "The new photo is done and posted in the dashboard"', () => {
    const d = detectDeliverableClaim('The new photo is done and posted in the dashboard, go check it out.');
    expect(d.matched).toBe(true);
  });

  it('flags verb-then-artifact ("generated the summary")', () => {
    expect(detectDeliverableClaim('All set, I generated the summary you asked for.').matched).toBe(true);
  });

  it('does NOT flag a bare "Saved." (no artifact noun, so no claim shape)', () => {
    expect(detectDeliverableClaim('Saved.').matched).toBe(false);
  });

  it('does NOT flag a plain acknowledgement with no completion claim', () => {
    expect(detectDeliverableClaim('On it, give me a moment.').matched).toBe(false);
    expect(detectDeliverableClaim('Sure, what would you like the report to cover?').matched).toBe(false);
  });

  it('does NOT join a completion verb and an artifact noun across sentences', () => {
    // "compiled" and "report" live in separate clauses, not one claim.
    expect(
      detectDeliverableClaim('I compiled my thoughts. What should the report include?').matched,
    ).toBe(false);
  });

  it('returns matched:false for empty / trivial input', () => {
    expect(detectDeliverableClaim('').matched).toBe(false);
    expect(detectDeliverableClaim(null).matched).toBe(false);
    expect(detectDeliverableClaim(undefined).matched).toBe(false);
  });
});

describe('hadReceiptToolThisTurn: receipt-tier gate', () => {
  it('a receipt-backed "Saved." is grounded (vault_remember succeeded)', () => {
    const grounded = hadReceiptToolThisTurn([{ name: 'vault_remember', isError: false }]);
    expect(grounded).toBe(true);
  });

  it('grounds a report claim when a file was written this turn', () => {
    expect(hadReceiptToolThisTurn([{ name: 'file_write', isError: false }])).toBe(true);
  });

  it('does NOT count a read-only tool (tracker_get_status) as a receipt', () => {
    expect(hadReceiptToolThisTurn([{ name: 'tracker_get_status', isError: false }])).toBe(false);
    expect(hadReceiptToolThisTurn([{ name: 'vault_search', isError: false }])).toBe(false);
  });

  it('does NOT count a receipt-tier tool that ERRORED', () => {
    expect(hadReceiptToolThisTurn([{ name: 'file_write', isError: true }])).toBe(false);
  });

  it('empty tool results = no receipt (the confabulation turn)', () => {
    expect(hadReceiptToolThisTurn([])).toBe(false);
  });

  it('RECEIPT_TOOLS mirrors the harness artifact/receipt list', () => {
    // A representative spread of the anomaly.mjs list; drift here would decouple
    // the live floor from the dev-harness report.
    for (const t of ['file_write', 'exec', 'vault_remember', 'tracker_update_status', 'image_create', 'complete_task']) {
      expect(RECEIPT_TOOLS.has(t)).toBe(true);
    }
    // read-only tools are NOT receipts
    expect(RECEIPT_TOOLS.has('tracker_get_status')).toBe(false);
    expect(RECEIPT_TOOLS.has('vault_search')).toBe(false);
  });
});
