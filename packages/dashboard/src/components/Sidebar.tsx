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
                <span className="text-[10px]" style={{ color: 'var(--text-tertiary)' }}>{ws.label}</span>
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
                className={`flex items-center gap-3 rounded-xl transition-all duration-200 ${
                  collapsed ? 'px-0 py-2.5 justify-center' : 'px-3 py-2.5'
                }`}
                style={isActive ? {
                  background: 'rgba(245, 166, 35, 0.1)',
                  borderLeft: '3px solid #F5A623',
                  color: '#F5A623',
                } : {
                  color: 'rgba(255,255,255,0.45)',
                  borderLeft: '3px solid transparent',
                }}
                onMouseEnter={(e) => { if (!isActive) { e.currentTarget.style.color = 'rgba(255,255,255,0.8)'; e.currentTarget.style.background = 'rgba(255,255,255,0.04)'; } }}
                onMouseLeave={(e) => { if (!isActive) { e.currentTarget.style.color = 'rgba(255,255,255,0.45)'; e.currentTarget.style.background = 'transparent'; } }}
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
  const location = useLocation();
  const { logout } = useAuth();
  const ws = statusConfig[connectionStatus];

  // Get current page title
  const pageTitle = navItems.find(n =>
    n.path === '/' ? location.pathname === '/' : location.pathname.startsWith(n.path)
  )?.label ?? 'Agent D.O.J.O.';

  return (
    <>
      <div
        className="md:hidden fixed top-0 left-0 right-0 z-40 flex items-center justify-between px-4 py-3"
        style={{
          background: 'rgba(11, 15, 26, 0.85)',
          backdropFilter: 'blur(16px)',
          borderBottom: '1px solid rgba(255, 255, 255, 0.06)',
        }}
      >
        <button onClick={() => setMenuOpen(true)} className="text-white/60 hover:text-white text-xl p-1">
          {'\u2630'}
        </button>
        <span className="text-sm font-semibold text-white">{pageTitle}</span>
        <span className={`status-dot ${ws.dot}`} title={ws.label} />
      </div>

      {/* Mobile menu overlay */}
      {menuOpen && (
        <div className="md:hidden fixed inset-0 z-50">
          <div className="absolute inset-0 bg-black/60" onClick={() => setMenuOpen(false)} />
          <div
            className="absolute left-0 top-0 bottom-0 w-[280px] flex flex-col"
            style={{
              background: 'rgba(26, 31, 53, 0.95)',
              backdropFilter: 'blur(30px)',
            }}
          >
            <div className="flex items-center gap-3 px-5 py-5 border-b border-white/[0.06]">
              <img src="/dojologo.svg" alt="DOJO" className="w-8 h-8" />
              <h1 className="text-base font-bold text-white">Agent D.O.J.O.</h1>
            </div>
            <nav className="flex-1 py-3 px-2 space-y-0.5">
              {navItems.map((item) => {
                const isActive =
                  item.path === '/' ? location.pathname === '/' : location.pathname.startsWith(item.path);
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
              <button onClick={() => { logout(); setMenuOpen(false); }}
                className="w-full flex items-center gap-3 px-3 py-3 rounded-glass-xs text-white/40 hover:text-white/70 transition-colors">
                <span>{'\u{1F6AA}'}</span>
                <span className="text-sm">Leave the Dojo</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Spacer for fixed top bar */}
      <div className="md:hidden h-[52px]" />
    </>
  );
};
