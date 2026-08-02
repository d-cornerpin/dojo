// ════════════════════════════════════════════════════════════════════════════
// System Control Tools (Phase 5A) — Mouse, Keyboard, Screenshot, AppleScript
//
// ⚠ NO SHELL LIVES IN THIS FILE (PHASE-5 T3 Step 2). Every call here used to
// build a command STRING and hand it to `execSync`, which is `/bin/sh -c`. Five
// of the six interpolated a value the model chose, and `keyboard_type` did it
// with a hand-rolled single-quote escape on text an agent composed — gated by
// nothing but `system_control`, so an agent granted *"control the mouse and
// keyboard"* held a shell. §T0-PINS P7 records `osascript -` as the same class.
//
// `execFileSync(program, argv)` is what stands here now: a program and an
// argument VECTOR, so the bytes never reach a parser. The vectors are built by
// `system-control-argv.ts`, which is PURE — the splitting that `/bin/sh` used to
// do (a key combo is FOUR arguments, not one string) is explicit there, where a
// test can read it, and `system-control-argv.test.ts` asserts an injection
// payload comes back as one inert element.
// ════════════════════════════════════════════════════════════════════════════

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createLogger } from '../logger.js';
import { callModel } from './model.js';
import { getDb } from '../db/connection.js';
import { getEffectiveVisionModel } from '../services/vision-model.js';
import {
  clickArgv, moveArgv, keyComboArgv, typeTextArgv, screencaptureArgv,
} from './system-control-argv.js';

const logger = createLogger('system-control');

// ── Dependency Check ──

let cliclickAvailable: boolean | null = null;

function checkCliclick(): boolean {
  if (cliclickAvailable !== null) return cliclickAvailable;
  try {
    execFileSync('which', ['cliclick'], { encoding: 'utf-8', timeout: 5000 });
    cliclickAvailable = true;
  } catch {
    cliclickAvailable = false;
  }
  return cliclickAvailable;
}

// ── Mouse Click ──

export function mouseClick(
  agentId: string,
  args: { x: number; y: number; click_type?: string },
): string {
  if (!checkCliclick()) {
    return 'Error: cliclick is not installed. Install with: brew install cliclick';
  }

  const { x, y, click_type = 'left' } = args;

  logger.info('Mouse click', { x, y, click_type }, agentId);

  try {
    execFileSync('cliclick', clickArgv(x, y, click_type), { timeout: 5000, encoding: 'utf-8' });
    return `Clicked ${click_type} at (${x}, ${y})`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Mouse click failed', { error: msg }, agentId);
    return `Error: Mouse click failed: ${msg}`;
  }
}

// ── Mouse Move ──

export function mouseMove(
  agentId: string,
  args: { x: number; y: number },
): string {
  if (!checkCliclick()) {
    return 'Error: cliclick is not installed. Install with: brew install cliclick';
  }

  const { x, y } = args;

  logger.info('Mouse move', { x, y }, agentId);

  try {
    execFileSync('cliclick', moveArgv(x, y), { timeout: 5000, encoding: 'utf-8' });
    return `Mouse moved to (${x}, ${y})`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Mouse move failed', { error: msg }, agentId);
    return `Error: Mouse move failed: ${msg}`;
  }
}

// ── Keyboard Type ──

// The combo table moved to `system-control-argv.ts` PRE-SPLIT. It had to: the
// space-splitting inside `cliclick kd:cmd t:c ku:cmd` was the SHELL's work, so
// dropping the shell without moving the splitting would hand cliclick one
// argument it does not understand and the keyboard would silently stop working.

