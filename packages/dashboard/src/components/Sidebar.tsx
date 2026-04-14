import { Link, useLocation } from 'react-router-dom';
import { useState } from 'react';
import { useAuth } from '../hooks/useAuth';
import { useWebSocket, type ConnectionStatus } from '../hooks/useWebSocket';
import { SidebarClock } from './SidebarClock';
import { PresenceToggle } from './PresenceToggle';

interface NavItem {
  path: string;
  label: string;
  icon: string;
}

const navItems: NavItem[] = [
  { path: '/', label: 'Chat', icon: '\u{1F4AC}' },
  { path: '/agents', label: 'Agents', icon: '\u{1F916}' },
  { path: '/memory', label: 'Vault', icon: '\u{1F9E0}' },
  { path: '/techniques', label: 'Techniques', icon: '\u{1F94B}' },
  { path: '/tracker', label: 'Tracker', icon: '\u{1F4CB}' },
  { path: '/costs', label: 'Ledger', icon: '\u{1F4B0}' },
  { path: '/health', label: 'Vitals', icon: '\u{1F49A}' },
  { path: '/settings', label: 'Settings', icon: '\u2699\uFE0F' },
];

// Settings sub-tabs shown in the mobile hamburger menu instead of the
// tab bar (which doesn't fit on phone screens).
const settingsSubItems = [
  { tab: 'platform', label: 'Dojo' },
  { tab: 'providers', label: 'Providers' },
  { tab: 'models', label: 'Models' },
  { tab: 'router', label: 'Router' },
  { tab: 'profile', label: 'Profile' },
  { tab: 'security', label: 'Security' },
  { tab: 'sensei', label: 'Sensei' },
  { tab: 'integrations', label: 'Integrations' },
  { tab: 'update', label: 'Update' },
];

const statusConfig: Record<ConnectionStatus, { dot: string; label: string }> = {
  connected: { dot: 'status-dot-healthy status-dot-pulse', label: 'In Session' },
  connecting: { dot: 'status-dot-warning status-dot-pulse', label: 'Returning to Mat...' },
  disconnected: { dot: 'status-dot-error', label: 'Off the Mat' },
};

export const Sidebar = () => {
  const location = useLocation();
  const { logout } = useAuth();
  const { connectionStatus } = useWebSocket();
  const [collapsed, setCollapsed] = useState(false);

  const ws = statusConfig[connectionStatus];

  return (
    <>
      {/* Desktop / Tablet sidebar */}
      <aside
        className={`hidden md:flex flex-col h-full transition-all duration-300 glass-sidebar ${
          collapsed ? 'w-[68px]' : 'w-[260px]'
        }`}
      >
        {/* Logo */}
        <div className={`flex items-center gap-3 border-b border-white/[0.06] ${collapsed ? 'px-4 py-5 justify-center' : 'px-5 py-5'}`}>
          <img src="/dojologo.svg" alt="DOJO" className="w-8 h-8 flex-shrink-0" />
          {!collapsed && (
            <div>
              <h1 className="text-base font-bold text-white tracking-wide">Agent D.O.J.O.</h1>
              <div className="flex items-center gap-1.5 mt-0.5">
                <span className={`status-dot ${ws.dot}`} />
                <span className="text-[10px] text-tertiary">{ws.label}</span>
              </div>
            </div>
          )}
        </div>

        {/* Navigation */}
        <nav className="flex-1 py-3 px-2 space-y-0.5 overflow-y-auto">
          {navItems.map((item) => {
            const isActive =
              item.path === '/'
                ? location.pathname === '/'
                : location.pathname.startsWith(item.path);

            return (
              <Link
                key={item.path}
                to={item.path}
                title={collapsed ? item.label : undefined}
                className={`nav-link flex items-center gap-3 rounded-xl ${
                  collapsed ? 'px-0 py-2.5 justify-center' : 'px-3 py-2.5'
                } ${isActive ? 'nav-link-active' : ''}`}
              >
                <span className={`text-base ${collapsed ? '' : 'w-6 text-center'}`}>{item.icon}</span>
                {!collapsed && <span className="text-sm font-medium">{item.label}</span>}
              </Link>
            );
          })}
        </nav>

        {/* Presence toggle */}
        <PresenceToggle collapsed={collapsed} />

        {/* Clock */}
        <SidebarClock collapsed={collapsed} />

        {/* Footer */}
        <div className="p-2 space-y-1">
          {/* Collapse toggle */}
          <button
            onClick={() => setCollapsed(!collapsed)}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-glass-xs text-white/30 hover:text-white/60 hover:bg-white/[0.04] transition-colors text-xs"
          >
            {collapsed ? '\u{276F}' : '\u{276E}'}
            {!collapsed && <span>Chop</span>}
          </button>

          {connectionStatus !== 'connected' && !collapsed && (
            <div className="px-3 py-1.5 text-[10px] text-cp-amber bg-cp-amber/10 rounded-glass-xs text-center">
              {ws.label}
            </div>
          )}

          <button
            onClick={logout}
            className={`w-full flex items-center gap-3 rounded-glass-xs text-white/30 hover:text-white/60 hover:bg-white/[0.04] transition-colors ${
              collapsed ? 'px-0 py-2.5 justify-center' : 'px-3 py-2.5'
            }`}
          >
            <span className="text-sm">{'\u{1F6AA}'}</span>
            {!collapsed && <span className="text-sm">Leave the Dojo</span>}
          </button>
        </div>
      </aside>

      {/* Mobile top bar — shown on small screens */}
      <MobileTopBar connectionStatus={connectionStatus} />
    </>
  );
};

