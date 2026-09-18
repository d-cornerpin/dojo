import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AccessGrants, AgentDetail, IntegrationLevel } from '@dojo/shared';
import { ACCESS_CHANNELS } from '@dojo/shared';
import * as api from '../lib/api';
import type { AccessCatalog } from '../lib/api';
import { useToast } from '../hooks/useToast';
import { TechniqueSelector } from './TechniqueSelector';
import { CollapseToggle, usePanelCollapse } from './CollapseToggle';
import { Check, Choice, Item, Row, Toggle, splitLabel } from './AccessControls';
import { KnowsManifestItem, ManageManifestItems, ReachManifestItems } from './AccessManifest';
import {
  accountLevel, categoryChecked, clone, credentialsGranted, grantsPatch, hasMaster, inertChannels,
  isDirty, mailWriteWithoutSend, masterOn, setAccountLevel, setCategory, setChannelTier, setCredentials, setKindLevel,
  setMaster, setPlaud, setTechnique, setTechniqueAccess, setToolMode, techniqueAccessOn,
  techniqueChecked, toolMode, type AccountRow, type Provider, type ToolMode,
} from '../lib/access-edits';
import { CHANNEL_LABEL, accessDigest, knowsSummary, reachSummary, talkSummary, toolsSummary } from '../lib/access-summary';
import {
  buildLegacyAccess, legacyDirty, legacyReachSummary, manageSummary, readLegacyAccess, type LegacyAccess,
} from '../lib/manifest-edits';

// ════════════════════════════════════════════════════════════════════════════
// THE ACCESS PANEL — the owner's one door onto what an agent may do.
//
// A1 built the object and the walls, A2 built the door a MODEL grants through.
// This is the door the OWNER grants through, and until it existed the whole
// phase was invisible to the person it is for.
//
// ── A6: ONE PANEL, FIVE PLAIN QUESTIONS ──
// The card opens COLLAPSED with a one-line digest of the agent's setup on its
// header, derived from the stored object. Inside it are five folded rows, each a
// question a person would actually ask:
//
//   What it can do       the tool-group selector (full, or one group at a time)
//   What it can reach    Plaud, the connected mail/calendar accounts, the web,
//                        programs on this Mac, the key store
//   Who it can talk to   the channels, under the one switch that governs them
//   What it knows        techniques, and whether it knows who you are
//   What it may manage   your files, this Mac, and the agents it creates
//
// THE LAST TWO ROWS ARE WHERE THE AGENT EDITOR'S "PERMISSIONS" CARD WENT. That
// card is deleted: two cards answering overlapping questions, neither of which
// mentioned the other, is the drift this overhaul exists to end. What moved is
// the CONTROL — the storage is untouched, and `lib/manifest-edits.ts` is held to
// producing the same document the old card produced.
//
// ── THE LANGUAGE RULE ──
// Nothing on this card speaks the dojo's internal language. There is no rank
// name on screen: an agent with no switch of its own is described by what that
// means — it talks through your main agent — because that is the sentence the
// owner can act on.
//
// WHAT IT DOES NOT DO: it does not compute access. Every control is a field of
// an object a door already reads, it saves through A2's resolver, and the audit
// row is written by the route. The panel owns no authority of its own.
// ════════════════════════════════════════════════════════════════════════════

const LEVELS: Array<{ value: IntegrationLevel; label: string }> = [
  { value: 'none', label: 'No access' },
  { value: 'read', label: 'Read' },
  { value: 'full', label: 'Read & write' },
];

const PROVIDER_LABEL: Record<Provider, string> = { google: 'Google', microsoft: 'Microsoft' };

/** An account row's plain name: whose account it is, and which one. */
const accountName = (provider: Provider, row: { kind: 'agent' | 'user'; email: string | null; id: string }): string =>
  `${row.kind === 'user' ? 'Your' : 'The dojo’s'} ${PROVIDER_LABEL[provider]} account (${row.email ?? row.id})`;

