import { useState, useEffect, useCallback, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Model, Provider } from '@dojo/shared';
import * as api from '../lib/api';
import { SetupDeps, SetupPermissions } from '../components/SetupDeps';

type Step = 'welcome' | 'dependencies' | 'permissions' | 'provider' | 'models' | 'your-profile' | 'primary-agent' | 'pm-agent' | 'trainer-agent' | 'dreamer' | 'imessage' | 'workspace' | 'web-search' | 'complete';

const STEPS: Step[] = ['welcome', 'dependencies', 'permissions', 'provider', 'models', 'your-profile', 'primary-agent', 'pm-agent', 'trainer-agent', 'dreamer', 'imessage', 'web-search', 'workspace', 'complete'];

const STEP_LABELS: Record<Step, string> = {
  welcome: 'Welcome',
  dependencies: 'Equip the Dojo',
  permissions: 'macOS Permissions',
  provider: 'AI Providers',
  models: 'Enable Models',
  'your-profile': 'Your Profile',
  'primary-agent': 'Primary Agent',
  'pm-agent': 'Project Manager',
  'trainer-agent': 'Technique Trainer',
  dreamer: 'Dreamer',
  imessage: 'iMessage',
  workspace: 'Google Workspace',
  'web-search': 'Web Search',
  complete: 'Enter the Dojo',
};

