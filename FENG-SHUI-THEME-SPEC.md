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
| `.glass-sidebar` | `--glass-input-bg`, `--glass-border`, `--glass-input-border` |
| `.glass-topbar` | `--cp-bg-ch` (channel), `--glass-input-border` |
| `.glass-menu` | `--cp-sidebar-ch` (channel) |
| `.glass-panel` | `--glass-bg`, `--glass-border`, `--glass-input-border` |
| `.glass-input-bar` | `--glass-bg`, `--glass-border`, `--glass-input-border` |
| `.glass-input-bar-subtle` | `--glass-subtle`, `--glass-input-border` |
| `.glass-divider-v` | `--glass-input-border` |
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

---

## Compliance Audit — 2026-05-10

A full audit of the dashboard against this spec was performed on 2026-05-10. Significant drift had accumulated since the system was first introduced — almost entirely in features added afterward (migration, vault, costs, health charts, technique builder). The system itself is sound; the violations are mechanical replacements, not architectural problems.

This section documents what was found so the work to fix it can be planned discretely, and so the next round of feature work doesn't repeat the same mistakes.

### How the audit was conducted

Searched the entire `packages/dashboard/src/` tree for the following patterns:

1. Hardcoded hex colors (`#xxxxxx`) in `.tsx`, `.ts`, `.css`, `.html` — excluding `themes/<id>/theme.css` (theme files are themselves the source of truth) and `index.css` (default `:root` variables legitimately live there).
2. Hardcoded `rgb()` / `rgba()` literals in the same scope.
3. Tailwind utility classes that bypass the theme: any `text-red-*`, `bg-blue-*`, `border-green-*`, `text-yellow-*`, `bg-purple-*`, etc. using the default Tailwind palette instead of `cp-*` theme colors.
4. Inline `style={{ color: ..., background: ..., ... }}` props with hardcoded values (rather than `cssVar()` reads).
5. Hardcoded font-family declarations outside theme files.
6. Hardcoded `linear-gradient(...)` / `radial-gradient(...)` outside theme files.
7. Hand-rolled glass surfaces (`backdrop-filter: blur(...)`, white-alpha rgba) that bypass the canonical `.glass-card`, `.glass-input`, etc. classes.
8. Stray `.css` files outside `index.css` and `themes/*/theme.css`.
9. Drift between `src/themes/<id>/theme.css` and `public/themes/<id>/theme.css` (the two copies must stay identical).

### Critical structural finding

**`packages/dashboard/public/themes/miyagi/theme.css` is missing.** The directory exists but is empty. Per Step 2 of this spec, the theme CSS must live in BOTH `src/themes/<id>/theme.css` and `public/themes/<id>/theme.css` — the public copy is what Vite serves as a static asset in production. Without it, theme switching will fail in production builds for any non-default theme: the dynamic `<link>` injection will 404. Restore by copying the canonical `src/themes/miyagi/theme.css` into `public/themes/miyagi/theme.css` and add a one-line note to the build script (or pre-commit) that the two files must stay in sync.

### High-severity violations — visible elements that bypass the theme

Each of these is a piece of UI that won't change appearance when a non-Miyagi theme is loaded. All are mechanical fixes.

