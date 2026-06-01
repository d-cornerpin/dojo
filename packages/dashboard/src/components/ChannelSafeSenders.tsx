import { useEffect, useState } from 'react';
import * as api from '../lib/api';

// v2.7.24 — per-channel safe-sender allowlist (Gmail / Outlook / Teams).
// Mirrors the iMessage safe-sender UX in Settings.tsx but trimmed: no
// primary/star concept (the dashboard user is implicitly primary), no
// default-sender, no bridge-running coupling. Backed by a config key
// holding a JSON-array of SafeSender records.
//
// Empty list ⇒ no one on this channel can trigger an agent auto-reply.
// Notifications still surface; the agent just doesn't send back without
// the user being explicitly on the list.

type SharingLevel = 'open_book' | 'dont_overshare' | 'cautious' | 'project_only';

interface SafeSender {
  address: string;
  name: string;
  description?: string;
  is_primary: boolean;
  sharing_level: SharingLevel;
}

const SHARING_LEVEL_LABELS: Record<SharingLevel, string> = {
  open_book: 'Open Book',
  dont_overshare: "Don't Over-Share",
  cautious: 'Be Cautious',
  project_only: 'Project Only',
};

const SHARING_LEVEL_HINTS: Record<SharingLevel, string> = {
  open_book: 'No restrictions; treat as owner.',
  dont_overshare: 'Share what is asked; do not volunteer extra details.',
  cautious: 'Answer only what is asked, briefly.',
  project_only: 'Discuss only the specific project this contact is on.',
};

const isSharingLevel = (v: unknown): v is SharingLevel =>
  v === 'open_book' || v === 'dont_overshare' || v === 'cautious' || v === 'project_only';

function parseSenders(raw: string | undefined): SafeSender[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item): SafeSender[] => {
      if (item && typeof item === 'object' && typeof item.address === 'string' && item.address.trim()) {
        return [{
          address: item.address.trim(),
          name: typeof item.name === 'string' && item.name.trim() ? item.name.trim() : item.address.trim(),
          description: typeof item.description === 'string' && item.description.trim() ? item.description.trim() : undefined,
          is_primary: item.is_primary === true,
          sharing_level: isSharingLevel(item.sharing_level) ? item.sharing_level : 'dont_overshare',
        }];
      }
      return [];
    });
  } catch {
    return [];
  }
}

export interface ChannelSafeSendersProps {
  /** Config key the list is stored under (e.g., `gmail_approved_senders`). */
  configKey: string;
  /** Channel name for the section heading (e.g., "Gmail", "Outlook", "Teams"). */
  channelLabel: string;
  /** Help text describing what the list does for this channel. */
  description: string;
  /** Placeholder text for the address input (e.g., "name@gmail.com" or "user@org.com"). */
  addressPlaceholder: string;
}