export const Setup = () => {
  const [currentStep, setCurrentStep] = useState<Step>('welcome');
  const [depsReady, setDepsReady] = useState(false);
  const [stepReady, setStepReady] = useState<Record<string, boolean>>({});
  const [visitedSteps, setVisitedSteps] = useState<Set<Step>>(new Set(['welcome']));
  const navigate = useNavigate();

  const markReady = useCallback((step: Step, ready: boolean) => {
    setStepReady(prev => {
      if (prev[step] === ready) return prev;
      return { ...prev, [step]: ready };
    });
  }, []);

  const currentIndex = STEPS.indexOf(currentStep);

  // Track visited steps so we can keep them mounted
  useEffect(() => {
    setVisitedSteps(prev => {
      if (prev.has(currentStep)) return prev;
      const next = new Set(prev);
      next.add(currentStep);
      return next;
    });
  }, [currentStep]);

  // Steps that require explicit completion before proceeding
  const gatedSteps: Step[] = ['dependencies', 'your-profile', 'primary-agent', 'pm-agent', 'trainer-agent', 'dreamer', 'imessage', 'web-search'];
  const isNextDisabled = gatedSteps.includes(currentStep) && !stepReady[currentStep];

  // Stable callbacks for step onReady props (prevents infinite re-render loops)
  const onDepsReady = useCallback((ready: boolean) => { setDepsReady(ready); markReady('dependencies', ready); }, [markReady]);
  const onProviderReady = useCallback((r: boolean) => markReady('provider', r), [markReady]);
  const onProfileReady = useCallback((r: boolean) => markReady('your-profile', r), [markReady]);
  const onPrimaryReady = useCallback((r: boolean) => markReady('primary-agent', r), [markReady]);
  const onPMReady = useCallback((r: boolean) => markReady('pm-agent', r), [markReady]);
  const onTrainerReady = useCallback((r: boolean) => markReady('trainer-agent', r), [markReady]);
  const onDreamerReady = useCallback((r: boolean) => markReady('dreamer', r), [markReady]);
  const onImessageReady = useCallback((r: boolean) => markReady('imessage', r), [markReady]);
  const onWebSearchReady = useCallback((r: boolean) => markReady('web-search', r), [markReady]);

  // Provider step: "are you sure?" when only Ollama is configured
  const [hasCloudProvider, setHasCloudProvider] = useState(false);
  const [showProviderConfirm, setShowProviderConfirm] = useState(false);

  const goNext = () => {
    // Intercept the provider step: warn if no cloud provider
    if (currentStep === 'provider' && !hasCloudProvider) {
      setShowProviderConfirm(true);
      return;
    }
    setShowProviderConfirm(false);
    if (currentIndex < STEPS.length - 1) {
      setCurrentStep(STEPS[currentIndex + 1]);
    }
  };

  const goNextForce = () => {
    setShowProviderConfirm(false);
    if (currentIndex < STEPS.length - 1) {
      setCurrentStep(STEPS[currentIndex + 1]);
    }
  };

  const goBack = () => {
    setShowProviderConfirm(false);
    if (currentIndex > 0) {
      setCurrentStep(STEPS[currentIndex - 1]);
    }
  };

  return (
    <div className="min-h-screen flex flex-col items-center px-4 py-12 relative">
      <div className="gradient-blob-layer">
        <div className="blob blob-purple" />
        <div className="blob blob-teal" />
        <div className="blob blob-warm" />
      </div>
      <div className="w-full max-w-2xl relative z-[1]">
        {/* Header */}
        <div className="text-center mb-8">
          <img src="/dojologo.svg" alt="DOJO" className="w-12 h-12 mx-auto mb-3" />
          <h1 className="text-2xl font-bold text-white">Agent D.O.J.O.</h1>
          <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>Delegated Operations & Job Orchestration</p>
        </div>

        {/* Progress */}
        <div className="flex items-center justify-center gap-1 mb-8">
          {STEPS.map((step, i) => (
            <div key={step} className="flex items-center">
              <div
                className={`w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-semibold transition-all duration-300 ${
                  i < currentIndex
                    ? 'bg-cp-teal text-[#0B0F1A]'
                    : i === currentIndex
                      ? 'bg-cp-amber text-[#0B0F1A] ring-2 ring-cp-amber/40 shadow-glass-glow'
                      : 'bg-white/[0.06] text-white/30'
                }`}
              >
                {i < currentIndex ? '\u2713' : i + 1}
              </div>
              {i < STEPS.length - 1 && (
                <div className={`w-5 h-0.5 mx-0.5 transition-colors duration-300 ${i < currentIndex ? 'bg-cp-teal' : 'bg-white/[0.06]'}`} />
              )}
            </div>
          ))}
        </div>

        {/* Step Label */}
        <h2 className="text-lg font-semibold text-white text-center mb-6">
          {STEP_LABELS[currentStep]}
        </h2>

        {/* Step Content — steps stay mounted once visited so state is preserved on back/next */}
        <div className="glass-card p-6">
          <div style={{ display: currentStep === 'welcome' ? 'block' : 'none' }}>
            {visitedSteps.has('welcome') && <WelcomeStep />}
          </div>
          <div style={{ display: currentStep === 'dependencies' ? 'block' : 'none' }}>
            {visitedSteps.has('dependencies') && <SetupDeps onReady={onDepsReady} />}
          </div>
          <div style={{ display: currentStep === 'permissions' ? 'block' : 'none' }}>
            {visitedSteps.has('permissions') && <SetupPermissions />}
          </div>
          <div style={{ display: currentStep === 'provider' ? 'block' : 'none' }}>
            {visitedSteps.has('provider') && <ProviderStep onReady={onProviderReady} onCloudProviderChange={setHasCloudProvider} />}
          </div>
          <div style={{ display: currentStep === 'models' ? 'block' : 'none' }}>
            {visitedSteps.has('models') && <ModelsStep />}
          </div>
          <div style={{ display: currentStep === 'your-profile' ? 'block' : 'none' }}>
            {visitedSteps.has('your-profile') && <YourProfileStep onReady={onProfileReady} />}
          </div>
          <div style={{ display: currentStep === 'primary-agent' ? 'block' : 'none' }}>
            {visitedSteps.has('primary-agent') && <PrimaryAgentStep onReady={onPrimaryReady} />}
          </div>
          <div style={{ display: currentStep === 'pm-agent' ? 'block' : 'none' }}>
            {visitedSteps.has('pm-agent') && <PMAgentStep onReady={onPMReady} />}
          </div>
          <div style={{ display: currentStep === 'trainer-agent' ? 'block' : 'none' }}>
            {visitedSteps.has('trainer-agent') && <TrainerAgentStep onReady={onTrainerReady} />}
          </div>
          <div style={{ display: currentStep === 'dreamer' ? 'block' : 'none' }}>
            {visitedSteps.has('dreamer') && <DreamerStep onReady={onDreamerReady} />}
          </div>
          <div style={{ display: currentStep === 'imessage' ? 'block' : 'none' }}>
            {visitedSteps.has('imessage') && <IMessageStep onReady={onImessageReady} />}
          </div>
          <div style={{ display: currentStep === 'workspace' ? 'block' : 'none' }}>
            {visitedSteps.has('workspace') && <WorkspaceStep />}
          </div>
          <div style={{ display: currentStep === 'web-search' ? 'block' : 'none' }}>
            {visitedSteps.has('web-search') && <WebSearchStep onReady={onWebSearchReady} />}
          </div>
          <div style={{ display: currentStep === 'complete' ? 'block' : 'none' }}>
            {visitedSteps.has('complete') && <CompleteStep />}
          </div>
        </div>

        {/* Provider confirmation dialog */}
        {showProviderConfirm && (
          <div className="mt-4 px-4 py-3 rounded-lg bg-cp-amber/10 border border-cp-amber/20 space-y-3">
            <p className="text-sm text-cp-amber">
              Only the local Ollama provider is configured. The Agent Dojo works much better with a cloud AI provider like Anthropic or OpenAI for complex tasks.
            </p>
            <div className="flex gap-2">
              <button onClick={() => setShowProviderConfirm(false)}
                className="glass-btn glass-btn-primary text-xs">
                I'll add one
              </button>
              <button onClick={goNextForce}
                className="glass-btn glass-btn-ghost text-xs">
                Continue anyway
              </button>
            </div>
          </div>
        )}

        {/* Navigation */}
        <div className="flex justify-between mt-6">
          <button
            onClick={goBack}
            disabled={currentIndex === 0}
            className="glass-btn glass-btn-ghost disabled:opacity-30"
          >
            Back
          </button>
          {currentStep === 'complete' ? (
            <LaunchButton />
          ) : (
            <button
              onClick={goNext}
              disabled={isNextDisabled}
              className="glass-btn glass-btn-primary disabled:opacity-30 disabled:cursor-not-allowed"
            >
              Next
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

// ══════════════════════════════════════
// Step Components
// ══════════════════════════════════════

const WelcomeStep = () => {
  const [health, setHealth] = useState<{ backend: boolean; db: boolean } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const check = async () => {
      const result = await api.getHealth();
      if (result.ok) {
        setHealth({ backend: true, db: result.data.db === 'ok' });
      } else {
        setHealth({ backend: false, db: false });
      }
      setLoading(false);
    };
    check();
  }, []);

  return (
    <div className="space-y-6">
      <div className="text-center">
        <img src="/dojologo.svg" alt="DOJO" className="w-16 h-16 mx-auto mb-4" />
        <p className="white/70">
          Prepare to enter the <strong className="text-white">D.O.J.O.</strong>
        </p>
        <p className="text-sm text-white/40 mt-2">
          The path to mastery begins with a single step. Take yours.
        </p>
      </div>

      {loading ? (
        <p className="text-white/55 text-center py-4">Checking system...</p>
      ) : (
        <div className="space-y-3">
          {[
            { label: 'Backend server', ok: health?.backend },
            { label: 'Database', ok: health?.db },
          ].map((check) => (
            <div key={check.label} className="flex items-center gap-3">
              <span className={`text-lg ${check.ok ? 'text-green-500' : 'text-red-500'}`}>
                {check.ok ? '\u2713' : '\u2717'}
              </span>
              <span className="white/70">{check.label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// ── Password ──

const PasswordStep = ({ onComplete }: { onComplete: () => void }) => {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSet = async (e: FormEvent) => {
    e.preventDefault();
    if (password !== confirm) {
      setError('Passwords do not match');
      return;
    }
    if (password.length < 6) {
      setError('Password must be at least 6 characters');
      return;
    }

    setError(null);
    const result = await api.login(password);
    if (result.ok) {
      setSaved(true);
      setTimeout(onComplete, 500);
    } else {
      setError(result.error);
    }
  };

  return (
    <form onSubmit={handleSet} className="space-y-4">
      <p className="text-sm text-white/55">
        Create a password for your dashboard. You'll use this to log in.
      </p>

      <div>
        <label className="block text-sm font-medium white/70 mb-1">New Password</label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="At least 6 characters"
          autoFocus
          className="glass-input"
        />
      </div>

      <div>
        <label className="block text-sm font-medium white/70 mb-1">Confirm Password</label>
        <input
          type="password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          placeholder="Type it again"
          className="glass-input"
        />
      </div>

      {error && (
        <div className="px-3 py-2 rounded-lg bg-cp-coral/10 border border-cp-coral/20 text-cp-coral text-sm">{error}</div>
      )}

      {saved && (
        <div className="px-3 py-2 rounded-lg glass-badge-teal border border-cp-teal/20 text-sm">
          Password created!
        </div>
      )}

      <button
        type="submit"
        disabled={!password.trim() || !confirm.trim() || saved}
        className={`px-4 py-2 text-white text-sm font-medium rounded-lg transition-colors ${
          saved ? 'bg-cp-teal text-[#0B0F1A] font-semibold' : 'glass-btn glass-btn-primary'
        }`}
      >
        {saved ? '\u2713 Password Created' : 'Create Password'}
      </button>
    </form>
  );
};

// ── Provider ──

const ProviderStep = ({ onReady, onCloudProviderChange }: { onReady?: (ready: boolean) => void; onCloudProviderChange?: (has: boolean) => void }) => {
  const [name, setName] = useState('');
  const [type, setType] = useState('anthropic');
  const [authType, setAuthType] = useState('api_key');
  const [credential, setCredential] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [status, setStatus] = useState<'idle' | 'validating' | 'valid' | 'invalid'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [providerId, setProviderId] = useState<string | null>(null);
  const [hasOllama, setHasOllama] = useState(false);
  const [hasCloudProvider, setHasCloudProvider] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  // Always allow Next (we handle the "are you sure" in the parent via onReady)
  useEffect(() => { onReady?.(true); }, [onReady]);

  // Check existing providers on mount
  useEffect(() => {
    api.getProviders().then(r => {
      if (r.ok) {
        const providers = r.data as Provider[];
        setHasOllama(providers.some(p => p.type === 'ollama' && p.isValidated));
        const hasCloud = providers.some(p => p.type !== 'ollama' && p.isValidated);
        setHasCloudProvider(hasCloud);
        onCloudProviderChange?.(hasCloud);
      }
    });
  }, []);

  const handleAdd = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || (type !== 'ollama' && !credential.trim())) return;

    setStatus('validating');
    setError(null);

    const id = name.toLowerCase().replace(/[^a-z0-9]/g, '-');
    const result = await api.createProvider({
      id, name, type,
      baseUrl: type === 'ollama' ? (baseUrl || 'http://localhost:11434')
        : type === 'openai-compatible' ? (baseUrl || 'https://openrouter.ai/api')
        : type === 'openai' ? (baseUrl || 'https://api.openai.com')
        : undefined,
      authType: type === 'ollama' ? 'none' : authType,
      credential: type === 'ollama' ? undefined : credential,
    });

    if (!result.ok) {
      setError(result.error);
      setStatus('invalid');
      return;
    }

    setProviderId(id);
    const valResult = await api.validateProvider(id);
    if (valResult.ok && valResult.data.valid) {
      setStatus('valid');
      if (type === 'ollama') {
        setHasOllama(true);
      } else {
        setHasCloudProvider(true);
        onCloudProviderChange?.(true);
      }
    } else {
      setStatus('invalid');
      setError(`Provider added but validation failed: ${!valResult.ok ? valResult.error : 'Unexpected result'}`);
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-white/55">
        Connect a cloud AI provider for your agents. You can add more providers later in Settings.
      </p>

      {/* Ollama status */}
      {hasOllama && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-cp-teal/10 border border-cp-teal/20">
          <span className="text-cp-teal">{'\u2713'}</span>
          <span className="text-sm text-cp-teal">Ollama (local) is configured</span>
        </div>
      )}

      {/* Cloud provider added confirmation */}
      {hasCloudProvider && status === 'valid' && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-cp-teal/10 border border-cp-teal/20">
          <span className="text-cp-teal">{'\u2713'}</span>
          <span className="text-sm text-cp-teal">Cloud provider validated!</span>
        </div>
      )}

      {/* Add provider form */}
      <form onSubmit={handleAdd} className="space-y-4">
        <h3 className="text-sm font-medium text-white/70">{hasCloudProvider ? 'Add Another Provider' : 'Add a Cloud Provider'}</h3>

        <div>
          <label className="block text-sm font-medium white/70 mb-1">Provider Name</label>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g., My Anthropic"
            className="glass-input" />
        </div>

        <div>
          <label className="block text-sm font-medium white/70 mb-1">Type</label>
          <select value={type} onChange={(e) => setType(e.target.value)}
            className="glass-select w-full">
            <option value="anthropic">Anthropic</option>
            <option value="openai">OpenAI</option>
            <option value="openai-compatible">OpenRouter</option>
            <option value="ollama">Ollama</option>
          </select>
        </div>

        {type === 'ollama' && (
          <div>
            <label className="block text-sm font-medium white/70 mb-1">Base URL</label>
            <input type="text" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="http://localhost:11434"
              className="glass-input" />
          </div>
        )}

        {type !== 'ollama' && (
          <>
            {type === 'anthropic' && (
              <div>
                <label className="block text-sm font-medium white/70 mb-1">Auth Type</label>
                <select value={authType} onChange={(e) => setAuthType(e.target.value)}
                  className="glass-select w-full">
                  <option value="api_key">API Key</option>
                  <option value="oauth">OAuth Token</option>
                </select>
              </div>
            )}
            <div>
              <label className="block text-sm font-medium white/70 mb-1">{authType === 'oauth' && type === 'anthropic' ? 'OAuth Token' : 'API Key'}</label>
              <input type="password" value={credential} onChange={(e) => setCredential(e.target.value)}
                placeholder={type === 'openai' ? 'sk-...' : authType === 'oauth' ? 'sk-ant-oat...' : 'sk-...'}
                className="glass-input" />
            </div>

            {/* OAuth hint for Anthropic */}
            {type === 'anthropic' && authType === 'oauth' && (
              <div className="px-3 py-2.5 rounded-lg bg-blue-500/5 border border-blue-500/10 text-[11px] text-blue-300/70 leading-relaxed space-y-1.5">
                <p className="font-medium text-blue-300/90">How to get your OAuth token:</p>
                <p>1. Install Claude Code (if you haven't already):</p>
                <code className="block px-2 py-1 rounded bg-white/[0.05] font-mono text-[10px] text-white/60">curl -fsSL https://claude.ai/install.sh | bash</code>
                <p>2. Generate your token:</p>
                <code className="block px-2 py-1 rounded bg-white/[0.05] font-mono text-[10px] text-white/60">claude setup-token</code>
                <p>3. Copy the token (starts with <span className="font-mono">sk-ant-oat</span>) and paste it above.</p>
              </div>
            )}
          </>
        )}

        {error && <div className="px-3 py-2 rounded-lg bg-cp-coral/10 border border-cp-coral/20 text-cp-coral text-sm">{error}</div>}

        <button type="submit" disabled={status === 'validating' || !name.trim() || (type !== 'ollama' && !credential.trim())}
          className="px-4 py-2 text-white text-sm font-medium rounded-lg transition-colors glass-btn glass-btn-primary">
          {status === 'validating' ? 'Validating...' : 'Add & Validate Provider'}
        </button>
      </form>
    </div>
  );
};

// ── Models ──

// ── Setup: Browse Models for aggregator providers ──

const SetupBrowseModels = ({ providerId, providerName, onModelsAdded }: { providerId: string; providerName: string; onModelsAdded: () => void }) => {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<api.BrowseModelResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [adding, setAdding] = useState<string | null>(null);
  const [addedCount, setAddedCount] = useState(0);
  const [searched, setSearched] = useState(false);

  const handleSearch = async () => {
    if (!query.trim()) return;
    setSearching(true);
    setSearched(true);
    const result = await api.browseProviderModels(providerId, query.trim());
    if (result.ok) setResults(result.data);
    else setResults([]);
    setSearching(false);
  };

  const handleAdd = async (model: api.BrowseModelResult) => {
    setAdding(model.apiModelId);
    const result = await api.addProviderModel(providerId, model);
    if (result.ok) {
      // Also enable the model immediately
      const addedId = (result.data as Record<string, unknown>).id as string;
      if (addedId) await api.enableModels([addedId]);
      setResults(prev => prev.filter(r => r.apiModelId !== model.apiModelId));
      setAddedCount(prev => prev + 1);
      onModelsAdded();
    }
    setAdding(null);
  };

  const formatCost = (cost: number | null) => {
    if (cost === null || cost === 0) return 'Free';
    if (cost < 0.01) return `$${cost.toFixed(4)}`;
    return `$${cost.toFixed(2)}`;
  };

  return (
    <div className="space-y-3">
      <p className="text-sm text-white/55">
        {providerName} has thousands of models. Search for the ones you want to use.
      </p>

      <div className="flex gap-2">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
          placeholder="Search models... (e.g., claude, llama, gpt, mistral)"
          className="flex-1 glass-input"
        />
        <button
          onClick={handleSearch}
          disabled={searching || !query.trim()}
          className="glass-btn glass-btn-primary text-sm shrink-0"
        >
          {searching ? 'Searching...' : 'Search'}
        </button>
      </div>

      {results.length > 0 && (
        <div className="space-y-1.5 max-h-64 overflow-y-auto">
          {results.map((model) => (
            <div key={model.apiModelId} className="flex items-center justify-between glass-nested p-2.5 rounded-lg">
              <div className="min-w-0 flex-1">
                <div className="text-sm text-white/90 truncate">{model.name}</div>
                <div className="text-[10px] white/40 flex items-center gap-2 mt-0.5">
                  <span className="truncate">{model.apiModelId}</span>
                  {model.contextWindow && <span>{(model.contextWindow / 1000).toFixed(0)}k ctx</span>}
                  <span>In: {formatCost(model.inputCostPerM)}/M</span>
                  <span>Out: {formatCost(model.outputCostPerM)}/M</span>
                </div>
              </div>
              <button
                onClick={() => handleAdd(model)}
                disabled={adding === model.apiModelId}
                className="ml-2 px-3 py-1 text-xs bg-cp-teal/20 text-cp-teal hover:bg-cp-teal/30 disabled:bg-white/[0.05] disabled:white/30 rounded-lg transition-colors shrink-0"
              >
                {adding === model.apiModelId ? 'Adding...' : 'Add & Enable'}
              </button>
            </div>
          ))}
        </div>
      )}

      {searched && results.length === 0 && !searching && (
        <p className="text-xs white/30 text-center py-2">No models found matching &ldquo;{query}&rdquo;</p>
      )}

      {addedCount > 0 && (
        <p className="text-xs text-cp-teal">{addedCount} model{addedCount !== 1 ? 's' : ''} added and enabled.</p>
      )}
    </div>
  );
};

const ModelsStep = () => {
  const [models, setModels] = useState<Model[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadModels = async () => {
    const modelsResult = await api.getModels();
    if (modelsResult.ok) {
      setModels(modelsResult.data);
      const enabled = new Set<string>(modelsResult.data.filter((m: Model) => m.isEnabled).map((m: Model) => m.id));
      setSelected(enabled);
    }
  };

  useEffect(() => {
    const load = async () => {
      const providersResult = await api.getProviders();
      if (!providersResult.ok || providersResult.data.length === 0) {
        setLoading(false);
        setError('No providers configured. Go back and add a provider first.');
        return;
      }
      setProviders(providersResult.data);
      await loadModels();
      setLoading(false);
    };
    load();
  }, []);

  const hasAggregatorProviders = providers.some(p => p.type === 'openai-compatible');
  const hasDirectProviders = providers.some(p => p.type !== 'openai-compatible');

  const toggleModel = (id: string) => {
    setSaved(false);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleSave = async () => {
    const ids = Array.from(selected);
    if (ids.length > 0) await api.enableModels(ids);
    const toDisable = models.filter((m) => !selected.has(m.id)).map((m) => m.id);
    if (toDisable.length > 0) await api.disableModels(toDisable);
    setSaved(true);
  };

  if (loading) return <p className="text-white/55 text-center py-8">Loading models...</p>;
  if (error) return <p className="text-red-400 text-center py-8">{error}</p>;

  return (
    <div className="space-y-4">
      {/* Direct providers (Anthropic, OpenAI, Ollama): show toggle checkboxes */}
      {hasDirectProviders && models.length > 0 && (
        <>
          <p className="text-sm text-white/55">Select which models to enable. You can change this later in Settings.</p>
          <div className="space-y-2 max-h-64 overflow-y-auto">
            {models.map((model) => (
              <label key={model.id} className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-white/[0.04] cursor-pointer">
                <input type="checkbox" checked={selected.has(model.id)} onChange={() => toggleModel(model.id)}
                  className="w-4 h-4 rounded white/[0.10] bg-white/[0.08] text-blue-500 focus:ring-blue-500 focus:ring-offset-0" />
                <div>
                  <span className="text-sm white/90">{model.name}</span>
                  {model.contextWindow && (
                    <span className="text-xs text-white/40 ml-2">{Math.round(model.contextWindow / 1000)}k ctx</span>
                  )}
                </div>
              </label>
            ))}
          </div>
          <button onClick={handleSave} disabled={selected.size === 0}
            className={`px-4 py-2 text-white text-sm font-medium rounded-lg transition-colors ${
              saved ? 'bg-cp-teal text-[#0B0F1A] font-semibold' : 'glass-btn glass-btn-primary'
            }`}>
            {saved ? `\u2713 ${selected.size} Model(s) Enabled` : `Enable ${selected.size} Model(s)`}
          </button>
        </>
      )}

      {/* Aggregator providers (OpenRouter): show browse UI */}
      {providers.filter(p => p.type === 'openai-compatible').map(p => (
        <SetupBrowseModels key={p.id} providerId={p.id} providerName={p.name} onModelsAdded={loadModels} />
      ))}

      {/* No models at all and no aggregator */}
      {!hasAggregatorProviders && models.length === 0 && (
        <p className="text-white/55 text-center py-4">No models available from provider.</p>
      )}
    </div>
  );
};

// ── Your Profile ──

const YourProfileStep = ({ onReady }: { onReady?: (ready: boolean) => void }) => {
  const [userName, setUserName] = useState('');
  const [aboutYou, setAboutYou] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => { onReady?.(saved); }, [saved, onReady]);

  const handleSave = async () => {
    if (userName.trim()) {
      await api.setSetting('user_name', userName.trim());
      await api.setSetting('owner_name', userName.trim());
    }
    if (aboutYou.trim()) {
      await api.updateIdentity('USER.md', aboutYou.trim());
    }
    setSaved(true);
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-white/55">
        Tell us about yourself. Your agents will use this information to personalize their interactions with you.
        You can update this anytime in Settings &gt; Profile.
      </p>

      <div>
        <label className="block text-sm font-medium white/70 mb-1">Your Name</label>
        <input type="text" value={userName} onChange={(e) => setUserName(e.target.value)} placeholder="e.g., David"
          className="glass-input" />
      </div>

      <div>
        <label className="block text-sm font-medium white/70 mb-1">About You</label>
        <p className="text-xs text-white/40 mb-2">
          Your work, preferences, projects, communication style — anything you want your agents to know about you.
        </p>
        <textarea value={aboutYou} onChange={(e) => setAboutYou(e.target.value)} rows={5}
          placeholder="I run a small tech company in Seattle. I prefer concise, direct communication..."
          className="glass-textarea resize-none" />
      </div>

      {saved && (
        <div className="px-3 py-2 rounded-lg glass-badge-teal border border-cp-teal/20 text-sm">Profile saved!</div>
      )}

      <button onClick={handleSave} disabled={!userName.trim() || !aboutYou.trim() || saved}
        className={`px-4 py-2 text-white text-sm font-medium rounded-lg transition-colors ${
          saved ? 'bg-cp-teal text-[#0B0F1A] font-semibold' : 'glass-btn glass-btn-primary'
        }`}>
        {saved ? '\u2713 Profile Saved' : 'Save Profile'}
      </button>
    </div>
  );
};

// ── Primary Agent ──

const PrimaryAgentStep = ({ onReady }: { onReady?: (ready: boolean) => void }) => {
  const [agentName, setAgentName] = useState('');
  const [models, setModels] = useState<Model[]>([]);
  const [selectedModel, setSelectedModel] = useState('');
  const [style, setStyle] = useState('balanced');
  const [personality, setPersonality] = useState('');
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { onReady?.(saved); }, [saved, onReady]);

  useEffect(() => {
    api.getModels().then(r => {
      if (r.ok) {
        const enabled = r.data.filter((m: Model) => m.isEnabled);
        setModels(enabled);
        if (enabled.length > 0) setSelectedModel(enabled[0].id);
      }
    });
  }, []);

  const handleSave = async () => {
    if (!agentName.trim()) return;
    setError(null);

    // Generate agent ID from name
    const primaryId = agentName.trim().toLowerCase().replace(/[^a-z0-9]/g, '-');

    // Save config
    await api.setSetting('primary_agent_name', agentName.trim());
    await api.setSetting('primary_agent_id', primaryId);

    // Provision the agent in the database (creates or updates)
    const provisionResult = await fetch('/api/setup/provision-agent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: primaryId,
        name: agentName.trim(),
        modelId: selectedModel || undefined,
        classification: 'sensei',
      }),
    }).then(r => r.json());

    if (!provisionResult.ok) {
      setError(provisionResult.error ?? 'Failed to create agent');
      return;
    }

    // Generate identity files (SOUL.md etc.)
    const userNameResult = await api.getSetting('user_name');
    const userName = userNameResult.ok ? userNameResult.data.value ?? '' : '';
    await api.generateIdentity({
      agentName: agentName.trim(),
      communicationStyle: style,
      rules: personality.trim(),
      userName,
      userRole: '',
      userPreferences: '',
    });

    setSaved(true);
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-white/55">
        Your <strong className="white/90">primary agent</strong> is the main AI you'll interact with.
        It orchestrates everything — managing sub-agents, executing tasks, searching the web, controlling your Mac, and communicating with you via the dashboard and iMessage.
      </p>

      <div>
        <label className="block text-sm font-medium white/70 mb-1">Agent Name</label>
        <input type="text" value={agentName} onChange={(e) => setAgentName(e.target.value)} placeholder="e.g., Atlas, Friday, Jarvis"
          className="glass-input" />
      </div>

      {models.length > 0 && (
        <div>
          <label className="block text-sm font-medium white/70 mb-1">Model</label>
          <select value={selectedModel} onChange={(e) => setSelectedModel(e.target.value)}
            className="glass-select w-full">
            {models.map((m) => <option key={m.id} value={m.id}>{m.name} ({m.apiModelId})</option>)}
          </select>
        </div>
      )}

      <div>
        <label className="block text-sm font-medium white/70 mb-2">Communication Style</label>
        <div className="flex gap-4">
          {['casual', 'balanced', 'formal'].map((s) => (
            <label key={s} className="flex items-center gap-2 cursor-pointer">
              <input type="radio" name="style" value={s} checked={style === s} onChange={() => setStyle(s)}
                className="w-4 h-4 text-blue-500 bg-white/[0.08] white/[0.10] focus:ring-blue-500" />
              <span className="text-sm white/70 capitalize">{s}</span>
            </label>
          ))}
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium white/70 mb-1">
          Personality & Instructions <span className="text-white/30 font-normal">(optional)</span>
        </label>
        <p className="text-xs text-white/40 mb-2">
          Describe how this agent should behave — its tone, areas of expertise, things to avoid, or any special instructions.
          You can edit this later from the agent's Config tab.
        </p>
        <textarea value={personality} onChange={(e) => setPersonality(e.target.value)} rows={4}
          placeholder="e.g., Always explain your reasoning. Be proactive about suggesting improvements. Avoid making changes without asking first."
          className="glass-textarea resize-none" />
      </div>

      {error && <div className="px-3 py-2 rounded-lg bg-cp-coral/10 border border-cp-coral/20 text-cp-coral text-sm">{error}</div>}
      {saved && (
        <div className="px-3 py-2 rounded-lg glass-badge-teal border border-cp-teal/20 text-sm">
          {agentName} is configured!
        </div>
      )}

      <button onClick={handleSave} disabled={!agentName.trim() || saved}
        className={`px-4 py-2 text-white text-sm font-medium rounded-lg transition-colors ${
          saved ? 'bg-cp-teal text-[#0B0F1A] font-semibold' : 'glass-btn glass-btn-primary'
        }`}>
        {saved ? `\u2713 ${agentName} Configured` : `Configure ${agentName || 'Agent'}`}
      </button>
    </div>
  );
};

// ── Project Manager ──

const PMAgentStep = ({ onReady }: { onReady?: (ready: boolean) => void }) => {
  const [pmName, setPmName] = useState('');
  const [models, setModels] = useState<Model[]>([]);
  const [selectedModel, setSelectedModel] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => { onReady?.(saved); }, [saved, onReady]);

  useEffect(() => {
    api.getModels().then(r => {
      if (r.ok) {
        const enabled = r.data.filter((m: Model) => m.isEnabled);
        setModels(enabled);
        // Default to cheapest model (last in list, or first Ollama model)
        const ollamaModel = enabled.find((m: Model) => m.inputCostPerM === 0 || m.inputCostPerM === null);
        const cheapest = ollamaModel ?? enabled[enabled.length - 1];
        if (cheapest) setSelectedModel(cheapest.id);
      }
    });
  }, []);

  const handleSave = async () => {
    await api.setSetting('pm_agent_enabled', 'true');
    if (pmName.trim()) {
      const pmId = pmName.trim().toLowerCase().replace(/[^a-z0-9]/g, '-');
      await api.setSetting('pm_agent_name', pmName.trim());
      await api.setSetting('pm_agent_id', pmId);
      if (selectedModel) {
        await api.setSetting('pm_agent_model', selectedModel);
      }
    }
    setSaved(true);
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-white/55">
        The <strong className="white/90">project manager</strong> tracks tasks,
        pokes stalled work, and escalates issues. It runs on a lighter model to save costs and keeps your primary agent accountable.
      </p>

      <div>
        <label className="block text-sm font-medium white/70 mb-1">PM Name</label>
        <input type="text" value={pmName} onChange={(e) => { setPmName(e.target.value); setSaved(false); }}
          placeholder="e.g., Kelly, Max, Tracker"
          className="glass-input" />
      </div>

      {models.length > 0 && (
        <div>
          <label className="block text-sm font-medium white/70 mb-1">Model</label>
          <p className="text-xs text-white/40 mb-2">
            The PM uses a lighter model to save costs. A free local model works well here.
          </p>
          <select value={selectedModel} onChange={(e) => { setSelectedModel(e.target.value); setSaved(false); }}
            className="glass-select w-full">
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} ({m.apiModelId}){m.inputCostPerM === 0 || m.inputCostPerM === null ? ' — free' : ''}
              </option>
            ))}
          </select>
        </div>
      )}

      {saved && (
        <div className="px-3 py-2 rounded-lg glass-badge-teal border border-cp-teal/20 text-sm">
          {`${pmName} will manage your projects!`}
        </div>
      )}

      <button onClick={handleSave} disabled={saved || !pmName.trim()}
        className={`px-4 py-2 text-white text-sm font-medium rounded-lg transition-colors ${
          saved ? 'bg-cp-teal text-[#0B0F1A] font-semibold' : 'glass-btn glass-btn-primary'
        }`}>
        {saved ? '\u2713 Saved' : 'Save'}
      </button>
    </div>
  );
};

