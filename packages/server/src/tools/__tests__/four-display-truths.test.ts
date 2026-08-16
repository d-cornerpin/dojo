// ════════════════════════════════════════════════════════════════════════════════════════
// UX-REPAIR T54 — four display truths (the owner's ruling 6 of the 2026-08-16 twelve).
//
// T5/W3 parked three tools with a paragraph of evidence each and recorded a fourth
// consequence of its own arg-less fold. The owner ruled FIX on all four. This file is the
// four rulings as tests, plus the controls that keep the ruling from spreading.
//
// STEP-0, RE-MEASURED AT HEAD e49a167 (not inherited — the classifier was re-run and the
// worn-in box `~/.dojo/data/dojo.db` re-counted; all four subject files are byte-identical
// at the T51/T57 commits that landed alongside, so the measurement holds where this lands):
//
//   classifyTool('shell')         -> 'bookkeeping'      (sibling `exec` -> 'effectful-action')
//   classifyTool('canvas_render') -> 'bookkeeping'
//   classifyTool('open_browser')  -> 'bookkeeping'
//   classifyTool('work_open', {kind:'reminder'}) -> 'effectful-action', but UNREACHABLE:
//     all four dashboard call sites were arg-less, and so was the write-time fold.
//   stored rows: shell 23 · canvas_render 118 · open_browser 0 · work_open 628 (57 reminders)
//
// (a) SHELL IS EXEC. The two are one door split in half at PHASE-5 T3 — `sensei-policy.ts`
//     says so in its own ledger entry ("same decision as exec, whose door it split from").
//     `exec` classifies effectful because the token "exec" happens to be an override; "shell"
//     is in no verb set and in no override, so it fell to the safe default. A vocabulary
//     accident, not a decision: `shell` runs arbitrary zsh with pipes and redirection and
//     declares `effects: [{ kind: 'shell', from: 'args.script' }]`. The ruling is PARITY, and
//     parity is what is asserted here — `classifyTool('shell') === classifyTool('exec')` —
//     so the two can never drift apart again by one of them acquiring an override.
//
//     PARITY IS NOT DISPLAY-ONLY AND IS NOT PRETENDED TO BE. `effectful-action` is read by
//     five engine sites (loop thrash-progress, promise-floor, going-idle's countsAsTaskWork
//     and its side-effect hint, execute/post-result). A `shell` call now counts as real work
//     in each, exactly as an `exec` call always has. That is the parity, stated rather than
//     discovered later: the sibling that runs a script is not less work than the sibling that
//     runs a binary.
//
// (b)+(c) CANVAS_RENDER AND OPEN_BROWSER ARE DELIVERY. Both exist to put something on the
//     user's screen — the right dock slides open and the user looks at it. That is the
//     `delivery` class's own definition ("the one primitive that renders content visibly"),
//     whose only member was `show_to_user`, and W3 named it: canvas_render "is the nearest
//     neighbour of show_to_user". DELIVERY, NOT EFFECTFUL, IS THE ARGUED CHOICE: the ruling
//     asks for a visible chip, and `delivery` is user-visible at the badge tier while being
//     read by ZERO engine sites (grep: the only `'delivery'` comparisons in the server are
//     `SettlementMoment`, an unrelated string). Classing a view surface as effectful-action
//     would have made opening a document count as task work in five loop gates — a change
//     nobody ruled on. `open_browser` takes the same class because it is the same act on a
//     live URL instead of a local file; it has **0 stored rows on the box**, so the rule is
//     landed on correctness with no observed impact, and that emptiness is recorded here
//     rather than left for a future reader to rediscover.
//
// (d) THE REMINDER PROMOTION BECOMES REACHABLE. `WORK_OP_DISPLAY_CLASS` has promoted
//     `work_open:reminder` to effectful-action since PHASE-2 T8V, because the retired
//     `reminder_create` was the ONE of 24 collapsed verbs that was not bookkeeping. T5 then
//     folded the write-time tier through an ARG-LESS `classifyTool` — correctly, because all
//     four dashboard call sites were arg-less — and recorded the consequence in source rather
//     than hiding it: the promotion drew nothing, and the stored tier agreed with the screen
//     instead of with the table. The owner ruled that the table is right. So the arguments
//     now reach the classifier on BOTH sides at once, which is the only way this can be done:
//     the client re-derives the row tier itself (`Chat.tsx:975`, `:1870` call
//     classifyMessageForDisplay), so an arg-aware chip filter over an arg-less row tier would
//     draw nothing at all — the row would be dropped one step earlier.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyTool, toolBadgeTier, classifyMessageForDisplay } from '@dojo/shared';
import { TOOL_CATEGORIES } from '../categories.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const DASHBOARD_SRC = path.join(REPO, 'packages/dashboard/src');

