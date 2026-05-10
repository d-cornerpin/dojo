// v2.3.17 — pure-function tests for the deliverable-shape heuristic that
// drives FYI → DELIVERABLE auto-promotion in a2a-transport. The full
// deliverA2AMessage flow needs DB + agent fixtures; that's covered by
// integration tests. Here we lock down the heuristic so changes don't
// silently regress (false negatives → primary agent stays idle and the
// owner doesn't get pinged about real deliverables).

import { describe, it, expect } from 'vitest';
import { payloadLooksDeliverable } from '../a2a-transport.js';

describe('payloadLooksDeliverable', () => {
  describe('promotes (true)', () => {
    it('payload with a URL alone', () => {
      expect(payloadLooksDeliverable('Check this out: https://hitchstream.com/?p=4253')).toBe(true);
    });

    it('the literal Nora-to-Kevin example from the v2.3.17 bug report', () => {
      const payload = `Draft #21 is ready for David.\n\n**Post ID:** 4253\n**Title:** How to Build a Wedding Day Timeline That Actually Works\n**Preview:** https://hitchstream.com/?p=4253\n**Status:** Draft`;
      expect(payloadLooksDeliverable(payload)).toBe(true);
    });

    it('completion keyword + draft number (no URL)', () => {
      expect(payloadLooksDeliverable('Draft #14 is ready for review')).toBe(true);
    });

    it('completion keyword + post ID (no URL)', () => {
      expect(payloadLooksDeliverable('Post 4253 is now published')).toBe(true);
    });

    it('completion keyword + quoted title', () => {
      expect(payloadLooksDeliverable('Finished writing "The Wedding Timeline Post" — let me know')).toBe(true);
    });

    it('completion keyword + bare longish numeric ID', () => {
      expect(payloadLooksDeliverable('Order 12345 has shipped')).toBe(true);
    });

    it('PR completion notice', () => {
      expect(payloadLooksDeliverable('PR #42 merged and live')).toBe(true);
    });
  });

  describe('does NOT promote (false)', () => {
    it('empty / trivial payloads', () => {
      expect(payloadLooksDeliverable('')).toBe(false);
      expect(payloadLooksDeliverable('hi')).toBe(false);
    });

    it('completion keyword without artefact reference', () => {
      // "I'm done" with no specific artefact shouldn't auto-promote — it's
      // status chatter, not a deliverable.
      expect(payloadLooksDeliverable("I'm done for the day")).toBe(false);
    });

    it('artefact reference without completion keyword', () => {
      // "Working on draft #21" — in progress, not finished.
      expect(payloadLooksDeliverable('Working on draft #21 still')).toBe(false);
    });

    it('plain status update', () => {
      expect(payloadLooksDeliverable('Just checking in, no updates yet')).toBe(false);
    });

    it('question-shaped payload with no URL or artefact', () => {
      expect(payloadLooksDeliverable('Did you want me to start on the next post?')).toBe(false);
    });
  });
});
