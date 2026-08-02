// ════════════════════════════════════════
// Google Forms Toolkit — Native REST API
// Available to: primary agent ONLY (write tools), all agents (read tools)
//
// Lets agents create surveys/quizzes, add and edit questions, delete items,
// inspect form structure, and read submitted responses.
//
// Architecture mirrors tools-slides.ts:
//   - Tool defs in `formsToolDefinitions`
//   - Single executor `executeGoogleFormsTool` dispatches by name
//   - All API calls flow through googleRead / googleWrite (auto activity log)
//
// Forms API surface used:
//   POST   /v1/forms                        → create
//   POST   /v1/forms/{id}:batchUpdate       → add/edit/delete items + settings
//   GET    /v1/forms/{id}                   → read structure
//   GET    /v1/forms/{id}/responses         → list responses
// ════════════════════════════════════════

import type { ToolDefinition } from '../agent/tools/types.js';
import { googleRead, googleWrite, googleSilentFetch } from './client.js';

const FORMS_BASE = 'https://forms.googleapis.com/v1/forms';

// ─────────────────────────────────────────
// Result helpers (mirror tools-slides.ts)
// ─────────────────────────────────────────

function ok(obj: unknown): string {
  return JSON.stringify(obj);
}

function err(message: string): string {
  return `Error: ${message}`;
}

// ─────────────────────────────────────────
// batchUpdate helper
// ─────────────────────────────────────────

interface BatchUpdateResponse {
  replies?: Array<Record<string, unknown>>;
  form?: Record<string, unknown>;
}

async function batchUpdate(
  formId: string,
  requests: Array<Record<string, unknown>>,
  agentId: string,
  agentName: string,
  action: string,
  details: Record<string, unknown>,
): Promise<{ ok: true; data: BatchUpdateResponse } | { ok: false; error: string }> {
  const result = await googleWrite(
    'POST',
    `${FORMS_BASE}/${formId}:batchUpdate`,
    { requests, includeFormInResponse: false },
    agentId, agentName, action, details,
  );
  if (!result.ok) return { ok: false, error: result.error ?? 'batchUpdate failed' };
  return { ok: true, data: result.data as BatchUpdateResponse };
}

// ─────────────────────────────────────────
// Question payload builders
// Each returns the `item` object that goes into a createItem request.
// ─────────────────────────────────────────

interface CommonQuestionFields {
  title: string;
  description?: string;
  required?: boolean;
}

function buildTextQuestionItem(c: CommonQuestionFields & { paragraph?: boolean }): Record<string, unknown> {
  return {
    title: c.title,
    description: c.description,
    questionItem: {
      question: {
        required: c.required ?? false,
        textQuestion: { paragraph: c.paragraph ?? false },
      },
    },
  };
}

function buildChoiceQuestionItem(
  c: CommonQuestionFields & {
    type: 'multiple_choice' | 'checkbox' | 'dropdown';
    options: string[];
    shuffle?: boolean;
  },
): Record<string, unknown> {
  // Forms API enum: RADIO | CHECKBOX | DROP_DOWN
  const TYPE_MAP: Record<string, string> = {
    multiple_choice: 'RADIO',
    checkbox: 'CHECKBOX',
    dropdown: 'DROP_DOWN',
  };
  const apiType = TYPE_MAP[c.type];
  if (!apiType) throw new Error(`Unknown choice type: ${c.type}`);
  return {
    title: c.title,
    description: c.description,
    questionItem: {
      question: {
        required: c.required ?? false,
        choiceQuestion: {
          type: apiType,
          options: c.options.map((value) => ({ value })),
          shuffle: c.shuffle ?? false,
        },
      },
    },
  };
}

/**
 * Validate a scale question's bounds against Google's actual constraints:
 *   - low must be 0 or 1 (Google rejects anything else)
 *   - high must be between 2 and 10 inclusive
 *   - high must be > low (otherwise the scale collapses)
 * Returns null if valid, an error message string if invalid.
 */
