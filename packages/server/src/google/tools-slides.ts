// ════════════════════════════════════════
// Google Slides Toolkit — Native REST API
// Available to: primary agent ONLY (all write tools)
//
// Adds comprehensive deck-building tools: DeckStyle presets, slide CRUD,
// formatted text, bullets, images (URL + Drive), video (YouTube + Drive),
// shapes, lines, tables, and compound layout helpers. All sizes and
// positions are in points (pt); EMUs are hidden internally.
// ════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import type { ToolDefinition } from '../agent/tools.js';
import { googleRead, googleWrite } from './client.js';

const SLIDES_BASE = 'https://slides.googleapis.com/v1/presentations';
const DRIVE_BASE = 'https://www.googleapis.com/drive/v3';

// ─────────────────────────────────────────
// Constants & unit conversion
// ─────────────────────────────────────────

// Default slide dimensions: 16:9 widescreen (720pt × 405pt).
// Rendered at 192 DPI this is exactly 1920×1080 pixels, matching the
// dojo's default "1920x1080 unless the user says otherwise" convention.
export const DEFAULT_SLIDE_WIDTH_PT = 720;
export const DEFAULT_SLIDE_HEIGHT_PT = 405;
const EMU_PER_PT = 12700;

function ptToEmu(pt: number): number {
  return Math.round(pt * EMU_PER_PT);
}

function emuToPt(emu: number): number {
  return emu / EMU_PER_PT;
}

function hexToRgb(hex: string): { red: number; green: number; blue: number } {
  const h = hex.replace('#', '').trim();
  const normalized = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
  if (normalized.length !== 6) throw new Error(`Invalid hex color: ${hex}`);
  return {
    red: parseInt(normalized.substring(0, 2), 16) / 255,
    green: parseInt(normalized.substring(2, 4), 16) / 255,
    blue: parseInt(normalized.substring(4, 6), 16) / 255,
  };
}

function opaqueColor(hex: string): { rgbColor: { red: number; green: number; blue: number } } {
  return { rgbColor: hexToRgb(hex) };
}

function solidFill(hex: string, alpha = 1.0): { color: { rgbColor: { red: number; green: number; blue: number } }; alpha: number } {
  return { color: opaqueColor(hex), alpha };
}

function pageSize(widthPt: number, heightPt: number) {
  return {
    width: { magnitude: ptToEmu(widthPt), unit: 'EMU' as const },
    height: { magnitude: ptToEmu(heightPt), unit: 'EMU' as const },
  };
}

function pageTransform(xPt: number, yPt: number, scaleX = 1, scaleY = 1) {
  return {
    scaleX,
    scaleY,
    translateX: ptToEmu(xPt),
    translateY: ptToEmu(yPt),
    unit: 'EMU' as const,
  };
}

function genId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

// ─────────────────────────────────────────
// DeckStyle: interface + presets + persistence
// ─────────────────────────────────────────

export interface DeckStyle {
  title_font: string;
  title_size: number;
  title_color: string;
  title_bold: boolean;

  heading_font: string;
  heading_size: number;
  heading_color: string;
  heading_bold: boolean;

  body_font: string;
  body_size: number;
  body_color: string;
  body_bold: boolean;

  subtitle_font: string;
  subtitle_size: number;
  subtitle_color: string;
  subtitle_bold: boolean;

  caption_font: string;
  caption_size: number;
  caption_color: string;
  caption_bold: boolean;

  accent_color: string;
  background_color: string;
  slide_background_color: string;

  bullet_indent_pt: number;
  line_spacing: number;

  margin_left_pt: number;
  margin_top_pt: number;

  // Slide dimensions in points. Default is 720×405 (16:9 widescreen,
  // renders at 1920×1080 at 192dpi). Stored per-presentation so layout
  // helpers know the usable area without having to fetch the deck.
  slide_width_pt: number;
  slide_height_pt: number;
}

// Usable content area inside a slide after applying margins.
function contentArea(style: DeckStyle): { ml: number; mt: number; cw: number; ch: number } {
  return {
    ml: style.margin_left_pt,
    mt: style.margin_top_pt,
    cw: style.slide_width_pt - 2 * style.margin_left_pt,
    ch: style.slide_height_pt - 2 * style.margin_top_pt,
  };
}

export const STYLE_PRESETS: Record<string, { description: string; style: DeckStyle }> = {
  clean_light: {
    description: 'Dark text on white backgrounds, blue accent, Open Sans / Poppins. Clean and corporate.',
    style: {
      title_font: 'Poppins', title_size: 36, title_color: '#111111', title_bold: true,
      heading_font: 'Poppins', heading_size: 28, heading_color: '#2D5BFF', heading_bold: true,
      body_font: 'Open Sans', body_size: 16, body_color: '#333333', body_bold: false,
      subtitle_font: 'Open Sans', subtitle_size: 20, subtitle_color: '#666666', subtitle_bold: false,
      caption_font: 'Open Sans', caption_size: 12, caption_color: '#888888', caption_bold: false,
      accent_color: '#2D5BFF',
      background_color: '#FFFFFF',
      slide_background_color: '#FFFFFF',
      bullet_indent_pt: 18, line_spacing: 1.15,
      margin_left_pt: 50, margin_top_pt: 40,
      slide_width_pt: DEFAULT_SLIDE_WIDTH_PT, slide_height_pt: DEFAULT_SLIDE_HEIGHT_PT,
    },
  },
  clean_dark: {
    description: 'White text on dark (#1a1a2e) backgrounds, teal accent. Strong contrast.',
    style: {
      title_font: 'Poppins', title_size: 36, title_color: '#FFFFFF', title_bold: true,
      heading_font: 'Poppins', heading_size: 28, heading_color: '#4DD0E1', heading_bold: true,
      body_font: 'Open Sans', body_size: 16, body_color: '#E6E6E6', body_bold: false,
      subtitle_font: 'Open Sans', subtitle_size: 20, subtitle_color: '#B5B5B5', subtitle_bold: false,
      caption_font: 'Open Sans', caption_size: 12, caption_color: '#999999', caption_bold: false,
      accent_color: '#4DD0E1',
      background_color: '#1A1A2E',
      slide_background_color: '#1A1A2E',
      bullet_indent_pt: 18, line_spacing: 1.15,
      margin_left_pt: 50, margin_top_pt: 40,
      slide_width_pt: DEFAULT_SLIDE_WIDTH_PT, slide_height_pt: DEFAULT_SLIDE_HEIGHT_PT,
    },
  },
  bold_modern: {
    description: 'Large type, bold saturated colors, minimal text. High-impact investor-deck style.',
    style: {
      title_font: 'Montserrat', title_size: 54, title_color: '#111111', title_bold: true,
      heading_font: 'Montserrat', heading_size: 36, heading_color: '#FF3366', heading_bold: true,
      body_font: 'Inter', body_size: 20, body_color: '#222222', body_bold: false,
      subtitle_font: 'Inter', subtitle_size: 24, subtitle_color: '#444444', subtitle_bold: false,
      caption_font: 'Inter', caption_size: 14, caption_color: '#666666', caption_bold: false,
      accent_color: '#FF3366',
      background_color: '#FFF7F0',
      slide_background_color: '#FFF7F0',
      bullet_indent_pt: 20, line_spacing: 1.25,
      margin_left_pt: 60, margin_top_pt: 48,
      slide_width_pt: DEFAULT_SLIDE_WIDTH_PT, slide_height_pt: DEFAULT_SLIDE_HEIGHT_PT,
    },
  },
  minimal: {
    description: 'Lots of whitespace, thin fonts, understated gray palette. Editorial.',
    style: {
      title_font: 'Inter', title_size: 32, title_color: '#222222', title_bold: false,
      heading_font: 'Inter', heading_size: 22, heading_color: '#222222', heading_bold: false,
      body_font: 'Inter', body_size: 14, body_color: '#555555', body_bold: false,
      subtitle_font: 'Inter', subtitle_size: 16, subtitle_color: '#888888', subtitle_bold: false,
      caption_font: 'Inter', caption_size: 11, caption_color: '#999999', caption_bold: false,
      accent_color: '#222222',
      background_color: '#FAFAFA',
      slide_background_color: '#FAFAFA',
      bullet_indent_pt: 14, line_spacing: 1.4,
      margin_left_pt: 70, margin_top_pt: 56,
      slide_width_pt: DEFAULT_SLIDE_WIDTH_PT, slide_height_pt: DEFAULT_SLIDE_HEIGHT_PT,
    },
  },
};

// Persistent style store
const STYLE_STORE_PATH = path.join(os.homedir(), '.dojo', 'data', 'slides_styles.json');

type StyleStore = Record<string, DeckStyle>;

function readStyleStore(): StyleStore {
  try {
    if (!fs.existsSync(STYLE_STORE_PATH)) return {};
    const raw = fs.readFileSync(STYLE_STORE_PATH, 'utf-8');
    return JSON.parse(raw) as StyleStore;
  } catch {
    return {};
  }
}

function writeStyleStore(store: StyleStore): void {
  fs.mkdirSync(path.dirname(STYLE_STORE_PATH), { recursive: true });
  const tmp = STYLE_STORE_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf-8');
  fs.renameSync(tmp, STYLE_STORE_PATH);
}

function resolveStyle(input: unknown): DeckStyle {
  if (input == null) return { ...STYLE_PRESETS.clean_light.style };
  if (typeof input === 'string') {
    const preset = STYLE_PRESETS[input];
    if (!preset) throw new Error(`Unknown style preset '${input}'. Available: ${Object.keys(STYLE_PRESETS).join(', ')}`);
    return { ...preset.style };
  }
  if (typeof input === 'object') {
    // Merge onto clean_light so missing keys are filled in
    return { ...STYLE_PRESETS.clean_light.style, ...(input as Partial<DeckStyle>) };
  }
  throw new Error(`Invalid style value — must be a preset name or DeckStyle object`);
}

function getStoredStyle(presentationId: string): DeckStyle {
  const store = readStyleStore();
  if (store[presentationId]) {
    // Merge onto defaults so any new fields added later (e.g. slide_width_pt)
    // get filled in for old persisted styles.
    return { ...STYLE_PRESETS.clean_light.style, ...store[presentationId] };
  }
  return { ...STYLE_PRESETS.clean_light.style };
}

