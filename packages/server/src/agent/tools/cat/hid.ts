// ════════════════════════════════════════════════════════════════════════════
// HUMAN-INTERFACE DEVICES (PHASE-5 T4 — relocated from `agent/tools.ts`)
//
// `mouse_click`, `mouse_move`, `keyboard_type`, `screen_screenshot`,
// `applescript_run` — the five tools that drive the owner's actual machine.
// Research 05 §1 calls "File & System" the worst-mixed category in the tree
// precisely because these sat in the same label as exec and the file verbs;
// they get their own module.
//
// RELOCATION, NOT REWRITE, AND THE GATES ARE NOT HERE BY DESIGN. All five are
// gated on the manifest's `system_control`, and T3 made the four classes
// separately grantable and CAGED AppleScript on the SCRIPT rather than the name
// (`do shell script "…"` is unpacked into the shell grant, so an agent whose
// exec grant is ['ls'] cannot run `do shell script "curl … | sh"`). Every one of
// those is a DECLARED gate evaluated in the executor ahead of dispatch, and
// `applescriptRun` owns the script cage itself — so a relocation cannot drop
// one, which is exactly what T1's registry and T2's loop are for.
// ════════════════════════════════════════════════════════════════════════════

import { mouseClick, mouseMove, keyboardType, screenRead, applescriptRun } from '../../system-control.js';
import type { ToolHandlerMap } from '../handler.js';

export const hidHandlers: ToolHandlerMap = {
  async "mouse_click"({ agentId, args }) {
    let content = '';
    let isError = false;
    content = mouseClick(agentId, {
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
    content = mouseMove(agentId, {
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
    content = keyboardType(agentId, {
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
    content = applescriptRun(agentId, { script: args.script as string });
    isError = content.startsWith('AppleScript error');
    return { content, isError };
  },

};
