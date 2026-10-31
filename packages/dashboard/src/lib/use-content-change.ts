import { useEffect, useRef } from 'react';
import { stableGrantsText } from '@dojo/shared';

/**
 * Runs `onChange(value)` when the CONTENT of `value` changes, not when it merely arrives as a new
 * object. A parent refetch hands panels fresh objects holding the same stored values; an editor
 * that resets its unsaved draft on identity loses the owner's edits each time.
 */
export function useContentChange<T>(value: T, onChange: (value: T) => void): void {
  const last = useRef<string>(stableGrantsText(value));
  useEffect(() => {
    const text = stableGrantsText(value);
    if (text === last.current) return;
    last.current = text;
    onChange(value);
  });
}
