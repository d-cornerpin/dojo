// ════════════════════════════════════════════════════════════════════════════
// HID: `mouse_click`, `mouse_move`, `keyboard_type`, `screen_screenshot`, `applescript_run`: the
// five tools that drive the owner's actual machine.
// The gates are not here by design: all five are declared `system_control` gates evaluated in the
// executor ahead of dispatch, and the four classes are separately grantable.
// AppleScript is caged on the script, not the name: `do shell script "..."` is unpacked into the
// shell grant, so an agent whose exec grant is ['ls'] cannot run `do shell script "curl ... | sh"`.
// ════════════════════════════════════════════════════════════════════════════

import { mouseClick, mouseMove, keyboardType, screenRead, applescriptRun } from '../../system-control.js';
import type { ToolHandlerMap } from '../handler.js';
import { redactText } from '../../../inspect/redact.js';

export const hidHandlers: ToolHandlerMap = {
  async "mouse_click"({ agentId, args }) {
    let content = '';
    let isError = false;
    content = await mouseClick(agentId, {
      x: args.x as number,
      y: args.y as number,
      click_type: args.click_type as string | undefined,
    });
    isError = content.startsWith('Error');
    return { content, isError };
  },

  async "mouse_move"({ agentId, args }) {
    let content = '';
    let isError = false;
    content = await mouseMove(agentId, {
      x: args.x as number,
      y: args.y as number,
    });
    isError = content.startsWith('Error');
    return { content, isError };
  },

  async "keyboard_type"({ agentId, args }) {
    let content = '';
    let isError = false;
    if (args.text === undefined && args.key_combo === undefined) {
      content = 'Error: provide either `text` (a string to type) or `key_combo` (a key chord like "cmd+c").';
      isError = true;
      return { content, isError };
    }
    content = await keyboardType(agentId, {
      text: args.text as string | undefined,
      key_combo: args.key_combo as string | undefined,
    });
    isError = content.startsWith('Error');
    return { content, isError };
  },

  async "screen_screenshot"({ agentId, args }) {
    let content = '';
    let isError = false;
    content = await screenRead(agentId, {
      region: args.region as { x: number; y: number; width: number; height: number } | undefined,
      query: args.query as string | undefined,
    });
    isError = content.startsWith('Error');
    return { content, isError };
  },

  async "applescript_run"({ agentId, args }) {
    let content = '';
    let isError = false;
    content = redactText(await applescriptRun(agentId, { script: args.script as string }), [agentId]);
    isError = content.startsWith('AppleScript error');
    return { content, isError };
  },

};
