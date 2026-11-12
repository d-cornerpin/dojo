// DOJO CONTROLS + OVERSIGHT: `dreamer_run_now`, `channel_inspect`, `open_settings`,
// `dashboard_navigate`, `set_capability_model`, `check_for_update`, `apply_update`,
// `set_voice`, `set_channel`, `cost_summary`. The `ui:navigate` broadcast payloads
// are the shapes the dashboard router keys on.
// The gates here (`apply_update`/`dreamer_run_now` primary-only, `set_*` DOJO
// controls) are DECLARED gates evaluated by the executor's gate loop before
// dispatch, not body code: a moved handler cannot carry a gate with it, and a
// move cannot silently drop one.
// The three `services/agent-controls.js` loads stay lazy: that module resolves a
// capability->setter table at module top level, so a static import runs its
// initialisation inside the toolbox graph; the lazy load defers that side effect.

import { getUnprocessedConversationCount } from '../../../vault/store.js';
import { runDreamingCycle } from '../../../vault/maintenance.js';
import { buildChannelInspectReport } from '../../../services/channel-inspect.js';
import { getUpdateCache, refreshUpdateCache, getUpdateChannel, applyUpdate } from '../../../gateway/routes/update.js';
import { getCostSummary, getDailySpend } from '../../../costs/tracker.js';
import { broadcast } from '../../../gateway/ws.js';
import { coerceNumberArg } from '../pagination.js';
import type { ToolHandlerMap } from '../handler.js';
import { SETTINGS_TAB_LIST, settingsPath, type SettingsTabKey } from '@dojo/shared';

