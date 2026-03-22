import { useState, useEffect, useRef, useCallback } from 'react';
import type { SearchResult } from '@dojo/shared';
import * as api from '../lib/api';
import { parseUtc } from '../lib/dates';

type SearchScope = 'both' | 'messages' | 'summaries';
type SearchMode = 'text' | 'semantic';

interface MemorySearchProps {
  agentId: string;
  onSelectResult: (id: string, type: 'message' | 'summary') => void;
}

// Unified result type that handles both FTS and vector results
interface UnifiedResult {
  id: string;
  type: 'message' | 'summary';
  snippet: string;
  timestamp: string;
  tokenCount: number;
  similarity?: number;
  source?: 'keyword' | 'semantic';
}

export const MemorySearch = ({ agentId, onSelectResult }: MemorySearchProps) => {
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<SearchScope>('both');
  const [mode, setMode] = useState<SearchMode>('text');
  const [results, setResults] = useState<UnifiedResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [embeddingsAvailable, setEmbeddingsAvailable] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Check if embeddings are available for this agent
  useEffect(() => {
    api.getEmbeddingStatus().then((res) => {
      if (res.ok) {
        setEmbeddingsAvailable(res.data.embedded > 0);
      }
    });
  }, [agentId]);

  const doSearch = useCallback(
    async (q: string) => {
      if (!q.trim()) {
        setResults([]);
        setSearched(false);
        return;
      }
      setLoading(true);

      if (mode === 'semantic') {
        // Vector search
        const result = await api.vectorSearchMemory(q, agentId, 20);
        if (result.ok) {
          setResults(
            result.data.map((r) => ({
              id: r.sourceId,
              type: r.sourceType as 'message' | 'summary',
              snippet: r.preview,
              timestamp: '',
              tokenCount: 0,
              similarity: r.similarity,
              source: 'semantic' as const,
            })),
          );
        } else {
          setResults([]);
        }
      } else {
        // FTS search
        const result = await api.searchMemory(agentId, q, scope, 20);
        if (result.ok) {
          setResults(
            result.data.map((r: SearchResult) => ({
              ...r,
              source: 'keyword' as const,
            })),
          );
        } else {
          setResults([]);
        }
      }

      setSearched(true);
      setLoading(false);
    },
    [agentId, scope, mode],
  );

  useEffect(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }
    debounceRef.current = setTimeout(() => {
      doSearch(query);
    }, mode === 'semantic' ? 500 : 300); // slightly longer debounce for semantic (API call)
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, [query, doSearch, mode]);

  const formatTimestamp = (ts: string) => {
    if (!ts) return '';
    const d = parseUtc(ts);
    if (!d) return '';
    return d.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const highlightMatch = (text: string, q: string) => {
    if (!q.trim()) return text;
    const regex = new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    const parts = text.split(regex);
    return parts.map((part, i) =>
      regex.test(part) ? (
        <mark key={i} className="bg-yellow-500/30 text-yellow-200 rounded px-0.5">
          {part}
        </mark>
      ) : (
        part
      ),
    );
  };

  const formatSimilarity = (sim: number) => {
    const pct = Math.round(sim * 100);
    const color =
      pct >= 80 ? 'text-green-400' : pct >= 60 ? 'text-yellow-400' : 'white/55';
    return <span className={`${color} font-mono`}>{pct}%</span>;
  };

  return (
    <div className="flex flex-col h-full">
      {/* Search input */}
      <div className="px-4 py-3 border-b white/[0.06] space-y-2">
        <div className="relative">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={
              mode === 'semantic'
                ? 'Semantic search — describe what you recall...'
                : 'Search memory...'
            }
            className="w-full bg-white/[0.05] border white/[0.08] rounded-lg pl-9 pr-3 py-2 text-sm white/90 placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
          <span className="absolute left-3 top-1/2 -translate-y-1/2 white/40 text-sm">
            {mode === 'semantic' ? '\u2731' : '?'}
          </span>
          {loading && (
            <span className="absolute right-3 top-1/2 -translate-y-1/2 white/40 text-xs">
              ...
            </span>
          )}
        </div>

        {/* Mode + Scope toggles */}
        <div className="flex items-center gap-3">
          {/* Search mode toggle */}
          <div className="flex gap-1 white/[0.03] rounded-lg p-0.5">
            <button
              onClick={() => setMode('text')}
              className={`px-2.5 py-1 text-xs rounded transition-colors ${
                mode === 'text'
                  ? 'bg-blue-600/20 text-blue-400'
                  : 'white/40 hover:white/70'
              }`}
            >
              Text
            </button>
            <button
              onClick={() => setMode('semantic')}
              disabled={!embeddingsAvailable}
              title={
                embeddingsAvailable
                  ? 'Search by meaning using vector embeddings'
                  : 'No embeddings available — run backfill first'
              }
              className={`px-2.5 py-1 text-xs rounded transition-colors ${
                mode === 'semantic'
                  ? 'bg-purple-600/20 text-purple-400'
                  : embeddingsAvailable
                    ? 'white/40 hover:white/70'
                    : 'text-gray-700 cursor-not-allowed'
              }`}
            >
              Semantic
            </button>
          </div>

          {/* Divider */}
          <div className="w-px h-4 bg-white/[0.08]" />

          {/* Scope toggle (only for text mode) */}
          <div className={`flex gap-1 ${mode === 'semantic' ? 'opacity-40 pointer-events-none' : ''}`}>
            {(['both', 'messages', 'summaries'] as SearchScope[]).map((s) => (
              <button
                key={s}
                onClick={() => setScope(s)}
                className={`px-2.5 py-1 text-xs rounded transition-colors ${
                  scope === s
                    ? 'bg-blue-600/20 text-blue-400'
                    : 'bg-white/[0.05] white/40 hover:white/70'
                }`}
              >
                {s.charAt(0).toUpperCase() + s.slice(1)}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Results */}
      <div className="flex-1 overflow-y-auto">
        {!searched && !loading && (
          <div className="p-4 text-center white/40 text-sm">
            {mode === 'semantic'
              ? 'Describe what you remember — finds similar content even without exact keywords'
              : 'Type to search messages and summaries'}
          </div>
        )}
        {searched && results.length === 0 && !loading && (
          <div className="p-4 text-center white/40 text-sm">
            No results found
          </div>
        )}
        {results.map((result, idx) => (
          <button
            key={`${result.id}-${idx}`}
            onClick={() => onSelectResult(result.id, result.type)}
            className="w-full text-left px-4 py-3 border-b white/[0.04] hover:white/[0.03] transition-colors"
          >
            <div className="flex items-center gap-2 mb-1">
              <span
                className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                  result.type === 'message'
                    ? 'bg-blue-500/20 text-blue-400'
                    : 'bg-green-500/20 text-green-400'
                }`}
              >
                {result.type}
              </span>
              {result.similarity !== undefined && (
                <span className="text-[10px]">
                  {formatSimilarity(result.similarity)}
                </span>
              )}
              {result.timestamp && (
                <span className="text-[10px] white/40">
                  {formatTimestamp(result.timestamp)}
                </span>
              )}
              {result.tokenCount > 0 && (
                <span className="text-[10px] white/30">
                  {result.tokenCount} tokens
                </span>
              )}
            </div>
            <div className="text-xs white/70 line-clamp-2">
              {mode === 'text' ? highlightMatch(result.snippet, query) : result.snippet}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
};
