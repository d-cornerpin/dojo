import { useEffect, useRef } from 'react';
import { stableGrantsText } from '@dojo/shared';

/** Runs `onChange` when the CONTENT of `value` changes, not when it arrives as a new object. */
export function useContentChange<T>(value: T, onChange: (value: T) => void): void {
  const last = useRef<string>(stableGrantsText(value));
  useEffect(() => {
    const text = stableGrantsText(value);
    if (text === last.current) return;
    last.current = text;
    onChange(value);
  });
}
