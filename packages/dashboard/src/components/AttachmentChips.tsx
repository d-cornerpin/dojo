import { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';

interface Attachment {
  fileId: string;
  filename: string;
  mimeType: string;
  size: number;
  path: string;
  category: string;
}

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const AUDIO_TYPES = new Set(['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/wave',
  'audio/x-wav', 'audio/ogg', 'audio/opus', 'audio/webm', 'audio/aac', 'audio/m4a',
  'audio/x-m4a', 'audio/mp4']);
const VIDEO_TYPES = new Set(['video/mp4', 'video/quicktime', 'video/webm',
  'video/x-matroska', 'video/x-msvideo']);

function isAudio(mime: string): boolean {
  return AUDIO_TYPES.has(mime) || mime.startsWith('audio/');
}
function isVideo(mime: string): boolean {
  return VIDEO_TYPES.has(mime) || mime.startsWith('video/');
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function getFileIcon(category: string, _ext: string): string {
  switch (category) {
    case 'pdf': return '\uD83D\uDCC4';
    case 'text': return '\uD83D\uDCDD';
    case 'office': return '\uD83D\uDCCA';
    case 'audio': return '\uD83C\uDFB5';  // musical note
    case 'video': return '\uD83C\uDFAC';  // clapper board
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

  // Global keyboard: Esc closes, D downloads. Also lock body scroll so
  // the chat behind the lightbox doesn't scroll when the user wheels
  // over the modal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      } else if ((e.key === 'd' || e.key === 'D') && !e.metaKey && !e.ctrlKey && !e.altKey) {
        // Avoid hijacking browser devtools / Cmd+D bookmark shortcut
        e.preventDefault();
        handleDownload();
      }
    };
    window.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [handleDownload, onClose]);

  // Render the lightbox at document.body via portal so its lifecycle is
  // fully independent of whichever message bubble's AttachmentChips
  // happened to open it. Without the portal, a parent re-render or a
  // CSS ancestor with `transform`/`filter`/`backdrop-filter` could clip
  // or break the fixed positioning, leaving the modal stuck mid-screen
  // with broken close behavior — the symptom: "I have to refresh the
  // page to make the image go away."
  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex flex-col items-center justify-center cursor-pointer"
      style={{ background: 'var(--overlay-dark)' }}
      onClick={onClose}
    >
      {/* Image + overlay controls wrapper. `relative inline-block`
          sizes the wrapper to the image so the absolutely-positioned
          buttons land on the image's top-right corner instead of the
          viewport corner (where they previously sat over empty
          dark space and were nearly invisible). */}
      <div
        className="relative inline-block"
        onClick={(e) => e.stopPropagation()}
        style={{ lineHeight: 0 /* kill the inline-block baseline gap below the img */ }}
      >
        <img
          src={src}
          alt={alt}
          style={{
            maxWidth: '90vw',
            maxHeight: caption ? '80vh' : '88vh',
            objectFit: 'contain',
            borderRadius: '8px',
            boxShadow: '0 20px 60px rgba(0,0,0,0.6)',
            cursor: 'default',
            display: 'block',
          }}
        />

        {/* Top-right controls overlaid on the image itself. Solid
            backdrop + white text gives high contrast against any
            image content (light, dark, busy). */}
        <div className="absolute top-3 right-3 flex items-center gap-2">
          <button
            onClick={handleDownload}
            title="Download image (D)"
            className="px-3 py-1.5 rounded-lg bg-black/60 hover:bg-black/75 border border-white/20 text-xs text-white font-medium backdrop-blur transition-colors"
          >
            <span aria-hidden>⬇</span> Download
          </button>
          <button
            onClick={onClose}
            title="Close (Esc)"
            className="w-9 h-9 flex items-center justify-center rounded-lg bg-black/60 hover:bg-black/75 border border-white/20 text-white backdrop-blur transition-colors"
            aria-label="Close"
          >
            <span className="text-xl leading-none">×</span>
          </button>
        </div>
      </div>

      {/* Optional caption */}
      {caption && (
        <div
          className="mt-4 max-w-3xl text-center text-xs text-ui/55 px-4"
          onClick={(e) => e.stopPropagation()}
          style={{ cursor: 'default' }}
        >
          {caption}
        </div>
      )}

      {/* Keyboard hint */}
      <div className="absolute bottom-4 left-1/2 -translate-x-1/2 text-[10px] text-ui/25">
        Press <kbd className="px-1 py-0.5 rounded bg-ui/[0.08] border border-ui/[0.15] text-ui/40">D</kbd> to download ·
        <kbd className="ml-1 px-1 py-0.5 rounded bg-ui/[0.08] border border-ui/[0.15] text-ui/40">Esc</kbd> to close
      </div>
    </div>,
    document.body,
  );
};