function setStoredStyle(presentationId: string, style: DeckStyle): void {
  const store = readStyleStore();
  store[presentationId] = style;
  writeStyleStore(store);
}

// ─────────────────────────────────────────
// Role-based text style resolution
// ─────────────────────────────────────────

type TextRole = 'title' | 'heading' | 'body' | 'subtitle' | 'caption';
const VALID_ROLES: TextRole[] = ['title', 'heading', 'body', 'subtitle', 'caption'];

function roleTextStyle(style: DeckStyle, role: TextRole, overrides?: Partial<DeckStyle>) {
  const eff: DeckStyle = { ...style, ...(overrides ?? {}) };
  const font = eff[`${role}_font` as keyof DeckStyle] as string;
  const size = eff[`${role}_size` as keyof DeckStyle] as number;
  const color = eff[`${role}_color` as keyof DeckStyle] as string;
  const bold = eff[`${role}_bold` as keyof DeckStyle] as boolean;
  return {
    fontFamily: font,
    fontSize: { magnitude: size, unit: 'PT' as const },
    foregroundColor: { opaqueColor: opaqueColor(color) },
    bold: !!bold,
  };
}

const TEXT_STYLE_FIELDS = 'fontFamily,fontSize,foregroundColor,bold';

// ─────────────────────────────────────────
// Drive image helper
// ─────────────────────────────────────────
//
// Problem: the Slides API `createImage` request fetches its URL anonymously.
// Private Drive files can't be embedded by passing a Drive URL directly —
// the Slides fetcher isn't authenticated as the caller.
//
// Solution: before embedding, check if the file already has a public/link
// permission. If not, temporarily grant `anyone-with-link` reader access,
// let Slides fetch and cache the image, then revoke the permission in a
// finally block. Presentations store a durable copy of the image, so
// revocation after embedding is safe — the deck keeps working.
//
// Returns a prep object with the image URL to pass to createImage and a
// cleanup function the caller MUST invoke in finally.

interface DriveImagePrep {
  ok: boolean;
  url?: string;
  cleanup: () => Promise<void>;
  error?: string;
}

async function prepareDriveImageUrl(
  driveFileId: string,
  agentId: string,
  agentName: string,
  action: string,
): Promise<DriveImagePrep> {
  const noop = async () => { /* nothing to clean up */ };

  // Step 1: inspect existing permissions to see if the file is already
  // accessible via link (in which case we don't need to touch anything).
  const permsUrl = `${DRIVE_BASE}/files/${encodeURIComponent(driveFileId)}/permissions?fields=permissions(id,type,role)&supportsAllDrives=true`;
  const permsResult = await googleRead(permsUrl, agentId, agentName, `${action}_check_perms`, { driveFileId });

  if (!permsResult.ok) {
    return {
      ok: false,
      cleanup: noop,
      error: `Cannot read Drive file permissions for ${driveFileId}: ${permsResult.error}. Make sure the agent's Google account has access to this file.`,
    };
  }

  const existingPerms = (permsResult.data as { permissions?: Array<{ id?: string; type?: string; role?: string }> }).permissions ?? [];
  const hasPublicAccess = existingPerms.some(
    p => p.type === 'anyone' && (p.role === 'reader' || p.role === 'commenter' || p.role === 'writer'),
  );

  const url = `https://drive.google.com/uc?export=view&id=${encodeURIComponent(driveFileId)}`;

  if (hasPublicAccess) {
    // Already link-shared. Use URL directly with no cleanup needed.
    return { ok: true, url, cleanup: noop };
  }

  // Step 2: grant a temporary anyone-with-link reader permission.
  const grantUrl = `${DRIVE_BASE}/files/${encodeURIComponent(driveFileId)}/permissions?supportsAllDrives=true&sendNotificationEmail=false`;
  const grant = await googleWrite(
    'POST',
    grantUrl,
    { role: 'reader', type: 'anyone', allowFileDiscovery: false },
    agentId, agentName, `${action}_grant_temp_link`, { driveFileId },
  );

  if (!grant.ok) {
    return {
      ok: false,
      cleanup: noop,
      error: `Cannot grant temporary share link for Drive file ${driveFileId}: ${grant.error}. The agent's Google account must have "can share" permission on the file.`,
    };
  }

  const permissionId = (grant.data as { id?: string }).id;
  if (!permissionId) {
    return {
      ok: false,
      cleanup: noop,
      error: `Drive grant returned no permission ID for file ${driveFileId}.`,
    };
  }

  // Brief propagation wait — permission changes are usually instant but
  // Slides' URL fetcher can race against the grant otherwise.
  await new Promise(resolve => setTimeout(resolve, 600));

  const cleanup = async () => {
    try {
      await googleWrite(
        'DELETE',
        `${DRIVE_BASE}/files/${encodeURIComponent(driveFileId)}/permissions/${encodeURIComponent(permissionId)}?supportsAllDrives=true`,
        undefined,
        agentId, agentName, `${action}_revoke_temp_link`, { driveFileId, permissionId },
      );
    } catch {
      // Best effort — if revocation fails the file is still only
      // link-visible (not discoverable), so leaked access is bounded.
    }
  };

  return { ok: true, url, cleanup };
}

async function runWithCleanups<T>(
  cleanups: Array<() => Promise<void>>,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } finally {
    for (const cleanup of cleanups) {
      await cleanup();
    }
  }
}

// ─────────────────────────────────────────
// Tool definitions
// ─────────────────────────────────────────

const ptParam = (desc: string) => ({ type: 'number', description: desc });
const geomParams = {
  x_pt: ptParam('X position in points from slide top-left'),
  y_pt: ptParam('Y position in points from slide top-left'),
  width_pt: ptParam('Width in points'),
  height_pt: ptParam('Height in points'),
};
const geomRequired = ['x_pt', 'y_pt', 'width_pt', 'height_pt'];

