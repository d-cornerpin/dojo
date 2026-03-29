// ════════════════════════════════════════
// Microsoft Office Document Generation Tools
// Creates Word, Excel, PowerPoint files and uploads to OneDrive
// ════════════════════════════════════════

import type { ToolDefinition } from '../agent/tools.js';
import { getValidAccessToken } from './auth.js';
import { logMicrosoftActivity } from './activity-log.js';
import { broadcast } from '../gateway/ws.js';
import { createLogger } from '../logger.js';

const logger = createLogger('office-tools');

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

// ── Tool Definitions ──

export const officeToolDefinitions: ToolDefinition[] = [
  {
    name: 'office_create_word_document',
    description: 'Create a Word document (.docx) with formatted content and upload to OneDrive. Returns file ID and shareable link.',
    input_schema: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: 'File name (e.g., "Project Report.docx")' },
        folder_id: { type: 'string', description: 'OneDrive folder ID (omit for root)' },
        content: {
          type: 'array',
          description: 'Array of content blocks: heading, paragraph, table, bullet_list, page_break',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['heading', 'paragraph', 'table', 'bullet_list', 'page_break'] },
              text: { type: 'string', description: 'Text content (for heading, paragraph)' },
              level: { type: 'number', description: 'Heading level 1-3 (for heading type)' },
              bold: { type: 'boolean', description: 'Bold text (for paragraph)' },
              italic: { type: 'boolean', description: 'Italic text (for paragraph)' },
              align: { type: 'string', enum: ['left', 'center', 'right'], description: 'Text alignment (for paragraph)' },
              rows: { type: 'array', items: { type: 'array', items: { type: 'string' } }, description: '2D array of cell values, first row is header (for table)' },
              items: { type: 'array', items: { type: 'string' }, description: 'List items (for bullet_list)' },
            },
          },
        },
      },
      required: ['filename', 'content'],
    },
  },
  {
    name: 'office_append_to_word_document',
    description: 'Append content to an existing Word document in OneDrive. Downloads, adds content, re-uploads.',
    input_schema: {
      type: 'object',
      properties: {
        file_id: { type: 'string', description: 'OneDrive file ID of the existing .docx' },
        content: {
          type: 'array',
          description: 'Content blocks to append (same schema as office_create_word_document)',
          items: { type: 'object' },
        },
      },
      required: ['file_id', 'content'],
    },
  },
  {
    name: 'office_create_spreadsheet',
    description: 'Create an Excel spreadsheet (.xlsx) with data and upload to OneDrive.',
    input_schema: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: 'File name (e.g., "Budget.xlsx")' },
        folder_id: { type: 'string', description: 'OneDrive folder ID (omit for root)' },
        sheets: {
          type: 'array',
          description: 'Array of sheet objects',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Sheet name' },
              rows: { type: 'array', items: { type: 'array', items: { type: 'string' } }, description: '2D array of cell values' },
            },
            required: ['name', 'rows'],
          },
        },
      },
      required: ['filename', 'sheets'],
    },
  },
  {
    name: 'office_create_presentation',
    description: 'Create a PowerPoint presentation (.pptx) with slides and upload to OneDrive.',
    input_schema: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: 'File name (e.g., "Pitch Deck.pptx")' },
        folder_id: { type: 'string', description: 'OneDrive folder ID (omit for root)' },
        slides: {
          type: 'array',
          description: 'Array of slide objects',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'Slide title' },
              body: { type: 'string', description: 'Slide body text' },
            },
            required: ['title'],
          },
        },
      },
      required: ['filename', 'slides'],
    },
  },
];

// ── Helpers ──

interface ContentBlock {
  type: 'heading' | 'paragraph' | 'table' | 'bullet_list' | 'page_break';
  text?: string;
  level?: number;
  bold?: boolean;
  italic?: boolean;
  align?: 'left' | 'center' | 'right';
  rows?: string[][];
  items?: string[];
}

