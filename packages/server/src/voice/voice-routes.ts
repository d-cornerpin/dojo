/**
 * Voice settings & model management API.
 *
 *   GET    /api/voice/voices                       — list Kokoro voice presets
 *   GET    /api/voice/models                       — installed STT/TTS models + disk usage
 *   POST   /api/voice/models/:kind/:id             — download (whisper) / preload (kokoro)
 *   DELETE /api/voice/models/:kind/:id             — delete a model file from disk
 *   POST   /api/voice/preview                      — synthesize a short clip in a voice
 *
 * Voice config (preferred voice, playback speed, VAD sensitivity, STT model)
 * lives in the existing `config` table via /api/config/settings/:key — no new
 * routes needed there.
 */

import { Hono } from 'hono';
import { createLogger } from '../logger.js';
import { broadcast } from '../gateway/ws.js';
import {
  WHISPER_MODELS,
  DEFAULT_WHISPER,
  ensureWhisperModel,
  ensureKokoroFiles,
  listInstalledModels,
  deleteModel,
  totalVoiceDiskBytes,
  freeDiskMb,
  type WhisperSize,
} from './model-manager.js';
import { synthesizeOnce, listVoices, DEFAULT_VOICE, loadKokoro, isKokoroLoaded } from './tts-service.js';

const logger = createLogger('voice-routes');

export const voiceRouter = new Hono();

// ── Voice presets ──

voiceRouter.get('/voices', (c) => {
  return c.json({
    ok: true,
    data: {
      voices: listVoices(),
      defaultVoice: DEFAULT_VOICE,
    },
  });
});

// ── Installed models ──

voiceRouter.get('/models', async (c) => {
  const models = listInstalledModels();
  const totalBytes = totalVoiceDiskBytes();
  const freeMb = await freeDiskMb();

  // Annotate each whisper entry with its label + approximate download size,
  // so the dashboard can render "Base (147 MB) — fast, lower quality".
  const whisper = models
    .filter((m) => m.kind === 'whisper')
    .map((m) => {
      const spec = WHISPER_MODELS[m.id as WhisperSize];
      return {
        ...m,
        label: spec?.label ?? m.id,
        approxBytes: spec?.approxBytes ?? null,
      };
    });

  const kokoro = models.find((m) => m.kind === 'kokoro') ?? null;

  return c.json({
    ok: true,
    data: {
      whisper,
      kokoro,
      defaultWhisper: DEFAULT_WHISPER,
      kokoroLoaded: isKokoroLoaded(),
      totalDiskBytes: totalBytes,
      freeDiskMb: freeMb,
    },
  });
});

// ── Download / install ──

voiceRouter.post('/models/:kind/:id', async (c) => {
  const kind = c.req.param('kind');
  const id = c.req.param('id');
  if (kind === 'whisper') {
    if (!(id in WHISPER_MODELS)) {
      return c.json({ ok: false, error: `unknown whisper model: ${id}` }, 400);
    }
    try {
      await ensureWhisperModel(id as WhisperSize, (p) => {
        // Broadcast download progress so the dashboard's Voice tab can
        // render a live progress bar against the model row.
        broadcast({
          type: 'voice:model_download',
          data: {
            kind: 'whisper',
            modelId: id,
            bytesDownloaded: p.bytesDownloaded,
            bytesTotal: p.bytesTotal,
          },
        });
      });
      // Final 100% tick so the bar finishes cleanly.
      broadcast({
        type: 'voice:model_download',
        data: { kind: 'whisper', modelId: id, bytesDownloaded: 1, bytesTotal: 1 },
      });
      return c.json({ ok: true, data: { kind, id, installed: true } });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('whisper download failed', { id, error: msg });
      return c.json({ ok: false, error: msg }, 500);
    }
  }
  if (kind === 'kokoro') {
    try {
      // Direct-download path (bypasses transformers.js's broken cache layer).
      // ensureKokoroFiles fetches every required file straight into
      // ~/.dojo/voice/kokoro/onnx-community/Kokoro-82M-v1.0-ONNX/ and reports
      // real-byte progress. Then loadKokoro() reads them locally — no
      // re-download, no cache.put/match dance.
      await ensureKokoroFiles((p) => {
        broadcast({
          type: 'voice:model_download',
          data: {
            kind: 'kokoro',
            modelId: id,
            bytesDownloaded: p.bytesDownloaded,
            bytesTotal: p.bytesTotal,
          },
        });
      });
      // Now that files are on disk, warm up the in-memory model instance so
      // the next voice session doesn't pay the load cost.
      await loadKokoro();
      return c.json({ ok: true, data: { kind, id, loaded: true } });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      logger.error('kokoro install failed', { error: msg, stack });
      return c.json({ ok: false, error: msg }, 500);
    }
  }
  return c.json({ ok: false, error: `unknown model kind: ${kind}` }, 400);
});

// ── Delete ──

voiceRouter.delete('/models/:kind/:id', async (c) => {
  const kind = c.req.param('kind');
  const id = c.req.param('id');
  if (kind !== 'whisper' && kind !== 'kokoro') {
    return c.json({ ok: false, error: `unknown model kind: ${kind}` }, 400);
  }
  try {
    await deleteModel(kind, id);
    return c.json({ ok: true, data: { kind, id, deleted: true } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ ok: false, error: msg }, 500);
  }
});

// ── Voice preview ──

const DEFAULT_PREVIEW_TEXT = 'Hi, this is your voice for the dojo. How does it sound?';

voiceRouter.post('/preview', async (c) => {
  const body = await c.req.json().catch(() => ({} as { voice?: string; text?: string; speed?: number }));
  const voice = typeof body.voice === 'string' && body.voice.length > 0 ? body.voice : DEFAULT_VOICE;
  const text = (typeof body.text === 'string' && body.text.trim().length > 0 ? body.text : DEFAULT_PREVIEW_TEXT).slice(0, 240);
  const speed = typeof body.speed === 'number' && body.speed > 0.5 && body.speed < 2 ? body.speed : 1;

  try {
    const result = await synthesizeOnce(text, voice, speed);
    return new Response(result.wav, {
      status: 200,
      headers: {
        'Content-Type': 'audio/wav',
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('Voice preview failed', { voice, error: msg });
    return c.json({ ok: false, error: msg }, 500);
  }
});
