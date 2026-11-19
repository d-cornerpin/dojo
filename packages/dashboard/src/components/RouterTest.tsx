import { useState } from 'react';

interface RouterTestResult {
  scores: Array<{ dimension: string; score: number; weight: number; weighted: number }>;
  rawScore: number;
  confidence: number;
  tier: string;
  method?: string;
  selectedModel: string;
}

interface RouterTestProps {
  onTest: (prompt: string) => Promise<RouterTestResult | { error: string }>;
}

const METHOD_WORDS: Record<string, string> = {
  semantic: 'Meaning match',
  fallback: 'Keyword backup',
  heuristic: 'Keyword backup',
  structural: 'Fixed rule',
};

export const RouterTest = ({ onTest }: RouterTestProps) => {
  const [prompt, setPrompt] = useState('');
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<RouterTestResult | null>(null);

  const [error, setError] = useState<string | null>(null);

  const handleTest = async () => {
    if (!prompt.trim()) return;
    setTesting(true);
    setResult(null);
    setError(null);
    try {
      const res = await onTest(prompt.trim());
      if ('error' in res) setError(res.error);
      else setResult(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="glass-card p-4">
      <h3 className="card-header mb-3">Test Router</h3>
      <p className="text-xs text-ui/40 mb-3">
        Enter a prompt to see the tier and model a turn with this prompt would get.
      </p>

      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        rows={3}
        placeholder="Enter a test prompt..."
        className="glass-textarea w-full resize-y mb-3"
      />

      <button
        onClick={handleTest}
        disabled={testing || !prompt.trim()}
        className="px-4 py-2 glass-btn-primary text-sm font-medium rounded-lg transition-colors"
      >
        {testing ? 'Testing...' : 'Test'}
      </button>

      {error && <p className="mt-3 text-xs text-cp-coral">Test failed: {error}</p>}

      {result && (
        <div className="mt-4 space-y-4">
          {/* Result summary */}
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <ResultCard label="Raw Score" value={result.rawScore.toFixed(3)} />
            <ResultCard label="Confidence" value={`${(result.confidence * 100).toFixed(0)}%`} />
            <ResultCard label="Selected Tier" value={result.tier} highlight />
            <ResultCard label="Selected Model" value={result.selectedModel} highlight />
            {result.method && <ResultCard label="Decided by" value={METHOD_WORDS[result.method] ?? result.method} />}
          </div>

          {/* Keyword backup scores: present only when the backup decided */}
          {result.scores.length > 0 && (<div>
            <h4 className="text-xs font-medium text-ui/55 uppercase tracking-wider mb-2">
              Keyword backup scores
            </h4>
            <div className="text-ui/25 rounded-lg overflow-hidden">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-ui/40 uppercase tracking-wider">
                    <th className="px-3 py-2 text-left">Dimension</th>
                    <th className="px-3 py-2 text-right">Score</th>
                    <th className="px-3 py-2 text-right">Weight</th>
                    <th className="px-3 py-2 text-right">Weighted</th>
                    <th className="px-3 py-2 w-32">Bar</th>
                  </tr>
                </thead>
                <tbody>
                  {result.scores.map((s) => (
                    <tr key={s.dimension} className="border-t border-ui/[0.06]">
                      <td className="px-3 py-1.5 text-ui/70">{s.dimension}</td>
                      <td className="px-3 py-1.5 text-ui/55 text-right font-mono">
                        {s.score.toFixed(3)}
                      </td>
                      <td className="px-3 py-1.5 text-ui/40 text-right font-mono">
                        {s.weight.toFixed(2)}
                      </td>
                      <td className="px-3 py-1.5 text-ui/70 text-right font-mono">
                        {s.weighted.toFixed(3)}
                      </td>
                      <td className="px-3 py-1.5">
                        <div className="bg-ui/[0.08] rounded-full h-2 overflow-hidden">
                          <div
                            className="h-full rounded-full bg-cp-blue"
                            style={{ width: `${Math.min(s.score * 100, 100)}%` }}
                          />
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>)}
        </div>
      )}
    </div>
  );
};

const ResultCard = ({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) => (
  <div className="text-ui/25 rounded-lg px-3 py-2">
    <p className="text-xs text-ui/40 mb-0.5">{label}</p>
    <p className={`text-sm font-medium ${highlight ? 'text-cp-blue' : 'text-ui'}`}>
      {value}
    </p>
  </div>
);
