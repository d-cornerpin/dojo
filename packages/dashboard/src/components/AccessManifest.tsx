// ════════════════════════════════════════════════════════════════════════════
// THE FOLDED-IN PERMISSION TOGGLES.
//
// These controls live in the Access panel: the two reach toggles under "What it
// can reach", files / this Mac / other agents under "What it may manage". The
// agent editor has ONE door onto what an agent may do.
//
// THE STORAGE IS NOT HERE. Every switch writes the `PermissionManifest` inside
// `agents.permissions`, the `tools_policy` column, or `config.shareUserProfile`,
// through the Access panel's one save (a PUT to `/agents/:id`). The arithmetic is
// `lib/manifest-edits.ts`, pure; this file only renders and asks.
//
// ── A BUILT-IN AGENT'S MANIFEST IS NOT EDITABLE ──
// A NOTE is rendered instead of the editor for every platform agent: `editable`
// is decided by the agent config page from the sensei classification and passed through
// AccessPanel. Neither the panel nor this file classifies an agent.
// ════════════════════════════════════════════════════════════════════════════

import { useState } from 'react';
import { programsAreEmpty, type LegacyAccess } from '../lib/manifest-edits';
import { Item, Scope, Toggle } from './AccessControls';

interface Props {
  state: LegacyAccess;
  onChange: (next: LegacyAccess) => void;
  /** False for the platform's own agents, whose manifest the dojo sets. */
  editable: boolean;
  /** What to say instead, when it is not editable. */
  note: string;
}

const Locked = ({ note }: { note: string }) => (
  <div className="note--warn" style={{ textTransform: 'none', letterSpacing: 'normal', marginBottom: 0 }}>
    {note}
  </div>
);

/** One switch over one boolean of the state. */
const Flag = ({ name, help, risk, on, set, children }: {
  name: string; help: string; risk?: boolean; on: boolean; set: (v: boolean) => void; children?: React.ReactNode;
}) => (
  <Item name={name} help={help} risk={risk} control={<Toggle label={name} on={on} onChange={set} />}>
    {on && children}
  </Item>
);

// ── "What it can reach": the two the owner named ──

export const ReachManifestItems = ({ state, onChange, editable, note }: Props) => {
  if (!editable) return <Locked note={note} />;
  const edit = (patch: Partial<LegacyAccess>) => onChange({ ...state, ...patch });
  return (
    <>
      <Flag
        name="Search the web"
        help="Look things up with a web search."
        on={state.searchOn}
        set={(v) => edit({ searchOn: v })}
      />
      <Flag
        name="Open web pages"
        help="Open a page in a background browser and read what is on it."
        on={state.browseOn}
        set={(v) => edit({ browseOn: v })}
      >
        <Scope
          id="acx-domains"
          allLabel="Any website"
          someLabel="Only these"
          isAll={state.domainsAll}
          list={state.domainsList}
          onAll={(v) => edit({ domainsAll: v })}
          onList={(v) => edit({ domainsList: v })}
          placeholder="github.com, docs.python.org"
        />
      </Flag>
      <Flag
        name="Run programs on this Mac"
        help="Run commands on your machine, as you."
        risk
        on={state.execOn}
        set={(v) => edit({ execOn: v })}
      >
        <Scope
          id="acx-exec"
          allLabel="Any command"
          someLabel="Only these"
          isAll={state.execAll}
          list={state.execList}
          onAll={(v) => edit({ execAll: v })}
          onList={(v) => edit({ execList: v })}
          placeholder="ls, cat, node, npm, git"
        />
        {programsAreEmpty(state) && (
          <div className="fhelp">No commands listed yet, so this grants nothing until you name some.</div>
        )}
      </Flag>
    </>
  );
};

// ── "What it knows": your profile ──

export const KnowsManifestItem = ({ state, onChange, editable }: Props) => {
  // Not the same note as the other two rows: this row's OTHER control (the
  // techniques) is editable for every agent, so the row must say which half is
  // not, in a sentence about the half that is not.
  if (!editable) {
    return (
      <div className="fhelp">
        Whether this agent knows who you are is set by the dojo, and it does{state.shareProfile ? '' : ' not'}.
      </div>
    );
  }
  return (
    <Flag
      name="Knows who you are"
      help="Puts your profile (About You) in this agent's context."
      on={state.shareProfile}
      set={(v) => onChange({ ...state, shareProfile: v })}
    />
  );
};

