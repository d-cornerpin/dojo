import { useState } from 'react';

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

// Lightbox for image preview
const ImageLightbox = ({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) => (
  <div
    className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-8 cursor-pointer"
    onClick={onClose}
  >
    <img src={src} alt={alt} className="max-w-full max-h-full rounded-lg shadow-2xl" onClick={(e) => e.stopPropagation()} />
    <button onClick={onClose} className="absolute top-4 right-4 text-white/60 hover:text-white text-2xl">&times;</button>
  </div>
);

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
