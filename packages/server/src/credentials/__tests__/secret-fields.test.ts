// ════════════════════════════════════════════════════════════════════════════
// PHASE-4 T5b (owner ruling P4-R2) — the credential write-path redaction.
//
// THE DEFECT THESE CLAUSES WERE WRITTEN AGAINST, measured on the live box
// before a line of this changed: the owner hands the agent an API key in chat,
// the agent calls `credential_add`, and the key is then at rest in the
// `tool_use` ARGUMENTS of that assistant row — a row replayed to the model
// provider on every later turn — plus, downstream of it, in
// `agent_tool_failures.signature` and in `embeddings.content_preview`.
// (`credential-never-persisted`, run `bmsblb7yzmk`: clause 3 FAIL
// "assistant/owner: 2 row(s)", clause 4 FAIL with the failure signature and the
// preview named.)
//
// WHAT MAKES THIS DIFFERENT FROM A SCRUBBER: every clause below is about a
// DECLARED FIELD. The last two are the important ones — a value that looks
// exactly like a secret in a field nobody declared is left alone, on purpose,
// because the alternative is the prose-keying the phase exists to delete.
// ════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach } from 'vitest';
import {
  SECRET_TOOL_FIELDS,
  REDACTED_CREDENTIAL,
  secretFieldsFor,
  redactDeclaredSecretArgs,
  redactAssistantBlocksForPersist,
  noteDeclaredSecretsFromToolCalls,
  hasHandedCredentialValues,
  redactHandedCredentials,
  forgetHandedCredentialValues,
} from '../secret-fields.js';

const AGENT = 'agent-under-test';
const SECRET = 'sk-live-t5b-0nlyinthisfile-9f2c';

beforeEach(() => forgetHandedCredentialValues());

describe('the enumeration', () => {
  it('is exactly the three declared secret fields on three tools', () => {
    expect([...SECRET_TOOL_FIELDS.keys()].sort()).toEqual(
      ['credential_add', 'credential_update', 'technique_set_placeholder'],
    );
    expect(SECRET_TOOL_FIELDS.get('credential_add')).toEqual(['credentials']);
    expect(SECRET_TOOL_FIELDS.get('credential_update')).toEqual(['credentials']);
    expect(SECRET_TOOL_FIELDS.get('technique_set_placeholder')).toEqual(['value']);
  });

  it('leaves the credential tools that carry no secret INPUT out', () => {
    // credential_get returns a secret; its ARGUMENTS are a service name, and
    // redacting those would blind the cross-turn failure ledger.
    expect(secretFieldsFor('credential_get')).toBeUndefined();
    expect(secretFieldsFor('credential_delete')).toBeUndefined();
    expect(secretFieldsFor('credential_list')).toBeUndefined();
  });
});

describe('redactDeclaredSecretArgs', () => {
  it('replaces every leaf of the declared field and keeps the shape', () => {
    const args = { service_name: 'openweather', credentials: { api_key: SECRET, workspace: 'wx-1' } };
    const out = redactDeclaredSecretArgs('credential_add', args) as typeof args;
    expect(out.credentials).toEqual({ api_key: REDACTED_CREDENTIAL, workspace: REDACTED_CREDENTIAL });
    // The service name is NOT a secret: the failure ledger and the agent's own
    // replayed history both need to know WHICH service this call was about.
    expect(out.service_name).toBe('openweather');
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });

  it('never mutates the arguments the live call runs with', () => {
    const args = { service_name: 'openweather', credentials: { api_key: SECRET } };
    redactDeclaredSecretArgs('credential_add', args);
    expect(args.credentials.api_key).toBe(SECRET);
  });

  it('redacts a non-string secret too (a numeric PIN is a secret)', () => {
    const out = redactDeclaredSecretArgs('credential_add', { credentials: { pin: 481516 } }) as
      { credentials: { pin: unknown } };
    expect(out.credentials.pin).toBe(REDACTED_CREDENTIAL);
  });

  it("takes technique_set_placeholder's value, which is a string field", () => {
    const out = redactDeclaredSecretArgs('technique_set_placeholder',
      { technique: 'weather', label: 'OPENWEATHER_KEY', value: SECRET }) as Record<string, unknown>;
    expect(out.value).toBe(REDACTED_CREDENTIAL);
    expect(out.label).toBe('OPENWEATHER_KEY');
  });

  it('returns the SAME REFERENCE for a tool that declares nothing secret', () => {
    const args = { command: `curl -H "Authorization: Bearer ${SECRET}"` };
    expect(redactDeclaredSecretArgs('exec', args)).toBe(args);
  });

  it('is keyed on the field, NOT on what the value looks like', () => {
    // A secret-shaped string in an undeclared field survives verbatim. This is
    // the deliberate limitation: a value-shaped matcher is the prose-keyed
    // disease, and the fix for a new secret-bearing field is a line in the map.
    const args = { service_name: SECRET, credentials: { api_key: 'x' } };
    const out = redactDeclaredSecretArgs('credential_add', args) as typeof args;
    expect(out.service_name).toBe(SECRET);
  });
});