function validateScaleBounds(low: unknown, high: unknown): string | null {
  if (typeof low !== 'number' || typeof high !== 'number') return 'low and high must be numbers';
  if (!Number.isInteger(low) || !Number.isInteger(high)) return 'low and high must be integers';
  if (low !== 0 && low !== 1) return `low must be 0 or 1 (got ${low}). Common ranges: 0–5, 1–5, 0–10, 1–10.`;
  if (high < 2 || high > 10) return `high must be between 2 and 10 (got ${high}).`;
  if (low >= high) return `low (${low}) must be less than high (${high})`;
  return null;
}

function buildScaleQuestionItem(
  c: CommonQuestionFields & {
    low: number;
    high: number;
    low_label?: string;
    high_label?: string;
  },
): Record<string, unknown> {
  return {
    title: c.title,
    description: c.description,
    questionItem: {
      question: {
        required: c.required ?? false,
        scaleQuestion: {
          low: c.low,
          high: c.high,
          lowLabel: c.low_label,
          highLabel: c.high_label,
        },
      },
    },
  };
}

function buildDateOrTimeQuestionItem(
  c: CommonQuestionFields & {
    kind: 'date' | 'time' | 'datetime';
    include_year?: boolean;
  },
): Record<string, unknown> {
  if (c.kind === 'time') {
    return {
      title: c.title,
      description: c.description,
      questionItem: {
        question: {
          required: c.required ?? false,
          timeQuestion: { duration: false },
        },
      },
    };
  }
  // 'date' or 'datetime' both go through dateQuestion. includeTime distinguishes them.
  return {
    title: c.title,
    description: c.description,
    questionItem: {
      question: {
        required: c.required ?? false,
        dateQuestion: {
          includeTime: c.kind === 'datetime',
          includeYear: c.include_year ?? true,
        },
      },
    },
  };
}

// ─────────────────────────────────────────
// Tool definitions
// ─────────────────────────────────────────

