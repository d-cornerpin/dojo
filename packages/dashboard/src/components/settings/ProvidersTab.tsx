// ── Settings → The Providers tab: the provider list, the add/edit forms and the patience fields.

import { useState, useEffect, type FormEvent } from 'react';
import type { Provider, EditProviderRequest } from '@dojo/shared';
import * as api from '../../lib/api';
import { useToast } from '../../hooks/useToast';
import {
  numberEditsFor, numInput,
  THROUGHPUT_MIN_TOK_PER_SEC, THROUGHPUT_MAX_TOK_PER_SEC,
} from '../../lib/provider-edits';
import { AgentSdkSetup } from './PlatformTab';


export const ProvidersTab = () => {
  const toast = useToast();
  const [providers, setProviders] = useState<Provider[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);

  const loadProviders = async () => {
    const result = await api.getProviders();
    if (result.ok) setProviders(result.data);
    setLoading(false);
  };

  useEffect(() => {
    loadProviders();
  }, []);

  const [syncing, setSyncing] = useState<string | null>(null);
  // One provider is open for editing at a time. Held here rather than inside the row so
  // that opening a second edit closes the first, instead of leaving two half-typed forms.
  const [editingId, setEditingId] = useState<string | null>(null);

  const handleDelete = async (id: string) => {
    const modelsResult = await api.getModels();
    const providerModelIds = modelsResult.ok
      ? (modelsResult.data as Array<{ id: string; providerId: string }>).filter(m => m.providerId === id).map(m => m.id)
      : [];

    let warning = 'Delete this provider? This will also remove its models.';
    if (providerModelIds.length > 0) {
      const usage = await api.checkModelUsage(providerModelIds);
      if (usage.ok && usage.data.usages.length > 0) {
        const affected = usage.data.usages.flatMap(u => u.usedBy.map((a: { name: string }) => a.name));
        const unique = [...new Set(affected)];
        warning += `\n\nCurrently used by: ${unique.join(', ')}. They will be left with no model until you pick a new one.`;
      }
    }

    if (!confirm(warning)) return;
    const result = await api.deleteProvider(id);
    if (result.ok) {
      setProviders((prev) => prev.filter((p) => p.id !== id));
    } else {
      toast.error(result.error ?? 'The provider could not be deleted.');
    }
  };

  const handleSyncModels = async (id: string) => {
    setSyncing(id);
    try {
      const result = await api.validateProvider(id);
      if (!result.ok) toast.error(result.error ?? 'The sync did not work.');
      else await loadProviders();
    } finally {
      setSyncing(null);
    }
  };

  if (loading) return <div className="loading-state">Loading...</div>;

  return (
    <div className="space-y-4 max-w-4xl">
      {providers.length === 0 ? (
        <p className="text-ui/40 text-sm">No providers configured.</p>
      ) : (
        <div className="space-y-3">
          {providers.map((provider) => (
            <div key={provider.id} className="tile">
            <div className="flex items-start justify-between gap-3">
              {/* min-w-0 / shrink-0: the meta line wraps instead of pushing into the buttons. */}
              <div className="min-w-0">
                <h3 className="text-sm font-medium text-ui">{provider.name}</h3>
                <p className="text-xs text-ui/40 mt-0.5">
                  {/* 'none' is a real stored auth type (Ollama, local servers): it reads "No key". */}
                  {provider.type} &middot; {provider.authType === 'agent-sdk' ? 'Agent SDK' : provider.authType === 'oauth' ? 'OAuth' : provider.authType === 'none' ? 'No key' : 'API Key'}
                  {provider.behavesLike ? ` · behaves like ${provider.behavesLike}` : ''} {provider.isValidated ? '(validated)' : '(not validated)'}
                  {/* Patience is still readable at a glance here: its editor lives in Edit now. */}
                  {(provider.firstChunkTimeoutMs !== null || provider.streamIdleTimeoutMs !== null) && (
                    <span className="text-cp-teal">
                      {' '}· waits {msToSecInput(provider.firstChunkTimeoutMs) || STANDARD_FIRST_CHUNK_SEC}s for the
                      first word, {msToSecInput(provider.streamIdleTimeoutMs) || STANDARD_IDLE_SEC}s during
                    </span>
                  )}
                </p>
              </div>
              {/* The row's actions are real buttons: `btn btn--sm` is the page's own pill
                  (cursor, hover lift, focus ring), so nothing new is invented here. */}
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => setEditingId(editingId === provider.id ? null : provider.id)}
                  className="btn btn--sm"
                  aria-expanded={editingId === provider.id}
                >
                  {editingId === provider.id ? 'Close' : 'Edit'}
                </button>
                <button
                  type="button"
                  onClick={() => handleSyncModels(provider.id)}
                  disabled={syncing === provider.id}
                  className="btn btn--sm"
                >
                  {syncing === provider.id ? 'Syncing…' : 'Sync Models and Pricing'}
                </button>
                <button
                  type="button"
                  onClick={() => handleDelete(provider.id)}
                  className="btn btn--sm btn--danger"
                >
                  Delete
                </button>
              </div>
            </div>
            {/* The edit exists because this box is already a provider: changing its name, its
                URL or one timeout should not mean delete and re-add. */}
            {editingId === provider.id && (
              <ProviderEditForm
                provider={provider}
                onSaved={() => { loadProviders(); setEditingId(null); }}
                onCancel={() => setEditingId(null)}
              />
            )}
            </div>
          ))}
        </div>
      )}

      {showAdd ? (
        <AddProviderForm
          onAdded={() => {
            loadProviders();
            setShowAdd(false);
          }}
          onCreated={() => { loadProviders(); }}
          onCancel={() => setShowAdd(false)}
        />
      ) : (
        <button
          type="button"
          onClick={() => setShowAdd(true)}
          className="btn btn--primary"
        >
          Add Provider
        </button>
      )}
    </div>
  );
};

