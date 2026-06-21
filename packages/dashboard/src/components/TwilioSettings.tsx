import { useEffect, useState, useCallback } from 'react';
import * as api from '../lib/api';
import { useToast } from '../hooks/useToast';
import { CollapseToggle, usePanelCollapse } from './CollapseToggle';

// Twilio channel card. Lives on the Channels tab (it's a messaging channel,
// like the iMessage bridge). A master-enable toggle gates the whole panel:
// when off, everything below collapses. When on, the connect flow appears
// ("paste Account SID + Auth Token, Test, Connect" — API-key auth, not OAuth),
// and once connected the card grows additional sections: feature toggles,
// numbers management, safe-sender lists for SMS + Voice, and webhook URLs to
// copy into the Twilio console.

export const TwilioSettings = () => {
  const toast = useToast();
  const [config, setConfig] = useState<api.TwilioConfigDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [sid, setSid] = useState('');
  const [token, setToken] = useState('');
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const { collapsed, toggle } = usePanelCollapse('channels.collapse.twilio');
  const isCollapsed = collapsed['twilio'] ?? true;

  const load = useCallback(async () => {
    setLoading(true);
    const r = await api.getTwilioConfigApi();
    if (r.ok) setConfig(r.data);
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const handleConnect = async () => {
    if (!sid.trim() || !token.trim()) {
      toast.error('Account SID and Auth Token are both required.');
      return;
    }
    setSaving(true);
    const r = await api.saveTwilioCredentialsApi(sid.trim(), token.trim());
    setSaving(false);
    if (!r.ok) {
      toast.error(`Twilio connect failed: ${r.error}`);
      return;
    }
    toast.success(`Twilio connected${r.data.friendlyName ? ` (${r.data.friendlyName})` : ''}.`);
    setToken('');
    void load();
  };

  const handleTest = async () => {
    setTesting(true);
    const r = await api.testTwilioConnectionApi(
      sid.trim() || undefined,
      token.trim() || undefined,
    );
    setTesting(false);
    if (!r.ok) {
      toast.error(`Test failed: ${r.error}`);
      return;
    }
    toast.info(`Twilio reachable${r.data.friendlyName ? ` (${r.data.friendlyName})` : ''}.`);
  };

  const handleDisconnect = async () => {
    if (!confirm('Disconnect Twilio? This clears the stored Auth Token and disables SMS/Voice. Numbers and safe-sender lists are kept so reconnecting restores them.')) return;
    setDisconnecting(true);
    const r = await api.clearTwilioCredentialsApi();
    setDisconnecting(false);
    if (!r.ok) {
      toast.error(`Disconnect failed: ${r.error}`);
      return;
    }
    toast.success('Twilio disconnected.');
    setSid('');
    setToken('');
    void load();
  };

  const handlePatch = async (patch: api.TwilioSettingsPatchDto) => {
    const r = await api.patchTwilioSettingsApi(patch);
    if (!r.ok) {
      toast.error(`Save failed: ${r.error}`);
      return;
    }
    setConfig(r.data);
  };

  if (loading || !config) {
    return (
      <div className="tile">
        <div className="flex items-center gap-2 mb-2">
          <h3 className="scard__title">Twilio</h3>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-cp-amber/20 text-cp-amber uppercase tracking-wide font-mono">Beta</span>
        </div>
        <p className="text-xs text-ui/40">Loading…</p>
      </div>
    );
  }

  return (
    <div className="tile space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h3 className="scard__title">Twilio</h3>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-cp-amber/20 text-cp-amber uppercase tracking-wide font-mono">Beta</span>
        </div>
        <div className="flex items-center gap-2">
          {config.configured && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-cp-teal/20 text-cp-teal">Connected</span>
          )}
          <CollapseToggle collapsed={isCollapsed} onClick={() => toggle('twilio')} label="Twilio" />
        </div>
      </div>

      {isCollapsed && (
        <div className="space-y-1.5">
          {config.configured ? (
            config.numbers.length > 0 ? (
              config.numbers.map(n => (
                <div key={n.number} className="flex items-center gap-2 text-sm text-ui/60">
                  <span className="w-1.5 h-1.5 rounded-full bg-cp-teal shrink-0" />
                  <span>{n.number}</span>
                  {n.isDefault && <span className="text-[10px] text-ui/30">default</span>}
                </div>
              ))
            ) : (
              <p className="text-xs text-ui/40">Connected · no numbers added yet</p>
            )
          ) : (
            <p className="text-xs text-ui/40">{config.enabled ? 'Enabled · not connected' : 'Not enabled'}</p>
          )}
        </div>
      )}

      {!isCollapsed && (
        <p className="text-xs text-ui/40">
          Twilio gives your agents two new channels: SMS (text the user, text people on their behalf, receive replies) and Voice (place + receive phone calls, real-time spoken conversation). Personal Twilio accounts only. No call recording.
        </p>
      )}

      {/* Master enable — mirrors the iMessage Bridge toggle. When off, the rest
          of the panel collapses. */}
      {!isCollapsed && (
        <div className="flex items-center justify-between">
          <label className="text-sm text-ui/70">Enable Twilio</label>
          <button
            type="button"
            aria-pressed={config.enabled}
            onClick={() => void handlePatch({ enabled: !config.enabled })}
            className={`switch ${config.enabled ? 'is-on' : ''}`}
          />
        </div>
      )}

      {!isCollapsed && config.enabled && (
        <>
          {!config.configured && (
            <ConnectForm
              sid={sid}
              token={token}
              onChangeSid={setSid}
              onChangeToken={setToken}
              onTest={handleTest}
              onConnect={handleConnect}
              testing={testing}
              saving={saving}
            />
          )}

          {config.configured && (
            <>
              <div className="text-sm text-ui/80">
                Account SID: <code className="text-xs">{config.accountSid?.slice(0, 12)}…</code>
                <button
                  onClick={handleDisconnect}
                  disabled={disconnecting}
                  className="ml-3 px-2 py-0.5 text-[11px] glass-btn rounded transition-colors disabled:opacity-60"
                >
                  {disconnecting ? 'Disconnecting…' : 'Disconnect'}
                </button>
              </div>

              <FeatureToggles config={config} onPatch={handlePatch} />
              <NumbersSection config={config} reload={load} />
              <VoiceSettingsSection config={config} onPatch={handlePatch} />
              <SafeSenderSection kind="sms" />
              <SafeSenderSection kind="voice" />
              <WebhookSection config={config} />
            </>
          )}
        </>
      )}
    </div>
  );
};

// ── Subcomponents ──

const ConnectForm = ({
  sid, token, onChangeSid, onChangeToken, onTest, onConnect, testing, saving,
}: {
  sid: string; token: string;
  onChangeSid: (v: string) => void; onChangeToken: (v: string) => void;
  onTest: () => void; onConnect: () => void;
  testing: boolean; saving: boolean;
}) => (
  <div className="space-y-2">
    <FieldRow label="Account SID">
      <input
        value={sid}
        onChange={e => onChangeSid(e.target.value)}
        placeholder="ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
        className="glass-input w-full font-mono text-xs"
        autoComplete="off"
      />
    </FieldRow>
    <FieldRow label="Auth Token">
      <input
        type="password"
        value={token}
        onChange={e => onChangeToken(e.target.value)}
        placeholder="••••••••"
        className="glass-input w-full font-mono text-xs"
        autoComplete="new-password"
      />
    </FieldRow>
    <div className="flex items-center gap-2 pt-1">
      <button
        onClick={onTest}
        disabled={testing || !sid.trim() || !token.trim()}
        className="px-3 py-1.5 glass-btn text-xs rounded-lg transition-colors disabled:opacity-50"
      >
        {testing ? 'Testing…' : 'Test'}
      </button>
      <button
        onClick={onConnect}
        disabled={saving || !sid.trim() || !token.trim()}
        className="px-3 py-1.5 glass-btn-primary text-xs rounded-lg transition-colors disabled:opacity-50"
      >
        {saving ? 'Connecting…' : 'Connect'}
      </button>
    </div>
    <p className="text-[11px] text-ui/40">
      Find your credentials at <a href="https://console.twilio.com" target="_blank" rel="noopener noreferrer" className="text-cp-teal hover:text-cp-teal/80 underline">console.twilio.com</a>. The Auth Token is encrypted at rest using the credentials master key.
    </p>
  </div>
);

const FeatureToggles = ({ config, onPatch }: { config: api.TwilioConfigDto; onPatch: (p: api.TwilioSettingsPatchDto) => void }) => (
  <div className="border-t border-ui/[0.06] pt-3 space-y-2">
    <h4 className="text-xs font-medium text-ui/70 uppercase tracking-wider">Features</h4>
    <ToggleRow
      label="SMS"
      hint="Inbound + outbound text messages."
      checked={config.smsEnabled}
      onChange={v => onPatch({ smsEnabled: v })}
    />
    <ToggleRow
      label="Voice calls"
      hint="Inbound + outbound phone calls with real-time speech."
      checked={config.voiceEnabled}
      onChange={v => onPatch({ voiceEnabled: v })}
    />
  </div>
);

const NumbersSection = ({ config, reload }: { config: api.TwilioConfigDto; reload: () => Promise<void> }) => {
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [newNumber, setNewNumber] = useState('');
  const [newLabel, setNewLabel] = useState('');

  const handleAdd = async () => {
    if (!newNumber.trim()) return;
    setAdding(true);
    const r = await api.upsertTwilioNumberApi(newNumber.trim(), {
      label: newLabel.trim() || null,
      is_default: config.numbers.length === 0,
    });
    setAdding(false);
    if (!r.ok) { toast.error(`Add failed: ${r.error}`); return; }
    setNewNumber(''); setNewLabel('');
    void reload();
  };

  const handleRemove = async (number: string) => {
    if (!confirm(`Remove ${number}?`)) return;
    const r = await api.removeTwilioNumberApi(number);
    if (!r.ok) { toast.error(`Remove failed: ${r.error}`); return; }
    void reload();
  };

  const handleSetDefault = async (number: string) => {
    const r = await api.upsertTwilioNumberApi(number, { is_default: true });
    if (!r.ok) { toast.error(`Save failed: ${r.error}`); return; }
    void reload();
  };

  const handleToggleSms = async (number: string, smsEnabled: boolean) => {
    const r = await api.upsertTwilioNumberApi(number, { sms_enabled: smsEnabled });
    if (!r.ok) { toast.error(`Save failed: ${r.error}`); return; }
    void reload();
  };

  const handleToggleVoice = async (number: string, voiceEnabled: boolean) => {
    const r = await api.upsertTwilioNumberApi(number, { voice_enabled: voiceEnabled });
    if (!r.ok) { toast.error(`Save failed: ${r.error}`); return; }
    void reload();
  };

  return (
    <div className="border-t border-ui/[0.06] pt-3 space-y-2">
      <h4 className="text-xs font-medium text-ui/70 uppercase tracking-wider">Phone numbers</h4>
      <p className="text-[11px] text-ui/40">
        Add the Twilio phone numbers you own. Format: E.164 (+15551234567). Each number can independently allow SMS / Voice.
      </p>
      {config.numbers.length === 0 && (
        <p className="text-xs text-ui/40 italic">No numbers configured yet.</p>
      )}
      {config.numbers.length > 0 && (
        <div className="space-y-1">
          {config.numbers.map(n => (
            <div key={n.number} className="flex items-center gap-2 px-2 py-1.5 rounded bg-ui/[0.03] text-xs">
              <span className="font-mono">{n.number}</span>
              {n.label && <span className="text-ui/55">· {n.label}</span>}
              {n.isDefault ? (
                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-cp-teal/20 text-cp-teal">default</span>
              ) : (
                <button onClick={() => handleSetDefault(n.number)} className="text-[10px] text-ui/40 hover:text-ui/80">make default</button>
              )}
              <label className="ml-auto flex items-center gap-1 text-[10px] text-ui/55">
                <input type="checkbox" checked={n.smsEnabled} onChange={e => handleToggleSms(n.number, e.target.checked)} />
                SMS
              </label>
              <label className="flex items-center gap-1 text-[10px] text-ui/55">
                <input type="checkbox" checked={n.voiceEnabled} onChange={e => handleToggleVoice(n.number, e.target.checked)} />
                Voice
              </label>
              <button onClick={() => handleRemove(n.number)} className="text-[10px] text-red-400 hover:text-red-300">×</button>
            </div>
          ))}
        </div>
      )}
      <div className="flex items-end gap-2 pt-1">
        <div className="flex-1">
          <span className="block text-[10px] text-ui/40 mb-1">New number</span>
          <input
            value={newNumber}
            onChange={e => setNewNumber(e.target.value)}
            placeholder="+15551234567"
            className="glass-input w-full font-mono text-xs"
          />
        </div>
        <div className="flex-1">
          <span className="block text-[10px] text-ui/40 mb-1">Label (optional)</span>
          <input
            value={newLabel}
            onChange={e => setNewLabel(e.target.value)}
            placeholder="e.g. main, work"
            className="glass-input w-full text-xs"
          />
        </div>
        <button
          onClick={handleAdd}
          disabled={adding || !newNumber.trim()}
          className="px-3 py-1.5 glass-btn text-xs rounded transition-colors disabled:opacity-50"
        >
          {adding ? '…' : 'Add'}
        </button>
      </div>
    </div>
  );
};

const VoiceSettingsSection = ({ config, onPatch }: { config: api.TwilioConfigDto; onPatch: (p: api.TwilioSettingsPatchDto) => Promise<void> }) => (
  <div className="border-t border-ui/[0.06] pt-3 space-y-2">
    <h4 className="text-xs font-medium text-ui/70 uppercase tracking-wider">Voice settings</h4>
    <FieldRow label="Unknown caller action">
      <select
        value={config.voiceUnknownCallerAction}
        onChange={e => onPatch({ voiceUnknownCallerAction: e.target.value as 'reject' | 'voicemail' | 'agent' })}
        className="glass-select text-xs"
      >
        <option value="reject">Reject (drop the call)</option>
        <option value="voicemail">Voicemail (greeting + transcribe message)</option>
        <option value="agent">Connect to agent (anyone can reach Kevin)</option>
      </select>
    </FieldRow>
    <FieldRow label="Max call duration (minutes)">
      <input
        type="number"
        min={1}
        max={120}
        value={config.voiceMaxMinutesPerCall}
        onChange={e => onPatch({ voiceMaxMinutesPerCall: Number(e.target.value) })}
        className="glass-input w-24 text-xs"
      />
    </FieldRow>
    {config.voiceUnknownCallerAction === 'voicemail' && (
      <FieldRow label="Voicemail greeting">
        <textarea
          value={config.voiceVoicemailGreeting}
          onChange={e => onPatch({ voiceVoicemailGreeting: e.target.value })}
          rows={3}
          className="glass-textarea w-full text-xs"
        />
      </FieldRow>
    )}
  </div>
);

const SafeSenderSection = ({ kind }: { kind: 'sms' | 'voice' }) => {
  const toast = useToast();
  const [list, setList] = useState<api.TwilioSafeSenderDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState('');
  const [newAddress, setNewAddress] = useState('');

  const reload = useCallback(async () => {
    setLoading(true);
    const r = kind === 'sms' ? await api.listTwilioSmsSafeSendersApi() : await api.listTwilioVoiceSafeCallersApi();
    if (r.ok) setList(r.data);
    setLoading(false);
  }, [kind]);

  useEffect(() => { void reload(); }, [reload]);

  const handleAdd = async () => {
    if (!newName.trim() || !newAddress.trim()) return;
    const r = kind === 'sms'
      ? await api.addTwilioSmsSafeSenderApi({ name: newName.trim(), address: newAddress.trim() })
      : await api.addTwilioVoiceSafeCallerApi({ name: newName.trim(), address: newAddress.trim() });
    if (!r.ok) { toast.error(`Add failed: ${r.error}`); return; }
    if (!r.data.added) toast.info('Already on the list.');
    setNewName(''); setNewAddress('');
    void reload();
  };

  const handleRemove = async (address: string) => {
    const r = kind === 'sms' ? await api.removeTwilioSmsSafeSenderApi(address) : await api.removeTwilioVoiceSafeCallerApi(address);
    if (!r.ok) { toast.error(`Remove failed: ${r.error}`); return; }
    void reload();
  };

  return (
    <div className="border-t border-ui/[0.06] pt-3 space-y-2">
      <h4 className="text-xs font-medium text-ui/70 uppercase tracking-wider">
        {kind === 'sms' ? 'SMS safe-sender allowlist' : 'Voice safe-caller allowlist'}
      </h4>
      <p className="text-[11px] text-ui/40">
        {kind === 'sms'
          ? 'Phone numbers the agent is authorized to text proactively, and to auto-reply to when they text the owner. Format: E.164 (+15551234567). Unknown senders arrive as notifications; the agent decides whether to surface or ignore.'
          : 'Phone numbers the agent will pick up calls from when the unknown-caller policy is set to "Connect to agent" or "Voicemail". Without this allowlist, all unknown callers follow the unknown-caller policy.'}
      </p>
      {loading && <p className="text-xs text-ui/40 italic">Loading…</p>}
      {!loading && list.length === 0 && <p className="text-xs text-ui/40 italic">Empty.</p>}
      {!loading && list.length > 0 && (
        <div className="space-y-1">
          {list.map(s => (
            <div key={s.address} className="flex items-center gap-2 px-2 py-1.5 rounded bg-ui/[0.03] text-xs">
              <span>{s.name}</span>
              <span className="font-mono text-ui/55">{s.address}</span>
              {s.is_primary && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-cp-blue/20 text-cp-blue">primary</span>}
              <button onClick={() => handleRemove(s.address)} className="ml-auto text-[10px] text-red-400 hover:text-red-300">×</button>
            </div>
          ))}
        </div>
      )}
      <div className="flex items-end gap-2 pt-1">
        <div className="flex-1">
          <span className="block text-[10px] text-ui/40 mb-1">Name</span>
          <input
            value={newName}
            onChange={e => setNewName(e.target.value)}
            placeholder="e.g. Crystal"
            className="glass-input w-full text-xs"
          />
        </div>
        <div className="flex-1">
          <span className="block text-[10px] text-ui/40 mb-1">Number</span>
          <input
            value={newAddress}
            onChange={e => setNewAddress(e.target.value)}
            placeholder="+15551234567"
            className="glass-input w-full font-mono text-xs"
          />
        </div>
        <button
          onClick={handleAdd}
          disabled={!newName.trim() || !newAddress.trim()}
          className="px-3 py-1.5 glass-btn text-xs rounded transition-colors disabled:opacity-50"
        >
          Add
        </button>
      </div>
    </div>
  );
};

const WebhookSection = ({ config }: { config: api.TwilioConfigDto }) => {
  const toast = useToast();
  const copy = async (url: string, label: string) => {
    try {
      await navigator.clipboard.writeText(url);
      toast.info(`${label} URL copied.`);
    } catch {
      toast.error('Clipboard copy failed.');
    }
  };
  return (
    <div className="border-t border-ui/[0.06] pt-3 space-y-2">
      <h4 className="text-xs font-medium text-ui/70 uppercase tracking-wider">Webhook URLs</h4>
      <p className="text-[11px] text-ui/40">
        Paste these into the corresponding fields on each Twilio number's configuration page in the console. The URLs are derived from the active Cloudflare tunnel.
      </p>
      {config.webhookError && (
        <p className="text-xs text-amber-400">{config.webhookError}</p>
      )}
      {config.webhooks && (
        <div className="space-y-1.5">
          <WebhookRow label="SMS inbound (Messaging → A MESSAGE COMES IN)" url={config.webhooks.sms} onCopy={url => copy(url, 'SMS')} />
          <WebhookRow label="Voice inbound (Voice → A CALL COMES IN)" url={config.webhooks.voice} onCopy={url => copy(url, 'Voice')} />
          <WebhookRow label="Voice status callback (Voice → CALL STATUS CHANGES)" url={config.webhooks.voiceStatus} onCopy={url => copy(url, 'Voice status')} />
        </div>
      )}
    </div>
  );
};

const WebhookRow = ({ label, url, onCopy }: { label: string; url: string; onCopy: (u: string) => void }) => (
  <div className="text-xs space-y-1">
    <div className="text-ui/55">{label}</div>
    <div className="flex items-center gap-2">
      <code className="flex-1 px-2 py-1 rounded bg-ui/[0.04] text-[10px] font-mono break-all">{url}</code>
      <button onClick={() => onCopy(url)} className="px-2 py-1 glass-btn text-[10px] rounded transition-colors">Copy</button>
    </div>
  </div>
);

const ToggleRow = ({ label, hint, checked, onChange, disabled }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) => (
  <label className={`flex items-start gap-3 ${disabled ? 'opacity-50' : ''}`}>
    <input
      type="checkbox"
      checked={checked}
      onChange={e => onChange(e.target.checked)}
      disabled={disabled}
      className="mt-0.5"
    />
    <div className="flex-1">
      <div className="text-xs text-ui">{label}</div>
      {hint && <div className="text-[11px] text-ui/40">{hint}</div>}
    </div>
  </label>
);

const FieldRow = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <label className="block">
    <span className="block text-[10px] text-ui/55 uppercase tracking-wider mb-1">{label}</span>
    {children}
  </label>
);
