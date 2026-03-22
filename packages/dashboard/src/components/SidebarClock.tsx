import { useState, useEffect } from 'react';

interface SidebarClockProps {
  collapsed?: boolean;
}

export const SidebarClock = ({ collapsed }: SidebarClockProps) => {
  const [now, setNow] = useState(new Date());

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const tzAbbr = now.toLocaleTimeString('en-US', { timeZoneName: 'short' }).split(' ').pop() ?? tz;

  const dateLine = now.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  const timeLine = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  if (collapsed) {
    return (
      <div className="text-center py-2 font-mono text-[11px]" style={{ color: 'rgba(255,255,255,0.4)' }}>
        {now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
      </div>
    );
  }

  return (
    <div className="text-center py-3 px-2 border-t border-white/[0.06]">
      <div className="text-xs" style={{ color: 'rgba(255,255,255,0.45)' }}>{dateLine}</div>
      <div className="font-mono text-sm font-medium" style={{ color: 'rgba(255,255,255,0.7)' }}>{timeLine}</div>
      <div className="text-[10px]" style={{ color: 'rgba(255,255,255,0.3)' }}>{tzAbbr}</div>
    </div>
  );
};
