// ── Settings → The iMessage bridge card: safe senders, sharing levels, auto-routing.
// Its `SHARING_LEVEL_*` tables and `parseSenders` travel with it — every call site is here.
//
// Lifted OUT of `pages/Settings.tsx` by t111-E1. The moved lines are VERBATIM; the only new
// bytes are this header, the imports below and the `export` keyword(s).

import { useState, useEffect } from 'react';
import { fullDiskAccessInstructions, fullDiskAccessWhy, FULL_DISK_ACCESS_VERIFY } from '@dojo/shared';
import * as api from '../../lib/api';


// ── iMessage Bridge Settings ──

// Shape matches packages/server/src/services/imessage-bridge.ts SafeSender.
// Duplicated rather than imported to keep the dashboard build standalone.
type SharingLevel = 'open_book' | 'dont_overshare' | 'cautious' | 'project_only';

interface SafeSender {
  address: string;
  name: string;
  description?: string;
  is_primary: boolean;
  sharing_level: SharingLevel;
  /** This contact is another AI agent, not a person. The engine skips
   *  work-acks and damps content-free courtesy volleys toward it. */
  is_agent?: boolean;
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
  cautious: 'Answer only what is asked, briefly. High-level only.',
  project_only: 'Discuss only the specific project this contact is on.',
};

const isSharingLevel = (v: unknown): v is SharingLevel =>
  v === 'open_book' || v === 'dont_overshare' || v === 'cautious' || v === 'project_only';

// Accept both the legacy string[] shape (older installs) and the new object
// shape so reading an unmigrated config doesn't lose data.
const parseSenders = (raw: string | undefined): SafeSender[] => {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item, idx): SafeSender[] => {
      if (typeof item === 'string') {
        const addr = item.trim();
        if (!addr) return [];
        const isPrimary = idx === 0;
        return [{
          address: addr,
          name: addr,
          description: undefined,
          is_primary: isPrimary,
          sharing_level: isPrimary ? 'open_book' : 'dont_overshare',
        }];
      }
      if (item && typeof item === 'object' && typeof item.address === 'string' && item.address.trim()) {
        const isPrimary = item.is_primary === true;
        return [{
          address: item.address.trim(),
          name: typeof item.name === 'string' && item.name.trim() ? item.name.trim() : item.address.trim(),
          description: typeof item.description === 'string' && item.description.trim() ? item.description.trim() : undefined,
          is_primary: isPrimary,
          sharing_level: isSharingLevel(item.sharing_level) ? item.sharing_level : (isPrimary ? 'open_book' : 'dont_overshare'),
          is_agent: item.is_agent === true,
        }];
      }
      return [];
    });
  } catch {
    return [];
  }
};