const row = (blocks: unknown[]) => ({
  role: 'assistant' as const,
  lane: 'owner' as const,
  content: JSON.stringify(blocks),
});
const tool = (name: string, input: Record<string, unknown> = {}) =>
  ({ type: 'tool_use', id: `call_${name}`, name, input });

// The client's regular-mode chip filter, transcribed WITH the arguments it now passes.
const chipsTheClientWouldDraw = (blocks: Array<{ type: string; name?: string; input?: Record<string, unknown> }>) =>
  blocks.filter((b) => b.type === 'tool_use' && b.name && classifyTool(b.name, b.input) !== 'bookkeeping');

describe('T54(a) — `shell` renders like the sibling it split from', () => {
  it('THE RED: shell classifies effectful-action', () => {
    expect(classifyTool('shell')).toBe('effectful-action');
  });

  it('PARITY, not a coincidence: shell and exec carry the SAME class', () => {
    // Asserted as an equality so a future override on either one cannot re-open the gap.
    expect(classifyTool('shell')).toBe(classifyTool('exec'));
  });

  it('the badge tier follows: a shell-only turn is drawn, not hidden', () => {
    expect(toolBadgeTier(classifyTool('shell'))).toBe('user-visible');
    expect(classifyMessageForDisplay(row([tool('shell', { script: 'ls ~/notes | wc -l' })])).tier)
      .toBe('user-visible');
    expect(chipsTheClientWouldDraw([tool('shell', { script: 'ls' })])).toHaveLength(1);
  });

  it('CONTROL: the ruling did not spread to shell\'s hidden category neighbours', () => {
    // Same `File & System` category, NOT ruled on, still bookkeeping.
    for (const n of ['screen_screenshot', 'keyboard_type', 'mouse_click', 'scratchpad_set', 'get_current_time']) {
      expect(classifyTool(n), n).toBe('bookkeeping');
    }
  });
});

describe('T54(b)+(c) — the two right-dock view surfaces are visible, and they are delivery', () => {
  it('THE RED: canvas_render classifies delivery, not bookkeeping', () => {
    expect(classifyTool('canvas_render')).toBe('delivery');
    expect(toolBadgeTier(classifyTool('canvas_render'))).toBe('user-visible');
  });

  it('THE RED: open_browser takes the SAME class as canvas_render (0 stored rows on the box)', () => {
    // The ruling is "same class", so it is asserted as sameness rather than as a literal:
    // if canvas_render is ever re-ruled, open_browser follows it or this fails.
    expect(classifyTool('open_browser')).toBe(classifyTool('canvas_render'));
    expect(toolBadgeTier(classifyTool('open_browser'))).toBe('user-visible');
  });

  it('the two view surfaces share their class with show_to_user and with nothing else new', () => {
    const delivery = [...new Set(TOOL_CATEGORIES.flatMap((c) => c.tools))]
      .filter((n) => classifyTool(n) === 'delivery').sort();
    expect(delivery).toEqual(['canvas_render', 'open_browser', 'show_to_user']);
  });

  it('a view-surface-only turn is drawn instead of dropped', () => {
    for (const t of [tool('canvas_render', { path: '/x/report.md' }), tool('open_browser', { url: 'https://example.com' })]) {
      expect(classifyMessageForDisplay(row([t])).tier, t.name).toBe('user-visible');
      expect(chipsTheClientWouldDraw([t]), t.name).toHaveLength(1);
    }
  });

  it('CONTROL: the other two members of the right-dock category are untouched', () => {
    expect(classifyTool('canvas_read')).toBe('retrieval');      // a read of the dock, as before
    expect(classifyTool('screen_broadcast')).toBe('bookkeeping'); // never ruled on
  });
});

