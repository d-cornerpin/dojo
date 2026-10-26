// namesMoney is the money-vs-window half of provider-error.ts's prose quota check (its line 157;
// consume it at 271). It answers one question for an error TEXT: did the owner's MONEY run out
// (class 'quota' — the owner must act), or is it only a window limit (a wait)? A wrong answer
// either locks a working provider as out of credit or retries forever on a real credit problem, so
// this suite pins its truth table.
//
// CONTRACT: the argument is ALREADY lower-cased by the caller — `classifyProviderErrorText` lowercases
// before calling. 'Billing issue' would arrive as 'billing issue' and count; the capital in the
// original is the caller's job, not namesMoney's, so no case here pins a capital letter.

import { describe, it, expect } from 'vitest';
import { namesMoney, classifyProviderError } from '../provider-error.js';

describe('namesMoney', () => {
  // 1. Money words: the owner is out of credit, so it reads true.
  const money = [
    'insufficient_quota',
    'you have insufficient balance',
    'insufficient_balance',
    'insufficient funds on account',
    'insufficient credit',
    'please check your plan and billing details',
    'exceeded your current quota',
    'you exceeded your current quota, please check your plan and billing details',
  ];
  it.each(money)('reads out-of-credit as true: %j', (text) => {
    expect(namesMoney(text)).toBe(true);
  });

  // 2. A money word beside a window word: the money word wins, because the first branch returns
  //    before the window check is ever consulted.
  it('a money word wins even next to a window word', () => {
    expect(namesMoney('insufficient_quota per minute')).toBe(true);
  });

  // 3. A window is named, so it is a wait even with 'billing' or 'exceeded your current quota'
  //    present — free tiers say "check your plan and billing details" about a per-minute limit.
  const windows = [
    'billing details: 5 requests per minute exceeded',
    'you exceeded your current quota per day',
    'billing problem: resource_exhausted',
    'requests per minute; exceeded your current quota',
  ];
  it.each(windows)('a named window makes it a wait: %j', (text) => {
    expect(namesMoney(text)).toBe(false);
  });

  // 4. No money word at all: neither out of credit nor a window.
  const noMoney = [
    '',
    'quota exceeded',
    'rate limit exceeded',
    'insufficient permissions',
  ];
  it.each(noMoney)('no money word is not out of credit: %j', (text) => {
    expect(namesMoney(text)).toBe(false);
  });

  // 5. End-to-end through classifyProviderError: a plain Error whose message is a money word has no
  //    status, body or transport code, so it falls through to the prose table and reaches the same
  //    namesMoney branch — a money-word message classifies 'quota'.
  it('classifyProviderError routes a money-word message to quota', () => {
    expect(classifyProviderError(new Error('insufficient_quota')).class).toBe('quota');
  });
});