// ── "What it may manage": files, this Mac, other agents ──

export const ManageManifestItems = ({ state, onChange, editable, note }: Props) => {
  const [advanced, setAdvanced] = useState(false);
  if (!editable) return <Locked note={note} />;
  const edit = (patch: Partial<LegacyAccess>) => onChange({ ...state, ...patch });
  return (
    <>
      <div className="acx-sub">Your files</div>
      <Flag name="Read your files" help="Open and read files on this Mac." on={state.readOn} set={(v) => edit({ readOn: v })}>
        <Scope
          id="acx-read" allLabel="Anywhere" someLabel="Only these folders"
          isAll={state.readAll} list={state.readList}
          onAll={(v) => edit({ readAll: v })} onList={(v) => edit({ readList: v })}
          placeholder="~/Projects/**, ~/Desktop/*"
        />
      </Flag>
      <Flag name="Change and create files" help="Write new files and edit existing ones." on={state.writeOn} set={(v) => edit({ writeOn: v })}>
        <Scope
          id="acx-write" allLabel="Anywhere" someLabel="Only these folders"
          isAll={state.writeAll} list={state.writeList}
          onAll={(v) => edit({ writeAll: v })} onList={(v) => edit({ writeList: v })}
          placeholder="~/Projects/**, /tmp/**"
        />
      </Flag>

      <div className="acx-sub">This Mac</div>
      <Flag name="See your screen" help="Take screenshots and read what is on screen." on={state.screenOn} set={(v) => edit({ screenOn: v })} />
      <Flag name="Move the mouse" help="Move and click the pointer." on={state.mouseOn} set={(v) => edit({ mouseOn: v })} />
      <Flag name="Type on the keyboard" help="Type text and press shortcuts." on={state.keyboardOn} set={(v) => edit({ keyboardOn: v })} />
      <Flag name="Automate Mac apps" help="Drive apps and system features with AppleScript." risk on={state.applescriptOn} set={(v) => edit({ applescriptOn: v })} />

      <div className="acx-sub">Other agents</div>
      <Flag name="Create helper agents" help="Start new agents to hand work to." on={state.spawnOn} set={(v) => edit({ spawnOn: v })} />
      <Flag
        name="Set what other agents may do"
        help="Change the access of the agents it creates or manages."
        risk
        on={state.assignOn}
        set={(v) => edit({ assignOn: v })}
      />

      <div className="acx-adv">
        <button type="button" className="acx-adv__toggle" aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}>
          {advanced ? '▾' : '▸'} Advanced
        </button>
        {advanced && (
          <div className="acx-adv__body">
            <Item
              name="Commands it may never run"
              help="On top of the dojo's own block list, which always applies."
              control={(
                <input
                  className="finput acx-list" aria-label="Commands it may never run"
                  value={state.execDeny} placeholder="rm -rf *, sudo *"
                  onChange={(e) => edit({ execDeny: e.target.value })}
                />
              )}
            />
            <Item
              name="Tools it may use, by name"
              help="Leave empty for every tool its groups allow."
              control={(
                <input
                  className="finput acx-list" aria-label="Tools it may use, by name"
                  value={state.rawAllow} placeholder="empty = all"
                  onChange={(e) => edit({ rawAllow: e.target.value })}
                />
              )}
            />
            <Item
              name="Tools it may never use, by name"
              help="Blocked whatever else is granted."
              control={(
                <input
                  className="finput acx-list" aria-label="Tools it may never use, by name"
                  value={state.rawDeny} placeholder="spawn_agent, kill_agent"
                  onChange={(e) => edit({ rawDeny: e.target.value })}
                />
              )}
            />
          </div>
        )}
      </div>
    </>
  );
};

// There is no raw "Network Domains" field: `network_domains` is owned by the "Open web pages"
// scope above, and a second control over it could disagree on screen.