// ── Trainer Agent ──

const TrainerAgentStep = ({ onReady }: { onReady?: (ready: boolean) => void }) => {
  const [trainerName, setTrainerName] = useState('');
  const [models, setModels] = useState<Model[]>([]);
  const [selectedModel, setSelectedModel] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => { onReady?.(saved); }, [saved, onReady]);

  useEffect(() => {
    api.getModels().then(r => {
      if (r.ok) {
        const enabledModels = r.data.filter((m: Model) => m.isEnabled);
        setModels(enabledModels);
        const ollamaModel = enabledModels.find((m: Model) => m.inputCostPerM === 0 || m.inputCostPerM === null);
        const cheapest = ollamaModel ?? enabledModels[enabledModels.length - 1];
        if (cheapest) setSelectedModel(cheapest.id);
      }
    });
  }, []);

  const handleSave = async () => {
    await api.setSetting('trainer_agent_enabled', 'true');
    if (trainerName.trim()) {
      const trainerId = trainerName.trim().toLowerCase().replace(/[^a-z0-9]/g, '-');
      await api.setSetting('trainer_agent_name', trainerName.trim());
      await api.setSetting('trainer_agent_id', trainerId);
      if (selectedModel) {
        await api.setSetting('trainer_agent_model', selectedModel);
      }
    }
    setSaved(true);
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-white/55">
        The <strong className="white/90">technique trainer</strong> helps you create, refine, and manage
        reusable techniques for the dojo. It runs the Technique Trainer interface and ensures techniques are well-documented and useful.
      </p>

      <div>
        <label className="block text-sm font-medium white/70 mb-1">Trainer Name</label>
        <input type="text" value={trainerName} onChange={(e) => { setTrainerName(e.target.value); setSaved(false); }}
          placeholder="e.g., Sensei, Coach, Instructor"
          className="glass-input" />
      </div>

      {models.length > 0 && (
        <div>
          <label className="block text-sm font-medium white/70 mb-1">Model</label>
          <p className="text-xs text-white/40 mb-2">
            The Trainer uses the same model as other agents. A capable model works best here since it writes detailed instructions.
          </p>
          <select value={selectedModel} onChange={(e) => { setSelectedModel(e.target.value); setSaved(false); }}
            className="glass-select w-full">
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} ({m.apiModelId}){m.inputCostPerM === 0 || m.inputCostPerM === null ? ' — free' : ''}
              </option>
            ))}
          </select>
        </div>
      )}

      {saved && (
        <div className="px-3 py-2 rounded-lg glass-badge-teal border border-cp-teal/20 text-sm">
          {`${trainerName} will train your dojo's techniques!`}
        </div>
      )}

      <button onClick={handleSave} disabled={saved || !trainerName.trim()}
        className={`px-4 py-2 text-white text-sm font-medium rounded-lg transition-colors ${
          saved ? 'bg-cp-teal text-[#0B0F1A] font-semibold' : 'glass-btn glass-btn-primary'
        }`}>
        {saved ? '\u2713 Saved' : 'Save'}
      </button>
    </div>
  );
};

