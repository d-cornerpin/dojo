import { useEffect, type RefObject } from 'react';

/**
 * Keep a pinned scroll view at the bottom while its content GROWS (late images, markdown, code
 * blocks, a history backfill). The caller's pin is the one statement of "following"; the caller's
 * scroll listener releases it the moment the owner scrolls up, and `isPinned()` then reads false.
 * This is the real signal for page-load scrolling: no timed re-asserts to outlast.
 */
export function useFollowGrowth(
  contentRef: RefObject<HTMLElement | null>,
  active: boolean,
  isPinned: () => boolean,
  follow: () => void,
  rekey: unknown,
): void {
  useEffect(() => {
    const content = contentRef.current;
    if (!active || !content || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => { if (isPinned()) follow(); });
    observer.observe(content);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, rekey, contentRef, follow]);
}