export function keyboardType(
  agentId: string,
  args: { text?: string; key_combo?: string },
): string {
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
      execFileSync('cliclick', argv, { timeout: 5000, encoding: 'utf-8' });
      return `Key combo pressed: ${key_combo}`;
    }

    if (text) {
      // ⚠ NO ESCAPING, AND THAT IS THE FIX. The old line was
      //     const escaped = text.replace(<single quotes>, "'\\''");
      //     <the string form of exec>(`cliclick t:'${escaped}'`)
      // — a hand-rolled quote escape in front of /bin/sh, on model-authored
      // text. As one argv element the text is bytes cliclick receives; there is
      // no quote to close and no shell to close it into.
      execFileSync('cliclick', typeTextArgv(text), { timeout: 10000, encoding: 'utf-8' });
      return `Typed: "${text.length > 100 ? text.slice(0, 100) + '...' : text}"`;
    }

    return 'Error: No input provided';
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Keyboard input failed', { error: msg }, agentId);
    return `Error: Keyboard input failed: ${msg}`;
  }
}

// ── Screenshot / Screen Read ──
//
// Vision-model resolution now lives in services/vision-model.ts so a
// single helper governs every place on the platform that needs to
// route an image through a vision-capable model. The old in-file
// findVisionModel() that lived here did its own auto-pick of the
// "cheapest vision-ish enabled model" when the calling agent couldn't
// see, that decision is now an explicit, user-controlled config
// (Settings → Dojo → Fallback vision model).

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
    // Capture screenshot. The output path is ONE argv element, so a directory
    // with a space in it works by construction rather than by the quoting the
    // string form got right only by accident.
    execFileSync('screencapture', screencaptureArgv(screenshotPath, region ?? null), {
      timeout: 10000, encoding: 'utf-8',
    });

    if (!fs.existsSync(screenshotPath)) {
      return 'Error: Screenshot capture failed, file was not created. Ensure screen recording permission is granted in System Settings > Privacy & Security > Screen Recording.';
    }

    // Read image as base64
    const imageData = fs.readFileSync(screenshotPath);
    const base64Image = imageData.toString('base64');

    // Pick a model via the centralized vision-model resolver:
    //   1. Use the calling agent's own model if it has vision (one
    //      round trip, no extra hop).
    //   2. Otherwise route through whichever model the user has set as
    //      the platform's fallback vision model (Settings → Dojo).
    //   3. If neither path is available, return a degraded text result
    //      pointing the user at the right Settings control.
    const visionModel = getEffectiveVisionModel(agentId);
    if (!visionModel) {
      return `Screenshot saved to: ${screenshotPath}\nNo vision-capable model is configured. Either set a fallback vision model in Settings → Dojo → Fallback vision model, or switch the calling agent to a vision-capable model in Settings → Models.`;
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

    // 60s timeout on the model call. screencapture has its own 10s timeout
    // above; this caps the inner vision call so a hung provider returns a
    // clean error instead of bleeding into the agent's turn budget.
    const SCREEN_READ_MODEL_TIMEOUT_MS = 60_000;
    const modelCall = callModel({
      agentId,
      modelId: visionModel.modelId,
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
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`screen_screenshot timed out after ${SCREEN_READ_MODEL_TIMEOUT_MS / 1000}s waiting for ${visionModel.apiModelId} (provider ${visionModel.providerId}). The screenshot was captured fine; the model call hung. Try again, or pick a different vision model in Settings > Models.`)),
        SCREEN_READ_MODEL_TIMEOUT_MS,
      ),
    );
    const result = await Promise.race([modelCall, timeoutPromise]);

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

// ── AppleScript Run ──

export function applescriptRun(
  agentId: string,
  args: { script: string },
): string {
  const { script } = args;

  logger.info('Running AppleScript', { scriptLength: script.length }, agentId);

  try {
    // `osascript -` reads the script from STDIN, so the script text never
    // appears on a command line at all. It was ALREADY the safest of the six
    // sites in that respect; what T3 adds is (a) `execFileSync`, so the program
    // name stops going through /bin/sh either, and (b) the AUTHORIZATION —
    // `brokers/applescript.ts` now reads this script before the dispatcher lets
    // the call reach here, including any `do shell script` payload inside it.
    const result = execFileSync('osascript', ['-'], {
      timeout: 30000,
      encoding: 'utf-8',
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
