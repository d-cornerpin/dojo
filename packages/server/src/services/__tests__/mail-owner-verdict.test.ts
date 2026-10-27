import { describe, it, expect } from 'vitest';
import { ownerEmailVerdict } from '../mail-owner-verdict.js';

// Small header builder so each case reads as one line of mail.
const h = (name: string, value: string) => ({ name, value });

// Provider shapes as the mail servers write them. Gmail's `Authentication-Results`
// carries the authserv-id; Exchange (Outlook) writes it with no authserv-id.
const GMAIL_PASS =
  'mx.google.com; dkim=pass header.i=@example.org; spf=pass smtp.mailfrom=owner@example.org; dmarc=pass (p=NONE sp=NONE dis=NONE) header.from=example.org';
const OUTLOOK_PASS =
  'spf=pass smtp.mailfrom=example.org; dkim=pass header.d=example.org; dmarc=pass action=none header.from=example.org';

const OWNER = 'owner@example.org';

describe('ownerEmailVerdict', () => {
  // ── Aligned pass proves the owner ──

  it('gmail: aligned dmarc=pass with the From domain is the owner', () => {
    expect(ownerEmailVerdict({
      provider: 'gmail',
      from: 'Owner Name <owner@example.org>',
      headers: [h('Authentication-Results', GMAIL_PASS)],
      ownerAddresses: [OWNER],
    })).toEqual({ verdict: 'owner' });
  });

  it('outlook: aligned dmarc=pass with the From domain is the owner', () => {
    expect(ownerEmailVerdict({
      provider: 'outlook',
      from: 'Owner Name <owner@example.org>',
      headers: [h('Authentication-Results', OUTLOOK_PASS)],
      ownerAddresses: [OWNER],
    })).toEqual({ verdict: 'owner' });
  });

  // ── dmarc not pass ──

  it('gmail: dmarc=fail is unconfirmed (dmarc_not_pass)', () => {
    const v = 'mx.google.com; dkim=pass header.i=@example.org; spf=pass smtp.mailfrom=owner@example.org; dmarc=fail (p=NONE sp=NONE dis=NONE) header.from=example.org';
    expect(ownerEmailVerdict({
      provider: 'gmail',
      from: 'Owner Name <owner@example.org>',
      headers: [h('Authentication-Results', v)],
      ownerAddresses: [OWNER],
    })).toEqual({ verdict: 'unconfirmed', reason: 'dmarc_not_pass' });
  });

  it('gmail: dmarc=none is unconfirmed (dmarc_not_pass)', () => {
    const v = 'mx.google.com; dkim=pass header.i=@example.org; spf=pass smtp.mailfrom=owner@example.org; dmarc=none (p=NONE sp=NONE dis=NONE) header.from=example.org';
    expect(ownerEmailVerdict({
      provider: 'gmail',
      from: 'Owner Name <owner@example.org>',
      headers: [h('Authentication-Results', v)],
      ownerAddresses: [OWNER],
    })).toEqual({ verdict: 'unconfirmed', reason: 'dmarc_not_pass' });
  });

  it('gmail: a header with no dmarc segment is unconfirmed (dmarc_not_pass)', () => {
    const v = 'mx.google.com; dkim=pass header.i=@example.org; spf=pass smtp.mailfrom=owner@example.org';
    expect(ownerEmailVerdict({
      provider: 'gmail',
      from: 'Owner Name <owner@example.org>',
      headers: [h('Authentication-Results', v)],
      ownerAddresses: [OWNER],
    })).toEqual({ verdict: 'unconfirmed', reason: 'dmarc_not_pass' });
  });

  // ── No provider auth result ──

  it('no Authentication-Results header at all is unconfirmed (no_auth_header)', () => {
    expect(ownerEmailVerdict({
      provider: 'gmail',
      from: 'Owner Name <owner@example.org>',
      headers: [h('Received', 'from mail.example')],
      ownerAddresses: [OWNER],
    })).toEqual({ verdict: 'unconfirmed', reason: 'no_auth_header' });
  });

  it('only ARC-Authentication-Results carrying a perfect pass is unconfirmed (no_auth_header)', () => {
    expect(ownerEmailVerdict({
      provider: 'gmail',
      from: 'Owner Name <owner@example.org>',
      headers: [h('ARC-Authentication-Results', GMAIL_PASS)],
      ownerAddresses: [OWNER],
    })).toEqual({ verdict: 'unconfirmed', reason: 'no_auth_header' });
  });

  // ── Unaligned pass ──

  it('gmail: pass with header.from on another domain is unconfirmed (dmarc_unaligned)', () => {
    const v = 'mx.google.com; dkim=pass header.i=@example.org; spf=pass smtp.mailfrom=owner@example.org; dmarc=pass (p=NONE sp=NONE dis=NONE) header.from=other.example';
    expect(ownerEmailVerdict({
      provider: 'gmail',
      from: 'Owner Name <owner@example.org>',
      headers: [h('Authentication-Results', v)],
      ownerAddresses: [OWNER],
    })).toEqual({ verdict: 'unconfirmed', reason: 'dmarc_unaligned' });
  });

  it('gmail: a pass segment with no header.from= is unconfirmed (dmarc_unaligned)', () => {
    const v = 'mx.google.com; dkim=pass header.i=@example.org; spf=pass smtp.mailfrom=owner@example.org; dmarc=pass (p=NONE sp=NONE dis=NONE)';
    expect(ownerEmailVerdict({
      provider: 'gmail',
      from: 'Owner Name <owner@example.org>',
      headers: [h('Authentication-Results', v)],
      ownerAddresses: [OWNER],
    })).toEqual({ verdict: 'unconfirmed', reason: 'dmarc_unaligned' });
  });

  // ── Look-alike addresses: exact equality only ──

  it('look-alike From own-er@example.org is unconfirmed (from_not_owner)', () => {
    expect(ownerEmailVerdict({
      provider: 'gmail',
      from: 'Owner Name <own-er@example.org>',
      headers: [h('Authentication-Results', GMAIL_PASS)],
      ownerAddresses: [OWNER],
    })).toEqual({ verdict: 'unconfirmed', reason: 'from_not_owner' });
  });

  it('look-alike From owner@example.org.evil is unconfirmed (from_not_owner)', () => {
    expect(ownerEmailVerdict({
      provider: 'gmail',
      from: 'Owner Name <owner@example.org.evil>',
      headers: [h('Authentication-Results', GMAIL_PASS)],
      ownerAddresses: [OWNER],
    })).toEqual({ verdict: 'unconfirmed', reason: 'from_not_owner' });
  });

  // ── From must hold exactly one address ──

  it('From with two bare addresses is unconfirmed (from_not_single)', () => {
    expect(ownerEmailVerdict({
      provider: 'gmail',
      from: 'a@example.org, owner@example.org',
      headers: [h('Authentication-Results', GMAIL_PASS)],
      ownerAddresses: [OWNER],
    })).toEqual({ verdict: 'unconfirmed', reason: 'from_not_single' });
  });

  it('From with two angle-bracket addresses is unconfirmed (from_not_single)', () => {
    expect(ownerEmailVerdict({
      provider: 'gmail',
      from: 'Owner <owner@example.org>, Other <o@x.com>',
      headers: [h('Authentication-Results', GMAIL_PASS)],
      ownerAddresses: [OWNER],
    })).toEqual({ verdict: 'unconfirmed', reason: 'from_not_single' });
  });

  // ── Topmost provider header wins ──

  it('gmail: a lower mx.google.com pass header does not override a topmost fail', () => {
    const top = 'mx.google.com; dkim=pass header.i=@example.org; spf=pass smtp.mailfrom=owner@example.org; dmarc=fail (p=NONE sp=NONE dis=NONE) header.from=example.org';
    const lower = 'mx.google.com; dkim=pass header.i=@example.org; spf=pass smtp.mailfrom=owner@example.org; dmarc=pass (p=NONE sp=NONE dis=NONE) header.from=example.org';
    expect(ownerEmailVerdict({
      provider: 'gmail',
      from: 'Owner Name <owner@example.org>',
      headers: [h('Authentication-Results', top), h('Authentication-Results', lower)],
      ownerAddresses: [OWNER],
    })).toEqual({ verdict: 'unconfirmed', reason: 'dmarc_not_pass' });
  });

  it('gmail: a topmost non-mx.google.com pass is ignored; the real mx.google.com fail wins', () => {
    const evil = 'evil.example; dkim=pass header.i=@example.org; spf=pass smtp.mailfrom=owner@example.org; dmarc=pass (p=NONE sp=NONE dis=NONE) header.from=example.org';
    const real = 'mx.google.com; dkim=pass header.i=@example.org; spf=pass smtp.mailfrom=owner@example.org; dmarc=fail (p=NONE sp=NONE dis=NONE) header.from=example.org';
    expect(ownerEmailVerdict({
      provider: 'gmail',
      from: 'Owner Name <owner@example.org>',
      headers: [h('Authentication-Results', evil), h('Authentication-Results', real)],
      ownerAddresses: [OWNER],
    })).toEqual({ verdict: 'unconfirmed', reason: 'dmarc_not_pass' });
  });

  // ── No owner addresses ──

  it('empty ownerAddresses is unconfirmed (no_owner_addresses)', () => {
    expect(ownerEmailVerdict({
      provider: 'gmail',
      from: 'Owner Name <owner@example.org>',
      headers: [h('Authentication-Results', GMAIL_PASS)],
      ownerAddresses: [],
    })).toEqual({ verdict: 'unconfirmed', reason: 'no_owner_addresses' });
  });

  it('blank-only ownerAddresses is unconfirmed (no_owner_addresses)', () => {
    expect(ownerEmailVerdict({
      provider: 'gmail',
      from: 'Owner Name <owner@example.org>',
      headers: [h('Authentication-Results', GMAIL_PASS)],
      ownerAddresses: ['  '],
    })).toEqual({ verdict: 'unconfirmed', reason: 'no_owner_addresses' });
  });

  // ── Owner list normalisation ──

  it('a mixed-case, padded owner address still matches', () => {
    expect(ownerEmailVerdict({
      provider: 'gmail',
      from: 'Owner Name <owner@example.org>',
      headers: [h('Authentication-Results', GMAIL_PASS)],
      ownerAddresses: ['  Owner@Example.org '],
    })).toEqual({ verdict: 'owner' });
  });
});
