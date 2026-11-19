// A call whose arguments did not parse keeps no raw text when its tool declares a secret field.
import { describe, it, expect } from 'vitest';
import { REDACTED_CREDENTIAL, redactDeclaredSecretArgs, redactAssistantBlocksForPersist } from '../secret-fields.js';

const RAW = '{"service_name":"example_service","credentials":{"api_key":"zq9FakeRawText0000000000044';

describe('a garbled call', () => {
  it('a secret tool keeps no raw text in its arguments', () => {
    expect(redactDeclaredSecretArgs('credential_add', { __malformed_args: RAW })).toEqual({ __malformed_args: REDACTED_CREDENTIAL });
  });
  it('the stored copy of the call keeps no raw text either', () => {
    const [stored] = redactAssistantBlocksForPersist('agent-under-test', [{ type: 'tool_use', name: 'credential_add', input: { __malformed_args: RAW } }]);
    expect(JSON.stringify(stored)).not.toContain('zq9FakeRawText');
  });
  it('a tool with no declared secret keeps its raw text, so the model can repair the call', () => {
    const args = { __malformed_args: RAW };
    expect(redactDeclaredSecretArgs('file_read', args)).toBe(args);
  });
});
