import { useEffect, type RefObject } from 'react';

/** Re-follows the bottom while pinned content grows; the caller's pin is the only follow signal. */
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
