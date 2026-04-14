import { useState, useEffect, useCallback } from 'react';

interface Attachment {
  fileId: string;
  filename: string;
  mimeType: string;
  size: number;
  path: string;
  category: string;
}

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function getFileIcon(category: string, ext: string): string {
  switch (category) {
    case 'pdf': return '\uD83D\uDCC4';
    case 'text': return '\uD83D\uDCDD';
    case 'office': return '\uD83D\uDCCA';
    default: return '\uD83D\uDCCE';
  }
}

// Build the serve URL from the upload path
function getImageUrl(att: Attachment): string {
  // path is like /Users/.../uploads/{agentId}/{timestamp}_{filename}
  const parts = att.path.split('/');
  const filename = parts[parts.length - 1];
  const agentId = parts[parts.length - 2];
  return `/api/upload/file/${agentId}/${filename}`;
}

// Near-full-screen image viewer used for every chat image (user uploads,
// iMessage attachments, and Imaginer-generated images). ~90% viewport,
// dark backdrop, top-right Download + Close controls, Esc closes,
// D triggers download, clicking outside the image closes too.
const ImageLightbox = ({
  src,
  alt,
  caption,
  onClose,
}: {
  src: string;
  alt: string;
  caption?: string | null;
  onClose: () => void;
}) => {
  const handleDownload = useCallback(() => {
    // Build a sensible default filename. If the alt (usually the original
    // file name) already has an extension we use it directly; otherwise
    // fall back to `dojo-image-<timestamp>.png`.
    const hasExt = /\.[a-zA-Z0-9]{2,5}$/.test(alt);
    const filename = hasExt
      ? alt
      : `dojo-image-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.png`;

    // Anchor-download approach works cross-origin for same-origin URLs
    // (which our /api/upload/file/... paths are). For remote URLs or data
    // URLs the browser will still try the download attribute.
    const a = document.createElement('a');
    a.href = src;
    a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }, [src, alt]);

  // Global keyboard: Esc closes, D downloads
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if ((e.key === 'd' || e.key === 'D') && !e.metaKey && !e.ctrlKey && !e.altKey) {
        // Avoid hijacking browser devtools / Cmd+D bookmark shortcut
        e.preventDefault();
        handleDownload();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handleDownload, onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col items-center justify-center cursor-pointer"
      style={{ background: 'var(--overlay-dark)' }}
      onClick={onClose}
    >
      {/* Top-right controls — stopPropagation so clicking buttons
          doesn't also close the modal via the backdrop click. */}
      <div
        className="absolute top-4 right-4 flex items-center gap-2"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={handleDownload}
          title="Download image (D)"
          className="px-3 py-1.5 rounded-lg bg-white/[0.08] hover:bg-white/[0.15] border border-white/[0.12] text-xs text-white/85 font-medium backdrop-blur transition-colors"
        >
          <span aria-hidden>⬇</span> Download
        </button>
        <button
          onClick={onClose}
          title="Close (Esc)"
          className="w-9 h-9 flex items-center justify-center rounded-lg bg-white/[0.08] hover:bg-white/[0.15] border border-white/[0.12] text-white/85 backdrop-blur transition-colors"
          aria-label="Close"
        >
          <span className="text-xl leading-none">×</span>
        </button>
      </div>

      {/* Image — scaled to ~90% viewport, preserve aspect ratio */}
      <img
        src={src}
        alt={alt}
        onClick={(e) => e.stopPropagation()}
        style={{
          maxWidth: '90vw',
          maxHeight: caption ? '80vh' : '88vh',
          objectFit: 'contain',
          borderRadius: '8px',
          boxShadow: '0 20px 60px rgba(0,0,0,0.6)',
          cursor: 'default',
        }}
      />

      {/* Optional caption */}
      {caption && (
        <div
          className="mt-4 max-w-3xl text-center text-xs text-white/60 px-4"
          onClick={(e) => e.stopPropagation()}
          style={{ cursor: 'default' }}
        >
          {caption}
        </div>
      )}

      {/* Keyboard hint */}
      <div className="absolute bottom-4 left-1/2 -translate-x-1/2 text-[10px] text-white/25">
        Press <kbd className="px-1 py-0.5 rounded bg-white/[0.08] border border-white/[0.12] text-white/40">D</kbd> to download ·
        <kbd className="ml-1 px-1 py-0.5 rounded bg-white/[0.08] border border-white/[0.12] text-white/40">Esc</kbd> to close
      </div>
    </div>
  );
};

export const AttachmentChips = ({ attachments }: { attachments: Attachment[] }) => {
  const [lightboxSrc, setLightboxSrc] = useState<{ src: string; alt: string } | null>(null);

  if (!attachments || attachments.length === 0) return null;

  const images = attachments.filter(a => IMAGE_TYPES.has(a.mimeType));
  const files = attachments.filter(a => !IMAGE_TYPES.has(a.mimeType));

  return (
    <>
      {lightboxSrc && (
        <ImageLightbox src={lightboxSrc.src} alt={lightboxSrc.alt} onClose={() => setLightboxSrc(null)} />
      )}

      <div className="flex flex-wrap gap-1.5 mt-2">
        {/* Image thumbnails */}
        {images.length > 0 && (
          <div className="flex gap-1">
            {images.map((att, i) => {
              const url = getImageUrl(att);
              // Stack effect for multiple images
              const isStacked = images.length > 1;
              return (
                <div
                  key={att.fileId || i}
                  className="relative cursor-pointer group"
                  style={isStacked && i > 0 ? { marginLeft: '-8px' } : undefined}
                  onClick={() => setLightboxSrc({ src: url, alt: att.filename })}
                >
                  <img
                    src={url}
                    alt={att.filename}
                    className="w-14 h-14 rounded-lg object-cover border-2 border-white/10 group-hover:border-white/30 transition-colors shadow-md"
                    style={isStacked ? { boxShadow: '0 2px 8px rgba(0,0,0,0.4)' } : undefined}
                  />
                  {/* Count badge for stacked images */}
                  {isStacked && i === images.length - 1 && images.length > 2 && (
                    <div className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-white/20 backdrop-blur-sm text-[9px] text-white font-bold flex items-center justify-center border border-white/20">
                      {images.length}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* File chips */}
        {files.map((att, i) => {
          const ext = att.filename.split('.').pop()?.toUpperCase() || '?';
          const icon = getFileIcon(att.category, ext);
          return (
            <div
              key={att.fileId || i}
              className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-white/[0.06] border border-white/[0.08] text-[11px]"
            >
              <span>{icon}</span>
              <span className="text-white/70 truncate max-w-[120px]">{att.filename}</span>
              <span className="text-white/30">{formatSize(att.size)}</span>
            </div>
          );
        })}
      </div>
    </>
  );
};