// ── Mobile Top Bar ──

const MobileTopBar = ({ connectionStatus }: { connectionStatus: ConnectionStatus }) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const [settingsExpanded, setSettingsExpanded] = useState(false);
  const location = useLocation();
  const { logout } = useAuth();
  const ws = statusConfig[connectionStatus];

  // Get current page title — include settings sub-tab if on settings
  const settingsTab = location.pathname.startsWith('/settings')
    ? new URLSearchParams(location.search).get('tab')
    : null;
  const settingsSubLabel = settingsTab
    ? settingsSubItems.find(s => s.tab === settingsTab)?.label
    : null;
  const pageTitle = settingsSubLabel
    ? `Settings — ${settingsSubLabel}`
    : (navItems.find(n =>
        n.path === '/' ? location.pathname === '/' : location.pathname.startsWith(n.path)
      )?.label ?? 'Agent D.O.J.O.');

  return (
    <>
      <div
        className="glass-topbar md:hidden fixed top-0 left-0 right-0 z-40 flex items-center justify-between px-3 py-2.5 safe-area-top"
      >
        <button onClick={() => setMenuOpen(true)} className="text-white/60 hover:text-white text-xl p-2 -ml-1">
          {'\u2630'}
        </button>
        <span className="text-xs font-semibold text-white truncate max-w-[200px]">{pageTitle}</span>
        <span className={`status-dot ${ws.dot}`} title={ws.label} />
      </div>

      {/* Mobile menu overlay */}
      {menuOpen && (
        <div className="md:hidden fixed inset-0 z-50">
          <div className="absolute inset-0 bg-black/60" onClick={() => setMenuOpen(false)} />
          <div
            className="glass-menu absolute left-0 top-0 bottom-0 w-[280px] flex flex-col safe-area-top"
          >
            <div className="flex items-center gap-3 px-5 py-4 border-b border-white/[0.06]">
              <img src="/dojologo.svg" alt="DOJO" className="w-7 h-7" />
              <h1 className="text-sm font-bold text-white">Agent D.O.J.O.</h1>
            </div>
            <nav className="flex-1 py-2 px-2 space-y-0.5 overflow-y-auto">
              {navItems.map((item) => {
                const isSettings = item.path === '/settings';
                const isActive =
                  item.path === '/' ? location.pathname === '/' : location.pathname.startsWith(item.path);

                if (isSettings) {
                  // Settings gets an expandable sub-menu on mobile
                  return (
                    <div key={item.path}>
                      <button
                        onClick={() => setSettingsExpanded(!settingsExpanded)}
                        className={`w-full flex items-center gap-3 px-3 py-3 rounded-glass-sm transition-colors ${
                          isActive ? 'bg-white/[0.08] text-white' : 'text-white/50'
                        }`}
                      >
                        <span className="text-base w-6 text-center">{item.icon}</span>
                        <span className="text-sm font-medium flex-1 text-left">{item.label}</span>
                        <span className="text-[10px] text-white/30">{settingsExpanded ? '▾' : '▸'}</span>
                      </button>
                      {settingsExpanded && (
                        <div className="ml-5 pl-4 border-l border-white/[0.06] space-y-0.5 mt-0.5">
                          {settingsSubItems.map(sub => {
                            const subActive = isActive && settingsTab === sub.tab;
                            return (
                              <Link
                                key={sub.tab}
                                to={`/settings?tab=${sub.tab}`}
                                onClick={() => setMenuOpen(false)}
                                className={`block px-3 py-2 rounded-lg text-xs transition-colors ${
                                  subActive
                                    ? 'bg-cp-amber/10 text-cp-amber font-medium'
                                    : 'text-white/40 hover:text-white/70'
                                }`}
                              >
                                {sub.label}
                              </Link>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                }

                return (
                  <Link
                    key={item.path}
                    to={item.path}
                    onClick={() => setMenuOpen(false)}
                    className={`flex items-center gap-3 px-3 py-3 rounded-glass-sm transition-colors ${
                      isActive ? 'bg-white/[0.08] text-white' : 'text-white/50 hover:text-white/80'
                    }`}
                  >
                    <span className="text-base w-6 text-center">{item.icon}</span>
                    <span className="text-sm font-medium">{item.label}</span>
                  </Link>
                );
              })}
            </nav>
            <div className="p-3 border-t border-white/[0.06]">
              <PresenceToggle collapsed={false} />
              <button onClick={() => { logout(); setMenuOpen(false); }}
                className="w-full flex items-center gap-3 px-3 py-3 rounded-glass-xs text-white/40 hover:text-white/70 transition-colors mt-1">
                <span>{'\u{1F6AA}'}</span>
                <span className="text-sm">Leave the Dojo</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Spacer removed — pt-[48px] on <main> in App.tsx handles clearance */}
    </>
  );
};
