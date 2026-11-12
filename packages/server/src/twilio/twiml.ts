// TwiML response helpers: tiny serializers (TwiML is XML with a fixed root element).

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Reject the call immediately. */
export function twimlReject(reason = 'rejected'): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Reject reason="${xmlEscape(reason)}"/></Response>`;
}

/** Voicemail: greet, then record with transcribe on, so only the transcript (no audio) is stored. */
export function twimlVoicemail(greeting: string, statusCallback: string, transcribeCallback: string): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Response>` +
    `<Say>${xmlEscape(greeting)}</Say>` +
    `<Record ` +
      `action="${xmlEscape(statusCallback)}" ` +
      `method="POST" ` +
      `maxLength="180" ` +
      `playBeep="true" ` +
      `transcribe="true" ` +
      `transcribeCallback="${xmlEscape(transcribeCallback)}"` +
    `/>` +
    `<Hangup/>` +
    `</Response>`
  );
}

/**
 * Hand the call to our Media Streams WebSocket (bidirectional μ-law frames). From/To go in as <Parameter>
 * tags that Twilio echoes in the WS `start` customParameters; without them badges show "(unknown)".
 */
export function twimlConnectStream(
  streamUrl: string,
  params: { from?: string; to?: string } = {},
): string {
  const paramTags: string[] = [];
  if (params.from) paramTags.push(`<Parameter name="From" value="${xmlEscape(params.from)}"/>`);
  if (params.to) paramTags.push(`<Parameter name="To" value="${xmlEscape(params.to)}"/>`);
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Response>` +
    `<Connect>` +
    `<Stream url="${xmlEscape(streamUrl)}">` +
    paramTags.join('') +
    `</Stream>` +
    `</Connect>` +
    `</Response>`
  );
}
