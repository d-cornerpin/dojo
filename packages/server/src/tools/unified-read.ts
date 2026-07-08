// ════════════════════════════════════════
// Unified read tools (F4: coverage guarantee)
//
// The platform can hold up to four mail surfaces and four+ calendar surfaces:
// {agent, owner} x {Google, Microsoft}, each slot holding several accounts.
// Which surfaces a narrow tool swept was left to per-turn model judgment, and a
// weak floor model picks a different arbitrary subset every time, so "what does
// my day look like" or "check my email for X" produced confident, silently
// INCOMPLETE answers. Per the correctness-floor law, coverage is the engine's
// job, not the model's: one call here = complete coverage.
//
// unifiedCalendarAgenda / unifiedEmailSearch enumerate EVERY connected +
// service-enabled account across both providers and both slots, fetch each in
// parallel (per-account failures never sink the whole call), merge, and label
// every line by source. The per-provider FETCH logic is NOT duplicated here:
// these executors reuse the same helpers the narrow tools use
// (fetchAgendaItemsForAccount / searchMailForAccount in google/tools-read.ts and
// their Microsoft mirrors). One fetch path, two renderers.
//
// Import direction is one-way: this module -> provider modules -> nothing back.
// Provider fetch helpers are pulled via DYNAMIC import inside the executors so
// (a) there is no top-level cycle and (b) the pure merge/dedup/render functions
// below carry no provider dependency and can be imported in isolation by tests.
// ════════════════════════════════════════

import type { ToolDefinition } from '../agent/tools.js';
import { registerConcurrency, registerMaxResultTokens } from '../agent/v2/classifiers/concurrency.js';

// ── Pure types (no provider / DB / format-time dependency) ──

export type SlotWord = 'agent' | 'owner';

export interface UnifiedSource {
  /** Display name for the provider surface: Google/Microsoft (calendar) or Gmail/Outlook (mail). */
  providerLabel: string;
  slot: SlotWord;
  email: string;
  /** `${slot} ${providerLabel}` — the ambiguity key (email is only shown when a label maps to >1 account). */
  labelKey: string;
}

export interface UnifiedCalendarItem {
  title: string;
  /** Instant ISO for a timed event, or the all-day date. Half of the dedup key. */
  startISO: string;
  /** Epoch ms for chronological sort (unparseable times sink to the end). */
  sortKey: number;
  allDay: boolean;
  location?: string;
  /** Preformatted, timezone-labeled display range (built by the executor). */
  when: string;
  source: UnifiedSource;
}

export interface MergedCalendarItem {
  title: string;
  startISO: string;
  allDay: boolean;
  location?: string;
  when: string;
  /** One entry per distinct source that carries this same (title, start). */
  sources: UnifiedSource[];
}

export interface UnifiedMailItem {
  id: string;
  from: string;
  subject: string;
  /** Preformatted, timezone-labeled date. */
  when: string;
  /** Epoch ms for most-recent-first sort. */
  sortKey: number;
  snippet: string;
  /** True only when the source reported the message as unread (Gmail search does not report read-state). */
  unread: boolean;
  source: UnifiedSource;
}

export interface AccountFailure {
  label: string;
  error: string;
}

// ── Pure helpers (unit-tested directly) ──

