// ════════════════════════════════════════════════════════════════════════════
// MEDIA GENERATION: `image_create`, `tts_create` / `music_create` (one body, two tools),
// `video_create`, `transcribe_audio`.
// LAW: the turn-scoped iMessage recipient is captured at tool-CALL time. The delivery
// IIFE outlives the turn and the turn's `finally` ends its `TurnContext`, so a
// delivery-time re-read returns null and the image falls to the owner (or, under
// concurrency, to a third party). The capture's POSITION is the guarantee.
// LAW: no persisted message sits between an assistant `tool_use` and its matching
// `tool_result`; transient progress is broadcast-only. These handlers write no ack row
// on the synchronous path (`__tests__/media-posts-no-ack-row.test.ts` holds zero rows).
// LAW: the engine DETECTS and the agent SPEAKS. It writes nothing in the agent's voice;
// the deferred IIFE's later caption/attachment is the PAYLOAD, after the turn, not an ack.
// ════════════════════════════════════════════════════════════════════════════

import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../../../db/connection.js';
import { broadcast } from '../../../gateway/ws.js';
import { writeAgentStatus } from '../../agent-status.js';
import { deliveredResult, insertMessageIfAbsent } from '../../../memory/message-store.js';
import { getModelCapabilities } from '../../../services/capabilities.js';
import { settleAskOnAsyncResult, settleAskOnJobEnded } from '../../../work/ask-settlement.js';
import { auditLog, toolsLogger as logger } from '../util.js';
import * as effectFs from '../../effects/fs.js';
import pathModule from 'node:path';
import { createGenerationJob as createImgJob, setRunning as setImgRunning, setSucceeded as setImgSucceeded, setFailed as setImgFailed, setCancelled as setImgCancelled, createGenerationJob, enqueueAudioOrMusicJob } from '../../../services/generation-jobs.js';
import { enqueueVideoJob, countActiveVideoJobs } from '../../../services/video-job-poller.js';
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
import { tellAgentAndWake, requesterReachSentence, isFailureWokenTurn, noteJobStartedIn } from '../../wake-with-notice.js';
import { resolvePath, isSensitivePath } from '../../path-guards.js';
import { isPrimaryAgent } from '../../../config/platform.js';
import { recordCost } from '../../../costs/tracker.js';
import { resolveAttachmentPath, fetchAudioUrl, transcribeAudio } from '../../../services/transcription.js';
import { submitVideoJob } from '../../../services/video-generation.js';
import type { ToolHandler, ToolHandlerMap } from '../handler.js';
import { homeDir } from '../../../home.js';
import { turnContext } from '../../turn-context.js';
import { userWords, currentAddress } from '../../v2/turn-address.js';
import { outsideSpan } from '../../../tools/external-content.js';

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

    // Slugify the title into a safe filename stem: lowercase, hyphens collapsed, cap 50.
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
        `Go to Settings → Models → Image Generation Model and pick an image-capable model (e.g. Gemini 2.5 Flash Image on OpenRouter). ` +
        `Tell ${userWords(currentAddress(agentId))} image generation is unavailable until this is configured, do not retry.`;
      isError = true;
      return { content, isError };
    }

    // Tracked as a generation_job so the orb shows it;
    // image_create keeps its own delivery path, driven around the job lifecycle.
    const imgJobId = createImgJob({
      kind: 'image',
      agentId,
      modelId: modelChoice.modelId,
      providerId: modelChoice.providerId,
      prompt: description,
      title: rawTitle || null,
    });
    // ONE durable identity: the job id (carrying source lineage) is the request id.
    const requestId = imgJobId;

    // Append the style hint so the image model gets stylistic direction inline.
    const fullPrompt = styleHint
      ? `${description}\n\nStyle: ${styleHint}`
      : description;

    // Captured BEFORE the runtime clears the flag: the background delivery needs it
    // when the flag is long gone. Turn-anchored, so it stays correct even when the
    // pending map was consumed or overwritten by a newer inbound.
    // Turn-scoped ONLY, by law: a last-inbound fallback could deliver owner-directed
    // content to a contact who texted mid-generation. Null means "not an iMessage
    // reply": dashboard, or the owner on the away branch, never a guessed contact.
    const requesterIMessage = getTurnScopedImRecipient(agentId);
    const triggeredByIMessage = requesterIMessage !== null;
    const wokenByFailure = isFailureWokenTurn(agentId);   // captured at CALL time: a failure inside a failure-woken turn does not wake again
    const live = turnContext(agentId);  // captured at CALL time: the result is labelled with the request
    const resultSubject = deliveredResult(live?.conversationId, live?.root?.kind === 'ask' ? live.root.id : null);

    auditLog(agentId, 'image_create', null, 'success',
      `Request ${requestId} queued (aspect ${aspectRatio}${styleHint ? `, style ${styleHint}` : ''})`,
    );

    // ── Async background generation, fire and forget ──
    // The tool returns its ack IMMEDIATELY and generates in the background; on
    // completion the engine itself writes the synthetic message that carries it.
    const imageModelId = modelChoice.modelId;
    void (async () => {
      try {
        // Wait for the requesting agent's turn to end: a delivery landing mid-response
        // scrambles message order, so the model repeats its ack instead of presenting.
        const waitStart = Date.now();
        const MAX_WAIT_MS = 60000;
        while (Date.now() - waitStart < MAX_WAIT_MS) {
          const agentRow = db.prepare('SELECT status FROM agents WHERE id = ?').get(agentId) as { status: string } | undefined;
          if (agentRow?.status === 'idle' || agentRow?.status === 'error') break;
          await new Promise<void>(r => setTimeout(r, 500));
        }

        // 'working' keeps the thinking dots visible: without it the agent goes idle
        // between the ack and the delivery and the user sees a gap of silence.
        writeAgentStatus(agentId, 'working');
        broadcast({ type: 'agent:status', agentId, status: 'working' });

        // The CAS is READ: a stop pressed during the wait has already lowered its
        // fence, so the abort registry cannot refuse the dial. The row can: a cancelled
        // job never moves to `running`, so nothing is dialled, spent or said.
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
          // Honest stop identity: the user's own button is not a generation failure.
          // No `failed` row, no error column, no failure notice for work the user stopped.
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

          // The engine writes nothing to the person: the failure reaches the AGENT as a
          // notice, so it tells the person in its own words, on the channel asked.
          const askedBy = requesterIMessage ? 'the person who asked' : 'the person who asked (in the dashboard)';
          const reach = requesterIMessage ? await requesterReachSentence(requesterIMessage) : 'They asked in the dashboard: write it as your reply.';
          // The agent is handed the failure AND woken (agent/wake-with-notice.ts) so it tells the person now.
          void tellAgentAndWake({
            agentId, from: 'Image generation', inFailureTurn: wokenByFailure,
            brief:
              `the image you asked for could not be generated. The provider said: ${result.error}. ` +
              `Nothing was sent to ${askedBy}. ${reach} Tell them in your own words that it failed and offer a next step; ` +
              `do not call image_create again with the same description unless they ask.`,
          });
          settleAskOnJobEnded(agentId, imgJobId);   // no bubble was posted; the request is re-asked now that the job ended
          return;
        }

        // Success: record cost under the calling agent (per-megapixel models price by
        // width × height; token-priced models by the provider's token counts).
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
        // Copy into the caller's uploads dir for a stable on-disk path; the synthetic
        // assistant message written below carries the attachment. No model call.
        const recipientDir = path.join(homeDir(), '.dojo', 'uploads', agentId);
        if (!effectFs.existsSync(recipientDir)) effectFs.mkdirSync(recipientDir, { recursive: true });
        // Prefer the agent's slug plus a short id chunk; with no title, fall back to
        // the image_create_<reqId>_<uuid> shape.
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
          // NO engine caption and NO model call: a model turn at delivery time re-reads
          // the original prompt and re-calls image_create, so one request could yield
          // several images. The engine writes the one clean bubble itself.
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

          // The engine writes NO caption in the agent's voice; the agent is told below.
          const caption = '';

          const deliveryMsgId = uuidv4();
          const attachmentsJson = JSON.stringify([attachment]);
          insertMessageIfAbsent({
            id: deliveryMsgId, agentId, role: 'assistant', content: caption,
            attachments: attachmentsJson, ...resultSubject,
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

          setImgSucceeded(imgJobId, { assetPath: deliveredPath });
          settleAskOnAsyncResult({ agentId, askMessageId: resultSubject.rootId, resultMessageId: deliveryMsgId });   // the job is finished and its result reached the owner

          try {
            postAgentNotice({
              toAgentId: agentId, fromName: 'Image delivery', intent: 'image_delivery_outcome', selfIntro: false,
              brief: `the finished image was delivered (posted in the dashboard${triggeredByIMessage ? ' and being texted to the requester' : ''}) with no caption: the Dojo wrote no words around it. ` +
                'If you want to say something about it, say it in your own words.',
            });
          } catch { /* awareness note is best-effort */ }
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
          // Reaching a real phone is a channel question: ask `mayUseChannel`, the same
          // reader ladder the `comms.ts` walls and the engine auto-route ask.
          if (mayUseChannel(agentId, 'imessage')) {
            let shouldSendViaIMessage = triggeredByIMessage;
            if (!shouldSendViaIMessage) {
              try {
                shouldSendViaIMessage = getPresence() === 'away';
              } catch { /* presence module unavailable */ }
            }
            if (shouldSendViaIMessage) {
              // Route to the REQUESTER, never default to the owner; the owner only for a
              // proactive or away send. Use the call-time capture, not a delivery re-read.
              const recipient = requesterIMessage ?? getDefaultSender();
              if (recipient) {
                // Capture the ACTUAL delivery outcome and thread it back to the model:
                // sendIMessageWithAttachment returns true only when the file went out.
                const iMessageDelivered = await sendIMessageWithAttachment(recipient, result.filePath, '');
                const deliveryOutcome = iMessageDelivered
                  ? 'the finished image was texted to the requester over iMessage'
                  : 'texting the image to the requester failed (the iMessage attachment channel is unavailable), it is available in the dashboard only';
                logger.info('image_create: iMessage delivery outcome', {
                  requestId, requesterId: agentId, delivered: iMessageDelivered,
                });
                // Correction ONLY on FAILURE: on success the ack already promised the text.
                // postAgentNotice is the sanctioned model-visible awareness channel (out of the
                // human chat); a failed send must never read as done.
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
        // The caller goes back to idle once the background job has run its course.
        writeAgentStatus(agentId, 'idle');
        broadcast({ type: 'agent:status', agentId, status: 'idle' });
      }
    })();

    // A model without vision gets a no-hallucination reminder; the image lands in
    // the chat regardless, only the agent's ability to describe it changes.
    let visionTail = '';
    try {
      const callerModel = db
        .prepare('SELECT model_id FROM agents WHERE id = ?')
        .get(agentId) as { model_id: string | null } | undefined;
      const callerCaps = callerModel?.model_id ? getModelCapabilities(callerModel.model_id) : [];
      if (callerCaps.length > 0 && !callerCaps.includes('vision')) {
        visionTail =
          `\n\nNote: your current model does NOT support image input. The image will be delivered to ${userWords(currentAddress(agentId))} as an attachment and ${userWords(currentAddress(agentId))} will see it; you will NOT see it. ` +
          `Acknowledge delivery with a short message ("here's the image you asked for" or similar) but do NOT describe what is "in" the image as if you can see it, anything you write about its visual contents will be a hallucination.`;
      }
    } catch { /* skip tail on lookup failure */ }

    // State WHERE the image lands so the completion line is truthful: on an
    // iMessage turn the engine auto-texts the requester, so "check the dashboard"
    // is wrong there; on a dashboard turn it lands in the chat.
    const deliveryClause = triggeredByIMessage
      ? `When the image is ready in 10-60 s, the engine will post it to the dashboard AND text it to the person who asked over iMessage, no second turn from you. Your own words are what they get with it, so write that line in this turn, in your next reply (it is text only, no more tools run); do not tell them to "check the dashboard" (they are on iMessage and will receive the image itself), just say it is on the way.`
      : `When the image is ready in 10-60 s, the engine will post it directly to the chat with no caption of its own, no second turn from you. Your own words are what they get with it, so write that line in this turn, in your next reply (it is text only, no more tools run).`;
    content =
      `Image generation kicked off (request_id: ${requestId}). ${deliveryClause} ` +
      `The engine adds no caption: the line you write in this turn is the only text that arrives with the image.` +
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
        ? `No music-generation model is configured. Go to Settings → Models → Music Generation Model and pick a music-capable model (e.g. Google Lyria). Tell ${userWords(currentAddress(agentId))} music generation is unavailable until this is configured, do not retry.`
        : `No audio-generation model is configured. Go to Settings → Models → Text-to-Speech (TTS) Model and pick an audio-capable model. Tell ${userWords(currentAddress(agentId))} audio generation is unavailable until this is configured, do not retry.`;
      isError = true;
      return { content, isError };
    }

    // A voice outside the model's catalog is kicked back: the provider's voice enum
    // is closed, so character or age go into the spoken text, not the id.
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
      `${isMusic ? 'Music' : 'Audio'} generation started (job_id: ${jobId}). The engine is generating the asset in the background. When it's ready the engine will post it directly to the chat. You do NOT get a second turn and must NOT call ${name} again. The engine adds no caption: the words you write in this turn are the only text that arrives with the ${kind}, so write them now, in your next reply (it is text only, no more tools run).`;
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

    const modelChoice = getEffectiveVideoGenModel();
    if (!modelChoice) {
      content =
        `No video-generation model is configured. ` +
        `Go to Settings → Models → Video Generation Model and pick a video-capable model. ` +
        `Tell ${userWords(currentAddress(agentId))} video generation is unavailable until this is configured, do not retry.`;
      isError = true;
      return { content, isError };
    }

    // Canonical params are engine-enforced at the boundary: a missing or
    // out-of-range value kicks the call back so the agent re-picks.
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
      // Honest stop identity: a submit the user stopped is not a provider refusal,
      // and the model must not explain a failure that did not happen.
      if (submit.code === 'STOPPED') {
        auditLog(agentId, 'video_create', null, 'success', 'Not submitted: the user stopped this agent.');
        content = `${submit.error} The video was not submitted. End your turn.`;
        isError = true;
        return { content, isError };
      }
      auditLog(agentId, 'video_create', null, 'error', submit.error);
      content =
        `Video generation could not be started: ${submit.error}\n\n` +
        `Tell ${userWords(currentAddress(agentId))} briefly that the video couldn't be started. Do not retry automatically.`;
      isError = true;
      return { content, isError };
    }

    auditLog(agentId, 'video_create', null, 'success',
      `Job ${submit.jobId} queued (provider ${submit.providerJobId})`);

    // Broadcast the initial queued state so the dashboard indicator
    // appears immediately, then start polling.
    try {
      // The count comes from the module that owns the table, not a fourth copy of the
      // predicate here: one census, one place (services/media-job-status.ts).
      const activeRow = { n: countActiveVideoJobs() };
      broadcast({
        type: 'video_job:update',
        data: { id: submit.jobId, agentId, status: 'queued', prompt: description, activeCount: activeRow.n },
      });
    } catch { /* best effort */ }

    try {
      enqueueVideoJob(submit.jobId); noteJobStartedIn(agentId, submit.jobId);   // loop guard: see wake-with-notice.ts
    } catch (err) {
      logger.error('video_create: failed to enqueue poller (job will resume on next boot)', {
        jobId: submit.jobId, error: err instanceof Error ? err.message : String(err),
      });
    }

    content =
      `Video generation started (job_id: ${submit.jobId}). The engine is generating the video in the background (1 to 10 min). When it's ready the engine will post it directly to the chat, you do NOT get a second turn and must NOT call video_create again. The engine adds no caption: the words you write in this turn are the only text that arrives with the video, so write them now, in your next reply (it is text only, no more tools run).`;
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
    // What the audit line names this source as: the attachment id, the resolved
    // file path, or the url: whichever branch actually produced the audio.
    let sourceLabel: string;
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
      sourceLabel = `attachment ${attachmentId}`;
    } else if (pathArg) {
      // Fenced to the uploads dir so agents cannot read arbitrary disk; the main agent (`isPrimaryAgent`)
      // may transcribe any non-secret path. Key and password files stay hidden from EVERY agent.
      const uploadsRoot = pathModule.join(homeDir(), '.dojo', 'uploads');
      const resolvedPath = pathModule.resolve(resolvePath(pathArg));
      if (isSensitivePath(resolvedPath)) {
        content = `[BLOCKED] transcribe_audio refused: ${resolvedPath} is on the sensitive-files block list (secrets.yaml, .env files, SSH keys, cloud credentials).`;
        isError = true;
        return { content, isError };
      }
      if (!isPrimaryAgent(agentId) && !resolvedPath.startsWith(uploadsRoot + pathModule.sep)) {
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
      sourceLabel = `path ${resolvedPath}`;
    } else {
      const fetched = await fetchAudioUrl(agentId, urlArg!);
      if ('error' in fetched) {
        // Both arms of ONE tool render a user stop the same way: the stop sentence
        // stands bare, never prefixed `Error:` on the user's own button.
        content = fetched.stopped ? fetched.error : `Error: ${fetched.error}`;
        isError = true;
        return { content, isError };
      }
      audio = fetched.buffer;
      mimeType = fetched.mimeType;
      filename = fetched.filename;
      sourceLabel = `url ${urlArg}`;
    }

    auditLog(agentId, 'transcribe_audio', sourceLabel.slice(0, 200), 'success',
      `Source ${sourceLabel}, ${audio.length} bytes`);

    const result = await transcribeAudio({ agentId, audio, mimeType, filename, language });
    if (!result.ok) {
      // Honest stop identity: the user's button is not a transcription failure.
      content = result.code === 'STOPPED' ? result.error : `Transcription failed: ${result.error}`;
      isError = true;
      return { content, isError };
    }

    // Cost: local engines are free and skip recordCost entirely; a synthetic id
    // would write $0 rows that clutter the ledger (the tracker keys off the row).
    // Cloud rides the unified per-minute pricing path.
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

    // The transcript is a normal tool result; the agent decides what to do with it.
    // It is wrapped in a fenced `source/transcript` block so a verbatim paste lands
    // in the dashboard's word-wrapped "source" container with a Copy button. Not a
    // code block: transcripts must not horizontal-scroll.
    if (result.text.length > 0) {
      content =
        `Transcription of "${filename}" (engine: ${result.apiModelId}).\n` +
        `If you paste the transcript to ${userWords(currentAddress(agentId))}, paste it verbatim INSIDE a fenced \`\`\`source/transcript ... \`\`\` block. Do not paraphrase the words unless ${userWords(currentAddress(agentId))} asks for a summary.\n\n` +
        `\`\`\`source/transcript\n${outsideSpan(result.text)}\n\`\`\``;   // only the words are outside text
    } else {
      content = `Transcription of "${filename}" (engine: ${result.apiModelId}): no detectable speech.`;
    }
    return { content, isError };
  },

} satisfies Record<string, ToolHandler>;

// The table is keyed on the dispatch key: `tts_create` and `music_create` must
// resolve to the SAME function, because the one body branches on `name`.
export const mediaHandlers: ToolHandlerMap = {
  ...handlers,
  music_create: handlers.tts_create,
};
