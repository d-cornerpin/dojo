// TwiML response builders (twiml.ts, v35): the XML returned to Twilio's webhooks.
//
// These are pure serializers: caller numbers, greetings and callback URLs are
// interpolated through a single private `xmlEscape`, so a missed escape is the
// one way a caller-controlled string can break the document. No test ever
// pinned that, so these clauses pin the exact bytes and, last, that a
// well-formedness-attacking string survives every builder only in escaped form.
import { describe, it, expect } from 'vitest';
import {
  twimlEmpty,
  twimlReject,
  twimlSayAndHangup,
  twimlVoicemail,
  twimlConnectStream,
} from '../twiml.js';

describe('twimlEmpty', () => {
  it('acks the webhook with a bare Response and no body', () => {
    expect(twimlEmpty()).toBe('<?xml version="1.0" encoding="UTF-8"?><Response/>');
  });
});

describe('twimlReject', () => {
  it('escapes the reason on its way into the Reject attribute', () => {
    expect(twimlReject('a"b<')).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Response><Reject reason="a&quot;b&lt;"/></Response>',
    );
  });

  it('defaults the reason to "rejected"', () => {
    expect(twimlReject()).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Response><Reject reason="rejected"/></Response>',
    );
  });
});

describe('twimlSayAndHangup', () => {
  it('escapes the greeting inside <Say> then hangs up', () => {
    expect(twimlSayAndHangup("it's <b> & co")).toContain(
      "<Say>it&apos;s &lt;b&gt; &amp; co</Say><Hangup/>",
    );
  });
});

describe('twimlConnectStream', () => {
  it('escapes the stream URL and embeds only the From parameter, in order', () => {
    const out = twimlConnectStream('wss://x/y?a=1&b=2', { from: '+15550001111' });

    expect(out).toContain('url="wss://x/y?a=1&amp;b=2"');

    // Exactly one From parameter, and no To parameter at all (case-sensitive:
    // the code emits `name="To"`, never `Name="To"`).
    const fromTag = '<Parameter name="From" value="+15550001111"/>';
    expect(out.split(fromTag).length - 1).toBe(1);
    expect(out).not.toContain('name="To"');
    expect(out).not.toContain('Name="To"');
  });

  it('carries both From and To as adjacent Parameters, in that order, inside <Stream>', () => {
    const out = twimlConnectStream('wss://x/y', { from: '+15550001111', to: '+15550002222' });
    const fromIdx = out.indexOf('<Parameter name="From" value="+15550001111"/>');
    const toIdx = out.indexOf('<Parameter name="To" value="+15550002222"/>');
    const streamEnd = out.indexOf('</Stream>');

    expect(fromIdx).toBeGreaterThan(-1);
    expect(toIdx).toBeGreaterThan(-1);
    expect(fromIdx).toBeLessThan(toIdx);
    expect(toIdx).toBeLessThan(streamEnd);
  });

  it('emits no <Parameter at all when no from/to is given', () => {
    expect(twimlConnectStream('wss://x/y')).not.toContain('<Parameter');
  });
});

describe('twimlVoicemail', () => {
  it('escapes the greeting and both callback URLs and pins the Record attributes', () => {
    const out = twimlVoicemail('Hi & bye', 'https://x.test/a?x=1&y=2', 'https://x.test/t');

    expect(out).toContain('<Say>Hi &amp; bye</Say>');
    expect(out).toContain('action="https://x.test/a?x=1&amp;y=2"');
    expect(out).toContain('transcribeCallback="https://x.test/t"');
    expect(out).toContain('maxLength="180"');
    expect(out).toContain('transcribe="true"');
    expect(out).toMatch(/<Hangup\/><\/Response>$/);
  });
});

// A well-formedness attack: the string below would close an attribute, open a
// sibling and start a new one if it ever reached the document raw. Fed into every
// text/URL argument of every builder, it must survive only in escaped form, so the
// raw substring is never present.
const INJECT = '"><Hangup/><x a="';

describe('every builder escapes a well-formedness attack', () => {
  it('twimlReject', () => {
    expect(twimlReject(INJECT)).not.toContain(INJECT);
  });

  it('twimlSayAndHangup', () => {
    expect(twimlSayAndHangup(INJECT)).not.toContain(INJECT);
  });

  it('twimlVoicemail (greeting and both callbacks)', () => {
    expect(twimlVoicemail(INJECT, INJECT, INJECT)).not.toContain(INJECT);
  });

  it('twimlConnectStream (url and both from/to)', () => {
    expect(twimlConnectStream(INJECT, { from: INJECT, to: INJECT })).not.toContain(INJECT);
  });

  it('twimlEmpty has no caller-controlled argument to escape', () => {
    expect(twimlEmpty()).not.toContain(INJECT);
  });
});
