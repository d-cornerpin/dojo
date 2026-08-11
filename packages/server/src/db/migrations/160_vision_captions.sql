-- 160 (UX-REPAIR ROUND 6 T27): THE VISION GATE REMEMBERS WHAT IT ALREADY DECIDED.
--
-- The gate (`agent/runtime.ts`) walks the ASSEMBLED MESSAGE HISTORY on every model call. It
-- held no memory at all, so a single image row in an agent's history was re-processed from
-- scratch on every assembly, for ever: re-sent to the fallback vision model, re-failed,
-- re-toasted to the user (`chat:error`, amber — 11 in 15 minutes on the dev body, 2026-08-10,
-- across all six round-6 catalogs), and re-followed by a spliced "The user just sent N
-- images… Do NOT continue any prior topic, respond ONLY about the images they just sent" —
-- false on its face by the second turn, and a topic hijack in the middle of the history.
--
-- ONE ROW PER IMAGE, KEYED ON THE IMAGE ITSELF. The gate is handed provider-shape content
-- blocks, not database rows: no message id reaches it, and plumbing one through four call
-- layers to answer "have I seen this before?" would be a second identity for a thing that
-- already has one. The image's own bytes (or its URL) are that identity, and hashing them
-- also means the same picture uploaded twice is described once.
--
-- THE FAILURE IS A RECORD TOO, and that is the half that stops the loop: a caption that
-- failed is stored as a failure, the stub goes in its place, and the fallback model is never
-- asked about that image again. One attempt per image, ever — deliberately not a retry
-- budget, because a retry budget is a number nobody could derive and the thing being bounded
-- is an unbounded repeat, not a flaky call. A user who wants another attempt re-uploads,
-- which the gate's own nudge already tells them.
--
-- NOT AGENT-SCOPED: the caption describes the picture, not the conversation, and the fallback
-- model that produced it is a platform-wide setting. A per-agent copy would re-pay for the
-- same image on every agent that saw it and could hold two different descriptions of one
-- picture. `model_id` records WHICH describer spoke, so a later reader can tell.

CREATE TABLE IF NOT EXISTS vision_captions (
  -- sha256 of the image's base64 bytes, or of its URL when that is all the block carries.
  fingerprint TEXT PRIMARY KEY,
  -- The description, or NULL when the attempt failed and this row is the tombstone for it.
  caption     TEXT,
  -- The fallback vision model that answered (or was asked and failed). NULL when no fallback
  -- was configured at the time, which is itself the reason there is no caption.
  model_id    TEXT,
  outcome     TEXT NOT NULL CHECK (outcome IN ('captioned', 'failed')),
  created_at  INTEGER NOT NULL
);