// Inline audio chip. Compact filename + size header above a native
// <audio controls> element. The /api/upload/file route streams with
// Range support so seek scrubbing works without buffering the whole
// clip first.
const AudioChip = ({ att }: { att: Attachment }) => {
  const url = getImageUrl(att); // same path-derivation as images
  return (
    <div className="flex flex-col gap-1 px-2 py-1.5 rounded-lg bg-ui/[0.08] border border-ui/[0.10] min-w-[260px] max-w-[420px]">
      <div className="flex items-center gap-1.5 text-[11px]">
        <span>🎵</span>
        <span className="text-ui/70 truncate flex-1">{att.filename}</span>
        <span className="text-ui/25">{formatSize(att.size)}</span>
      </div>
      <audio controls preload="metadata" src={url} className="w-full h-8" />
    </div>
  );
};

// Inline video chip. Browser handles its own playback controls and
// poster frame. Constrained to a reasonable max-width so a single
// chip doesn't dominate the chat column.
const VideoChip = ({ att }: { att: Attachment }) => {
  const url = getImageUrl(att);
  return (
    <div className="flex flex-col gap-1 rounded-lg overflow-hidden bg-ui/[0.06] border border-ui/[0.10] max-w-[480px]">
      <video
        controls
        preload="metadata"
        src={url}
        className="w-full max-h-[360px] bg-black/30"
      />
      <div className="flex items-center gap-1.5 px-2 py-1 text-[11px]">
        <span>🎬</span>
        <span className="text-ui/70 truncate flex-1">{att.filename}</span>
        <span className="text-ui/25">{formatSize(att.size)}</span>
      </div>
    </div>
  );
};

export const AttachmentChips = ({ attachments }: { attachments: Attachment[] }) => {
  const [lightboxSrc, setLightboxSrc] = useState<{ src: string; alt: string } | null>(null);

  if (!attachments || attachments.length === 0) return null;

  const images = attachments.filter(a => IMAGE_TYPES.has(a.mimeType));
  const audios = attachments.filter(a => !IMAGE_TYPES.has(a.mimeType) && isAudio(a.mimeType));
  const videos = attachments.filter(a => !IMAGE_TYPES.has(a.mimeType) && isVideo(a.mimeType));
  const files = attachments.filter(a =>
    !IMAGE_TYPES.has(a.mimeType) && !isAudio(a.mimeType) && !isVideo(a.mimeType)
  );

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
                    className="w-14 h-14 rounded-lg object-cover border-2 border-ui/[0.10] group-hover:border-ui/[0.15] transition-colors shadow-md"
                    style={isStacked ? { boxShadow: '0 2px 8px rgba(0,0,0,0.4)' } : undefined}
                  />
                  {/* Count badge for stacked images */}
                  {isStacked && i === images.length - 1 && images.length > 2 && (
                    <div className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-ui/[0.12] backdrop-blur-sm text-[9px] text-ui font-bold flex items-center justify-center border border-ui/[0.15]">
                      {images.length}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Audio chips */}
        {audios.map((att, i) => (
          <AudioChip key={att.fileId || `a-${i}`} att={att} />
        ))}

        {/* Video chips */}
        {videos.map((att, i) => (
          <VideoChip key={att.fileId || `v-${i}`} att={att} />
        ))}

        {/* File chips */}
        {files.map((att, i) => {
          const ext = att.filename.split('.').pop()?.toUpperCase() || '?';
          const icon = getFileIcon(att.category, ext);
          return (
            <div
              key={att.fileId || i}
              className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-ui/[0.08] border border-ui/[0.10] text-[11px]"
            >
              <span>{icon}</span>
              <span className="text-ui/70 truncate max-w-[120px]">{att.filename}</span>
              <span className="text-ui/25">{formatSize(att.size)}</span>
            </div>
          );
        })}
      </div>
    </>
  );
};