// Dialects a MANUAL endpoint can declare it behaves like; the values are the
// capability-contract profile ids, and the create route validates against the same list.
const BEHAVES_LIKE_CHOICES = [
  {
    value: 'generic-openai-compatible',
    label: 'Generic OpenAI-compatible',
    hint: 'Plain chat completions. Pick this unless the model below is listed.',
  },
  {
    value: 'deepseek-native',
    label: 'DeepSeek (e.g. a local DeepSeek V4)',
    hint: "Hands the model its own reasoning back on tool-call turns, sends DeepSeek's thinking switch, and drops temperature/top-p while it is thinking.",
  },
  {
    value: 'openrouter-proxy',
    label: 'OpenRouter-style proxy',
    hint: 'A gateway in front of other models: unified reasoning switch, explicit prompt-cache marker.',
  },
] as const;

// Response patience bounds, restated from the server's own (`agent/stream-patience.ts`) in
// the unit the field is typed in: seconds in the form, milliseconds in the column.
const PATIENCE_MIN_SEC = 10;
const PATIENCE_MAX_SEC = 30 * 60;
const STANDARD_FIRST_CHUNK_SEC = 90;
const STANDARD_IDLE_SEC = 60;

/** Typed seconds → milliseconds for the wire. `''` is "declare nothing" (null). */
type PatienceParse = { ok: true; ms: number | null } | { ok: false; error: string };
const parsePatienceSeconds = (raw: string, label: string): PatienceParse => {
  const trimmed = raw.trim();
  if (trimmed === '') return { ok: true, ms: null };
  const n = Number(trimmed);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    return { ok: false, error: `${label} must be a whole number of seconds` };
  }
  if (n < PATIENCE_MIN_SEC || n > PATIENCE_MAX_SEC) {
    return { ok: false, error: `${label} must be between ${PATIENCE_MIN_SEC} seconds and ${PATIENCE_MAX_SEC / 60} minutes` };
  }
  return { ok: true, ms: n * 1000 };
};

const msToSecInput = (ms: number | null): string => (ms === null ? '' : String(Math.round(ms / 1000)));

/** What the engine worked out for itself, shown as information with no write door: a field
 *  that let someone edit a measurement would turn it straight back into a declaration. */
const MeasuredReadingSpeed = ({ provider }: { provider: Provider }) => {
  const measured = provider.measuredPrefillTokensPerSec;
  if (measured === null) return null;
  // The reader (`agent/stream-patience.ts`) floors this and re-checks it against the same
  // 1-100,000 bounds a declared value must satisfy, so a reading outside them is IGNORED by
  // the engine; showing one would advertise a number nothing uses.
  if (Math.floor(measured) < THROUGHPUT_MIN_TOK_PER_SEC || measured > THROUGHPUT_MAX_TOK_PER_SEC) return null;
  return (
    <p className="text-[11px] text-cp-teal/70 mt-1">
      Measured reading speed: ~{Math.floor(measured)} tokens/sec.
      Worked out from this machine's own recent calls, you do not need to fill anything in.
    </p>
  );
};

