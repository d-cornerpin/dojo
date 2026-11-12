// Twilio Media Streams WebSocket handler. Twilio opens a bidirectional WS per call carrying JSON text frames:
// inbound `connected | start | media | stop | mark | dtmf`, outbound `media` (also `mark` and `clear`).
// A CallSession is created on `start`, fed `media` frames, and ended on `stop` or socket close.

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
  if (msg === null || typeof msg !== 'object' || typeof (msg as { event?: unknown }).event !== 'string') {
    logger.warn('Twilio WS sent a frame with no event, ignoring');
    return;
  }

  switch (msg.event) {
    case 'connected':
      // Twilio handshake ack - no action needed.
      return;
    case 'start': {
      const startMsg = msg;
      if (!startMsg.start || typeof startMsg.start.callSid !== 'string') {
        logger.warn('Twilio WS start frame without a call id, ignoring');
        return;
      }
      const callSid = startMsg.start.callSid;
      const streamSid = startMsg.streamSid;
      wsToCallSid.set(ws, callSid);
      // An outbound call already has a placeholder session (from voice-outbound): attach the WS sender
      // to it. Otherwise this is an inbound call and gets a new session.
      const existing = getCallSession(callSid);
      if (existing) {
        existing.bindSend((m: string) => { try { ws.send(m); } catch { /* dead */ } }, streamSid);
        existing.start();
        return;
      }
      // Inbound: From/To come from the TwiML <Parameter> customParameters, else '(unknown)'.
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
      if (!frameMsg.media) return;
      // Only the caller's inbound track is processed; Twilio may echo the outbound track, which is ignored.
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
