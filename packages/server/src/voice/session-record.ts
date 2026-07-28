// ════════════════════════════════════════
// Voice session records (lanes & lineage phase 8, migration 123).
//
// The durable identity of a spoken session. The dashboard WS session was pure
// process memory (a dropped connection left no record); phone calls had
// twilio_call_log but no shared identity with in-person voice. One writer
// module, two kinds:
//   kind 'dashboard'  - the in-person voice WS session (voice-ws.ts)
//   kind 'phone'      - a live call (call-session.ts; external_id = callSid,
//                       twilio_call_log stays the call's own record)
// Message rows stamp voice_session_id + speaker at the producer; the spoken
// reply is bound by id at turn finalize (riding the P4 answer stamp).
//
// Best-effort by contract: a record failure must never break the audio path.
// ════════════════════════════════════════
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/connection.js';
import { stampVoiceSpeaker } from '../memory/message-store.js';
import { createLogger } from '../logger.js';

const logger = createLogger('voice-session-record');

export function startVoiceSessionRecord(input: {
  agentId: string;
  kind: 'dashboard' | 'phone';
  externalId?: string | null;
  conversationId?: string | null;
  sttModel?: string | null;
  ttsEngine?: string | null;
  voiceId?: string | null;
}): string | null {
  try {
    const id = uuidv4();
    getDb().prepare(`
      INSERT INTO voice_sessions (id, agent_id, kind, external_id, conversation_id, stt_model, tts_engine, voice_id, started_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), datetime('now'))
    `).run(
      id, input.agentId, input.kind, input.externalId ?? null, input.conversationId ?? null,
      input.sttModel ?? null, input.ttsEngine ?? null, input.voiceId ?? null,
    );
    return id;
  } catch (err) {
    logger.warn('startVoiceSessionRecord failed (session proceeds unrecorded)', {
      agentId: input.agentId, kind: input.kind, error: err instanceof Error ? err.message : String(err),
    }, input.agentId);
    return null;
  }
}

export function endVoiceSessionRecord(sessionId: string | null, reason: string): void {
  if (!sessionId) return;
  try {
    getDb().prepare(`
      UPDATE voice_sessions SET ended_at = datetime('now'), end_reason = ?, updated_at = datetime('now')
      WHERE id = ? AND ended_at IS NULL
    `).run(reason.slice(0, 200), sessionId);
  } catch (err) {
    logger.warn('endVoiceSessionRecord failed (non-fatal)', {
      sessionId, error: err instanceof Error ? err.message : String(err),
    });
  }
}

export function bumpVoiceSessionTurnCount(sessionId: string | null): void {
  if (!sessionId) return;
  try {
    getDb().prepare(`
      UPDATE voice_sessions SET turn_count = turn_count + 1, updated_at = datetime('now') WHERE id = ?
    `).run(sessionId);
  } catch { /* best effort */ }
}

/** The open session for a live call, by its Twilio callSid (reply binding for
 *  phone turns, where the loop holds the callSid but not the session id). */
export function getVoiceSessionIdForCall(callSid: string): string | null {
  try {
    const row = getDb().prepare(
      `SELECT id FROM voice_sessions WHERE kind = 'phone' AND external_id = ? AND ended_at IS NULL
        ORDER BY started_at DESC LIMIT 1`,
    ).get(callSid) as { id: string } | undefined;
    return row?.id ?? null;
  } catch {
    return null;
  }
}

/** Stamp a spoken row's identity (speaker + session). Used by the producers
 *  and by the turn-finalize reply binding. Idempotent; never throws. */
export function stampSpokenMessage(messageId: string, speaker: 'owner' | 'caller' | 'agent', voiceSessionId: string | null): void {
  try {
    stampVoiceSpeaker(messageId, speaker, voiceSessionId);
  } catch (err) {
    logger.warn('stampSpokenMessage failed (non-fatal)', {
      messageId, speaker, error: err instanceof Error ? err.message : String(err),
    });
  }
}
