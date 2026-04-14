# Feng Shui Theme Spec — Building a Dojo Theme

This document specifies exactly how to create a new visual theme for the Agent D.O.J.O. dashboard. A theme changes fonts, colors, gradients, glass surface appearances, and animations. It does NOT change layout, sizing, spacing, or component structure.

## Architecture Overview

The theming system uses **CSS custom properties (variables)** defined in `:root`. The dashboard's `index.css` defines default values. A theme overrides these values by loading an additional CSS file that re-declares `:root` with new values. Because CSS specificity is equal, the later-loaded theme file wins.

### Key files

```
packages/dashboard/
├── src/
│   ├── index.css                          # Default :root variables + all component classes
│   ├── lib/theme.ts                       # JS utilities to read CSS vars at runtime
│   ├── themes/
│   │   ├── index.ts                       # Theme registry (add your theme here)
│   │   ├── ThemeProvider.tsx              # React context, loads theme CSS dynamically
│   │   └── miyagi/
│   │       └── theme.css                  # Miyagi theme (default, canonical reference)
│   └── pages/Settings.tsx                 # Feng Shui picker UI (auto-renders from registry)
├── public/
│   └── themes/
│       └── <theme-id>/
│           └── theme.css                  # Production-served theme CSS (non-default themes only)
└── tailwind.config.js                     # Colors reference CSS vars via channel pattern
```

### How it works at runtime

1. `index.css` loads with default `:root` values (Miyagi defaults).
2. `ThemeProvider` reads `feng_shui_theme` from the server config table.
3. If the saved theme is not `miyagi`, a `<link>` element is injected into `<head>` pointing to `/themes/<id>/theme.css`.
4. The theme CSS re-declares `:root`, overriding the defaults.
5. All CSS rules, Tailwind classes, and JS-read colors update instantly.

---

## Step-by-Step: Creating a New Theme

### Step 1: Create the theme folder and CSS file

```
packages/dashboard/src/themes/<your-theme-id>/theme.css
```

Copy `miyagi/theme.css` as your starting point. Change every value.

### Step 2: Copy the CSS to the public directory

For non-default themes, the CSS must be served as a static asset:

```
packages/dashboard/public/themes/<your-theme-id>/theme.css
```

This is the same file. It lives in two places because Vite serves `public/` as static assets in production, while the `src/` copy is the source of truth for development.

### Step 3: Register the theme

Edit `packages/dashboard/src/themes/index.ts`. Add an entry to the `THEMES` array:

```typescript
export const THEMES: ThemeMeta[] = [
  {
    id: 'miyagi',
    name: 'Miyagi',
    description: 'Deep space glassmorphism with warm amber accents',
    cssPath: '/themes/miyagi/theme.css',
  },
  {
    id: 'your-theme-id',
    name: 'Your Theme Name',
    description: 'One-line description shown in the Feng Shui picker',
    cssPath: '/themes/your-theme-id/theme.css',
  },
];
```

That's it. The picker in Settings > Dojo tab automatically renders the new option.

### Step 4: Build and test

```bash
npm run build
```

Select the theme in the Feng Shui picker. Every color across the dashboard should change. If anything looks wrong, a hardcoded color was missed — check for inline styles or Tailwind utility classes that bypass the variable system.

---

## Theme CSS File — Complete Variable Reference

Your theme CSS file must be a single `:root` block that overrides the variables below. You may also include an `@import` for Google Fonts (or any other font source) at the top of the file.

### Color Channel System

Colors that are used in both CSS rules AND Tailwind classes use a **channel pattern**:

```css
--cp-amber-ch: 245 166 35;              /* Space-separated RGB channels */
--cp-amber: rgb(var(--cp-amber-ch));     /* DO NOT set this — it derives automatically */
```

**You only set the `-ch` variable.** The named variable (`--cp-amber`) is defined in `index.css` as `rgb(var(--cp-amber-ch))` and derives automatically. Your theme CSS should NOT re-declare the named variables — only the channel variables.