export function normalizeTitle(t: string): string {
  return (t ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Chronological (earliest first). Stable, non-mutating. */
export function mergeCalendarChronologically(items: UnifiedCalendarItem[]): UnifiedCalendarItem[] {
  return [...items].sort((a, b) => a.sortKey - b.sortKey);
}

/**
 * Collapse events that share a normalized title AND the same start into one
 * line carrying every distinct source. Preserves first-seen order, so run this
 * on an already-chronological list to keep the merged agenda chronological.
 */
export function dedupCalendarItems(items: UnifiedCalendarItem[]): MergedCalendarItem[] {
  const order: string[] = [];
  const map = new Map<string, MergedCalendarItem>();
  for (const it of items) {
    const key = `${normalizeTitle(it.title)}|${it.startISO}`;
    const existing = map.get(key);
    if (existing) {
      if (!existing.sources.some(s => s.labelKey === it.source.labelKey && s.email === it.source.email)) {
        existing.sources.push(it.source);
      }
    } else {
      map.set(key, {
        title: it.title,
        startISO: it.startISO,
        allDay: it.allDay,
        location: it.location,
        when: it.when,
        sources: [it.source],
      });
      order.push(key);
    }
  }
  return order.map(k => map.get(k)!);
}

/** Most-recent-first. Stable, non-mutating. */
export function mergeMailByRecency(items: UnifiedMailItem[]): UnifiedMailItem[] {
  return [...items].sort((a, b) => b.sortKey - a.sortKey);
}

/** A source label needs its email shown only when the SAME label covers >1 account. */
export function computeAmbiguousLabels(sources: UnifiedSource[]): Set<string> {
  const byLabel = new Map<string, Set<string>>();
  for (const s of sources) {
    if (!byLabel.has(s.labelKey)) byLabel.set(s.labelKey, new Set());
    byLabel.get(s.labelKey)!.add(s.email);
  }
  const ambiguous = new Set<string>();
  for (const [label, emails] of byLabel) {
    if (emails.size > 1) ambiguous.add(label);
  }
  return ambiguous;
}

export function formatSourceLabel(s: UnifiedSource, ambiguous: Set<string>): string {
  const base = `[${s.slot} ${s.providerLabel}]`;
  return ambiguous.has(s.labelKey) && s.email ? `${base} (${s.email})` : base;
}

function joinSourceLabels(sources: UnifiedSource[], ambiguous: Set<string>): string {
  const labels = sources.map(s => formatSourceLabel(s, ambiguous));
  if (labels.length === 1) return labels[0];
  if (labels.length === 2) return `(on both ${labels[0]} and ${labels[1]})`;
  return `(on ${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]})`;
}

function renderCalendarLine(m: MergedCalendarItem, ambiguous: Set<string>): string {
  let line = `- ${m.title}\n  ${m.when}  ${joinSourceLabels(m.sources, ambiguous)}`;
  if (m.location) line += `\n  Location: ${m.location}`;
  return line;
}

function renderFailures(failures: AccountFailure[]): string[] {
  return failures.map(f => `could not read ${f.label}: ${f.error}`);
}

export function renderCalendarAgenda(
  merged: MergedCalendarItem[],
  ambiguous: Set<string>,
  failures: AccountFailure[],
  opts: { days: number; accountCount: number },
): string {
  const timed = merged.filter(m => !m.allDay);
  const allDay = merged.filter(m => m.allDay);
  const lines: string[] = [];
  lines.push(
    `Merged agenda (next ${opts.days} day(s)) across ${opts.accountCount} connected calendar${opts.accountCount === 1 ? '' : 's'}:`,
  );
  if (timed.length > 0) {
    lines.push('');
    for (const m of timed) lines.push(renderCalendarLine(m, ambiguous));
  }
  if (allDay.length > 0) {
    lines.push('');
    lines.push('All-day:');
    for (const m of allDay) lines.push(renderCalendarLine(m, ambiguous));
  }
  if (timed.length === 0 && allDay.length === 0) {
    lines.push('');
    lines.push('No events on any connected calendar in this window.');
  }
  if (failures.length > 0) {
    lines.push('');
    lines.push(...renderFailures(failures));
  }
  return lines.join('\n');
}

export function renderEmailSearch(
  items: UnifiedMailItem[],
  ambiguous: Set<string>,
  failures: AccountFailure[],
  opts: { query: string; accountCount: number },
): string {
  const lines: string[] = [];
  lines.push(
    `Merged email search for "${opts.query}" across ${opts.accountCount} connected mailbox${opts.accountCount === 1 ? '' : 'es'}:`,
  );
  if (items.length > 0) {
    lines.push('');
    for (const m of items) {
      const label = formatSourceLabel(m.source, ambiguous);
      const unread = m.unread ? ' [UNREAD]' : '';
      const snip = m.snippet
        ? ` | ${m.snippet.length > 160 ? m.snippet.slice(0, 160) + '…' : m.snippet}`
        : '';
      lines.push(`- ${label}${unread} ${m.when} | ${m.from} — ${m.subject}\n  ID: ${m.id}${snip}`);
    }
  } else {
    lines.push('');
    lines.push('No matching email in any connected mailbox.');
  }
  if (failures.length > 0) {
    lines.push('');
    lines.push(...renderFailures(failures));
  }
  return lines.join('\n');
}

// ── Narrow-tool DATA-floor helpers (pure; unit-tested directly) ──
//
// A narrow agenda/mail-search call touches ONE surface. Advice ("also call the
// merged tool") does not survive a weak model — it reads the note and answers
// anyway, missing real events/mail on the surfaces it skipped. The floor must be
// DATA: the narrow result carries, compactly and labeled, what the OTHER
// connected surfaces hold. These renderers build that appended block; the
// impure fan-out that feeds them lives in the two orchestrators below.

/** Compact single time for the "also elsewhere" block: "9:00 AM", or "All day". Intl-only, pure. */
export function compactEventTime(start: Date | null, tz: string, allDay: boolean): string {
  if (allDay) return 'All day';
  if (!start || Number.isNaN(start.getTime())) return 'time TBD';
  try {
    return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz }).format(start);
  } catch {
    return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(start);
  }
}

