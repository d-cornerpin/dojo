// ════════════════════════════════════════════════════════════════════════════
// MODALSHELL — the one frame every pop-up window hangs from.
//
// Twelve windows (Tracker ×4, Agents ×2, Memory, ContactsPanel ×2, ModelsTab,
// MigrationExport, ImportWizard) each wrote their own `fixed inset-0` backdrop
// div. None closed on Escape, none told a screen reader it was a dialog, and
// Tab could wander out of the window into the page behind it. This is the
// frame they now share: backdrop > panel, the panel is a modal dialog, Escape
// closes, Tab stays inside, focus enters on open and returns to the opener on
// close.
//
// The LOOK is not this component's business: each window passes its current
// class names through `className`/`backdropClassName` (joined on the backdrop)
// and `panelClassName` (the panel), so the frame adds behaviour and changes no
// pixels. Backdrop clicks close only when the click lands on the backdrop
// itself — a click on the panel bubbles here with `target !== currentTarget`,
// so call sites no longer need `stopPropagation`.
// ════════════════════════════════════════════════════════════════════════════

import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';

/** What `Tab` may visit inside a panel — the standard focusable set. */
const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Panels in mount order. Windows stack (the contact conflict prompt sits over
// the contact editor), and each one listens on `document`; without a topmost
// check one Escape would tear the confirm AND the form under it out at once.
const openPanels: HTMLElement[] = [];

export const ModalShell = ({
  onClose,
  children,
  className,
  backdropClassName,
  panelClassName,
  closeOnEscape = true,
  closeOnBackdrop = true,
  label,
}: {
  onClose: () => void;
  children: ReactNode;
  className?: string;
  backdropClassName?: string;
  panelClassName?: string;
  closeOnEscape?: boolean;
  closeOnBackdrop?: boolean;
  label?: string;
}) => {
  const panelRef = useRef<HTMLDivElement>(null);

  // Enter on open, return to the opener on close. Runs once for the window's
  // life: a busy flag flipping mid-save must not re-run this and yank the caret
  // out of a field the owner is typing in.
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return undefined;
    openPanels.push(panel);
    const opener = document.activeElement as HTMLElement | null;
    const first = panel.querySelector<HTMLElement>(FOCUSABLE) ?? panel;
    first.focus();
    // A first field that cannot take focus (e.g. a display:none file input)
    // would leave the window with nothing focused at all; the panel can.
    if (document.activeElement !== first) panel.focus();
    return () => {
      const i = openPanels.indexOf(panel);
      if (i >= 0) openPanels.splice(i, 1);
      opener?.focus();
    };
  }, []);

  // Escape is heard on `document`, not the panel: the window has focus on
  // whatever it contains — a button, a textarea — and the key is pressed with
  // the window open wherever the caret happens to be. A window told not to
  // close on Escape (work in flight) never installs the listener at all.
  useEffect(() => {
    if (!closeOnEscape) return undefined;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (openPanels[openPanels.length - 1] !== panelRef.current) return;
      onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [closeOnEscape, onClose]);

  // Keep Tab inside the panel. The page behind a modal is unreachable, so the
  // focus ring must not walk out of it from either end.
  const onPanelKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab') return;
    const items = panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
    if (!items || items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      className={[className, backdropClassName].filter(Boolean).join(' ')}
      onClick={(e) => {
        if (closeOnBackdrop && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        className={panelClassName}
        onKeyDown={onPanelKeyDown}
      >
        {children}
      </div>
    </div>
  );
};