export const formsToolDefinitions: ToolDefinition[] = [
  {
    name: 'forms_create_form',
    description: 'Create a new Google Form. Returns form_id, edit_url, and response_url. Use the returned form_id with the other forms_* tools to add or edit questions. The created form has no questions until you add them.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Form title shown to respondents' },
        document_title: { type: 'string', description: 'Optional Drive document title (defaults to title)' },
      },
      required: ['title'],
    },
  },
  {
    name: 'forms_add_text_question',
    description: 'Add a text-input question (short answer or paragraph) to an existing form. Returns the new item_id. Use paragraph=true for long-form responses, false (default) for one-line answers.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        form_id: { type: 'string', description: 'The form to add to (from forms_create_form)' },
        title: { type: 'string', description: 'Question text shown to respondents' },
        description: { type: 'string', description: 'Optional helper text below the question' },
        paragraph: { type: 'boolean', description: 'true = long answer textarea; false (default) = single-line input' },
        required: { type: 'boolean', description: 'Make this question required (default false)' },
        position: { type: 'number', description: 'Zero-based position in the form. If omitted, appended to the end.' },
      },
      required: ['form_id', 'title'],
    },
  },
  {
    name: 'forms_add_choice_question',
    description: 'Add a multiple-choice, checkbox, or dropdown question. Returns the new item_id. Specify type plus the answer options list.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        form_id: { type: 'string', description: 'The form to add to' },
        title: { type: 'string', description: 'Question text' },
        description: { type: 'string', description: 'Optional helper text' },
        type: {
          type: 'string',
          enum: ['multiple_choice', 'checkbox', 'dropdown'],
          description: 'multiple_choice = pick one (radio); checkbox = pick many; dropdown = pick one from a select',
        },
        options: {
          type: 'array',
          items: { type: 'string' },
          description: 'Answer options shown to respondents (1+ required)',
        },
        shuffle: { type: 'boolean', description: 'Randomize option order per respondent (default false)' },
        required: { type: 'boolean', description: 'Make this question required (default false)' },
        position: { type: 'number', description: 'Zero-based position. Omit to append.' },
      },
      required: ['form_id', 'title', 'type', 'options'],
    },
  },
  {
    name: 'forms_add_scale_question',
    description: 'Add a linear-scale question (e.g. 1–5 or 0–10) with optional endpoint labels. Returns the new item_id.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        form_id: { type: 'string', description: 'The form to add to' },
        title: { type: 'string', description: 'Question text' },
        description: { type: 'string', description: 'Optional helper text' },
        low: { type: 'number', description: 'Lowest scale value. Must be 0 or 1 (Google constraint).' },
        high: { type: 'number', description: 'Highest scale value. Integer between 2 and 10. Common pairs: 0–5, 1–5, 0–10, 1–10.' },
        low_label: { type: 'string', description: 'Label for the low end (e.g. "Strongly disagree")' },
        high_label: { type: 'string', description: 'Label for the high end (e.g. "Strongly agree")' },
        required: { type: 'boolean', description: 'Make this question required (default false)' },
        position: { type: 'number', description: 'Zero-based position. Omit to append.' },
      },
      required: ['form_id', 'title', 'low', 'high'],
    },
  },
  {
    name: 'forms_add_date_question',
    description: 'Add a date, time, or datetime question. Returns the new item_id. kind="date" picks just a calendar date, "time" picks a time-of-day, "datetime" picks both.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        form_id: { type: 'string', description: 'The form to add to' },
        title: { type: 'string', description: 'Question text' },
        description: { type: 'string', description: 'Optional helper text' },
        kind: {
          type: 'string',
          enum: ['date', 'time', 'datetime'],
          description: 'date = calendar; time = time-of-day; datetime = both',
        },
        include_year: { type: 'boolean', description: 'For date/datetime: include year selector (default true). Ignored for time.' },
        required: { type: 'boolean', description: 'Make this question required (default false)' },
        position: { type: 'number', description: 'Zero-based position. Omit to append.' },
      },
      required: ['form_id', 'title', 'kind'],
    },
  },
  {
    name: 'forms_update_question',
    description: 'Replace an existing question on a form. You must specify what kind of question it should become — pass the same fields you would for forms_add_*. The item_id stays the same; the question content is replaced.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        form_id: { type: 'string', description: 'The form containing the question' },
        item_id: { type: 'string', description: 'The item ID to update (from forms_add_* or forms_get)' },
        kind: {
          type: 'string',
          enum: ['text', 'choice', 'scale', 'date'],
          description: 'What kind of question this should be',
        },
        title: { type: 'string', description: 'New question text' },
        description: { type: 'string', description: 'New helper text (omit to clear)' },
        required: { type: 'boolean', description: 'Whether question is required' },
        // text-specific
        paragraph: { type: 'boolean', description: 'For kind=text: long-answer (paragraph) vs short' },
        // choice-specific
        choice_type: {
          type: 'string',
          enum: ['multiple_choice', 'checkbox', 'dropdown'],
          description: 'For kind=choice: subtype',
        },
        options: {
          type: 'array',
          items: { type: 'string' },
          description: 'For kind=choice: list of options (replaces existing)',
        },
        shuffle: { type: 'boolean', description: 'For kind=choice: randomize option order' },
        // scale-specific
        low: { type: 'number', description: 'For kind=scale: low end' },
        high: { type: 'number', description: 'For kind=scale: high end' },
        low_label: { type: 'string', description: 'For kind=scale: label for low end' },
        high_label: { type: 'string', description: 'For kind=scale: label for high end' },
        // date-specific
        date_kind: {
          type: 'string',
          enum: ['date', 'time', 'datetime'],
          description: 'For kind=date: which date variant',
        },
        include_year: { type: 'boolean', description: 'For kind=date with date_kind=date|datetime: include year' },
      },
      required: ['form_id', 'item_id', 'kind', 'title'],
    },
  },
  {
    name: 'forms_rename_question',
    description: 'Lightweight edit: change the title, description, and/or required flag of an existing question without touching the question type or its options. For changing the question TYPE or replacing options, use forms_update_question instead.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        form_id: { type: 'string', description: 'The form containing the question' },
        item_id: { type: 'string', description: 'The item ID (from forms_get)' },
        title: { type: 'string', description: 'New question text. Omit to leave unchanged.' },
        description: { type: 'string', description: 'New helper text. Pass an empty string to clear. Omit to leave unchanged.' },
        required: { type: 'boolean', description: 'Whether the question is required. Omit to leave unchanged.' },
      },
      required: ['form_id', 'item_id'],
    },
  },
  {
    name: 'forms_set_settings',
    description: 'Update form-level settings: quiz mode, email collection, accepting responses. Pass any subset of fields. Quiz mode (is_quiz=true) lets you assign correct answers and point values per question via the Forms UI; setting it via this tool toggles the form-level flag.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        form_id: { type: 'string', description: 'The form to update' },
        is_quiz: { type: 'boolean', description: 'Convert form to a quiz (or back to a regular form)' },
        email_collection_type: {
          type: 'string',
          enum: ['do_not_collect', 'verified', 'responder_input'],
          description: 'do_not_collect = no emails collected; verified = require Google sign-in (recommended); responder_input = ask the respondent to type their email',
        },
      },
      required: ['form_id'],
    },
  },
  {
    name: 'forms_delete_item',
    description: 'Delete a question or other item from a form by its item_id. Other items shift up to fill the gap. Cannot be undone.\n\nNOTE: this deletes ONE item INSIDE a form. To delete the entire form itself, use forms_delete_form (or drive_delete with the form_id).',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        form_id: { type: 'string', description: 'The form containing the item' },
        item_id: { type: 'string', description: 'The item ID to delete (from forms_get)' },
      },
      required: ['form_id', 'item_id'],
    },
  },
  {
    name: 'forms_delete_form',
    description: 'Delete an entire form. Forms are stored as Drive files, so this routes through the Drive API. Defaults to TRASH (recoverable for 30 days from Drive trash). Pass permanent: true to skip trash and delete immediately — irreversible.\n\nFor deleting a single QUESTION inside a form, use forms_delete_item instead.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        form_id: { type: 'string', description: 'The form to delete' },
        permanent: { type: 'boolean', description: 'true = permanently delete (no recovery). false (default) = move to Drive trash (restorable for 30 days).' },
      },
      required: ['form_id'],
    },
  },
  {
    name: 'forms_get',
    description: 'Read the structure of a form: title, description, settings, and the list of items with their item IDs and question content. Use this before forms_update_question or forms_delete_item to look up item IDs.\n\nLARGE FORMS: the full response can exceed the result cap on forms with many items. If you only need item IDs (e.g. to pick one to delete), pass fields="items(itemId,title)" to get a slim response. Other useful field selectors: "info", "settings", "items".',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        form_id: { type: 'string', description: 'The form to inspect' },
        fields: { type: 'string', description: 'Optional field selector (Google Forms API "fields" param). e.g. "items(itemId,title)" returns only item IDs and titles. Omit for the full form.' },
      },
      required: ['form_id'],
    },
    concurrency: 'safe',
    maxResultTokens: 5000,
  },
  {
    name: 'forms_list_responses',
    description: 'List submitted responses to a form. Returns an array of response objects with each respondent\'s answers keyed by item_id. Use forms_get first to map item_ids to question titles.\n\nPAGINATION: response.nextPageToken (when present) means there are more responses than fit in this page. Pass it as page_token in a follow-up call to get the next page. If you don\'t paginate when nextPageToken is set, your summary will silently miss data.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        form_id: { type: 'string', description: 'The form to read responses from' },
        page_size: { type: 'number', description: 'Max responses to return per page (default 50, max 5000)' },
        page_token: { type: 'string', description: 'Pagination cursor from a previous call\'s nextPageToken. Omit on the first call.' },
        filter: { type: 'string', description: 'Optional filter, e.g. "timestamp > 2026-01-01T00:00:00Z" to fetch only recent responses' },
      },
      required: ['form_id'],
    },
    concurrency: 'safe',
    maxResultTokens: 8000,
  },
];

