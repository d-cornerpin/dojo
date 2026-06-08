// ════════════════════════════════════════
// TwiML response helpers (v2.9.18)
// Tiny serializers - TwiML is just XML with a fixed root element.
// ════════════════════════════════════════

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

/** Play a greeting, then hang up. */
export function twimlSayAndHangup(text: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Say>${xmlEscape(text)}</Say><Hangup/></Response>`;
}

/**
 * Voicemail: greet, then record. Twilio sends a status callback
 * with RecordingSid + TranscriptionText (when transcribe=true) once
 * the recording ends. We use transcribe to get the transcript without
 * storing audio - the dashboard sees the transcript only.
 */
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
 * Hand the call off to our Media Streams WebSocket so the agent can
 * talk in real time. Twilio opens a bidirectional WS to streamUrl
 * and pumps μ-law frames in both directions.
 *
 * The optional From/To get embedded as <Parameter> tags inside
 * <Stream>; Twilio echoes them back to us in the WS `start` event's
 * customParameters bag. Without these, the WS start frame carries
 * no caller identity and CallSession logs / dashboard badges show
 * "(unknown)". The webhook handler already has the values (they
 * arrive in the form-encoded inbound webhook body).
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

/** Empty response (acks the webhook without taking action). */
export function twimlEmpty(): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response/>`;
}