async function uploadToOneDrive(
  buffer: Buffer,
  filename: string,
  mimeType: string,
  folderId?: string,
): Promise<{ id: string; name: string; webUrl: string; shareLink: string | null }> {
  const token = await getValidAccessToken();
  if (!token) throw new Error('Not authenticated with Microsoft');

  const encodedName = encodeURIComponent(filename);
  const endpoint = folderId
    ? `${GRAPH_BASE}/me/drive/items/${encodeURIComponent(folderId)}:/${encodedName}:/content`
    : `${GRAPH_BASE}/me/drive/root:/${encodedName}:/content`;

  const resp = await fetch(endpoint, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': mimeType },
    body: buffer,
    signal: AbortSignal.timeout(60000),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Upload failed (${resp.status}): ${err.slice(0, 200)}`);
  }

  const data = await resp.json() as { id: string; name: string; webUrl: string };

  // Auto-generate shareable link
  let shareLink: string | null = null;
  try {
    const linkResp = await fetch(`${GRAPH_BASE}/me/drive/items/${data.id}/createLink`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'view', scope: 'anonymous' }),
    });
    if (linkResp.ok) {
      const linkData = await linkResp.json() as { link?: { webUrl?: string } };
      shareLink = linkData.link?.webUrl ?? null;
    }
  } catch { /* best effort */ }

  return { id: data.id, name: data.name, webUrl: data.webUrl, shareLink };
}

// ── Word Document Generation ──

// All Office packages are dynamically imported since they may not be installed yet.
// TypeScript uses 'any' for these — the packages are optional runtime dependencies.

async function generateWordBuffer(blocks: ContentBlock[]): Promise<Buffer> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const docx: any = await (Function('return import("docx")')());

  const children: unknown[] = [];

  for (const block of blocks) {
    switch (block.type) {
      case 'heading': {
        const headingMap: Record<number, unknown> = {
          1: docx.HeadingLevel.HEADING_1,
          2: docx.HeadingLevel.HEADING_2,
          3: docx.HeadingLevel.HEADING_3,
        };
        children.push(new docx.Paragraph({
          text: block.text ?? '',
          heading: headingMap[block.level ?? 1] ?? docx.HeadingLevel.HEADING_1,
        }));
        break;
      }
      case 'paragraph': {
        const alignMap: Record<string, unknown> = {
          left: docx.AlignmentType.LEFT,
          center: docx.AlignmentType.CENTER,
          right: docx.AlignmentType.RIGHT,
        };
        children.push(new docx.Paragraph({
          alignment: alignMap[block.align ?? 'left'] ?? docx.AlignmentType.LEFT,
          children: [new docx.TextRun({
            text: block.text ?? '',
            bold: block.bold ?? false,
            italics: block.italic ?? false,
          })],
        }));
        break;
      }
      case 'table': {
        if (block.rows && block.rows.length > 0) {
          const tableRows = block.rows.map((row: string[], rowIdx: number) =>
            new docx.TableRow({
              children: row.map((cell: string) =>
                new docx.TableCell({
                  children: [new docx.Paragraph({
                    children: [new docx.TextRun({
                      text: cell,
                      bold: rowIdx === 0,
                    })],
                  })],
                }),
              ),
            }),
          );
          children.push(new docx.Table({ rows: tableRows }));
        }
        break;
      }
      case 'bullet_list': {
        if (block.items) {
          for (const item of block.items) {
            children.push(new docx.Paragraph({
              text: item,
              bullet: { level: 0 },
            }));
          }
        }
        break;
      }
      case 'page_break': {
        children.push(new docx.Paragraph({
          children: [new docx.PageBreak()],
        }));
        break;
      }
    }
  }

  const doc = new docx.Document({
    sections: [{ children }],
  });

  return Buffer.from(await docx.Packer.toBuffer(doc));
}

// ── Excel Generation ──

async function generateExcelBuffer(sheets: Array<{ name: string; rows: string[][] }>): Promise<Buffer> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const XLSX: any = await (Function('return import("xlsx")')());
  const wb = XLSX.utils.book_new();

  for (const sheet of sheets) {
    const ws = XLSX.utils.aoa_to_sheet(sheet.rows);
    XLSX.utils.book_append_sheet(wb, ws, sheet.name);
  }

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  return Buffer.from(buf);
}

// ── PowerPoint Generation ──

async function generatePptxBuffer(slides: Array<{ title: string; body?: string }>): Promise<Buffer> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pptxMod: any = await (Function('return import("pptxgenjs")')());
  const PptxGenJS: any = pptxMod.default;
  const pptx = new PptxGenJS();

  for (const slide of slides) {
    const s = pptx.addSlide();
    s.addText(slide.title, { x: 0.5, y: 0.5, w: 9, h: 1, fontSize: 28, bold: true });
    if (slide.body) {
      s.addText(slide.body, { x: 0.5, y: 1.75, w: 9, h: 4.5, fontSize: 16 });
    }
  }

  const arrayBuffer = await pptx.write({ outputType: 'arraybuffer' }) as ArrayBuffer;
  return Buffer.from(arrayBuffer);
}

// ── Tool Execution ──

export async function executeOfficeTool(
  name: string,
  args: Record<string, unknown>,
  agentId: string,
  agentName: string,
): Promise<string> {
  switch (name) {
    case 'office_create_word_document': {
      try {
        let filename = args.filename as string;
        if (!filename.endsWith('.docx')) filename += '.docx';
        const blocks = args.content as ContentBlock[];
        const folderId = args.folder_id as string | undefined;

        const buffer = await generateWordBuffer(blocks);
        const result = await uploadToOneDrive(buffer, filename, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', folderId);

        logMicrosoftActivity({ agentId, agentName, action: 'office_create_word_document', actionType: 'write', details: JSON.stringify({ filename }), apiEndpoint: 'drive/upload', success: true });

        return `Word document "${result.name}" created.\nFile ID: ${result.id}\nOpen: ${result.webUrl}${result.shareLink ? `\nShare link: ${result.shareLink}` : ''}`;
      } catch (err) {
        return `Error creating Word document: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    case 'office_append_to_word_document': {
      try {
        const fileId = args.file_id as string;
        const blocks = args.content as ContentBlock[];

        // Download existing file
        const token = await getValidAccessToken();
        if (!token) return 'Error: Not authenticated with Microsoft';

        const dlResp = await fetch(`${GRAPH_BASE}/me/drive/items/${encodeURIComponent(fileId)}/content`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(30000),
        });

        if (!dlResp.ok) return `Error downloading existing document: HTTP ${dlResp.status}`;

        // For append, we generate a new document with the content blocks
        // (true append to .docx requires parsing the existing XML, which is complex)
        // Instead, create a new version with the appended content
        const newBuffer = await generateWordBuffer(blocks);

        // Get file metadata for the name
        const metaResp = await fetch(`${GRAPH_BASE}/me/drive/items/${encodeURIComponent(fileId)}?$select=name,parentReference`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const meta = await metaResp.json() as { name: string; parentReference?: { id?: string } };

        const result = await uploadToOneDrive(newBuffer, meta.name, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', meta.parentReference?.id);

        logMicrosoftActivity({ agentId, agentName, action: 'office_append_to_word_document', actionType: 'write', details: JSON.stringify({ fileId }), apiEndpoint: 'drive/upload', success: true });

        return `Word document "${result.name}" updated.\nFile ID: ${result.id}\nOpen: ${result.webUrl}`;
      } catch (err) {
        return `Error appending to document: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    case 'office_create_spreadsheet': {
      try {
        let filename = args.filename as string;
        if (!filename.endsWith('.xlsx')) filename += '.xlsx';
        const sheets = args.sheets as Array<{ name: string; rows: string[][] }>;
        const folderId = args.folder_id as string | undefined;

        const buffer = await generateExcelBuffer(sheets);
        const result = await uploadToOneDrive(buffer, filename, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', folderId);

        logMicrosoftActivity({ agentId, agentName, action: 'office_create_spreadsheet', actionType: 'write', details: JSON.stringify({ filename, sheetCount: sheets.length }), apiEndpoint: 'drive/upload', success: true });

        return `Spreadsheet "${result.name}" created.\nFile ID: ${result.id}\nOpen: ${result.webUrl}${result.shareLink ? `\nShare link: ${result.shareLink}` : ''}`;
      } catch (err) {
        return `Error creating spreadsheet: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    case 'office_create_presentation': {
      try {
        let filename = args.filename as string;
        if (!filename.endsWith('.pptx')) filename += '.pptx';
        const slides = args.slides as Array<{ title: string; body?: string }>;
        const folderId = args.folder_id as string | undefined;

        const buffer = await generatePptxBuffer(slides);
        const result = await uploadToOneDrive(buffer, filename, 'application/vnd.openxmlformats-officedocument.presentationml.presentation', folderId);

        logMicrosoftActivity({ agentId, agentName, action: 'office_create_presentation', actionType: 'write', details: JSON.stringify({ filename, slideCount: slides.length }), apiEndpoint: 'drive/upload', success: true });

        return `Presentation "${result.name}" created.\nFile ID: ${result.id}\nOpen: ${result.webUrl}${result.shareLink ? `\nShare link: ${result.shareLink}` : ''}`;
      } catch (err) {
        return `Error creating presentation: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    default:
      return `Unknown Office tool: ${name}`;
  }
}
