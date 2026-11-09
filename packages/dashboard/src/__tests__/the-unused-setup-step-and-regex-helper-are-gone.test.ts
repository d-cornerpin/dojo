import { it, expect } from 'vitest';
import * as cp from '../lib/credential-placeholder';
it('credentialPlaceholderLeadingRe is not exported', () => { expect(Object.keys(cp)).not.toContain('credentialPlaceholderLeadingRe'); });
it('the live helper still works', () => { expect(cp.splitCredentialPlaceholders('a<redacted-credential>b').map((s) => s.kind)).toEqual(['text', 'credential', 'text']); });