export const platformHandlers: ToolHandlerMap = {
  async dreamer_run_now() {
    // Kick off the cycle in the background: runDreamingCycle returns when the
    // Dreamer agent starts; the extraction itself is async on that agent's loop.
    const unprocessedCount = getUnprocessedConversationCount();
    if (unprocessedCount === 0) {
      return {
        content: 'No unprocessed conversation archives, nothing for the Dreamer to do right now. The next archive will trigger a cycle on the normal schedule.',
        isError: false,
      };
    }
    try {
      const { dreamerId } = await runDreamingCycle();
      if (dreamerId) {
        return {
          content: `Dream cycle started in the background. Dreamer agent: ${dreamerId}. Processing ${unprocessedCount} unprocessed archive(s). The Dreamer will write a dream_reports row when done, typically 30s-3m.`,
          isError: false,
        };
      }
      return {
        content: 'Dream cycle did NOT start, dreaming is disabled, no model is configured, or the primary agent is missing. Check ~/.dojo/config.yaml.',
        isError: true,
      };
    } catch (err) {
      return { content: `Failed to start dream cycle: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
  },

  async channel_inspect() {
    return { content: buildChannelInspectReport(), isError: false };
  },

  async open_settings({ args }) {
    const tab = typeof args.tab === 'string' ? args.tab : '';
    const validTabs: string[] = SETTINGS_TAB_LIST.map((t) => t.key);
    if (!validTabs.includes(tab)) {
      return { content: `Unknown settings tab "${tab}". Valid tabs: ${validTabs.join(', ')}.`, isError: true };
    }
    const section = typeof args.section === 'string' && args.section.trim() ? args.section.trim() : undefined;
    broadcast({ type: 'ui:navigate', data: { path: '/settings', tab, section } });
    return {
      content: `Opened ${settingsPath(tab as SettingsTabKey)}${section ? ` (scrolling to "${section}")` : ''} on the dashboard. (It only shows if the user is looking at the dashboard; if they're on iMessage/voice, it'll be there next time they open it.)`,
      isError: false,
    };
  },

  async dashboard_navigate({ args }) {
    const page = typeof args.page === 'string' ? args.page : '';
    const pagePaths: Record<string, string> = {
      chat: '/', agents: '/agents', techniques: '/techniques',
      tracker: '/tracker', memory: '/memory', costs: '/costs', health: '/health',
    };
    const navPath = pagePaths[page];
    if (!navPath) {
      return { content: `Unknown page "${page}". Valid pages: ${Object.keys(pagePaths).join(', ')}.`, isError: true };
    }
    broadcast({ type: 'ui:navigate', data: { path: navPath } });
    return {
      content: `Opened the ${page} page on the dashboard. (It only shows if the user is looking at the dashboard.)`,
      isError: false,
    };
  },

  async set_capability_model({ args }) {
    const { setCapabilityModel } = await import('../../../services/agent-controls.js');
    const capResult = setCapabilityModel(
      args.capability as Parameters<typeof setCapabilityModel>[0],
      args.model_id as string,
    );
    return { content: capResult.message, isError: !capResult.ok };
  },

  async check_for_update() {
    // Read the engine's daily cache, no GitHub round-trip per call. On a cold
    // cache or one left by the OTHER channel (user toggled Stable/Preflight),
    // do one live check so the report matches the user's CURRENT channel.
    const channel = getUpdateChannel();
    let info = getUpdateCache();
    if (!info || info.channel !== channel) info = await refreshUpdateCache();
    const asOf = info.checkedAt ? ` (as of ${info.checkedAt.slice(0, 16).replace('T', ' ')} UTC)` : '';
    // State the channel explicitly, so a pre-release is not read as a stable release.
    const chanNote = channel === 'preflight'
      ? ' Channel: Preflight (pre-release/test builds, may be unstable).'
      : ' Channel: Stable.';
    if (info.error && !info.latestVersion) {
      return { content: `Installed version: ${info.currentVersion}.${chanNote} The last update check${asOf} couldn't reach GitHub (${info.error}).`, isError: false };
    }
    if (info.updateAvailable) {
      return {
        content: `An update is available${asOf}.${chanNote}\nInstalled: ${info.currentVersion}\nLatest: ${info.latestVersion}${info.releaseName ? ` (${info.releaseName})` : ''}\n\nRelease notes:\n${info.releaseNotes ?? '(none provided)'}\n\nIf the user wants it, call apply_update to install and restart.`,
        isError: false,
      };
    }
    return { content: `The DOJO is on the latest version (${info.currentVersion})${asOf}.${chanNote}`, isError: false };
  },

  async apply_update() {
    // applyUpdate() targets the user's selected channel (Stable/Preflight).
    const applyResult = await applyUpdate();
    return { content: applyResult.message, isError: !applyResult.ok };
  },

  async set_voice({ args }) {
    const voiceArg = typeof args.voice === 'string' ? args.voice : undefined;
    const speedArg = coerceNumberArg(args.speed) ?? undefined;
    if (voiceArg === undefined && speedArg === undefined) {
      return { content: 'Provide a voice and/or a speed to change.', isError: true };
    }
    const { setVoice } = await import('../../../services/agent-controls.js');
    const voiceResult = await setVoice({ voice: voiceArg, speed: speedArg });
    return { content: voiceResult.message, isError: !voiceResult.ok };
  },

  async set_channel({ args }) {
    const { setChannelEnabled } = await import('../../../services/agent-controls.js');
    const chanResult = await setChannelEnabled(
      args.channel as Parameters<typeof setChannelEnabled>[0],
      args.enabled as boolean,
    );
    return { content: chanResult.message, isError: !chanResult.ok };
  },

  async cost_summary() {
    const today = getDailySpend();
    const summary = getCostSummary('24h');
    const topAgents = (summary.byAgent ?? []).slice(0, 3);
    const topModels = (summary.byModel ?? []).slice(0, 3);
    const fmt = (n: number) => `$${n.toFixed(4)}`;
    const lines: string[] = [];
    lines.push(`Total spend (last 24h): ${fmt(today)}`);
    if (topAgents.length > 0) {
      lines.push('');
      lines.push('Top agents:');
      for (const a of topAgents) {
        lines.push(`  - ${a.agentName ?? a.agentId}: ${fmt(a.totalCost)}`);
      }
    }
    if (topModels.length > 0) {
      lines.push('');
      lines.push('Top models:');
      for (const m of topModels) {
        lines.push(`  - ${m.modelId}: ${fmt(m.totalCost)}`);
      }
    }
    return { content: lines.join('\n'), isError: false };
  },
};
