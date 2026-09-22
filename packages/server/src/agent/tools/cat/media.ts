// ════════════════════════════════════════════════════════════════════════════
// MEDIA GENERATION (PHASE-5 T4 — relocated from `agent/tools.ts`)
//
// `image_create`, `tts_create` / `music_create` (one body, two tools),
// `video_create`, `transcribe_audio`.
//
// RELOCATION, NOT REWRITE. Every body is byte-faithful, and in this category
// that is load bearing three times over:
//
// 1. **C13 — the turn-scoped iMessage recipient is captured at tool-CALL time.**
//    `image_create` reads `getTurnScopedImRecipient(agentId)` into a `const`
//    BEFORE the deferred delivery IIFE, and the comment at that line says why:
//    the IIFE outlives the turn, the turn's `finally` ends its `TurnContext`
//    (PHASE-6 T1; it was the idle status write), and a re-read would return null —
//    so the image would fall to the owner, or under concurrency to a third
//    party. The capture's POSITION is the guarantee, and it is unchanged.
// 2. **The delivery IIFE's own shape.** `void (async () => { … })()` runs after
//    the handler has already answered; its `while` loops, its status writes and
//    its failure path are untouched. A handler returns to the executor's tail
//    exactly where the case `break`ed, so the tool RESULT reaches the model while
//    generation continues in the background.
// 3. **The generation-job lifecycle** (queued → running → succeeded/failed) that
//    the dashboard's ActiveJobsIndicator reads is driven from inside these
//    bodies; the aliased job helpers (`createImgJob`, `setImgRunning`, …) keep
//    their local names so the diff is readable by eye.
//
// ── TWENTY-ONE LAZY LOADS DIED ──
// None is on §T0-PINS P8's sanctioned list and not one of their targets imports
// anything from the toolbox, so not one broke a cycle. Four were the inline
// `(await import('…')).fn()` form and become ordinary named imports. RULING
// P5-R9's arbiter — the unit suite — stayed green.
//
// ── THE SECOND ACK AUTHORITY IS GONE (UX-REPAIR T71b, owner report 2026-09-05) ──
// Three of these bodies used to open with a "synthetic acknowledgment": an
// assistant-role row written and broadcast on the SYNCHRONOUS path of every call,
// v2.10.3's answer to the silence between the tool pill and the finished asset.
// It is deleted, in all three, and none of it is replaced.
//
//   1. IT WAS N BUBBLES, NOT ONE, ON TOP OF THE REAL ACK. The executor runs a
//      `safe` batch through `Promise.all` (`v2/steps/execute/index.ts:204`), and
//      there was no latch of any kind — not per turn, not per batch, not per
//      phrase. Driven at `63b9064` on the floor model, a three-headshot ask: row
//      71934 is the DESIGNED ack (`origin_intent=engine_start_ack`, the model's
//      own "Generating all three headshots now — chef, pilot, and librarian.")
//      and then 71936/71937/71938 are "Checking on that." / "Looking into it." /
//      "Checking.", three independent draws from the voice-mode filler pool in
//      one instant. Four bubbles where the design says one.
//   2. IT BROKE A WRITTEN INVARIANT. `v2/loop.ts` (Part XIX, sharpened): *never
//      insert any persisted message between an assistant `tool_use` and its
//      matching `tool_result` … a transient indicator must be broadcast-only,
//      never written to the messages table.* Those three rows sat at 71936-71938,
//      between the `tool_use` row 71935 and the `tool_result` row 71939.
//   3. IT COULD NOT DISCHARGE THE ACK DUTY IT CLAIMED. The row was written with no
//      `turnNumber`, so `startAckRepliedNow`'s probe (`v2/steps/preflight/
//      start-ack.ts`, `turn_number = ?`) could not see it and the start-ack door
//      stayed open — the engine then steered the model to say "on it" moments
//      after the handler had already said it N times. A handler has no route to
//      the flag that would close the door: `ToolHandlerContext` carries no
//      `TurnContext` and no turn number, by design.
//   4. A CANNED ENGINE LINE IS THE THING OR2 FORBIDS. Owner ruling 2026-07-22:
//      the engine DETECTS, the agent SPEAKS; the engine never composes the ack
//      itself. The F10/T41 start-ack door is that one authority and it hands the
//      model the mic (`v2/steps/assemble/start-ack-door.ts`).
//
// So this is a deletion and not a latch: a latch would have turned three junk
// bubbles into one junk bubble and left (2), (3) and (4) all standing. What the
// deferred delivery IIFE writes later — the caption plus the attachment, and the
// failure notice — is the PAYLOAD, lands after the turn rather than between the
// pair, and is untouched. `__tests__/media-posts-no-ack-row.test.ts` holds the
// requirement at zero rows on the synchronous path, per generator and for a
// three-call batch.
// ════════════════════════════════════════════════════════════════════════════