export const slidesToolDefinitions: ToolDefinition[] = [
  // ── Style & deck management ──
  {
    name: 'slides_create_presentation',
    description: 'Create a new Google Slides presentation with a DeckStyle applied. Default dimensions are 720×405pt (16:9 widescreen, renders at 1920×1080 pixels). Pass width_pt/height_pt to override. The style is persisted per-presentation and used by every subsequent slides_* call automatically. Replaces the old slides_create tool.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Presentation title' },
        style: { type: 'string', description: 'Preset name (clean_light, clean_dark, bold_modern, minimal) or a JSON DeckStyle object encoded as a string. Default: clean_light' },
        width_pt: { type: 'number', description: 'Slide width in points. Default 720 (16:9 widescreen). Common alternatives: 720 for 4:3 with height 540, 960 for PowerPoint widescreen.' },
        height_pt: { type: 'number', description: 'Slide height in points. Default 405 (16:9 widescreen).' },
      },
      required: ['title'],
    },
  },
  {
    name: 'slides_set_style',
    description: 'Set or update the active DeckStyle for an existing presentation. Persists to disk so all later tool calls use the new fonts, colors, and spacing.',
    input_schema: {
      type: 'object',
      properties: {
        presentation_id: { type: 'string', description: 'Presentation ID' },
        style: { type: 'string', description: 'Preset name or JSON DeckStyle object as a string' },
      },
      required: ['presentation_id', 'style'],
    },
  },
  {
    name: 'slides_get_style',
    description: 'Return the current active DeckStyle for a presentation as JSON.',
    input_schema: {
      type: 'object',
      properties: {
        presentation_id: { type: 'string', description: 'Presentation ID' },
      },
      required: ['presentation_id'],
    },
  },
  {
    name: 'slides_list_presets',
    description: 'List the available DeckStyle preset names and their descriptions.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },

  // ── Slide operations ──
  {
    name: 'slides_add_slide',
    description: 'Add a new slide to a presentation using a predefined layout. Applies the deck style background automatically.',
    input_schema: {
      type: 'object',
      properties: {
        presentation_id: { type: 'string', description: 'Presentation ID' },
        layout: { type: 'string', description: 'BLANK, TITLE, TITLE_AND_BODY, TITLE_AND_TWO_COLUMNS, SECTION_HEADER, or CAPTION_ONLY. Default BLANK.' },
        insertion_index: { type: 'number', description: '0-based position, -1 to append (default)' },
      },
      required: ['presentation_id'],
    },
  },
  {
    name: 'slides_duplicate_slide',
    description: 'Duplicate an existing slide. Returns the new slide ID.',
    input_schema: {
      type: 'object',
      properties: {
        presentation_id: { type: 'string' },
        slide_id: { type: 'string' },
      },
      required: ['presentation_id', 'slide_id'],
    },
  },
  {
    name: 'slides_delete_slide',
    description: 'Delete a slide from a presentation.',
    input_schema: {
      type: 'object',
      properties: {
        presentation_id: { type: 'string' },
        slide_id: { type: 'string' },
      },
      required: ['presentation_id', 'slide_id'],
    },
  },
  {
    name: 'slides_reorder_slides',
    description: 'Move a set of slides to a new position in the presentation.',
    input_schema: {
      type: 'object',
      properties: {
        presentation_id: { type: 'string' },
        slide_ids: { type: 'array', items: { type: 'string' }, description: 'Slide IDs to move, in final order' },
        insertion_index: { type: 'number', description: '0-based target index' },
      },
      required: ['presentation_id', 'slide_ids', 'insertion_index'],
    },
  },
  {
    name: 'slides_set_background',
    description: 'Set a slide background to a solid color or a stretched image URL. Provide exactly one of color or image_url.',
    input_schema: {
      type: 'object',
      properties: {
        presentation_id: { type: 'string' },
        slide_id: { type: 'string' },
        color: { type: 'string', description: 'Hex color like #1a1a2e' },
        image_url: { type: 'string', description: 'Publicly accessible image URL' },
      },
      required: ['presentation_id', 'slide_id'],
    },
  },

  // ── Text operations ──
  {
    name: 'slides_add_text_box',
    description: 'Place a styled text box on a slide. The role determines which DeckStyle properties are applied (title, heading, body, subtitle, caption).',
    input_schema: {
      type: 'object',
      properties: {
        presentation_id: { type: 'string' },
        slide_id: { type: 'string' },
        text: { type: 'string' },
        ...geomParams,
        role: { type: 'string', description: 'title | heading | body | subtitle | caption (default body)' },
        style_overrides: { type: 'string', description: 'Optional JSON object to override any DeckStyle keys for this box' },
      },
      required: ['presentation_id', 'slide_id', 'text', ...geomRequired],
    },
  },
  {
    name: 'slides_add_bullet_list',
    description: 'Create a text box containing a bulleted list. Prefix items with \\t to nest.',
    input_schema: {
      type: 'object',
      properties: {
        presentation_id: { type: 'string' },
        slide_id: { type: 'string' },
        items: { type: 'array', items: { type: 'string' }, description: 'Bullet items' },
        ...geomParams,
        role: { type: 'string', description: 'title | heading | body | subtitle | caption (default body)' },
      },
      required: ['presentation_id', 'slide_id', 'items', ...geomRequired],
    },
  },
  {
    name: 'slides_update_text',
    description: 'Replace all text in an existing text box.',
    input_schema: {
      type: 'object',
      properties: {
        presentation_id: { type: 'string' },
        text_box_id: { type: 'string' },
        new_text: { type: 'string' },
      },
      required: ['presentation_id', 'text_box_id', 'new_text'],
    },
  },
  {
    name: 'slides_style_text_range',
    description: 'Apply formatting to a specific character range within a text box. Only the properties you specify are changed.',
    input_schema: {
      type: 'object',
      properties: {
        presentation_id: { type: 'string' },
        text_box_id: { type: 'string' },
        start_index: { type: 'number' },
        end_index: { type: 'number' },
        bold: { type: 'boolean' },
        italic: { type: 'boolean' },
        underline: { type: 'boolean' },
        font_size_pt: { type: 'number' },
        font_family: { type: 'string' },
        color: { type: 'string', description: 'Hex color' },
        link_url: { type: 'string' },
      },
      required: ['presentation_id', 'text_box_id', 'start_index', 'end_index'],
    },
  },

  // ── Image operations ──
  {
    name: 'slides_add_image',
    description: 'Insert an image from a publicly accessible URL.',
    input_schema: {
      type: 'object',
      properties: {
        presentation_id: { type: 'string' },
        slide_id: { type: 'string' },
        image_url: { type: 'string' },
        ...geomParams,
      },
      required: ['presentation_id', 'slide_id', 'image_url', ...geomRequired],
    },
  },
  {
    name: 'slides_add_image_from_drive',
    description: 'Insert an image from a Google Drive file the agent has access to.',
    input_schema: {
      type: 'object',
      properties: {
        presentation_id: { type: 'string' },
        slide_id: { type: 'string' },
        drive_file_id: { type: 'string' },
        ...geomParams,
      },
      required: ['presentation_id', 'slide_id', 'drive_file_id', ...geomRequired],
    },
  },
  {
    name: 'slides_replace_shape_with_image',
    description: 'Find every shape containing placeholder_text and replace it with the image. Useful for template workflows.',
    input_schema: {
      type: 'object',
      properties: {
        presentation_id: { type: 'string' },
        image_url: { type: 'string' },
        placeholder_text: { type: 'string' },
        replace_method: { type: 'string', description: 'CENTER_INSIDE or CENTER_CROP (default)' },
      },
      required: ['presentation_id', 'image_url', 'placeholder_text'],
    },
  },

  // ── Video operations ──
  {
    name: 'slides_add_video',
    description: 'Embed a YouTube or Google Drive video on a slide. source must be YOUTUBE or GOOGLE_DRIVE.',
    input_schema: {
      type: 'object',
      properties: {
        presentation_id: { type: 'string' },
        slide_id: { type: 'string' },
        source: { type: 'string', description: 'YOUTUBE or GOOGLE_DRIVE' },
        video_id: { type: 'string', description: 'YouTube video ID (bare) or Drive file ID' },
        ...geomParams,
      },
      required: ['presentation_id', 'slide_id', 'source', 'video_id', ...geomRequired],
    },
  },

  // ── Shape operations ──
  {
    name: 'slides_add_shape',
    description: 'Create a shape on a slide. Common shape_types: RECTANGLE, ROUND_RECTANGLE, ELLIPSE, TRIANGLE, DIAMOND, HEXAGON, PENTAGON, ARROW_RIGHT, STAR, CLOUD, CHEVRON, CALLOUT_RECTANGLE, FLOW_CHART_PROCESS, FLOW_CHART_DECISION.',
    input_schema: {
      type: 'object',
      properties: {
        presentation_id: { type: 'string' },
        slide_id: { type: 'string' },
        shape_type: { type: 'string' },
        ...geomParams,
        fill_color: { type: 'string', description: 'Hex fill color. Defaults to DeckStyle accent_color.' },
        outline_color: { type: 'string', description: 'Hex outline color' },
        outline_weight_pt: { type: 'number' },
        text: { type: 'string', description: 'Optional body-styled text to insert in the shape' },
      },
      required: ['presentation_id', 'slide_id', 'shape_type', ...geomRequired],
    },
  },
  {
    name: 'slides_add_line',
    description: 'Draw a straight line on a slide.',
    input_schema: {
      type: 'object',
      properties: {
        presentation_id: { type: 'string' },
        slide_id: { type: 'string' },
        start_x_pt: { type: 'number' },
        start_y_pt: { type: 'number' },
        end_x_pt: { type: 'number' },
        end_y_pt: { type: 'number' },
        color: { type: 'string', description: 'Hex. Defaults to DeckStyle accent_color.' },
        weight_pt: { type: 'number', description: 'Default 2' },
        dash_style: { type: 'string', description: 'SOLID, DOT, DASH, DASH_DOT, LONG_DASH (default SOLID)' },
      },
      required: ['presentation_id', 'slide_id', 'start_x_pt', 'start_y_pt', 'end_x_pt', 'end_y_pt'],
    },
  },

  // ── Table operations ──
  {
    name: 'slides_add_table',
    description: 'Create an empty table on a slide.',
    input_schema: {
      type: 'object',
      properties: {
        presentation_id: { type: 'string' },
        slide_id: { type: 'string' },
        rows: { type: 'number' },
        cols: { type: 'number' },
        ...geomParams,
      },
      required: ['presentation_id', 'slide_id', 'rows', 'cols', ...geomRequired],
    },
  },
  {
    name: 'slides_populate_table',
    description: 'Fill an entire table from a 2D array of strings. Optionally styles the first row with bold text and an accent background.',
    input_schema: {
      type: 'object',
      properties: {
        presentation_id: { type: 'string' },
        table_id: { type: 'string' },
        data: { type: 'array', items: { type: 'array', items: { type: 'string' } }, description: 'Row-major cell values' },
        header_row: { type: 'boolean', description: 'Default true' },
      },
      required: ['presentation_id', 'table_id', 'data'],
    },
  },

  // ── Layout helpers (compound) ──
  {
    name: 'slides_layout_title',
    description: 'Create a fully formatted title slide with centered title and subtitle. Optionally uses an image URL as the background.',
    input_schema: {
      type: 'object',
      properties: {
        presentation_id: { type: 'string' },
        title: { type: 'string' },
        subtitle: { type: 'string' },
        background_image_url: { type: 'string' },
      },
      required: ['presentation_id', 'title'],
    },
  },
  {
    name: 'slides_layout_section',
    description: 'Create a section divider slide with a large heading on the accent-colored background.',
    input_schema: {
      type: 'object',
      properties: {
        presentation_id: { type: 'string' },
        heading: { type: 'string' },
        subheading: { type: 'string' },
      },
      required: ['presentation_id', 'heading'],
    },
  },
  {
    name: 'slides_layout_content',
    description: 'The workhorse slide: title at top, body content below. If both text/bullets and an image are provided, automatically splits into two columns based on image_position (right, left, bottom, full).',
    input_schema: {
      type: 'object',
      properties: {
        presentation_id: { type: 'string' },
        title: { type: 'string' },
        body_text: { type: 'string' },
        bullets: { type: 'array', items: { type: 'string' } },
        image_url: { type: 'string' },
        image_position: { type: 'string', description: 'right (default), left, bottom, full' },
      },
      required: ['presentation_id', 'title'],
    },
  },
  {
    name: 'slides_layout_two_column',
    description: 'Create a two-column slide. Each column object may contain text, bullets, image_url, or image_drive_id.',
    input_schema: {
      type: 'object',
      properties: {
        presentation_id: { type: 'string' },
        title: { type: 'string' },
        left: { type: 'string', description: 'JSON object as a string: {text?, bullets?, image_url?, image_drive_id?}' },
        right: { type: 'string', description: 'JSON object as a string: {text?, bullets?, image_url?, image_drive_id?}' },
      },
      required: ['presentation_id', 'title', 'left', 'right'],
    },
  },
  {
    name: 'slides_layout_image',
    description: 'Create a slide dominated by a large image with an optional caption below.',
    input_schema: {
      type: 'object',
      properties: {
        presentation_id: { type: 'string' },
        title: { type: 'string' },
        image_url: { type: 'string' },
        image_drive_id: { type: 'string' },
        caption: { type: 'string' },
      },
      required: ['presentation_id', 'title'],
    },
  },
  {
    name: 'slides_layout_comparison',
    description: 'Create a side-by-side comparison slide with 2-4 items. Each item: {heading, points, image_url?}.',
    input_schema: {
      type: 'object',
      properties: {
        presentation_id: { type: 'string' },
        title: { type: 'string' },
        items: { type: 'array', items: { type: 'object' }, description: 'Array of {heading, points, image_url?} — 2 to 4 items' },
      },
      required: ['presentation_id', 'title', 'items'],
    },
  },

  // ── Utility ──
  {
    name: 'slides_get_slides',
    description: 'Return the list of all slides in a presentation with their object IDs and indices.',
    input_schema: {
      type: 'object',
      properties: {
        presentation_id: { type: 'string' },
      },
      required: ['presentation_id'],
    },
  },
  {
    name: 'slides_get_elements',
    description: 'Return every page element on a slide with element_id, type, and position/size in points.',
    input_schema: {
      type: 'object',
      properties: {
        presentation_id: { type: 'string' },
        slide_id: { type: 'string' },
      },
      required: ['presentation_id', 'slide_id'],
    },
  },
  {
    name: 'slides_delete_element',
    description: 'Delete any page element by object ID.',
    input_schema: {
      type: 'object',
      properties: {
        presentation_id: { type: 'string' },
        element_id: { type: 'string' },
      },
      required: ['presentation_id', 'element_id'],
    },
  },
  {
    name: 'slides_move_element',
    description: 'Move a page element to an absolute position (points).',
    input_schema: {
      type: 'object',
      properties: {
        presentation_id: { type: 'string' },
        element_id: { type: 'string' },
        x_pt: { type: 'number' },
        y_pt: { type: 'number' },
      },
      required: ['presentation_id', 'element_id', 'x_pt', 'y_pt'],
    },
  },
  {
    name: 'slides_resize_element',
    description: 'Resize a page element to a target width/height in points.',
    input_schema: {
      type: 'object',
      properties: {
        presentation_id: { type: 'string' },
        element_id: { type: 'string' },
        width_pt: { type: 'number' },
        height_pt: { type: 'number' },
      },
      required: ['presentation_id', 'element_id', 'width_pt', 'height_pt'],
    },
  },
  {
    name: 'slides_find_replace',
    description: 'Global find-and-replace text across the entire presentation.',
    input_schema: {
      type: 'object',
      properties: {
        presentation_id: { type: 'string' },
        find_text: { type: 'string' },
        replace_text: { type: 'string' },
      },
      required: ['presentation_id', 'find_text', 'replace_text'],
    },
  },
];

