// System control tools: mouse, keyboard, screenshot, AppleScript.
// NO SHELL HERE: every call spawns a program with an argv vector (see `run`), so
// model-chosen bytes never reach a parser. The vectors are built, PRE-SPLIT where a
// program takes several arguments, in the pure module `system-control-argv.ts`.
// One runner binds every spawn to the owner's stop: `runBoundToTheStop`, imported as
// `run` from `stop-bound-run.ts`; no call here runs unbound.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createLogger } from '../logger.js';
import { callModel } from './model.js';
import { openAgentCall } from './abortable-call.js';
import { getEffectiveVisionModel } from '../services/vision-model.js';
import {
  clickArgv, moveArgv, keyComboArgv, typeTextArgv, screencaptureArgv,
} from './system-control-argv.js';
import { runBoundToTheStop as run, programOnPath } from './stop-bound-run.js';   // the one runner, bound to the owner's stop

const logger = createLogger('system-control');

let cliclickAvailable: boolean | null = null;

function checkCliclick(): boolean {
  if (cliclickAvailable !== null) return cliclickAvailable;
  cliclickAvailable = programOnPath('cliclick');
  return cliclickAvailable;
}

export async function mouseClick(
  agentId: string,
  args: { x: number; y: number; click_type?: string },
): Promise<string> {
  if (!checkCliclick()) {
    return 'Error: cliclick is not installed. Install with: brew install cliclick';
  }

  const { x, y, click_type = 'left' } = args;

  logger.info('Mouse click', { x, y, click_type }, agentId);

  try {
    await run('cliclick', clickArgv(x, y, click_type), { agentId, timeout: 5000 });
    return `Clicked ${click_type} at (${x}, ${y})`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Mouse click failed', { error: msg }, agentId);
    return `Error: Mouse click failed: ${msg}`;
  }
}

export async function mouseMove(
  agentId: string,
  args: { x: number; y: number },
): Promise<string> {
  if (!checkCliclick()) {
    return 'Error: cliclick is not installed. Install with: brew install cliclick';
  }

  const { x, y } = args;

  logger.info('Mouse move', { x, y }, agentId);

  try {
    await run('cliclick', moveArgv(x, y), { agentId, timeout: 5000 });
    return `Mouse moved to (${x}, ${y})`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Mouse move failed', { error: msg }, agentId);
    return `Error: Mouse move failed: ${msg}`;
  }
}

export async function keyboardType(
  agentId: string,
  args: { text?: string; key_combo?: string },
): Promise<string> {
  if (!checkCliclick()) {
    return 'Error: cliclick is not installed. Install with: brew install cliclick';
  }

  const { text, key_combo } = args;

  if (!text && !key_combo) {
    return 'Error: Either text or key_combo must be provided';
  }

  logger.info('Keyboard input', { text: text?.slice(0, 50), key_combo }, agentId);

  try {
    if (key_combo) {
      const argv = keyComboArgv(key_combo);
      if (!argv) return `Error: Unknown key combo: ${key_combo}`;
      await run('cliclick', argv, { agentId, timeout: 5000 });
      return `Key combo pressed: ${key_combo}`;
    }

    if (text) {
      // No escaping: the text is one argv element, so there is no quote to close
      // and no shell to close it into.
      await run('cliclick', typeTextArgv(text), { agentId, timeout: 10000 });
      return `Typed: "${text.length > 100 ? text.slice(0, 100) + '...' : text}"`;
    }

    return 'Error: No input provided';
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Keyboard input failed', { error: msg }, agentId);
    return `Error: Keyboard input failed: ${msg}`;
  }
}

// Vision-model resolution lives in services/vision-model.ts, one helper for every image route.