/** The two fields, shared by the add form and the per-provider editor so they cannot drift. */
const PatienceFields = ({
  firstChunkSec, idleSec, onFirstChunk, onIdle, disabled,
}: {
  firstChunkSec: string; idleSec: string;
  onFirstChunk: (v: string) => void; onIdle: (v: string) => void; disabled?: boolean;
}) => (
  <>
    <div className="fgrid" style={{ marginBottom: 0 }}>
      <div>
        <label className="flabel">Wait for the first word</label>
        <input
          type="number" step="1" min={PATIENCE_MIN_SEC} max={PATIENCE_MAX_SEC}
          placeholder={`${STANDARD_FIRST_CHUNK_SEC} (standard)`}
          value={firstChunkSec}
          onChange={(e) => onFirstChunk(e.target.value)}
          disabled={disabled}
          className="finput disabled:opacity-60"
        />
        <p className="text-[11px] text-ui/40 mt-1">
          Seconds. A model running on your own machine reads the whole prompt before it can say
          anything, and on a long one that can take several minutes, far past the{' '}
          {STANDARD_FIRST_CHUNK_SEC}-second standard, which was set for services on the
          internet. Raise this if long messages fail but short ones work.
        </p>
      </div>
      <div>
        <label className="flabel">Wait during an answer</label>
        <input
          type="number" step="1" min={PATIENCE_MIN_SEC} max={PATIENCE_MAX_SEC}
          placeholder={`${STANDARD_IDLE_SEC} (standard)`}
          value={idleSec}
          onChange={(e) => onIdle(e.target.value)}
          disabled={disabled}
          className="finput disabled:opacity-60"
        />
        <p className="text-[11px] text-ui/40 mt-1">
          Seconds of silence allowed <em>after</em> the answer has started. This one catches a
          dead connection, so leave it alone unless a slow machine is stopping mid-answer.
        </p>
      </div>
    </div>
    <p className="text-[11px] text-ui/25 italic">
      Leave both blank to use the standard {STANDARD_FIRST_CHUNK_SEC}s / {STANDARD_IDLE_SEC}s.
      Anything from {PATIENCE_MIN_SEC} seconds to {PATIENCE_MAX_SEC / 60} minutes is allowed.
    </p>
  </>
);

