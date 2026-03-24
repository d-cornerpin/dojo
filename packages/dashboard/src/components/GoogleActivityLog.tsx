import { useState, useEffect } from 'react';

const TOKEN = () => localStorage.getItem('dojo_token');

const fetchApi = async (path: string) => {
  const token = TOKEN();
  const res = await fetch(path, {
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  return res.json();
};

interface ActivityEntry {
  id: string;
  agentId: string;
  agentName: string | null;
  action: string;
  actionType: 'read' | 'write';
  details: string | null;
  success: boolean;
  error: string | null;
  createdAt: string;
}

export const GoogleActivityLog = () => {
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const [filterType, setFilterType] = useState<'all' | 'read' | 'write'>('all');
  const [filterAgent, setFilterAgent] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => { loadEntries(); }, [filterType, filterAgent]);

  const loadEntries = async () => {
    setLoading(true);
    let url = '/api/google/activity?limit=50';
    if (filterType !== 'all') url += `&type=${filterType}`;
    if (filterAgent) url += `&agent=${encodeURIComponent(filterAgent)}`;

    const data = await fetchApi(url);
    if (data.ok) setEntries(data.data);
    setLoading(false);
  };

  const formatAction = (action: string) => {
    return action.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  };

  const parseDetails = (details: string | null): Record<string, unknown> | null => {
    if (!details) return null;
    try { return JSON.parse(details); } catch { return null; }
  };

  const formatDetails = (entry: ActivityEntry): string => {
    const d = parseDetails(entry.details);
    if (!d) return '';

    const parts: string[] = [];
    if (d.to) parts.push(`To: ${d.to}`);
    if (d.subject) parts.push(`Subject: ${d.subject}`);
    if (d.query) parts.push(`Query: ${d.query}`);
    if (d.title) parts.push(`Title: ${d.title}`);
    if (d.documentId) parts.push(`Doc: ${d.documentId}`);
    if (d.spreadsheetId) parts.push(`Sheet: ${d.spreadsheetId}`);
    if (d.messageId) parts.push(`Msg: ${d.messageId}`);
    if (d.filePath) parts.push(`File: ${d.filePath}`);
    if (d.email) parts.push(`Shared with: ${d.email}`);
    return parts.join(' | ');
  };

  return (
    <div className="space-y-3">
      {/* Filters */}
      <div className="flex gap-2">
        <select value={filterType} onChange={(e) => setFilterType(e.target.value as 'all' | 'read' | 'write')}
          className="glass-select text-xs py-1">
          <option value="all">All Actions</option>
          <option value="read">Reads Only</option>
          <option value="write">Writes Only</option>
        </select>
        <input type="text" value={filterAgent} onChange={(e) => setFilterAgent(e.target.value)}
          placeholder="Filter by agent..."
          className="glass-input text-xs py-1 flex-1" />
      </div>

      {/* Table */}
      {loading ? (
        <p className="text-xs text-white/30">Loading...</p>
      ) : entries.length === 0 ? (
        <p className="text-xs text-white/30">No activity yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-white/40 border-b border-white/[0.06]">
                <th className="text-left py-1.5 pr-2 font-medium">Time</th>
                <th className="text-left py-1.5 pr-2 font-medium">Agent</th>
                <th className="text-left py-1.5 pr-2 font-medium">Action</th>
                <th className="text-left py-1.5 pr-2 font-medium">Type</th>
                <th className="text-left py-1.5 font-medium">Details</th>
              </tr>
            </thead>
            <tbody>
              {entries.map(entry => (
                <tr key={entry.id} className="border-b border-white/[0.03] hover:bg-white/[0.02]">
                  <td className="py-1.5 pr-2 text-white/30 whitespace-nowrap">
                    {new Date(entry.createdAt).toLocaleTimeString()}
                  </td>
                  <td className="py-1.5 pr-2 text-white/60">
                    {entry.agentName ?? entry.agentId.slice(0, 8)}
                  </td>
                  <td className="py-1.5 pr-2 text-white/70">
                    {formatAction(entry.action)}
                  </td>
                  <td className="py-1.5 pr-2">
                    <span className={`px-1.5 py-0.5 rounded text-[10px] ${
                      entry.actionType === 'write'
                        ? 'bg-cp-amber/10 text-cp-amber border border-cp-amber/20'
                        : 'bg-white/[0.06] text-white/40'
                    }`}>
                      {entry.actionType}
                    </span>
                    {!entry.success && (
                      <span className="ml-1 px-1.5 py-0.5 rounded text-[10px] bg-cp-coral/10 text-cp-coral border border-cp-coral/20">
                        failed
                      </span>
                    )}
                  </td>
                  <td className="py-1.5 text-white/40 truncate max-w-[200px]" title={formatDetails(entry)}>
                    {formatDetails(entry)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