This pattern exists because Tailwind needs raw channels to generate opacity modifiers like `bg-cp-amber/20` → `background-color: rgb(245 166 35 / 0.2)`.

### All Variables

```css
/* Google Fonts — import your theme's fonts here */
@import url('https://fonts.googleapis.com/css2?family=YOUR+FONT&display=swap');

:root {
  /* ══════════════════════════════════════
     FONTS
     ══════════════════════════════════════ */
  --font-sans: 'Your Sans Font';           /* Primary UI font */
  --font-mono: 'Your Mono Font';           /* Code/data font */

  /* ══════════════════════════════════════
     BACKGROUND SURFACES (RGB channels)
     These color the page behind the glass.
     ══════════════════════════════════════ */
  --cp-bg-ch: 11 15 26;                    /* Main page background */
  --cp-bg-secondary-ch: 20 25 41;          /* Card bg when working animation active */
  --cp-sidebar-ch: 26 31 53;               /* Sidebar background tint */

  /* ══════════════════════════════════════
     ACCENT PALETTE (RGB channels)
     These are the 9 named accent colors used
     throughout the UI. Each needs a -ch var.
     ══════════════════════════════════════ */
  --cp-amber-ch: 245 166 35;              /* Primary accent (buttons, nav active, toggles) */
  --cp-amber-light-ch: 255 186 66;        /* Primary accent hover/light variant */
  --cp-teal-ch: 0 212 170;                /* Success, healthy status, teal badges */
  --cp-teal-light-ch: 74 237 196;         /* Teal light variant, healthy status dots */
  --cp-coral-ch: 255 107 138;             /* Error, destructive, coral badges */
  --cp-blue-ch: 91 141 239;               /* Info, links, blue badges */
  --cp-blue-light-ch: 123 164 247;        /* Blue light variant */
  --cp-purple-ch: 167 139 250;            /* Purple badges, accents */
  --cp-purple-deep-ch: 139 92 246;        /* Deep purple, heavy tier badge */

  /* ══════════════════════════════════════
     TEXT
     Use rgba to control opacity against
     the background. Dark themes use white
     base; light themes would use black base.
     ══════════════════════════════════════ */
  --text-primary: rgba(255, 255, 255, 0.92);    /* Headings, body text */
  --text-secondary: rgba(255, 255, 255, 0.55);  /* Labels, descriptions */
  --text-tertiary: rgba(255, 255, 255, 0.30);   /* Hints, timestamps, placeholders */

  /* ══════════════════════════════════════
     THRESHOLD / HEALTH COLORS
     Used in budget charts, progress bars,
     and cost dashboards. Semantic colors
     that indicate severity levels.
     ══════════════════════════════════════ */
  --threshold-ok: #22c55e;                 /* < 50% — healthy, green */
  --threshold-warn: #eab308;               /* 50-75% — caution, yellow */
  --threshold-high: #f97316;               /* 75-90% — elevated, orange */
  --threshold-critical: #ef4444;           /* > 90% — critical, red */

  /* ══════════════════════════════════════
     OVERLAY
     ══════════════════════════════════════ */
  --overlay-dark: rgba(0, 0, 0, 0.88);    /* Image lightbox, fullscreen overlays */

  /* ══════════════════════════════════════
     PAGE BACKGROUND GRADIENT
     The full-page gradient behind everything.
     Glass cards blur this through their
     backdrop-filter, so the gradient colors
     heavily influence the overall feel.
     ══════════════════════════════════════ */
  --bg-gradient: linear-gradient(135deg, rgb(11 15 26) 0%, #1a1040 25%, #0d2137 50%, #1a0f2e 75%, rgb(11 15 26) 100%);

  /* ══════════════════════════════════════
     GRADIENT BLOBS
     Three large colored circles positioned
     behind the glass UI. They show through
     the glass via backdrop-filter: blur().
     ══════════════════════════════════════ */
  --blob-1-color: #7c3aed;                /* Top-left blob (purple in Miyagi) */
  --blob-2-color: #06b6d4;                /* Bottom-right blob (cyan in Miyagi) */
  --blob-3-color: #ec4899;                /* Center blob (pink in Miyagi) */

  /* ══════════════════════════════════════
     GLASS SURFACES
     Control the translucency and borders of
     all glass cards, inputs, modals, and panels.
     These use rgba so the background gradient
     and blobs show through.
     ══════════════════════════════════════ */
  --glass-bg: rgba(255, 255, 255, 0.08);           /* Card/panel background */
  --glass-bg-hover: rgba(255, 255, 255, 0.12);     /* Card hover state */
  --glass-border: rgba(255, 255, 255, 0.15);       /* Card border */
  --glass-border-hover: rgba(255, 255, 255, 0.2);  /* Card border hover */
  --glass-subtle: rgba(255, 255, 255, 0.04);       /* Nested card, subtle bg */
  --glass-input-bg: rgba(255, 255, 255, 0.05);     /* Input/select/textarea bg */
  --glass-input-border: rgba(255, 255, 255, 0.08); /* Input border */

  /* ══════════════════════════════════════
     CHAT BUBBLES
     User messages (right side) and assistant
     messages (left side) in the chat view.
     ══════════════════════════════════════ */
  --bubble-user-bg: rgba(124, 58, 237, 0.25);      /* User message background */
  --bubble-user-border: rgba(124, 58, 237, 0.4);   /* User message border */
  --bubble-assistant-bg: rgba(255, 255, 255, 0.08); /* Assistant message bg */
  --bubble-assistant-border: rgba(255, 255, 255, 0.15); /* Assistant message border */

  /* ══════════════════════════════════════
     BUTTONS
     Primary button uses a gradient from
     the accent colors. These vars control
     the gradient endpoints and text color.
     ══════════════════════════════════════ */
  --btn-primary-text: rgb(26 26 46);       /* Text on primary/action buttons */
  --btn-stop: #EF4444;                     /* Stop/cancel button background */
  --btn-stop-hover: #DC2626;               /* Stop button hover */

  /* Note: --btn-primary-from and --btn-primary-to are defined in index.css
     as var(--cp-amber) and var(--cp-amber-light). They derive from the
     accent palette automatically. Override them only if your primary button
     should use different colors than your main accent. */

  /* ══════════════════════════════════════
     FOCUS RING
     The glow ring shown around focused
     inputs, selects, and textareas.
     ══════════════════════════════════════ */
  --focus-ring: rgb(245 166 35 / 0.4);     /* Should complement --cp-amber */
}
```