// ── Dreamer ──

const DreamerStep = ({ onReady }: { onReady?: (ready: boolean) => void }) => {
  const [models, setModels] = useState<Model[]>([]);
  const [selectedModel, setSelectedModel] = useState('');
  const [dreamTime, setDreamTime] = useState('03:00');
  const [dreamMode, setDreamMode] = useState<'full' | 'light'>('full');
  const [saved, setSaved] = useState(false);

  useEffect(() => { onReady?.(saved); }, [saved, onReady]);

  useEffect(() => {
    api.getModels().then(r => {
      if (r.ok) {
        const enabledModels = r.data.filter((m: Model) => m.isEnabled);
        setModels(enabledModels);
        // Default to a Sonnet-class model, or cheapest available
        const sonnet = enabledModels.find((m: Model) => m.apiModelId.includes('sonnet'));
        const fallback = enabledModels.find((m: Model) => m.inputCostPerM === 0 || m.inputCostPerM === null) ?? enabledModels[0];
        setSelectedModel((sonnet ?? fallback)?.id ?? '');
      }
    });
  }, []);

  const handleSave = async () => {
    await api.updateDreamingConfig({
      modelId: selectedModel || undefined,
      dreamTime,
      dreamMode,
    });
    setSaved(true);
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-white/55">
        Every night, the dojo <strong className="text-white/90">dreams</strong>. Just like humans consolidate memories during sleep,
        a temporary <strong className="text-white/90">Dreamer</strong> agent wakes up, processes the day's conversations, and
        extracts the important stuff into the dojo's long-term memory vault: facts, preferences, decisions,
        procedures, relationships, and events.
      </p>
      <p className="text-sm text-white/55">
        Without dreaming, your agents would gradually forget things as older conversations get compacted.
        The Dreamer makes sure nothing important is lost.
      </p>

      <div>
        <label className="block text-sm font-medium text-white/70 mb-1">Dreamer Model</label>
        <p className="text-xs text-white/40 mb-2">
          The model the Dreamer uses to read conversations and extract knowledge. A Standard tier model
          (like Sonnet) gives good quality at reasonable cost. A smaller model works but may miss subtleties.
        </p>
        {models.length > 0 && (
          <select value={selectedModel} onChange={(e) => { setSelectedModel(e.target.value); setSaved(false); }}
            className="glass-select w-full">
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} ({m.apiModelId}){m.inputCostPerM === 0 || m.inputCostPerM === null ? ' -- free' : ''}
              </option>
            ))}
          </select>
        )}
      </div>

      <div>
        <label className="block text-sm font-medium text-white/70 mb-1">Dream Time</label>
        <p className="text-xs text-white/40 mb-2">
          What time should the Dreamer run each night? Pick a time when the dojo is idle.
        </p>
        <input
          type="time"
          value={dreamTime}
          onChange={(e) => { setDreamTime(e.target.value); setSaved(false); }}
          className="glass-input w-full"
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-white/70 mb-2">Dream Mode</label>
        <div className="space-y-3">
          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="radio"
              name="setupDreamMode"
              checked={dreamMode === 'full'}
              onChange={() => { setDreamMode('full'); setSaved(false); }}
              className="mt-1 accent-blue-500"
            />
            <div>
              <span className="text-sm text-white/80 font-medium">Full Dream</span>
              <p className="text-xs text-white/40 mt-0.5">
                Extract memories from conversations AND identify reusable techniques.
                When the Dreamer spots a procedure that other agents could benefit from,
                it sends it to the Trainer to be turned into a proper technique.
              </p>
            </div>
          </label>
          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="radio"
              name="setupDreamMode"
              checked={dreamMode === 'light'}
              onChange={() => { setDreamMode('light'); setSaved(false); }}
              className="mt-1 accent-blue-500"
            />
            <div>
              <span className="text-sm text-white/80 font-medium">Light Dream</span>
              <p className="text-xs text-white/40 mt-0.5">
                Extract memories only. Faster and cheaper, but won't discover new techniques automatically.
              </p>
            </div>
          </label>
        </div>
      </div>

      {saved && (
        <div className="px-3 py-2 rounded-lg glass-badge-teal border border-cp-teal/20 text-sm">
          The Dreamer will process conversations every night at {dreamTime}.
        </div>
      )}

      <button onClick={handleSave} disabled={saved}
        className={`px-4 py-2 text-white text-sm font-medium rounded-lg transition-colors ${
          saved ? 'bg-cp-teal text-[#0B0F1A] font-semibold' : 'glass-btn glass-btn-primary'
        }`}>
        {saved ? '\u2713 Saved' : 'Save'}
      </button>
    </div>
  );
};