import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../../../db/connection.js';
import { broadcast } from '../../../gateway/ws.js';
import { writeAgentStatus } from '../../agent-status.js';
import { insertMessageIfAbsent } from '../../../memory/message-store.js';
import { getModelCapabilities } from '../../../services/capabilities.js';
import { auditLog, toolsLogger as logger } from '../util.js';
import * as effectFs from '../../effects/fs.js';
import pathModule from 'node:path';
import { createGenerationJob as createImgJob, setRunning as setImgRunning, setSucceeded as setImgSucceeded, setFailed as setImgFailed, setCancelled as setImgCancelled, createGenerationJob, enqueueAudioOrMusicJob } from '../../../services/generation-jobs.js';
import { enqueueVideoJob } from '../../../services/video-job-poller.js';
import { generateImage } from '../../../services/image-generation.js';
import { getEffectiveAudioGenModel } from '../../../services/audio-gen-model.js';
import { getEffectiveImageGenModel } from '../../../services/image-gen-model.js';
import { getEffectiveMusicGenModel } from '../../../services/music-gen-model.js';
import { getEffectiveTranscriptionModel } from '../../../services/transcription-model.js';
import { getEffectiveVideoGenModel } from '../../../services/video-gen-model.js';
import { getModelGenerationParams, defaultVideoSpecFor, validateCanonicalParams, VIDEO_CANONICAL_PARAMS } from '../../../services/generation-params.js';
import { getModelVoiceCatalog, defaultVoiceCatalogFor, isKnownVoice, formatVoiceCatalog } from '../../../services/voice-catalog.js';
import { getPresence } from '../../../services/presence.js';
import { getTurnScopedImRecipient, sendIMessageWithAttachment, getDefaultSender } from '../../../services/imessage-bridge.js';
import { mayUseChannel } from '../../access/read.js';
import { postAgentNotice } from '../../agent-notice.js';
import { recordCost } from '../../../costs/tracker.js';
import { resolveAttachmentPath, fetchAudioUrl, transcribeAudio } from '../../../services/transcription.js';
import { submitVideoJob } from '../../../services/video-generation.js';
import type { ToolHandler, ToolHandlerMap } from '../handler.js';
import { homeDir } from '../../../home.js';

