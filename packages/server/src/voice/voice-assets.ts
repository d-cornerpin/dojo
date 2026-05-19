/**
 * Serves VAD + ORT runtime assets from node_modules. The dashboard's voice
 * client points its onnxWASMBasePath / baseAssetPath at /api/voice/assets/...
 * so vite's dev middleware doesn't try to resolve these as importable modules.
 */

import { Hono } from 'hono';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '../logger.js';

const logger = createLogger('voice-assets');

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '../../../..');

const ASSET_MAP: Record<string, string> = {
  // VAD
  'vad/vad.worklet.bundle.min.js': 'node_modules/@ricky0123/vad-web/dist/vad.worklet.bundle.min.js',
  'vad/silero_vad_legacy.onnx':    'node_modules/@ricky0123/vad-web/dist/silero_vad_legacy.onnx',
  'vad/silero_vad_v5.onnx':        'node_modules/@ricky0123/vad-web/dist/silero_vad_v5.onnx',

  // ORT — list every variant @ricky0123/vad-web may pull in
  'ort/ort-wasm-simd-threaded.mjs':           'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs',
  'ort/ort-wasm-simd-threaded.wasm':          'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm',
  'ort/ort-wasm-simd-threaded.jsep.mjs':      'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.mjs',
  'ort/ort-wasm-simd-threaded.jsep.wasm':     'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm',
  'ort/ort-wasm-simd-threaded.jspi.mjs':      'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jspi.mjs',
  'ort/ort-wasm-simd-threaded.jspi.wasm':     'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jspi.wasm',
  'ort/ort-wasm-simd-threaded.asyncify.mjs':  'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.mjs',
  'ort/ort-wasm-simd-threaded.asyncify.wasm': 'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm',
};

const MIME: Record<string, string> = {
  '.mjs':  'text/javascript; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
};

export const voiceAssetsRouter = new Hono();

voiceAssetsRouter.get('/:kind/:filename', async (c) => {
  const kind = c.req.param('kind');
  const filename = c.req.param('filename');
  const key = `${kind}/${filename}`;
  const rel = ASSET_MAP[key];
  if (!rel) {
    return c.json({ ok: false, error: `unknown voice asset: ${key}` }, 404);
  }
  const full = path.join(repoRoot, rel);
  if (!fs.existsSync(full)) {
    logger.warn('Voice asset missing from node_modules', { full });
    return c.json({ ok: false, error: 'asset not found on disk' }, 404);
  }
  const ext = path.extname(full).toLowerCase();
  const body = fs.readFileSync(full);
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Cache-Control': 'public, max-age=86400',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'cross-origin',
    },
  });
});