// ── iMessage ──

const IMessageStep = ({ onReady }: { onReady?: (ready: boolean) => void }) => {
  const [enabled, setEnabled] = useState(false);
  const [senders, setSenders] = useState<string[]>([]);
  const [defaultSender, setDefaultSender] = useState<string | null>(null);
  const [newSender, setNewSender] = useState('');
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { onReady?.(saved); }, [saved, onReady]);

  const addSender = () => {
    const s = newSender.trim();
    if (!s || senders.includes(s)) return;
    const updated = [...senders, s];
    setSenders(updated);
    if (updated.length === 1) setDefaultSender(s);
    setNewSender('');
    setSaved(false);
  };

  const removeSender = (index: number) => {
    const removed = senders[index];
    const updated = senders.filter((_, i) => i !== index);
    setSenders(updated);
    if (removed === defaultSender) setDefaultSender(updated[0] ?? null);
    setSaved(false);
  };

  const [sending, setSending] = useState(false);

  const handleSave = async () => {
    setError(null);
    if (enabled && senders.length === 0) {
      setError('Add at least one approved sender to enable iMessage.');
      return;
    }
    const effectiveDefault = defaultSender && senders.includes(defaultSender) ? defaultSender : senders[0] ?? '';
    await Promise.all([
      api.setSetting('imessage_enabled', enabled ? 'true' : 'false'),
      api.setSetting('imessage_approved_senders', JSON.stringify(senders)),
      api.setSetting('imessage_recipient', senders[0] ?? ''),
      api.setSetting('imessage_default_sender', effectiveDefault),
    ]);

    // Send welcome message to start the bridge and verify it works
    if (enabled && effectiveDefault) {
      setSending(true);
      const token = localStorage.getItem('dojo_token');
      const csrfMatch = document.cookie.match(/(?:^|;\s*)csrf=([^;]+)/);
      const csrf = csrfMatch ? csrfMatch[1] : null;
      try {
        const res = await fetch('/api/system/imessage/welcome', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
          },
          body: JSON.stringify({ recipient: effectiveDefault }),
        });
        const data = await res.json();
        if (!data.ok) {
          setError(`iMessage saved but welcome message failed: ${data.error}. You may need to grant Automation permission for Messages.`);
        }
      } catch {
        setError('Settings saved but could not send welcome message. Check Automation permissions.');
      }
      setSending(false);
    }

    setSaved(true);
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-white/55">
        The iMessage bridge lets you communicate with your agent via text message. It can send you alerts,
        respond to your questions, and receive commands — all through iMessage. Requires Full Disk Access (granted in a previous step).
      </p>

      <div className="flex items-center justify-between py-3 px-4 glass-nested rounded-xl">
        <div>
          <span className="text-sm font-medium white/90">Enable iMessage Bridge</span>
          <p className="text-xs text-white/40 mt-0.5">Send and receive messages with your agent via iMessage</p>
        </div>
        <button onClick={() => { setEnabled(!enabled); setSaved(false); }}
          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors duration-200 ${enabled ? 'bg-cp-teal' : 'bg-white/[0.12]'}`}>
          <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform duration-200 ${enabled ? 'translate-x-6' : 'translate-x-1'}`} />
        </button>
      </div>

      {enabled && (
        <div className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-white/55 mb-1">Approved Senders</label>
            <p className="text-xs text-white/30 mb-2">
              Phone numbers or Apple IDs your agent will accept messages from. Click the star to set the default sender for alerts.
            </p>
          </div>

          {senders.map((sender, i) => (
            <div key={i} className="flex items-center justify-between glass-nested rounded-xl px-3 py-2">
              <div className="flex items-center gap-2">
                <button onClick={() => { setDefaultSender(sender); setSaved(false); }}
                  className={`text-lg leading-none transition-colors ${sender === defaultSender ? 'text-yellow-400' : 'text-white/30 hover:text-yellow-400'}`}>
                  {sender === defaultSender ? '\u2605' : '\u2606'}
                </button>
                <span className="text-sm white/90 font-mono">{sender}</span>
              </div>
              <button onClick={() => removeSender(i)} className="text-white/40 hover:text-red-400">&times;</button>
            </div>
          ))}

          <div className="flex gap-2">
            <input type="text" value={newSender} onChange={(e) => setNewSender(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addSender()}
              placeholder="+15551234567 or user@icloud.com"
              className="glass-input flex-1 font-mono" />
            <button onClick={addSender} disabled={!newSender.trim()}
              className="px-3 py-2 glass-btn glass-btn-primary text-white text-sm rounded-lg transition-colors">
              Add
            </button>
          </div>
        </div>
      )}

      {error && <div className="px-3 py-2 rounded-lg bg-cp-coral/10 border border-cp-coral/20 text-cp-coral text-sm">{error}</div>}
      {saved && <div className="px-3 py-2 rounded-lg glass-badge-teal border border-cp-teal/20 text-sm">
        {enabled ? 'iMessage bridge configured! Check your phone for a welcome message.' : 'iMessage bridge disabled.'}
      </div>}

      <button onClick={handleSave} disabled={saved || sending}
        className={`px-4 py-2 text-white text-sm font-medium rounded-lg transition-colors ${
          saved ? 'bg-cp-teal text-[#0B0F1A] font-semibold' : 'glass-btn glass-btn-primary'
        }`}>
        {sending ? 'Sending welcome message...' : saved ? '\u2713 Saved' : enabled ? 'Save & Test iMessage' : 'Skip (Leave Disabled)'}
      </button>
    </div>
  );
};