const handlers = {
  async "image_create"({ agentId, args }) {
    let content = '';
    let isError = false;
    const description = (args.description as string | undefined)?.trim();
    const aspectRatio = ((args.aspect_ratio as string | undefined) ?? '1:1').trim();
    const styleHint = ((args.style_hint as string | undefined) ?? '').trim();
    const rawTitle = (args.title as string | undefined)?.trim() ?? '';

    if (!description) {
      content = 'Error: description is required';
      isError = true;
      return { content, isError };
    }

    // Slugify the agent-provided title into a safe filename stem.
    // Lowercase, drop non-alphanumerics, collapse runs of hyphens,
    // cap at 50 chars so the final filename stays reasonable.
    const slugify = (s: string): string =>
      s.toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 50);
    const titleSlug = rawTitle ? slugify(rawTitle) : '';

    const db = getDb();

    const modelChoice = getEffectiveImageGenModel();
    if (!modelChoice) {
      content =
        `No image-generation model is configured. ` +
        `Go to Settings → Dojo → Image Generation Model and pick an image-capable model (e.g. Gemini 2.5 Flash Image on OpenRouter). ` +
        `Tell the user image generation is unavailable until this is configured, do not retry.`;
      isError = true;
      return { content, isError };
    }

    // Track this image generation as a generation_job so it shows up in
    // the dashboard's ActiveJobsIndicator alongside audio/music/video.
    // image_create keeps its own delivery path below; we just drive the
    // job's lifecycle (queued -> running -> succeeded/failed) around it.
    const imgJobId = createImgJob({
      kind: 'image',
      agentId,
      modelId: modelChoice.modelId,
      providerId: modelChoice.providerId,
      prompt: description,
      title: rawTitle || null,
    });
    // P6b: ONE durable identity. The job id (which carries source lineage:
    // source_message_id / turn / task / conversation) is the request id in
    // every log line, filename, and the tool result; the separate img_
    // mint that split one generation across two ids is gone.
    const requestId = imgJobId;

    // Build the full prompt. Append the style hint if the user provided
    // one, so the image model gets stylistic direction inline.
    const fullPrompt = styleHint
      ? `${description}\n\nStyle: ${styleHint}`
      : description;

    // Capture whether this request originated from iMessage BEFORE the
    // runtime clears the flag after sending the ack. The background task
    // needs this to know whether to send the finished image back via
    // iMessage when it's done, the flag will be long gone by then.
    // D10: turn-anchored check. `TurnContext.imRecipient` is set iff THIS turn's
    // counterparty is a human iMessage sender (derived from the persisted
    // inbound_meta), which stays correct even when the pending map was already
    // consumed or was overwritten by a newer inbound (the bridge no longer
    // serializes ingest behind the running turn).
    //
    // FA-C1: turn-scoped ONLY - a last-inbound fallback is deliberately
    // gone here. That map holds whoever texted this agent most recently at
    // ingest time, decoupled from the turn, so on a proactive/dashboard image
    // request a contact who texted mid-generation could receive the finished
    // image (third-party delivery of owner-directed content). Null here means
    // "not an iMessage reply", so the image just shows in the dashboard, or
    // goes to the owner (getDefaultSender) on the away-forward branch below,
    // never to a guessed contact.
    //
    // C13: capture at tool-CALL time. The delivery IIFE outlives the turn, and the turn's
    // `finally` ends its `TurnContext` (PHASE-6 T1 — it was the idle status write; this
    // capture's POSITION is what made that change safe), so a delivery-time re-read would
    // return null and the image would fall to the owner (or a third party under
    // concurrency). This const is closed over by the IIFE and unaffected by the turn end.
    const requesterIMessage = getTurnScopedImRecipient(agentId);
    const triggeredByIMessage = requesterIMessage !== null;

    auditLog(agentId, 'image_create', null, 'success',
      `Request ${requestId} queued (aspect ${aspectRatio}${styleHint ? `, style ${styleHint}` : ''})`,
    );

    // ── Async background generation, fire and forget ──
    // The tool returns the ack text below IMMEDIATELY. The generation
    // runs in the background. On completion the file is copied into
    // the caller's uploads dir, pre-queued as a pending attachment,
    // and a synthetic wake message wakes the caller's runtime so the
    // agent's next assistant reply auto-attaches the image.
    const imageModelId = modelChoice.modelId;
    void (async () => {
      try {
        // Wait for the requesting agent to finish its current turn
        // before we start generating. This prevents the delivery message
        // from landing in the middle of the agent's still-in-progress
        // response to the ack text, which scrambles the message order
        // and confuses the model into repeating "I'll have Imaginer
        // work on that" instead of presenting the image.
        const waitStart = Date.now();
        const MAX_WAIT_MS = 60000;
        while (Date.now() - waitStart < MAX_WAIT_MS) {
          const agentRow = db.prepare('SELECT status FROM agents WHERE id = ?').get(agentId) as { status: string } | undefined;
          if (agentRow?.status === 'idle' || agentRow?.status === 'error') break;
          await new Promise<void>(r => setTimeout(r, 500));
        }

        // Set the requesting agent back to 'working' so the thinking
        // dots stay visible during image generation. The user sees the
        // agent say "On it!" → thinking dots stay → image appears.
        // Without this, the primary agent goes idle between the ack and delivery
        // and the user sees an awkward gap of silence.
        writeAgentStatus(agentId, 'working');
        broadcast({ type: 'agent:status', agentId, status: 'working' });

        // A-5: the CAS is READ. This IIFE deliberately waits for the turn to end before it
        // dials (the loop just above), so a stop pressed during that turn has already lowered
        // its own fence by the time we get here and the abort registry cannot refuse this dial.
        // The row can: `stopAgent` cancels the agent's open generation jobs, and a cancelled
        // row never moves to `running`. Nothing is dialled, nothing is spent, nothing is said.
        if (!setImgRunning(imgJobId)) {
          logger.info('image_create: not dialling — the job is no longer queued (stopped or cancelled)', {
            requestId, requesterId: agentId,
          });
          return;
        }

        logger.info('image_create: generating image', {
          requestId, requesterId: agentId, modelId: imageModelId, aspectRatio,
          waitedForIdleMs: Date.now() - waitStart,
        });

        const result = await generateImage({
          agentId,
          modelId: imageModelId,
          prompt: fullPrompt,
          aspectRatio,
        });

        if (!result.ok) {
          // A-5: honest stop identity. The user's own button is not a generation failure —
          // no `failed` row, no error column, and no "I wasn't able to generate that image"
          // bubble for work he called off himself.
          if (result.code === 'STOPPED') {
            setImgCancelled(imgJobId);
            logger.info('image_create: cancelled — the user stopped this agent mid-generation', {
              requestId, requesterId: agentId,
            });
            return;
          }

          logger.error('image_create: generation failed', {
            requestId, code: result.code, error: result.error,
          });

          setImgFailed(imgJobId, result.error);

          // Deliver error directly as an assistant message in the
          // requesting agent's own chat. No second LLM turn.
          const errMsgId = uuidv4();
          const errContent =
            `I wasn't able to generate that image:\n\n` +
            `> ${result.error}\n\n` +
            `You could try simplifying the description or trying again in a moment.`;
          insertMessageIfAbsent({ id: errMsgId, agentId, role: 'assistant', content: errContent });
          broadcast({
            type: 'chat:message', agentId,
            message: {
              id: errMsgId, agentId, role: 'assistant' as const, content: errContent,
              tokenCount: null, modelId: null, cost: null, latencyMs: null,
              createdAt: new Date().toISOString(),
            },
          });
          broadcast({
            type: 'chat:chunk', agentId,
            messageId: errMsgId, content: '', done: true, modelId: null,
          });
          return;
        }

        // Success, record cost under the calling agent. For models
        // priced per megapixel the tracker uses width × height; for
        // token-priced models it uses the prompt/completion counts
        // returned by the provider.
        try {
          recordCost({
            agentId,
            modelId: imageModelId,
            providerId: result.providerId,
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
            latencyMs: result.latencyMs,
            requestType: 'image_generation',
            imageWidth: result.width ?? undefined,
            imageHeight: result.height ?? undefined,
          });
        } catch { /* best effort */ }

        // ── Deliver the image ──
        // v2.10.3, no more A2A from a separate Imaginer agent.
        // We copy the file into the caller's uploads dir for a
        // stable on-disk path, pre-queue it as a pending attachment
        // so the agent's next assistant reply auto-attaches it,
        // and inject a synthetic user-role wake message into the
        // caller's chat. The runtime fires once more, the agent's
        // one-line reply ("Here you go!") lands with the image
        // thumbnail, and we're done.
        const recipientDir = path.join(homeDir(), '.dojo', 'uploads', agentId);
        if (!effectFs.existsSync(recipientDir)) effectFs.mkdirSync(recipientDir, { recursive: true });
        // Build a human-friendly on-disk filename. Prefer the agent-
        // provided slug (e.g. "coffee-shop-sunset") and append a short
        // id chunk for uniqueness. Falls back to the legacy
        // image_create_<reqId>_<uuid>.png shape when no title given.
        const sourceExt = path.extname(result.filename) || '.png';
        const shortId = requestId.replace(/^gen_/, '').slice(0, 8);
        const stableFilename = titleSlug
          ? `${titleSlug}-${shortId}${sourceExt}`
          : `image_create_${requestId}_${result.filename}`;
        const stablePath = path.join(recipientDir, stableFilename);
        let deliveredPath = result.filePath;
        try {
          effectFs.copyFileSync(result.filePath, stablePath);
          deliveredPath = stablePath;
        } catch (copyErr) {
          logger.warn('image_create: pre-copy to caller uploads dir failed, falling back to original path', {
            requestId, src: result.filePath, dest: stablePath,
            error: copyErr instanceof Error ? copyErr.message : String(copyErr),
          });
        }

        try {
          // v2.10.3, direct synthetic-delivery pattern. Pre-fix,
          // the success path injected a user-role wake message
          // and fired runtime.handleMessage so the model would
          // wake up, see "image ready" and write a contextual
          // reply with the auto-attached image. That looped:
          // the primary agent's fresh model turn saw the original user
          // prompt still in scope ("make me a giant banana"),
          // didn't reliably parse the wake message as the
          // completion signal, and re-called image_create.
          // Production incident 2026-06-09: four images
          // generated from one prompt.
          //
          // Now we just write a synthetic assistant message
          // with a short delivery caption and the image inline,
          // no model call. The user sees ONE clean bubble with
          // "Here you go." and the image thumbnail. Loop killed.
          const stat = effectFs.statSync(deliveredPath);
          const filename = path.basename(deliveredPath);
          const ext = path.extname(filename).toLowerCase();
          const mimeType =
            ext === '.png' ? 'image/png'
            : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
            : ext === '.webp' ? 'image/webp'
            : ext === '.gif' ? 'image/gif'
            : 'application/octet-stream';
          const attachment = {
            fileId: uuidv4(),
            filename,
            mimeType,
            size: stat.size,
            path: deliveredPath,
            category: 'image' as const,
          };

          // Small pool of delivery captions, generic enough to
          // fit any image request without sounding contextual.
          const DELIVERY_CAPTIONS = [
            'Here you go.',
            'Here it is.',
            'All done.',
            'Done.',
            'Got it for you.',
          ];
          const caption = DELIVERY_CAPTIONS[
            Math.floor(Math.random() * DELIVERY_CAPTIONS.length)
          ];

          const deliveryMsgId = uuidv4();
          const attachmentsJson = JSON.stringify([attachment]);
          insertMessageIfAbsent({
            id: deliveryMsgId, agentId, role: 'assistant', content: caption,
            attachments: attachmentsJson,
          });
          broadcast({
            type: 'chat:message', agentId,
            message: {
              id: deliveryMsgId, agentId, role: 'assistant' as const,
              content: caption,
              attachments: [attachment],
              tokenCount: null, modelId: null, cost: null, latencyMs: null,
              createdAt: new Date().toISOString(),
            },
          });
          broadcast({
            type: 'chat:chunk', agentId,
            messageId: deliveryMsgId, content: '', done: true, modelId: null,
          });

          setImgSucceeded(imgJobId, { assetPath: deliveredPath, assetMime: mimeType });

          logger.info('image_create: image delivered via synthetic assistant message', {
            requestId, requesterId: agentId, filePath: deliveredPath,
            sizeBytes: result.sizeBytes, latencyMs: result.latencyMs,
          });
        } catch (deliveryErr) {
          logger.error('image_create: image delivery threw, writing fallback message', {
            requestId, requesterId: agentId,
            error: deliveryErr instanceof Error ? deliveryErr.message : String(deliveryErr),
          });
          const fallbackId = uuidv4();
          const fallbackContent = `Image was generated successfully but delivery threw an error: ${deliveryErr instanceof Error ? deliveryErr.message : String(deliveryErr)}. The image file is at ${deliveredPath}.`;
          try {
            insertMessageIfAbsent({ id: fallbackId, agentId, role: 'system', content: fallbackContent });
            broadcast({
              type: 'chat:message', agentId,
              message: {
                id: fallbackId, agentId, role: 'system' as const, content: fallbackContent,
                tokenCount: null, modelId: null, cost: null, latencyMs: null,
                createdAt: new Date().toISOString(),
              },
            });
          } catch { /* best effort */ }
        }

        // Send via iMessage if user is away or request came from iMessage
        try {
          // UX-ACCESS A4: the LAST outbound-to-human door still wearing the role
          // singleton. The census classified it correctly — this reaches a real
          // person's phone with an attachment, so "is it the primary" was a
          // channel question in a role predicate's clothing. `mayUseChannel` is
          // the same reader ladder row 7, the `comms.ts` walls and the engine
          // auto-route now ask.
          //
          // EMPTY-DIFF BY CONSTRUCTION, and measurably so: post-migration the
          // primary is the only agent holding `imessage`, so the predicate
          // answers what `isPrimaryAgent` answered for all 111 rows — which is
          // what makes this the one auto-route door A4 can close for free.
          if (mayUseChannel(agentId, 'imessage')) {
            let shouldSendViaIMessage = triggeredByIMessage;
            if (!shouldSendViaIMessage) {
              try {
                shouldSendViaIMessage = getPresence() === 'away';
              } catch { /* presence module unavailable */ }
            }
            if (shouldSendViaIMessage) {
              // A-3 (comms-audit): route the image to the REQUESTER (the inbound
              // iMessage sender), not always the owner. Before, a contact who asked
              // for an image got nothing and the OWNER received an unrequested image.
              // Only fall back to the owner for a proactive/away send (no inbound).
              // C13: use the requester captured at call time (see above), not a
              // delivery-time re-read (which idle has since wiped → owner/wrong person).
              const recipient = requesterIMessage ?? getDefaultSender();
              if (recipient) {
                // Capture the ACTUAL delivery outcome and thread it back to the
                // model (2026-07-18 incident: the agent told an iMessage requester
                // "posted in the dashboard, go check it out" while this auto-text
                // silently failed on a broken imsg, so the requester got nothing
                // and could not see the dashboard). sendIMessageWithAttachment
                // returns true only when the file actually went out.
                const iMessageDelivered = sendIMessageWithAttachment(recipient, result.filePath, 'Here you go!');
                const deliveryOutcome = iMessageDelivered
                  ? 'the finished image was texted to the requester over iMessage'
                  : 'texting the image to the requester failed (the iMessage attachment channel is unavailable), it is available in the dashboard only';
                logger.info('image_create: iMessage delivery outcome', {
                  requestId, requesterId: agentId, delivered: iMessageDelivered,
                });
                // Only surface a model-visible correction on FAILURE. On success
                // the synchronous tool result already told the model the finished
                // image would be texted to the requester, so that completion line
                // is already truthful and a second note would be redundant chatter.
                // On failure the model must correct: postAgentNotice is the
                // sanctioned model-visible awareness channel (role='user'
                // origin_kind='engine', out of the human chat), so the agent's
                // next reply can tell the requester it is in the dashboard and why,
                // rather than presenting a failed send as done.
                if (!iMessageDelivered) {
                  try {
                    postAgentNotice({
                      toAgentId: agentId,
                      fromName: 'Image delivery',
                      brief:
                        `${deliveryOutcome}. If you reply to the requester, tell them the image is in the dashboard and could not be texted, ` +
                        `do not tell them it was sent.`,
                      intent: 'image_delivery_outcome',
                      selfIntro: false,
                    });
                  } catch { /* awareness note is best-effort */ }
                }
              }
            }
          }
        } catch { /* iMessage not available, fine */ }

      } catch (err) {
        logger.error('image_create: unexpected error in background generation', {
          requestId, error: err instanceof Error ? err.message : String(err),
        });
        // No-op if the job already reached a terminal state.
        setImgFailed(imgJobId, err instanceof Error ? err.message : String(err));
      } finally {
        // Set the caller back to idle (the runtime wake fired by
        // the success path will re-enter 'working' immediately
        // when the new turn picks up).
        writeAgentStatus(agentId, 'idle');
        broadcast({ type: 'agent:status', agentId, status: 'idle' });
      }
    })();

    // If the caller's model lacks vision, append a no-hallucination
    // reminder. The image will land in the user's chat thumbnail
    // regardless; only the agent's own ability to interpret what
    // was generated changes.
    let visionTail = '';
    try {
      const callerModel = db
        .prepare('SELECT model_id FROM agents WHERE id = ?')
        .get(agentId) as { model_id: string | null } | undefined;
      const callerCaps = callerModel?.model_id ? getModelCapabilities(callerModel.model_id) : [];
      if (callerCaps.length > 0 && !callerCaps.includes('vision')) {
        visionTail =
          `\n\nNote: your current model does NOT support image input. The image will be delivered to the user as an attachment and the user will see it; you will NOT see it. ` +
          `Acknowledge delivery with a short message ("here's the image you asked for" or similar) but do NOT describe what is "in" the image as if you can see it, anything you write about its visual contents will be a hallucination.`;
      }
    } catch { /* skip tail on lookup failure */ }

    // Tell the model WHERE the finished image will be delivered so any
    // completion line it writes is truthful about the destination. On an
    // iMessage-origin turn the engine auto-texts the finished file to the
    // requester (see the delivery block above), so telling that requester to
    // "check the dashboard" they cannot see was the 2026-07-18 confabulation.
    // On a dashboard turn it lands in the chat. The ACTUAL iMessage send
    // outcome is threaded back separately (an awareness note on failure) so a
    // silent send failure can never read as success.
    const deliveryClause = triggeredByIMessage
      ? `When the image is ready in 10-60 s, the engine will post it to the dashboard AND text it to the person who asked over iMessage, no second turn from you. If you do write a line, do not tell them to "check the dashboard" (they are on iMessage and will receive the image itself), just say it is on the way.`
      : `When the image is ready in 10-60 s, the engine will post it directly to the chat with a short caption, no second turn from you.`;
    content =
      `Image generation kicked off (request_id: ${requestId}). ${deliveryClause} ` +
      `End your turn now.` +
      visionTail;
    return { content, isError };
  },

  async "tts_create"({ agentId, name, args }) {
    let content = '';
    let isError = false;
    const isMusic = name === 'music_create';
    const promptText = isMusic
      ? (args.description as string | undefined)?.trim()
      : (args.text as string | undefined)?.trim();
    const voice = isMusic ? undefined : ((args.voice as string | undefined)?.trim() || undefined);
    const rawTitle = (args.title as string | undefined)?.trim() || undefined;

    if (!promptText) {
      content = `Error: ${isMusic ? 'description' : 'text'} is required.`;
      isError = true;
      return { content, isError };
    }

    const modelChoice = isMusic
      ? getEffectiveMusicGenModel()
      : getEffectiveAudioGenModel();
    if (!modelChoice) {
      content = isMusic
        ? `No music-generation model is configured. Go to Settings → Models → Music Generation Model and pick a music-capable model (e.g. Google Lyria). Tell the user music generation is unavailable until this is configured, do not retry.`
        : `No audio-generation model is configured. Go to Settings → Models → Audio Generation Model and pick an audio-capable model. Tell the user audio generation is unavailable until this is configured, do not retry.`;
      isError = true;
      return { content, isError };
    }

    // Validate the requested voice against the model's catalog and kick
    // the call back if it's not a real voice id. This stops the agent
    // from passing a freeform character description (e.g. "gravelly
    // elderly man") into the provider's closed voice enum, which 400s.
    if (!isMusic && voice) {
      const catalog =
        getModelVoiceCatalog(modelChoice.modelId) ?? defaultVoiceCatalogFor(modelChoice.apiModelId);
      if (catalog && !isKnownVoice(catalog, voice)) {
        content = `"${voice}" is not a valid voice for this TTS model. Pick the closest id from: ${formatVoiceCatalog(catalog)}. The voice id sets only the base timbre, put character, accent, age, or emotion (gravelly, elderly, etc.) into the spoken text instead. Re-call tts_create with a valid voice id.`;
        isError = true;
        return { content, isError };
      }
    }

    const kind = isMusic ? 'music' : 'audio';
    const jobId = createGenerationJob({
      kind,
      agentId,
      modelId: modelChoice.modelId,
      providerId: modelChoice.providerId,
      prompt: promptText,
      title: rawTitle,
      voice,
    });

    auditLog(agentId, name, null, 'success',
      `Job ${jobId} queued (${kind}, ${promptText.length} chars)`);

    enqueueAudioOrMusicJob(jobId);

    content =
      `${isMusic ? 'Music' : 'Audio'} generation started (job_id: ${jobId}). The engine is generating the asset in the background. When it's ready the engine will post it directly to the chat. You do NOT get a second turn and must NOT call ${name} again. End your turn now without writing any further text.`;
    return { content, isError };
  },

  async "video_create"({ agentId, args }) {
    let content = '';
    let isError = false;
    const description = (args.description as string | undefined)?.trim();
    const rawTitle = (args.title as string | undefined)?.trim() || undefined;
    const refImageAttachmentId = (args.ref_image_attachment_id as string | undefined)?.trim() || undefined;

    if (!description) {
      content = 'Error: description is required.';
      isError = true;
      return { content, isError };
    }

    const db = getDb();

    const modelChoice = getEffectiveVideoGenModel();
    if (!modelChoice) {
      content =
        `No video-generation model is configured. ` +
        `Go to Settings → Models → Video Generation Model and pick a video-capable model. ` +
        `Tell the user video generation is unavailable until this is configured, do not retry.`;
      isError = true;
      return { content, isError };
    }

    // Engine-enforced canonical params (agent → tool boundary). The agent
    // must supply duration / aspect_ratio / resolution; on a missing or
    // out-of-range value we kick the call back so it re-picks.
    const paramSpec =
      getModelGenerationParams(modelChoice.modelId) ?? defaultVideoSpecFor(modelChoice.apiModelId);
    const validation = validateCanonicalParams(paramSpec, VIDEO_CANONICAL_PARAMS, {
      duration: args.duration_seconds,
      aspect_ratio: args.aspect_ratio,
      resolution: args.resolution,
    });
    if (!validation.ok) {
      content =
        `Video parameters need fixing before I can start:\n- ${validation.errors.join('\n- ')}\n\n` +
        `Re-call video_create with corrected values.`;
      isError = true;
      return { content, isError };
    }

    // Resolve an optional reference image to an absolute path.
    let refImagePath: string | undefined;
    if (refImageAttachmentId) {
      try {
        const resolved = resolveAttachmentPath(refImageAttachmentId);
        if (!resolved) {
          content = `Error: no attachment found with id ${refImageAttachmentId} for the reference image. The file may be stale or deleted.`;
          isError = true;
          return { content, isError };
        }
        refImagePath = resolved.path;
      } catch (err) {
        content = `Error: failed to resolve reference image: ${err instanceof Error ? err.message : String(err)}`;
        isError = true;
        return { content, isError };
      }
    }

    const submit = await submitVideoJob({
      modelId: modelChoice.modelId,
      agentId,
      prompt: description,
      title: rawTitle,
      paramSpec,
      canonicalParams: validation.normalized,
      refImagePath,
    });

    if (!submit.ok) {
      // A-5: honest stop identity. A submit the user stopped is not a provider refusal, and
      // the model must not be steered to explain a failure that did not happen.
      if (submit.code === 'STOPPED') {
        auditLog(agentId, 'video_create', null, 'success', 'Not submitted: the user stopped this agent.');
        content = `${submit.error} The video was not submitted. End your turn.`;
        isError = true;
        return { content, isError };
      }
      auditLog(agentId, 'video_create', null, 'error', submit.error);
      content =
        `Video generation could not be started: ${submit.error}\n\n` +
        `Tell the user briefly that the video couldn't be started. Do not retry automatically.`;
      isError = true;
      return { content, isError };
    }

    auditLog(agentId, 'video_create', null, 'success',
      `Job ${submit.jobId} queued (provider ${submit.providerJobId})`);

    // Broadcast the initial queued state so the dashboard indicator
    // appears immediately, then start polling.
    try {
      const activeRow = db.prepare(
        "SELECT COUNT(*) AS n FROM video_jobs WHERE status IN ('queued','polling')"
      ).get() as { n: number };
      broadcast({
        type: 'video_job:update',
        data: { id: submit.jobId, agentId, status: 'queued', prompt: description, activeCount: activeRow.n },
      });
    } catch { /* best effort */ }

    try {
      enqueueVideoJob(submit.jobId);
    } catch (err) {
      logger.error('video_create: failed to enqueue poller (job will resume on next boot)', {
        jobId: submit.jobId, error: err instanceof Error ? err.message : String(err),
      });
    }

    content =
      `Video generation started (job_id: ${submit.jobId}). The engine is generating the video in the background (1 to 10 min). When it's ready the engine will post it directly to the chat, you do NOT get a second turn and must NOT call video_create again. End your turn now without writing any further text.`;
    return { content, isError };
  },

  async "transcribe_audio"({ agentId, args }) {
    let content = '';
    let isError = false;
    const attachmentId = (args.attachment_id as string | undefined)?.trim();
    let pathArg = (args.path as string | undefined)?.trim();
    const urlArgRaw = (args.url as string | undefined)?.trim();
    const language = (args.language as string | undefined)?.trim() || undefined;

    // Be forgiving: a file:// URL is just a path with a scheme.
    // Strip the scheme and treat it as a path.
    let urlArg = urlArgRaw;
    if (urlArg?.startsWith('file://')) {
      try {
        pathArg = pathArg ?? new URL(urlArg).pathname;
        urlArg = undefined;
      } catch { /* fall through to validation error below */ }
    }

    const sources = [attachmentId, pathArg, urlArg].filter((v) => v && v.length > 0);
    if (sources.length === 0) {
      content = 'Error: pass one of attachment_id (preferred), path, or url (https only).';
      isError = true;
      return { content, isError };
    }
    if (sources.length > 1) {
      content = 'Error: pass only ONE of attachment_id, path, or url, not multiple.';
      isError = true;
      return { content, isError };
    }

    // Resolve to a buffer + mime + filename.
    let audio: Buffer;
    let mimeType: string;
    let filename: string;
    if (attachmentId) {
      const resolved = resolveAttachmentPath(attachmentId);
      if (!resolved) {
        content = `Error: no attachment found with id ${attachmentId}. The file may have been deleted or the id may be stale.`;
        isError = true;
        return { content, isError };
      }
      try {
        audio = effectFs.readFileSync(resolved.path);
      } catch (err) {
        content = `Error: failed to read attachment from disk: ${err instanceof Error ? err.message : String(err)}`;
        isError = true;
        return { content, isError };
      }
      mimeType = resolved.mimeType || 'audio/mpeg';
      filename = resolved.filename;
    } else if (pathArg) {
      // Sandbox the path to the dojo uploads dir to prevent the
      // agent from accidentally (or maliciously) reading arbitrary
      // files off disk.
      const uploadsRoot = pathModule.join(homeDir(), '.dojo', 'uploads');
      const resolvedPath = pathModule.resolve(pathArg);
      if (!resolvedPath.startsWith(uploadsRoot + pathModule.sep)) {
        content = `Error: path must be inside ~/.dojo/uploads/ (got ${resolvedPath}).`;
        isError = true;
        return { content, isError };
      }
      if (!effectFs.existsSync(resolvedPath)) {
        content = `Error: no file at ${resolvedPath}.`;
        isError = true;
        return { content, isError };
      }
      try {
        audio = effectFs.readFileSync(resolvedPath);
      } catch (err) {
        content = `Error: failed to read file: ${err instanceof Error ? err.message : String(err)}`;
        isError = true;
        return { content, isError };
      }
      filename = pathModule.basename(resolvedPath);
      const ext = pathModule.extname(filename).toLowerCase();
      mimeType =
        ext === '.mp3' ? 'audio/mpeg' :
        ext === '.wav' ? 'audio/wav' :
        ext === '.m4a' || ext === '.mp4' ? 'audio/mp4' :
        ext === '.ogg' || ext === '.opus' ? 'audio/ogg' :
        ext === '.webm' ? 'audio/webm' :
        ext === '.aac' ? 'audio/aac' :
        ext === '.flac' ? 'audio/flac' :
        'audio/mpeg';
    } else {
      const fetched = await fetchAudioUrl(agentId, urlArg!);
      if ('error' in fetched) {
        content = `Error: ${fetched.error}`;
        isError = true;
        return { content, isError };
      }
      audio = fetched.buffer;
      mimeType = fetched.mimeType;
      filename = fetched.filename;
    }

    auditLog(agentId, 'transcribe_audio', null, 'success',
      `Source ${attachmentId ? `attachment ${attachmentId}` : `url ${urlArg}`}, ${audio.length} bytes`);

    const result = await transcribeAudio({ agentId, audio, mimeType, filename, language });
    if (!result.ok) {
      // A-5: honest stop identity — the user's button is not a transcription failure.
      content = result.code === 'STOPPED' ? result.error : `Transcription failed: ${result.error}`;
      isError = true;
      return { content, isError };
    }

    // Cost recording. Local engines are free; cloud rides on the
    // unified per-minute pricing path. We skip recordCost entirely
    // for local rather than passing a synthetic modelId, the cost
    // tracker keys off the row, so writing $0 against a synthetic
    // id would just clutter the ledger.
    if (result.costMode === 'cloud') {
      try {
        const choice = getEffectiveTranscriptionModel();
        if (choice && choice.kind === 'cloud') {
          recordCost({
            agentId,
            modelId: choice.modelId,
            providerId: choice.providerId,
            inputTokens: 0,
            outputTokens: 0,
            latencyMs: result.latencyMs,
            requestType: 'transcription',
            units: result.durationSeconds !== null ? result.durationSeconds / 60 : undefined,
          });
        }
      } catch { /* best effort */ }
    }

    logger.info('transcribe_audio: success', {
      requesterId: agentId,
      mode: result.costMode,
      providerId: result.providerId,
      apiModelId: result.apiModelId,
      textLength: result.text.length,
      durationSeconds: result.durationSeconds,
      latencyMs: result.latencyMs,
    });

    // Return the transcript as a normal tool result. The agent
    // decides what to do with it, summarize, write to a file,
    // compare to another transcript, reply verbatim, whatever.
    // Pre-wrap in a fenced `source/transcript` block so when the
    // agent pastes verbatim the user gets a word-wrapped,
    // sans-serif "source" container with a Copy button (rendered
    // by the dashboard's Markdown component). Not a code block, 
    // transcripts shouldn't horizontal-scroll.
    if (result.text.length > 0) {
      content =
        `Transcription of "${filename}" (engine: ${result.apiModelId}).\n` +
        `If you paste the transcript to the user, paste it verbatim INSIDE a fenced \`\`\`source/transcript ... \`\`\` block. Do not paraphrase the words unless the user asks for a summary.\n\n` +
        `\`\`\`source/transcript\n${result.text}\n\`\`\``;
    } else {
      content = `Transcription of "${filename}" (engine: ${result.apiModelId}): no detectable speech.`;
    }
    return { content, isError };
  },

} satisfies Record<string, ToolHandler>;

// `tts_create` and `music_create` were ONE case body reached by two labels
// (`case 'tts_create': case 'music_create': {`), and the body branches on
// `name`. The table is keyed on the dispatch key, so both keys must resolve —
// to the SAME function, which is what the fall-through meant.
export const mediaHandlers: ToolHandlerMap = {
  ...handlers,
  music_create: handlers.tts_create,
};