export interface OtherCalendarRow {
  title: string;
  /** Preformatted compact time or 'All day' (from compactEventTime). */
  when: string;
  source: UnifiedSource;
}

/**
 * "Also on other connected calendars" block appended to a NARROW agenda result
 * so a single-surface answer never reads as the whole day. Capped at `cap`
 * lines; when more exist, a pointer to the merged tool replaces the overflow.
 * '' for an empty list (silence is honest — nothing elsewhere). Pure.
 */
export function renderOtherCalendarsSection(
  rows: OtherCalendarRow[],
  ambiguous: Set<string>,
  cap = 6,
): string {
  if (rows.length === 0) return '';
  const shown = rows.slice(0, cap);
  const lines = shown.map(r => `- ${r.title}, ${r.when} ${formatSourceLabel(r.source, ambiguous)}`);
  let out = `Also on other connected calendars (not shown above):\n${lines.join('\n')}`;
  if (rows.length > cap) out += `\n(call calendar_agenda for the fully merged view)`;
  return out;
}

export interface MailboxCount {
  source: UnifiedSource;
  count: number;
}

/**
 * One-line "also matching elsewhere" count block for a NARROW mail search.
 * Zero-count surfaces are dropped; an all-zero list yields '' (honest silence).
 * Pure.
 */
export function renderOtherMailboxesCount(counts: MailboxCount[], ambiguous: Set<string>): string {
  const nonzero = counts.filter(c => c.count > 0);
  if (nonzero.length === 0) return '';
  const parts = nonzero.map(c => `${c.count} in ${formatSourceLabel(c.source, ambiguous)}`);
  return `Also matching in other connected mailboxes: ${parts.join(', ')}. Call email_search to see them together.`;
}

// ── Account enumeration (runtime; touches the DB via dynamic import) ──

interface EnumeratedAccount {
  provider: 'google' | 'microsoft';
  accountId: string;
  source: UnifiedSource;
  /** Human label used in per-account failure lines. */
  label: string;
}

/** A per-account service is enabled unless its JSON explicitly sets it false (defaults are all-on). */
function serviceEnabled(enabledServices: string | null, service: string): boolean {
  if (!enabledServices) return true;
  try {
    return (JSON.parse(enabledServices) as Record<string, unknown>)[service] !== false;
  } catch {
    return true;
  }
}

