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

import type { ToolDefinition } from '../agent/tools/types.js';
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
  // `emptySurfaces` (F4 coverage floor, 2026-07-08): the connected calendars that
  // were checked and held NOTHING in this window. Enumerated so the "across N
  // connected calendars" claim is verifiable — a reader can see which of the N
  // were swept and came back empty, instead of empty being indistinguishable
  // from never-checked.
  opts: { days: number; accountCount: number; emptySurfaces?: UnifiedSource[] },
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
  const empty = opts.emptySurfaces ?? [];
  if (empty.length > 0) {
    lines.push('');
    lines.push(`Empty in this window: ${empty.map(s => formatSourceLabel(s, ambiguous)).join(', ')}`);
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
  // `emptySurfaces` (F4 coverage floor, 2026-07-08): the connected mailboxes that
  // were searched and matched NOTHING. Enumerated so "across N connected
  // mailboxes" is verifiable — the reader sees which of the N were swept clean
  // rather than empty reading the same as never-checked.
  opts: { query: string; accountCount: number; emptySurfaces?: UnifiedSource[] },
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
  const empty = opts.emptySurfaces ?? [];
  if (empty.length > 0) {
    lines.push('');
    lines.push(`Empty in this window: ${empty.map(s => formatSourceLabel(s, ambiguous)).join(', ')}`);
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
 * so a single-surface answer never reads as the whole day.
 *
 * Coverage floor (2026-07-08): honest SILENCE for an empty surface was the wrong
 * call — the owner could not tell "checked, nothing there" from "never checked".
 * So the block now ACCOUNTS for every OTHER connected calendar the fan-out
 * touched:
 *   • surfaces WITH events keep their data lines (capped at `cap`; on overflow a
 *     pointer to the merged tool replaces the tail);
 *   • surfaces checked and EMPTY are named on one compact "Also checked, nothing
 *     in this window" line (the sweep is visible even when it found nothing);
 *   • surfaces whose fetch FAILED are itemized separately as "could not check"
 *     so a failure never masquerades as checked-empty.
 * Returns '' only when there was genuinely nothing to report (no rows, no empty,
 * no failures — i.e. no other surface at all). Pure.
 */
export function renderOtherCalendarsSection(
  rows: OtherCalendarRow[],
  ambiguous: Set<string>,
  opts: { emptySurfaces?: UnifiedSource[]; failed?: AccountFailure[]; cap?: number } = {},
): string {
  const cap = opts.cap ?? 6;
  const empty = opts.emptySurfaces ?? [];
  const failed = opts.failed ?? [];
  const lines: string[] = [];
  if (rows.length > 0) {
    lines.push('Also on other connected calendars (not shown above):');
    for (const r of rows.slice(0, cap)) {
      lines.push(`- ${r.title}, ${r.when} ${formatSourceLabel(r.source, ambiguous)}`);
    }
    if (rows.length > cap) lines.push('(call calendar_agenda for the fully merged view)');
  }
  if (empty.length > 0) {
    lines.push(`Also checked, nothing in this window: ${empty.map(s => formatSourceLabel(s, ambiguous)).join(', ')}`);
  }
  for (const f of failed) {
    lines.push(`could not check: ${f.label} (${f.error})`);
  }
  return lines.join('\n');
}

export interface MailboxCount {
  source: UnifiedSource;
  count: number;
}

/**
 * "Also matching / checked elsewhere" block for a NARROW mail search.
 *
 * Coverage floor (2026-07-08): honest silence for an empty mailbox hid the sweep
 * — the owner could not tell "checked, no matches" from "never checked". So every
 * OTHER connected mailbox the fan-out queried is now accounted for:
 *   • mailboxes WITH matches get a count on the "Also matching" line;
 *   • mailboxes checked with NO match are named on a "No matches in" line;
 *   • a mailbox whose query FAILED is itemized as "could not check" so a failure
 *     is never mistaken for checked-empty.
 * Returns '' only when there was no other mailbox to report at all. Pure.
 */
export function renderOtherMailboxesCount(
  counts: MailboxCount[],
  ambiguous: Set<string>,
  opts: { emptySurfaces?: UnifiedSource[]; failed?: AccountFailure[] } = {},
): string {
  const empty = opts.emptySurfaces ?? [];
  const failed = opts.failed ?? [];
  const nonzero = counts.filter(c => c.count > 0);
  const lines: string[] = [];
  if (nonzero.length > 0) {
    const parts = nonzero.map(c => `${c.count} in ${formatSourceLabel(c.source, ambiguous)}`);
    lines.push(`Also matching in other connected mailboxes: ${parts.join(', ')}. Call email_search to see them together.`);
  }
  if (empty.length > 0) {
    lines.push(`No matches in: ${empty.map(s => formatSourceLabel(s, ambiguous)).join(', ')}`);
  }
  for (const f of failed) {
    lines.push(`could not check: ${f.label} (${f.error})`);
  }
  return lines.join('\n');
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
  const emptySurfaces: UnifiedSource[] = [];
  const collected: UnifiedCalendarItem[] = [];

  // Fetch in parallel but CLASSIFY in a deterministic second pass (account
  // enumeration order), so the empty-surface enumeration below is stable rather
  // than in fetch-completion order.
  const results = await Promise.all(
    accounts.map(async (acc) => {
      try {
        const res =
          acc.provider === 'google'
            ? await fetchAgendaItemsForAccount(acc.accountId, window, tz, agentId, agentName, { days })
            : await fetchAgendaItemsForAccountMs(acc.accountId, window, agentId, agentName, { days });
        return { acc, res };
      } catch (err) {
        return { acc, res: { ok: false as const, error: err instanceof Error ? err.message : String(err) } };
      }
    }),
  );

  for (const { acc, res } of results) {
    if (!res.ok) {
      failures.push({ label: acc.label, error: res.error });
      continue;
    }
    if (res.items.length === 0) {
      emptySurfaces.push(acc.source); // checked, nothing in this window
      continue;
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
  }

  const merged = dedupCalendarItems(mergeCalendarChronologically(collected));
  const ambiguous = computeAmbiguousLabels(accounts.map(a => a.source));
  return renderCalendarAgenda(merged, ambiguous, failures, { days, accountCount: accounts.length, emptySurfaces });
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
  const emptySurfaces: UnifiedSource[] = [];
  const collected: UnifiedMailItem[] = [];

  // Fetch in parallel; CLASSIFY in a deterministic second pass (enumeration
  // order) so the empty-surface enumeration is stable, not fetch-completion order.
  const results = await Promise.all(
    accounts.map(async (acc) => {
      try {
        if (acc.provider === 'google') {
          // Gmail understands `newer_than:Nd` as a recency bound in the query.
          const gq = days > 0 ? `${query} newer_than:${days}d` : query;
          const res = await searchMailForAccount(acc.accountId, gq, limit, agentId, agentName);
          return { acc, res: res.ok ? { ok: true as const, items: res.items } : res };
        }
        const res = await searchMailForAccountMs(acc.accountId, query, limit, agentId, agentName);
        return { acc, res };
      } catch (err) {
        return { acc, res: { ok: false as const, error: err instanceof Error ? err.message : String(err) } };
      }
    }),
  );

  for (const { acc, res } of results) {
    if (!res.ok) {
      failures.push({ label: acc.label, error: res.error });
      continue;
    }
    if (res.items.length === 0) {
      emptySurfaces.push(acc.source); // searched, matched nothing
      continue;
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

  const merged = mergeMailByRecency(collected);
  const ambiguous = computeAmbiguousLabels(accounts.map(a => a.source));
  return renderEmailSearch(merged, ambiguous, failures, { query, accountCount: accounts.length, emptySurfaces });
}

// ── Narrow-tool DATA-floor orchestrators (impure; fan out over OTHER surfaces) ──
//
// Called by the NARROW agenda/mail cases in the provider files (via dynamic
// import, keeping the static graph one-way). They reuse the SAME enumeration +
// per-account fetch helpers the merged executors above use, excluding the one
// account the narrow tool already read. A narrow answer is never SUNK or delayed
// by another surface (each fetch is parallel and its own failure is caught), but
// per the coverage floor (2026-07-08) a per-surface failure is no longer silently
// swallowed: it is reported as a distinct "could not check" line so it cannot
// masquerade as checked-empty. The ambiguity set is computed over ALL surfaces
// (including the one already read) so a slot+provider with two accounts still
// disambiguates the OTHER one by email.

/**
 * Compact "also on other calendars" block for a NARROW agenda read. `exclude` is
 * the account the narrow tool already rendered (by provider + row id); every
 * OTHER connected calendar is fetched for the SAME window in parallel. Coverage
 * floor: the returned block accounts for EVERY other connected calendar — ones
 * with events (data lines), ones checked-and-empty (an enumerated line), and ones
 * that failed to fetch (a "could not check" line). Returns '' only when there is
 * no other connected calendar at all (leading newlines included only when
 * non-empty).
 */
export async function otherCalendarsAgendaSection(
  exclude: { provider: 'google' | 'microsoft'; accountId: string },
  window: { startISO: string; endISO: string; anchored: boolean },
  tz: string,
  days: number,
  agentId: string,
  agentName: string,
): Promise<string> {
  const all = await enumerateAccounts('calendar');
  const accounts = all.filter(
    a => !(a.provider === exclude.provider && a.accountId === exclude.accountId),
  );
  if (accounts.length === 0) return '';

  const { fetchAgendaItemsForAccount } = await import('../google/tools-read.js');
  const { fetchAgendaItemsForAccountMs } = await import('../microsoft/tools-read.js');

  const results = await Promise.all(
    accounts.map(async (acc) => {
      try {
        const res =
          acc.provider === 'google'
            ? await fetchAgendaItemsForAccount(acc.accountId, window, tz, agentId, agentName, { days })
            : await fetchAgendaItemsForAccountMs(acc.accountId, window, agentId, agentName, { days });
        return { acc, res };
      } catch (err) {
        return { acc, res: { ok: false as const, error: err instanceof Error ? err.message : String(err) } };
      }
    }),
  );

  const collected: Array<{ row: OtherCalendarRow; sortKey: number }> = [];
  const emptySurfaces: UnifiedSource[] = [];
  const failed: AccountFailure[] = [];
  for (const { acc, res } of results) {
    if (!res.ok) {
      failed.push({ label: acc.label, error: res.error });
      continue;
    }
    if (res.items.length === 0) {
      emptySurfaces.push(acc.source);
      continue;
    }
    for (const it of res.items) {
      collected.push({
        row: { title: it.title, when: compactEventTime(it.start, tz, it.allDay), source: acc.source },
        sortKey: it.start ? it.start.getTime() : Number.MAX_SAFE_INTEGER,
      });
    }
  }

  collected.sort((a, b) => a.sortKey - b.sortKey);
  // Ambiguity over ALL surfaces (including the one already read) so a two-account
  // slot+provider still disambiguates the OTHER account by email.
  const ambiguous = computeAmbiguousLabels(all.map(a => a.source));
  const section = renderOtherCalendarsSection(collected.map(c => c.row), ambiguous, { emptySurfaces, failed });
  return section ? `\n\n${section}` : '';
}

/**
 * "Also matching / checked in other mailboxes" block for a NARROW mail search.
 * Runs the SAME query against every OTHER connected mailbox (small per-mailbox
 * cap). Coverage floor: accounts for EVERY other connected mailbox — ones with
 * matches (a count), ones checked with none (an enumerated "No matches in" line),
 * and ones that failed (a "could not check" line). `days > 0` applies a Gmail
 * recency bound; pass 0 to mirror an unbounded narrow search. Returns '' only
 * when there is no other connected mailbox at all.
 */
export async function otherMailboxesCountSection(
  exclude: { provider: 'google' | 'microsoft'; accountId: string },
  query: string,
  days: number,
  agentId: string,
  agentName: string,
): Promise<string> {
  const all = await enumerateAccounts('mail');
  const accounts = all.filter(
    a => !(a.provider === exclude.provider && a.accountId === exclude.accountId),
  );
  if (accounts.length === 0) return '';

  const { searchMailForAccount } = await import('../google/tools-read.js');
  const { searchMailForAccountMs } = await import('../microsoft/tools-read.js');
  const perMailboxLimit = 5;

  const results = await Promise.all(
    accounts.map(async (acc) => {
      try {
        if (acc.provider === 'google') {
          const gq = days > 0 ? `${query} newer_than:${days}d` : query;
          const res = await searchMailForAccount(acc.accountId, gq, perMailboxLimit, agentId, agentName);
          return { acc, count: res.ok ? res.total : null, error: res.ok ? null : res.error };
        }
        const res = await searchMailForAccountMs(acc.accountId, query, perMailboxLimit, agentId, agentName);
        return { acc, count: res.ok ? res.items.length : null, error: res.ok ? null : res.error };
      } catch (err) {
        return { acc, count: null, error: err instanceof Error ? err.message : String(err) };
      }
    }),
  );

  const counts: MailboxCount[] = [];
  const emptySurfaces: UnifiedSource[] = [];
  const failed: AccountFailure[] = [];
  for (const r of results) {
    if (r.count === null) {
      failed.push({ label: r.acc.label, error: r.error ?? 'unknown error' });
      continue;
    }
    if (r.count > 0) counts.push({ source: r.acc.source, count: r.count });
    else emptySurfaces.push(r.acc.source);
  }

  // Ambiguity over ALL surfaces (including the one already read) so a two-account
  // slot+provider still disambiguates the OTHER account by email.
  const ambiguous = computeAmbiguousLabels(all.map(a => a.source));
  const line = renderOtherMailboxesCount(counts, ambiguous, { emptySurfaces, failed });
  return line ? `\n\n${line}` : '';
}

// ── Tool surface ──

export const EMAIL_SEARCH_TOOL: ToolDefinition = {
  name: 'email_search',
  description:
    "[DEFAULT for any 'my email / check email for X' ask] Search EVERY connected mailbox at once (agent + owner, Gmail + Outlook), results labeled by source and merged most-recent-first. Use gmail_search / outlook_search / user_gmail_search / user_outlook_search only when the user names one specific mailbox. There is no `account` parameter here (the merged view spans every mailbox); the per-mailbox tools take one.",
  effects: [],
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