// Exported list of tool names, used by the tool registrar
export const slidesToolNames: string[] = slidesToolDefinitions.map(t => t.name);

// ─────────────────────────────────────────
// Tool execution
// ─────────────────────────────────────────

type Req = Record<string, unknown>;

interface BatchResult {
  ok: boolean;
  data: unknown;
  error?: string;
}

async function batchUpdate(
  presentationId: string,
  requests: Req[],
  agentId: string,
  agentName: string,
  toolName: string,
  details: Record<string, unknown>,
): Promise<BatchResult> {
  if (requests.length === 0) return { ok: true, data: { replies: [] } };
  const result = await googleWrite(
    'POST',
    `${SLIDES_BASE}/${encodeURIComponent(presentationId)}:batchUpdate`,
    { requests },
    agentId,
    agentName,
    toolName,
    details,
  );
  return { ok: result.ok, data: result.data, error: result.error };
}

async function getPresentation(
  presentationId: string,
  agentId: string,
  agentName: string,
  toolName: string,
): Promise<BatchResult> {
  const result = await googleRead(
    `${SLIDES_BASE}/${encodeURIComponent(presentationId)}`,
    agentId,
    agentName,
    toolName,
    { presentationId },
  );
  return { ok: result.ok, data: result.data, error: result.error };
}

function ok(obj: unknown): string {
  return JSON.stringify(obj);
}

function err(message: string): string {
  return `Error: ${message}`;
}

function parseJsonArg(arg: unknown): unknown {
  if (arg == null) return undefined;
  if (typeof arg === 'object') return arg;
  if (typeof arg === 'string') {
    const s = arg.trim();
    if (!s) return undefined;
    try {
      return JSON.parse(s);
    } catch {
      return s;
    }
  }
  return arg;
}

function buildTextBoxRequests(
  slideId: string,
  text: string,
  xPt: number,
  yPt: number,
  widthPt: number,
  heightPt: number,
  textStyle: ReturnType<typeof roleTextStyle>,
  lineSpacing: number,
  objectId?: string,
): { textBoxId: string; requests: Req[] } {
  const textBoxId = objectId ?? genId('txt');
  const requests: Req[] = [
    {
      createShape: {
        objectId: textBoxId,
        shapeType: 'TEXT_BOX',
        elementProperties: {
          pageObjectId: slideId,
          size: pageSize(widthPt, heightPt),
          transform: pageTransform(xPt, yPt),
        },
      },
    },
  ];
  if (text) {
    requests.push({
      insertText: { objectId: textBoxId, insertionIndex: 0, text },
    });
    requests.push({
      updateTextStyle: {
        objectId: textBoxId,
        textRange: { type: 'ALL' },
        style: textStyle,
        fields: TEXT_STYLE_FIELDS,
      },
    });
    requests.push({
      updateParagraphStyle: {
        objectId: textBoxId,
        textRange: { type: 'ALL' },
        style: { lineSpacing: lineSpacing * 100 },
        fields: 'lineSpacing',
      },
    });
  }
  return { textBoxId, requests };
}

function backgroundRequest(
  slideId: string,
  color?: string,
  imageUrl?: string,
): Req | null {
  if (color) {
    return {
      updatePageProperties: {
        objectId: slideId,
        pageProperties: {
          pageBackgroundFill: { solidFill: solidFill(color) },
        },
        fields: 'pageBackgroundFill.solidFill.color',
      },
    };
  }
  if (imageUrl) {
    return {
      updatePageProperties: {
        objectId: slideId,
        pageProperties: {
          pageBackgroundFill: { stretchedPictureFill: { contentUrl: imageUrl } },
        },
        fields: 'pageBackgroundFill.stretchedPictureFill.contentUrl',
      },
    };
  }
  return null;
}

async function addSlideInternal(
  presentationId: string,
  layout: string,
  insertionIndex: number,
  agentId: string,
  agentName: string,
  toolName: string,
): Promise<{ ok: boolean; slideId?: string; index?: number; error?: string }> {
  const slideId = genId('slide');
  const req: Req = {
    createSlide: {
      objectId: slideId,
      slideLayoutReference: { predefinedLayout: layout },
    },
  };
  if (insertionIndex >= 0) {
    (req.createSlide as Record<string, unknown>).insertionIndex = insertionIndex;
  }

  const r = await batchUpdate(presentationId, [req], agentId, agentName, toolName, { layout, insertionIndex });
  if (!r.ok) return { ok: false, error: r.error };

  // Apply deck background to new slide
  const style = getStoredStyle(presentationId);
  const bg = backgroundRequest(slideId, style.slide_background_color);
  if (bg) {
    await batchUpdate(presentationId, [bg], agentId, agentName, toolName, { slideId, applyBg: true });
  }

  // Look up the slide's final index
  const pres = await getPresentation(presentationId, agentId, agentName, toolName);
  let index = insertionIndex;
  if (pres.ok && pres.data && typeof pres.data === 'object') {
    const slides = (pres.data as { slides?: Array<{ objectId?: string }> }).slides ?? [];
    const found = slides.findIndex(s => s.objectId === slideId);
    if (found >= 0) index = found;
  }
  return { ok: true, slideId, index };
}

