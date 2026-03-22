import { useState, useEffect } from 'react';

interface TechniqueOption {
  id: string;
  name: string;
}

interface TechniqueSelectorProps {
  selected: string[];
  onChange: (techniques: string[]) => void;
}

export const TechniqueSelector = ({ selected, onChange }: TechniqueSelectorProps) => {
  const [techniques, setTechniques] = useState<TechniqueOption[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = localStorage.getItem('dojo_token');
    fetch('/api/techniques?state=published', {
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    }).then(r => r.json()).then(data => {
      if (data.ok) setTechniques(data.data.map((t: { id: string; name: string }) => ({ id: t.id, name: t.name })));
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  const available = techniques.filter(t => !selected.includes(t.id));
  const selectedTechniques = selected.map(id => techniques.find(t => t.id === id)).filter(Boolean) as TechniqueOption[];

  const handleAdd = (id: string) => {
    onChange([...selected, id]);
    setShowAdd(false);
  };

  const handleRemove = (id: string) => {
    onChange(selected.filter(s => s !== id));
  };

  if (loading) return <p className="text-xs white/30">Loading techniques...</p>;
  if (techniques.length === 0) return null;

  return (
    <div className="space-y-1.5">
      {/* Selected techniques */}
      {selectedTechniques.map(t => (
        <div key={t.id} className="flex items-center justify-between px-3 py-1.5 glass-nested rounded-lg">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-xs">{'\u{1F94B}'}</span>
            <span className="text-xs white/80 truncate">{t.name}</span>
            <span className="text-[10px] white/25 font-mono shrink-0">{t.id}</span>
          </div>
          <button
            onClick={() => handleRemove(t.id)}
            className="text-white/20 hover:text-cp-coral text-sm shrink-0 ml-2 transition-colors"
          >
            &times;
          </button>
        </div>
      ))}

      {/* Add button / dropdown */}
      {showAdd ? (
        <div className="flex items-center gap-2">
          <select
            defaultValue=""
            onChange={(e) => { if (e.target.value) handleAdd(e.target.value); }}
            className="flex-1 px-2 py-1.5 bg-white/[0.05] border white/[0.08] rounded-lg text-xs white/90 focus:outline-none focus:ring-1 focus:ring-blue-500"
            autoFocus
          >
            <option value="" disabled>Select a technique...</option>
            {available.map(t => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
          <button
            onClick={() => setShowAdd(false)}
            className="text-xs white/40 hover:white/70 transition-colors shrink-0"
          >
            Cancel
          </button>
        </div>
      ) : (
        available.length > 0 && (
          <button
            onClick={() => setShowAdd(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-white/40 hover:text-white/70 hover:bg-white/[0.04] rounded-lg transition-colors"
          >
            <span className="text-sm">+</span> Add technique
          </button>
        )
      )}

      {selected.length === 0 && !showAdd && (
        <p className="text-[10px] white/25">No techniques equipped. Equipped techniques are pre-loaded into the agent's context.</p>
      )}
    </div>
  );
};