// THE PER-PROVIDER EDITOR. `PATCH /providers/:id` writes only the fields it is given, and this
// form only gives it the fields the user altered; patience keeps its own narrow door and the
// identity fields have theirs, so neither rewrites the other and the user still sees one Save.
const ProviderEditForm = ({ provider, onSaved, onCancel }: {
  provider: Provider; onSaved: () => void; onCancel: () => void;
}) => {
  // The pair is offered only where the stream watchdog actually arms: Ollama bounds its call
  // with a single 5-minute fetch timeout and the Agent SDK transport has no watchdog at all.
  const armsTheWatchdog = provider.type !== 'ollama' && provider.authType !== 'agent-sdk';
  // The dialect is only ambiguous behind an OpenAI-compatible URL, which is the whole reason
  // it is declarable here. Anthropic, OpenAI and Ollama each speak one known dialect.
  const canDeclareDialect = provider.type === 'openai-compatible';
  // A provider with no base URL of its own (Anthropic direct) has nothing to point elsewhere.
  const hasEndpoint = provider.type !== 'anthropic' || provider.baseUrl !== null;
  // Ollama takes no key, and the Agent SDK signs in through the CLI rather than a stored one.
  const canRotateKey = provider.type !== 'ollama' && provider.authType !== 'agent-sdk';

  const [name, setName] = useState(provider.name);
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl ?? '');
  // '' is "declare nothing and go back to reading the URL", which is what the column's NULL
  // means; a provider with no stored dialect holds that.
  const [behavesLike, setBehavesLike] = useState(provider.behavesLike ?? '');
  // Never pre-filled: the server does not send the stored key to the client and must not.
  // Blank therefore means KEEP, and the help text under the field says exactly that.
  const [credential, setCredential] = useState('');
  // The fold opens by itself when ANY of the advanced numbers is already set: a value the user
  // cannot see is a value they cannot check, and this fold holds three of them.
  const [showPatience, setShowPatience] = useState(
    provider.firstChunkTimeoutMs !== null || provider.streamIdleTimeoutMs !== null
    || provider.prefillTokensPerSec !== null,
  );
  const [firstChunkSec, setFirstChunkSec] = useState(msToSecInput(provider.firstChunkTimeoutMs));
  const [idleSec, setIdleSec] = useState(msToSecInput(provider.streamIdleTimeoutMs));
  // '' is "say nothing": for reading speed that means "use whatever the engine measured", not a
  // number the user has to supply.
  const [tokensPerSec, setTokensPerSec] = useState(numInput(provider.prefillTokensPerSec));
  const [status, setStatus] = useState<'idle' | 'saving' | 'validating' | 'valid' | 'invalid'>('idle');
  const [error, setError] = useState<string | null>(null);

  const busy = status === 'saving' || status === 'validating';

  const handleSave = async (): Promise<void> => {
    setError(null);
    if (!name.trim()) { setError('A provider needs a name'); return; }

    const first = parsePatienceSeconds(firstChunkSec, 'The wait for the first word');
    const idle = parsePatienceSeconds(idleSec, 'The wait during an answer');
    // The only-what-moved rule for the narrow-door number, decided in `lib/provider-edits.ts`
    // where it can be argued with in a test rather than only observed in a browser.
    const numbers = numberEditsFor(provider, { tokensPerSec });
    if (!first.ok) { setError(first.error); setShowPatience(true); return; }
    if (!idle.ok) { setError(idle.error); setShowPatience(true); return; }
    if (!numbers.ok) { setError(numbers.error); setShowPatience(true); return; }

    // ONLY WHAT MOVED. This is the client half of the anti-trap: a field the user did not
    // touch is not mentioned, so there is no request in which it could be cleared.
    const edit: EditProviderRequest = {};
    if (name.trim() !== provider.name) edit.name = name.trim();
    if (hasEndpoint && (baseUrl.trim() || null) !== provider.baseUrl) {
      edit.baseUrl = baseUrl.trim() || null;
    }
    if (canDeclareDialect && (behavesLike || null) !== provider.behavesLike) {
      edit.behavesLike = behavesLike || null;
    }
    if (canRotateKey && credential.trim()) edit.credential = credential.trim();

    const patienceMoved = armsTheWatchdog && (
      first.ms !== provider.firstChunkTimeoutMs || idle.ms !== provider.streamIdleTimeoutMs
    );
    // Reading speed has its own narrow door and its own flag, for the patience pair's reason:
    // the server REFUSES the field by name on the identity door, so it can never ride along in
    // `edit`, and a number the user did not touch must not be mentioned to its door: sending an
    // untouched value back is how a blank clears a number nobody meant to clear. An ABSENT key
    // is "do not call this door"; a `null` key is "call it and clear the number".
    const speedMoved = 'prefillTokensPerSec' in numbers.edits;

    if (Object.keys(edit).length === 0 && !patienceMoved && !speedMoved) {
      onCancel(); return;
    }

    setStatus('saving');
    if (patienceMoved) {
      const p = await api.updateProviderResponsePatience(provider.id, {
        firstChunkTimeoutMs: first.ms, streamIdleTimeoutMs: idle.ms,
      });
      if (!p.ok) { setError(p.error); setStatus('idle'); return; }
    }
    if (speedMoved) {
      const s = await api.updateProviderPrefillThroughput(provider.id, numbers.edits.prefillTokensPerSec ?? null);
      if (!s.ok) { setError(s.error); setStatus('idle'); return; }
    }

    let revalidationRequired = false;
    if (Object.keys(edit).length > 0) {
      const result = await api.updateProvider(provider.id, edit);
      if (!result.ok) { setError(result.error); setStatus('idle'); return; }
      revalidationRequired = result.revalidationRequired === true;
    }

    // The badge the server cleared is a claim about a connection nobody has tried yet, so save,
    // then run the EXISTING validate route as a separate call: a write door that reached out to
    // a local box would hold the user's Save open for as long as that box takes to time out.
    if (!revalidationRequired) { onSaved(); return; }
    setStatus('validating');
    const valResult = await api.validateProvider(provider.id);
    if (valResult.ok && valResult.data.valid) {
      setStatus('valid');
      setTimeout(() => onSaved(), 800);
    } else {
      setStatus('invalid');
      setError(`Saved, but the connection did not answer: ${!valResult.ok ? valResult.error : 'unexpected result'}`);
    }
  };

  return (
    <div className="glass-nested rounded-xl p-3 mt-3 space-y-3">
      <div className="fgrid" style={{ marginBottom: 0 }}>
        <div>
          <label className="flabel">Name</label>
          <input
            type="text" value={name} onChange={(e) => setName(e.target.value)}
            disabled={busy} className="finput disabled:opacity-60"
          />
          <p className="text-[11px] text-ui/40 mt-1">
            What you call it. Nothing else uses it, models, keys and assignments all follow the
            provider itself, so renaming is safe.
          </p>
        </div>
        <div>
          <label className="flabel">Type</label>
          <input type="text" value={provider.type} disabled readOnly className="finput opacity-60" />
          <p className="text-[11px] text-ui/40 mt-1">
            Can't be changed, a different type is a different provider. Delete this one and add
            it again.
          </p>
        </div>
      </div>

      {hasEndpoint && (
        <div>
          <label className="flabel">Base URL</label>
          <input
            type="text" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="http://localhost:8000/v1"
            disabled={busy} className="finput disabled:opacity-60"
          />
          <p className="text-[11px] text-ui/40 mt-1">
            Change this if the machine moved. Saving a new URL re-checks the connection.
          </p>
        </div>
      )}

      {canDeclareDialect && (
        <div>
          <label className="flabel">Behaves like</label>
          <select
            value={behavesLike} onChange={(e) => setBehavesLike(e.target.value)}
            disabled={busy} className="finput field--select disabled:opacity-60"
          >
            <option value="">Decide from the URL (default)</option>
            {BEHAVES_LIKE_CHOICES.map(choice => (
              <option key={choice.value} value={choice.value}>{choice.label}</option>
            ))}
          </select>
          <p className="text-[11px] text-ui/40 mt-1">
            {BEHAVES_LIKE_CHOICES.find(ch => ch.value === behavesLike)?.hint
              ?? 'Reads the dialect off the address, which is right for every hosted service. Declare one when the address cannot say, a local server.'}
          </p>
        </div>
      )}

      {canRotateKey && (
        <div>
          <label className="flabel">API Key</label>
          <input
            type="password" value={credential} onChange={(e) => setCredential(e.target.value)}
            placeholder="Leave blank to keep the key you already saved"
            disabled={busy} className="finput disabled:opacity-60"
          />
          <p className="text-[11px] text-ui/40 mt-1">
            A saved key is never shown back to you. Leave this empty and it stays exactly as it
            is; type a new one to replace it, and the connection is re-checked.
          </p>
        </div>
      )}

      {/* The fold is not gated on `armsTheWatchdog`: every provider has a reading speed, and
          only the PATIENCE PAIR inside keeps that gate, where it still means what it says. */}
      <div>
        <button
          type="button"
          onClick={() => setShowPatience(v => !v)}
          className="btn btn--sm"
          aria-expanded={showPatience}
        >
          {showPatience ? '▾' : '▸'} Speed and patience (advanced)
        </button>
        {showPatience && (
          <div className="mt-2 space-y-2">
            {armsTheWatchdog && (
              <PatienceFields
                firstChunkSec={firstChunkSec}
                idleSec={idleSec}
                onFirstChunk={setFirstChunkSec}
                onIdle={setIdleSec}
                disabled={busy}
              />
            )}
            <div className="fgrid" style={{ marginBottom: 0 }}>
              <div>
                <label className="flabel">Reading speed</label>
                <input
                  type="number" step="1"
                  min={THROUGHPUT_MIN_TOK_PER_SEC} max={THROUGHPUT_MAX_TOK_PER_SEC}
                  placeholder="measured automatically"
                  value={tokensPerSec}
                  onChange={(e) => setTokensPerSec(e.target.value)}
                  disabled={busy}
                  className="finput disabled:opacity-60"
                />
                <MeasuredReadingSpeed provider={provider} />
                <p className="text-[11px] text-ui/40 mt-1">
                  Tokens per second. You should not need this: the engine watches how fast this
                  machine actually gets through a prompt and works the number out on its own. Fill
                  it in only to overrule that, a figure you type here always wins. Be careful
                  with a low one: it tells the engine to turn away long messages before it even
                  tries them. Clear the box to undo that.
                </p>
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="flex items-center gap-3">
        <button type="button" onClick={handleSave} disabled={busy} className="btn btn--sm btn--primary">
          {status === 'saving' ? 'Saving…' : status === 'validating' ? 'Checking the connection…' : 'Save'}
        </button>
        <button type="button" onClick={onCancel} disabled={busy} className="btn btn--sm">
          Cancel
        </button>
        {status === 'valid' && <span className="text-xs text-cp-teal">Saved and connected</span>}
        {error && <span className="text-xs text-cp-coral">{error}</span>}
      </div>
    </div>
  );
};

const AddProviderForm = ({ onAdded, onCreated, onCancel }: { onAdded: () => void; onCreated?: () => void; onCancel: () => void }) => {
  const [name, setName] = useState('');
  // The dropdown 'preset' is UI-only: deepseek, openrouter and manual all map to backend type
  // 'openai-compatible' with different default base URLs and seeded catalogs, at submit time.
  const [preset, setPreset] = useState('anthropic');
  const [authType, setAuthType] = useState<'api_key' | 'oauth' | 'agent-sdk'>('api_key');
  const [credential, setCredential] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  // Only the manual choice carries one; every preset sends nothing and resolves it from its URL.
  const [behavesLike, setBehavesLike] = useState<string>('generic-openai-compatible');
  // The advanced patience pair: SECONDS in the UI, milliseconds on the wire; empty means
  // "declare nothing", which is what every provider does today.
  const [showPatience, setShowPatience] = useState(false);
  const [firstChunkSec, setFirstChunkSec] = useState('');
  const [idleSec, setIdleSec] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<'idle' | 'saving' | 'validating' | 'valid' | 'invalid'>('idle');

  // The manual choice: the owner types the URL, the key is OPTIONAL (a local
  // ollama / vLLM / LM Studio server usually has none), and the dialect is declared.
  const isManual = preset === 'manual';

  // Translate UI preset → backend (type, default baseUrl, suggested name).
  const presetConfig = (() => {
    switch (preset) {
      case 'anthropic':   return { backendType: 'anthropic',          defaultBaseUrl: undefined,                     suggestedName: 'Anthropic' };
      case 'openai':      return { backendType: 'openai',             defaultBaseUrl: 'https://api.openai.com',      suggestedName: 'OpenAI' };
      case 'openrouter':  return { backendType: 'openai-compatible',  defaultBaseUrl: 'https://openrouter.ai/api',   suggestedName: 'OpenRouter' };
      case 'deepseek':    return { backendType: 'openai-compatible',  defaultBaseUrl: 'https://api.deepseek.com',    suggestedName: 'DeepSeek' };
      case 'ollama':      return { backendType: 'ollama',             defaultBaseUrl: 'http://localhost:11434',      suggestedName: 'Ollama' };
      case 'manual':      return { backendType: 'openai-compatible',  defaultBaseUrl: undefined,                     suggestedName: 'Local Model' };
      default:            return { backendType: 'anthropic',          defaultBaseUrl: undefined,                     suggestedName: 'Anthropic' };
    }
  })();

  // Autofill the name on a preset change only while it is still blank or a previous preset's
  // suggestion; saves a click for the common case.
  useEffect(() => {
    setName((current) => {
      const isAutoFilled = current === '' ||
        ['Anthropic', 'OpenAI', 'OpenRouter', 'DeepSeek', 'Ollama', 'Local Model'].includes(current);
      return isAutoFilled ? presetConfig.suggestedName : current;
    });
  }, [preset, presetConfig.suggestedName]);

  // What the form needs before it will submit: manual asks for a URL instead of a key, the
  // field it cannot guess; the other presets ask for a key.
  const canSubmit = Boolean(name.trim()) && (
    isManual
      ? Boolean(baseUrl.trim())
      : preset === 'ollama' || authType === 'agent-sdk' || Boolean(credential.trim())
  );

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setStatus('saving');
    setError(null);

    // A manual endpoint with no key typed DECLARES it has no auth ('none'), which is what lets
    // validation and browsing reach it; a typed key follows the stored-key path like the rest.
    const manualAuthType = credential.trim() ? 'api_key' : 'none';

    // Validated here in the unit the user typed, so the message names seconds rather than
    // the millisecond bound the server would have reported.
    const first = parsePatienceSeconds(firstChunkSec, 'The wait for the first word');
    const idle = parsePatienceSeconds(idleSec, 'The wait during an answer');
    if (!first.ok || !idle.ok) {
      setError(!first.ok ? first.error : (idle as { ok: false; error: string }).error);
      setShowPatience(true);
      setStatus('idle');
      return;
    }

    const id = name.toLowerCase().replace(/[^a-z0-9]/g, '-');
    const result = await api.createProvider({
      id,
      name,
      type: presetConfig.backendType,
      baseUrl: baseUrl.trim() || presetConfig.defaultBaseUrl,
      authType: isManual ? manualAuthType : preset === 'ollama' ? 'none' : authType,
      credential: isManual
        ? (credential.trim() || undefined)
        : preset === 'ollama' || authType === 'agent-sdk' ? undefined : credential,
      ...(isManual ? { behavesLike } : {}),
      // Sent only when actually declared, so an undeclared pair never enters the create body.
      ...(first.ms === null ? {} : { firstChunkTimeoutMs: first.ms }),
      ...(idle.ms === null ? {} : { streamIdleTimeoutMs: idle.ms }),
    });

    if (!result.ok) {
      setError(result.error);
      setStatus('idle');
      return;
    }

    // The provider is stored whether or not the check below passes, so the list
    // learns about it now: a failed check must not leave it invisible.
    onCreated?.();

    setStatus('validating');
    const valResult = await api.validateProvider(id);
    if (valResult.ok && valResult.data.valid) {
      setStatus('valid');
      // Brief delay so the user sees the green badge before the form closes
      setTimeout(() => onAdded(), 800);
    } else {
      setStatus('invalid');
      const detail = !valResult.ok ? valResult.error : 'Unexpected result';
      setError(`Provider added but validation failed: ${detail}`);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="tile space-y-3">
      <div className="fgrid" style={{ marginBottom: 0 }}>
        <div>
          <label className="flabel">Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="finput"
          />
        </div>
        <div>
          <label className="flabel">Type</label>
          <select
            value={preset}
            onChange={(e) => setPreset(e.target.value)}
            className="finput field--select"
          >
            <option value="anthropic">Anthropic</option>
            <option value="openai">OpenAI</option>
            <option value="openrouter">OpenRouter</option>
            <option value="deepseek">DeepSeek</option>
            <option value="ollama">Ollama</option>
            <option value="manual">Manual OpenAI API</option>
          </select>
        </div>
      </div>

      {/* The manual choice: a URL the owner types, an optional key, and the dialect declared,
          because none of the three can be guessed from the others. */}
      {isManual && (
        <>
          <div>
            <label className="flabel">Base URL</label>
            <input
              type="text"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="http://localhost:8000/v1"
              className="finput"
            />
            <p className="text-[11px] text-ui/40 mt-1">
              Any server that speaks the OpenAI API, a local DeepSeek, vLLM, LM Studio, or a
              gateway on your network. Paste the URL the server prints; with or without the
              trailing <span className="font-mono">/v1</span> both work.
            </p>
          </div>

          <div>
            <label className="flabel">Behaves like</label>
            <select
              value={behavesLike}
              onChange={(e) => setBehavesLike(e.target.value)}
              className="finput field--select"
            >
              {BEHAVES_LIKE_CHOICES.map(choice => (
                <option key={choice.value} value={choice.value}>{choice.label}</option>
              ))}
            </select>
            <p className="text-[11px] text-ui/40 mt-1">
              {BEHAVES_LIKE_CHOICES.find(ch => ch.value === behavesLike)?.hint}
            </p>
          </div>

          <div>
            <label className="flabel">API Key <span className="text-ui/40">(optional)</span></label>
            <input
              type="password"
              value={credential}
              onChange={(e) => setCredential(e.target.value)}
              placeholder="Leave blank if the server needs no key"
              className="finput"
            />
            <p className="text-[11px] text-ui/40 mt-1">
              Most local servers accept anything here, leave it blank. A key you do type is
              stored the same way every other provider's key is.
            </p>
          </div>

          {/* Response patience is folded away: the standard bounds are right for almost
              everything, and the fold opens for the one person whose machine they are wrong for. */}
          <div>
            <button
              type="button"
              onClick={() => setShowPatience(v => !v)}
              className="btn btn--sm"
              aria-expanded={showPatience}
            >
              {showPatience ? '▾' : '▸'} Response patience (advanced)
            </button>
            {showPatience && (
              <div className="mt-2 space-y-2">
                <PatienceFields
                  firstChunkSec={firstChunkSec}
                  idleSec={idleSec}
                  onFirstChunk={setFirstChunkSec}
                  onIdle={setIdleSec}
                />
              </div>
            )}
          </div>
        </>
      )}

      {preset === 'ollama' && (
        <div>
          <label className="flabel">Base URL</label>
          <input
            type="text"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="http://localhost:11434"
            className="finput"
          />
          <p className="text-[11px] text-ui/40 mt-1">
            Ollama runs models locally, no account needed. On this Mac the Dojo installs Ollama at setup and keeps it
            current by itself; for Ollama on another machine, enter that machine's address.
          </p>
        </div>
      )}

      {preset !== 'ollama' && !isManual && (
        <>
          {preset === 'anthropic' && (
            <div>
              <label className="flabel">Auth Type</label>
              <select
                value={authType}
                onChange={(e) => setAuthType(e.target.value as 'api_key' | 'oauth' | 'agent-sdk')}
                className="finput field--select"
              >
                <option value="api_key">API Key</option>
                <option value="oauth">OAuth Token</option>
                <option value="agent-sdk">Agent SDK (Subscription)</option>
              </select>
            </div>
          )}

          {authType === 'agent-sdk' && preset === 'anthropic' ? (
            <AgentSdkSetup />
          ) : (
            <div>
              <label className="flabel">
                {authType === 'oauth' && preset === 'anthropic' ? 'OAuth Token' : 'API Key'}
              </label>
              <input
                type="password"
                value={credential}
                onChange={(e) => setCredential(e.target.value)}
                placeholder={
                  preset === 'deepseek' ? 'sk-... (DeepSeek API key from platform.deepseek.com)' :
                  preset === 'openai' ? 'sk-...' :
                  authType === 'oauth' ? 'sk-ant-oat...' : 'sk-...'
                }
                className="finput"
              />
              {/* Per-provider help: where to grab a key (or create an
                  account first). Each link opens the provider's
                  console keys page in a new tab. */}
              {preset === 'anthropic' && authType !== 'oauth' && (
                <p className="text-[11px] text-ui/40 mt-1">
                  Don't have a key?{' '}
                  <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener noreferrer" className="text-cp-teal hover:text-cp-teal/80 underline">
                    Create one at Anthropic Console ↗
                  </a>{' '}
                  · No account?{' '}
                  <a href="https://console.anthropic.com/signup" target="_blank" rel="noopener noreferrer" className="text-cp-teal hover:text-cp-teal/80 underline">
                    Sign up ↗
                  </a>
                </p>
              )}
              {preset === 'anthropic' && authType === 'oauth' && (
                <div className="text-[11px] text-ui/40 mt-1 space-y-1">
                  <p className="text-ui/55">Get a token with the Claude Code CLI:</p>
                  <p>1. Install it:</p>
                  <code className="block bg-ui/[0.05] px-2 py-1 rounded font-mono text-[10px] text-ui/55">curl -fsSL https://claude.ai/install.sh | bash</code>
                  <p>2. Generate the token:</p>
                  <code className="block bg-ui/[0.05] px-2 py-1 rounded font-mono text-[10px] text-ui/55">claude setup-token</code>
                  <p>
                    3. Paste it above (starts with <span className="font-mono">sk-ant-oat</span>). Needs a Claude{' '}
                    <a href="https://claude.ai/upgrade" target="_blank" rel="noopener noreferrer" className="text-cp-teal hover:text-cp-teal/80 underline">Pro/Max plan ↗</a>.
                  </p>
                </div>
              )}
              {preset === 'openai' && (
                <p className="text-[11px] text-ui/40 mt-1">
                  Don't have a key?{' '}
                  <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener noreferrer" className="text-cp-teal hover:text-cp-teal/80 underline">
                    Create one at OpenAI Platform ↗
                  </a>{' '}
                  · No account?{' '}
                  <a href="https://platform.openai.com/signup" target="_blank" rel="noopener noreferrer" className="text-cp-teal hover:text-cp-teal/80 underline">
                    Sign up ↗
                  </a>
                </p>
              )}
              {preset === 'openrouter' && (
                <p className="text-[11px] text-ui/40 mt-1">
                  Don't have a key?{' '}
                  <a href="https://openrouter.ai/settings/keys" target="_blank" rel="noopener noreferrer" className="text-cp-teal hover:text-cp-teal/80 underline">
                    Create one at OpenRouter ↗
                  </a>{' '}
                  · No account?{' '}
                  <a href="https://openrouter.ai/sign-up" target="_blank" rel="noopener noreferrer" className="text-cp-teal hover:text-cp-teal/80 underline">
                    Sign up ↗
                  </a>
                </p>
              )}
              {preset === 'deepseek' && (
                <p className="text-[11px] text-ui/40 mt-1">
                  Don't have a key?{' '}
                  <a href="https://platform.deepseek.com/api_keys" target="_blank" rel="noopener noreferrer" className="text-cp-teal hover:text-cp-teal/80 underline">
                    Create one at DeepSeek Platform ↗
                  </a>{' '}
                  · No account?{' '}
                  <a href="https://platform.deepseek.com/sign_up" target="_blank" rel="noopener noreferrer" className="text-cp-teal hover:text-cp-teal/80 underline">
                    Sign up ↗
                  </a>
                </p>
              )}
            </div>
          )}
        </>
      )}

      {error && (
        <div className="alert-banner alert-error">
          {error}
        </div>
      )}

      {status === 'valid' && (
        <div className="alert-banner alert-success">
          Validated
        </div>
      )}

      <div className="srow">
        <button
          type="submit"
          disabled={status === 'saving' || status === 'validating' || status === 'valid' || !canSubmit}
          className="btn btn--primary btn--sm"
        >
          {status === 'saving' ? 'Adding...' : status === 'validating' ? 'Validating...' : 'Add & Validate'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={status === 'saving' || status === 'validating'}
          className="px-4 py-2 text-sm text-ui/55 hover:text-ui/90 disabled:text-gray-700 transition-colors"
        >
          Cancel
        </button>
      </div>
    </form>
  );
};
