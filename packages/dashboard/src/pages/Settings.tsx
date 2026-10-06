import { useState, useEffect, useRef, type FormEvent } from 'react';
import { useWebSocket } from '../hooks/useWebSocket';
import { useSearchParams } from 'react-router-dom';
import type { Provider, Model, GenerationParamSpec, VoiceOption, EditProviderRequest } from '@dojo/shared';
import { fullDiskAccessInstructions, fullDiskAccessWhy, FULL_DISK_ACCESS_VERIFY } from '@dojo/shared';
import * as api from '../lib/api';
import {
  SUDO_FLOOR_NOTE, SUDO_POLICY_DEFAULT, SUDO_POLICY_HINTS, SUDO_POLICY_KEY, SUDO_POLICY_LABELS,
  SUDO_POLICY_ORDER, readSudoPolicy, sudoPolicyWarning, type SudoPolicy,
} from '../lib/sudo-policy';
import {
  numberEditsFor, numInput,
  THROUGHPUT_MIN_TOK_PER_SEC, THROUGHPUT_MAX_TOK_PER_SEC,
  UNATTENDED_MIN_MINUTES, UNATTENDED_MAX_MINUTES, UNATTENDED_STANDARD_MINUTES, UNATTENDED_UNCAPPED,
} from '../lib/provider-edits';
import { useToast } from '../hooks/useToast';
import { RouterConfig, SystemModelConfig, VoiceOpenerModelConfig } from '../components/RouterConfig';
import { DataBackupNotice } from '../components/DataBackupNotice';
import { DiskSpaceNotice } from '../components/DiskSpaceNotice';
import { RouterTest } from '../components/RouterTest';
import { GoogleWorkspaceSettings } from '../components/GoogleWorkspaceSettings';
import { MicrosoftWorkspaceSettings } from '../components/MicrosoftWorkspaceSettings';
import { PlaudSettings } from '../components/PlaudSettings';
import { GitHubSettings } from '../components/GitHubSettings';
import { TwilioSettings } from '../components/TwilioSettings';
import { ScreenShareSettings } from '../components/ScreenSharePanel';
import { CollapseChevron } from '../components/CollapseToggle';
import { formatDate, formatDateShort, parseUtc } from '../lib/dates';
import { MigrationExport } from '../components/MigrationExport';
import { ImportWizard } from '../components/ImportWizard';
import { useTheme } from '../themes';
import {
  getOrbQualityCached,
  refreshOrbQualityFromServer,
  setOrbQuality,
  type OrbQualityPref,
} from '../components/orb/orbQuality';
import { IMBridgeSettings } from '../components/settings/IMBridgeSettings';
import { PlatformTab } from '../components/settings/PlatformTab';
import { ProvidersTab } from '../components/settings/ProvidersTab';
import { ModelsTab } from '../components/settings/ModelsTab';
import { ProfileTab } from '../components/settings/ProfileTab';
import { RouterTab } from '../components/settings/RouterTab';
import { SecurityTab, SudoPolicyCard } from '../components/settings/SecurityTab';
import { DreamingTab } from '../components/settings/DreamingTab';
import { UpdateTab } from '../components/settings/UpdateTab';
import { VoiceTab } from '../components/settings/VoiceTab';

type Tab = 'platform' | 'providers' | 'models' | 'profile' | 'security' | 'router' | 'sensei' | 'channels' | 'integrations' | 'voice' | 'update';

