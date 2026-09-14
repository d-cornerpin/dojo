import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AccessChannel, AccessGrants, AgentDetail, IntegrationLevel } from '@dojo/shared';
import { ACCESS_CHANNELS, channelTierOf } from '@dojo/shared';
import * as api from '../lib/api';
import type { AccessCatalog } from '../lib/api';
import { useToast } from '../hooks/useToast';
import { TechniqueSelector } from './TechniqueSelector';
import { CollapseToggle, usePanelCollapse } from './CollapseToggle';
import {
  accountLevel, categoryChecked, clone, credentialsGranted, grantsPatch, hasMaster, inertChannels,
  isDirty, masterOn, setAccountLevel, setCategory, setChannelTier, setCredentials, setKindLevel,
  setMaster, setPlaud, setTechnique, setTechniqueAccess, setToolMode, techniqueAccessOn,
  techniqueChecked, toolMode,
  type AccountRow, type Provider, type ToolMode,
} from '../lib/access-edits';

// ════════════════════════════════════════════════════════════════════════════
// THE ACCESS PANEL (UX-ACCESS A3, simplified by the owner's orders in A5) —
// the owner's door onto the grants object.
//
// A1 built the object and the walls, A2 built the door a MODEL grants through.
// This is the door the OWNER grants through, and until it existed the whole
// phase was invisible to the person it is for: `effectiveGrants` rode
// `GET /agents/:id` with no reader and the validated `grants` body on
// `PUT /agents/:id` had no caller.
//
// FOUR SECTIONS, from the plan: tools · integrations (per-account for the
// mail/calendar providers — the work-vs-personal split) · channels · techniques.
//
// ── A5: ONE SHAPE FOR ALL FOUR — A SWITCH, AND WHAT IT GOVERNS ──
// The card opens COLLAPSED (it is the tallest thing on the agent editor), and
// inside it every section is a switch whose children appear only when it is on:
//   TOOLS        "Full tool access" / "Individual tool access"; the 38 group
//                boxes render under the second, pre-filled from what the agent
//                already holds so a mode flip can never narrow by accident.
//   CREDENTIALS  one toggle. The per-credential rows are gone AND SO IS THE
//                PER-CREDENTIAL MODEL — `integrations.credentials` is a boolean,
//                so this control is the whole truth about the field.
//   CHANNELS     the children are hidden under a `false` master rather than
//                drawn disabled, and flipping it on defaults them to "Only me".
//   TECHNIQUES   a "Technique access" switch over the published list.
//
// WHAT IT DOES NOT DO: it does not compute access. Every control is a field of
// the object the doors already read, it is saved through A2's resolver, and the
// audit row is written by the route. The panel owns no authority of its own —
// which is why a preset can be a plain object and a save can be a patch.
// ════════════════════════════════════════════════════════════════════════════

const LEVELS: Array<{ value: IntegrationLevel; label: string }> = [
  { value: 'none', label: 'No access' },
  { value: 'read', label: 'Read' },
  { value: 'full', label: 'Read & write' },
];

const CHANNEL_LABEL: Record<AccessChannel, string> = {
  imessage: 'iMessage', sms: 'Text message (SMS)', voice: 'Phone calls', email: 'Email', teams: 'Microsoft Teams',
};

/** The long index labels carry a parenthetical for the prompt; the checkbox
 *  shows the name and the parenthetical becomes its hint. */
const splitLabel = (label: string): { name: string; hint: string | null } => {
  const at = label.indexOf(' (');
  return at === -1 ? { name: label, hint: null } : { name: label.slice(0, at), hint: label.slice(at + 2, -1) };
};

const Check = ({ label, hint, checked, onChange, disabled }: {
  label: string; hint?: string | null; checked: boolean; disabled?: boolean; onChange: (v: boolean) => void;
}) => (
  <label className={`acx-check${disabled ? ' is-disabled' : ''}`}>
    <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
    <span className="acx-check__body">
      <span className="acx-check__name">{label}</span>
      {hint && <span className="acx-check__hint">{hint}</span>}
    </span>
  </label>
);