async function enumerateAccounts(service: 'calendar' | 'mail'): Promise<EnumeratedAccount[]> {
  const { listGoogleAccounts } = await import('../google/accounts.js');
  const { listMicrosoftAccounts } = await import('../microsoft/accounts.js');

  const googleService = service === 'calendar' ? 'calendar' : 'gmail';
  const msService = service === 'calendar' ? 'calendar' : 'outlook';
  const googleProvider = service === 'calendar' ? 'Google' : 'Gmail';
  const msProvider = service === 'calendar' ? 'Microsoft' : 'Outlook';
  const surface = service === 'calendar' ? 'calendar' : 'mailbox';

  const out: EnumeratedAccount[] = [];
  const make = (
    provider: 'google' | 'microsoft',
    accountId: string,
    kind: 'agent' | 'user',
    email: string | null,
    providerLabel: string,
  ): EnumeratedAccount => {
    const slot: SlotWord = kind === 'user' ? 'owner' : 'agent';
    const mail = email ?? '';
    return {
      provider,
      accountId,
      source: { providerLabel, slot, email: mail, labelKey: `${slot} ${providerLabel}` },
      label: `${slot} ${providerLabel} ${surface}${mail ? ` (${mail})` : ''}`,
    };
  };

  for (const kind of ['agent', 'user'] as const) {
    for (const a of listGoogleAccounts(kind)) {
      if (a.connected && serviceEnabled(a.enabledServices, googleService)) {
        out.push(make('google', a.id, kind, a.email, googleProvider));
      }
    }
    for (const a of listMicrosoftAccounts(kind)) {
      if (a.connected && serviceEnabled(a.enabledServices, msService)) {
        out.push(make('microsoft', a.id, kind, a.email, msProvider));
      }
    }
  }
  return out;
}

// ── Executors ──

/**
 * Merged agenda across EVERY connected calendar (agent + owner, Google +
 * Microsoft). The `account` arg is intentionally ignored: this view spans all
 * accounts; the provider variants take a single account.
 */
export async function unifiedCalendarAgenda(
  args: Record<string, unknown>,
  agentId: string,
  agentName: string,
): Promise<string> {
  const days = (args.days as number) ?? 1;
  const requestedTz = args.timezone as string | undefined;
  const tz = requestedTz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const startDate = args.start_date as string | undefined;

  const { computeCalendarWindow } = await import('../services/calendar-window.js');
  const window = computeCalendarWindow({ days, timezone: requestedTz, start_date: startDate });

  const accounts = await enumerateAccounts('calendar');
  if (accounts.length === 0) {
    return 'No calendar is connected. Connect a Google or Microsoft account in Settings to see your agenda.';
  }

  const { fetchAgendaItemsForAccount } = await import('../google/tools-read.js');
  const { fetchAgendaItemsForAccountMs } = await import('../microsoft/tools-read.js');
  const { formatTimeRangeForAgent } = await import('../services/format-time.js');

  const failures: AccountFailure[] = [];
  const collected: UnifiedCalendarItem[] = [];

  await Promise.all(
    accounts.map(async (acc) => {
      try {
        const res =
          acc.provider === 'google'
            ? await fetchAgendaItemsForAccount(acc.accountId, window, tz, agentId, agentName, { days })
            : await fetchAgendaItemsForAccountMs(acc.accountId, window, agentId, agentName, { days });
        if (!res.ok) {
          failures.push({ label: acc.label, error: res.error });
          return;
        }
        for (const it of res.items) {
          const when =
            it.start && it.end
              ? formatTimeRangeForAgent(it.start, it.end, { timezone: tz, allDay: it.allDay })
              : `${it.rawStart} to ${it.rawEnd} (could not parse)`;
          const startISO = it.start ? it.start.toISOString() : it.rawStart;
          const sortKey = it.start ? it.start.getTime() : Number.MAX_SAFE_INTEGER;
          collected.push({
            title: it.title,
            startISO,
            sortKey,
            allDay: it.allDay,
            location: it.location,
            when,
            source: acc.source,
          });
        }
      } catch (err) {
        failures.push({ label: acc.label, error: err instanceof Error ? err.message : String(err) });
      }
    }),
  );

  const merged = dedupCalendarItems(mergeCalendarChronologically(collected));
  const ambiguous = computeAmbiguousLabels(accounts.map(a => a.source));
  return renderCalendarAgenda(merged, ambiguous, failures, { days, accountCount: accounts.length });
}

/**
 * Search EVERY connected mailbox at once (agent + owner, Gmail + Outlook). The
 * `days` bound is applied per-mailbox (Gmail via `newer_than`), `limit` caps
 * results per mailbox.
 */