export async function screenRead(
  agentId: string,
  args: { region?: { x: number; y: number; width: number; height: number }; query?: string },
): Promise<string> {
  const { region, query } = args;
  const tmpDir = path.join(os.tmpdir(), 'dojo-screenshots');

  if (!fs.existsSync(tmpDir)) {
    fs.mkdirSync(tmpDir, { recursive: true });
  }

  const screenshotPath = path.join(tmpDir, `screen_${Date.now()}.png`);

  logger.info('Taking screenshot', { region, query }, agentId);

  try {
    // The output path is ONE argv element: directories with spaces work by construction.
    await run('screencapture', screencaptureArgv(screenshotPath, region ?? null), { agentId, timeout: 10000 });

    if (!fs.existsSync(screenshotPath)) {
      return 'Error: Screenshot capture failed, file was not created. Ensure screen recording permission is granted in System Settings → Privacy & Security → Screen Recording.';
    }

    // Read image as base64
    const imageData = fs.readFileSync(screenshotPath);
    const base64Image = imageData.toString('base64');

    // Model choice is `getEffectiveVisionModel`: the agent's own model when it has
    // vision, else the user's configured platform fallback; null means neither.
    const visionModel = getEffectiveVisionModel(agentId);
    if (!visionModel) {
      return `Screenshot saved to: ${screenshotPath}\nNo vision-capable model is configured. Either set a fallback vision model in Settings → Models → Fallback Vision Model, or switch the calling agent to a vision-capable model in Settings → Models.`;
    }
    logger.info('screen_screenshot: model selected', {
      modelId: visionModel.modelId,
      apiModelId: visionModel.apiModelId,
      source: visionModel.source,
    }, agentId);

    // Build the vision prompt
    const visionPrompt = query
      ? `You are a screen reader assistant. Look at this screenshot and answer: ${query}\nFor interactive elements (buttons, links, text fields, menus), provide approximate pixel coordinates as [x,y]. Be precise about positions.`
      : 'You are a screen reader assistant. Describe what you see on the screen. For interactive elements (buttons, links, text fields, menus), provide approximate pixel coordinates as [x,y]. Be precise about positions. List all visible text and UI elements.';

    // The bound rides the model call's own signal through `openAgentCall`: expiry
    // CUTS the request, the registry lets the owner's stop reach it, and the slot
    // releases on settle. `Promise.race` cannot cancel the call it abandons; the
    // timeout branch below attaches only when a bound (not a stop) cut the call.
    const SCREEN_READ_MODEL_TIMEOUT_MS = 60_000;
    const slot = openAgentCall(agentId, 'turn', AbortSignal.timeout(SCREEN_READ_MODEL_TIMEOUT_MS));
    if (slot.refused) {
      slot.release();
      try { fs.unlinkSync(screenshotPath); } catch { /* best-effort */ }
      return 'Error: Screen read failed: the user stopped this agent before the vision call began';
    }
    const modelCall = callModel({
      abortSignal: slot.signal,
      agentId,
      modelId: visionModel.modelId,
      // A caption of what is on screen, for the agent to read: an engine artifact.
      purpose: 'vision_caption',
      messages: [{
        role: 'user' as const,
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: base64Image,
            },
          },
          {
            type: 'text',
            text: visionPrompt,
          },
        ] as never,
      }],
      systemPrompt: 'You are a screen reader assistant for a macOS automation platform. Be precise and thorough in describing screen contents.',
      tools: false,
    });
    let result;
    try {
      result = await modelCall;
    } catch (callErr) {
      const cut = slot.cutBy();
      if (cut && !slot.cutByStop()) {
        throw new Error(`screen_screenshot timed out after ${SCREEN_READ_MODEL_TIMEOUT_MS / 1000}s waiting for ${visionModel.apiModelId} (provider ${visionModel.providerId}). The screenshot was captured fine; the model call hung. Try again, or pick a different vision model in Settings → Models.`);
      }
      throw callErr;
    } finally {
      slot.release();
    }

    // Clean up screenshot
    try { fs.unlinkSync(screenshotPath); } catch { /* best-effort */ }

    return result.content;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Screen read failed', { error: msg }, agentId);
    // Clean up on error
    try { fs.unlinkSync(screenshotPath); } catch { /* ignore */ }
    return `Error: Screen read failed: ${msg}`;
  }
}

// Five minutes: an AppleScript driving a large mailbox or a Finder batch is legitimately
// slow, and its side effects are not transactional, so a wrong cut leaves a half-applied change.
const APPLESCRIPT_CEILING_MS = 5 * 60_000;

export async function applescriptRun(
  agentId: string,
  args: { script: string },
): Promise<string> {
  const { script } = args;

  logger.info('Running AppleScript', { scriptLength: script.length }, agentId);

  try {
    // `osascript -` reads the script from STDIN, so the script text never appears
    // on a command line. The authorization gate (`brokers/applescript.ts`) reads the
    // script, including any `do shell script` payload inside it, before this runs.
    const result = await run('osascript', ['-'], { agentId,
      // osascript produces no incremental output: there is no progress signal to
      // re-arm on, so the bound is a flat CEILING, set where a real script does not
      // reach it; only a wedged `osascript` holding a UI dialog ever hits it, and the
      // kill states plainly that it fired. A bound must exist: it cannot run forever.
      timeout: APPLESCRIPT_CEILING_MS,
      input: script,
      maxBuffer: 1024 * 1024,
    });

    return result.trim() || '(AppleScript completed with no output)';
  } catch (err: unknown) {
    const error = err as { stderr?: string; message?: string; status?: number };
    const stderr = error.stderr ?? error.message ?? 'Unknown error';
    logger.error('AppleScript failed', { error: String(stderr).slice(0, 500) }, agentId);
    return `AppleScript error: ${String(stderr).slice(0, 1000)}`;
  }
}