export const ChannelSafeSenders = ({
  configKey,
  channelLabel,
  description,
  addressPlaceholder,
}: ChannelSafeSendersProps) => {
  const [senders, setSenders] = useState<SafeSender[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [newAddress, setNewAddress] = useState('');
  const [newName, setNewName] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [newSharingLevel, setNewSharingLevel] = useState<SharingLevel>('dont_overshare');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await api.getSetting(configKey);
      if (cancelled) return;
      if (res.ok) {
        setSenders(parseSenders(res.data.value ?? undefined));
      }
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [configKey]);

  const persist = async (next: SafeSender[]) => {
    setSaving(true);
    setError(null);
    const res = await api.setSetting(configKey, JSON.stringify(next));
    setSaving(false);
    if (res.ok) {
      setSenders(next);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } else {
      setError('Failed to save');
    }
  };

  const handleAdd = async () => {
    const address = newAddress.trim();
    if (!address) {
      setError('Address is required');
      return;
    }
    if (senders.some((s) => s.address.toLowerCase() === address.toLowerCase())) {
      setError(`"${address}" is already on the list`);
      return;
    }
    const next: SafeSender[] = [
      ...senders,
      {
        address,
        name: newName.trim() || address,
        description: newDescription.trim() || undefined,
        is_primary: false,
        sharing_level: newSharingLevel,
      },
    ];
    setNewAddress('');
    setNewName('');
    setNewDescription('');
    setNewSharingLevel('dont_overshare');
    setShowAdd(false);
    await persist(next);
  };

  const handleRemove = async (address: string) => {
    const next = senders.filter((s) => s.address !== address);
    await persist(next);
  };

  const handleChangeSharing = async (address: string, level: SharingLevel) => {
    const next = senders.map((s) =>
      s.address === address ? { ...s, sharing_level: level } : s,
    );
    await persist(next);
  };

  if (loading) {
    return <div className="text-xs text-ui/40 italic">Loading {channelLabel} safe senders…</div>;
  }

  return (
    <div className="mt-3 pt-3 border-t border-ui/[0.08]">
      <div className="flex items-center justify-between mb-1">
        <span className="text-sm text-ui/70">Safe {channelLabel} senders</span>
        {saved && <span className="text-xs text-cp-teal">Saved</span>}
        {saving && <span className="text-xs text-ui/40 italic">Saving…</span>}
      </div>
      <p className="text-xs text-ui/25 mb-2">{description}</p>

      {senders.length === 0 ? (
        <p className="text-xs text-ui/40 italic py-2">
          List is empty — the agent won&apos;t auto-reply to anyone on {channelLabel} until you add them here.
        </p>
      ) : (
        <ul className="space-y-1.5 mb-2">
          {senders.map((s) => (
            <li
              key={s.address}
              className="flex items-center gap-2 px-2 py-1.5 rounded bg-ui/[0.03] border border-ui/[0.06]"
            >
              <div className="flex-1 min-w-0">
                <div className="text-sm text-ui/85 truncate">{s.name}</div>
                <div className="text-xs text-ui/40 truncate">{s.address}</div>
                {s.description && (
                  <div className="text-xs text-ui/40 italic mt-0.5 truncate">{s.description}</div>
                )}
              </div>
              <select
                value={s.sharing_level}
                onChange={(e) => handleChangeSharing(s.address, e.target.value as SharingLevel)}
                className="text-xs rounded border border-ui/[0.12] bg-ui/[0.04] text-ui/70 px-1.5 py-0.5"
                title={SHARING_LEVEL_HINTS[s.sharing_level]}
              >
                {Object.entries(SHARING_LEVEL_LABELS).map(([k, label]) => (
                  <option key={k} value={k}>{label}</option>
                ))}
              </select>
              <button
                onClick={() => handleRemove(s.address)}
                className="text-xs text-cp-coral/70 hover:text-cp-coral px-1.5"
                title={`Remove ${s.name}`}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}

      {showAdd ? (
        <div className="space-y-2 p-2 rounded bg-ui/[0.03] border border-ui/[0.08]">
          <div>
            <label className="text-xs text-ui/55 block mb-1">Address</label>
            <input
              type="text"
              value={newAddress}
              onChange={(e) => setNewAddress(e.target.value)}
              placeholder={addressPlaceholder}
              className="w-full px-2 py-1 text-sm rounded bg-ui/[0.05] border border-ui/[0.12] text-ui focus:outline-none focus:border-cp-amber"
            />
          </div>
          <div>
            <label className="text-xs text-ui/55 block mb-1">Display name (optional)</label>
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="e.g., full name of the contact"
              className="w-full px-2 py-1 text-sm rounded bg-ui/[0.05] border border-ui/[0.12] text-ui focus:outline-none focus:border-cp-amber"
            />
          </div>
          <div>
            <label className="text-xs text-ui/55 block mb-1">Note (optional)</label>
            <input
              type="text"
              value={newDescription}
              onChange={(e) => setNewDescription(e.target.value)}
              placeholder="e.g., Spouse, business partner, etc."
              className="w-full px-2 py-1 text-sm rounded bg-ui/[0.05] border border-ui/[0.12] text-ui focus:outline-none focus:border-cp-amber"
            />
          </div>
          <div>
            <label className="text-xs text-ui/55 block mb-1">Sharing policy</label>
            <select
              value={newSharingLevel}
              onChange={(e) => setNewSharingLevel(e.target.value as SharingLevel)}
              className="w-full px-2 py-1 text-sm rounded bg-ui/[0.05] border border-ui/[0.12] text-ui"
            >
              {Object.entries(SHARING_LEVEL_LABELS).map(([k, label]) => (
                <option key={k} value={k}>{label}</option>
              ))}
            </select>
            <p className="text-xs text-ui/40 italic mt-1">{SHARING_LEVEL_HINTS[newSharingLevel]}</p>
          </div>
          {error && <p className="text-xs text-cp-coral">{error}</p>}
          <div className="flex gap-2">
            <button
              onClick={handleAdd}
              disabled={saving}
              className="px-3 py-1 glass-btn-primary text-xs rounded transition-colors disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Add'}
            </button>
            <button
              onClick={() => { setShowAdd(false); setError(null); }}
              className="px-3 py-1 text-xs text-ui/55 hover:text-ui/80"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setShowAdd(true)}
          className="text-xs text-cp-amber hover:text-cp-amber/80"
        >
          + Add safe {channelLabel.toLowerCase()} sender
        </button>
      )}
      {error && !showAdd && <p className="text-xs text-cp-coral mt-1">{error}</p>}
    </div>
  );
};