---

## What Each Variable Controls

### Where accent colors appear

| Variable | Used by |
|----------|---------|
| `--cp-amber` | Primary buttons, nav active state, toggle switches, send button, working card glow, focus ring, stat card accent bar, amber badges |
| `--cp-amber-light` | Primary button gradient end, amber badge text |
| `--cp-teal` | Success buttons, toast success border, teal badges, healthy status |
| `--cp-teal-light` | Success button gradient end, teal badge text, healthy status dot |
| `--cp-coral` | Destructive buttons, error toast border, coral badges, error status dot, error card glow |
| `--cp-blue` | Info toast border, blue badges, small primary button bg, blue card glow |
| `--cp-blue-light` | Blue badge text, small primary button text |
| `--cp-purple` | Purple badges, purple badge text |
| `--cp-purple-deep` | Heavy tier badge bg |

### CSS classes that consume variables

These classes are defined in `index.css` and automatically use the variables:

| Class | Variables used |
|-------|--------------|
| `.glass-card` | `--glass-bg`, `--glass-border` |
| `.glass-card-hover:hover` | `--glass-bg-hover`, `--glass-border-hover` |
| `.glass-nested` | `--glass-subtle`, `--glass-input-border` |
| `.glass-input`, `.glass-select`, `.glass-textarea` | `--glass-input-bg`, `--glass-input-border`, `--text-primary`, `--focus-ring` |
| `.glass-sidebar` | Hardcoded (structural — same across themes) |
| `.glass-topbar` | Hardcoded (structural) |
| `.glass-menu` | Hardcoded (structural) |
| `.glass-panel` | Hardcoded (structural) |
| `.glass-input-bar` | Hardcoded (structural) |
| `.glass-btn-primary` | `--btn-primary-from`, `--btn-primary-to`, `--btn-primary-text` |
| `.glass-btn-secondary` | `--glass-bg`, `--glass-border`, `--text-primary` |
| `.glass-btn-destructive` | `--cp-coral-ch` |
| `.glass-btn-success` | `--btn-success-from`, `--btn-success-to`, `--btn-success-text` |
| `.glass-btn-ghost` | None (uses white alpha) |
| `.glass-badge-amber` | `--cp-amber-ch`, `--cp-amber-light` |
| `.glass-badge-teal` | `--cp-teal-ch`, `--cp-teal-light` |
| `.glass-badge-coral` | `--cp-coral-ch`, `--cp-coral` |
| `.glass-badge-blue` | `--cp-blue-ch`, `--cp-blue-light` |
| `.glass-badge-purple` | `--cp-purple-deep-ch`, `--cp-purple` |
| `.glass-badge-gray` | `--glass-bg`, `--text-secondary` |
| `.status-dot-healthy` | `--status-healthy`, `--cp-teal-light-ch` |
| `.status-dot-warning` | `--status-warning`, `--cp-amber-ch` |
| `.status-dot-error` | `--status-error`, `--cp-coral-ch` |
| `.status-dot-idle` | `--status-idle` |
| `.glass-toast-info/success/warning/error` | `--cp-blue`, `--cp-teal`, `--cp-amber`, `--cp-coral` |
| `.alert-error/success/warning/info` | `--cp-coral-ch`, `--cp-teal-ch`, `--cp-amber-ch`, `--cp-blue-ch` |
| `.accent-bar-*` | `--cp-amber`, `--cp-teal`, `--cp-coral`, `--cp-blue`, `--cp-purple` |
| `.bubble-user` | `--bubble-user-bg`, `--bubble-user-border` |
| `.bubble-assistant` | `--bubble-assistant-bg`, `--bubble-assistant-border` |
| `.btn-circle-send` | `--cp-amber`, `--cp-bg` |
| `.btn-circle-stop` | `--btn-stop`, `--btn-stop-hover` |
| `.nav-link-active` | `--cp-amber-ch`, `--cp-amber` |
| `.toggle-switch.toggle-on` | `--cp-amber` |
| `.card-glow-amber/teal/purple/blue/coral` | `--cp-amber`, `--cp-teal`, `--blob-1-color`, `--cp-blue`, `--cp-coral` |
| `.card-error-glow` | `--cp-coral-ch` |
| body | `--font-sans`, `--bg-gradient`, `--text-primary` |