// Main execution dispatcher
export async function executeGoogleSlidesTool(
  name: string,
  args: Record<string, unknown>,
  agentId: string,
  agentName: string,
): Promise<string> {
  try {
    switch (name) {
      // ── Style & deck management ──

      case 'slides_create_presentation': {
        const title = args.title as string;
        let style: DeckStyle;
        try {
          style = resolveStyle(parseJsonArg(args.style) ?? 'clean_light');
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e));
        }

        // Apply dimension overrides to the style before persisting.
        if (typeof args.width_pt === 'number') style.slide_width_pt = args.width_pt;
        if (typeof args.height_pt === 'number') style.slide_height_pt = args.height_pt;

        // Set pageSize on the create body so the deck opens at the right
        // aspect ratio instead of Slides' default widescreen.
        const createBody: Record<string, unknown> = {
          title,
          pageSize: {
            width: { magnitude: ptToEmu(style.slide_width_pt), unit: 'EMU' },
            height: { magnitude: ptToEmu(style.slide_height_pt), unit: 'EMU' },
          },
        };

        const result = await googleWrite(
          'POST',
          SLIDES_BASE,
          createBody,
          agentId, agentName, 'slides_create_presentation',
          { title, width_pt: style.slide_width_pt, height_pt: style.slide_height_pt },
        );
        if (!result.ok) return `Error creating presentation: ${result.error}`;
        const data = result.data as { presentationId?: string; slides?: Array<{ objectId?: string }> };
        const presentationId = data.presentationId;
        if (!presentationId) return err('No presentation ID returned');
        setStoredStyle(presentationId, style);

        // Apply background to the auto-created first slide
        const firstSlideId = data.slides?.[0]?.objectId;
        if (firstSlideId) {
          const bg = backgroundRequest(firstSlideId, style.slide_background_color);
          if (bg) {
            await batchUpdate(presentationId, [bg], agentId, agentName, 'slides_create_presentation', { firstSlideId });
          }
        }

        return ok({
          presentation_id: presentationId,
          url: `https://docs.google.com/presentation/d/${presentationId}/edit`,
          slide_width_pt: style.slide_width_pt,
          slide_height_pt: style.slide_height_pt,
          style,
        });
      }

      case 'slides_set_style': {
        const presentationId = args.presentation_id as string;
        let style: DeckStyle;
        try {
          style = resolveStyle(parseJsonArg(args.style));
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e));
        }
        setStoredStyle(presentationId, style);
        return ok({ style });
      }

      case 'slides_get_style': {
        const presentationId = args.presentation_id as string;
        return ok({ style: getStoredStyle(presentationId) });
      }

      case 'slides_list_presets': {
        const presets = Object.entries(STYLE_PRESETS).map(([n, p]) => ({
          name: n,
          description: p.description,
        }));
        return ok({ presets });
      }

      // ── Slide operations ──

      case 'slides_add_slide': {
        const presentationId = args.presentation_id as string;
        const layout = ((args.layout as string) ?? 'BLANK').toUpperCase();
        const insertionIndex = typeof args.insertion_index === 'number' ? args.insertion_index : -1;
        const r = await addSlideInternal(presentationId, layout, insertionIndex, agentId, agentName, 'slides_add_slide');
        if (!r.ok) return `Error adding slide: ${r.error}`;
        return ok({ slide_id: r.slideId, index: r.index });
      }

      case 'slides_duplicate_slide': {
        const presentationId = args.presentation_id as string;
        const slideId = args.slide_id as string;
        const newId = genId('slide');
        const r = await batchUpdate(presentationId, [{
          duplicateObject: { objectId: slideId, objectIds: { [slideId]: newId } },
        }], agentId, agentName, 'slides_duplicate_slide', { slideId });
        if (!r.ok) return `Error duplicating slide: ${r.error}`;
        return ok({ new_slide_id: newId });
      }

      case 'slides_delete_slide': {
        const presentationId = args.presentation_id as string;
        const slideId = args.slide_id as string;
        const r = await batchUpdate(presentationId, [{ deleteObject: { objectId: slideId } }],
          agentId, agentName, 'slides_delete_slide', { slideId });
        if (!r.ok) return `Error deleting slide: ${r.error}`;
        return ok({ ok: true });
      }

      case 'slides_reorder_slides': {
        const presentationId = args.presentation_id as string;
        const slideIds = args.slide_ids as string[];
        const insertionIndex = args.insertion_index as number;
        const r = await batchUpdate(presentationId, [{
          updateSlidesPosition: { slideObjectIds: slideIds, insertionIndex },
        }], agentId, agentName, 'slides_reorder_slides', { slideIds, insertionIndex });
        if (!r.ok) return `Error reordering slides: ${r.error}`;
        return ok({ ok: true });
      }

      case 'slides_set_background': {
        const presentationId = args.presentation_id as string;
        const slideId = args.slide_id as string;
        const color = args.color as string | undefined;
        const imageUrl = args.image_url as string | undefined;
        if ((!color && !imageUrl) || (color && imageUrl)) {
          return err('Provide exactly one of color or image_url');
        }
        const req = backgroundRequest(slideId, color, imageUrl);
        if (!req) return err('No background request built');
        const r = await batchUpdate(presentationId, [req], agentId, agentName, 'slides_set_background', { slideId });
        if (!r.ok) return `Error setting background: ${r.error}`;
        return ok({ ok: true });
      }

      // ── Text ──

      case 'slides_add_text_box': {
        const presentationId = args.presentation_id as string;
        const slideId = args.slide_id as string;
        const text = args.text as string;
        const xPt = args.x_pt as number;
        const yPt = args.y_pt as number;
        const widthPt = args.width_pt as number;
        const heightPt = args.height_pt as number;
        const role = ((args.role as string) ?? 'body') as TextRole;
        if (!VALID_ROLES.includes(role)) return err(`Invalid role '${role}'`);
        const overrides = parseJsonArg(args.style_overrides) as Partial<DeckStyle> | undefined;
        const style = getStoredStyle(presentationId);
        const textStyle = roleTextStyle(style, role, overrides);
        const { textBoxId, requests } = buildTextBoxRequests(
          slideId, text, xPt, yPt, widthPt, heightPt, textStyle, style.line_spacing,
        );
        const r = await batchUpdate(presentationId, requests, agentId, agentName, 'slides_add_text_box', { slideId, role });
        if (!r.ok) return `Error adding text box: ${r.error}`;
        return ok({ text_box_id: textBoxId });
      }

      case 'slides_add_bullet_list': {
        const presentationId = args.presentation_id as string;
        const slideId = args.slide_id as string;
        const items = args.items as string[];
        const xPt = args.x_pt as number;
        const yPt = args.y_pt as number;
        const widthPt = args.width_pt as number;
        const heightPt = args.height_pt as number;
        const role = ((args.role as string) ?? 'body') as TextRole;
        if (!VALID_ROLES.includes(role)) return err(`Invalid role '${role}'`);
        if (!items || items.length === 0) return err('items must not be empty');

        const style = getStoredStyle(presentationId);
        const textStyle = roleTextStyle(style, role);
        const joined = items.join('\n');
        const { textBoxId, requests } = buildTextBoxRequests(
          slideId, joined, xPt, yPt, widthPt, heightPt, textStyle, style.line_spacing,
        );
        requests.push({
          createParagraphBullets: {
            objectId: textBoxId,
            textRange: { type: 'ALL' },
            bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE',
          },
        });
        const r = await batchUpdate(presentationId, requests, agentId, agentName, 'slides_add_bullet_list', { slideId, count: items.length });
        if (!r.ok) return `Error adding bullet list: ${r.error}`;
        return ok({ text_box_id: textBoxId });
      }

      case 'slides_update_text': {
        const presentationId = args.presentation_id as string;
        const textBoxId = args.text_box_id as string;
        const newText = args.new_text as string;
        const r = await batchUpdate(presentationId, [
          { deleteText: { objectId: textBoxId, textRange: { type: 'ALL' } } },
          { insertText: { objectId: textBoxId, insertionIndex: 0, text: newText } },
        ], agentId, agentName, 'slides_update_text', { textBoxId });
        if (!r.ok) return `Error updating text: ${r.error}`;
        return ok({ ok: true });
      }

      case 'slides_style_text_range': {
        const presentationId = args.presentation_id as string;
        const textBoxId = args.text_box_id as string;
        const startIndex = args.start_index as number;
        const endIndex = args.end_index as number;
        const style: Record<string, unknown> = {};
        const fields: string[] = [];
        if (typeof args.bold === 'boolean') { style.bold = args.bold; fields.push('bold'); }
        if (typeof args.italic === 'boolean') { style.italic = args.italic; fields.push('italic'); }
        if (typeof args.underline === 'boolean') { style.underline = args.underline; fields.push('underline'); }
        if (typeof args.font_size_pt === 'number') {
          style.fontSize = { magnitude: args.font_size_pt, unit: 'PT' };
          fields.push('fontSize');
        }
        if (typeof args.font_family === 'string') { style.fontFamily = args.font_family; fields.push('fontFamily'); }
        if (typeof args.color === 'string') {
          style.foregroundColor = { opaqueColor: opaqueColor(args.color) };
          fields.push('foregroundColor');
        }
        if (typeof args.link_url === 'string') {
          style.link = { url: args.link_url };
          fields.push('link');
        }
        if (fields.length === 0) return err('Must specify at least one style property');
        const r = await batchUpdate(presentationId, [{
          updateTextStyle: {
            objectId: textBoxId,
            textRange: { type: 'FIXED_RANGE', startIndex, endIndex },
            style,
            fields: fields.join(','),
          },
        }], agentId, agentName, 'slides_style_text_range', { textBoxId, fields });
        if (!r.ok) return `Error styling text: ${r.error}`;
        return ok({ ok: true });
      }

      // ── Images ──

      case 'slides_add_image': {
        const presentationId = args.presentation_id as string;
        const slideId = args.slide_id as string;
        const imageUrl = args.image_url as string;
        const xPt = args.x_pt as number;
        const yPt = args.y_pt as number;
        const widthPt = args.width_pt as number;
        const heightPt = args.height_pt as number;
        const imageId = genId('img');
        const r = await batchUpdate(presentationId, [{
          createImage: {
            objectId: imageId,
            url: imageUrl,
            elementProperties: {
              pageObjectId: slideId,
              size: pageSize(widthPt, heightPt),
              transform: pageTransform(xPt, yPt),
            },
          },
        }], agentId, agentName, 'slides_add_image', { slideId });
        if (!r.ok) return `Error adding image: ${r.error} (URL must be publicly accessible)`;
        return ok({ image_id: imageId });
      }

      case 'slides_add_image_from_drive': {
        const presentationId = args.presentation_id as string;
        const slideId = args.slide_id as string;
        const driveFileId = args.drive_file_id as string;
        const xPt = args.x_pt as number;
        const yPt = args.y_pt as number;
        const widthPt = args.width_pt as number;
        const heightPt = args.height_pt as number;

        const prep = await prepareDriveImageUrl(driveFileId, agentId, agentName, 'slides_add_image_from_drive');
        if (!prep.ok || !prep.url) return err(prep.error ?? 'Failed to prepare Drive image URL');

        try {
          const imageId = genId('img');
          const r = await batchUpdate(presentationId, [{
            createImage: {
              objectId: imageId,
              url: prep.url,
              elementProperties: {
                pageObjectId: slideId,
                size: pageSize(widthPt, heightPt),
                transform: pageTransform(xPt, yPt),
              },
            },
          }], agentId, agentName, 'slides_add_image_from_drive', { slideId, driveFileId });
          if (!r.ok) return `Error adding Drive image: ${r.error}`;
          return ok({ image_id: imageId });
        } finally {
          await prep.cleanup();
        }
      }

      case 'slides_replace_shape_with_image': {
        const presentationId = args.presentation_id as string;
        const imageUrl = args.image_url as string;
        const placeholderText = args.placeholder_text as string;
        const replaceMethod = ((args.replace_method as string) ?? 'CENTER_CROP');
        if (!['CENTER_INSIDE', 'CENTER_CROP'].includes(replaceMethod)) {
          return err('replace_method must be CENTER_INSIDE or CENTER_CROP');
        }
        const r = await batchUpdate(presentationId, [{
          replaceAllShapesWithImage: {
            imageUrl,
            imageReplaceMethod: replaceMethod,
            containsText: { text: placeholderText, matchCase: false },
          },
        }], agentId, agentName, 'slides_replace_shape_with_image', { placeholderText });
        if (!r.ok) return `Error replacing shapes: ${r.error}`;
        const replies = (r.data as { replies?: Array<{ replaceAllShapesWithImage?: { occurrencesChanged?: number } }> }).replies ?? [];
        const count = replies[0]?.replaceAllShapesWithImage?.occurrencesChanged ?? 0;
        return ok({ occurrences_replaced: count });
      }

      // ── Video ──

      case 'slides_add_video': {
        const presentationId = args.presentation_id as string;
        const slideId = args.slide_id as string;
        const source = (args.source as string).toUpperCase();
        const videoId = args.video_id as string;
        const xPt = args.x_pt as number;
        const yPt = args.y_pt as number;
        const widthPt = args.width_pt as number;
        const heightPt = args.height_pt as number;
        if (!['YOUTUBE', 'GOOGLE_DRIVE'].includes(source)) return err('source must be YOUTUBE or GOOGLE_DRIVE');
        const elementId = genId('vid');
        const r = await batchUpdate(presentationId, [{
          createVideo: {
            objectId: elementId,
            source,
            id: videoId,
            elementProperties: {
              pageObjectId: slideId,
              size: pageSize(widthPt, heightPt),
              transform: pageTransform(xPt, yPt),
            },
          },
        }], agentId, agentName, 'slides_add_video', { slideId, source, videoId });
        if (!r.ok) return `Error adding video: ${r.error}`;
        return ok({ video_id: elementId });
      }

      // ── Shapes ──

      case 'slides_add_shape': {
        const presentationId = args.presentation_id as string;
        const slideId = args.slide_id as string;
        const shapeType = args.shape_type as string;
        const xPt = args.x_pt as number;
        const yPt = args.y_pt as number;
        const widthPt = args.width_pt as number;
        const heightPt = args.height_pt as number;
        const style = getStoredStyle(presentationId);
        const fillColor = (args.fill_color as string | undefined) ?? style.accent_color;
        const outlineColor = args.outline_color as string | undefined;
        const outlineWeightPt = args.outline_weight_pt as number | undefined;
        const text = args.text as string | undefined;

        const shapeId = genId('shape');
        const requests: Req[] = [
          {
            createShape: {
              objectId: shapeId,
              shapeType,
              elementProperties: {
                pageObjectId: slideId,
                size: pageSize(widthPt, heightPt),
                transform: pageTransform(xPt, yPt),
              },
            },
          },
          {
            updateShapeProperties: {
              objectId: shapeId,
              shapeProperties: { shapeBackgroundFill: { solidFill: solidFill(fillColor) } },
              fields: 'shapeBackgroundFill.solidFill.color',
            },
          },
        ];

        if (outlineColor || outlineWeightPt != null) {
          const outline: Record<string, unknown> = {};
          const fields: string[] = [];
          if (outlineColor) {
            outline.outlineFill = { solidFill: solidFill(outlineColor) };
            fields.push('outline.outlineFill.solidFill.color');
          }
          if (outlineWeightPt != null) {
            outline.weight = { magnitude: outlineWeightPt, unit: 'PT' };
            fields.push('outline.weight');
          }
          requests.push({
            updateShapeProperties: {
              objectId: shapeId,
              shapeProperties: { outline },
              fields: fields.join(','),
            },
          });
        }

        if (text) {
          const textStyle = roleTextStyle(style, 'body');
          requests.push({ insertText: { objectId: shapeId, insertionIndex: 0, text } });
          requests.push({
            updateTextStyle: {
              objectId: shapeId,
              textRange: { type: 'ALL' },
              style: textStyle,
              fields: TEXT_STYLE_FIELDS,
            },
          });
        }

        const r = await batchUpdate(presentationId, requests, agentId, agentName, 'slides_add_shape', { slideId, shapeType });
        if (!r.ok) return `Error adding shape: ${r.error}`;
        return ok({ shape_id: shapeId });
      }

      case 'slides_add_line': {
        const presentationId = args.presentation_id as string;
        const slideId = args.slide_id as string;
        const sx = args.start_x_pt as number;
        const sy = args.start_y_pt as number;
        const ex = args.end_x_pt as number;
        const ey = args.end_y_pt as number;
        const style = getStoredStyle(presentationId);
        const color = (args.color as string | undefined) ?? style.accent_color;
        const weightPt = (args.weight_pt as number | undefined) ?? 2;
        const dashStyle = ((args.dash_style as string | undefined) ?? 'SOLID').toUpperCase();
        const valid = ['SOLID', 'DOT', 'DASH', 'DASH_DOT', 'LONG_DASH'];
        if (!valid.includes(dashStyle)) return err(`dash_style must be one of ${valid.join(', ')}`);

        const x = Math.min(sx, ex);
        const y = Math.min(sy, ey);
        const w = Math.max(Math.abs(ex - sx), 1);
        const h = Math.max(Math.abs(ey - sy), 1);

        const lineId = genId('line');
        const requests: Req[] = [
          {
            createLine: {
              objectId: lineId,
              lineCategory: 'STRAIGHT',
              elementProperties: {
                pageObjectId: slideId,
                size: pageSize(w, h),
                transform: pageTransform(x, y),
              },
            },
          },
          {
            updateLineProperties: {
              objectId: lineId,
              lineProperties: {
                lineFill: { solidFill: solidFill(color) },
                weight: { magnitude: weightPt, unit: 'PT' },
                dashStyle,
              },
              fields: 'lineFill.solidFill.color,weight,dashStyle',
            },
          },
        ];
        const r = await batchUpdate(presentationId, requests, agentId, agentName, 'slides_add_line', { slideId });
        if (!r.ok) return `Error adding line: ${r.error}`;
        return ok({ line_id: lineId });
      }

      // ── Tables ──

      case 'slides_add_table': {
        const presentationId = args.presentation_id as string;
        const slideId = args.slide_id as string;
        const rows = args.rows as number;
        const cols = args.cols as number;
        const xPt = args.x_pt as number;
        const yPt = args.y_pt as number;
        const widthPt = args.width_pt as number;
        const heightPt = args.height_pt as number;
        if (rows < 1 || cols < 1) return err('rows and cols must be >= 1');
        const tableId = genId('tbl');
        const r = await batchUpdate(presentationId, [{
          createTable: {
            objectId: tableId,
            rows,
            columns: cols,
            elementProperties: {
              pageObjectId: slideId,
              size: pageSize(widthPt, heightPt),
              transform: pageTransform(xPt, yPt),
            },
          },
        }], agentId, agentName, 'slides_add_table', { slideId, rows, cols });
        if (!r.ok) return `Error adding table: ${r.error}`;
        return ok({ table_id: tableId });
      }

      case 'slides_populate_table': {
        const presentationId = args.presentation_id as string;
        const tableId = args.table_id as string;
        const data = args.data as string[][];
        const headerRow = args.header_row !== false;
        if (!data || data.length === 0) return err('data must not be empty');

        const style = getStoredStyle(presentationId);
        const headerBg = style.accent_color;
        const requests: Req[] = [];

        for (let r = 0; r < data.length; r++) {
          for (let c = 0; c < data[r].length; c++) {
            const cellLocation = { rowIndex: r, columnIndex: c };
            const isHeader = headerRow && r === 0;
            const textStyle = roleTextStyle(style, 'body');
            textStyle.bold = isHeader;

            requests.push({
              deleteText: { objectId: tableId, cellLocation, textRange: { type: 'ALL' } },
            });
            requests.push({
              insertText: { objectId: tableId, cellLocation, insertionIndex: 0, text: String(data[r][c] ?? '') },
            });
            requests.push({
              updateTextStyle: {
                objectId: tableId,
                cellLocation,
                textRange: { type: 'ALL' },
                style: textStyle,
                fields: TEXT_STYLE_FIELDS,
              },
            });
            if (isHeader) {
              requests.push({
                updateTableCellProperties: {
                  objectId: tableId,
                  tableRange: { location: cellLocation, rowSpan: 1, columnSpan: 1 },
                  tableCellProperties: {
                    tableCellBackgroundFill: { solidFill: solidFill(headerBg) },
                  },
                  fields: 'tableCellBackgroundFill.solidFill.color',
                },
              });
            }
          }
        }

        const r = await batchUpdate(presentationId, requests, agentId, agentName, 'slides_populate_table', { tableId, rowCount: data.length });
        if (!r.ok) return `Error populating table: ${r.error}`;
        return ok({ ok: true });
      }

      // ── Layout helpers ──

      case 'slides_layout_title': {
        const presentationId = args.presentation_id as string;
        const title = args.title as string;
        const subtitle = (args.subtitle as string | undefined) ?? '';
        const backgroundImageUrl = args.background_image_url as string | undefined;

        const style = getStoredStyle(presentationId);
        const slideR = await addSlideInternal(presentationId, 'BLANK', -1, agentId, agentName, 'slides_layout_title');
        if (!slideR.ok || !slideR.slideId) return `Error creating title slide: ${slideR.error}`;
        const slideId = slideR.slideId;

        if (backgroundImageUrl) {
          const bg = backgroundRequest(slideId, undefined, backgroundImageUrl);
          if (bg) {
            await batchUpdate(presentationId, [bg], agentId, agentName, 'slides_layout_title', { bg: true });
          }
        }

        const titleH = 80;
        const subH = 40;
        const totalH = titleH + (subtitle ? subH : 0);
        const titleY = (style.slide_height_pt - totalH) / 2;
        const titleW = style.slide_width_pt - 100;
        const titleX = 50;

        const titleStyle = roleTextStyle(style, 'title');
        const { textBoxId: titleId, requests: titleReqs } = buildTextBoxRequests(
          slideId, title, titleX, titleY, titleW, titleH, titleStyle, style.line_spacing,
        );

        const allReqs: Req[] = [...titleReqs];
        let subtitleId: string | undefined;
        if (subtitle) {
          const subStyle = roleTextStyle(style, 'subtitle');
          const { textBoxId: sId, requests: sReqs } = buildTextBoxRequests(
            slideId, subtitle, titleX, titleY + titleH + 8, titleW, subH, subStyle, style.line_spacing,
          );
          subtitleId = sId;
          allReqs.push(...sReqs);
        }

        const r = await batchUpdate(presentationId, allReqs, agentId, agentName, 'slides_layout_title', { slideId });
        if (!r.ok) return `Error adding title content: ${r.error}`;
        return ok({ slide_id: slideId, title_id: titleId, subtitle_id: subtitleId ?? null });
      }

      case 'slides_layout_section': {
        const presentationId = args.presentation_id as string;
        const heading = args.heading as string;
        const subheading = (args.subheading as string | undefined) ?? '';

        const style = getStoredStyle(presentationId);
        const slideR = await addSlideInternal(presentationId, 'BLANK', -1, agentId, agentName, 'slides_layout_section');
        if (!slideR.ok || !slideR.slideId) return `Error creating section slide: ${slideR.error}`;
        const slideId = slideR.slideId;

        // Accent background with contrasting text
        const bg = backgroundRequest(slideId, style.accent_color);
        const textColor = style.slide_background_color;

        const headingH = 90;
        const subH = 40;
        const totalH = headingH + (subheading ? subH : 0);
        const y = (style.slide_height_pt - totalH) / 2;
        const w = style.slide_width_pt - 100;
        const x = 50;

        const headingStyle = roleTextStyle(style, 'title', { title_color: textColor });
        const { textBoxId: headingId, requests: hReqs } = buildTextBoxRequests(
          slideId, heading, x, y, w, headingH, headingStyle, style.line_spacing,
        );

        const allReqs: Req[] = [];
        if (bg) allReqs.push(bg);
        allReqs.push(...hReqs);

        let subheadingId: string | undefined;
        if (subheading) {
          const subStyle = roleTextStyle(style, 'subtitle', { subtitle_color: textColor });
          const { textBoxId: sId, requests: sReqs } = buildTextBoxRequests(
            slideId, subheading, x, y + headingH + 8, w, subH, subStyle, style.line_spacing,
          );
          subheadingId = sId;
          allReqs.push(...sReqs);
        }

        const r = await batchUpdate(presentationId, allReqs, agentId, agentName, 'slides_layout_section', { slideId });
        if (!r.ok) return `Error adding section content: ${r.error}`;
        return ok({ slide_id: slideId, heading_id: headingId, subheading_id: subheadingId ?? null });
      }

      case 'slides_layout_content': {
        const presentationId = args.presentation_id as string;
        const title = args.title as string;
        const bodyText = args.body_text as string | undefined;
        const bullets = args.bullets as string[] | undefined;
        const imageUrl = args.image_url as string | undefined;
        const imagePosition = ((args.image_position as string | undefined) ?? 'right').toLowerCase();
        if (!['right', 'left', 'bottom', 'full'].includes(imagePosition)) {
          return err('image_position must be right, left, bottom, or full');
        }
        if (bodyText && bullets) return err('Provide either body_text or bullets, not both');

        const style = getStoredStyle(presentationId);
        const { ml, mt, cw, ch } = contentArea(style);

        const slideR = await addSlideInternal(presentationId, 'BLANK', -1, agentId, agentName, 'slides_layout_content');
        if (!slideR.ok || !slideR.slideId) return `Error creating content slide: ${slideR.error}`;
        const slideId = slideR.slideId;

        const titleH = 60;
        const headingStyle = roleTextStyle(style, 'heading');
        const { textBoxId: titleId, requests: titleReqs } = buildTextBoxRequests(
          slideId, title, ml, mt, cw, titleH, headingStyle, style.line_spacing,
        );

        const bodyTop = mt + titleH + 16;
        const bodyAreaH = ch - (titleH + 16);

        const allReqs: Req[] = [...titleReqs];
        const bodyStyle = roleTextStyle(style, 'body');
        let bodyId: string | undefined;
        let imageId: string | undefined;

        const hasImage = !!imageUrl;
        const hasText = !!(bodyText || bullets);

        const addBodyBox = (x: number, y: number, w: number, h: number): string => {
          const text = bullets ? bullets.join('\n') : (bodyText ?? '');
          const { textBoxId, requests } = buildTextBoxRequests(
            slideId, text, x, y, w, h, bodyStyle, style.line_spacing,
          );
          allReqs.push(...requests);
          if (bullets) {
            allReqs.push({
              createParagraphBullets: {
                objectId: textBoxId,
                textRange: { type: 'ALL' },
                bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE',
              },
            });
          }
          return textBoxId;
        };

        const addImageEl = (x: number, y: number, w: number, h: number): string => {
          const id = genId('img');
          allReqs.push({
            createImage: {
              objectId: id,
              url: imageUrl!,
              elementProperties: {
                pageObjectId: slideId,
                size: pageSize(w, h),
                transform: pageTransform(x, y),
              },
            },
          });
          return id;
        };

        if (hasImage && hasText && (imagePosition === 'right' || imagePosition === 'left')) {
          const gap = 20;
          const colW = (cw - gap) / 2;
          const textX = imagePosition === 'right' ? ml : ml + colW + gap;
          const imgX = imagePosition === 'right' ? ml + colW + gap : ml;
          bodyId = addBodyBox(textX, bodyTop, colW, bodyAreaH);
          imageId = addImageEl(imgX, bodyTop, colW, bodyAreaH);
        } else if (hasImage && hasText && imagePosition === 'bottom') {
          const textH = bodyAreaH * 0.5 - 10;
          const imgH = bodyAreaH * 0.5 - 10;
          bodyId = addBodyBox(ml, bodyTop, cw, textH);
          imageId = addImageEl(ml, bodyTop + textH + 20, cw, imgH);
        } else if (hasImage && imagePosition === 'full') {
          imageId = addImageEl(ml, bodyTop, cw, bodyAreaH);
          if (hasText) bodyId = addBodyBox(ml + 20, bodyTop + 20, cw - 40, bodyAreaH - 40);
        } else if (hasImage) {
          imageId = addImageEl(ml, bodyTop, cw, bodyAreaH);
        } else if (hasText) {
          bodyId = addBodyBox(ml, bodyTop, cw, bodyAreaH);
        }

        const r = await batchUpdate(presentationId, allReqs, agentId, agentName, 'slides_layout_content', { slideId });
        if (!r.ok) return `Error building content slide: ${r.error}`;
        return ok({
          slide_id: slideId,
          title_id: titleId,
          body_id: bodyId ?? null,
          image_id: imageId ?? null,
        });
      }

      case 'slides_layout_two_column': {
        const presentationId = args.presentation_id as string;
        const title = args.title as string;
        const left = parseJsonArg(args.left) as { text?: string; bullets?: string[]; image_url?: string; image_drive_id?: string } | undefined;
        const right = parseJsonArg(args.right) as { text?: string; bullets?: string[]; image_url?: string; image_drive_id?: string } | undefined;
        if (!left || !right) return err('left and right columns are required');

        const style = getStoredStyle(presentationId);
        const { ml, mt, cw, ch } = contentArea(style);

        const slideR = await addSlideInternal(presentationId, 'BLANK', -1, agentId, agentName, 'slides_layout_two_column');
        if (!slideR.ok || !slideR.slideId) return `Error creating two-column slide: ${slideR.error}`;
        const slideId = slideR.slideId;

        const titleH = 60;
        const headingStyle = roleTextStyle(style, 'heading');
        const { textBoxId: titleId, requests: titleReqs } = buildTextBoxRequests(
          slideId, title, ml, mt, cw, titleH, headingStyle, style.line_spacing,
        );

        const gap = 20;
        const colW = (cw - gap) / 2;
        const colTop = mt + titleH + 16;
        const colH = ch - (titleH + 16);

        // Pre-resolve Drive image URLs for either column (grants temporary
        // share links if needed). Cleanups run in finally.
        const cleanups: Array<() => Promise<void>> = [];
        let leftDriveUrl: string | undefined;
        let rightDriveUrl: string | undefined;

        if (left.image_drive_id) {
          const prep = await prepareDriveImageUrl(left.image_drive_id, agentId, agentName, 'slides_layout_two_column');
          if (!prep.ok || !prep.url) return err(prep.error ?? 'Failed to prepare left Drive image');
          leftDriveUrl = prep.url;
          cleanups.push(prep.cleanup);
        }
        if (right.image_drive_id) {
          const prep = await prepareDriveImageUrl(right.image_drive_id, agentId, agentName, 'slides_layout_two_column');
          if (!prep.ok || !prep.url) {
            await runWithCleanups(cleanups, async () => { /* release left */ });
            return err(prep.error ?? 'Failed to prepare right Drive image');
          }
          rightDriveUrl = prep.url;
          cleanups.push(prep.cleanup);
        }

        return await runWithCleanups(cleanups, async () => {
          const allReqs: Req[] = [...titleReqs];
          const bodyStyle = roleTextStyle(style, 'body');

          const placeColumn = (content: typeof left, driveUrl: string | undefined, x: number): Record<string, string> => {
            const ids: Record<string, string> = {};
            if (!content) return ids;
            if (content.bullets && content.bullets.length > 0) {
              const { textBoxId, requests } = buildTextBoxRequests(
                slideId, content.bullets.join('\n'), x, colTop, colW, colH, bodyStyle, style.line_spacing,
              );
              allReqs.push(...requests);
              allReqs.push({
                createParagraphBullets: {
                  objectId: textBoxId,
                  textRange: { type: 'ALL' },
                  bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE',
                },
              });
              ids.text_box_id = textBoxId;
            } else if (content.text) {
              const { textBoxId, requests } = buildTextBoxRequests(
                slideId, content.text, x, colTop, colW, colH, bodyStyle, style.line_spacing,
              );
              allReqs.push(...requests);
              ids.text_box_id = textBoxId;
            } else if (content.image_url || driveUrl) {
              const id = genId('img');
              allReqs.push({
                createImage: {
                  objectId: id,
                  url: (content.image_url ?? driveUrl)!,
                  elementProperties: {
                    pageObjectId: slideId,
                    size: pageSize(colW, colH),
                    transform: pageTransform(x, colTop),
                  },
                },
              });
              ids.image_id = id;
            }
            return ids;
          };

          const leftIds = placeColumn(left, leftDriveUrl, ml);
          const rightIds = placeColumn(right, rightDriveUrl, ml + colW + gap);

          const r = await batchUpdate(presentationId, allReqs, agentId, agentName, 'slides_layout_two_column', { slideId });
          if (!r.ok) return `Error building two-column slide: ${r.error}`;
          return ok({ slide_id: slideId, title_id: titleId, left_ids: leftIds, right_ids: rightIds });
        });
      }

      case 'slides_layout_image': {
        const presentationId = args.presentation_id as string;
        const title = args.title as string;
        const imageUrl = args.image_url as string | undefined;
        const imageDriveId = args.image_drive_id as string | undefined;
        const caption = args.caption as string | undefined;
        if (!imageUrl && !imageDriveId) return err('Provide either image_url or image_drive_id');

        const style = getStoredStyle(presentationId);
        const { ml, mt, cw, ch } = contentArea(style);

        const slideR = await addSlideInternal(presentationId, 'BLANK', -1, agentId, agentName, 'slides_layout_image');
        if (!slideR.ok || !slideR.slideId) return `Error creating image slide: ${slideR.error}`;
        const slideId = slideR.slideId;

        const titleH = 50;
        const headingStyle = roleTextStyle(style, 'heading');
        const { textBoxId: titleId, requests: titleReqs } = buildTextBoxRequests(
          slideId, title, ml, mt, cw, titleH, headingStyle, style.line_spacing,
        );

        const captionH = caption ? 30 : 0;
        const imgY = mt + titleH + 12;
        const imgH = ch - (titleH + 12 + (caption ? captionH + 8 : 0));

        // Resolve the final image URL, temporarily sharing the Drive file if needed.
        let finalUrl: string;
        let drivePrep: DriveImagePrep | null = null;
        if (imageUrl) {
          finalUrl = imageUrl;
        } else {
          drivePrep = await prepareDriveImageUrl(imageDriveId!, agentId, agentName, 'slides_layout_image');
          if (!drivePrep.ok || !drivePrep.url) return err(drivePrep.error ?? 'Failed to prepare Drive image URL');
          finalUrl = drivePrep.url;
        }

        try {
          const imageId = genId('img');
          const allReqs: Req[] = [...titleReqs, {
            createImage: {
              objectId: imageId,
              url: finalUrl,
              elementProperties: {
                pageObjectId: slideId,
                size: pageSize(cw, imgH),
                transform: pageTransform(ml, imgY),
              },
            },
          }];

          let captionId: string | undefined;
          if (caption) {
            const captionStyle = roleTextStyle(style, 'caption');
            const { textBoxId: cId, requests: cReqs } = buildTextBoxRequests(
              slideId, caption, ml, imgY + imgH + 8, cw, captionH, captionStyle, style.line_spacing,
            );
            captionId = cId;
            allReqs.push(...cReqs);
          }

          const r = await batchUpdate(presentationId, allReqs, agentId, agentName, 'slides_layout_image', { slideId });
          if (!r.ok) return `Error building image slide: ${r.error}`;
          return ok({ slide_id: slideId, title_id: titleId, image_id: imageId, caption_id: captionId ?? null });
        } finally {
          if (drivePrep) await drivePrep.cleanup();
        }
      }

      case 'slides_layout_comparison': {
        const presentationId = args.presentation_id as string;
        const title = args.title as string;
        const items = args.items as Array<{ heading?: string; points?: string[]; image_url?: string }>;
        if (!Array.isArray(items) || items.length < 2 || items.length > 4) {
          return err('items must be an array of 2-4 objects');
        }

        const style = getStoredStyle(presentationId);
        const { ml, mt, cw, ch } = contentArea(style);

        const slideR = await addSlideInternal(presentationId, 'BLANK', -1, agentId, agentName, 'slides_layout_comparison');
        if (!slideR.ok || !slideR.slideId) return `Error creating comparison slide: ${slideR.error}`;
        const slideId = slideR.slideId;

        const titleH = 50;
        const headingStyle = roleTextStyle(style, 'heading');
        const { textBoxId: titleId, requests: titleReqs } = buildTextBoxRequests(
          slideId, title, ml, mt, cw, titleH, headingStyle, style.line_spacing,
        );

        const n = items.length;
        const gap = 16;
        const colW = (cw - gap * (n - 1)) / n;
        const colTop = mt + titleH + 16;
        const colH = ch - (titleH + 16);
        const subHeadingH = 34;
        const imgH = 120;

        const allReqs: Req[] = [...titleReqs];
        const itemIds: Array<Record<string, string>> = [];
        const bodyStyle = roleTextStyle(style, 'body');

        for (let i = 0; i < n; i++) {
          const item = items[i];
          const x = ml + i * (colW + gap);
          const entry: Record<string, string> = {};

          // Column heading (smaller than deck heading for readability)
          const colHeadingStyle = roleTextStyle(style, 'heading', { heading_size: 20 });
          const { textBoxId: headId, requests: hReqs } = buildTextBoxRequests(
            slideId, item.heading ?? '', x, colTop, colW, subHeadingH, colHeadingStyle, style.line_spacing,
          );
          allReqs.push(...hReqs);
          entry.heading_id = headId;

          let cursorY = colTop + subHeadingH + 8;

          if (item.image_url) {
            const id = genId('img');
            allReqs.push({
              createImage: {
                objectId: id,
                url: item.image_url,
                elementProperties: {
                  pageObjectId: slideId,
                  size: pageSize(colW, imgH),
                  transform: pageTransform(x, cursorY),
                },
              },
            });
            entry.image_id = id;
            cursorY += imgH + 8;
          }

          const points = item.points ?? [];
          const pointsH = colTop + colH - cursorY;
          if (points.length > 0 && pointsH > 30) {
            const { textBoxId: pId, requests: pReqs } = buildTextBoxRequests(
              slideId, points.join('\n'), x, cursorY, colW, pointsH, bodyStyle, style.line_spacing,
            );
            allReqs.push(...pReqs);
            allReqs.push({
              createParagraphBullets: {
                objectId: pId,
                textRange: { type: 'ALL' },
                bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE',
              },
            });
            entry.points_id = pId;
          }

          itemIds.push(entry);
        }

        const r = await batchUpdate(presentationId, allReqs, agentId, agentName, 'slides_layout_comparison', { slideId, n });
        if (!r.ok) return `Error building comparison slide: ${r.error}`;
        return ok({ slide_id: slideId, title_id: titleId, item_ids: itemIds });
      }

      // ── Utility ──

      case 'slides_get_slides': {
        const presentationId = args.presentation_id as string;
        const pres = await getPresentation(presentationId, agentId, agentName, 'slides_get_slides');
        if (!pres.ok) return `Error reading presentation: ${pres.error}`;
        const slides = (pres.data as { slides?: Array<{ objectId?: string }> }).slides ?? [];
        return ok({
          slides: slides.map((s, i) => ({ slide_id: s.objectId, index: i })),
        });
      }

      case 'slides_get_elements': {
        const presentationId = args.presentation_id as string;
        const slideId = args.slide_id as string;
        const pres = await getPresentation(presentationId, agentId, agentName, 'slides_get_elements');
        if (!pres.ok) return `Error reading presentation: ${pres.error}`;
        const slides = (pres.data as { slides?: Array<{ objectId?: string; pageElements?: Array<Record<string, unknown>> }> }).slides ?? [];
        const slide = slides.find(s => s.objectId === slideId);
        if (!slide) return err(`Slide ${slideId} not found`);
        const elements = (slide.pageElements ?? []).map(el => {
          const hasKey = (k: string) => Object.prototype.hasOwnProperty.call(el, k);
          const type =
            hasKey('shape') ? 'shape' :
            hasKey('image') ? 'image' :
            hasKey('video') ? 'video' :
            hasKey('line') ? 'line' :
            hasKey('table') ? 'table' :
            hasKey('elementGroup') ? 'group' : 'unknown';
          const transform = (el.transform as { translateX?: number; translateY?: number; scaleX?: number; scaleY?: number } | undefined) ?? {};
          const size = (el.size as { width?: { magnitude?: number }; height?: { magnitude?: number } } | undefined) ?? {};
          const wEmu = size.width?.magnitude ?? 0;
          const hEmu = size.height?.magnitude ?? 0;
          return {
            element_id: el.objectId as string,
            type,
            x_pt: emuToPt(transform.translateX ?? 0),
            y_pt: emuToPt(transform.translateY ?? 0),
            width_pt: emuToPt(wEmu) * (transform.scaleX ?? 1),
            height_pt: emuToPt(hEmu) * (transform.scaleY ?? 1),
          };
        });
        return ok({ elements });
      }

      case 'slides_delete_element': {
        const presentationId = args.presentation_id as string;
        const elementId = args.element_id as string;
        const r = await batchUpdate(presentationId, [{ deleteObject: { objectId: elementId } }],
          agentId, agentName, 'slides_delete_element', { elementId });
        if (!r.ok) return `Error deleting element: ${r.error}`;
        return ok({ ok: true });
      }

      case 'slides_move_element': {
        const presentationId = args.presentation_id as string;
        const elementId = args.element_id as string;
        const xPt = args.x_pt as number;
        const yPt = args.y_pt as number;
        const r = await batchUpdate(presentationId, [{
          updatePageElementTransform: {
            objectId: elementId,
            applyMode: 'ABSOLUTE',
            transform: {
              scaleX: 1, scaleY: 1,
              translateX: ptToEmu(xPt),
              translateY: ptToEmu(yPt),
              unit: 'EMU',
            },
          },
        }], agentId, agentName, 'slides_move_element', { elementId });
        if (!r.ok) return `Error moving element: ${r.error}`;
        return ok({ ok: true });
      }

      case 'slides_resize_element': {
        const presentationId = args.presentation_id as string;
        const elementId = args.element_id as string;
        const widthPt = args.width_pt as number;
        const heightPt = args.height_pt as number;

        // Fetch current size/transform so we can compute scale factor
        const pres = await getPresentation(presentationId, agentId, agentName, 'slides_resize_element');
        if (!pres.ok) return `Error reading presentation: ${pres.error}`;
        const slides = (pres.data as { slides?: Array<{ pageElements?: Array<Record<string, unknown>> }> }).slides ?? [];
        let target: Record<string, unknown> | null = null;
        for (const s of slides) {
          const found = (s.pageElements ?? []).find(e => e.objectId === elementId);
          if (found) { target = found; break; }
        }
        if (!target) return err(`Element ${elementId} not found`);

        const size = target.size as { width?: { magnitude?: number }; height?: { magnitude?: number } } | undefined;
        const transform = (target.transform as { translateX?: number; translateY?: number } | undefined) ?? {};
        const wEmu = size?.width?.magnitude ?? 1;
        const hEmu = size?.height?.magnitude ?? 1;
        const scaleX = ptToEmu(widthPt) / wEmu;
        const scaleY = ptToEmu(heightPt) / hEmu;

        const r = await batchUpdate(presentationId, [{
          updatePageElementTransform: {
            objectId: elementId,
            applyMode: 'ABSOLUTE',
            transform: {
              scaleX, scaleY,
              translateX: transform.translateX ?? 0,
              translateY: transform.translateY ?? 0,
              unit: 'EMU',
            },
          },
        }], agentId, agentName, 'slides_resize_element', { elementId });
        if (!r.ok) return `Error resizing element: ${r.error}`;
        return ok({ ok: true });
      }

      case 'slides_find_replace': {
        const presentationId = args.presentation_id as string;
        const findText = args.find_text as string;
        const replaceText = args.replace_text as string;
        const r = await batchUpdate(presentationId, [{
          replaceAllText: {
            containsText: { text: findText, matchCase: false },
            replaceText,
          },
        }], agentId, agentName, 'slides_find_replace', { findText });
        if (!r.ok) return `Error in find/replace: ${r.error}`;
        const replies = (r.data as { replies?: Array<{ replaceAllText?: { occurrencesChanged?: number } }> }).replies ?? [];
        const count = replies[0]?.replaceAllText?.occurrencesChanged ?? 0;
        return ok({ occurrences_replaced: count });
      }

      default:
        return `Unknown Google Slides tool: ${name}`;
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return `Error in ${name}: ${msg}`;
  }
}