export async function unifiedEmailSearch(
  args: Record<string, unknown>,
  agentId: string,
  agentName: string,
): Promise<string> {
  const query = (args.query as string | undefined)?.trim();
  if (!query) return 'Error: email_search requires a non-empty `query`.';
  const days = (args.days as number) ?? 30;
  const limit = (args.limit as number) ?? 5;

  const accounts = await enumerateAccounts('mail');
  if (accounts.length === 0) {
    return 'No mailbox is connected. Connect a Gmail or Outlook account in Settings to search your email.';
  }

  const { searchMailForAccount } = await import('../google/tools-read.js');
  const { searchMailForAccountMs } = await import('../microsoft/tools-read.js');

  const failures: AccountFailure[] = [];
  const collected: UnifiedMailItem[] = [];

  await Promise.all(
    accounts.map(async (acc) => {
      try {
        if (acc.provider === 'google') {
          // Gmail understands `newer_than:Nd` as a recency bound in the query.
          const gq = days > 0 ? `${query} newer_than:${days}d` : query;
          const res = await searchMailForAccount(acc.accountId, gq, limit, agentId, agentName);
          if (!res.ok) {
            failures.push({ label: acc.label, error: res.error });
            return;
          }
          for (const it of res.items) {
            collected.push({
              id: it.id,
              from: it.from,
              subject: it.subject,
              when: it.dateDisplay,
              sortKey: it.dateSortMs,
              snippet: it.snippet,
              unread: it.read === false,
              source: acc.source,
            });
          }
        } else {
          const res = await searchMailForAccountMs(acc.accountId, query, limit, agentId, agentName);
          if (!res.ok) {
            failures.push({ label: acc.label, error: res.error });
            return;
          }
          for (const it of res.items) {
            collected.push({
              id: it.id,
              from: it.from,
              subject: it.subject,
              when: it.dateDisplay,
              sortKey: it.dateSortMs,
              snippet: it.snippet,
              unread: it.read === false,
              source: acc.source,
            });
          }
        }
      } catch (err) {
        failures.push({ label: acc.label, error: err instanceof Error ? err.message : String(err) });
      }
    }),
  );

  const merged = mergeMailByRecency(collected);
  const ambiguous = computeAmbiguousLabels(accounts.map(a => a.source));
  return renderEmailSearch(merged, ambiguous, failures, { query, accountCount: accounts.length });
}

// ── Narrow-tool DATA-floor orchestrators (impure; fan out over OTHER surfaces) ──
//
// Called by the NARROW agenda/mail cases in the provider files (via dynamic
// import, keeping the static graph one-way). They reuse the SAME enumeration +
// per-account fetch helpers the merged executors above use, excluding the one
// account the narrow tool already read. Per-surface fetch errors are swallowed
// here (the MERGED tool is where failures get itemized); a narrow answer must
// never be sunk or delayed by another surface beyond the parallel fetch cost.

/**
 * Compact "also on other calendars" block for a NARROW agenda read. `exclude` is
 * the account the narrow tool already rendered (by provider + row id); every
 * OTHER connected calendar is fetched for the SAME window in parallel. Returns
 * '' (leading newlines included only when non-empty) when nothing else holds
 * events or no other surface exists.
 */
