// ════════════════════════════════════════
// System Control Tools (Phase 5A)
// Mouse, Keyboard, Screenshot, AppleScript
// ════════════════════════════════════════

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createLogger } from '../logger.js';
import { callModel } from './model.js';
import { getDb } from '../db/connection.js';

const logger = createLogger('system-control');

// ── Dependency Check ──

let cliclickAvailable: boolean | null = null;

function checkCliclick(): boolean {
  if (cliclickAvailable !== null) return cliclickAvailable;
  try {
    execSync('which cliclick', { encoding: 'utf-8', timeout: 5000 });
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

  let cmd: string;
  switch (click_type) {
    case 'right':
      cmd = `cliclick rc:${Math.round(x)},${Math.round(y)}`;
      break;
    case 'double':
      cmd = `cliclick dc:${Math.round(x)},${Math.round(y)}`;
      break;
    default:
      cmd = `cliclick c:${Math.round(x)},${Math.round(y)}`;
  }

  logger.info('Mouse click', { x, y, click_type }, agentId);

  try {
    execSync(cmd, { timeout: 5000, encoding: 'utf-8' });
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
    execSync(`cliclick m:${Math.round(x)},${Math.round(y)}`, {
      timeout: 5000,
      encoding: 'utf-8',
    });
    return `Mouse moved to (${x}, ${y})`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Mouse move failed', { error: msg }, agentId);
    return `Error: Mouse move failed: ${msg}`;
  }
}

// ── Keyboard Type ──

const KEY_COMBO_MAP: Record<string, string> = {
  'cmd+c': 'kd:cmd t:c ku:cmd',
  'cmd+v': 'kd:cmd t:v ku:cmd',
  'cmd+a': 'kd:cmd t:a ku:cmd',
  'cmd+z': 'kd:cmd t:z ku:cmd',
  'cmd+s': 'kd:cmd t:s ku:cmd',
  'cmd+x': 'kd:cmd t:x ku:cmd',
  'cmd+w': 'kd:cmd t:w ku:cmd',
  'cmd+q': 'kd:cmd t:q ku:cmd',
  'cmd+n': 'kd:cmd t:n ku:cmd',
  'cmd+t': 'kd:cmd t:t ku:cmd',
  'cmd+f': 'kd:cmd t:f ku:cmd',
  'cmd+tab': 'kd:cmd kp:tab ku:cmd',
  'cmd+space': 'kd:cmd kp:space ku:cmd',
  'cmd+shift+3': 'kd:cmd kd:shift kp:3 ku:shift ku:cmd',
  'cmd+shift+4': 'kd:cmd kd:shift kp:4 ku:shift ku:cmd',
  'cmd+shift+z': 'kd:cmd kd:shift t:z ku:shift ku:cmd',
  'cmd+shift+t': 'kd:cmd kd:shift t:t ku:shift ku:cmd',
  'cmd+option+esc': 'kd:cmd kd:alt kp:escape ku:alt ku:cmd',
  'ctrl+c': 'kd:ctrl t:c ku:ctrl',
  'return': 'kp:return',
  'enter': 'kp:return',
  'escape': 'kp:escape',
  'esc': 'kp:escape',
  'tab': 'kp:tab',
  'delete': 'kp:delete',
  'backspace': 'kp:delete',
  'space': 'kp:space',
  'arrow-up': 'kp:arrow-up',
  'arrow-down': 'kp:arrow-down',
  'arrow-left': 'kp:arrow-left',
  'arrow-right': 'kp:arrow-right',
  'up': 'kp:arrow-up',
  'down': 'kp:arrow-down',
  'left': 'kp:arrow-left',
  'right': 'kp:arrow-right',
  'home': 'kp:home',
  'end': 'kp:end',
  'pageup': 'kp:page-up',
  'pagedown': 'kp:page-down',
  'f1': 'kp:f1',
  'f2': 'kp:f2',
  'f3': 'kp:f3',
  'f4': 'kp:f4',
  'f5': 'kp:f5',
};

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
      const combo = key_combo.toLowerCase();
      const mapped = KEY_COMBO_MAP[combo];
      if (mapped) {
        execSync(`cliclick ${mapped}`, { timeout: 5000, encoding: 'utf-8' });
        return `Key combo pressed: ${key_combo}`;
      }
      // Try to parse generic combos like "cmd+shift+k"
      const parts = combo.split('+');
      const modifiers: string[] = [];
      let finalKey = '';
      for (const part of parts) {
        if (['cmd', 'command'].includes(part)) modifiers.push('cmd');
        else if (['ctrl', 'control'].includes(part)) modifiers.push('ctrl');
        else if (['alt', 'option', 'opt'].includes(part)) modifiers.push('alt');
        else if (['shift'].includes(part)) modifiers.push('shift');
        else finalKey = part;
      }
      if (finalKey && modifiers.length > 0) {
        const kd = modifiers.map(m => `kd:${m}`).join(' ');
        const ku = modifiers.reverse().map(m => `ku:${m}`).join(' ');
        const keyCmd = finalKey.length === 1 ? `t:${finalKey}` : `kp:${finalKey}`;
        execSync(`cliclick ${kd} ${keyCmd} ${ku}`, { timeout: 5000, encoding: 'utf-8' });
        return `Key combo pressed: ${key_combo}`;
      }
      return `Error: Unknown key combo: ${key_combo}`;
    }

    if (text) {
      // Escape single quotes for shell
      const escaped = text.replace(/'/g, "'\\''");
      execSync(`cliclick t:'${escaped}'`, { timeout: 10000, encoding: 'utf-8' });
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

function findVisionModel(): { modelId: string; providerId: string; apiModelId: string } | null {
  const db = getDb();
  // Look for enabled models with vision capability
  const row = db.prepare(`
    SELECT m.id, m.provider_id, m.api_model_id, m.capabilities
    FROM models m
    JOIN providers p ON p.id = m.provider_id
    WHERE m.is_enabled = 1
    ORDER BY
      CASE
        WHEN m.capabilities LIKE '%vision%' THEN 0
        WHEN m.api_model_id LIKE '%sonnet%' THEN 1
        WHEN m.api_model_id LIKE '%opus%' THEN 2
        WHEN m.api_model_id LIKE '%haiku%' THEN 3
        ELSE 4
      END,
      COALESCE(m.input_cost_per_m, 999) ASC
    LIMIT 1
  `).get() as { id: string; provider_id: string; api_model_id: string; capabilities: string } | undefined;

  if (!row) return null;
  return { modelId: row.id, providerId: row.provider_id, apiModelId: row.api_model_id };
}

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
    // Capture screenshot
    let cmd: string;
    if (region) {
      cmd = `screencapture -x -R${region.x},${region.y},${region.width},${region.height} "${screenshotPath}"`;
    } else {
      cmd = `screencapture -x "${screenshotPath}"`;
    }

    execSync(cmd, { timeout: 10000, encoding: 'utf-8' });

    if (!fs.existsSync(screenshotPath)) {
      return 'Error: Screenshot capture failed — file was not created. Ensure screen recording permission is granted in System Settings > Privacy & Security > Screen Recording.';
    }

    // Read image as base64
    const imageData = fs.readFileSync(screenshotPath);
    const base64Image = imageData.toString('base64');

    // Find a vision-capable model
    const visionModel = findVisionModel();
    if (!visionModel) {
      // Return just the screenshot path without description
      return `Screenshot saved to: ${screenshotPath}\nNo vision-capable model available to describe the screen. Enable a model with vision support in Settings > Models.`;
    }

    // Build the vision prompt
    const visionPrompt = query
      ? `You are a screen reader assistant. Look at this screenshot and answer: ${query}\nFor interactive elements (buttons, links, text fields, menus), provide approximate pixel coordinates as [x,y]. Be precise about positions.`
      : 'You are a screen reader assistant. Describe what you see on the screen. For interactive elements (buttons, links, text fields, menus), provide approximate pixel coordinates as [x,y]. Be precise about positions. List all visible text and UI elements.';

    // Call the vision model
    const result = await callModel({
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
    // Use osascript with heredoc-style input to avoid quote escaping issues
    const result = execSync('osascript -', {
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
