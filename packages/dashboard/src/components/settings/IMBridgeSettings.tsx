// ── Settings → The iMessage bridge card: safe senders, sharing levels, auto-routing.
// Its `SHARING_LEVEL_*` tables and `parseSenders` travel with it; every call site is here.

import { useState, useEffect, useRef, useCallback } from 'react';
import { fullDiskAccessInstructions, fullDiskAccessWhy, FULL_DISK_ACCESS_VERIFY } from '@dojo/shared';
import * as api from '../../lib/api';
import { ownerChanged, confirmRemoveOwner } from '../../lib/owner-star';
import { isEnterNotComposing } from '../../lib/enter-key';


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

// A stored value that is not a JSON list cannot be told apart from "empty" by `parseSenders`, so
// the load checks it here first: an unreadable list is never edited or saved over.
const isReadableList = (raw: string | null | undefined): boolean => {
  if (!raw) return true;
  try { return Array.isArray(JSON.parse(raw)); } catch { return false; }
};

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

export const IMBridgeSettings = ({ onLoaded, onSaved, onDirtyChange, saveLabel = () => 'Save', saveDisabled = false }: {
  onLoaded?: (setUpBefore: boolean) => void;
  onSaved?: (enabled: boolean, primaryAddress: string) => void;
  onDirtyChange?: (dirty: boolean) => void;
  saveLabel?: (enabled: boolean) => string;
  saveDisabled?: boolean;
} = {}) => {
  const hooks = useRef({ onLoaded, onSaved, onDirtyChange });
  hooks.current = { onLoaded, onSaved, onDirtyChange };
  const cleanSnapshot = useRef('');   // the switch and list as loaded or last saved: any difference is an unsaved edit
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
  const [loadFailed, setLoadFailed] = useState(false);
  // The exact stored list text the editor was built on; the save names it so the server can refuse a stale one.
  const baseRaw = useRef<string | null>(null);
  const baseList = useRef<SafeSender[]>([]);   // the list as loaded or last saved: who the owner was

  const load = useCallback(async () => {
      setLoading(true);
      // `permissions/check` reports which executable does the reading; only the server knows it.
      // No leading `/api`: the door prepends it, so adding it here would 404 the read.
      void api.request<Record<string, string>>('/setup/permissions/check')
        .then(r => { if (r.ok && r.data?.serverExecPath) setServerExecPath(r.data.serverExecPath); });
      const [enabledResult, sendersResult, defaultResult] = await Promise.all([
        api.getSetting('imessage_enabled'),
        api.getSetting('imessage_approved_senders'),
        api.getSetting('imessage_default_sender'),
      ]);

      // A failed or unreadable read must not look like an empty list: nothing is offered to edit.
      if (!enabledResult.ok || !sendersResult.ok || !isReadableList(sendersResult.data.value)) {
        setLoadFailed(true);
        setLoading(false);
        return;
      }
      setLoadFailed(false);
      baseRaw.current = sendersResult.data.value ?? null;

      if (enabledResult.ok && enabledResult.data.value) {
        setEnabled(enabledResult.data.value === 'true');
      }

      // Only saved safe-sender records load: the legacy `imessage_recipient` field usually
      // holds the AGENT's own address, and promoting it would label the agent as the owner.
      const loaded: SafeSender[] = sendersResult.ok && sendersResult.data.value
        ? parseSenders(sendersResult.data.value)
        : [];

      // With no starred record, the legacy default key's matching record takes the star, best-effort.
      if (loaded.length > 0 && !loaded.some(s => s.is_primary)) {
        const legacyDefault = defaultResult.ok ? defaultResult.data.value : '';
        const idx = legacyDefault ? loaded.findIndex(s => s.address === legacyDefault) : -1;
        if (idx >= 0) loaded[idx].is_primary = true;
        // Otherwise the list has no owner and stays that way: the star never lands on the first entry on its own.
      }
      baseList.current = loaded.map(s => ({ ...s }));
      setSenders(loaded);
      cleanSnapshot.current = JSON.stringify({ enabled: enabledResult.data.value === 'true', senders: loaded });
      hooks.current.onLoaded?.(enabledResult.data.value !== null);
      hooks.current.onDirtyChange?.(false);
      setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!loading && !loadFailed) hooks.current.onDirtyChange?.(JSON.stringify({ enabled, senders }) !== cleanSnapshot.current);
  }, [enabled, senders, loading, loadFailed]);

  const handleSave = async () => {
    setSaving(true);
    setSaved(false);
    setError(null);

    if (enabled && senders.length === 0) {
      setError('Add at least one approved sender');
      setSaving(false);
      return;
    }

    const normalized = senders.map(s => ({ ...s }));
    // (A list with no starred entry is saved with no owner; the star never moves on its own.)
    // Force every primary's sharing_level to open_book at save time: the UI locks the
    // dropdown, but a stale or hand-edited record could arrive with a throttled level.
    for (const s of normalized) {
      if (s.is_primary) s.sharing_level = 'open_book';
    }
    // A Project-Only sender needs a description: the policy text uses it as the project
    // scope, so without one the agent has nothing to enforce against.
    const badProjectOnly = normalized.find(s => !s.is_primary && s.sharing_level === 'project_only' && !s.description);
    if (badProjectOnly) {
      setError(`"${badProjectOnly.name || badProjectOnly.address}" is set to Project Only but has no description. Add a brief description that names the specific project the agent should stay inside of, or change the sharing level.`);
      setSaving(false);
      return;
    }
    const primary = normalized.find(s => s.is_primary);

    // The list goes first, built on the text that was loaded. If the server says it moved, nothing else is written.
    const listText = JSON.stringify(normalized);
    const listResult = await api.setSetting('imessage_approved_senders', listText, baseRaw.current, { ownerChange: ownerChanged(baseList.current, normalized) });
    if (!listResult.ok) {
      setError(listResult.error || 'Failed to save settings');
      setSaving(false);
      await load();
      return;
    }
    baseRaw.current = listText;
    baseList.current = normalized.map(s => ({ ...s }));
    const results = await Promise.all([
      api.setSetting('imessage_enabled', enabled ? 'true' : 'false'),
      // Legacy fields stay in sync until every reader goes through the bridge
      // helpers, so older code paths and tools that read them directly keep working.
      api.setSetting('imessage_recipient', primary?.address ?? ''),
      api.setSetting('imessage_default_sender', primary?.address ?? ''),
    ]);

    if (results.every(r => r.ok)) {
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      cleanSnapshot.current = JSON.stringify({ enabled, senders });
      hooks.current.onDirtyChange?.(false);
      hooks.current.onSaved?.(enabled, primary?.address ?? '');
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
    // The first sender is the owner, so it is open_book whatever the dropdown says;
    // later senders honor the level chosen on the form.
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
    // The owner entry is removed only on purpose, and the star does not pass to anyone else.
    if (senders[index].is_primary && !confirmRemoveOwner(senders[index].name || senders[index].address)) return;
    setSenders(senders.filter((_, i) => i !== index));
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

  if (loadFailed) {
    return (
      <div className="tile space-y-4">
        <div className="scard__title">iMessage Bridge</div>
        <p className="text-xs text-cp-coral">
          Could not load your approved senders, so they can&apos;t be edited right now. Your saved list has not been changed.
        </p>
        <button type="button" onClick={() => { void load(); }} className="text-xs text-cp-amber hover:text-cp-amber/80">
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="tile space-y-4">
      <div>
        <div className="scard__title">iMessage Bridge</div>
        <div className="scard__desc">
          Enable to send and receive messages with your agent via iMessage. {fullDiskAccessWhy()}
        </div>
      </div>

      <div className="flex items-center justify-between">
        <label className="text-sm text-ui/70">Enable iMessage Bridge</label>
        <button
          type="button"
          aria-pressed={enabled}
          onClick={() => setEnabled(!enabled)}
          className={`switch ${enabled ? 'is-on' : ''}`}
        />
      </div>

      {enabled && (
        <div>
          <label className="form-label mb-2">
            Approved Senders
          </label>
          <p className="text-xs text-ui/25 mb-2">
            Each safe sender is a person (or another agent) your DOJO will accept iMessages from. Star the primary user; everyone else is a household member, friend, or another agent. The agent sees each sender's name and description in the inbound message and replies to them by default - so it can't mix up who's who.
          </p>

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

          {showAddInput ? (
            <div className="glass-nested rounded-xl px-3 py-3 space-y-2">
              <div className="space-y-1">
                <label className="text-xs text-ui/40 block">Phone number or Apple ID</label>
                <input
                  type="text"
                  value={newAddress}
                  onChange={(e) => setNewAddress(e.target.value)}
                  placeholder="+15551234567 or user@example.com"
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
                    onKeyDown={(e) => isEnterNotComposing(e) && addSender()}
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
          disabled={saving || saveDisabled}
          className="px-4 py-2 glass-btn-primary text-sm font-medium rounded-lg transition-colors"
        >
          {saving ? 'Saving...' : saveLabel(enabled)}
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