describe('T54(d) — the reminder promotion is reachable from the render path', () => {
  it('THE RED: a reminder-only turn is user-visible, so the client keeps the row', () => {
    // At HEAD this row stamped `agent-only`, and `Chat.tsx:1870` (which re-derives the tier
    // client-side with this same function) returned null for it — the chip filter never ran.
    const reminder = tool('work_open', { kind: 'reminder', what: 'call mum', when: '2026-08-17T09:00' });
    expect(classifyMessageForDisplay(row([reminder])).tier).toBe('user-visible');
    expect(chipsTheClientWouldDraw([reminder])).toHaveLength(1);
  });

  it('the shape-fallback reminder (no `kind`, just what/when) is promoted too', () => {
    const shaped = tool('work_open', { what: 'refill the prescription', when: 'friday 5pm' });
    expect(classifyTool('work_open', shaped.input)).toBe('effectful-action');
    expect(classifyMessageForDisplay(row([shaped])).tier).toBe('user-visible');
  });

  it('CONTROL: every OTHER work call stays hidden bookkeeping, row and block', () => {
    const hidden = [
      tool('work_open', { kind: 'task', title: 'Research note-taking apps' }),
      tool('work_open', { kind: 'project', title: 'Q3' }),
      tool('work_update', { action: 'status', status: 'complete', task_id: 'abc' }),
      tool('work_note', { task_id: 'abc', note: 'x' }),
      tool('work_close_request', { task_id: 'abc' }),
      tool('work_validate', { task_id: 'abc' }),
      tool('work_schedule', { task_id: 'abc' }),
    ];
    for (const t of hidden) {
      expect(classifyTool(t.name, t.input), `${t.name} ${JSON.stringify(t.input)}`).toBe('bookkeeping');
      expect(classifyMessageForDisplay(row([t])).tier, t.name).toBe('agent-only');
    }
  });

  it('CONTROL: an arg-less caller still gets the safe answer (23 of the 24 retired verbs)', () => {
    // The classifier's own contract, unchanged: no arguments -> bookkeeping. Server callers
    // that legitimately have no args (going-idle's side-effect hint) keep today's answer.
    expect(classifyTool('work_open')).toBe('bookkeeping');
  });

  it('THE CALL SITES: no arg-less classifyTool call survives in the dashboard', () => {
    // The whole defect is that the promotion existed and nothing called it with arguments.
    // A single arg-less site anywhere in the client re-opens it, so the source is scanned
    // rather than the four known lines being listed (a fifth would slip past a list).
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (!/\.tsx?$/.test(e.name)) continue;
        const src = fs.readFileSync(p, 'utf8');
        src.split('\n').forEach((line, i) => {
          // `classifyTool(<one argument>)` — a call with no comma before its closing paren.
          if (/\bclassifyTool\(\s*[^,()]*\)/.test(line)) offenders.push(`${path.relative(REPO, p)}:${i + 1}: ${line.trim()}`);
        });
      }
    };
    walk(DASHBOARD_SRC);
    expect(offenders, `arg-less classifyTool call(s) in the dashboard:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('THE OTHER HALF: the write-time fold passes arguments too', () => {
    // An arg-aware chip filter over an arg-less row tier would draw NOTHING — the row is
    // dropped by the tier check before the filter runs. Both sides move or neither does.
    const shared = fs.readFileSync(path.join(REPO, 'packages/shared/src/visibility.ts'), 'utf8');
    expect(shared).toMatch(/toolBadgeTier\(classifyTool\(b\.name,\s*\w+\)\)/);
  });
});

describe('T54 — CONTROL: bookkeeping filtering is otherwise unmoved', () => {
  // The chip-noise class T5/W3 closed must not return from either side: no tool may quietly
  // acquire a chip, and none may quietly lose one. The whole registry's hidden set is pinned
  // by name. Three names left it in this task (shell, canvas_render, open_browser) and the
  // count fell 111 -> 108; any other movement fails here and has to be argued, not blessed.
  const HIDDEN_AT_T54: readonly string[] = [
    'add_safe_sender', 'approve_destructive_action', 'assign_to_group', 'broadcast_to_group',
    'calendar_freebusy', 'calendar_freebusy_ms', 'channel_inspect', 'complete_task',
    'contact_forget', 'contact_get', 'contact_list', 'contact_remember', 'contact_search',
    'contact_update', 'contacts_create', 'contacts_delete', 'contacts_get', 'contacts_list',
    'contacts_overview', 'contacts_search', 'contacts_update', 'convert_time', 'cost_summary',
    'create_agent_group', 'credential_add', 'credential_delete', 'credential_get',
    'credential_list', 'credential_update', 'dashboard_navigate', 'delete_group',
    'delete_technique', 'dreamer_run_now', 'get_agent_profile', 'get_current_time',
    'get_group_detail', 'gmail_label', 'healer_action_detail', 'healer_log_action',
    'healer_mark_applied', 'healer_propose', 'healer_recent_actions', 'history_expand',
    'imessage_list_contacts', 'keyboard_type', 'kill_agent', 'list_agents', 'list_groups',
    'list_models', 'list_techniques', 'load_tool_docs', 'mouse_click',
    'onedrive_versions_restore', 'open_settings', 'outlook_download_attachment',
    'pdf_extract_pages', 'pdf_fill_form', 'pdf_merge', 'pdf_rotate_pages', 'pdf_watermark',
    'plaud_account_info', 'plaud_recent_recordings', 'publish_technique',
    'recall_recent_thread', 'reset_session', 'save_technique', 'scratchpad_clear',
    'scratchpad_set', 'screen_broadcast', 'screen_screenshot', 'send_to_agent',
    'set_user_presence', 'sheets_format', 'slides_build_slide', 'slides_export_pngs',
    'slides_format_text', 'spawn_agent', 'spawn_timeout_decision', 'squad_recall',
    'squad_share', 'submit_technique_for_review', 'tasks_complete', 'teams_download_attachment',
    'technique_acknowledge', 'technique_finalize', 'technique_list_versions', 'technique_read',
    'technique_set_placeholder', 'transcribe_audio', 'tunnel', 'update_agent', 'update_group',
    'update_technique', 'use_technique', 'vault_discard_archives', 'vault_forget', 'vault_get',
    'vault_refresh', 'vault_remember', 'vault_search', 'vault_update', 'voice_call_status',
    'work_close_request', 'work_note', 'work_open', 'work_schedule', 'work_update',
    'work_validate',
  ];

  it('the hidden set is exactly the pinned 108 names (arg-less, as the registry is read)', () => {
    const hidden = [...new Set(TOOL_CATEGORIES.flatMap((c) => c.tools))]
      .filter((n) => classifyTool(n) === 'bookkeeping').sort();
    const gained = hidden.filter((n) => !HIDDEN_AT_T54.includes(n));
    const lost = HIDDEN_AT_T54.filter((n) => !hidden.includes(n));
    expect(gained, `tool(s) that newly went HIDDEN — the chip-noise class returning: ${gained.join(', ')}`).toEqual([]);
    expect(lost, `tool(s) that newly grew a chip without a ruling: ${lost.join(', ')}`).toEqual([]);
    expect(hidden.length).toBe(108);
  });

  it('the three names T54 moved are gone from the hidden set and nothing else went with them', () => {
    for (const n of ['shell', 'canvas_render', 'open_browser']) {
      expect(HIDDEN_AT_T54.includes(n), `${n} must not be in the post-T54 hidden pin`).toBe(false);
      expect(classifyTool(n), n).not.toBe('bookkeeping');
    }
    // 111 hidden before, 108 after: exactly the three, no fourth.
    expect(HIDDEN_AT_T54.length + 3).toBe(111);
  });
});