export const AccessPanel = ({ agent, onUpdated, manifestEditable, manifestNote }: {
  agent: AgentDetail;
  onUpdated: () => void;
  /** False for the platform's own agents, whose file/command/system settings the
   *  dojo sets. The PARENT decides this: the panel never reads a rank. */
  manifestEditable: boolean;
  manifestNote: string;
}) => {
  const toast = useToast();
  const stored = agent.effectiveGrants ?? null;
  const [draft, setDraft] = useState<AccessGrants | null>(stored ? clone(stored) : null);
  const [catalog, setCatalog] = useState<AccessCatalog | null>(null);
  const [google, setGoogle] = useState<AccountRow[]>([]);
  const [microsoft, setMicrosoft] = useState<AccountRow[]>([]);
  const [saving, setSaving] = useState(false);

  // The legacy half, read once into the same shape the old card kept in twenty
  // hooks. `storedLegacy` is what arrived; `legacy` is the draft.
  const storedLegacy = useMemo(
    () => readLegacyAccess(
      agent.permissions,
      agent.toolsPolicy ?? undefined,
      (agent.config as Record<string, unknown>)?.shareUserProfile === true,
    ),
    [agent.permissions, agent.toolsPolicy, agent.config],
  );
  const [legacy, setLegacy] = useState<LegacyAccess>(storedLegacy);
  useEffect(() => { setLegacy(storedLegacy); }, [storedLegacy]);

  // The dashboard's one collapse idiom, with the default the owner wants: the
  // card AND every row inside it open folded. The key is per-panel rather than
  // per-agent — "I keep this shut" is a fact about the owner.
  const { isCollapsed, toggle } = usePanelCollapse('agent.access.collapse', true);
  const collapsed = isCollapsed('access');

  useEffect(() => { setDraft(agent.effectiveGrants ? clone(agent.effectiveGrants) : null); }, [agent.effectiveGrants]);

  useEffect(() => {
    const load = async () => {
      const [cat, g, m] = await Promise.all([
        api.getAccessCatalog(),
        api.request<{ accounts: AccountRow[] }>('/google/status'),
        api.request<{ accounts: AccountRow[] }>('/microsoft/status'),
      ]);
      if (cat.ok) setCatalog(cat.data);
      if (g.ok) setGoogle((g.data.accounts ?? []).filter((a) => a.connected));
      if (m.ok) setMicrosoft((m.data.accounts ?? []).filter((a) => a.connected));
    };
    load();
  }, []);

  const labels = useMemo(() => (catalog?.categories ?? []).map((c) => c.label), [catalog]);
  const techniqueCatalog = useMemo(() => catalog?.techniques ?? [], [catalog]);
  const techniqueIds = useMemo(() => techniqueCatalog.map((t) => t.id), [techniqueCatalog]);
  const grantedTechniqueIds = useMemo(
    () => (draft ? techniqueIds.filter((id) => techniqueChecked(draft, id)) : []),
    [draft, techniqueIds],
  );
  const edit = useCallback((next: AccessGrants) => setDraft(next), []);

  // ONE SAVE, ONE PUT. The grants half rides A2's validated `grants` body; the
  // folded half rides the same `permissions` / `toolsPolicy` / `config` fields
  // the deleted card used. Each is sent ONLY if it moved, so a save that touches
  // one half never rewrites the other and never writes an audit row for it.
  const save = async () => {
    if (!stored || !draft) return;
    const patch = grantsPatch(stored, draft);
    const legacyMoved = manifestEditable && legacyDirty(storedLegacy, legacy);
    if (Object.keys(patch).length === 0 && !legacyMoved) return;
    const body: Record<string, unknown> = {};
    if (Object.keys(patch).length > 0) body.grants = patch;
    if (legacyMoved) {
      const built = buildLegacyAccess(legacy);
      body.permissions = built.permissions;
      body.toolsPolicy = built.toolsPolicy;
      body.config = { shareUserProfile: built.shareUserProfile };
    }
    setSaving(true);
    const result = await api.updateAgentConfig(agent.id, body);
    setSaving(false);
    if (result.ok) { toast.success('Access saved'); onUpdated(); }
    else { toast.error(result.error || 'Could not save access.'); }
  };

  // ONE header, drawn in every state, with the chevron always reachable — so the
  // card can be opened while it is still loading and shut again from anywhere.
  const dirty = stored && draft ? isDirty(stored, draft) || (manifestEditable && legacyDirty(storedLegacy, legacy)) : false;
  const header = (
    <div className="acx-head">
      <div className="acx-head__body">
        <div className="scard__title">Access</div>
        <div className="scard__desc">
          {!stored || !draft
            ? 'Loading this agent’s access…'
            : collapsed
              ? `${accessDigest(stored, { runsPrograms: storedLegacy.execOn })}${dirty ? ' · unsaved changes' : ''}`
              : `Everything ${agent.name} may reach is denied unless you grant it here. Changes apply when you press Save.`}
        </div>
      </div>
      <CollapseToggle collapsed={collapsed} onClick={() => toggle('access')} label="Access" />
    </div>
  );

  if (collapsed || !stored || !draft) return <div className="tile acx">{header}</div>;

  const master = hasMaster(draft);
  const on = masterOn(draft);
  const mode = toolMode(draft);
  const inert = inertChannels(draft, catalog?.channelGroups ?? {});
  const reach = legacyReachSummary(legacy);
  const row = (key: string) => ({ collapsed: isCollapsed(key), onToggle: () => toggle(key) });

  const accountRows = (provider: Provider, rows: AccountRow[]) => (
    rows.length > 0
      ? rows.map((r) => {
        const level = accountLevel(draft, provider, r);
        return (
          <Item
            key={r.id}
            name={accountName(provider, r)}
            help={level === 'none' ? 'Not granted.' : undefined}
            control={(
              <Toggle
                label={accountName(provider, r)}
                on={level !== 'none'}
                onChange={(v) => edit(setAccountLevel(draft, provider, r, v ? 'read' : 'none', rows))}
              />
            )}
          >
            {level !== 'none' && (
              <Choice
                label="How much of it"
                value={level}
                options={LEVELS.filter((l) => l.value !== 'none').map((l) => ({ v: l.value, l: l.label }))}
                onChange={(v) => edit(setAccountLevel(draft, provider, r, v, rows))}
              />
            )}
          </Item>
        );
      })
      : (['agent', 'user'] as const).map((kind) => (
        <Item
          key={kind}
          name={`${kind === 'user' ? 'Your' : 'The dojo’s'} ${PROVIDER_LABEL[provider]} account`}
          help="Nothing is connected yet — this applies once one is."
          control={(
            <select
              className="finput field--select acx-level"
              aria-label={`${PROVIDER_LABEL[provider]} ${kind === 'user' ? 'your' : 'dojo'} account access`}
              value={draft.integrations[provider][kind]}
              onChange={(e) => edit(setKindLevel(draft, provider, kind, e.target.value as IntegrationLevel))}
            >
              {LEVELS.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
            </select>
          )}
        />
      ))
  );

  return (
    <div className="tile acx">
      {header}

      {/* ── Presets ── */}
      <div className="acx-presets">
        {(catalog?.presets ?? []).map((p) => (
          <button
            key={p.id}
            type="button"
            className="btn btn--sm"
            title={p.description}
            onClick={() => edit({ ...clone(p.grants), channels: master ? clone(p.grants).channels : draft.channels })}
          >
            {p.label}
          </button>
        ))}
      </div>
      <div className="fhelp">A profile fills the boxes below. Nothing is saved until you press Save.</div>

      {/* ── 1 ── */}
      <Row question="What it can do" state={toolsSummary(draft)} {...row('do')}>
        <Choice<ToolMode>
          label="How many tools"
          value={mode}
          options={[{ v: 'full', l: 'Full tool access' }, { v: 'individual', l: 'Individual tool access' }]}
          onChange={(v) => edit(setToolMode(draft, v, labels))}
        />
        <div className="fhelp">
          {mode === 'full'
            ? 'Every tool group, including ones added by future updates.'
            : 'Only the groups ticked below — untick what this agent should not have.'}
        </div>
        {toolMode(draft) === 'individual' && (
          <div className="acx-grid">
            {(catalog?.categories ?? []).map((cat) => {
              const { name, hint } = splitLabel(cat.label);
              return (
                <Check
                  key={cat.label}
                  label={name}
                  hint={hint ?? `${cat.tools} tool${cat.tools === 1 ? '' : 's'}`}
                  checked={categoryChecked(draft, cat.label)}
                  onChange={(v) => edit(setCategory(draft, cat.label, v, labels))}
                />
              );
            })}
          </div>
        )}
      </Row>

      {/* ── 2 ── */}
      <Row question="What it can reach" state={reachSummary(draft, reach)} {...row('reach')}>
        <Item
          name="Plaud recordings"
          help="Transcripts and summaries from your voice recorder."
          control={<Toggle label="Plaud recordings" on={draft.integrations.plaud} onChange={(v) => edit(setPlaud(draft, v))} />}
        />
        {accountRows('google', google)}
        {accountRows('microsoft', microsoft)}
        {mailWriteWithoutSend(draft).map((w) => (
          <div className="note--warn" key={w.provider} style={{ marginTop: 10, marginBottom: 0 }}>
            {PROVIDER_LABEL[w.provider]} is granted read &amp; write, but the agent cannot send mail from it
            — {w.missing === 'master' ? '“Can talk to people” is off' : 'Email is off under “Can talk to people”'}.
            Reading and drafts still work: it can leave a finished message in your Drafts folder for you
            to send. To let it send for itself, turn on{' '}
            {w.missing === 'master' ? '“Can talk to people” → Email' : 'Email'} below.
          </div>
        ))}
        <ReachManifestItems state={legacy} onChange={setLegacy} editable={manifestEditable} note={manifestNote} />
        <Item
          name="Use stored keys & logins"
          help="Read, add, change and delete anything in your key store."
          risk
          control={(
            <Toggle
              label="Use stored keys & logins"
              on={credentialsGranted(draft)}
              onChange={(v) => edit(setCredentials(draft, v))}
            />
          )}
        />
      </Row>

      {/* ── 3 ── */}
      <Row question="Who it can talk to" state={talkSummary(draft)} {...row('talk')}>
        {master ? (
          <>
            <Item
              name="Can talk to people"
              help="Nothing below works until this is on."
              control={<Toggle label="Can talk to people" on={on} onChange={(v) => edit(setMaster(draft, v))} />}
            />
            {on && (
              <div className="acx-children">
                {ACCESS_CHANNELS.map((channel) => (
                  <Item
                    key={channel}
                    name={CHANNEL_LABEL[channel]}
                    control={(
                      <Toggle
                        label={CHANNEL_LABEL[channel]}
                        on={draft.channels[channel] !== 'none'}
                        onChange={(v) => edit(setChannelTier(draft, channel, v ? 'owner' : 'none'))}
                      />
                    )}
                  >
                    {draft.channels[channel] !== 'none' && (
                      <Choice<'owner' | 'all'>
                        label={`Who it may reach on ${CHANNEL_LABEL[channel]}`}
                        value={draft.channels[channel] as 'owner' | 'all'}
                        options={[{ v: 'owner', l: 'Only you' }, { v: 'all', l: 'Anyone approved' }]}
                        onChange={(v) => edit(setChannelTier(draft, channel, v))}
                      />
                    )}
                  </Item>
                ))}
              </div>
            )}
            {!on && <div className="fhelp">This agent cannot reach a person at all. Turn it on to choose how.</div>}
            {on && inert.map((r) => (
              <div className="note--warn" key={r.channel} style={{ marginTop: 10, marginBottom: 0 }}>
                {CHANNEL_LABEL[r.channel]} is granted, but the “{splitLabel(r.groups[0]).name}” tool group is
                not — the agent would be refused when it tried. Tick that group above.
              </div>
            ))}
          </>
        ) : (
          <div className="note--warn" style={{ marginBottom: 0 }}>
            This is a helper agent that talks through your main agent, so it has no switch of its own.
            Everything else here is still yours to set.
          </div>
        )}
      </Row>

      {/* ── 4 ──
          The techniques half is two honest halves: the GRANT (may run — the
          index, the matcher that would otherwise inject a body unasked, and the
          door), saved with the panel, and the PRE-LOAD (equipping), which saves
          on change as it always did. The grant list gates the equip list on
          screen exactly as the renderer gates it on the server, because
          equipping something ungranted loads nothing. */}
      <Row question="What it knows" state={knowsSummary(draft, legacy.shareProfile)} {...row('knows')}>
        <KnowsManifestItem state={legacy} onChange={setLegacy} editable={manifestEditable} note={manifestNote} />
        {techniqueCatalog.length === 0 ? (
          <div className="fhelp">No published techniques on this dojo yet. Publish one and it will appear here.</div>
        ) : (
          <>
            <Item
              name="Can use techniques"
              help="Step-by-step procedures it may follow when a task matches one."
              control={(
                <Toggle
                  label="Can use techniques"
                  on={techniqueAccessOn(draft)}
                  onChange={(v) => edit(setTechniqueAccess(draft, v, techniqueIds))}
                />
              )}
            />
            {techniqueAccessOn(draft) ? (
              <div className="acx-children">
                <div className="acx-grid">
                  {techniqueCatalog.map((t) => (
                    <Check
                      key={t.id}
                      label={t.name}
                      checked={techniqueChecked(draft, t.id)}
                      onChange={(v) => edit(setTechnique(draft, t.id, v, techniqueIds))}
                    />
                  ))}
                </div>
                <div className="acx-sub">
                  <div className="acx-sub__title">Always in its head</div>
                  <TechniqueSelector
                    selected={(agent.equippedTechniques ?? []).filter((id) => techniqueChecked(draft, id))}
                    only={grantedTechniqueIds}
                    onChange={async (updated) => {
                      const result = await api.updateAgentConfig(agent.id, { equippedTechniques: updated } as Record<string, unknown>);
                      if (result.ok) { toast.success('Techniques updated'); onUpdated(); }
                      else { toast.error(result.error || 'Could not update techniques.'); }
                    }}
                  />
                  <div className="fhelp">These are pasted into every turn, and save as soon as you change them.</div>
                </div>
              </div>
            ) : (
              <div className="fhelp">This agent may run no techniques. Turn it on to choose which.</div>
            )}
          </>
        )}
      </Row>

      {/* ── 5 ── */}
      <Row
        question="What it may manage"
        state={manifestEditable ? manageSummary(legacy) : 'Set by the dojo'}
        {...row('manage')}
      >
        <ManageManifestItems state={legacy} onChange={setLegacy} editable={manifestEditable} note={manifestNote} />
      </Row>

      <div className="srow" style={{ justifyContent: 'flex-end', marginTop: 16, gap: 8 }}>
        <button
          type="button"
          className="btn btn--sm"
          disabled={!dirty || saving}
          onClick={() => { setDraft(clone(stored)); setLegacy(storedLegacy); }}
        >
          Reset
        </button>
        <button type="button" className="btn btn--primary btn--sm" disabled={!dirty || saving} onClick={save}>
          {saving ? 'Saving…' : 'Save access'}
        </button>
      </div>
    </div>
  );
};