describe('the persist seam', () => {
  it('keeps the secret out of the stored tool_use arguments', () => {
    const blocks = [
      { type: 'text', text: 'Saving that key now.' },
      { type: 'tool_use', id: 'call_1', name: 'credential_add',
        input: { service_name: 'openweather', credentials: { api_key: SECRET } } },
    ];
    noteDeclaredSecretsFromToolCalls(AGENT, [
      { name: 'credential_add', arguments: { service_name: 'openweather', credentials: { api_key: SECRET } } },
    ]);
    const stored = redactAssistantBlocksForPersist(AGENT, blocks);
    expect(JSON.stringify(stored)).not.toContain(SECRET);
    expect(JSON.stringify(stored)).toContain('openweather');
    // The live array is untouched — the executor still stores the real key.
    expect(JSON.stringify(blocks)).toContain(SECRET);
  });

  it('scrubs the same secret out of the prose the model wrote beside the call', () => {
    noteDeclaredSecretsFromToolCalls(AGENT, [
      { name: 'credential_add', arguments: { credentials: { api_key: SECRET } } },
    ]);
    const stored = redactAssistantBlocksForPersist(AGENT, [
      { type: 'text', text: `I will store ${SECRET} under openweather.` },
    ]);
    expect((stored[0] as { text: string }).text).toBe(
      `I will store ${REDACTED_CREDENTIAL} under openweather.`);
  });

  it('scrubs a secret that a LATER tool call inlines into an unrelated field', () => {
    // The `sshpass -p '<pw>'` case, now reachable from the inbound direction:
    // the agent stored the key, then put it on a curl command line.
    noteDeclaredSecretsFromToolCalls(AGENT, [
      { name: 'credential_add', arguments: { credentials: { api_key: SECRET } } },
    ]);
    const stored = redactAssistantBlocksForPersist(AGENT, [
      { type: 'tool_use', id: 'call_2', name: 'exec', input: { command: `curl -H 'key: ${SECRET}'` } },
    ]);
    expect(JSON.stringify(stored)).not.toContain(SECRET);
  });

  it('is a no-op for an agent that has handled no secret', () => {
    const blocks = [{ type: 'tool_use', id: 'c', name: 'exec', input: { command: 'ls' } }];
    const stored = redactAssistantBlocksForPersist('other-agent', blocks);
    expect(stored[0]).toBe(blocks[0]);
  });
});

describe('the value set', () => {
  it('learns a secret only from a declared field', () => {
    noteDeclaredSecretsFromToolCalls(AGENT, [{ name: 'exec', arguments: { command: SECRET } }]);
    expect(hasHandedCredentialValues(AGENT)).toBe(false);
    noteDeclaredSecretsFromToolCalls(AGENT, [
      { name: 'credential_update', arguments: { credentials: { api_key: SECRET } } },
    ]);
    expect(hasHandedCredentialValues(AGENT)).toBe(true);
    expect(redactHandedCredentials(AGENT, `key=${SECRET}`)).toBe(`key=${REDACTED_CREDENTIAL}`);
  });

  it('never turns a trivial value into a scrub rule', () => {
    noteDeclaredSecretsFromToolCalls(AGENT, [
      { name: 'credential_add', arguments: { credentials: { flag: 'on' } } },
    ]);
    expect(hasHandedCredentialValues(AGENT)).toBe(false);
    expect(redactHandedCredentials(AGENT, 'the lights are on')).toBe('the lights are on');
  });

  it('is per agent', () => {
    noteDeclaredSecretsFromToolCalls(AGENT, [
      { name: 'credential_add', arguments: { credentials: { api_key: SECRET } } },
    ]);
    expect(hasHandedCredentialValues('someone-else')).toBe(false);
    expect(redactHandedCredentials('someone-else', SECRET)).toBe(SECRET);
  });
});
