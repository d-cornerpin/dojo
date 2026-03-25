import { useState, useEffect } from 'react';

interface OgData {
  url: string;
  title: string | null;
  description: string | null;
  image: string | null;
  siteName: string | null;
}

// Cache previews so we don't re-fetch on every render
const previewCache = new Map<string, OgData | null>();

export const LinkPreview = ({ url }: { url: string }) => {
  const [data, setData] = useState<OgData | null>(previewCache.get(url) ?? null);
  const [loading, setLoading] = useState(!previewCache.has(url));
  const [imgError, setImgError] = useState(false);

  useEffect(() => {
    if (previewCache.has(url)) {
      setData(previewCache.get(url) ?? null);
      setLoading(false);
      return;
    }

    const token = localStorage.getItem('dojo_token');
    fetch(`/api/og-preview?url=${encodeURIComponent(url)}`, {
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    })
      .then(r => r.json())
      .then(res => {
        const ogData = res.ok ? res.data : null;
        previewCache.set(url, ogData);
        setData(ogData);
        setLoading(false);
      })
      .catch(() => {
        previewCache.set(url, null);
        setLoading(false);
      });
  }, [url]);

  // No preview data or still loading — just render a clickable link
  if (loading || !data || (!data.title && !data.description && !data.image)) {
    return (
      <a href={url} target="_blank" rel="noopener noreferrer"
        className="text-blue-400 hover:underline break-all">
        {url}
      </a>
    );
  }

  const hostname = (() => {
    try { return new URL(url).hostname.replace('www.', ''); } catch { return ''; }
  })();

  return (
    <a href={url} target="_blank" rel="noopener noreferrer"
      className="block my-2 rounded-lg border border-white/[0.08] hover:border-white/[0.15] bg-white/[0.03] hover:bg-white/[0.05] transition-colors overflow-hidden no-underline">
      {data.image && !imgError && (
        <div className="w-full h-36 overflow-hidden bg-white/[0.02]">
          <img
            src={data.image}
            alt=""
            className="w-full h-full object-cover"
            onError={() => setImgError(true)}
          />
        </div>
      )}
      <div className="px-3 py-2.5">
        {(data.siteName || hostname) && (
          <p className="text-[10px] text-white/30 mb-0.5 truncate">
            {data.siteName ?? hostname}
          </p>
        )}
        {data.title && (
          <p className="text-sm font-medium text-white/90 leading-snug line-clamp-2">
            {data.title}
          </p>
        )}
        {data.description && (
          <p className="text-xs text-white/50 mt-1 leading-relaxed line-clamp-2">
            {data.description}
          </p>
        )}
      </div>
    </a>
  );
};