export async function otherCalendarsAgendaSection(
  exclude: { provider: 'google' | 'microsoft'; accountId: string },
  window: { startISO: string; endISO: string; anchored: boolean },
  tz: string,
  days: number,
  agentId: string,
  agentName: string,
): Promise<string> {
  const accounts = (await enumerateAccounts('calendar')).filter(
    a => !(a.provider === exclude.provider && a.accountId === exclude.accountId),
  );
  if (accounts.length === 0) return '';

  const { fetchAgendaItemsForAccount } = await import('../google/tools-read.js');
  const { fetchAgendaItemsForAccountMs } = await import('../microsoft/tools-read.js');

  const collected: Array<{ row: OtherCalendarRow; sortKey: number }> = [];
  await Promise.all(
    accounts.map(async (acc) => {
      try {
        const res =
          acc.provider === 'google'
            ? await fetchAgendaItemsForAccount(acc.accountId, window, tz, agentId, agentName, { days })
            : await fetchAgendaItemsForAccountMs(acc.accountId, window, agentId, agentName, { days });
        if (!res.ok) return; // skip this surface silently (the merged tool itemizes errors)
        for (const it of res.items) {
          collected.push({
            row: { title: it.title, when: compactEventTime(it.start, tz, it.allDay), source: acc.source },
            sortKey: it.start ? it.start.getTime() : Number.MAX_SAFE_INTEGER,
          });
        }
      } catch {
        /* skip this surface silently */
      }
    }),
  );

  if (collected.length === 0) return '';
  collected.sort((a, b) => a.sortKey - b.sortKey);
  const ambiguous = computeAmbiguousLabels(accounts.map(a => a.source));
  const section = renderOtherCalendarsSection(collected.map(c => c.row), ambiguous);
  return section ? `\n\n${section}` : '';
}

/**
 * One-line "also matching in other mailboxes" count block for a NARROW mail
 * search. Runs the SAME query against every OTHER connected mailbox (small
 * per-mailbox cap), counts only. `days > 0` applies a Gmail recency bound; pass
 * 0 to mirror an unbounded narrow search.
 */
export async function otherMailboxesCountSection(
  exclude: { provider: 'google' | 'microsoft'; accountId: string },
  query: string,
  days: number,
  agentId: string,
  agentName: string,
): Promise<string> {
  const accounts = (await enumerateAccounts('mail')).filter(
    a => !(a.provider === exclude.provider && a.accountId === exclude.accountId),
  );
  if (accounts.length === 0) return '';

  const { searchMailForAccount } = await import('../google/tools-read.js');
  const { searchMailForAccountMs } = await import('../microsoft/tools-read.js');
  const perMailboxLimit = 5;

  const counts: MailboxCount[] = [];
  await Promise.all(
    accounts.map(async (acc) => {
      try {
        if (acc.provider === 'google') {
          const gq = days > 0 ? `${query} newer_than:${days}d` : query;
          const res = await searchMailForAccount(acc.accountId, gq, perMailboxLimit, agentId, agentName);
          if (res.ok && res.total > 0) counts.push({ source: acc.source, count: res.total });
        } else {
          const res = await searchMailForAccountMs(acc.accountId, query, perMailboxLimit, agentId, agentName);
          if (res.ok && res.items.length > 0) counts.push({ source: acc.source, count: res.items.length });
        }
      } catch {
        /* skip this surface silently */
      }
    }),
  );

  if (counts.length === 0) return '';
  const ambiguous = computeAmbiguousLabels(accounts.map(a => a.source));
  const line = renderOtherMailboxesCount(counts, ambiguous);
  return line ? `\n\n${line}` : '';
}

// ── Tool surface ──

export const EMAIL_SEARCH_TOOL: ToolDefinition = {
  name: 'email_search',
  description:
    "[DEFAULT for any 'my email / check email for X' ask] Search EVERY connected mailbox at once (agent + owner, Gmail + Outlook), results labeled by source and merged most-recent-first. Use gmail_search / outlook_search / user_gmail_search / user_outlook_search only when the user names one specific mailbox. There is no `account` parameter here (the merged view spans every mailbox); the per-mailbox tools take one.",
  input_schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'What to search for across all mailboxes (sender, subject keyword, or phrase).',
      },
      days: {
        type: 'number',
        description: 'How far back to search, in days (default 30). Applied as a per-mailbox recency bound.',
      },
      limit: {
        type: 'number',
        description: 'Max results per mailbox (default 5). Total results scale with the number of connected mailboxes.',
      },
    },
    required: ['query'],
  },
  concurrency: 'safe',
  maxResultTokens: 6000,
};

export const unifiedToolDefinitions: ToolDefinition[] = [EMAIL_SEARCH_TOOL];

// Register with the v2 partitioner / cap registry at module load (same path the
// Google/Microsoft tool files use). email_search is a pure read, safe to run in
// the same parallel batch as the other read tools.
registerConcurrency('email_search', 'safe');
registerMaxResultTokens('email_search', 6000);
