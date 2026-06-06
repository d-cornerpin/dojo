import { useEffect, useMemo, useRef, useState } from 'react';
import * as api from '../lib/api';
import { useToast } from '../hooks/useToast';

// Contacts panel — rendered as a tab on the Vault page. Searchable
// list view with sortable columns; clicking a row opens the edit
// drawer. New contact via the "+ New" button. Same store the
// contact_* agent tools write to, so observations the agents recorded
// show up here for the owner to read and refine.

type SortKey = 'name' | 'company' | 'updated';
type SortDir = 'asc' | 'desc';

const PAGE_SIZE = 50;

function parseCsv(v: string): string[] {
  return v.split(',').map(s => s.trim()).filter(Boolean);
}

function joinCsv(arr: string[]): string {
  return arr.join(', ');
}

function fmtDate(iso: string): string {
  try {
    const d = new Date(iso + (iso.endsWith('Z') ? '' : 'Z'));
    return d.toLocaleString();
  } catch {
    return iso;
  }
}

export const ContactsPanel = () => {
  const [contacts, setContacts] = useState<api.ContactDto[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('updated');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [editing, setEditing] = useState<api.ContactDto | null>(null);
  const [creating, setCreating] = useState(false);
  const toast = useToast();
  const searchDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = async (q: string, sb: SortKey, sd: SortDir, p: number) => {
    setLoading(true);
    const result = await api.listContactsApi({
      q: q.trim() || undefined,
      sort_by: sb,
      sort_dir: sd,
      limit: PAGE_SIZE,
      offset: p * PAGE_SIZE,
    });
    if (result.ok) {
      setContacts(result.data.contacts);
      setTotal(result.data.total);
    } else {
      toast.error(`Failed to load contacts: ${result.error}`);
    }
    setLoading(false);
  };

  useEffect(() => {
    void load('', 'updated', 'desc', 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Debounce search input so we don't fire a request per keystroke.
  // Any change to query/sort resets to page 0; page changes load directly.
  useEffect(() => {
    if (searchDebounce.current) clearTimeout(searchDebounce.current);
    searchDebounce.current = setTimeout(() => {
      setPage(0);
      void load(query, sortKey, sortDir, 0);
    }, 250);
    return () => { if (searchDebounce.current) clearTimeout(searchDebounce.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, sortKey, sortDir]);

  const goToPage = (p: number) => {
    setPage(p);
    void load(query, sortKey, sortDir, p);
  };

  const handleSortClick = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir(key === 'updated' ? 'desc' : 'asc');
    }
  };

  const sortIndicator = (key: SortKey): string => {
    if (key !== sortKey) return '';
    return sortDir === 'asc' ? ' ▲' : ' ▼';
  };

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const rangeStart = total === 0 ? 0 : page * PAGE_SIZE + 1;
  const rangeEnd = Math.min(total, page * PAGE_SIZE + contacts.length);
  const totalLabel = useMemo(() => {
    if (loading) return 'Loading...';
    if (total === 0) return query ? 'No matches' : 'No contacts yet';
    return `${rangeStart}-${rangeEnd} of ${total}`;
  }, [loading, total, rangeStart, rangeEnd, query]);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex items-center gap-3 px-4 py-3 border-b border-ui/[0.06]">
        <input
          type="text"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Search name, email, phone, company, tag, notes..."
          className="glass-input flex-1 max-w-md"
        />
        <span className="text-xs text-ui/40">{totalLabel}</span>
        <button
          className="ml-auto px-3 py-1.5 text-xs rounded-lg bg-cp-amber/20 text-cp-amber hover:bg-cp-amber/30 transition-colors"
          onClick={() => setCreating(true)}
        >
          + New
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-ui/[0.02] backdrop-blur border-b border-ui/[0.06]">
            <tr className="text-left text-xs text-ui/55">
              <th className="px-4 py-2 font-medium cursor-pointer select-none" onClick={() => handleSortClick('name')}>
                Name{sortIndicator('name')}
              </th>
              <th className="px-4 py-2 font-medium cursor-pointer select-none" onClick={() => handleSortClick('company')}>
                Company{sortIndicator('company')}
              </th>
              <th className="px-4 py-2 font-medium">Channels</th>
              <th className="px-4 py-2 font-medium">Tags</th>
              <th className="px-4 py-2 font-medium cursor-pointer select-none" onClick={() => handleSortClick('updated')}>
                Last updated{sortIndicator('updated')}
              </th>
            </tr>
          </thead>
          <tbody>
            {contacts.map(c => (
              <tr
                key={c.id}
                onClick={() => setEditing(c)}
                className="border-b border-ui/[0.04] hover:bg-ui/[0.04] cursor-pointer transition-colors"
              >
                <td className="px-4 py-2">
                  <div className="text-ui">{c.display_name}</div>
                  {c.preferred_name && c.preferred_name !== c.display_name && (
                    <div className="text-xs text-ui/40">{c.preferred_name}</div>
                  )}
                </td>
                <td className="px-4 py-2 text-ui/70">
                  {c.company ?? ''}
                  {c.role && <span className="text-ui/40 text-xs"> · {c.role}</span>}
                </td>
                <td className="px-4 py-2 text-xs text-ui/55">
                  {c.emails.length > 0 && <div>📧 {c.emails[0]}{c.emails.length > 1 && ` +${c.emails.length - 1}`}</div>}
                  {c.phones.length > 0 && <div>📞 {c.phones[0]}{c.phones.length > 1 && ` +${c.phones.length - 1}`}</div>}
                  {c.imessage_handles.length > 0 && <div>💬 {c.imessage_handles[0]}{c.imessage_handles.length > 1 && ` +${c.imessage_handles.length - 1}`}</div>}
                </td>
                <td className="px-4 py-2">
                  <div className="flex flex-wrap gap-1">
                    {c.tags.map(t => (
                      <span key={t} className="inline-block text-[10px] px-1.5 py-0.5 rounded-full bg-ui/[0.06] text-ui/70">
                        {t}
                      </span>
                    ))}
                  </div>
                </td>
                <td className="px-4 py-2 text-xs text-ui/40">{fmtDate(c.updated_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && contacts.length === 0 && (
          <div className="text-center text-ui/40 text-sm py-12 px-4">
            {query
              ? `No contacts match "${query}".`
              : 'No contacts yet. Agents will add records here as they learn about people, or you can add one with the + New button.'}
          </div>
        )}
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between px-4 py-2 border-t border-ui/[0.06] text-xs text-ui/55">
          <span>Page {page + 1} of {totalPages}</span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => goToPage(0)}
              disabled={page === 0 || loading}
              className="px-2 py-1 rounded hover:bg-ui/[0.06] disabled:opacity-30 disabled:cursor-not-allowed"
            >
              « First
            </button>
            <button
              onClick={() => goToPage(page - 1)}
              disabled={page === 0 || loading}
              className="px-2 py-1 rounded hover:bg-ui/[0.06] disabled:opacity-30 disabled:cursor-not-allowed"
            >
              ‹ Prev
            </button>
            <button
              onClick={() => goToPage(page + 1)}
              disabled={page >= totalPages - 1 || loading}
              className="px-2 py-1 rounded hover:bg-ui/[0.06] disabled:opacity-30 disabled:cursor-not-allowed"
            >
              Next ›
            </button>
            <button
              onClick={() => goToPage(totalPages - 1)}
              disabled={page >= totalPages - 1 || loading}
              className="px-2 py-1 rounded hover:bg-ui/[0.06] disabled:opacity-30 disabled:cursor-not-allowed"
            >
              Last »
            </button>
          </div>
        </div>
      )}

      {(editing || creating) && (
        <ContactEditDrawer
          contact={editing}
          onClose={() => { setEditing(null); setCreating(false); }}
          onSaved={async () => {
            setEditing(null);
            setCreating(false);
            await load(query, sortKey, sortDir, page);
          }}
        />
      )}
    </div>
  );
};

interface DrawerProps {
  contact: api.ContactDto | null;
  onClose: () => void;
  onSaved: () => void;
}

const ContactEditDrawer = ({ contact, onClose, onSaved }: DrawerProps) => {
  const toast = useToast();
  const [displayName, setDisplayName] = useState(contact?.display_name ?? '');
  const [preferredName, setPreferredName] = useState(contact?.preferred_name ?? '');
  const [emails, setEmails] = useState(joinCsv(contact?.emails ?? []));
  const [phones, setPhones] = useState(joinCsv(contact?.phones ?? []));
  const [imHandles, setImHandles] = useState(joinCsv(contact?.imessage_handles ?? []));
  const [company, setCompany] = useState(contact?.company ?? '');
  const [role, setRole] = useState(contact?.role ?? '');
  const [tags, setTags] = useState(joinCsv(contact?.tags ?? []));
  const [notes, setNotes] = useState(contact?.notes ?? '');
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // updated_at captured at drawer open time. Sent on PATCH so the
  // server can detect concurrent edits (typically an agent appending
  // to notes while the owner is in the drawer) and reject with 409.
  // Refreshed by the conflict resolver when the owner chooses to
  // reload-and-keep-mine.
  const [baselineUpdatedAt, setBaselineUpdatedAt] = useState(contact?.updated_at ?? null);
  const [conflictCurrent, setConflictCurrent] = useState<api.ContactDto | null>(null);

  const reseedFromRecord = (rec: api.ContactDto) => {
    setDisplayName(rec.display_name);
    setPreferredName(rec.preferred_name ?? '');
    setEmails(joinCsv(rec.emails));
    setPhones(joinCsv(rec.phones));
    setImHandles(joinCsv(rec.imessage_handles));
    setCompany(rec.company ?? '');
    setRole(rec.role ?? '');
    setTags(joinCsv(rec.tags));
    setNotes(rec.notes ?? '');
    setBaselineUpdatedAt(rec.updated_at);
  };

  const buildInput = (): api.ContactInputDto => ({
    display_name: displayName.trim(),
    preferred_name: preferredName.trim() || null,
    emails: parseCsv(emails),
    phones: parseCsv(phones),
    imessage_handles: parseCsv(imHandles),
    company: company.trim() || null,
    role: role.trim() || null,
    tags: parseCsv(tags),
    notes: notes.trim() ? notes : null,
  });

  const handleSave = async (forceOverwrite = false) => {
    if (!displayName.trim()) {
      toast.error('Display name is required.');
      return;
    }
    setSaving(true);
    const input = buildInput();
    const result = contact
      ? await api.updateContactApi(
          contact.id,
          input,
          forceOverwrite ? undefined : baselineUpdatedAt ?? undefined,
        )
      : await api.createContactApi(input);
    setSaving(false);
    if (!result.ok) {
      // updateContactApi may attach `conflictCurrent` on the failure
      // branch when the server returns 409 with the up-to-date record.
      // The ApiError type doesn't carry that field, so we cast to read it.
      const conflict = (result as { conflictCurrent?: api.ContactDto }).conflictCurrent;
      if (conflict) {
        setConflictCurrent(conflict);
        return;
      }
      toast.error(`Save failed: ${result.error}`);
      return;
    }
    toast.success(contact ? 'Contact updated.' : 'Contact created.');
    onSaved();
  };

  const handleDelete = async () => {
    if (!contact) return;
    if (!confirm(`Delete "${contact.display_name}"? This cannot be undone.`)) return;
    setDeleting(true);
    const result = await api.deleteContactApi(contact.id);
    setDeleting(false);
    if (!result.ok) {
      toast.error(`Delete failed: ${result.error}`);
      return;
    }
    toast.success('Contact deleted.');
    onSaved();
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-end sm:items-center justify-center z-50" onClick={onClose}>
      <div
        className="glass-modal-bg w-full max-w-xl max-h-[90vh] overflow-y-auto rounded-t-xl sm:rounded-xl border border-ui/[0.08] shadow-xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-ui/[0.06]">
          <h3 className="text-base font-semibold text-ui">
            {contact ? 'Edit contact' : 'New contact'}
          </h3>
          <button className="text-ui/40 hover:text-ui/70 text-xl leading-none" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="px-5 py-4 space-y-3">
          <FieldRow label="Display name *">
            <input value={displayName} onChange={e => setDisplayName(e.target.value)} className="glass-input w-full" autoFocus />
          </FieldRow>
          <FieldRow label="Preferred name">
            <input value={preferredName} onChange={e => setPreferredName(e.target.value)} className="glass-input w-full" />
          </FieldRow>
          <div className="grid grid-cols-2 gap-3">
            <FieldRow label="Company">
              <input value={company} onChange={e => setCompany(e.target.value)} className="glass-input w-full" />
            </FieldRow>
            <FieldRow label="Role">
              <input value={role} onChange={e => setRole(e.target.value)} className="glass-input w-full" />
            </FieldRow>
          </div>
          <FieldRow label="Emails (comma-separated)">
            <input value={emails} onChange={e => setEmails(e.target.value)} className="glass-input w-full" />
          </FieldRow>
          <FieldRow label="Phones (comma-separated)">
            <input value={phones} onChange={e => setPhones(e.target.value)} className="glass-input w-full" />
          </FieldRow>
          <FieldRow label="iMessage handles (comma-separated)">
            <input value={imHandles} onChange={e => setImHandles(e.target.value)} className="glass-input w-full" />
          </FieldRow>
          <FieldRow label="Tags (comma-separated)">
            <input value={tags} onChange={e => setTags(e.target.value)} className="glass-input w-full" />
          </FieldRow>
          <FieldRow label="Notes">
            <textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              rows={8}
              className="glass-input w-full font-mono text-xs leading-relaxed"
              placeholder="Freeform notes. Agents append timestamped observations here as they learn things."
            />
          </FieldRow>
          {contact && (
            <div className="text-xs text-ui/40 pt-2 border-t border-ui/[0.04]">
              <div>ID: <span className="font-mono">{contact.id}</span></div>
              <div>Created {fmtDate(contact.created_at)}{contact.created_by_agent_id ? ` by ${contact.created_by_agent_id}` : ''}</div>
              <div>Updated {fmtDate(contact.updated_at)}{contact.last_updated_by_agent_id ? ` by ${contact.last_updated_by_agent_id}` : ''}</div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 px-5 py-3 border-t border-ui/[0.06]">
          {contact ? (
            <button
              onClick={handleDelete}
              disabled={deleting}
              className="px-3 py-1.5 text-xs rounded-lg text-red-400 hover:bg-red-400/10 transition-colors disabled:opacity-50"
            >
              {deleting ? 'Deleting...' : 'Delete'}
            </button>
          ) : <div />}
          <div className="flex items-center gap-2">
            <button onClick={onClose} className="px-3 py-1.5 text-xs rounded-lg text-ui/55 hover:text-ui/90 transition-colors">
              Cancel
            </button>
            <button
              onClick={() => handleSave(false)}
              disabled={saving || !displayName.trim()}
              className="px-3 py-1.5 text-xs rounded-lg bg-cp-amber/20 text-cp-amber hover:bg-cp-amber/30 transition-colors disabled:opacity-50"
            >
              {saving ? 'Saving...' : contact ? 'Save changes' : 'Create contact'}
            </button>
          </div>
        </div>
      </div>

      {conflictCurrent && (
        <div
          className="fixed inset-0 bg-black/70 flex items-center justify-center z-[60]"
          onClick={() => setConflictCurrent(null)}
        >
          <div
            className="glass-modal-bg max-w-md w-[92vw] rounded-xl border border-ui/[0.12] shadow-2xl p-5 space-y-3"
            onClick={e => e.stopPropagation()}
          >
            <h4 className="text-sm font-semibold text-ui">Contact changed while you were editing</h4>
            <p className="text-xs text-ui/70 leading-relaxed">
              An agent (or another browser tab) modified <span className="font-medium text-ui">{conflictCurrent.display_name}</span> after you opened it. The server's current copy was last updated {fmtDate(conflictCurrent.updated_at)}.
            </p>
            <p className="text-xs text-ui/55 leading-relaxed">
              You can reload the latest version into the form (your unsaved edits will be lost) or save anyway and overwrite the change.
            </p>
            <div className="flex flex-col gap-1.5 pt-2">
              <button
                onClick={() => {
                  reseedFromRecord(conflictCurrent);
                  setConflictCurrent(null);
                  toast.info('Reloaded with the latest version. Re-apply your edits and save.');
                }}
                className="px-3 py-2 text-xs rounded-lg bg-ui/[0.06] text-ui hover:bg-ui/[0.10] transition-colors text-left"
              >
                Reload latest (discard my unsaved edits)
              </button>
              <button
                onClick={() => {
                  setConflictCurrent(null);
                  void handleSave(true);
                }}
                className="px-3 py-2 text-xs rounded-lg bg-red-400/10 text-red-400 hover:bg-red-400/20 transition-colors text-left"
              >
                Save anyway (overwrite the agent's change)
              </button>
              <button
                onClick={() => setConflictCurrent(null)}
                className="px-3 py-2 text-xs rounded-lg text-ui/55 hover:text-ui/90 transition-colors text-left"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

const FieldRow = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <label className="block">
    <span className="block text-xs text-ui/55 mb-1">{label}</span>
    {children}
  </label>
);