// ── Google Workspace ──

const WorkspaceStep = () => {
  const [connected, setConnected] = useState(false);
  const [email, setEmail] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pollTimer, setPollTimer] = useState<ReturnType<typeof setInterval> | null>(null);

  // Step states
  const [gcloudLoggingIn, setGcloudLoggingIn] = useState(false);
  const [gcloudEmail, setGcloudEmail] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [settingUpProject, setSettingUpProject] = useState(false);
  const [hasCredentials, setHasCredentials] = useState(false);
  const [credentialJson, setCredentialJson] = useState('');
  const [credentialError, setCredentialError] = useState<string | null>(null);
  const [savingCredentials, setSavingCredentials] = useState(false);
  const [signingIn, setSigningIn] = useState(false);

  useEffect(() => {
    // Check current state on mount
    api.request<{ connected: boolean; email: string | null }>('/google/status').then(data => {
      if (data.ok && data.data.connected) {
        setConnected(true);
        setEmail(data.data.email);
        setSaved(true);
      }
    });
    api.request<{ hasCredentials: boolean }>('/google/credentials-check').then(data => {
      if (data.ok && data.data.hasCredentials) setHasCredentials(true);
    });
    // Check if gcloud is already authed (lightweight GET, no side effects)
    api.request<{ loggedIn: boolean; email?: string; projectId?: string | null }>('/google/gcloud-status').then(data => {
      if (data.ok && data.data.loggedIn) {
        setGcloudEmail(data.data.email ?? null);
        if (data.data.projectId) setProjectId(data.data.projectId);
      }
    });
    return () => { if (pollTimer) clearInterval(pollTimer); };
  }, []);

  // Step 1: Sign in to Google Cloud
  const handleGcloudLogin = async () => {
    setGcloudLoggingIn(true);
    setError(null);
    await api.request('/google/gcloud-login', { method: 'POST' });
    // Poll for gcloud auth completion — silently ignore errors (expected while auth is in progress)
    const timer = setInterval(async () => {
      const data = await api.request<{ loggedIn: boolean; email?: string; projectId?: string | null }>('/google/gcloud-status');
      if (data.ok && data.data.loggedIn) {
        // Auth detected — now run project setup
        const setup = await api.request<{ email: string; projectId: string }>('/google/gcloud-setup', { method: 'POST' });
        if (setup.ok) {
          setGcloudEmail(setup.data.email);
          setProjectId(setup.data.projectId);
          setGcloudLoggingIn(false);
          clearInterval(timer);
        }
      }
    }, 5000);
    setTimeout(() => { clearInterval(timer); setGcloudLoggingIn(false); }, 180000);
  };

  // Step 2 is manual (user creates OAuth credentials in console)

  // Step 3: Upload client_secret.json
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => { setCredentialJson(reader.result as string); setCredentialError(null); };
    reader.readAsText(file);
  };

  const handleSaveCredentials = async () => {
    setSavingCredentials(true);
    setCredentialError(null);
    const result = await api.request<{ saved: boolean }>('/google/credentials', {
      method: 'POST',
      body: JSON.stringify({ clientSecret: credentialJson }),
    });
    if (result.ok) { setHasCredentials(true); } else { setCredentialError(result.error); }
    setSavingCredentials(false);
  };

  // Step 4: Sign in with Google (gws auth login)
  const handleSignIn = async () => {
    setSigningIn(true);
    setError(null);
    const result = await api.request<{ message: string }>('/google/connect', { method: 'POST' });
    if (!result.ok) { setError(result.error); setSigningIn(false); return; }

    const timer = setInterval(async () => {
      const data = await api.request<{ working: boolean; email: string | null }>('/google/test', { method: 'POST' });
      if (data.ok && data.data.working) {
        setConnected(true);
        setEmail(data.data.email);
        setSigningIn(false);
        setSaved(true);
        clearInterval(timer);
        setPollTimer(null);
      }
    }, 3000);
    setPollTimer(timer);
    setTimeout(() => { clearInterval(timer); setPollTimer(null); setSigningIn(false); }, 180000);
  };

  const step1Done = !!gcloudEmail && !!projectId;
  const step3Done = hasCredentials;
  const step4Done = connected;

  // Already connected
  if (connected) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-white/55">
          Your agents can read and manage Gmail, Calendar, Drive, Docs, Sheets, and Slides.
        </p>
        <div className="px-3 py-3 rounded-lg bg-cp-teal/10 border border-cp-teal/20">
          <div className="flex items-center gap-2">
            <span className="text-cp-teal">{'\u2713'}</span>
            <span className="text-sm text-white/80">Connected as <strong className="text-white">{email}</strong></span>
          </div>
        </div>
      </div>
    );
  }

  if (saved) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-white/55">
          Connect a Google account to let your agents manage Gmail, Calendar, Drive, Docs, Sheets, and Slides.
        </p>
        <div className="px-3 py-2 rounded-lg bg-white/[0.05] text-white/40 text-sm">
          Google Workspace skipped. You can connect later in Settings.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-white/55">
        Connect a Google account to let your agents read and manage Gmail, Calendar, Drive, Docs, Sheets, and Slides.
        Your primary agent gets full access; other agents get read-only.
      </p>

      {/* Step 1: Sign in to Google Cloud */}
      <div className="glass-nested rounded-xl p-4 space-y-2">
        <div className="flex items-center gap-2">
          <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold ${step1Done ? 'bg-cp-teal text-[#0B0F1A]' : 'bg-white/[0.1] text-white/50'}`}>
            {step1Done ? '\u2713' : '1'}
          </span>
          <span className="text-sm font-medium text-white/90">Sign in to Google Cloud</span>
          {step1Done && <span className="text-xs text-white/40">({gcloudEmail})</span>}
        </div>
        {!step1Done && (
          <div className="ml-7 space-y-2">
            <p className="text-xs text-white/50">Opens your browser to sign in with your Google account.</p>
            <button onClick={handleGcloudLogin} disabled={gcloudLoggingIn}
              className="glass-btn glass-btn-primary text-xs">
              {gcloudLoggingIn ? 'Working...' : 'Sign in with Google'}
            </button>
            {gcloudLoggingIn && (
              <div className="px-3 py-3 rounded-lg bg-cp-amber/10 border border-cp-amber/20 text-xs space-y-2">
                <div className="flex items-center gap-2">
                  <span className="animate-spin text-cp-amber">{'\u{1F504}'}</span>
                  <span className="text-cp-amber font-medium">Setting up your Google Cloud connection...</span>
                </div>
                <p className="text-white/40">A browser window should open for you to sign in. After you approve, this page needs to configure your project and enable APIs. <strong className="text-white/50">This can take up to a minute</strong> — please don't navigate away.</p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Step 2: Create OAuth credentials (manual) */}
      <div className={`glass-nested rounded-xl p-4 space-y-2 ${!step1Done ? 'opacity-40 pointer-events-none' : ''}`}>
        <div className="flex items-center gap-2">
          <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold ${step3Done ? 'bg-cp-teal text-[#0B0F1A]' : 'bg-white/[0.1] text-white/50'}`}>
            {step3Done ? '\u2713' : '2'}
          </span>
          <span className="text-sm font-medium text-white/90">Create OAuth Credentials</span>
        </div>
        {!step3Done && step1Done && (
          <div className="ml-7 space-y-3">
            <ol className="text-xs text-white/50 space-y-2 list-decimal list-inside">
              <li>
                <a href={`https://console.cloud.google.com/apis/credentials/consent?project=${projectId}`} target="_blank" rel="noopener noreferrer"
                  className="text-blue-400 hover:underline">Open the OAuth consent screen</a>
                {' '}&mdash; click <strong className="text-white/70">Get Started</strong>, enter an app name (e.g. "Agent DOJO") and your email as support email, click <strong className="text-white/70">Next</strong>
              </li>
              <li>
                Select <strong className="text-white/70">External</strong> for audience, click <strong className="text-white/70">Next</strong>
              </li>
              <li>
                Enter your email as the contact address, agree to the data policy, click <strong className="text-white/70">Create</strong>
              </li>
              <li>
                <strong className="text-white/70">Add yourself as a test user:</strong> Go to{' '}
                <a href={`https://console.cloud.google.com/apis/credentials/consent?project=${projectId}`} target="_blank" rel="noopener noreferrer"
                  className="text-blue-400 hover:underline">OAuth consent screen</a>
                {' '}&gt; <strong className="text-white/70">Audience</strong> &gt; <strong className="text-white/70">Add users</strong> &gt; enter your Google email &gt; <strong className="text-white/70">Save</strong>
              </li>
              <li>
                <a href={`https://console.cloud.google.com/apis/credentials?project=${projectId}`} target="_blank" rel="noopener noreferrer"
                  className="text-blue-400 hover:underline">Go to Credentials</a>
                {' '}&mdash; click <strong className="text-white/70">Create Credentials</strong> &gt; <strong className="text-white/70">OAuth client ID</strong>
              </li>
              <li>
                Choose <strong className="text-white/70">Desktop app</strong>, give it a name (e.g. "DOJO"), click <strong className="text-white/70">Create</strong>
              </li>
              <li>
                On the confirmation dialog, click <strong className="text-white/70">Download JSON</strong> and upload it below
              </li>
            </ol>

            <p className="text-[10px] text-white/30">
              Note: Google says credentials may take up to 5 minutes to take effect. If step 3 fails, wait a moment and try again.
            </p>

            <div className="space-y-2">
              <div className="flex gap-2">
                <label className="flex-1 flex items-center justify-center px-3 py-2 rounded-lg border border-dashed border-white/[0.15] hover:border-white/[0.25] cursor-pointer transition-colors">
                  <input type="file" accept=".json" onChange={handleFileUpload} className="sr-only" />
                  <span className="text-xs text-white/40">
                    {credentialJson ? 'File loaded \u2713 — click Save' : 'Upload client_secret.json'}
                  </span>
                </label>
                <button onClick={handleSaveCredentials}
                  disabled={!credentialJson || savingCredentials}
                  className="px-3 py-2 glass-btn glass-btn-primary text-xs shrink-0 disabled:opacity-30">
                  {savingCredentials ? 'Saving...' : 'Save'}
                </button>
              </div>
              {credentialError && <p className="text-xs text-cp-coral">{credentialError}</p>}
            </div>
          </div>
        )}
      </div>

      {/* Step 3: Authorize access */}
      <div className={`glass-nested rounded-xl p-4 space-y-2 ${!step3Done ? 'opacity-40 pointer-events-none' : ''}`}>
        <div className="flex items-center gap-2">
          <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold ${step4Done ? 'bg-cp-teal text-[#0B0F1A]' : 'bg-white/[0.1] text-white/50'}`}>
            {step4Done ? '\u2713' : '3'}
          </span>
          <span className="text-sm font-medium text-white/90">Authorize Access</span>
        </div>
        {!step4Done && step3Done && (
          <div className="ml-7 space-y-2">
            <p className="text-xs text-white/50">Opens your browser one more time to grant Gmail, Calendar, Drive, Docs, Sheets, and Slides access.</p>
            <button onClick={handleSignIn} disabled={signingIn}
              className="glass-btn glass-btn-primary text-xs">
              {signingIn ? 'Waiting for authorization...' : 'Authorize Google Workspace'}
            </button>
            {signingIn && <p className="text-xs text-cp-amber animate-pulse">Approve the permissions in your browser.</p>}
          </div>
        )}
      </div>

      {error && <div className="px-3 py-2 rounded-lg bg-cp-coral/10 border border-cp-coral/20 text-cp-coral text-sm">{error}</div>}

      {/* Skip button */}
      <button onClick={() => setSaved(true)} disabled={saved}
        className={`px-4 py-2 text-white text-sm font-medium rounded-lg transition-colors ${
          saved ? 'bg-cp-teal text-[#0B0F1A] font-semibold' : 'glass-btn glass-btn-primary'
        }`}>
        {saved ? '\u2713 Skipped' : 'Skip (Set Up Later in Settings)'}
      </button>
    </div>
  );
};

// ── Web Search ──

const WebSearchStep = ({ onReady }: { onReady?: (ready: boolean) => void }) => {
  const [provider, setProvider] = useState('brave');
  const [apiKey, setApiKey] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => { onReady?.(saved); }, [saved, onReady]);
  const [validating, setValidating] = useState(false);
  const [validationResult, setValidationResult] = useState<'valid' | 'invalid' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    if (!apiKey.trim()) {
      // Skip — no key provided
      setSaved(true);
      return;
    }

    setValidating(true);
    setError(null);
    setValidationResult(null);

    // Validate the key
    const valResult = await api.validateSearchKey(provider, apiKey.trim());
    if (valResult.ok && valResult.data.valid) {
      setValidationResult('valid');
      // Save the config
      await api.setSearchConfig(provider, apiKey.trim());
      setSaved(true);
    } else {
      setValidationResult('invalid');
      setError('API key validation failed. Check your key and try again.');
    }
    setValidating(false);
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-white/55">
        Web search lets your agent search the internet for up-to-date information. This requires a Brave Search API key
        (free tier available at <span className="text-blue-400">brave.com/search/api</span>).
        You can skip this and add it later in Settings.
      </p>

      <div>
        <label className="block text-sm font-medium white/70 mb-1">Search Provider</label>
        <select value={provider} onChange={(e) => { setProvider(e.target.value); setSaved(false); }}
          className="glass-select w-full">
          <option value="brave">Brave Search</option>
        </select>
      </div>

      <div>
        <label className="block text-sm font-medium white/70 mb-1">
          API Key <span className="text-white/30 font-normal">(optional)</span>
        </label>
        <input type="password" value={apiKey} onChange={(e) => { setApiKey(e.target.value); setSaved(false); setValidationResult(null); }}
          placeholder="BSA..."
          className="glass-input" />
      </div>

      {validationResult === 'valid' && (
        <div className="px-3 py-2 rounded-lg glass-badge-teal border border-cp-teal/20 text-sm">API key validated!</div>
      )}
      {error && <div className="px-3 py-2 rounded-lg bg-cp-coral/10 border border-cp-coral/20 text-cp-coral text-sm">{error}</div>}
      {saved && !apiKey.trim() && (
        <div className="px-3 py-2 rounded-lg bg-white/[0.05] text-white/40 text-sm">Web search skipped. You can add a key later in Settings.</div>
      )}

      <button onClick={handleSave} disabled={validating || saved}
        className={`px-4 py-2 text-white text-sm font-medium rounded-lg transition-colors ${
          saved ? 'bg-cp-teal text-[#0B0F1A] font-semibold' : 'glass-btn glass-btn-primary'
        }`}>
        {validating ? 'Validating...' : saved ? '\u2713 Saved' : apiKey.trim() ? 'Validate & Save' : 'Skip for Now'}
      </button>
    </div>
  );
};

// ── Complete ──

const CompleteStep = () => {
  const [primaryName, setPrimaryName] = useState('');
  const [pmName, setPmName] = useState('');
  const [trainerName, setTrainerName] = useState('');

  useEffect(() => {
    const load = async () => {
      const [pn, pm, tn] = await Promise.all([
        api.getSetting('primary_agent_name'),
        api.getSetting('pm_agent_name'),
        api.getSetting('trainer_agent_name'),
      ]);
      if (pn.ok && pn.data.value) setPrimaryName(pn.data.value);
      if (pm.ok && pm.data.value) setPmName(pm.data.value);
      if (tn.ok && tn.data.value) setTrainerName(tn.data.value);
    };
    load();
  }, []);

  return (
    <div className="text-center space-y-4">
      <div className="text-5xl">&#128640;</div>
      <h3 className="text-xl font-semibold text-white">You're all set!</h3>
      <div className="text-sm text-white/55 space-y-1">
        <p>Primary agent: <strong className="white/90">{primaryName || 'Agent'}</strong></p>
        {pmName && <p>Project manager: <strong className="white/90">{pmName}</strong></p>}
        {trainerName && <p>Technique trainer: <strong className="white/90">{trainerName}</strong></p>}
      </div>
      <p className="text-sm text-white/40">
        Click <strong className="text-green-400">Launch</strong> to enter the dashboard and start chatting.
      </p>
    </div>
  );
};

// ── Launch ──

const LaunchButton = () => {
  const navigate = useNavigate();
  const [launching, setLaunching] = useState(false);

  const handleLaunch = async () => {
    setLaunching(true);
    await api.completeSetup();
    navigate('/');
  };

  return (
    <button onClick={handleLaunch} disabled={launching}
      className="px-6 py-2.5 bg-cp-amber hover:bg-cp-amber-light disabled:bg-white/10 text-white text-sm font-semibold rounded-lg transition-colors">
      {launching ? 'Launching...' : 'Launch'}
    </button>
  );
};
