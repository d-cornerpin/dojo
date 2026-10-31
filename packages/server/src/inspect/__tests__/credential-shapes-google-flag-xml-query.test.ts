// t285 follow-ups (held items): four more credential shapes the dojo_inspect text scrubber blanks,
// each with a case that is blanked, and neighbours that must stay readable (the round-1 over-blanking
// of ordinary code must not return). Every credential below is a synthetic string built for the test.

import { describe, it, expect } from 'vitest';
import { redactText } from '../redact.js';

const BODY = 'Zq9Xk2Lm4Np6Rs8Tv0Wy1Ab3Cd5Ef7Gh';
const MARK = '<redacted-credential>';

describe('Google client secret and API key', () => {
  it('blanks a GOCSPX- client secret wherever it appears', () => {
    const out = redactText(`oauth client GOCSPX-${BODY} loaded`);
    expect(out).not.toContain(BODY);
    expect(out).toContain('oauth client');
    expect(out).toContain('loaded');
  });
  it('blanks an AIza API key', () => {
    const out = redactText(`using AIza${BODY}ABCD now`);
    expect(out).not.toContain(BODY);
  });
  it('leaves the bare prefix word alone', () => {
    expect(redactText('the GOCSPX- prefix marks a client secret')).toContain('GOCSPX-');
  });
});

describe('the short password flag -p', () => {
  it('blanks the value that follows -p', () => {
    for (const s of [`sshpass -p ${BODY} ssh host`, `tool -p "${BODY}"`, `tool -p '${BODY}'`, 'db-client -p hunter22x']) {
      expect(redactText(s), s).toContain(MARK);
      expect(redactText(s), s).not.toMatch(/Zq9Xk2|hunter22x/);
    }
    expect(redactText(`sshpass -p ${BODY} ssh host`)).toMatch(/^sshpass -p /);
  });
  it('leaves ports, parent-directory flags and paths alone', () => {
    for (const s of ['mkdir -p dist/out', 'mkdir -p "$DIR"', 'mkdir -p ~/.dojo/data', 'ssh -p 2222 host', 'tool -p 8080', 'tar -p backup.tar', 'cp -p src dest', 'rm -rf -p node_modules', 'sudo -p "pw: " rm x']) {
      expect(redactText(s), s).toBe(s);
    }
  });
});

describe('a credential written as an XML element', () => {
  it('blanks the element text, keeps the tags', () => {
    for (const tag of ['password', 'apiKey', 'client_secret', 'access_token', 'Token']) {
      const out = redactText(`<${tag}>${BODY}</${tag}>`);
      expect(out, tag).toBe(`<${tag}>${MARK}</${tag}>`);
    }
    expect(redactText(`<password type="plain">${BODY}</password>`)).not.toContain(BODY);
    expect(redactText(`<secret><![CDATA[${BODY}]]></secret>`)).not.toContain(BODY);
  });
  it('leaves ordinary elements and code-like values alone', () => {
    for (const s of ['<tokens>5</tokens>', '<token_count>1200</token_count>', '<password>{value}</password>', '<token>${TOKEN}</token>', '<secretary>Casey</secretary>', '<password></password>', '<password>...</password>']) {
      expect(redactText(s), s).toBe(s);
    }
  });
});

describe('a generic key= query parameter', () => {
  it('blanks a value that looks like a key', () => {
    const out = redactText(`GET https://api.example.test/v1/items?limit=5&key=${BODY}&alt=json`);
    expect(out).not.toContain(BODY);
    expect(out).toContain('limit=5');
    expect(out).toContain('alt=json');
    expect(redactText(`https://x.test/?access_key=${BODY}`)).not.toContain(BODY);
    expect(redactText(`https://x.test/?a=1&secret_key=${BODY}`)).not.toContain(BODY);
  });
  it('leaves ordinary words, short values and code alone', () => {
    for (const s of ['https://x.test/?key=name', 'https://x.test/?sort_key=created', 'https://x.test/?key=${key}', 'https://x.test/?key=12', 'cache.key=hello-world-thing', 'https://x.test/?key=abcdefghijklmnopqrstuvwxyz']) {
      expect(redactText(s), s).toBe(s);
    }
  });
});