export const IMBridgeSettings = () => {
  const [enabled, setEnabled] = useState(false);
  const [serverExecPath, setServerExecPath] = useState<string | null>(null);
  const [senders, setSenders] = useState<SafeSender[]>([]);
  const [newAddress, setNewAddress] = useState('');
  const [newName, setNewName] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [newSharingLevel, setNewSharingLevel] = useState<SharingLevel>('dont_overshare');
  const [newIsAgent, setNewIsAgent] = useState(false);
  const [showAddInput, setShowAddInput] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = async () => {
      // `permissions/check` reports which executable does the reading; only the server knows it.
      // ⚠ NO LEADING `/api` — the door prepends it. This read spent its whole life
      // asking for `/api/api/setup/permissions/check`, so it 404'd every time and
      // `serverExecPath` never arrived, which made the Full Disk Access hint below
      // render its "path unknown" wording PERMANENTLY on this page. The audit's
      // item-D fix was inert on one of its two surfaces because of five characters.
      // `the-dashboard-has-one-network-door.test.ts` now refuses the prefix.
      void api.request<Record<string, string>>('/setup/permissions/check')
        .then(r => { if (r.ok && r.data?.serverExecPath) setServerExecPath(r.data.serverExecPath); });
      const [enabledResult, sendersResult, defaultResult] = await Promise.all([
        api.getSetting('imessage_enabled'),
        api.getSetting('imessage_approved_senders'),
        api.getSetting('imessage_default_sender'),
      ]);

      if (enabledResult.ok && enabledResult.data.value) {
        setEnabled(enabledResult.data.value === 'true');
      }

      // Pre-fix the loader would also fall back to `imessage_recipient`
      // (a legacy single-address field) and auto-promote it to a sender
      // entry. On most installs that field holds the AGENT's own iMessage
      // address (set during installation), which then showed up as the
      // user's primary sender - confusing and wrong. We now only load
      // actual saved safe-sender records; if there are none, the list
      // starts empty so the user explicitly adds the right people.
      const loaded: SafeSender[] = sendersResult.ok && sendersResult.data.value
        ? parseSenders(sendersResult.data.value)
        : [];

      // If no record is marked primary, promote the legacy default key's
      // matching record (best-effort) or the first record. Best-effort
      // only; if no primary can be inferred, the first record gets the star.
      if (loaded.length > 0 && !loaded.some(s => s.is_primary)) {
        const legacyDefault = defaultResult.ok ? defaultResult.data.value : '';
        const idx = legacyDefault ? loaded.findIndex(s => s.address === legacyDefault) : -1;
        if (idx >= 0) loaded[idx].is_primary = true;
        else loaded[0].is_primary = true;
      }
      setSenders(loaded);
      setLoading(false);
    };
    load();
  }, []);

  const handleSave = async () => {
    setSaving(true);
    setSaved(false);
    setError(null);

    if (enabled && senders.length === 0) {
      setError('Add at least one approved sender');
      setSaving(false);
      return;
    }

    // Ensure exactly one primary on save. If somehow none, mark the first.
    const normalized = senders.map(s => ({ ...s }));
    if (normalized.length > 0 && !normalized.some(s => s.is_primary)) {
      normalized[0].is_primary = true;
    }
    // Force every primary record's sharing_level to open_book at save time.
    // The UI locks the dropdown, but a stale or hand-edited record could
    // arrive with a throttled level on the primary - normalize defensively.
    for (const s of normalized) {
      if (s.is_primary) s.sharing_level = 'open_book';
    }
    // Refuse to save a Project-Only sender with no description: the policy
    // text references the description for project scope, and an empty
    // description means the agent has nothing to enforce against.
    const badProjectOnly = normalized.find(s => !s.is_primary && s.sharing_level === 'project_only' && !s.description);
    if (badProjectOnly) {
      setError(`"${badProjectOnly.name || badProjectOnly.address}" is set to Project Only but has no description. Add a brief description that names the specific project the agent should stay inside of, or change the sharing level.`);
      setSaving(false);
      return;
    }
    const primary = normalized.find(s => s.is_primary);

    const results = await Promise.all([
      api.setSetting('imessage_enabled', enabled ? 'true' : 'false'),
      api.setSetting('imessage_approved_senders', JSON.stringify(normalized)),
      // Keep legacy fields in sync so older code paths (and any external
      // tools that read them directly) keep working until everything reads
      // the new shape via the bridge helpers.
      api.setSetting('imessage_recipient', normalized[0]?.address ?? ''),
      api.setSetting('imessage_default_sender', primary?.address ?? ''),
    ]);

    if (results.every(r => r.ok)) {
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } else {
      setError('Failed to save settings');
    }
    setSaving(false);
  };

  const addSender = () => {
    const address = newAddress.trim();
    if (!address) return;
    if (senders.some(s => s.address === address)) {
      setError(`"${address}" is already in the list`);
      return;
    }
    const name = newName.trim() || address;
    const description = newDescription.trim() || undefined;
    const isPrimary = senders.length === 0; // first sender is auto-primary
    // Primary auto-promotes to open_book regardless of dropdown value (no
    // reason to throttle sharing with yourself). Subsequent senders honor
    // the selected level from the form.
    setSenders([...senders, {
      address,
      name,
      description,
      is_primary: isPrimary,
      // The primary is the owner, a person by definition; the agent flag only
      // ever applies to non-primary senders.
      is_agent: isPrimary ? false : newIsAgent,
      sharing_level: isPrimary ? 'open_book' : newSharingLevel,
    }]);
    setNewAddress('');
    setNewName('');
    setNewDescription('');
    setNewSharingLevel('dont_overshare');
    setNewIsAgent(false);
    setShowAddInput(false);
    setError(null);
  };

  const removeSender = (index: number) => {
    const wasPrimary = senders[index].is_primary;
    const updated = senders.filter((_, i) => i !== index);
    if (wasPrimary && updated.length > 0) {
      updated[0].is_primary = true;
    }
    setSenders(updated);
  };

  const setPrimary = (index: number) => {
    // When promoting to primary, force sharing_level to open_book so the
    // primary is always treated as the owner. When demoting an old primary,
    // if their level was open_book (the locked default), drop them to
    // dont_overshare since open_book on a non-primary doesn't reflect a
    // deliberate choice.
    setSenders(senders.map((s, i) => {
      if (i === index) return { ...s, is_primary: true, sharing_level: 'open_book' as SharingLevel };
      if (s.is_primary) return { ...s, is_primary: false, sharing_level: s.sharing_level === 'open_book' ? 'dont_overshare' as SharingLevel : s.sharing_level };
      return { ...s, is_primary: false };
    }));
  };

  const updateField = (index: number, field: 'name' | 'description', value: string) => {
    setSenders(senders.map((s, i) => i === index ? { ...s, [field]: field === 'description' && !value.trim() ? undefined : value } : s));
  };

  const setSharingLevel = (index: number, level: SharingLevel) => {
    setSenders(senders.map((s, i) => i === index ? { ...s, sharing_level: level } : s));
  };

  const setIsAgentFlag = (index: number, isAgent: boolean) => {
    setSenders(senders.map((s, i) => i === index ? { ...s, is_agent: isAgent } : s));
  };

  if (loading) return null;

  return (
    <div className="tile space-y-4">
      <div>
        <div className="scard__title">iMessage Bridge</div>
        <div className="scard__desc">
          Enable to send and receive messages with your agent via iMessage. {fullDiskAccessWhy()}
        </div>
      </div>

      {/* Toggle */}
      <div className="flex items-center justify-between">
        <label className="text-sm text-ui/70">Enable iMessage Bridge</label>
        <button
          type="button"
          aria-pressed={enabled}
          onClick={() => setEnabled(!enabled)}
          className={`switch ${enabled ? 'is-on' : ''}`}
        />
      </div>

      {/* Approved Senders */}
      {enabled && (
        <div>
          <label className="form-label mb-2">
            Approved Senders
          </label>
          <p className="text-xs text-ui/25 mb-2">
            Each safe sender is a person (or another agent) your DOJO will accept iMessages from. Star the primary user; everyone else is a household member, friend, or another agent. The agent sees each sender's name and description in the inbound message and replies to them by default - so it can't mix up who's who.
          </p>

          {/* Sender list */}
          {senders.length > 0 && (
            <div className="space-y-2 mb-3">
              {senders.map((sender, i) => (
                <div
                  key={i}
                  className="glass-nested rounded-xl px-3 py-2 space-y-2"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      <button
                        onClick={() => setPrimary(i)}
                        title={sender.is_primary ? 'Primary user (you)' : 'Set as primary user'}
                        className={`text-lg leading-none transition-colors shrink-0 ${
                          sender.is_primary
                            ? 'text-cp-amber'
                            : 'text-ui/25 hover:text-cp-amber'
                        }`}
                      >
                        {sender.is_primary ? '\u2605' : '\u2606'}
                      </button>
                      <span className="text-sm text-ui/90 font-mono truncate">{sender.address}</span>
                    </div>
                    <button
                      onClick={() => removeSender(i)}
                      className="text-ui/40 hover:text-cp-coral transition-colors ml-2 shrink-0"
                    >
                      &times;
                    </button>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <div className="space-y-1">
                      <label className="text-xs text-ui/40 block">Display name</label>
                      <input
                        type="text"
                        value={sender.name === sender.address ? '' : sender.name}
                        onChange={(e) => updateField(i, 'name', e.target.value)}
                        placeholder="e.g., Alex"
                        className="glass-input text-sm w-full"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs text-ui/40 block">Brief description</label>
                      <input
                        type="text"
                        value={sender.description ?? ''}
                        onChange={(e) => updateField(i, 'description', e.target.value)}
                        placeholder="e.g., spouse, teammate, project collaborator"
                        className="glass-input text-sm w-full"
                      />
                    </div>
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs text-ui/40 block">Sharing level</label>
                    <select
                      value={sender.is_primary ? 'open_book' : sender.sharing_level}
                      onChange={(e) => setSharingLevel(i, e.target.value as SharingLevel)}
                      disabled={sender.is_primary}
                      className="glass-input text-sm w-full disabled:opacity-60"
                    >
                      {(Object.keys(SHARING_LEVEL_LABELS) as SharingLevel[]).map(level => (
                        <option key={level} value={level}>
                          {SHARING_LEVEL_LABELS[level]}
                        </option>
                      ))}
                    </select>
                    <p className="text-xs text-ui/25">
                      {sender.is_primary
                        ? 'Primary user is always Open Book. Star another sender first if you want to change this.'
                        : SHARING_LEVEL_HINTS[sender.sharing_level]}
                    </p>
                    {sender.sharing_level === 'project_only' && !sender.description && !sender.is_primary && (
                      <p className="text-xs text-cp-amber">⚠ Project Only needs a description that names the specific project; without it the agent has no scope to enforce.</p>
                    )}
                  </div>
                  {!sender.is_primary && (
                    <label
                      className="mt-2 inline-flex items-center gap-2 cursor-pointer select-none"
                      title="Check this when the contact is another AI agent (like a family member's assistant). Your agent will skip the automatic 'on it' texts and won't volley courtesy replies with it."
                    >
                      <input
                        type="checkbox"
                        checked={sender.is_agent === true}
                        onChange={(e) => setIsAgentFlag(i, e.target.checked)}
                        className="h-3.5 w-3.5 rounded border-ui/[0.15] bg-ui/[0.05] accent-amber-500 cursor-pointer"
                      />
                      <span className="text-[11px] text-ui/55">This contact is an AI agent, not a person</span>
                    </label>
                  )}
                </div>
              ))}
            </div>
          )}

          {enabled && senders.length === 0 && (
            <div className="alert-banner alert-warning mb-2">
              iMessage bridge is ON but no senders are configured. The bridge will sit idle until you add at least one sender below.
            </div>
          )}

          {senders.length === 0 && !showAddInput && (
            <p className="text-xs text-ui/25 italic mb-2">No approved senders configured.</p>
          )}

          {/* Add sender form */}
          {showAddInput ? (
            <div className="glass-nested rounded-xl px-3 py-3 space-y-2">
              <div className="space-y-1">
                <label className="text-xs text-ui/40 block">Phone number or Apple ID</label>
                <input
                  type="text"
                  value={newAddress}
                  onChange={(e) => setNewAddress(e.target.value)}
                  placeholder="+15551234567 or user@icloud.com"
                  autoFocus
                  className="glass-input w-full font-mono text-sm"
                />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <div className="space-y-1">
                  <label className="text-xs text-ui/40 block">Display name</label>
                  <input
                    type="text"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder="e.g., Alex"
                    className="glass-input text-sm w-full"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs text-ui/40 block">Brief description</label>
                  <input
                    type="text"
                    value={newDescription}
                    onChange={(e) => setNewDescription(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && addSender()}
                    placeholder="e.g., spouse, teammate, project collaborator"
                    className="glass-input text-sm w-full"
                  />
                </div>
              </div>
              {senders.length > 0 && (
                <div className="space-y-1">
                  <label className="text-xs text-ui/40 block">Sharing level</label>
                  <select
                    value={newSharingLevel}
                    onChange={(e) => setNewSharingLevel(e.target.value as SharingLevel)}
                    className="glass-input text-sm w-full"
                  >
                    {(Object.keys(SHARING_LEVEL_LABELS) as SharingLevel[]).map(level => (
                      <option key={level} value={level}>
                        {SHARING_LEVEL_LABELS[level]}
                      </option>
                    ))}
                  </select>
                  <p className="text-xs text-ui/25">{SHARING_LEVEL_HINTS[newSharingLevel]}</p>
                  <label
                    className="mt-2 inline-flex items-center gap-2 cursor-pointer select-none"
                    title="Check this when the contact is another AI agent (like a family member's assistant). Your agent will skip the automatic 'on it' texts and won't volley courtesy replies with it."
                  >
                    <input
                      type="checkbox"
                      checked={newIsAgent}
                      onChange={(e) => setNewIsAgent(e.target.checked)}
                      className="h-3.5 w-3.5 rounded border-ui/[0.15] bg-ui/[0.05] accent-amber-500 cursor-pointer"
                    />
                    <span className="text-[11px] text-ui/55">This contact is an AI agent, not a person</span>
                  </label>
                </div>
              )}
              {senders.length === 0 && (
                <p className="text-xs text-ui/25">First sender becomes the primary user automatically (Open Book).</p>
              )}
              <div className="flex gap-2">
                <button
                  onClick={addSender}
                  disabled={!newAddress.trim()}
                  className="px-3 py-2 glass-btn-primary text-sm rounded-lg transition-colors"
                >
                  Add sender
                </button>
                <button
                  onClick={() => { setShowAddInput(false); setNewAddress(''); setNewName(''); setNewDescription(''); setNewSharingLevel('dont_overshare'); setNewIsAgent(false); }}
                  className="px-3 py-2 text-sm text-ui/55 hover:text-ui/90 transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setShowAddInput(true)}
              className="flex items-center gap-1 text-xs text-cp-blue hover:text-cp-blue/80 transition-colors"
            >
              <span className="text-lg leading-none">+</span> Add sender
            </button>
          )}
        </div>
      )}

      {error && (
        <div className="alert-banner alert-error">
          {error}
        </div>
      )}

      <div className="flex items-center gap-2">
        <button
          onClick={handleSave}
          disabled={saving}
          className="px-4 py-2 glass-btn-primary text-sm font-medium rounded-lg transition-colors"
        >
          {saving ? 'Saving...' : 'Save'}
        </button>
        {saved && <span className="text-xs text-cp-teal">Saved. Changes are live - no restart needed.</span>}
      </div>

      {enabled && (
        <div className="alert-banner alert-warning">
          {fullDiskAccessInstructions(serverExecPath)} {FULL_DISK_ACCESS_VERIFY}
        </div>
      )}
    </div>
  );
};