/** A two-option radio group. One component for the tool MODE and the channel
 *  TIER, because they are the same control and a second copy would drift. */
const Choice = <T extends string>({ value, options, onChange }: {
  value: T; options: Array<{ v: T; l: string }>; onChange: (v: T) => void;
}) => (
  <div className="acx-tier" role="radiogroup">
    {options.map((o) => (
      <button
        key={o.v}
        type="button"
        role="radio"
        aria-checked={value === o.v}
        className={`acx-tier__opt${value === o.v ? ' is-on' : ''}`}
        onClick={() => onChange(o.v)}
      >
        {o.l}
      </button>
    ))}
  </div>
);

/** The master-style switch a section header carries. */
const Switch = ({ id, label, on, onChange }: {
  id: string; label: string; on: boolean; onChange: (v: boolean) => void;
}) => (
  <div className="acx-master">
    <label className="flabel" htmlFor={id} style={{ marginBottom: 0 }}>{label}</label>
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      className={`switch ${on ? 'is-on' : ''}`}
      onClick={() => onChange(!on)}
    />
  </div>
);

const Section = ({ title, desc, children }: { title: string; desc: string; children: React.ReactNode }) => (
  <section className="acx-section">
    <h4 className="acx-section__title">{title}</h4>
    <p className="acx-section__desc">{desc}</p>
    {children}
  </section>
);

/** One line for the folded card. Built from the STORED object, never the draft,
 *  so a shut card never reports an unsaved edit as if it had been saved. */
const summarize = (g: AccessGrants): string => {
  const reach = ACCESS_CHANNELS.filter((c) => channelTierOf(g, c) !== 'none').map((c) => CHANNEL_LABEL[c]);
  return [
    g.tools.categories === '*' ? 'all tools' : `${g.tools.categories.length} tool groups`,
    g.channels.master === null ? 'talks through the main agent' : reach.length ? reach.join(', ') : 'reaches no one',
    `credentials ${g.integrations.credentials ? 'on' : 'off'}`,
  ].join(' · ');
};

