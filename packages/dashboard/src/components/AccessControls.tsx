// ════════════════════════════════════════════════════════════════════════════
// THE ACCESS PANEL'S CONTROLS (UX-ACCESS A6) — the shapes, once.
//
// A5 grew four of these inside `AccessPanel.tsx`; A6 adds a collapsible ROW and
// a consistent ITEM and needs both from two components (the panel and the folded
// manifest half), so they live here instead of being written twice. Nothing in
// this file knows what a grant is — it renders and calls back.
//
// ── THE OWNER'S TWO STANDING NOTES, BUILT IN ──
//   1. "Interactive things look interactive." Every control is drawn at rest —
//      the switch has a track, the checkbox has a box, the row header is a real
//      <button> with a chevron — never only on hover.
//   2. "Consistent row heights/spacing." One <Item> is one line of question and
//      one line of help with its control on the right, at one height, whatever
//      the control is. Anything a control reveals goes in `children`, indented
//      under the same left rule the panel already uses for a switch's children.
// ════════════════════════════════════════════════════════════════════════════

import { CollapseChevron } from './CollapseToggle';

/** The long index labels carry a parenthetical for the prompt; the checkbox
 *  shows the name and the parenthetical becomes its hint. */
export const splitLabel = (label: string): { name: string; hint: string | null } => {
  const at = label.indexOf(' (');
  return at === -1 ? { name: label, hint: null } : { name: label.slice(0, at), hint: label.slice(at + 2, -1) };
};

/** A checkbox with a name and an optional one-line hint. Used where the owner is
 *  picking several things out of a list (tool groups, techniques, channels). */
export const Check = ({ label, hint, checked, onChange }: {
  label: string; hint?: string | null; checked: boolean; onChange: (v: boolean) => void;
}) => (
  <label className="acx-check">
    <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    <span className="acx-check__body">
      <span className="acx-check__name">{label}</span>
      {hint && <span className="acx-check__hint">{hint}</span>}
    </span>
  </label>
);

/** The bare switch. Used where the answer is yes or no. */
export const Toggle = ({ label, on, onChange }: {
  label: string; on: boolean; onChange: (v: boolean) => void;
}) => (
  <button
    type="button"
    role="switch"
    aria-checked={on}
    aria-label={label}
    className={`switch ${on ? 'is-on' : ''}`}
    onClick={() => onChange(!on)}
  />
);

/** A two-or-more option radio group. One component for the tool mode, the
 *  channel tier and every "all / only these" sub-option, because they are the
 *  same control and a second copy would drift. */
export const Choice = <T extends string>({ value, options, onChange, label }: {
  value: T; options: Array<{ v: T; l: string }>; onChange: (v: T) => void; label?: string;
}) => (
  <div className="acx-tier" role="radiogroup" aria-label={label}>
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

/** One line of the panel: a plain name, one line of help, a control on the
 *  right, and whatever the control reveals beneath it. `risk` is the single
 *  warning tint every consequential grant wears — running programs, the key
 *  store, deleting files, driving Mac apps, handing out permissions. */
export const Item = ({ name, help, control, risk, children }: {
  name: string; help?: string; control: React.ReactNode; risk?: boolean; children?: React.ReactNode;
}) => (
  <div className={`acx-item${risk ? ' is-risk' : ''}`}>
    <div className="acx-item__main">
      <span className="acx-item__body">
        <span className="acx-item__name">{name}</span>
        {help && <span className="acx-item__help">{help}</span>}
      </span>
      <span className="acx-item__control">{control}</span>
    </div>
    {children && <div className="acx-item__more">{children}</div>}
  </div>
);

/** An "everything / only these" sub-option with its list box. */
export const Scope = ({ id, allLabel, someLabel, isAll, list, onAll, onList, placeholder }: {
  id: string; allLabel: string; someLabel: string; isAll: boolean; list: string;
  onAll: (v: boolean) => void; onList: (v: string) => void; placeholder: string;
}) => (
  <>
    <Choice<'all' | 'some'>
      label={allLabel}
      value={isAll ? 'all' : 'some'}
      options={[{ v: 'all', l: allLabel }, { v: 'some', l: someLabel }]}
      onChange={(v) => onAll(v === 'all')}
    />
    {!isAll && (
      <input
        id={id}
        className="finput acx-list"
        aria-label={someLabel}
        value={list}
        placeholder={placeholder}
        onChange={(e) => onList(e.target.value)}
      />
    )}
  </>
);

/** One of the panel's five questions. Folded by default; the whole header is the
 *  click target, and it carries the row's own state so a shut row still answers
 *  the question it asks. */
export const Row = ({ question, state, collapsed, onToggle, children }: {
  question: string; state: string; collapsed: boolean; onToggle: () => void; children: React.ReactNode;
}) => (
  <section className="acx-row">
    <button
      type="button"
      className="acx-row__head"
      aria-expanded={!collapsed}
      onClick={onToggle}
    >
      <span className="acx-row__q">{question}</span>
      <span className="acx-row__state">{state}</span>
      <CollapseChevron collapsed={collapsed} className="acx-row__chev" />
    </button>
    {!collapsed && <div className="acx-row__body">{children}</div>}
  </section>
);
