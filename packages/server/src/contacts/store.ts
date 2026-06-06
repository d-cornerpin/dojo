// ════════════════════════════════════════
// DOJO contacts store (v2.9.16)
// A place for agents (and the owner via the dashboard) to keep records
// of people the DOJO interacts with. Separate from Microsoft / Google
// contacts directories and from iMessage safe-senders.
// ════════════════════════════════════════

import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';

const logger = createLogger('contacts');

export interface ContactRecord {
  id: string;
  displayName: string;
  preferredName: string | null;
  emails: string[];
  phones: string[];
  imessageHandles: string[];
  company: string | null;
  role: string | null;
  notes: string | null;
  tags: string[];
  createdByAgentId: string | null;
  lastUpdatedByAgentId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ContactRow {
  id: string;
  display_name: string;
  preferred_name: string | null;
  emails: string;
  phones: string;
  imessage_handles: string;
  company: string | null;
  role: string | null;
  notes: string | null;
  tags: string;
  created_by_agent_id: string | null;
  last_updated_by_agent_id: string | null;
  created_at: string;
  updated_at: string;
}

function parseStringArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  } catch { /* fall through */ }
  return [];
}

function rowToRecord(row: ContactRow): ContactRecord {
  return {
    id: row.id,
    displayName: row.display_name,
    preferredName: row.preferred_name,
    emails: parseStringArray(row.emails),
    phones: parseStringArray(row.phones),
    imessageHandles: parseStringArray(row.imessage_handles),
    company: row.company,
    role: row.role,
    notes: row.notes,
    tags: parseStringArray(row.tags),
    createdByAgentId: row.created_by_agent_id,
    lastUpdatedByAgentId: row.last_updated_by_agent_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Normalize an address-like string for cross-record matching. */
function normalizeAddress(s: string): string {
  return s.trim().toLowerCase();
}

function uniqStrings(arr: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of arr) {
    const k = normalizeAddress(s);
    if (k && !seen.has(k)) { seen.add(k); out.push(s.trim()); }
  }
  return out;
}

// ── Reads ──

export function getContactById(id: string): ContactRecord | null {
  const row = getDb().prepare('SELECT * FROM contacts WHERE id = ?').get(id) as ContactRow | undefined;
  return row ? rowToRecord(row) : null;
}

export function listContacts(opts: { limit?: number; offset?: number; sortBy?: 'name' | 'company' | 'updated'; sortDir?: 'asc' | 'desc' } = {}): ContactRecord[] {
  const limit = Math.max(1, Math.min(500, opts.limit ?? 200));
  const offset = Math.max(0, opts.offset ?? 0);
  const dir = opts.sortDir === 'asc' ? 'ASC' : 'DESC';
  const orderClause = opts.sortBy === 'name'
    ? `display_name COLLATE NOCASE ${dir}`
    : opts.sortBy === 'company'
      ? `COALESCE(company, '~~~') COLLATE NOCASE ${dir}, display_name COLLATE NOCASE ASC`
      : `updated_at ${dir}`;
  const rows = getDb()
    .prepare(`SELECT * FROM contacts ORDER BY ${orderClause} LIMIT ? OFFSET ?`)
    .all(limit, offset) as ContactRow[];
  return rows.map(rowToRecord);
}

export function searchContacts(query: string, limit = 50, offset = 0): ContactRecord[] {
  const q = query.trim();
  if (!q) return listContacts({ limit, offset });
  const like = `%${q.replace(/[%_]/g, ch => '\\' + ch)}%`;
  const safeLimit = Math.max(1, Math.min(500, limit));
  const safeOffset = Math.max(0, offset);
  const rows = getDb().prepare(`
    SELECT * FROM contacts
    WHERE display_name LIKE ? ESCAPE '\\'
       OR preferred_name LIKE ? ESCAPE '\\'
       OR company LIKE ? ESCAPE '\\'
       OR role LIKE ? ESCAPE '\\'
       OR emails LIKE ? ESCAPE '\\'
       OR phones LIKE ? ESCAPE '\\'
       OR imessage_handles LIKE ? ESCAPE '\\'
       OR tags LIKE ? ESCAPE '\\'
       OR notes LIKE ? ESCAPE '\\'
    ORDER BY display_name COLLATE NOCASE ASC
    LIMIT ? OFFSET ?
  `).all(like, like, like, like, like, like, like, like, like, safeLimit, safeOffset) as ContactRow[];
  return rows.map(rowToRecord);
}

/** Total matching contacts. Used by the dashboard for pagination. */
export function countContacts(query?: string): number {
  const q = (query ?? '').trim();
  if (!q) {
    const row = getDb().prepare('SELECT COUNT(*) as c FROM contacts').get() as { c: number };
    return row.c;
  }
  const like = `%${q.replace(/[%_]/g, ch => '\\' + ch)}%`;
  const row = getDb().prepare(`
    SELECT COUNT(*) as c FROM contacts
    WHERE display_name LIKE ? ESCAPE '\\'
       OR preferred_name LIKE ? ESCAPE '\\'
       OR company LIKE ? ESCAPE '\\'
       OR role LIKE ? ESCAPE '\\'
       OR emails LIKE ? ESCAPE '\\'
       OR phones LIKE ? ESCAPE '\\'
       OR imessage_handles LIKE ? ESCAPE '\\'
       OR tags LIKE ? ESCAPE '\\'
       OR notes LIKE ? ESCAPE '\\'
  `).get(like, like, like, like, like, like, like, like, like) as { c: number };
  return row.c;
}

export function describeContacts(): { total: number; topTags: Array<{ tag: string; count: number }>; topCompanies: Array<{ company: string; count: number }> } {
  const db = getDb();
  const totalRow = db.prepare('SELECT COUNT(*) as c FROM contacts').get() as { c: number };
  const tagCounts = new Map<string, number>();
  const companyCounts = new Map<string, number>();
  const rows = db.prepare('SELECT tags, company FROM contacts').all() as Array<{ tags: string; company: string | null }>;
  for (const r of rows) {
    for (const tag of parseStringArray(r.tags)) {
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    }
    if (r.company) {
      companyCounts.set(r.company, (companyCounts.get(r.company) ?? 0) + 1);
    }
  }
  const topTags = [...tagCounts.entries()]
    .sort((a, b) => b[1] - a[1]).slice(0, 10).map(([tag, count]) => ({ tag, count }));
  const topCompanies = [...companyCounts.entries()]
    .sort((a, b) => b[1] - a[1]).slice(0, 10).map(([company, count]) => ({ company, count }));
  return { total: totalRow.c, topTags, topCompanies };
}

// ── Match-for-upsert ──

/**
 * Find an existing contact that matches the provided identifiers.
 * Order of precedence: explicit id > email match > phone match >
 * imessage handle match > exact display name match. Used by the
 * remember verb so the agent can append observations to the right
 * record instead of creating duplicates.
 */
export function findMatchingContact(input: {
  id?: string;
  emails?: readonly string[];
  phones?: readonly string[];
  imessageHandles?: readonly string[];
  displayName?: string;
}): ContactRecord | null {
  const db = getDb();
  if (input.id) {
    const byId = getContactById(input.id);
    if (byId) return byId;
  }
  const tryAddrMatch = (column: 'emails' | 'phones' | 'imessage_handles', values: readonly string[] | undefined): ContactRecord | null => {
    if (!values || values.length === 0) return null;
    for (const v of values) {
      const norm = normalizeAddress(v);
      if (!norm) continue;
      const rows = db
        .prepare(`SELECT * FROM contacts WHERE LOWER(${column}) LIKE ?`)
        .all(`%${norm}%`) as ContactRow[];
      for (const row of rows) {
        const list = parseStringArray(row[column] as string).map(normalizeAddress);
        if (list.includes(norm)) return rowToRecord(row);
      }
    }
    return null;
  };
  const byEmail = tryAddrMatch('emails', input.emails);
  if (byEmail) return byEmail;
  const byPhone = tryAddrMatch('phones', input.phones);
  if (byPhone) return byPhone;
  const byIm = tryAddrMatch('imessage_handles', input.imessageHandles);
  if (byIm) return byIm;
  if (input.displayName) {
    const row = db
      .prepare('SELECT * FROM contacts WHERE LOWER(display_name) = LOWER(?) LIMIT 1')
      .get(input.displayName.trim()) as ContactRow | undefined;
    if (row) return rowToRecord(row);
  }
  return null;
}

// ── Writes ──

export interface ContactInput {
  displayName?: string;
  preferredName?: string | null;
  emails?: readonly string[];
  phones?: readonly string[];
  imessageHandles?: readonly string[];
  company?: string | null;
  role?: string | null;
  notes?: string | null;
  tags?: readonly string[];
}

export function createContact(input: ContactInput, agentId: string | null): ContactRecord {
  const displayName = (input.displayName ?? '').trim();
  if (!displayName) throw new Error('display_name is required');
  const id = uuidv4();
  getDb().prepare(`
    INSERT INTO contacts (
      id, display_name, preferred_name, emails, phones, imessage_handles,
      company, role, notes, tags, created_by_agent_id, last_updated_by_agent_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    displayName,
    input.preferredName ?? null,
    JSON.stringify(uniqStrings(input.emails ?? [])),
    JSON.stringify(uniqStrings(input.phones ?? [])),
    JSON.stringify(uniqStrings(input.imessageHandles ?? [])),
    input.company ?? null,
    input.role ?? null,
    input.notes ?? null,
    JSON.stringify(uniqStrings(input.tags ?? [])),
    agentId,
    agentId,
  );
  const created = getContactById(id);
  if (!created) throw new Error('contact insert succeeded but row not readable');
  logger.info('Contact created', { id, displayName, agentId });
  return created;
}

/**
 * Patch a contact's fields. Address-list fields (emails/phones/imessage)
 * and tags MERGE with the existing list when `mode='append'`; they
 * REPLACE when `mode='replace'`. notes append by default with a
 * separator when mode='append'; replace overwrites verbatim.
 */
export function updateContact(
  id: string,
  patch: ContactInput,
  agentId: string | null,
  mode: 'append' | 'replace' = 'replace',
): ContactRecord | null {
  const existing = getContactById(id);
  if (!existing) return null;
  const merged: ContactInput = { ...patch };

  if (patch.emails !== undefined) {
    merged.emails = mode === 'append'
      ? uniqStrings([...existing.emails, ...patch.emails])
      : uniqStrings(patch.emails);
  }
  if (patch.phones !== undefined) {
    merged.phones = mode === 'append'
      ? uniqStrings([...existing.phones, ...patch.phones])
      : uniqStrings(patch.phones);
  }
  if (patch.imessageHandles !== undefined) {
    merged.imessageHandles = mode === 'append'
      ? uniqStrings([...existing.imessageHandles, ...patch.imessageHandles])
      : uniqStrings(patch.imessageHandles);
  }
  if (patch.tags !== undefined) {
    merged.tags = mode === 'append'
      ? uniqStrings([...existing.tags, ...patch.tags])
      : uniqStrings(patch.tags);
  }
  if (patch.notes !== undefined && mode === 'append') {
    const existingNotes = (existing.notes ?? '').trim();
    const incoming = (patch.notes ?? '').trim();
    if (existingNotes && incoming) {
      merged.notes = `${existingNotes}\n\n[${new Date().toISOString()}] ${incoming}`;
    } else {
      merged.notes = existingNotes || incoming || null;
    }
  }

  const sets: string[] = [];
  const params: unknown[] = [];
  const apply = (col: string, val: unknown, transform?: (v: unknown) => string) => {
    sets.push(`${col} = ?`);
    params.push(transform ? transform(val) : val);
  };
  if (merged.displayName !== undefined) apply('display_name', merged.displayName.trim());
  if (merged.preferredName !== undefined) apply('preferred_name', merged.preferredName);
  if (merged.emails !== undefined) apply('emails', merged.emails, v => JSON.stringify(v));
  if (merged.phones !== undefined) apply('phones', merged.phones, v => JSON.stringify(v));
  if (merged.imessageHandles !== undefined) apply('imessage_handles', merged.imessageHandles, v => JSON.stringify(v));
  if (merged.company !== undefined) apply('company', merged.company);
  if (merged.role !== undefined) apply('role', merged.role);
  if (merged.notes !== undefined) apply('notes', merged.notes);
  if (merged.tags !== undefined) apply('tags', merged.tags, v => JSON.stringify(v));
  sets.push("last_updated_by_agent_id = ?"); params.push(agentId);
  sets.push("updated_at = datetime('now')");
  params.push(id);
  getDb().prepare(`UPDATE contacts SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  logger.info('Contact updated', { id, mode, agentId });
  return getContactById(id);
}

export function deleteContact(id: string): boolean {
  const res = getDb().prepare('DELETE FROM contacts WHERE id = ?').run(id);
  if (res.changes > 0) logger.info('Contact deleted', { id });
  return res.changes > 0;
}
