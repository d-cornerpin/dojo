// ── Settings → The Providers tab: the provider list, the add/edit forms and the patience fields.
//
// Lifted OUT of `pages/Settings.tsx` by t111-E1. The moved lines are VERBATIM; the only new
// bytes are this header, the imports below and the `export` keyword(s).

import { useState, useEffect, type FormEvent } from 'react';
import type { Provider, EditProviderRequest } from '@dojo/shared';
import * as api from '../../lib/api';
import {
  numberEditsFor, numInput,
  THROUGHPUT_MIN_TOK_PER_SEC, THROUGHPUT_MAX_TOK_PER_SEC,
  UNATTENDED_MIN_MINUTES, UNATTENDED_MAX_MINUTES, UNATTENDED_STANDARD_MINUTES, UNATTENDED_UNCAPPED,
} from '../../lib/provider-edits';
import { AgentSdkSetup } from './PlatformTab';


// ── Providers Tab ──

export const ProvidersTab = () => {
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
  // T66b — one provider is open for editing at a time. Held here rather than inside the row
  // so that opening a second edit closes the first, instead of leaving two half-typed forms.
  const [editingId, setEditingId] = useState<string | null>(null);

  const handleDelete = async (id: string) => {
    // Fetch models for this provider to check usage
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
        warning += `\n\nCurrently used by: ${unique.join(', ')}. They will be reassigned to another model.`;
      }
    }

    if (!confirm(warning)) return;
    const result = await api.deleteProvider(id);
    if (result.ok) {
      setProviders((prev) => prev.filter((p) => p.id !== id));
    }
  };

  const handleSyncModels = async (id: string) => {
    setSyncing(id);
    await api.validateProvider(id);
    setSyncing(null);
  };

  if (loading) return <div className="loading-state">Loading...</div>;

  return (
    <div className="space-y-4 max-w-4xl">
      {/* Existing providers */}
      {providers.length === 0 ? (
        <p className="text-ui/40 text-sm">No providers configured.</p>
      ) : (
        <div className="space-y-3">
          {providers.map((provider) => (
            <div key={provider.id} className="tile">
            <div className="flex items-start justify-between gap-3">
              {/* min-w-0 / shrink-0: the meta line wraps under itself instead of pushing into
                  the buttons now that the buttons are pills rather than bare text. */}
              <div className="min-w-0">
                <h3 className="text-sm font-medium text-ui">{provider.name}</h3>
                <p className="text-xs text-ui/40 mt-0.5">
                  {/* T63: 'none' is a real stored auth type (Ollama has always used it, and a
                      manual local server now does too). It used to render as "API Key",
                      which was the one thing it is not. */}
                  {provider.type} &middot; {provider.authType === 'agent-sdk' ? 'Agent SDK' : provider.authType === 'oauth' ? 'OAuth' : provider.authType === 'none' ? 'No key' : 'API Key'}
                  {provider.behavesLike ? ` · behaves like ${provider.behavesLike}` : ''} {provider.isValidated ? '(validated)' : '(not validated)'}
                  {/* T66b — patience was only readable by opening its own fold. It stays
                      readable at a glance now that the fold has moved inside Edit. */}
                  {(provider.firstChunkTimeoutMs !== null || provider.streamIdleTimeoutMs !== null) && (
                    <span className="text-cp-teal">
                      {' '}· waits {msToSecInput(provider.firstChunkTimeoutMs) || STANDARD_FIRST_CHUNK_SEC}s for the
                      first word, {msToSecInput(provider.streamIdleTimeoutMs) || STANDARD_IDLE_SEC}s during
                    </span>
                  )}
                </p>
              </div>
              {/* T66b — the row's actions are real buttons. They were text: "Sync Models and
                  Pricing" and "Delete" read as links, and the patience fold below them was
                  dim grey and read as a caption — the owner reported not realising the
                  patience editor was clickable at all. `btn btn--sm` is the page's own pill
                  (cursor, hover lift, focus ring), so nothing new is invented here; the
                  controls just stop pretending to be prose. */}
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
            {/* T66b — the edit. The owner's box is ALREADY a provider; he is not going to
                delete and re-add it to change its name, its URL or one timeout. */}
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

      {/* Add provider */}
      {showAdd ? (
        <AddProviderForm
          onAdded={() => {
            loadProviders();
            setShowAdd(false);
          }}
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

// T63 — the dialects a MANUAL endpoint can declare it behaves like.
//
// The values are the capability-contract profile ids (`agent/model-contract.ts`'s
// `BEHAVES_LIKE_PROFILES`), and the create route validates against that same list, so a
// label added here can never invent a profile the engine cannot resolve. The choice exists
// because a URL like `http://localhost:8000/v1` says nothing about the dialect behind it —
// which is precisely the case the manual option is for.
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

// T64b — RESPONSE PATIENCE.
//
// The server's own bounds (`agent/stream-patience.ts`), restated here in the unit the field
// is typed in. The form talks in SECONDS because nobody thinks about a timeout in
// milliseconds; the column stores milliseconds because everything else in the engine does.
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

/**
 * PREFILL SELF-CALIBRATION (owner ruling 2026-09-22: "never ask the user for a number the
 * platform can observe"). What the engine worked out for itself, shown as INFORMATION rather
 * than as a control: there is no write door for it, and a field that let someone edit a
 * measurement would turn it straight back into the declaration this feature exists to stop
 * asking for. Absent entirely until a provider has served a call big enough to measure from.
 */
const MeasuredReadingSpeed = ({ provider }: { provider: Provider }) => {
  const measured = provider.measuredPrefillTokensPerSec;
  if (measured === null) return null;
  // Fix round 1 (review N4): the reader (`agent/stream-patience.ts`) floors this and then
  // re-checks it against the same 1-100,000 bounds a declared value must satisfy, so a stored
  // reading outside them is IGNORED by the engine. Showing it anyway would tell the owner his
  // box was measured at 500,000 tokens/sec while nothing at all was using that number.
  if (Math.floor(measured) < THROUGHPUT_MIN_TOK_PER_SEC || measured > THROUGHPUT_MAX_TOK_PER_SEC) return null;
  return (
    <p className="text-[11px] text-cp-teal/70 mt-1">
      Measured reading speed: ~{Math.floor(measured)} tokens/sec.
      Worked out from this machine's own recent calls — you do not need to fill anything in.
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
          anything, and on a long one that can take several minutes — far past the{' '}
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

// T66b — THE PER-PROVIDER EDITOR.
//
// The owner: "at the very least change the name and the patience settings". Patience had its
// own editor from T64b; nothing else could be changed at all, and the only door that could
// change a name — `POST /providers` over the existing id — is a FULL REPLACE, so a form built
// on it would clear a base URL or a dialect declaration for anyone who did not re-send them.
// `PATCH /providers/:id` writes only the fields it is given, and this form only gives it the
// fields the user actually altered.
//
// TWO DOORS, ONE SAVE. Patience keeps its own narrow route (T64b) and the identity fields have
// theirs; each owns its properties so neither can rewrite the other's. The user sees one Save.
//
// WHAT IS NOT HERE. `type` cannot be edited — an Anthropic provider that becomes an Ollama one
// is a different provider, with different models, a different credential and a different
// dialect. The server refuses it by name; the form says so in plain words rather than
// offering a control that would be rejected.
const ProviderEditForm = ({ provider, onSaved, onCancel }: {
  provider: Provider; onSaved: () => void; onCancel: () => void;
}) => {
  // T64b's rule, unchanged: the pair is offered only where the stream watchdog actually arms.
  // Ollama bounds its call a different way (a single 5-minute fetch timeout) and the Agent SDK
  // transport has no watchdog at all, so the fields would be a control that does nothing.
  const armsTheWatchdog = provider.type !== 'ollama' && provider.authType !== 'agent-sdk';
  // The dialect is only ambiguous behind an OpenAI-compatible URL — which is the whole reason
  // T63 made it declarable. Anthropic, OpenAI and Ollama each speak one known dialect.
  const canDeclareDialect = provider.type === 'openai-compatible';
  // A provider with no base URL of its own (Anthropic direct) has nothing to point elsewhere.
  const hasEndpoint = provider.type !== 'anthropic' || provider.baseUrl !== null;
  // Ollama takes no key, and the Agent SDK signs in through the CLI rather than a stored one.
  const canRotateKey = provider.type !== 'ollama' && provider.authType !== 'agent-sdk';

  const [name, setName] = useState(provider.name);
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl ?? '');
  // '' is "declare nothing and go back to reading the URL", which is what the column's NULL
  // means and what every provider created before T63 holds.
  const [behavesLike, setBehavesLike] = useState(provider.behavesLike ?? '');
  // Never pre-filled: the server does not send the stored key to the client and must not.
  // Blank therefore means KEEP, and the help text under the field says exactly that.
  const [credential, setCredential] = useState('');
  // The fold opens by itself when ANY of the advanced numbers is already set — a value the user
  // cannot see is a value they cannot check, and this fold now holds four of them, not two.
  const [showPatience, setShowPatience] = useState(
    provider.firstChunkTimeoutMs !== null || provider.streamIdleTimeoutMs !== null
    || provider.prefillTokensPerSec !== null || provider.unattendedBudgetMinutes !== null,
  );
  const [firstChunkSec, setFirstChunkSec] = useState(msToSecInput(provider.firstChunkTimeoutMs));
  const [idleSec, setIdleSec] = useState(msToSecInput(provider.streamIdleTimeoutMs));
  // '' is "say nothing". For reading speed that means "use whatever the engine measured";
  // for working time it means "the standard hour". Neither is a number the user has to supply.
  const [tokensPerSec, setTokensPerSec] = useState(numInput(provider.prefillTokensPerSec));
  const [unattendedMinutes, setUnattendedMinutes] = useState(numInput(provider.unattendedBudgetMinutes));
  const [status, setStatus] = useState<'idle' | 'saving' | 'validating' | 'valid' | 'invalid'>('idle');
  const [error, setError] = useState<string | null>(null);

  const busy = status === 'saving' || status === 'validating';

  const handleSave = async (): Promise<void> => {
    setError(null);
    if (!name.trim()) { setError('A provider needs a name'); return; }

    const first = parsePatienceSeconds(firstChunkSec, 'The wait for the first word');
    const idle = parsePatienceSeconds(idleSec, 'The wait during an answer');
    // The only-what-moved rule for the two narrow-door numbers, decided in `lib/provider-edits.ts`
    // where it can be argued with in a test rather than only observed in a browser.
    const numbers = numberEditsFor(provider, { tokensPerSec, unattendedMinutes });
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
    // Two more narrow doors, each with its own flag for the same reason the patience pair has
    // one: the server REFUSES both of these fields by name on the identity door, so they can
    // never ride along in `edit`, and a field the user did not touch must not be mentioned to
    // its own door either — sending an untouched value back is how a blank clears a number
    // nobody meant to clear. An ABSENT key is "do not call this door"; a `null` key is "call it
    // and clear the number". Those are different requests.
    const speedMoved = 'prefillTokensPerSec' in numbers.edits;
    const unattendedMoved = 'unattendedBudgetMinutes' in numbers.edits;

    if (Object.keys(edit).length === 0 && !patienceMoved && !speedMoved && !unattendedMoved) {
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
    if (unattendedMoved) {
      const u = await api.updateProviderUnattendedBudget(provider.id, numbers.edits.unattendedBudgetMinutes ?? null);
      if (!u.ok) { setError(u.error); setStatus('idle'); return; }
    }

    let revalidationRequired = false;
    if (Object.keys(edit).length > 0) {
      const result = await api.updateProvider(provider.id, edit);
      if (!result.ok) { setError(result.error); setStatus('idle'); return; }
      revalidationRequired = result.revalidationRequired === true;
    }

    // The badge the server just cleared is a claim about a connection nobody has tried yet, so
    // the same two-step the add form uses after a create: save, then run the EXISTING validate
    // route. It is a separate call on purpose — a write door that reached out to a local box
    // would hold the user's Save open for as long as that box takes to time out.
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
            What you call it. Nothing else uses it — models, keys and assignments all follow the
            provider itself, so renaming is safe.
          </p>
        </div>
        <div>
          <label className="flabel">Type</label>
          <input type="text" value={provider.type} disabled readOnly className="finput opacity-60" />
          <p className="text-[11px] text-ui/40 mt-1">
            Can't be changed — a different type is a different provider. Delete this one and add
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
              ?? 'Reads the dialect off the address, which is right for every hosted service. Declare one when the address cannot say — a local server.'}
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

      {/* The fold is no longer gated on `armsTheWatchdog`: the two fields added here apply to
          every provider, and an Ollama box — the one kind the watchdog gate excludes — is
          precisely the kind whose owner needs to say how long it may work on its own. Only the
          PATIENCE PAIR keeps that gate, inside, where it still means what it meant. */}
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
                  it in only to overrule that — a figure you type here always wins. Be careful
                  with a low one: it tells the engine to turn away long messages before it even
                  tries them. Clear the box to undo that.
                </p>
              </div>
              <div>
                <label className="flabel">Working time on its own</label>
                <input
                  type="number" step="1"
                  min={UNATTENDED_UNCAPPED} max={UNATTENDED_MAX_MINUTES}
                  placeholder={`${UNATTENDED_STANDARD_MINUTES} (standard)`}
                  value={unattendedMinutes}
                  onChange={(e) => setUnattendedMinutes(e.target.value)}
                  disabled={busy}
                  className="finput disabled:opacity-60"
                />
                <p className="text-[11px] text-ui/40 mt-1">
                  Minutes. How long an agent on this machine may keep working before it has to
                  stop and check in. Blank is the standard {UNATTENDED_STANDARD_MINUTES} minutes;{' '}
                  {UNATTENDED_MIN_MINUTES} minutes to {UNATTENDED_MAX_MINUTES / 60} hours is
                  allowed. Type <strong>0</strong> to let it run as long as the job takes — worth
                  it on a slow machine of your own, rarely worth it on a paid service.
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

const AddProviderForm = ({ onAdded, onCancel }: { onAdded: () => void; onCancel: () => void }) => {
  const [name, setName] = useState('');
  // The dropdown 'preset' is a UI-only label. Several presets (deepseek,
  // openrouter, manual) all map to the same backend type 'openai-compatible'
  // but with different default base URLs and seeded model catalogs. The
  // mapping happens at submit time below.
  const [preset, setPreset] = useState('anthropic');
  const [authType, setAuthType] = useState<'api_key' | 'oauth' | 'agent-sdk'>('api_key');
  const [credential, setCredential] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  // T63: only the manual choice carries one. Every preset sends nothing and is resolved
  // from its URL exactly as before.
  const [behavesLike, setBehavesLike] = useState<string>('generic-openai-compatible');
  // T64b — the advanced patience pair, in SECONDS in the UI and milliseconds on the wire.
  // Empty string means "declare nothing", which is what every provider does today.
  const [showPatience, setShowPatience] = useState(false);
  const [firstChunkSec, setFirstChunkSec] = useState('');
  const [idleSec, setIdleSec] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<'idle' | 'saving' | 'validating' | 'valid' | 'invalid'>('idle');

  // T63 — the manual choice: the owner types the URL, the key is OPTIONAL (a local
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

  // When the preset changes, autofill the name field if the user hasn't
  // typed anything custom yet (or if it still matches a previous preset's
  // suggestion). Saves a click for the common case.
  useEffect(() => {
    setName((current) => {
      const isAutoFilled = current === '' ||
        ['Anthropic', 'OpenAI', 'OpenRouter', 'DeepSeek', 'Ollama', 'Local Model'].includes(current);
      return isAutoFilled ? presetConfig.suggestedName : current;
    });
  }, [preset, presetConfig.suggestedName]);

  // What the form needs before it will submit. Manual asks for a URL instead of a key,
  // because that is the field it cannot guess; everything else is unchanged.
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

    // A manual endpoint with no key typed DECLARES it has no auth ('none'), which is what
    // lets validation and browsing reach it at all. Type a key and it is stored and sent
    // through exactly the same path every other provider's key uses.
    const manualAuthType = credential.trim() ? 'api_key' : 'none';

    // T64b: validated here in the unit the user typed, so the message names seconds rather
    // than the millisecond bound the server would have reported.
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
      // Sent only when actually declared, so a preset's create body is byte-identical to
      // what it has always been.
      ...(first.ms === null ? {} : { firstChunkTimeoutMs: first.ms }),
      ...(idle.ms === null ? {} : { streamIdleTimeoutMs: idle.ms }),
    });

    if (!result.ok) {
      setError(result.error);
      setStatus('idle');
      return;
    }

    // Validate the credential
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

      {/* T63 — the manual choice: a URL the owner types, an optional key, and the
          dialect declared, because none of the three can be guessed from the others. */}
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
              Any server that speaks the OpenAI API — a local DeepSeek, vLLM, LM Studio, or a
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
              Most local servers accept anything here — leave it blank. A key you do type is
              stored the same way every other provider's key is.
            </p>
          </div>

          {/* T64b — response patience. Folded away because the standard bounds are right for
              almost everything; opened by the one person whose machine they are wrong for. */}
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
            Ollama runs models locally — no account needed.{' '}
            <a
              href="https://ollama.com/download"
              target="_blank"
              rel="noopener noreferrer"
              className="text-cp-teal hover:text-cp-teal/80 underline"
            >
              Download Ollama ↗
            </a>{' '}
            if you don't have it installed yet.
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
