// t285 — three credential holes in dojo_inspect, each pinned (red before the fix, green after).
//   R1  the text scrubber knows every credential shape the Dojo stores or handles.
//   R2  a config value is blanked at the source (config-shadow.test.ts).
//   R3  code search can only search the Dojo's own repository (see source-remote-scope.test.ts).
// Every credential below is a synthetic string built for the test; none is real.

import { describe, it, expect } from 'vitest';
import { redactText } from '../redact.js';

const BODY = 'Zq9Xk2Lm4Np6Rs8Tv0Wy1Ab3Cd5Ef7Gh';
const MARK = '<redacted-credential>';

describe('R1: redactText knows every shape the Dojo stores or handles', () => {
  it('Google OAuth access and refresh tokens', () => {
    expect(redactText(`got ya29.a0Synthetic_${BODY} ok`)).not.toContain(BODY);
    expect(redactText(`refresh 1//0gSynthetic-${BODY} ok`)).not.toContain(BODY);
  });
  it('a PEM private-key block, whole, with the lines between', () => {
    const pem = `before\n-----BEGIN RSA PRIVATE KEY-----\n${BODY}\nSecondLine${BODY}\n-----END RSA PRIVATE KEY-----\nafter`;
    const out = redactText(pem);
    expect(out).not.toContain(BODY);
    expect(out).not.toContain('BEGIN RSA');
    expect(out).toContain('before');
    expect(out).toContain('after');
  });
  it('a private-key block cut off before its END line is still blanked to the end', () => {
    expect(redactText(`-----BEGIN PRIVATE KEY-----\n${BODY}`)).not.toContain(BODY);
  });
  it('JSON pairs with a credential name, in any case; key and punctuation stay', () => {
    for (const k of ['access_token', 'refresh_token', 'client_secret', 'password', 'Access_Token', 'apiKey', 'api_key']) {
      const out = redactText(`{"${k}":"${BODY}","other":"fine"}`);
      expect(out, k).not.toContain(BODY);
      expect(out, k).toContain(`"${k}":"${MARK}"`);
      expect(out, k).toContain('"other":"fine"');
    }
  });
  it('name=value and name: value in lowercase and mixed case', () => {
    for (const s of [`password=${BODY}`, `client_secret: ${BODY}`, `Api_Key = ${BODY}`, `token: "${BODY}"`, `db_password=hunter22`]) {
      expect(redactText(s), s).not.toMatch(/Zq9Xk2|hunter22/);
    }
    expect(redactText(`password=${BODY}`)).toMatch(/^password=/);
  });
  it('GitHub fine-grained tokens', () => {
    expect(redactText(`x github_pat_11ABCDEFG0${BODY}_${BODY} y`)).not.toContain(BODY);
  });
  it('HTTP Basic auth values', () => {
    const b64 = Buffer.from('someuser:somepassword1').toString('base64');
    expect(redactText(`Authorization: Basic ${b64}`)).not.toContain(b64);
    expect(redactText(`curl -H "authorization: basic ${b64}"`)).not.toContain(b64);
  });
  it('ordinary text is unchanged', () => {
    for (const s of [
      'Please reset your password to continue.',
      'The password field is required, and a token is a string.',
      'commit 3f786850e387550fdab836ed7e6dc881de23001b',
      'id 123e4567-e89b-12d3-a456-426614174000 done',
      'Basic information about the project',
    ]) expect(redactText(s), s).toBe(s);
  });
});

describe('F3: counts, flags and code are not credentials', () => {
  it('lines about tokens as a quantity, and code, are unchanged', () => {
    for (const s of [
      'maxResultTokens: 2000', 'max_tokens: 4096', 'input_tokens: 1234', '"prompt_tokens":1500', 'tokenCount: null',
      'token_budget: 50000', 'tokenizer=cl100k', 'secretary: Bob', 'secret_scanning: enabled',
      'private_key_path=/etc/dojo/key.pem', 'const password = req.body.password;', 'if (token === undefined)',
      'if (token == null) {', 'const hasToken = token !== undefined;', 'token: string;', 'WHERE token = ?',
      'token=${token}; HttpOnly', 'refreshToken = acc?.refreshToken ?? null', "accessToken: 'access_token'",
      'secret: true', 'password: undefined',
    ]) expect(redactText(s), s).toBe(s);
  });
  it('a generated secret in a pair is still blanked', () => {
    for (const s of [`password=${BODY}`, `"client_secret": "${BODY}"`, `token = 'hunter22xyz'`, 'api_key: shppa_FAKE_a1b2c3d4e5f6']) {
      expect(redactText(s), s).toContain(MARK);
    }
  });
});

describe('F4: more shapes', () => {
  const TAIL = 'Rest+Of/Token=Value!Here*$x~';
  it('a Bearer value with + / = ! * $ ~ is blanked whole', () => {
    expect(redactText(`Authorization: Bearer EwB4A${BODY}${TAIL}`)).toBe(`Authorization: Bearer ${MARK}`);
    expect(redactText('Bearer ${credential}')).toBe('Bearer ${credential}');
  });
  it('a password in a URL of any scheme', () => {
    for (const sch of ['wss', 'smtp', 'imaps', 'sftp', 'amqps']) {
      expect(redactText(`${sch}://user:Pw${BODY}@host.example:25/x`), sch).not.toContain(BODY);
    }
  });
  it('a credential flag with a space or = before its value', () => {
    for (const s of [`cloudflared tunnel run --token ${BODY}`, `--password ${BODY}`, `--api-key=${BODY}`, `--secret '${BODY}'`]) {
      expect(redactText(s), s).not.toContain(BODY);
    }
    expect(redactText('--max-tokens 4096 --token-file /x')).toBe('--max-tokens 4096 --token-file /x');
  });
  it('the bare tunnel token (long base64 starting eyJ, no dots)', () => {
    const t = `eyJ${'hIjoiQWJjMTIzNDU2Nzg5MCIsInQiOiJ4eXoifQ'.repeat(3)}==`;
    expect(redactText(`run ${t} now`)).toBe(`run ${MARK} now`);
  });
  it('JSON with escaped quotes (a tool result stored as a JSON string)', () => {
    const stored = JSON.stringify({ content: JSON.stringify({ access_token: BODY, n: 1 }) });
    expect(stored).toContain('\\"access_token\\"');
    const out = redactText(stored);
    expect(out).not.toContain(BODY);
  });
  it('a Cookie header value', () => {
    expect(redactText(`Cookie: session=${BODY}; theme=dark`)).not.toContain(BODY);
  });
});

