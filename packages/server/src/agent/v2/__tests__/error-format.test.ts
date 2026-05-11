// error-handling-spec Phase 1 — language tests for the single source of
// truth for user-facing and agent-facing error strings.

import { describe, it, expect } from 'vitest';
import {
  formatErrorForHuman,
  formatTierBNoteForAgent,
  scrubTechnicalDetail,
} from '../error-format.js';

describe('formatErrorForHuman (Tier D — user-facing)', () => {
  it('auth_invalid mentions provider + agent + next action', () => {
    const out = formatErrorForHuman('auth_invalid', {
      providerName: 'Anthropic',
      agentName: 'Jain',
    });
    expect(out).toContain('Jain');
    expect(out).toContain('Anthropic');
    expect(out).toContain('Settings');
    expect(out).not.toMatch(/[{}]/); // no JSON
  });

  it('access_denied with attempted alternatives', () => {
    const out = formatErrorForHuman('access_denied', {
      modelName: 'claude-opus-4',
      attemptedAlternatives: 2,
    });
    expect(out).toContain('claude-opus-4');
    expect(out).toContain('2 alternatives');
    expect(out).toContain('Settings');
  });

  it('quota_exhausted names provider and ends with a next action', () => {
    const out = formatErrorForHuman('quota_exhausted', { providerName: 'OpenAI' });
    expect(out).toContain('OpenAI');
    expect(out).toMatch(/Switch|wait|Settings/i);
  });

  it('all_providers_down reassures user that retries continue', () => {
    const out = formatErrorForHuman('all_providers_down');
    expect(out).toMatch(/retry|trying|every \d+/i);
  });

  it('disk_full names the concrete next action', () => {
    const out = formatErrorForHuman('disk_full');
    expect(out).toMatch(/Free up|space/);
  });

  it('NEVER contains JSON or curly braces for any Tier D kind', () => {
    const kinds = [
      'auth_invalid', 'access_denied', 'quota_exhausted',
      'no_models_available', 'all_providers_down', 'dns_failure',
      'db_write_fail', 'disk_full', 'oom_restart',
    ] as const;
    for (const kind of kinds) {
      const out = formatErrorForHuman(kind, { providerName: 'TestProvider' });
      expect(out, `${kind} leaked JSON`).not.toMatch(/[{}]/);
      expect(out, `${kind} leaked tracebacks`).not.toMatch(/stack trace|at \w+:\d+/i);
    }
  });
});

describe('formatTierBNoteForAgent (agent-facing system note bodies)', () => {
  it('image_too_large_post_sips with filename surfaces the file name', () => {
    const note = formatTierBNoteForAgent('image_too_large_post_sips', {
      filename: 'IMG_4521.jpg',
    });
    expect(note).toContain('IMG_4521.jpg');
    expect(note).toContain('Tell the user');
  });

  it('image_too_large_post_sips without filename is still actionable', () => {
    const note = formatTierBNoteForAgent('image_too_large_post_sips');
    expect(note).toContain('Tell the user');
    expect(note).not.toContain('undefined');
  });

  it('image_too_many includes counts when provided', () => {
    const note = formatTierBNoteForAgent('image_too_many', {
      imageCount: 50,
      imageTotal: 73,
    });
    expect(note).toContain('50');
    expect(note).toContain('73');
  });

  it('tool_name_unknown surfaces the bad tool name and points to list_tool_docs', () => {
    const note = formatTierBNoteForAgent('tool_name_unknown', { toolName: 'memry_save' });
    expect(note).toContain('memry_save');
    expect(note).toContain('list_tool_docs');
  });

  it('tool_args_schema_mismatch with field+type surfaces the schema detail', () => {
    const note = formatTierBNoteForAgent('tool_args_schema_mismatch', {
      toolName: 'tracker_create_task',
      field: 'title',
      expectedType: 'string',
    });
    expect(note).toContain('tracker_create_task');
    expect(note).toContain('title');
    expect(note).toContain('string');
  });

  it('vision_mismatch suggests the user switch models', () => {
    const note = formatTierBNoteForAgent('vision_mismatch');
    expect(note).toMatch(/can't see|cannot see/i);
    expect(note).toContain('Settings');
  });

  it('refusal directs the agent to rephrase or end', () => {
    const note = formatTierBNoteForAgent('refusal');
    expect(note).toMatch(/refused|declined/i);
    expect(note).toMatch(/Rephrase|tell the user/i);
  });

  it('rate_limit_persistent with provider name', () => {
    const note = formatTierBNoteForAgent('rate_limit_persistent', { providerName: 'Anthropic' });
    expect(note).toContain('Anthropic');
    expect(note).toMatch(/few minutes|try again/i);
  });

  it('every Tier B template ends with an actionable directive', () => {
    const kinds = [
      'image_too_large_post_sips', 'image_too_many', 'vision_mismatch',
      'tool_name_unknown', 'tool_args_invalid_json', 'tool_args_schema_mismatch',
      'tool_format_rejected', 'output_truncated', 'empty_response_repeat',
      'refusal', 'rate_limit_persistent', 'malformed_request',
      'unsupported_modality', 'unsupported_input', 'provider_garbage',
    ] as const;
    for (const kind of kinds) {
      const note = formatTierBNoteForAgent(kind);
      // Heuristic: every Tier B template should imply an action the agent
      // can take or a message to send the user. Most contain "Tell"/"Re-"/
      // "Try"/"Apologize"/"Continue"/"Adjust".
      expect(note, `${kind} should be actionable`).toMatch(
        /Tell|Re-|Try|Apologize|Continue|Adjust|Rephrase|Mention|Suggest|Use list|End|Update/i,
      );
    }
  });
});

describe('scrubTechnicalDetail', () => {
  it('strips JSON object literals', () => {
    expect(scrubTechnicalDetail('Error: {"type":"invalid_request_error"} happened')).not.toContain('{');
  });

  it('strips known error envelope phrases', () => {
    expect(scrubTechnicalDetail('Model call failed: bad thing')).not.toMatch(/Model call failed/i);
    expect(scrubTechnicalDetail('messages.2.content.1.image fail')).not.toContain('messages.2.content');
  });

  it('preserves the human-readable part', () => {
    const out = scrubTechnicalDetail('Something went wrong (Model call failed: 400)');
    expect(out).toContain('Something went wrong');
  });
});
