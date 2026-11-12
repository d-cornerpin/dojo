// The error-remedy registry: `(tool, error fingerprint) -> one sentence saying what to do instead`,
// appended to a failing result by agent/v2/attempt-record.ts. Nothing here refuses or blocks anything.
// `appliesTo` tests the canonical tool name; `pattern` the error fingerprint; `remedy` receives the tool
// as called, so a `user_` call is pointed at `user_` siblings.

import { canonicalToolName, fingerprint } from '../agent/v2/error-fingerprint.js';

interface ErrorRemedy {
  appliesTo: RegExp;
  pattern: RegExp;
  remedy: (calledTool: string) => string;
}

const REMEDIES: readonly ErrorRemedy[] = [
  {
    appliesTo: /^gmail_label$/,
    pattern: /invalid label/,
    remedy: (calledTool) => {
      const prefix = calledTool.startsWith('user_') ? 'user_' : '';
      return (
        'That label does not exist on this Gmail account ' +
        `(label names are per-account, not shared). Call ${prefix}gmail_list_labels to see the account's actual label ` +
        'names before retrying — do not guess or invent one. Two common cases already have a standard label: ' +
        'to archive a message, remove_labels: ["INBOX"] (there is no separate "Archive" label to add); to ' +
        'mark it as junk/spam, add_labels the system label "SPAM". If you intended a genuinely new custom ' +
        `label, call ${prefix}gmail_create_label first, then retry gmail_label with the exact name it returns.`
      );
    },
  },
  {
    appliesTo: /^teams_/,
    // Exactly the text microsoft/client.ts gives a Graph 403 'Forbidden' (the status survives masking).
    pattern: /access denied \(http 403 forbidden\)/,
    remedy: () =>
      'Teams said access denied (403). Teams only works on a Microsoft work/school account (Entra ID); ' +
      'personal accounts (outlook.com, hotmail.com, live.com) do not support it. If this IS a work/school ' +
      'account, the Teams permission may not be granted or you may not be a member of that chat: tell the ' +
      'owner rather than retrying.',
  },
];

function find(toolName: string, errorText: string): ErrorRemedy | undefined {
  const canonical = canonicalToolName(toolName);
  const fp = fingerprint(toolName, errorText);
  return REMEDIES.find((r) => r.appliesTo.test(canonical) && r.pattern.test(fp));
}

export function hasRemedy(toolName: string, errorText: string): boolean {
  return find(toolName, errorText) !== undefined;
}

export function remedyNote(toolName: string, errorText: string): string {
  const hit = find(toolName, errorText);
  return hit ? `\n\n[Engine note: ${hit.remedy(toolName)}]` : '';
}
