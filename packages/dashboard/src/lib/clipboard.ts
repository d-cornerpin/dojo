/**
 * Copy text robustly. The async Clipboard API only works in a secure context (https / localhost)
 * with focus and permission, so over a tunnel or a LAN address it throws. We try it, then fall
 * back to the legacy `execCommand('copy')` through a hidden textarea, which works on plain http.
 * Returns whether anything actually landed on the clipboard.
 *
 * ⚠ CALL IT FROM A CLICK HANDLER with the text already in hand. Safari drops the user gesture
 * across an await on a fetch, so a copy that waits for the network first silently does nothing.
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard && window.isSecureContext) {
    try { await navigator.clipboard.writeText(text); return true; } catch { /* fall through */ }
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '0';
    ta.style.left = '0';
    ta.style.opacity = '0';
    ta.style.pointerEvents = 'none';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
