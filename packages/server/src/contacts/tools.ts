// ════════════════════════════════════════
// Agent-facing contacts tools (v2.9.16)
// Thin wrappers over store.ts that return human-readable strings the
// model can use directly in its reasoning + reply text.
// ════════════════════════════════════════

import {
  countContacts,
  createContact,
  deleteContact,
  describeContacts,
  findMatchingContact,
  countContactsNamed,
  getContactByIdOrPrefix,
  listContacts,
  searchContacts,
  updateContact,
  type ContactInput,
  type ContactRecord,
} from './store.js';

function asStringArray(v: unknown): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  if (typeof v === 'string') {
    return v.split(',').map(s => s.trim()).filter(Boolean);
  }
  return undefined;
}

function formatLine(r: ContactRecord): string {
  const parts: string[] = [`${r.displayName}`];
  if (r.preferredName && r.preferredName !== r.displayName) parts.push(`(${r.preferredName})`);
  if (r.company || r.role) {
    const wo = [r.role, r.company].filter(Boolean).join(' @ ');
    if (wo) parts.push(`— ${wo}`);
  }
  if (r.emails.length > 0) parts.push(`📧 ${r.emails[0]}${r.emails.length > 1 ? ` (+${r.emails.length - 1})` : ''}`);
  if (r.phones.length > 0) parts.push(`📞 ${r.phones[0]}${r.phones.length > 1 ? ` (+${r.phones.length - 1})` : ''}`);
  if (r.tags.length > 0) parts.push(`[${r.tags.join(', ')}]`);
  return `- ${parts.join(' ')} (id=${r.id.slice(0, 8)})`;
}

function formatFull(r: ContactRecord): string {
  const lines: string[] = [];
  lines.push(`Contact: ${r.displayName}${r.preferredName ? ` (${r.preferredName})` : ''}`);
  lines.push(`ID: ${r.id}`);
  if (r.role || r.company) lines.push(`Role/Company: ${[r.role, r.company].filter(Boolean).join(' @ ')}`);
  if (r.emails.length > 0) lines.push(`Emails: ${r.emails.join(', ')}`);
  if (r.phones.length > 0) lines.push(`Phones: ${r.phones.join(', ')}`);
  if (r.imessageHandles.length > 0) lines.push(`iMessage: ${r.imessageHandles.join(', ')}`);
  if (r.tags.length > 0) lines.push(`Tags: ${r.tags.join(', ')}`);
  if (r.notes) lines.push(`Notes:\n${r.notes}`);
  lines.push(`Last updated: ${r.updatedAt}${r.lastUpdatedByAgentId ? ` by ${r.lastUpdatedByAgentId}` : ''}`);
  return lines.join('\n');
}

export function executeContactSearch(args: Record<string, unknown>): string {
  const query = typeof args.query === 'string' ? args.query : '';
  const limit = typeof args.limit === 'number' ? args.limit : 20;
  const offset = typeof args.offset === 'number' ? args.offset : 0;
  const results = searchContacts(query, limit, offset);
  if (results.length === 0) return query ? `No contacts found matching "${query}".` : 'No contacts in the DOJO store.';
  const total = countContacts(query);
  const matching = query ? ` matching "${query}"` : '';
  const more = total > offset + results.length;
  // The tool schema has no `offset` (kept out of the cached tool block), so point at `limit` instead.
  const head = more || offset > 0
    ? `Showing ${results.length} of ${total} contact(s)${matching}`
    : `${results.length} contact(s)${matching}`;
  const tail = more ? `\n\nMore matched than are shown. Raise limit or narrow the query to see the rest.` : '';
  return `${head}:\n\n${results.map(formatLine).join('\n')}${tail}\n\nUse contact_get(id) for the full record.`;
}

export function executeContactList(args: Record<string, unknown>): string {
  const sortByRaw = typeof args.sort_by === 'string' ? args.sort_by : 'updated';
  const sortBy: 'name' | 'company' | 'updated' =
    sortByRaw === 'name' ? 'name' : sortByRaw === 'company' ? 'company' : 'updated';
  const limit = typeof args.limit === 'number' ? args.limit : 50;
  const offset = typeof args.offset === 'number' ? args.offset : 0;
  const results = listContacts({ limit, offset, sortBy });
  if (results.length === 0) return 'No contacts in the DOJO store.';
  const total = countContacts();
  const more = total > offset + results.length;
  const head = more || offset > 0
    ? `Showing ${results.length} of ${total} contact(s) (sorted by ${sortBy})`
    : `${results.length} contact(s) (sorted by ${sortBy})`;
  const tail = more ? `\n\nPass offset=${offset + results.length} to see more.` : '';
  return `${head}:\n\n${results.map(formatLine).join('\n')}${tail}`;
}

export function executeContactGet(args: Record<string, unknown>): string {
  const id = typeof args.contact_id === 'string' ? args.contact_id : '';
  if (!id) return 'Error: contact_id is required.';
  const record = getContactByIdOrPrefix(id);
  if (!record) return `Error: no contact with id "${id}".`;
  return formatFull(record);
}

