-- v2.9.18: Twilio integration (SMS + Voice calls).
--
-- Personal Twilio accounts only (10DLC consumer). No recording -
-- so no consent prompts, no audio storage, transcripts only.
--
-- Auth token is encrypted at rest using the credential master key
-- (same key the agent credentials store uses, in secrets.yaml).
-- We do NOT use the credential store itself because that's for
-- agent-callable credentials; the Twilio auth token is platform-
-- level config the engine uses to call Twilio on the agent's behalf.

CREATE TABLE IF NOT EXISTS twilio_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  account_sid TEXT,
  -- AES-256-GCM ciphertext + iv + auth tag. NULL when not yet
  -- configured. Decrypted on demand by twilio/auth.ts.
  auth_token_ciphertext BLOB,
  auth_token_iv BLOB,
  auth_token_tag BLOB,
  default_from_number TEXT,
  -- Master switch. Both SMS and Voice are gated on this; the per-
  -- feature flags below are sub-switches under it.
  enabled INTEGER NOT NULL DEFAULT 0,
  sms_enabled INTEGER NOT NULL DEFAULT 0,
  voice_enabled INTEGER NOT NULL DEFAULT 0,
  -- Per-call safety cap. Twilio bills per minute; runaway calls
  -- (model hallucinating an endless conversation) get force-ended
  -- at this duration.
  voice_max_minutes_per_call INTEGER NOT NULL DEFAULT 30,
  -- 'reject' | 'voicemail' | 'agent'. Default 'voicemail' captures
  -- a transcript for the owner without auto-connecting random
  -- callers to the primary agent.
  voice_unknown_caller_action TEXT NOT NULL DEFAULT 'voicemail',
  -- Greeting played to unknown callers when action='voicemail'.
  voice_voicemail_greeting TEXT NOT NULL DEFAULT 'Hi, you have reached the dojo voicemail. Please leave a brief message after the tone and we will get back to you.',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Phone numbers owned by the user on this Twilio account. Each
-- number is a separately addressable inbox / caller-id. Default
-- number is used when an outbound sms_send / voice_call doesn't
-- name a specific from-number.
CREATE TABLE IF NOT EXISTS twilio_numbers (
  number TEXT PRIMARY KEY,
  label TEXT,
  is_default INTEGER NOT NULL DEFAULT 0,
  sms_enabled INTEGER NOT NULL DEFAULT 1,
  voice_enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Inbound + outbound call records. Transcripts only (no audio).
-- One row per call; per-utterance transcript chunks are stored as
-- conversation messages on the primary agent and stitched together
-- in the transcript column when the call ends.
CREATE TABLE IF NOT EXISTS twilio_call_log (
  id TEXT PRIMARY KEY,
  call_sid TEXT NOT NULL UNIQUE,
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  from_number TEXT NOT NULL,
  to_number TEXT NOT NULL,
  status TEXT NOT NULL,
  -- 'agent' | 'voicemail' | 'rejected'. Tracks which branch the
  -- inbound call took. Outbound calls are always 'agent'.
  handler TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at TEXT,
  duration_seconds INTEGER,
  agent_id TEXT,
  transcript TEXT,
  ended_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_twilio_call_log_started ON twilio_call_log(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_twilio_call_log_to_from ON twilio_call_log(to_number, from_number);
