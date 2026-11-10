// An IME's Enter only picks a candidate: a composing Enter must never send, and both browser tells count.

export interface EnterKeyEvent {
  key: string;
  shiftKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
  nativeEvent?: { isComposing?: boolean; keyCode?: number };
}

const isImeComposing = (e: EnterKeyEvent): boolean =>
  (e.nativeEvent?.isComposing ?? e.isComposing) === true ||
  (e.nativeEvent?.keyCode ?? e.keyCode) === 229;

export const isPlainEnter = (e: EnterKeyEvent): boolean =>
  e.key === 'Enter' && !e.shiftKey && !isImeComposing(e);

/** Single-line add/search boxes: Shift was never part of the gesture, so only composition is filtered. */
export const isEnterNotComposing = (e: EnterKeyEvent): boolean =>
  e.key === 'Enter' && !isImeComposing(e);
