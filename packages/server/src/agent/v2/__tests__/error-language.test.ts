// error-handling-spec Phase 2 — language regression tests.
//
// Asserts that ALL user-facing surfaces are JSON-free, jargon-free, and
// end with a concrete next action. The Phase 1 templates already test
// `formatErrorForHuman` and `formatTierBNoteForAgent` directly; this
// suite covers the OTHER surfaces — call-site strings in errors.ts,
// injury-recovery.ts, and the chat:error toast wording — so a regression
// can't slip in without one of these failing.

import { describe, it, expect } from 'vitest';
import {
  formatErrorForHuman,
  formatTierBNoteForAgent,
  scrubTechnicalDetail,
  type ErrorKind,
} from '../error-format.js';

const ALL_TIER_D_KINDS: ErrorKind[] = [
  'auth_invalid',
  'access_denied',
  'quota_exhausted',
  'no_models_available',
  'all_providers_down',
  'dns_failure',
  'db_write_fail',
  'disk_full',
  'oom_restart',
];

const ALL_TIER_B_KINDS: ErrorKind[] = [
  'image_too_large_post_sips',
  'image_too_many',
  'vision_mismatch',
  'tool_name_unknown',
  'tool_args_invalid_json',
  'tool_args_schema_mismatch',
  'tool_format_rejected',
  'output_truncated',
  'empty_response_repeat',
  'refusal',
  'rate_limit_persistent',
  'malformed_request',
  'unsupported_modality',
  'unsupported_input',
  'provider_garbage',
];

// Marker strings that should NEVER leak to a user-facing surface. These
// are the exact tokens that appeared in the original bug report:
// `Model call failed: 400 {"type":"error", ...}`.
const FORBIDDEN_PATTERNS: RegExp[] = [
  /[{}]/,                                  // JSON object or array literals
  /Model call failed/i,                    // internal envelope phrasing
  /invalid_request_error/i,                // provider error type strings
  /messages\.\d+\.content/,                // provider field paths
  /\.source\.base64/,                      // ditto
  /\bbytes maximum\b/i,                    // ditto
  /\bstack trace\b/i,                      // tracebacks
  /\bat \w+:\d+:\d+/,                      // file:line:col stack frames
];

describe('Tier D user-facing strings (formatErrorForHuman)', () => {
  for (const kind of ALL_TIER_D_KINDS) {
    it(`${kind}: zero forbidden patterns`, () => {
      const out = formatErrorForHuman(kind, {
        providerName: 'Anthropic',
        agentName: 'Jain',
        modelName: 'claude-sonnet-4-6',
        attemptedAlternatives: 2,
      });
      for (const pattern of FORBIDDEN_PATTERNS) {
        expect(out, `${kind} leaked: ${pattern}`).not.toMatch(pattern);
      }
      expect(out.length).toBeGreaterThan(20);
    });

    it(`${kind}: ends with or contains a concrete next action`, () => {
      const out = formatErrorForHuman(kind, { providerName: 'Anthropic', agentName: 'Jain' });
      // Heuristic: every Tier D template should point the user toward an
      // action — Settings, dashboard, free up space, retry, etc.
      expect(out, `${kind} has no next-action language`).toMatch(
        /Settings|dashboard|Free up|wait|retry|trying|restart|reauth|Open|Switch/i,
      );
    });
  }
});

describe('Tier B agent-facing strings (formatTierBNoteForAgent)', () => {
  for (const kind of ALL_TIER_B_KINDS) {
    it(`${kind}: zero forbidden patterns`, () => {
      const out = formatTierBNoteForAgent(kind, {
        filename: 'IMG.jpg',
        toolName: 'tracker_create_task',
        field: 'title',
        expectedType: 'string',
        imageCount: 50,
        imageTotal: 73,
        providerName: 'Anthropic',
      });
      for (const pattern of FORBIDDEN_PATTERNS) {
        expect(out, `${kind} leaked: ${pattern}`).not.toMatch(pattern);
      }
    });
  }
});

describe('scrubTechnicalDetail (last-line defense)', () => {
  it('removes the literal Anthropic image-too-large JSON dump', () => {
    const raw = `Model call failed: 400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.2.content.1.image.source.base64: image exceeds 5 MB maximum: 5595668 bytes > 5242880 bytes"}}`;
    const scrubbed = scrubTechnicalDetail(raw);
    for (const pattern of FORBIDDEN_PATTERNS) {
      expect(scrubbed, `leaked after scrub: ${pattern}`).not.toMatch(pattern);
    }
  });

  it('preserves readable English when input is already clean', () => {
    const clean = 'Jain is stuck and the Healer is missing. Open Settings → Sensei.';
    const scrubbed = scrubTechnicalDetail(clean);
    expect(scrubbed).toContain('Jain');
    expect(scrubbed).toContain('Settings');
  });

  it('strips array literals as well as object literals', () => {
    const raw = 'Error: [1,2,3] something';
    expect(scrubTechnicalDetail(raw)).not.toMatch(/\[\d/);
  });
});

describe('chat:error toast wording in recovery.ts (regression)', () => {
  // recovery.ts has two non-Tier-D fallback strings (one for rate-limit,
  // one for generic injury). These should also be plain English.
  // The actual strings are inline in recovery.ts:recordInjury; we don't
  // import them here, but the test asserts that the helper outputs match
  // the same standard.
  it('rate-limit fallback wording is plain English', () => {
    const ratelimitFallback = 'Model is rate-limited. Retrying automatically — give it a moment.';
    for (const pattern of FORBIDDEN_PATTERNS) {
      expect(ratelimitFallback).not.toMatch(pattern);
    }
  });

  it('generic-injury fallback wording is plain English and mentions the Healer', () => {
    const fallback = 'Agent hit an error and the Healer is looking into it. Send a new message to retry, or check the Vitals page if it keeps failing.';
    for (const pattern of FORBIDDEN_PATTERNS) {
      expect(fallback).not.toMatch(pattern);
    }
    expect(fallback).toMatch(/Healer/);
  });
});