### Derived variables (do NOT override in themes)

These are defined in `index.css` and derive from channel or accent variables:

```css
--cp-amber: rgb(var(--cp-amber-ch));           /* Derives from channels */
--cp-teal: rgb(var(--cp-teal-ch));             /* ... */
/* (all 12 named color vars derive from their -ch counterparts) */

--agent-color-1 through 7: var(--cp-amber) etc  /* Derives from accent palette */
--status-healthy: var(--cp-teal-light)           /* Derives from accent */
--status-warning: var(--cp-amber)                /* Derives from accent */
--status-error: var(--cp-coral)                  /* Derives from accent */
--btn-primary-from: var(--cp-amber)              /* Derives from accent */
--btn-primary-to: var(--cp-amber-light)          /* Derives from accent */
--btn-success-from: var(--cp-teal)               /* Derives from accent */
--btn-success-to: var(--cp-teal-light)           /* Derives from accent */
--btn-success-text: var(--cp-bg)                 /* Derives from bg */
```

You CAN override these in a theme if you want different behavior (e.g., a success button that isn't teal), but normally the accent palette drives everything.

---

## JS-Side Theme Integration

Some colors are used in JavaScript (charts, dynamic agent avatars). These read from CSS variables at runtime via `packages/dashboard/src/lib/theme.ts`:

```typescript
cssVar('--cp-amber')        // Reads any CSS variable
getAgentColors()            // Returns 7 colors from --agent-color-1..7
getThresholdColor(pct)      // Returns threshold color based on percentage
```

These functions read live CSS variable values using `getComputedStyle`, so they automatically pick up theme overrides. **No JS changes needed per theme.**

---

## Animations

The following CSS animations exist in `index.css`. They use opacity/transform only (no hardcoded colors) and work across all themes:

| Animation | What it does | Used by |
|-----------|-------------|---------|
| `card-border-rotate` | Rotating conic-gradient border on working cards | `.card-working-border::before`, `.card-working-glow::before` |
| `card-error-pulse` | Pulsing coral glow on error cards | `.card-error-glow` |
| `pulse-dot` | Subtle opacity pulse on status dots | `.status-dot-pulse` |
| `fadeUp` | Fade in + slide up for page transitions | `.animate-fade-up` (Tailwind) |
| `slideInRight` | Slide in from right for toasts | `.glass-toast` |
| `thinking-bounce` | Bouncing dots for thinking/streaming indicator | `.thinking-dot` |

The `card-border-rotate` animation uses `var(--glow-color)` which is set by `.card-glow-amber`, `.card-glow-teal`, etc. These classes already use theme variables. No animation changes needed per theme.

---

## Tailwind Classes and Theme Colors

Tailwind config (`tailwind.config.js`) defines colors as:

```javascript
'cp-amber': 'rgb(var(--cp-amber-ch) / <alpha-value>)',
```

This means ALL Tailwind color utilities with `cp-*` prefixes are theme-aware:

- `bg-cp-amber` — solid amber background
- `bg-cp-amber/20` — 20% opacity amber background
- `text-cp-coral` — coral text
- `border-cp-blue/30` — 30% opacity blue border
- etc.

**Standard Tailwind palette colors** (`text-red-400`, `bg-blue-500/20`, `text-green-400`) are NOT theme-aware. These are used for semantic status indicators in some components (setup wizard, migration, provider health). They are intentionally left as-is because they represent universal status semantics (red=error, green=success) that should remain recognizable across themes.

---

## Checklist Before Submitting a Theme

1. Every `-ch` channel variable has valid space-separated RGB values (e.g., `245 166 35`)
2. Font `@import` is at the top of the theme CSS, before the `:root` block
3. `--font-sans` and `--font-mono` match the imported font family names exactly
4. `--bg-gradient` is a valid CSS gradient (the page background)
5. `--blob-1-color`, `--blob-2-color`, `--blob-3-color` are set (they show through the glass)
6. Glass surface rgba values have appropriate opacity for your background (darker bg = higher opacity glass)
7. `--text-primary/secondary/tertiary` have enough contrast against your glass surfaces
8. `--btn-primary-text` contrasts against the `--cp-amber` / `--cp-amber-light` gradient
9. `--btn-stop` is clearly recognizable as a stop/cancel action
10. `--focus-ring` is visible but not overwhelming
11. Theme CSS file is copied to both `src/themes/<id>/theme.css` and `public/themes/<id>/theme.css`
12. Theme is registered in `src/themes/index.ts` with id, name, description, and cssPath
13. Build passes: `npm run build`
14. Visual test: select the theme in Settings > Dojo > Feng Shui and check every page

---

## Design Tips

- **Glass opacity matters.** The glass surfaces (`--glass-bg`, etc.) use white-alpha on dark backgrounds. If your theme has a lighter background, you may need to switch to dark-alpha (e.g., `rgba(0, 0, 0, 0.06)`) or adjust opacities significantly.
- **Blob colors bleed through glass.** Pick blob colors that complement your accent palette — they tint everything behind the blur.
- **The gradient IS the identity.** The page gradient is the single most impactful variable. Two themes with the same gradient will feel the same regardless of accent color.
- **Test the chat page.** User bubble bg/border and assistant bubble bg/border must be visually distinct from each other AND from the page background.
- **Test the working card animation.** The rotating border glow uses `--cp-amber` by default. Make sure it's visible against your card background (`--cp-bg-secondary`).