export const formsToolNames: string[] = formsToolDefinitions.map((t) => t.name);

const formsToolDefByName: Map<string, ToolDefinition> = new Map(
  formsToolDefinitions.map((t) => [t.name, t]),
);

// ─────────────────────────────────────────
// Executor
// ─────────────────────────────────────────

export async function executeGoogleFormsTool(
  name: string,
  args: Record<string, unknown>,
  agentId: string,
  agentName: string,
): Promise<string> {
  try {
    // Validate required fields against the tool's own schema
    const { validateAgainstSchema } = await import('../agent/tool-helpers.js');
    const def = formsToolDefByName.get(name);
    const schemaErr = validateAgainstSchema(name, def?.input_schema as Parameters<typeof validateAgainstSchema>[1], args);
    if (schemaErr) return schemaErr;

    switch (name) {
      // ── Create ──

      case 'forms_create_form': {
        const title = args.title as string;
        const documentTitle = (args.document_title as string | undefined) ?? title;
        const result = await googleWrite(
          'POST',
          FORMS_BASE,
          { info: { title, documentTitle } },
          agentId, agentName, 'forms_create_form',
          { title },
        );
        if (!result.ok) return err(`creating form: ${result.error}`);
        const data = result.data as { formId?: string; responderUri?: string };
        const formId = data.formId;
        if (!formId) return err('No form ID returned');
        return ok({
          form_id: formId,
          edit_url: `https://docs.google.com/forms/d/${formId}/edit`,
          response_url: data.responderUri ?? `https://docs.google.com/forms/d/${formId}/viewform`,
        });
      }

      // ── Add questions (createItem) ──

      case 'forms_add_text_question': {
        const formId = args.form_id as string;
        const item = buildTextQuestionItem({
          title: args.title as string,
          description: args.description as string | undefined,
          paragraph: args.paragraph as boolean | undefined,
          required: args.required as boolean | undefined,
        });
        return await createItem(formId, item, args.position as number | undefined, agentId, agentName, 'forms_add_text_question');
      }

      case 'forms_add_choice_question': {
        const formId = args.form_id as string;
        const options = args.options as string[];
        if (!Array.isArray(options) || options.length === 0) return err('options must be a non-empty array of strings');
        let item: Record<string, unknown>;
        try {
          item = buildChoiceQuestionItem({
            title: args.title as string,
            description: args.description as string | undefined,
            type: args.type as 'multiple_choice' | 'checkbox' | 'dropdown',
            options,
            shuffle: args.shuffle as boolean | undefined,
            required: args.required as boolean | undefined,
          });
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e));
        }
        return await createItem(formId, item, args.position as number | undefined, agentId, agentName, 'forms_add_choice_question');
      }

      case 'forms_add_scale_question': {
        const formId = args.form_id as string;
        const low = args.low as number;
        const high = args.high as number;
        const scaleErr = validateScaleBounds(low, high);
        if (scaleErr) return err(scaleErr);
        const item = buildScaleQuestionItem({
          title: args.title as string,
          description: args.description as string | undefined,
          low, high,
          low_label: args.low_label as string | undefined,
          high_label: args.high_label as string | undefined,
          required: args.required as boolean | undefined,
        });
        return await createItem(formId, item, args.position as number | undefined, agentId, agentName, 'forms_add_scale_question');
      }

      case 'forms_add_date_question': {
        const formId = args.form_id as string;
        const item = buildDateOrTimeQuestionItem({
          title: args.title as string,
          description: args.description as string | undefined,
          kind: args.kind as 'date' | 'time' | 'datetime',
          include_year: args.include_year as boolean | undefined,
          required: args.required as boolean | undefined,
        });
        return await createItem(formId, item, args.position as number | undefined, agentId, agentName, 'forms_add_date_question');
      }

      // ── Edit / delete ──

      case 'forms_update_question': {
        const formId = args.form_id as string;
        const itemId = args.item_id as string;
        const kind = args.kind as 'text' | 'choice' | 'scale' | 'date';
        let item: Record<string, unknown>;
        try {
          if (kind === 'text') {
            item = buildTextQuestionItem({
              title: args.title as string,
              description: args.description as string | undefined,
              paragraph: args.paragraph as boolean | undefined,
              required: args.required as boolean | undefined,
            });
          } else if (kind === 'choice') {
            const options = args.options as string[] | undefined;
            if (!Array.isArray(options) || options.length === 0) return err('options must be a non-empty array for kind=choice');
            item = buildChoiceQuestionItem({
              title: args.title as string,
              description: args.description as string | undefined,
              type: (args.choice_type as 'multiple_choice' | 'checkbox' | 'dropdown') ?? 'multiple_choice',
              options,
              shuffle: args.shuffle as boolean | undefined,
              required: args.required as boolean | undefined,
            });
          } else if (kind === 'scale') {
            const low = args.low as number;
            const high = args.high as number;
            const scaleErr = validateScaleBounds(low, high);
            if (scaleErr) return err(scaleErr);
            item = buildScaleQuestionItem({
              title: args.title as string,
              description: args.description as string | undefined,
              low, high,
              low_label: args.low_label as string | undefined,
              high_label: args.high_label as string | undefined,
              required: args.required as boolean | undefined,
            });
          } else if (kind === 'date') {
            item = buildDateOrTimeQuestionItem({
              title: args.title as string,
              description: args.description as string | undefined,
              kind: (args.date_kind as 'date' | 'time' | 'datetime') ?? 'date',
              include_year: args.include_year as boolean | undefined,
              required: args.required as boolean | undefined,
            });
          } else {
            return err(`Unknown kind: ${kind}`);
          }
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e));
        }
        // Forms API updateItem identifies the target via location.index, NOT
        // by itemId in the body. We must look up the item's current index
        // first. (v2.5.5 fix — earlier code passed location.index=0 always,
        // which silently overwrote whichever item happened to be at position 0
        // regardless of the item_id the agent specified.)
        const targetIdx = await findItemIndex(formId, itemId);
        if (targetIdx === null) return err(`item ${itemId} not found in form ${formId}`);
        const res = await batchUpdate(formId, [{
          updateItem: {
            item, // do NOT include itemId — Forms API ignores it for updates
            location: { index: targetIdx },
            updateMask: 'title,description,questionItem',
          },
        }], agentId, agentName, 'forms_update_question', { formId, itemId, kind, index: targetIdx });
        if (!res.ok) return err(`updating item: ${res.error}`);
        return ok({ form_id: formId, item_id: itemId, kind, updated: true });
      }

      case 'forms_rename_question': {
        const formId = args.form_id as string;
        const itemId = args.item_id as string;
        // Build a partial item with only the fields the agent supplied,
        // and a matching updateMask so Google knows what to overwrite.
        const partialItem: Record<string, unknown> = {};
        const maskFields: string[] = [];
        if (typeof args.title === 'string') {
          partialItem.title = args.title;
          maskFields.push('title');
        }
        if (typeof args.description === 'string') {
          partialItem.description = args.description;
          maskFields.push('description');
        }
        if (typeof args.required === 'boolean') {
          // The required flag lives inside questionItem.question.required.
          // We have to send the full sub-tree path Google expects, but only
          // the `required` field is updated thanks to the mask.
          partialItem.questionItem = { question: { required: args.required } };
          maskFields.push('questionItem.question.required');
        }
        if (maskFields.length === 0) return err('Pass at least one of: title, description, required');
        const targetIdx = await findItemIndex(formId, itemId);
        if (targetIdx === null) return err(`item ${itemId} not found in form ${formId}`);
        const res = await batchUpdate(formId, [{
          updateItem: {
            item: partialItem,
            location: { index: targetIdx },
            updateMask: maskFields.join(','),
          },
        }], agentId, agentName, 'forms_rename_question', { formId, itemId, fields: maskFields });
        if (!res.ok) return err(`renaming question: ${res.error}`);
        return ok({ form_id: formId, item_id: itemId, fields_changed: maskFields });
      }

      case 'forms_set_settings': {
        const formId = args.form_id as string;
        const settings: Record<string, unknown> = {};
        const maskFields: string[] = [];
        if (typeof args.is_quiz === 'boolean') {
          settings.quizSettings = { isQuiz: args.is_quiz };
          maskFields.push('quizSettings.isQuiz');
        }
        if (typeof args.email_collection_type === 'string') {
          // Forms API enum values: EMAIL_COLLECTION_TYPE_UNSPECIFIED |
          // DO_NOT_COLLECT | VERIFIED | RESPONDER_INPUT
          const MAP: Record<string, string> = {
            do_not_collect: 'DO_NOT_COLLECT',
            verified: 'VERIFIED',
            responder_input: 'RESPONDER_INPUT',
          };
          const mapped = MAP[args.email_collection_type as string];
          if (!mapped) return err(`Unknown email_collection_type: ${args.email_collection_type}`);
          settings.emailCollectionType = mapped;
          maskFields.push('emailCollectionType');
        }
        if (maskFields.length === 0) return err('Pass at least one of: is_quiz, email_collection_type');
        const res = await batchUpdate(formId, [{
          updateSettings: {
            settings,
            updateMask: maskFields.join(','),
          },
        }], agentId, agentName, 'forms_set_settings', { formId, fields: maskFields });
        if (!res.ok) return err(`updating settings: ${res.error}`);
        return ok({ form_id: formId, settings_changed: maskFields });
      }

      case 'forms_delete_item': {
        const formId = args.form_id as string;
        const itemId = args.item_id as string;
        // Forms API deleteItem takes a location (index). We have to look up
        // the item's current index first via a forms.get.
        const idx = await findItemIndex(formId, itemId);
        if (idx === null) return err(`item ${itemId} not found in form ${formId}`);
        const res = await batchUpdate(formId, [{
          deleteItem: { location: { index: idx } },
        }], agentId, agentName, 'forms_delete_item', { formId, itemId, index: idx });
        if (!res.ok) return err(`deleting item: ${res.error}`);
        return ok({ form_id: formId, item_id: itemId, deleted: true });
      }

      case 'forms_delete_form': {
        const formId = args.form_id as string;
        const permanent = args.permanent === true;
        // Forms API has no delete endpoint — forms are Drive files, so this
        // routes through Drive. Default to TRASH (recoverable for 30 days)
        // unless the agent explicitly asks for permanent deletion.
        if (permanent) {
          const result = await googleWrite(
            'DELETE',
            `https://www.googleapis.com/drive/v3/files/${formId}`,
            undefined,
            agentId, agentName, 'forms_delete_form',
            { formId, permanent: true },
          );
          if (!result.ok) return err(`permanently deleting form: ${result.error}`);
          return ok({ form_id: formId, deleted: 'permanent' });
        } else {
          const result = await googleWrite(
            'PATCH',
            `https://www.googleapis.com/drive/v3/files/${formId}`,
            { trashed: true },
            agentId, agentName, 'forms_delete_form',
            { formId, permanent: false },
          );
          if (!result.ok) return err(`trashing form: ${result.error}`);
          return ok({ form_id: formId, deleted: 'trashed', recoverable_for_days: 30 });
        }
      }

      // ── Reads ──

      case 'forms_get': {
        const formId = args.form_id as string;
        const fields = args.fields as string | undefined;
        const url = fields
          ? `${FORMS_BASE}/${formId}?fields=${encodeURIComponent(fields)}`
          : `${FORMS_BASE}/${formId}`;
        const result = await googleRead(
          url,
          agentId, agentName, 'forms_get',
          { formId, fields },
        );
        if (!result.ok) return err(`reading form: ${result.error}`);
        return ok(result.data);
      }

      case 'forms_list_responses': {
        const formId = args.form_id as string;
        const params = new URLSearchParams();
        if (typeof args.page_size === 'number') params.set('pageSize', String(args.page_size));
        if (typeof args.page_token === 'string' && args.page_token) params.set('pageToken', args.page_token as string);
        if (typeof args.filter === 'string' && args.filter) params.set('filter', args.filter);
        const url = `${FORMS_BASE}/${formId}/responses${params.toString() ? '?' + params.toString() : ''}`;
        const result = await googleRead(
          url,
          agentId, agentName, 'forms_list_responses',
          { formId, pageSize: args.page_size, pageToken: args.page_token, filter: args.filter },
        );
        if (!result.ok) return err(`listing responses: ${result.error}`);
        // Pass through nextPageToken from Google's response. Annotate
        // explicitly so the agent can't miss it (it's a top-level field
        // either way, but the comment in the result reinforces it).
        const data = result.data as { responses?: unknown[]; nextPageToken?: string };
        return ok({
          responses: data.responses ?? [],
          nextPageToken: data.nextPageToken,
          has_more: Boolean(data.nextPageToken),
        });
      }

      default:
        return err(`Unknown forms tool: ${name}`);
    }
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

