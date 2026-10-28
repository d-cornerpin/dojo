import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as cp from '../lib/credential-placeholder';
const read = (rel: string) => readFileSync(resolve(__dirname, '..', rel), 'utf8');
it('Setup.tsx has no PasswordStep', () => { expect(read('pages/Setup.tsx')).not.toContain('PasswordStep'); });
it('credentialPlaceholderLeadingRe is not exported', () => { expect(Object.keys(cp)).not.toContain('credentialPlaceholderLeadingRe'); });
it('the live helpers still work', () => { expect(cp.hasCredentialPlaceholder('x <redacted-credential:c1> y')).toBe(true); expect(cp.splitCredentialPlaceholders('a<redacted-credential>b').map((s) => s.kind)).toEqual(['text', 'credential', 'text']); });