export const AccessPanel = ({ agent, onUpdated }: { agent: AgentDetail; onUpdated: () => void }) => {
  const toast = useToast();
  const stored = agent.effectiveGrants ?? null;
  const [draft, setDraft] = useState<AccessGrants | null>(stored ? clone(stored) : null);
  const [catalog, setCatalog] = useState<AccessCatalog | null>(null);
  const [google, setGoogle] = useState<AccountRow[]>([]);
  const [microsoft, setMicrosoft] = useState<AccountRow[]>([]);
  const [saving, setSaving] = useState(false);
  // The dashboard's one collapse idiom, asked for with the default the owner
  // wants: this card opens FOLDED. The key is per-panel rather than per-agent —
  // "I keep this card shut" is a fact about the owner, not about an agent.
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

  const save = async () => {
    if (!stored || !draft) return;
    const patch = grantsPatch(stored, draft);
    if (Object.keys(patch).length === 0) return;
    setSaving(true);
    const result = await api.updateAgentConfig(agent.id, { grants: patch });
    setSaving(false);
    if (result.ok) { toast.success('Access saved'); onUpdated(); }
    else { toast.error(result.error || 'Could not save access.'); }
  };

  // ONE header, drawn in every state, with the chevron always reachable — so the
  // card can be opened while it is still loading and shut again from anywhere.
  const header = (
    <div className="acx-head">
      <div className="acx-head__body">
        <div className="scard__title">Access</div>
        <div className="scard__desc">
          {!stored || !draft
            ? 'Loading this agent’s access…'
            : collapsed
              ? `${summarize(stored)}${isDirty(stored, draft) ? ' · unsaved changes' : ''}`
              : `What ${agent.name} may reach: tools, integrations, the people it can talk to, and the techniques it can draw on. Everything here is denied unless you grant it. Changes apply when you press Save.`}
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
  const dirty = isDirty(stored, draft);

  const accountRows = (provider: Provider, rows: AccountRow[]) => (
    rows.length > 0
      ? rows.map((row) => {
        const level = accountLevel(draft, provider, row);
        return (
          <div className="acx-acct" key={row.id}>
            <Check
              label={row.email ?? row.id}
              hint={row.kind === 'agent' ? "the agent's own account" : 'your account'}
              checked={level !== 'none'}
              onChange={(v) => edit(setAccountLevel(draft, provider, row, v ? 'read' : 'none', rows))}
            />
            {level !== 'none' && (
              <Choice
                value={level}
                options={LEVELS.filter((l) => l.value !== 'none').map((l) => ({ v: l.value, l: l.label }))}
                onChange={(v) => edit(setAccountLevel(draft, provider, row, v, rows))}
              />
            )}
          </div>
        );
      })
      : (['agent', 'user'] as const).map((kind) => (
        <div className="acx-acct" key={kind}>
          <span className="acx-check__name">
            {kind === 'agent' ? `The agent's ${provider === 'google' ? 'Google' : 'Microsoft'} account` : `Your ${provider === 'google' ? 'Google' : 'Microsoft'} account`}
          </span>
          <select
            className="finput field--select acx-level"
            aria-label={`${provider} ${kind} access level`}
            value={draft.integrations[provider][kind]}
            onChange={(e) => edit(setKindLevel(draft, provider, kind, e.target.value as IntegrationLevel))}
          >
            {LEVELS.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
          </select>
        </div>
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
      <div className="fhelp">A preset fills the boxes below — nothing is saved until you press Save, so adjust it first.</div>

      {/* ── 1. Tools (A5: a mode, and the groups only under "Individual") ── */}
      <Section title="Tools" desc="Tool groups this agent may use. A tool outside every granted group is refused, even if the model asks for it by name.">
        <Choice<ToolMode>
          value={mode}
          options={[{ v: 'full', l: 'Full tool access' }, { v: 'individual', l: 'Individual tool access' }]}
          onChange={(v) => edit(setToolMode(draft, v, labels))}
        />
        <div className="fhelp">
          {mode === 'full'
            ? 'Every tool group, including groups added by future updates.'
            : 'Only the groups ticked below. Switching from full access starts with everything ticked — untick what this agent should not have.'}
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
      </Section>

      {/* ── 2. Integrations ── */}
      <Section title="Integrations" desc="Connected accounts and stored keys. Mail and calendar are granted per account, so work and personal can differ.">
        <Check
          label="Plaud recordings"
          hint="transcripts and summaries from the voice recorder"
          checked={draft.integrations.plaud}
          onChange={(v) => edit(setPlaud(draft, v))}
        />
        <div className="acx-sub">Google — mail, calendar, drive</div>
        {accountRows('google', google)}
        <div className="acx-sub">Microsoft — mail, calendar, files</div>
        {accountRows('microsoft', microsoft)}
        <div className="acx-sub">Credentials</div>
        {/* ⚰ THE PER-CREDENTIAL CHECKBOX LIST IS GONE (owner order, A5), and with
            it the `listCredentials` fetch that fed it. The grant is a boolean in
            the model now, so one toggle is the WHOLE truth about the field — not
            a coarse view of a finer one. */}
        <Check
          label="Access to stored credentials"
          hint="read, add, update and delete every key in the credential store"
          checked={credentialsGranted(draft)}
          onChange={(v) => edit(setCredentials(draft, v))}
        />
      </Section>

      {/* ── 3. Channels (A5: the master REVEALS its children) ── */}
      <Section title="Channels" desc="How this agent may reach a person. Every channel sits under the master switch and does nothing without it.">
        {master ? (
          <>
            <Switch
              id={`master-${agent.id}`}
              label="Allowed to talk to humans"
              on={on}
              onChange={(v) => edit(setMaster(draft, v))}
            />
            {on && (
              <div className="acx-children">
                {ACCESS_CHANNELS.map((channel) => (
                  <div className="acx-acct" key={channel}>
                    <Check
                      label={CHANNEL_LABEL[channel]}
                      checked={draft.channels[channel] !== 'none'}
                      onChange={(v) => edit(setChannelTier(draft, channel, v ? 'owner' : 'none'))}
                    />
                    {draft.channels[channel] !== 'none' && (
                      <Choice<'owner' | 'all'>
                        value={draft.channels[channel] as 'owner' | 'all'}
                        options={[{ v: 'owner', l: 'Only me' }, { v: 'all', l: 'Anyone approved' }]}
                        onChange={(v) => edit(setChannelTier(draft, channel, v))}
                      />
                    )}
                  </div>
                ))}
              </div>
            )}
            {!on && <div className="fhelp">This agent cannot reach a person on any channel. Turn the switch on to choose which.</div>}
            {on && inert.map((row) => (
              <div className="note--warn" key={row.channel} style={{ marginTop: 10, marginBottom: 0 }}>
                {CHANNEL_LABEL[row.channel]} is granted, but the “{splitLabel(row.groups[0]).name}” tool group is
                not — the agent would be refused when it tried. Tick that group above.
              </div>
            ))}
          </>
        ) : (
          <div className="note--warn" style={{ marginBottom: 0 }}>
            This agent has no “allowed to talk to humans” switch. It communicates through the main agent, which is
            how the dojo&apos;s sensei agents have always worked. Its other access is editable above.
          </div>
        )}
      </Section>

      {/* ── 4. Techniques (A4: a real grant plus the equip list; A5: a switch) ──
          The two halves answer different questions, which is why both are drawn:
            MAY RUN   — the grant. Governs the agent's technique index, the
                        matcher that would otherwise inject a body unasked, and
                        the use_technique door. Saved with the rest of the panel.
            PRE-LOAD  — equipping. Inlines the whole TECHNIQUE.md into the
                        prompt every turn. Saves on change, as it always did.
          The grant list gates the equip list on screen for the same reason the
          renderer gates it on the server: equipping something ungranted loads
          nothing, and a control that offers it is lying to the owner. */}
      <Section title="Techniques" desc="Procedures this agent may run when a task matches one.">
        {techniqueCatalog.length === 0 ? (
          <div className="fhelp">No published techniques on this dojo yet. Publish one on the Techniques page and it will appear here.</div>
        ) : (
          <>
            <Switch
              id={`techniques-${agent.id}`}
              label="Technique access"
              on={techniqueAccessOn(draft)}
              onChange={(v) => edit(setTechniqueAccess(draft, v, techniqueIds))}
            />
            {techniqueAccessOn(draft) ? (
              <div className="acx-children">
                <div className="acx-grid">
                  {techniqueCatalog.map((t) => (
                    <Check
                      key={t.id}
                      label={t.name}
                      hint={t.id}
                      checked={techniqueChecked(draft, t.id)}
                      onChange={(v) => edit(setTechnique(draft, t.id, v, techniqueIds))}
                    />
                  ))}
                </div>
                <div className="acx-sub">
                  <div className="acx-sub__title">Pre-load into every prompt</div>
                  <TechniqueSelector
                    selected={(agent.equippedTechniques ?? []).filter((id) => techniqueChecked(draft, id))}
                    only={grantedTechniqueIds}
                    onChange={async (updated) => {
                      const result = await api.updateAgentConfig(agent.id, { equippedTechniques: updated } as Record<string, unknown>);
                      if (result.ok) { toast.success('Techniques updated'); onUpdated(); }
                      else { toast.error(result.error || 'Could not update techniques.'); }
                    }}
                  />
                  <div className="fhelp">Equipping inlines the full procedure into every turn. Granting alone is enough for the agent to find and use one on its own; this saves as soon as you change it.</div>
                </div>
              </div>
            ) : (
              <div className="fhelp">This agent may run no techniques. Turn the switch on to choose which.</div>
            )}
          </>
        )}
      </Section>

      <div className="srow" style={{ justifyContent: 'flex-end', marginTop: 16, gap: 8 }}>
        <button type="button" className="btn btn--sm" disabled={!dirty || saving} onClick={() => setDraft(clone(stored))}>
          Reset
        </button>
        <button type="button" className="btn btn--primary btn--sm" disabled={!dirty || saving} onClick={save}>
          {saving ? 'Saving…' : 'Save access'}
        </button>
      </div>
    </div>
  );
};