// ─────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────

/**
 * Internal lookup of a form's items. Uses googleSilentFetch so the lookup
 * doesn't pollute the activity log with a separate "forms_*:lookup" entry —
 * the user-visible parent action is the one that gets logged.
 */
async function fetchItemsSilent(formId: string): Promise<Array<{ itemId: string }> | null> {
  const result = await googleSilentFetch('GET', `${FORMS_BASE}/${formId}?fields=items(itemId)`);
  if (!result.ok) return null;
  return (result.data as { items?: Array<{ itemId: string }> }).items ?? [];
}

async function createItem(
  formId: string,
  item: Record<string, unknown>,
  position: number | undefined,
  agentId: string,
  agentName: string,
  action: string,
): Promise<string> {
  // If no position given, query the form to find the current item count and
  // append. Silent fetch — only the createItem batchUpdate logs as an activity.
  let index = position;
  if (typeof index !== 'number') {
    const items = await fetchItemsSilent(formId);
    if (items === null) return err(`looking up form ${formId} for append position`);
    index = items.length;
  }
  const res = await batchUpdate(formId, [{
    createItem: { item, location: { index } },
  }], agentId, agentName, action, { formId, index });
  if (!res.ok) return err(res.error);
  const reply = res.data.replies?.[0] as { createItem?: { itemId?: string } } | undefined;
  const itemId = reply?.createItem?.itemId;
  return ok({ form_id: formId, item_id: itemId, index });
}

/**
 * Find the current index of an item by ID. Silent — no activity log entry,
 * because this is plumbing for the user-visible parent action (delete,
 * update, move).
 */
async function findItemIndex(formId: string, itemId: string): Promise<number | null> {
  const items = await fetchItemsSilent(formId);
  if (items === null) return null;
  const idx = items.findIndex((it) => it.itemId === itemId);
  return idx >= 0 ? idx : null;
}