export function executeContactRemember(agentId: string, args: Record<string, unknown>): string {
  const input: ContactInput = {
    displayName: typeof args.display_name === 'string' ? args.display_name : undefined,
    preferredName: typeof args.preferred_name === 'string' ? args.preferred_name : undefined,
    emails: asStringArray(args.emails),
    phones: asStringArray(args.phones),
    imessageHandles: asStringArray(args.imessage_handles),
    company: typeof args.company === 'string' ? args.company : undefined,
    role: typeof args.role === 'string' ? args.role : undefined,
    notes: typeof args.notes === 'string' ? args.notes : undefined,
    tags: asStringArray(args.tags),
  };
  const explicitId = typeof args.contact_id === 'string' ? args.contact_id : undefined;
  const hasAddress = [input.emails, input.phones, input.imessageHandles].some((l) => (l?.length ?? 0) > 0);
  const match = findMatchingContact({
    id: explicitId,
    emails: input.emails,
    phones: input.phones,
    imessageHandles: input.imessageHandles,
    displayName: input.displayName,
  }, { allowNameMatch: !hasAddress });
  if (!hasAddress && !explicitId && input.displayName && countContactsNamed(input.displayName) > 1) {
    return `More than one contact is named "${input.displayName.trim()}". Nothing was saved. Pass contact_id, or an email, phone or iMessage handle, to say which one.`;
  }
  if (match) {
    // Remembering only adds: a name, company or role already on file is kept, not overwritten.
    const kept: string[] = [];
    const patch: ContactInput = { ...input };
    for (const k of ['displayName', 'preferredName', 'company', 'role'] as const) {
      const have = match[k];
      if (patch[k] !== undefined && have && have.trim() !== '') {
        if (String(patch[k]).trim().toLowerCase() !== have.trim().toLowerCase()) kept.push(`${k} "${have}"`);
        delete patch[k];
      }
    }
    const updated = updateContact(match.id, patch, agentId, 'append');
    if (!updated) return `Error: matched existing contact ${match.id} but update failed.`;
    const note = kept.length > 0 ? ` Kept the existing ${kept.join(', ')}; use contact_update to change it.` : '';
    return `Contact updated (id=${updated.id.slice(0, 8)}). New observations appended to "${updated.displayName}".${note}`;
  }
  if (!input.displayName) return 'Error: display_name is required when creating a new contact.';
  try {
    const created = createContact(input, agentId);
    return `Contact created (id=${created.id.slice(0, 8)}) for "${created.displayName}".`;
  } catch (err) {
    return `Error creating contact: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export function executeContactUpdate(agentId: string, args: Record<string, unknown>): string {
  const id = typeof args.contact_id === 'string' ? args.contact_id : '';
  if (!id) return 'Error: contact_id is required.';
  const modeRaw = typeof args.mode === 'string' ? args.mode : 'replace';
  const mode: 'append' | 'replace' = modeRaw === 'append' ? 'append' : 'replace';
  const patch: ContactInput = {
    displayName: typeof args.display_name === 'string' ? args.display_name : undefined,
    preferredName: typeof args.preferred_name === 'string' ? args.preferred_name : undefined,
    emails: asStringArray(args.emails),
    phones: asStringArray(args.phones),
    imessageHandles: asStringArray(args.imessage_handles),
    company: typeof args.company === 'string' ? args.company : undefined,
    role: typeof args.role === 'string' ? args.role : undefined,
    notes: typeof args.notes === 'string' ? args.notes : undefined,
    tags: asStringArray(args.tags),
  };
  const record = getContactByIdOrPrefix(id);
  if (!record) return `Error: no contact with id "${id}".`;
  const updated = updateContact(record.id, patch, agentId, mode);
  if (!updated) return `Error: contact ${record.id} disappeared mid-update.`;
  return `Contact updated (id=${updated.id.slice(0, 8)}) - "${updated.displayName}".`;
}

export function executeContactForget(args: Record<string, unknown>): string {
  const id = typeof args.contact_id === 'string' ? args.contact_id : '';
  if (!id) return 'Error: contact_id is required.';
  const record = getContactByIdOrPrefix(id);
  if (!record) return `Error: no contact with id "${id}".`;
  const ok = deleteContact(record.id);
  return ok ? `Contact "${record.displayName}" (id=${record.id.slice(0, 8)}) deleted.` : `Error: delete failed for ${record.id}.`;
}

export function executeContactDescribe(): string {
  const d = describeContacts();
  const lines: string[] = [];
  lines.push(`DOJO contacts: ${d.total} total`);
  if (d.topTags.length > 0) {
    lines.push(`Top tags: ${d.topTags.map(t => `${t.tag} (${t.count})`).join(', ')}`);
  }
  if (d.topCompanies.length > 0) {
    lines.push(`Top companies: ${d.topCompanies.map(c => `${c.company} (${c.count})`).join(', ')}`);
  }
  return lines.join('\n');
}
