// ════════════════════════════════════════════════════════════════════════════
// ENTER THAT MEANS "SEND" AND ENTER THAT MEANS "I'M STILL TYPING" (#9308)
//
// Every one-line submit box in the app sends on Enter. That is the deal the box
// makes with the user, and for a Latin-alphabet typist it holds. For anyone typing
// Japanese, Chinese or Korean it is a lie: their browser runs an INPUT METHOD — you
// type "nihon", a candidate rail opens over the box, and Enter ACCEPTS the highlighted
// word. It does not mean "done". But the browser still fires a plain `keydown` with
// `key === 'Enter'`, so a handler that reads only `key` sends the half-typed message
// AND eats the confirmation the user was mid-way through. A Japanese user cannot
// finish a sentence without their draft flying off half-formed.
//
// ── THE TELL IS NEVER `key`; IT IS "ARE WE COMPOSING?" ──
// A composing keydown is flagged two ways, and both must be believed because the
// browsers disagree about which one they set:
//   · `isComposing` — the modern flag, on the DOM event (`nativeEvent`), true for the
//     whole life of the composition including the Enter that ends it.
//   · `keyCode === 229` — the legacy tell Safari and older engines use; 229 is the
//     reserved code that means "the IME is handling this".
// A React synthetic keyboard event carries both. `key` is `Enter` in every case and
// tells you nothing, which is exactly how the bug hid: the handler looked correct.
//
// ── WHY A LIB FILE AND NOT NINE COPIES OF THE SAME THREE FLAGS ──
// Nine submit-on-Enter sites had this bug, each with its own `e.key === 'Enter'`.
// Fixing it nine ways guarantees the tenth regresses. One rule here, read by all
// of them, is the whole point: `isPlainEnter` for the composer, where Shift+Enter is a
// newline, and `isEnterNotComposing` for the single-line adders/searches, where Shift
// was never part of the gesture and must keep working exactly as it did.

/** The two shapes a keydown reaches this file in: a React synthetic keyboard event
 *  (has `nativeEvent`), or a bare object a test or a raw DOM handler hands over.
 *  Structural on purpose — a React `KeyboardEvent` is assignable to it as-is, and so
 *  is a `{ key: 'Enter', nativeEvent: { isComposing: true } }` literal in a test. */
export interface EnterKeyEvent {
  key: string;
  shiftKey?: boolean;
  /** Present on a React synthetic event; the DOM's own flag rides on `nativeEvent`. */
  isComposing?: boolean;
  /** Only ever read to match 229; absent on a modern React synthetic event. */
  keyCode?: number;
  nativeEvent?: { isComposing?: boolean; keyCode?: number };
}

/** Is an input method mid-composition on this keydown? Both tells count; either one
 *  alone would let a browser through and reopen the bug. `=== true` (not truthiness)
 *  so a `false` native flag is a definitive "not composing", not a hole. */
const isImeComposing = (e: EnterKeyEvent): boolean =>
  (e.nativeEvent?.isComposing ?? e.isComposing) === true ||
  (e.nativeEvent?.keyCode ?? e.keyCode) === 229;

/** True for the Enter that MEANS SEND in the chat composer: Enter, not Shift+Enter
 *  (that one is a newline), and not while an input method is still composing. */
export const isPlainEnter = (e: EnterKeyEvent): boolean =>
  e.key === 'Enter' && !e.shiftKey && !isImeComposing(e);

/** True for the Enter that MEANS SUBMIT in a single-line add/search box — a box where
 *  Shift+Enter never had a special meaning, so shift is deliberately not consulted.
 *  Only the input-method composition is filtered out; everything else is unchanged. */
export const isEnterNotComposing = (e: EnterKeyEvent): boolean =>
  e.key === 'Enter' && !isImeComposing(e);