export const Settings = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const rawTab = searchParams.get('tab');
  // v2.7.24 — iMessage / Google / Microsoft cards moved from 'platform'/
  // 'integrations' into a new 'channels' tab (they're all communication
  // channels with safe-sender lists, auto-routing, etc.). Old deep links
  // map forward so bookmarks don't 404.
  const tabFromUrl = (
    rawTab === 'workspace' || rawTab === 'microsoft' || rawTab === 'imessage'
      ? 'channels'
      : rawTab
  ) as Tab | null;
  const [activeTab, setActiveTab] = useState<Tab>(tabFromUrl || 'platform');

  // Sync tab with URL query param so mobile hamburger sub-menu links work
  useEffect(() => {
    if (tabFromUrl && tabFromUrl !== activeTab) {
      setActiveTab(tabFromUrl);
    }
  }, [tabFromUrl]);

  // Agent-driven deep-link: when navigated with ?section=, scroll the matching
  // settings card into view once its tab has rendered. Matches against the
  // section heading text (.scard__title) so no per-section anchors are needed.
  // The agent emits this via the open_settings tool (ui:navigate -> URL).
  const sectionParam = searchParams.get('section');
  useEffect(() => {
    if (!sectionParam) return;
    const want = sectionParam.trim().toLowerCase();
    if (!want) return;
    const tryScroll = (): boolean => {
      const titles = Array.from(document.querySelectorAll('.scard__title')) as HTMLElement[];
      const match = titles.find(t => (t.textContent ?? '').trim().toLowerCase().includes(want));
      if (!match) return false;
      (match.closest('.tile') ?? match).scrollIntoView({ behavior: 'smooth', block: 'start' });
      return true;
    };
    if (tryScroll()) return;
    // The tab content may still be mounting — retry a few times, then give up
    // (tab-level navigation already landed them in the right place).
    const timers = [60, 180, 400].map(d => window.setTimeout(tryScroll, d));
    return () => { timers.forEach(clearTimeout); };
  }, [activeTab, sectionParam]);

  const handleTabChange = (tab: Tab) => {
    setActiveTab(tab);
    setSearchParams({ tab });
  };

  const tabs: { key: Tab; label: string }[] = [
    { key: 'platform', label: 'Dojo' },
    { key: 'providers', label: 'Providers' },
    { key: 'models', label: 'Models' },
    { key: 'router', label: 'Router' },
    { key: 'profile', label: 'Profile' },
    { key: 'security', label: 'Security' },
    { key: 'sensei', label: 'Sensei' },
    { key: 'channels', label: 'Channels' },
    { key: 'integrations', label: 'Integrations' },
    { key: 'voice', label: 'Voice' },
    { key: 'update', label: 'Update' },
  ];

  return (
    <div className="settings-page">
      {/* Self-headered panel: the page owns its prototype .phead. */}
      <header className="phead">
        <h2 className="phead__title">Settings</h2>
        <span className="phead__meta">House rules</span>
      </header>

      {/* Tab bar — prototype .tabs/.tab pill row. Horizontally scrollable
          on narrow viewports (the .tabs primitive handles overflow), so
          the same control works on phones without a separate dropdown. */}
      <div className="toolbar">
        <div className="tabs" role="tablist">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.key}
              onClick={() => handleTabChange(tab.key)}
              className={`tab ${activeTab === tab.key ? 'is-active' : ''}`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Tab Content */}
      {activeTab === 'platform' && <PlatformTab />}
      {activeTab === 'providers' && <ProvidersTab />}
      {activeTab === 'models' && <ModelsTab />}
      {activeTab === 'router' && <RouterTab />}
      {activeTab === 'profile' && <ProfileTab />}
      {activeTab === 'security' && <><SudoPolicyCard /><SecurityTab /></>}
      {activeTab === 'sensei' && <DreamingTab />}
      {activeTab === 'channels' && (
        <>
          {/* OAuth callbacks land on http://localhost:3001 — connecting from
              a Cloudflare-tunneled URL (or any remote host) breaks the
              redirect roundtrip. Surface this once at the top of the page
              so users don't get cryptic "session expired" errors after the
              Google/Microsoft sign-in popup closes. */}
          <div className="note--warn max-w-4xl" style={{ textTransform: 'none', letterSpacing: 'normal', marginBottom: 18 }}>
            <p style={{ fontWeight: 600 }}>Connect accounts from your local Mac, not via a tunnel.</p>
            <p style={{ marginTop: 4, fontWeight: 400 }}>
              Google and Microsoft sign-in redirects land on <code>http://localhost:3001</code> — that only resolves when this dashboard is open on the same machine running the Dojo. If you're hitting the dashboard through a Cloudflare tunnel or named host from another device, the OAuth callback won't reach the server and the connection will silently fail. Sit at the host machine and use <code>http://localhost:3000</code> for the connect flow; once connected, the credentials work regardless of how you access the dashboard.
            </p>
          </div>
          <div className="scards">
            <IMBridgeSettings />
            <TwilioSettings />
            <GoogleWorkspaceSettings />
            <MicrosoftWorkspaceSettings />
          </div>
        </>
      )}
      {activeTab === 'integrations' && (
        <div className="scards">
          <ScreenShareSettings />
          <PlaudSettings />
          <GitHubSettings />
        </div>
      )}
      {activeTab === 'voice' && <VoiceTab />}
      {activeTab === 'update' && <UpdateTab />}
    </div>
  );
};
// IMBridgeSettings → components/settings/IMBridgeSettings.tsx (t111-E1)
// PlatformTab → components/settings/PlatformTab.tsx (t111-E1)
// ProvidersTab → components/settings/ProvidersTab.tsx (t111-E1)
// ModelRows → components/settings/ModelRows.tsx (t111-E1)
// ModelsTab → components/settings/ModelsTab.tsx (t111-E1)
// ProfileTab → components/settings/ProfileTab.tsx (t111-E1)
// RouterTab → components/settings/RouterTab.tsx (t111-E1)
// SecurityTab → components/settings/SecurityTab.tsx (t111-E1)
// DreamingTab → components/settings/DreamingTab.tsx (t111-E1)
// CapabilityModelCards → components/settings/CapabilityModelCards.tsx (t111-E1)
// UpdateTab → components/settings/UpdateTab.tsx (t111-E1)
// VoiceTab → components/settings/VoiceTab.tsx (t111-E1)
