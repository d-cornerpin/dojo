import { useEffect, useState } from 'react';
import * as api from '../lib/api';
import { useToast } from '../hooks/useToast';

// Credentials panel - rendered as a tab on the Memory (Vault) page. Lists
// every stored credential's metadata. Values are hidden by default; the
// "Show" button on a row hits the /reveal endpoint to decrypt. Add /
// edit / delete are inline.
//
// Credentials live in their own SQLite table with AES-256-GCM
// encryption (master key in secrets.yaml). They never decay and never
// appear in vault_search or Dreamer output.

export const CredentialsPanel = () => {
  const [credentials, setCredentials] = useState<api.CredentialSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [revealed, setRevealed] = useState<Record<string, Record<string, unknown>>>({});
  const [revealing, setRevealing] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const toast = useToast();

  const load = async () => {
    setLoading(true);
    const result = await api.listCredentials();
    if (result.ok) setCredentials(result.data.credentials);
    setLoading(false);
  };
  useEffect(() => { load(); }, []);

  const handleReveal = async (id: string) => {
    if (revealed[id]) {
      // Toggle off - hide the value.
      setRevealed(r => {
        const copy = { ...r };
        delete copy[id];
        return copy;
      });
      return;
    }
    setRevealing(id);
    const result = await api.revealCredential(id);
    setRevealing(null);
    if (!result.ok) {
      toast.error(`Reveal failed: ${result.error}`);
      return;
    }
    setRevealed(r => ({ ...r, [id]: result.data?.credentials ?? {} }));
  };

  const handleDelete = async (id: string, serviceName: string) => {
    if (!confirm(`Delete the credential for "${serviceName}"? This cannot be undone.`)) return;
    const result = await api.deleteCredential(id);
    if (!result.ok) {
      toast.error(`Delete failed: ${result.error}`);
      return;
    }
    toast.info(`Deleted "${serviceName}".`);
    setRevealed(r => {
      const copy = { ...r };
      delete copy[id];
      return copy;
    });
    load();
  };

  return (
    <div className="flex-1 overflow-y-auto p-4">
      <div className="max-w-4xl mx-auto space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="card-header">Agent Credentials</h3>
            <p className="text-xs text-ui/40 mt-1">
              API keys and tokens agents store for third-party services. Encrypted at rest. Never decays. Never appears in vault search or Dreamer output. The agent reads these via <code>credential_get</code> at API-call time.
            </p>
          </div>
          {!showAdd && (
            <button
              onClick={() => setShowAdd(true)}
              className="px-3 py-1.5 text-xs rounded-lg bg-cp-blue/20 text-cp-blue hover:bg-cp-blue/30 transition-colors"
            >
              + Add credential
            </button>
          )}
        </div>

        {showAdd && (
          <CredentialEditForm
            mode="create"
            onSaved={() => { setShowAdd(false); load(); }}
            onCancel={() => setShowAdd(false)}
          />
        )}

        {loading && <p className="text-xs text-ui/40 italic">Loading…</p>}

        {!loading && credentials.length === 0 && !showAdd && (
          <p className="text-sm text-ui/40 italic text-center py-8">
            No credentials stored yet. Agents add these via <code>credential_add</code> when the user provides API keys for techniques. You can also add one manually with the button above.
          </p>
        )}

        <div className="space-y-2">
          {credentials.map(c => {
            const isEditing = editing === c.id;
            return (
              <div key={c.id} className="glass-nested rounded-xl p-3 space-y-2">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-ui/90 font-mono truncate">{c.service_name}</span>
                      <span className="text-xs text-ui/25">|</span>
                      <span className="text-xs text-ui/40">accessed {c.access_count}× {c.last_accessed_at && `(last ${new Date(c.last_accessed_at).toLocaleString()})`}</span>
                    </div>
                    {c.description && <p className="text-xs text-ui/55 mt-1">{c.description}</p>}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={() => handleReveal(c.id)}
                      disabled={revealing === c.id}
                      className="px-2 py-1 text-xs rounded bg-ui/[0.06] hover:bg-ui/[0.12] transition-colors disabled:opacity-60"
                    >
                      {revealing === c.id ? '…' : revealed[c.id] ? 'Hide' : 'Show'}
                    </button>
                    <button
                      onClick={() => setEditing(isEditing ? null : c.id)}
                      className="px-2 py-1 text-xs rounded bg-ui/[0.06] hover:bg-ui/[0.12] transition-colors"
                    >
                      {isEditing ? 'Cancel' : 'Edit'}
                    </button>
                    <button
                      onClick={() => handleDelete(c.id, c.service_name)}
                      className="px-2 py-1 text-xs rounded text-cp-coral hover:bg-cp-coral/10 transition-colors"
                    >
                      Delete
                    </button>
                  </div>
                </div>

                {revealed[c.id] && (
                  <div className="bg-ui/[0.04] rounded p-2 font-mono text-xs space-y-1">
                    {Object.entries(revealed[c.id]).map(([k, v]) => (
                      <div key={k}>
                        <span className="text-ui/40">{k}:</span>{' '}
                        <span className="text-ui/90 break-all">{typeof v === 'string' ? v : JSON.stringify(v)}</span>
                      </div>
                    ))}
                  </div>
                )}

                {isEditing && (
                  <CredentialEditForm
                    mode="edit"
                    initial={{ service_name: c.service_name, description: c.description ?? '', credentials: revealed[c.id] ?? {} }}
                    credentialId={c.id}
                    onSaved={() => { setEditing(null); load(); }}
                    onCancel={() => setEditing(null)}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

interface CredentialEditFormProps {
  mode: 'create' | 'edit';
  initial?: { service_name: string; description: string; credentials: Record<string, unknown> };
  credentialId?: string;
  onSaved: () => void;
  onCancel: () => void;
}

// Inline form for add + edit. Credentials are entered as key/value rows
// (allows multi-field structures like {api_key, secret, workspace_id}).
const CredentialEditForm = ({ mode, initial, credentialId, onSaved, onCancel }: CredentialEditFormProps) => {
  const toast = useToast();
  const [serviceName, setServiceName] = useState(initial?.service_name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [fields, setFields] = useState<Array<{ key: string; value: string }>>(() => {
    const init = initial?.credentials ?? {};
    const entries = Object.entries(init).map(([k, v]) => ({ key: k, value: typeof v === 'string' ? v : JSON.stringify(v) }));
    return entries.length > 0 ? entries : [{ key: 'api_key', value: '' }];
  });
  const [saving, setSaving] = useState(false);

  const updateField = (i: number, key: 'key' | 'value', val: string) => {
    setFields(f => f.map((row, idx) => idx === i ? { ...row, [key]: val } : row));
  };
  const addField = () => setFields(f => [...f, { key: '', value: '' }]);
  const removeField = (i: number) => setFields(f => f.filter((_, idx) => idx !== i));

  const handleSave = async () => {
    setSaving(true);
    const credentials: Record<string, unknown> = {};
    for (const { key, value } of fields) {
      const k = key.trim();
      if (!k) continue;
      credentials[k] = value;
    }
    if (Object.keys(credentials).length === 0) {
      toast.error('At least one credential field is required.');
      setSaving(false);
      return;
    }
    const result = mode === 'create'
      ? await api.createCredential({ service_name: serviceName.trim(), credentials, description: description.trim() || null })
      : await api.updateCredentialApi(credentialId!, { credentials, description: description.trim() });
    setSaving(false);
    if (!result.ok) {
      toast.error(`Save failed: ${result.error}`);
      return;
    }
    toast.info(mode === 'create' ? 'Credential added.' : 'Credential updated.');
    onSaved();
  };

  return (
    <div className="glass-nested rounded-xl p-3 space-y-2 border border-cp-blue/20">
      {mode === 'create' && (
        <div className="space-y-1">
          <label className="text-xs text-ui/40 block">Service name</label>
          <input
            type="text"
            value={serviceName}
            onChange={(e) => setServiceName(e.target.value)}
            placeholder="e.g., openweather, github_pat, shopify"
            className="glass-input text-sm w-full font-mono"
          />
        </div>
      )}
      <div className="space-y-1">
        <label className="text-xs text-ui/40 block">Description</label>
        <input
          type="text"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What is this credential for?"
          className="glass-input text-sm w-full"
        />
      </div>
      <div className="space-y-1">
        <label className="text-xs text-ui/40 block">Credential fields</label>
        {fields.map((row, i) => (
          <div key={i} className="flex gap-2 items-center">
            <input
              type="text"
              value={row.key}
              onChange={(e) => updateField(i, 'key', e.target.value)}
              placeholder="field name (api_key, secret, etc.)"
              className="glass-input text-sm font-mono w-1/3"
            />
            <input
              type="text"
              value={row.value}
              onChange={(e) => updateField(i, 'value', e.target.value)}
              placeholder="value"
              className="glass-input text-sm font-mono flex-1"
            />
            {fields.length > 1 && (
              <button
                onClick={() => removeField(i)}
                className="text-ui/40 hover:text-cp-coral px-2"
                title="Remove field"
              >
                ×
              </button>
            )}
          </div>
        ))}
        <button
          onClick={addField}
          className="text-xs text-cp-blue hover:text-cp-blue/80"
        >
          + Add field
        </button>
      </div>
      <div className="flex gap-2 pt-1">
        <button
          onClick={handleSave}
          disabled={saving || (mode === 'create' && !serviceName.trim())}
          className="px-3 py-1.5 text-xs rounded glass-btn-primary disabled:opacity-50"
        >
          {saving ? 'Saving…' : mode === 'create' ? 'Save credential' : 'Update'}
        </button>
        <button
          onClick={onCancel}
          className="px-3 py-1.5 text-xs text-ui/55 hover:text-ui/90"
        >
          Cancel
        </button>
      </div>
    </div>
  );
};
