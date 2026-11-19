import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { GoogleWorkspaceSettings } from '../components/GoogleWorkspaceSettings';
import { MicrosoftWorkspaceSettings } from '../components/MicrosoftWorkspaceSettings';
import { PlaudSettings } from '../components/PlaudSettings';
import { GitHubSettings } from '../components/GitHubSettings';
import { TwilioSettings } from '../components/TwilioSettings';
import { ScreenShareSettings } from '../components/ScreenSharePanel';
import { IMBridgeSettings } from '../components/settings/IMBridgeSettings';
import { PlatformTab } from '../components/settings/PlatformTab';
import { ProvidersTab } from '../components/settings/ProvidersTab';
import { ModelsTab } from '../components/settings/ModelsTab';
import { ProfileTab } from '../components/settings/ProfileTab';
import { RouterTab } from '../components/settings/RouterTab';
import { SecurityTab } from '../components/settings/SecurityTab';
import { DreamingTab } from '../components/settings/DreamingTab';
import { UpdateTab } from '../components/settings/UpdateTab';
import { VoiceTab } from '../components/settings/VoiceTab';
import { SETTINGS_TABS, isTab, type Tab } from '../lib/settings-tabs';

export const Settings = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const rawTab = searchParams.get('tab');
  // The channel cards live under 'channels'; old deep links map forward so
  // bookmarks don't 404.
  const mappedTab =
    rawTab === 'workspace' || rawTab === 'microsoft' || rawTab === 'imessage'
      ? 'channels'
      : rawTab;
  // An unknown name (old bookmark, typo) falls back to the first tab and the link is corrected.
  const tabFromUrl: Tab | null = isTab(mappedTab) ? mappedTab : null;
  const [activeTab, setActiveTab] = useState<Tab>(tabFromUrl || 'platform');

  // Sync tab with URL query param so mobile hamburger sub-menu links work
  useEffect(() => {
    if (tabFromUrl && tabFromUrl !== activeTab) {
      setActiveTab(tabFromUrl);
    }
    if (rawTab !== null && !tabFromUrl) setSearchParams({ tab: 'platform' }, { replace: true });
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
    // The tab content may still be mounting, retry a few times, then give up
    // (tab-level navigation already landed them in the right place).
    const timers = [60, 180, 400].map(d => window.setTimeout(tryScroll, d));
    return () => { timers.forEach(clearTimeout); };
  }, [activeTab, sectionParam]);

  const handleTabChange = (tab: Tab) => {
    setActiveTab(tab);
    setSearchParams({ tab });
  };

  const tabs = SETTINGS_TABS;

  return (
    <div className="settings-page">
      {/* Self-headered panel: the page owns its prototype .phead. */}
      <header className="phead">
        <h2 className="phead__title">Settings</h2>
        <span className="phead__meta">House rules</span>
      </header>

      {/* Tab bar, prototype .tabs/.tab pill row. Horizontally scrollable
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
      {activeTab === 'security' && <SecurityTab />}
      {activeTab === 'sensei' && <DreamingTab />}
      {activeTab === 'channels' && (
        <>
          {/* Google and Microsoft send their sign-in back to the address the dashboard was opened on, which they accept only for this Mac. */}
          {!['localhost', '127.0.0.1'].includes(window.location.hostname) && (
            <div className="note--warn max-w-4xl" style={{ textTransform: 'none', letterSpacing: 'normal', marginBottom: 18 }}>
              To connect a Google or Microsoft account, open the dashboard on the Mac that runs the Dojo. A sign-in started from another device does not come back. Once connected, the account works from anywhere.
            </div>
          )}
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
