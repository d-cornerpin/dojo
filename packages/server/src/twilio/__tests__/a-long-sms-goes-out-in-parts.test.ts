// Twilio refuses a single Body longer than 1600 characters (error 21617), and the three
// engine paths that answer a person who texted in (the end-of-turn reply, the engine ack,
// the A2A relay) all call `sendSms` with whatever the agent wrote. So a normal long answer
// — a summary, a list — comes back as an HTTP 400, `sendSms` returns `{ ok: false }`, and
// the person who asked receives nothing at all. `sendSms` is the single SMS chokepoint: a
// body longer than the carrier limit must go out as several ordered parts, not fail.
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

const recordAtDoorMock = vi.fn();
const recordedIdMock = vi.fn();

vi.mock('../auth.js', () => ({
  getTwilioCreds: () => ({ sid: 'ACfake', token: 'fake' }),
}));
vi.mock('../../agent/v2/outbound.js', () => ({
  recordAtDoor: recordAtDoorMock,
  recordedId: recordedIdMock,
}));

const { sendSms, splitForSms } = await import('../client.js');
const { formatForPlainTextChannel } = await import('../../services/plain-text-format.js');

const TO = '+15550100198';
const FROM = '+15550000001';

let failOnCall = 0; // 1-based POST that answers HTTP 400; 0 = never
let callCount = 0;

const fetchSpy = vi.spyOn(globalThis, 'fetch');

function bodyOfCall(i: number): string {
  const init = fetchSpy.mock.calls[i][1] as RequestInit;
  return new URLSearchParams(String(init.body)).get('Body') ?? '';
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

function words(count: number): string {
  const unit = 'alpha bravo charlie delta echo foxtrot golf hotel india juliett kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu ';
  let s = '';
  while (s.length < count) s += unit;
  return s.slice(0, count).trim();
}

beforeEach(() => {
  recordAtDoorMock.mockReset();
  recordedIdMock.mockReset();
  failOnCall = 0;
  callCount = 0;
  fetchSpy.mockClear().mockImplementation(async (_url: unknown, init?: RequestInit) => {
    callCount++;
    const params = new URLSearchParams(String(init?.body ?? ''));
    if (callCount === failOnCall) {
      return new Response(JSON.stringify({ message: 'x' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({
      sid: 'SMfake1',
      status: 'queued',
      to: params.get('To'),
      from: params.get('From'),
      body: params.get('Body'),
      date_created: 'x',
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
});

// One spy for the whole file: `mockRestore` after every test would un-hook
// `globalThis.fetch` for good, and the next test's `mockImplementation` would
// update a detached spy while production code reached the real fetch.
afterAll(() => {
  fetchSpy.mockRestore();
});

describe('splitForSms', () => {
  it('cuts a 4000-char text at its blank lines, keeps every character, and returns more than one part', () => {
    const paras: string[] = [];
    let total = 0;
    while (total < 4000) {
      const p = words(300);
      paras.push(p);
      total += p.length + 2;
    }
    const text = paras.join('\n\n');
    const parts = splitForSms(text);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) {
      expect(p.length).toBeLessThanOrEqual(1500);
      expect(p.length).toBeGreaterThan(0);
    }
    expect(norm(parts.join(' '))).toBe(norm(text));
  });

  it('never ends a part in the middle of a surrogate pair (2000 family emojis, hard cuts only)', () => {
    const text = String.fromCodePoint(0x1F468, 0x200D, 0x1F469, 0x200D, 0x1F467, 0x200D, 0x1F466).repeat(2000);
    const parts = splitForSms(text);
    expect(parts.length).toBeGreaterThan(1);
    const unpaired = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    for (const p of parts) {
      expect(p.length).toBeLessThanOrEqual(1500);
      expect(p).not.toMatch(unpaired);
    }
    expect(Array.from(parts.join('')).length).toBe(Array.from(text).length);
  });
});

describe('sendSms', () => {
  it('a 3500-char body goes out as ordered parts, each <= 1600, and the caller sees the first part\'s sid', async () => {
    const body = [words(1170), words(1170), words(1170)].join('\n\n');
    const res = await sendSms(TO, body, FROM);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(res.data.sid).toBe('SMfake1');
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    const bodies = [0, 1, 2].map(bodyOfCall);
    for (const b of bodies) expect(b.length).toBeLessThanOrEqual(1600);
    expect(norm(bodies.join(' '))).toBe(norm(formatForPlainTextChannel(body)));
    // THE DOOR RECORD: one row for the whole call, delivered, naming the part count.
    expect(recordAtDoorMock).toHaveBeenCalledTimes(1);
    expect(recordAtDoorMock.mock.calls[0][0]).toMatchObject({
      outcome: 'delivered',
      detail: expect.stringContaining('3 parts'),
    });
  });

  it('stops at the first failed part and names it in the error', async () => {
    const body = [words(1170), words(1170), words(1170)].join('\n\n');
    failOnCall = 2;
    const res = await sendSms(TO, body, FROM);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.error).toContain('part 2');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(recordAtDoorMock).toHaveBeenCalledTimes(1);
    expect(recordAtDoorMock.mock.calls[0][0]).toMatchObject({ outcome: 'failed' });
  });

  it('a 100-char body behaves exactly as today: one POST, same Body (control)', async () => {
    const body = 'x'.repeat(100);
    const res = await sendSms(TO, body, FROM);
    expect(res.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(bodyOfCall(0)).toBe(body);
    expect(recordAtDoorMock).toHaveBeenCalledTimes(1);
  });

  it('a 1550-char body (over the 1500 cut, under Twilio\'s 1600) still goes out as ONE POST with the whole body', async () => {
    const body = words(1550);
    const res = await sendSms(TO, body, FROM);
    expect(res.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(bodyOfCall(0)).toBe(body);
  });
});