| File | Lines | Violation | Should use |
|------|-------|-----------|------------|
| `components/MigrationExport.tsx` | 81 | `bg-[#1a1a2e]` modal backdrop | `--cp-bg-secondary` (or a glass class on a darker overlay) |
| `components/MigrationExport.tsx` | 97, 108 | `focus:border-blue-500` on inputs | `focus:ring-2 focus:ring-cp-amber/40` (match `.glass-input`) |
| `components/MigrationImport.tsx` | 220 | Same `focus:border-blue-500` | Same as above |
| `components/VaultStats.tsx` | 120 | `bg-[#1a1a2e]` dropdown menu | `--cp-bg-secondary` or a glass class |
| `components/CostCharts.tsx` | 38 | `'#3b82f6'` chart-bar fallback | `cssVar('--cp-blue')` or `getThresholdColor()` |
| `pages/Costs.tsx` | 51–56 | `TIER_COLORS` and `MODEL_COLORS` arrays of raw hex (`#a855f7`, `#3b82f6`, `#22c55e`, `#ec4899`, `#f97316`, `#06b6d4`, `#84cc16`) | Derive from accent palette: `cssVar('--cp-purple')`, `cssVar('--cp-blue')`, `cssVar('--cp-teal')`, etc. |
| `pages/Health.tsx` | 383 | CPU bar `color="#3b82f6"` | `cssVar('--cp-blue')` |
| `pages/TechniqueBuilder.tsx` | 1017 | `style={{ background: 'rgba(0,0,0,0.15)' }}` on canvas panel | `--glass-subtle` or `--overlay-dark` |
| `components/AgentCard.tsx` | 105 | `style={{ background: \`${color}20\` }}` — string-concatenates hex `20` for opacity | Use proper rgba/opacity, since `color` may not always be a hex string after a theme switch |
| `components/GroupCard.tsx` | 56 | `style={{ background: group.color }}` reads color from backend state | Confirm group colors are assigned from the theme accent palette, not arbitrary hex stored at create time |
| `components/GoogleWorkspaceSetup.tsx` | 193 | `text-[#0B0F1A]` on a `bg-cp-teal` button (button bg themes, text doesn't) | `--btn-success-text` or `var(--cp-bg)` |
| `pages/Setup.tsx` | 122–124, 387, 800, 869, 1001, 1084, 1166, 1297, 1440, 1548, 1628 | Same `text-[#0B0F1A]` pattern across many primary-action buttons | Same as above. Setup wizard is otherwise a spec-exempt area, but **button text contrast against the teal/amber gradient is a theming concern, not a status semantic** — fix this even though it's in the wizard |

### Medium-severity violations — Tailwind palette in non-exempt areas

These use universal Tailwind colors (`text-red-400`, `bg-blue-500/20`, `text-yellow-500`) for elements that are NOT universal status semantics. Per this spec, only true status semantics (red = error, green = success, yellow = warning) in the setup wizard, migration flow, and provider health UI are intentionally left as standard Tailwind. Anything else should use `cp-*` colors.

Files where Tailwind palette colors leak into non-exempt UI:

- `components/VaultEntryCard.tsx` (lines ~6–14) — type badges (`bg-blue-500/20 text-blue-400`, `bg-purple-500/20 text-purple-400`, `bg-amber-500/20 text-amber-400`). Vault entries are persistent UI; replace with `cp-blue`, `cp-purple`, `cp-amber` badge classes.
- `components/SummaryDetail.tsx` — ~10 references to status/metadata colors.
- `components/KanbanBoard.tsx` (lines 21, 23, 97) — column headers and states (`text-yellow-400`, `text-green-400`, `border-blue-500/40 text-blue-400`). The kanban is part of the tracker, not the migration UI.
- `components/MemorySearch.tsx` — highlight color (`yellow-500/30`).
- `components/Markdown.tsx` (lines 150, 180, 196) — code block + link colors (`text-blue-300`, `text-blue-400`). Markdown rendering is theme-relevant; `--cp-blue` would be better.
- `components/LinkPreview.tsx` — link color.
- `pages/Tracker.tsx` — tracker status color.
- `pages/AgentDetail.tsx` — agent detail status colors (5 references).
- `pages/Memory.tsx` — memory interface status (2 references).
- `pages/TechniqueDetail.tsx` — technique metadata color.

### Spec-exempt areas — confirmed intentional, no action needed

Per the existing "Tailwind Classes and Theme Colors" section of this spec, certain components are intentionally allowed to use the standard Tailwind palette for universal status semantics. The audit confirmed these are still appropriate exceptions:

- `components/ProviderHealth.tsx` — `text-green-400` (healthy), `text-yellow-400` (degraded), `text-red-400` (down)
- `components/SetupDeps.tsx` — install status colors
- `pages/Setup.tsx` — non-button status colors only (the `text-[#0B0F1A]` button-text issue is separate, see HIGH table above)
- `components/PostMigrationBanner.tsx` — migration status colors
- `components/MigrationImport.tsx` — migration status colors

These should stay as-is. Worth adding inline comments at each site so future audits don't re-flag them.

### Low-severity findings — confirmed correct

- `lib/theme.ts:13–28` — JS-side fallback hex values when CSS var reads fail (`cssVar('--cp-amber') || '#F5A623'`). Intentional safety net; matches Miyagi defaults exactly.
- `src/index.css` default `:root` block — hardcoded threshold/blob/gradient/glass values. Correct per architecture; this IS the source of truth for the default theme.
- `tailwind.config.js` `glass-glow` shadow — hardcoded amber rgba. Themable by overriding the box-shadow in theme CSS if needed.
- Scrollbar `color: #ffffff` in `index.css:657` — browser chrome, negligible visual impact.

### Pattern observations

1. **Drift correlates with feature ship dates.** Every HIGH violation is in a component added after the Feng Shui system was introduced — migration, vault, costs, technique builder. The pre-existing pages (Chat, Agents, original Tracker) remained clean.
2. **Inline `style={{}}` is the most common escape hatch.** When a developer needs an opacity or a slight tint not covered by an existing class, the path of least resistance is an inline style with a literal value rather than a CSS var. This is the single biggest source of HIGH violations.
3. **Tailwind palette colors get copy-pasted from spec-exempt code.** A developer working on a vault component sees `text-red-400` in nearby migration code, assumes it's the project convention, and uses it in the new component without realizing migration is an intentional exception.
4. **Modal backgrounds are a recurring weak spot.** Two separate components (`MigrationExport`, `VaultStats`) hardcoded `#1a1a2e` for modal/dropdown bgs — there's no canonical glass-modal class for this case yet. Adding one (e.g., `.glass-modal-bg`) would prevent future copy-pasting of the literal.

### Recommended follow-ups for this spec

1. Add a section "Common pitfalls when adding new components" documenting items 2–4 above so future contributors avoid them.
2. Consider adding a CI-style lint rule (`eslint-plugin-no-hardcoded-colors` or a custom regex check) that fails the build if a `.tsx` file under `dashboard/src/` introduces a `#[0-9a-f]{6}` literal or a `text-(red|blue|green|yellow|purple|amber)-\d{3}` class outside the spec-exempt directories. This would prevent recurrence.
3. Define a `.glass-modal-bg` class for modal/dropdown backgrounds so the next feature has a canonical thing to use.
4. Add a pre-build check that diffs `src/themes/<id>/theme.css` against `public/themes/<id>/theme.css` and fails if they differ — would have caught the missing-public-file critical issue at the time it broke.

---

## Light themes — the `--ui-on-base-ch` channel

Earlier versions of the dashboard used the `text-white/X`, `bg-white/X`, `border-white/X` Tailwind utilities everywhere. Those literals locked the dashboard into a dark theme — on a light page background, white-with-low-opacity disappears against white. As of this pass the dashboard uses a themable channel instead.

### How it works

Every "ink over the page background" color reads through a single channel variable:

```css
:root {
  --ui-on-base-ch: 255 255 255;  /* white on dark themes */
}
```

That feeds:

1. **A Tailwind color named `ui`** in `tailwind.config.js`:
   ```js
   colors: {
     'ui': 'rgb(var(--ui-on-base-ch) / <alpha-value>)',
   }
   ```
   So `text-ui/55`, `bg-ui/[0.05]`, `border-ui/10`, `ring-ui/40` all work the same way `text-cp-amber/X` works for the accent palette. The opacity passes through Tailwind's `<alpha-value>` substitution.

2. **The text vars** in `:root`:
   ```css
   --text-primary: rgb(var(--ui-on-base-ch) / 0.92);
   --text-secondary: rgb(var(--ui-on-base-ch) / 0.55);
   --text-tertiary: rgb(var(--ui-on-base-ch) / 0.30);
   ```

3. **The glass surface vars** in `:root`:
   ```css
   --glass-bg: rgb(var(--ui-on-base-ch) / 0.08);
   --glass-bg-hover: rgb(var(--ui-on-base-ch) / 0.12);
   --glass-border: rgb(var(--ui-on-base-ch) / 0.15);
   --glass-border-hover: rgb(var(--ui-on-base-ch) / 0.2);
   --glass-subtle: rgb(var(--ui-on-base-ch) / 0.04);
   --glass-input-bg: rgb(var(--ui-on-base-ch) / 0.05);
   --glass-input-border: rgb(var(--ui-on-base-ch) / 0.08);
   ```

4. **All the inline `rgba(255,255,255,X)` literals** in component styles inside `index.css` (scrollbar, glossy edges, placeholder text, etc.) were converted to `rgb(var(--ui-on-base-ch) / X)`.

### Building a light theme

In your theme's `theme.css`, set:

```css
:root {
  --ui-on-base-ch: 0 0 0;  /* black on light themes */
}
```

That single line flips:
- All `text-ui/X` foreground colors
- All `bg-ui/X` surface tints
- All `border-ui/X` borders
- All `ring-ui/X` focus rings
- All `--text-primary/secondary/tertiary` text colors
- All `--glass-*` surfaces (cards, inputs, sidebar, topbar, menu, panel, input bar, divider, modal)
- All inline channel-pattern rgba in CSS rules

Of course you'll also want to flip the page bg gradient, blob colors, and other vars — all of those override exactly the same way they do for a dark theme.

### What still needs per-theme overrides for a light theme

A few elements consume the channel pattern but won't look right at the same opacities under a light theme. Adjust these in your theme's CSS:

1. **Page background gradient** (`--bg-gradient`) — use light colors (slate-50, off-whites, paper tones) instead of deep navy. The blobs (`--blob-1/2/3-color`) should be soft pastels rather than vivid saturated colors so they don't dominate the page.
2. **The select dropdown chevron** — `.glass-select`'s `background-image` is an inlined SVG with a hardcoded `stroke='rgba(255,255,255,0.4)'`. SVG background-image URLs cannot read CSS vars, so a light theme must override `.glass-select { background-image: url(...with stroke='rgba(0,0,0,0.4)'...); }` to make the chevron visible. (`-webkit-mask-image` would let us color it via CSS but masks the entire element including the text — not viable for a `<select>`.)
3. **Box shadows** in `.glass-card`, `.glass-panel`, `.glass-modal-bg` use `rgba(0, 0, 0, 0.4)` for depth. These are intentionally dark across themes (shadow convention), but a light theme may want softer values like `rgba(0, 0, 0, 0.08)`.
4. **`--overlay-dark`** (image lightbox backdrop) stays dark by convention even on light themes — full-screen overlays are conventionally dark for media focus.
5. **The agent group color bar** (`group.color`) is data-stored in SQLite and doesn't theme — see the "Compliance Audit" section.
6. **Threshold colors** (`--threshold-ok/warn/high/critical`) — the index.css defaults are bright (e.g., `#22c55e` green, `#eab308` yellow). On a light bg, bright greens and yellows turn into glare. Use deeper variants like `#16a34a` and `#ca8a04` so they read as semantic status colors rather than highlighter strokes.
7. **`--btn-success-text`** defaults to `var(--cp-bg)`. On Miyagi `--cp-bg` is deep navy (light text on bright teal — readable). On a light theme `--cp-bg` is cream, so the default would be light text on bright teal — unreadable. Override with a dark color (e.g., `rgb(15 50 40)` for an ink-green that complements teal).
8. **Per-theme alpha tuning for text** (see next section). The faintest text tiers (`text-ui/25`, `/40`, `--text-tertiary`) need a perceptual bump on light themes — dark ink at 25% on cream is barely visible (~1.7:1 contrast, fails WCAG), even though white at 25% on dark navy reads fine.

### Per-theme alpha tuning

The same `text-ui/X` class can resolve to different opacities per theme. This is critical for light themes because human perception of low-opacity text differs sharply between white-on-dark and dark-on-white.

**The pattern:** override the Tailwind utility class directly in your theme.css. Same source-code class, different resolved alpha per theme. Theme.css loads after index.css, so theme rules win at equal specificity.

**Example from `themes/sumi/theme.css`:**

```css
.text-ui\/25 { color: rgb(var(--ui-on-base-ch) / 0.50); }
.text-ui\/40 { color: rgb(var(--ui-on-base-ch) / 0.60); }
.text-ui\/55 { color: rgb(var(--ui-on-base-ch) / 0.68); }

/* Hover and disabled variants are separate Tailwind classes — override them too */
.hover\:text-ui\/25:hover { color: rgb(var(--ui-on-base-ch) / 0.50); }
.hover\:text-ui\/40:hover { color: rgb(var(--ui-on-base-ch) / 0.60); }
.disabled\:text-ui\/25:disabled { color: rgb(var(--ui-on-base-ch) / 0.50); }
```

And the corresponding `--text-*` vars (consumed by `.text-tertiary`, `.text-secondary`, the body color, glass badges, etc.) need the same bump:

```css
:root {
  --text-primary: rgb(var(--ui-on-base-ch) / 0.95);
  --text-secondary: rgb(var(--ui-on-base-ch) / 0.68);
  --text-tertiary: rgb(var(--ui-on-base-ch) / 0.50);
}
```

**Suggested tier mapping for light themes:**

| Tier (source) | Miyagi (dark bg) | Sumi-style (light bg) |
|---|---|---|
| Heading (`text-ui`) | 100% | 100% |
| Primary (`text-ui/90`) | 90% | 90% |
| Secondary (`text-ui/70`) | 70% | 70% |
| Tertiary (`text-ui/55`) | 55% | 68% |
| Hint (`text-ui/40`) | 40% | 60% |
| Faint (`text-ui/25`) | 25% | 50% |

**What NOT to bump:** borders (`border-ui/[0.06]` etc.) and background tints (`bg-ui/[0.05]` etc.) are decorative. Reduced contrast is acceptable for them and bumping makes them visually noisy. Only text needs the perceptual correction.

### Accent text on light themes

The same problem applies to accent colors: `--cp-amber` (245 166 35) is vivid on dark navy but only ~2.5:1 contrast on cream — fails WCAG AA when used as text. The solution is the same: surfaces keep the bright accent, text gets a deeper variant.

**The pattern:** define `--cp-{accent}-text-ch` channel vars in the theme, then override the `text-cp-*` Tailwind utilities and the CSS rules (`.glass-badge-*`, `.alert-*`, `.nav-link-active`) to use them. `bg-cp-*`, `border-cp-*`, status dots, button gradients, and accent borders all keep using the bright `--cp-*-ch` values so the surfaces stay vivid.

**Example from `themes/sumi/theme.css`:**

```css
:root {
  /* Bright accents for surfaces (buttons, bg tints, status dots) */
  --cp-amber-ch: 195 130 30;
  /* Deeper variants for accent TEXT only — ~5:1 contrast on cream */
  --cp-amber-text-ch: 145 85 15;
  /* (similar pairs for teal, coral, blue, purple, and -light/-deep variants) */
}

.text-cp-amber, .hover\:text-cp-amber:hover {
  color: rgb(var(--cp-amber-text-ch));
}

/* CSS rules that use the accent for text */
.glass-badge-amber { color: rgb(var(--cp-amber-text-ch)); }
.alert-warning     { color: rgb(var(--cp-amber-text-ch)); }
.nav-link-active   { color: rgb(var(--cp-amber-text-ch)); }
```

**Suggested -text-ch values for light themes:**

| Accent | Surface (Sumi `--cp-*-ch`) | Text (Sumi `--cp-*-text-ch`) |
|---|---|---|
| amber | `195 130 30` | `145 85 15` |
| amber-light | `220 160 60` | `170 110 30` |
| teal | `20 145 110` | `10 100 75` |
| teal-light | `60 175 140` | `30 130 100` |
| coral | `200 80 95` | `165 55 70` |
| blue | `50 95 180` | `30 65 145` |
| blue-light | `90 135 215` | `55 95 180` |
| purple | `130 100 195` | `95 65 165` |
| purple-deep | `105 70 175` | `75 50 145` |

**For dark themes, no override is needed.** The bright `--cp-*-ch` values give excellent contrast on dark navy (typically 6:1+).

**Opacity-modified variants** (`text-cp-amber/70`, `text-cp-coral/80`, etc.) need their own override rules since Tailwind generates them as separate classes. The Sumi theme handles every opacity variant currently used in source — when you add a new one, add the matching override.

### Authoring rule

When writing new components: use `text-ui/X`, `bg-ui/X`, `border-ui/X`, `ring-ui/X` — never the literal `text-white/X` patterns. The `\b(text|bg|border|ring)-white\b` pattern is now considered a defect; future audit passes should flag it.

### Standardized opacity tiers

To keep the dashboard visually consistent, use only these canonical opacity values. The codebase was standardized to this set in the 2026-05-10 audit pass; every other value should be considered a drift defect.

**Text — 6 tiers:**

| Tier | Class | Use case |
|---|---|---|
| Heading | `text-ui` (100%) | h1/h2, primary focal labels |
| Primary | `text-ui/90` | Body text, main labels |
| Secondary | `text-ui/70` | Emphasized secondary, prominent labels |
| Tertiary | `text-ui/55` | Standard secondary body, descriptions |
| Hint | `text-ui/40` | Timestamps, captions, supporting metadata |
| Faint | `text-ui/25` | Placeholders, disabled, very dim |

**Borders — 3 tiers:**

| Tier | Class | Use case |
|---|---|---|
| Subtle | `border-ui/[0.06]` | Dividers, inset edges, very faint outlines |
| Standard | `border-ui/[0.10]` | Card outlines, default borders |
| Emphasized | `border-ui/[0.15]` | Hover states, focus rings, strong outlines |

**Backgrounds — 5 tiers:**

| Tier | Class | Use case |
|---|---|---|
| Transparent | `bg-ui` (rare; defaults opaque — usually a typo) | Solid white/black surfaces |
| Whisper | `bg-ui/[0.03]` | Faint wash, large area tint |
| Subtle | `bg-ui/[0.05]` | Inset surfaces, button rest state |
| Standard | `bg-ui/[0.08]` | Cards, inputs, prominent surfaces |
| Hover | `bg-ui/[0.12]` | Hover/selected states |

**When you reach for an opacity not in this list, stop and pick the nearest tier.** If none of them work for a specific element, raise it as a discussion before adding a new tier — every additional value fragments the system.

Predefined Tailwind opacity shorthands (`/5`, `/10`, `/15`, etc.) and the bracket form (`/[0.05]`, `/[0.10]`) compile to the same CSS, but pick the canonical form per tier shown above so source code search/audit stays clean.

