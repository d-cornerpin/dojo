// ════════════════════════════════════════
// Twilio Media Streams WebSocket handler (v2.9.18)
//
// Twilio opens a bidirectional WebSocket to our voice-stream endpoint
// for the duration of each call. Wire protocol:
//   - JSON text frames in both directions
//   - Inbound: { event: 'connected' | 'start' | 'media' | 'stop' | 'mark' | 'dtmf', ... }
//   - Outbound: { event: 'media', streamSid, media: { payload: base64 } }
//                also 'mark' and 'clear' (we mostly use 'media')
//
// We instantiate a CallSession on `start`, dispatch `media` frames
// to it, end on `stop` or socket close.
// ════════════════════════════════════════

import type { WSContext } from 'hono/ws';
import { createLogger } from '../logger.js';
import {
  CallSession,
  endCallSession,
  getCallSession,
  registerCallSession,
} from './call-session.js';

const logger = createLogger('twilio-voice-stream');

interface TwilioMediaStartEvent {
  event: 'start';
  start: {
    streamSid: string;
    accountSid: string;
    callSid: string;
    tracks: string[];
    customParameters?: Record<string, string>;
    mediaFormat: { encoding: string; sampleRate: number; channels: number };
  };
  streamSid: string;
}

interface TwilioMediaFrameEvent {
  event: 'media';
  streamSid: string;
  media: {
    track: 'inbound' | 'outbound';
    chunk: string;
    timestamp: string;
    payload: string;
  };
}

interface TwilioMediaStopEvent {
  event: 'stop';
  streamSid: string;
  stop?: { accountSid?: string; callSid?: string };
}

type AnyTwilioEvent =
  | { event: 'connected' }
  | TwilioMediaStartEvent
  | TwilioMediaFrameEvent
  | TwilioMediaStopEvent
  | { event: 'mark' }
  | { event: 'dtmf' };

// Per-WS state: which CallSid this socket is tied to (set on `start`).
const wsToCallSid = new WeakMap<object, string>();

export function handleVoiceStreamOpen(ws: WSContext): void {
  logger.info('Twilio voice-stream WS opened');
  void ws;
}

export async function handleVoiceStreamMessage(ws: WSContext, data: string | ArrayBuffer | Buffer): Promise<void> {
  let text: string;
  if (typeof data === 'string') {
    text = data;
  } else if (Buffer.isBuffer(data)) {
    text = data.toString('utf8');
  } else {
    text = Buffer.from(data).toString('utf8');
  }
  let msg: AnyTwilioEvent;
  try {
    msg = JSON.parse(text) as AnyTwilioEvent;
  } catch {
    logger.warn('Twilio WS sent non-JSON, ignoring', { previewLen: text.length });
    return;
  }

  switch (msg.event) {
    case 'connected':
      // Twilio handshake ack - no action needed.
      return;
    case 'start': {
      const startMsg = msg;
      const callSid = startMsg.start.callSid;
      const streamSid = startMsg.streamSid;
      wsToCallSid.set(ws, callSid);
      // Lookup whether an outbound-call placeholder session already
      // exists (created by voice-outbound when the agent initiated the
      // call). If yes, just attach the WS sender and mark started.
      // Otherwise this is an inbound call - create a new session.
      const existing = getCallSession(callSid);
      if (existing) {
        existing.bindSend((m: string) => { try { ws.send(m); } catch { /* dead */ } }, streamSid);
        existing.start();
        return;
      }
      // Inbound: look up From/To from customParameters if provided
      // by the TwiML <Parameter>, otherwise fall back to whatever was
      // captured in the start payload (Twilio sometimes carries
      // from/to via params, not in the protocol body).
      const params = startMsg.start.customParameters ?? {};
      const fromNumber = params.From ?? params.from ?? '(unknown)';
      const toNumber = params.To ?? params.to ?? '(unknown)';
      const session = new CallSession({
        callSid,
        streamSid,
        direction: 'inbound',
        fromNumber,
        toNumber,
        send: (m: string) => { try { ws.send(m); } catch { /* dead */ } },
      });
      registerCallSession(session);
      session.start();
      return;
    }
    case 'media': {
      const frameMsg = msg;
      // Only process the inbound track (caller's audio). Twilio also
      // echoes back the outbound track in some configurations; ignore.
      if (frameMsg.media.track !== 'inbound') return;
      const callSid = wsToCallSid.get(ws);
      if (!callSid) return;
      const session = getCallSession(callSid);
      if (!session) return;
      await session.frame(frameMsg.media.payload);
      return;
    }
    case 'stop': {
      const callSid = wsToCallSid.get(ws) ?? msg.stop?.callSid ?? null;
      if (callSid) endCallSession(callSid, 'twilio_stop');
      wsToCallSid.delete(ws);
      return;
    }
    case 'mark':
    case 'dtmf':
      return;
    default:
      return;
  }
}

export function handleVoiceStreamClose(ws: WSContext): void {
  const callSid = wsToCallSid.get(ws);
  if (callSid) {
    endCallSession(callSid, 'ws_closed');
    wsToCallSid.delete(ws);
  }
  logger.info('Twilio voice-stream WS closed', { callSid });
}
