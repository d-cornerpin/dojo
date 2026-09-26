// ════════════════════════════════════════════════════════════════════════════════════════
// THE ONE ANNOTATED TOOL-INDEX ENTRY (DOJO-REPORT T8, owner-approved).
//
// ── THE MEASURED DEFECT ──
// The cached tool index is NAMES ONLY, by design — "tool-index slimming", the note at the top of
// `categories.ts`: the model learns that every tool exists and calls `load_tool_docs` for the
// schema, at a fraction of the tokens. That design has exactly one measured casualty.
//
// In the T8 live run a floor-model agent was handed the owner's own designed phrase — "That wasn't
// right. Why did that happen? Let's get this fixed in the Dojo." — and did NOT reach for
// `dojo_report`. It investigated its own grants, delegated to a peer to ask for a permission, was
// correctly refused, and burned the turn until a human named the tool; pointed at it, it then ran
// gather → draft → submit perfectly. Nothing in the machinery was wrong. ALL of the trigger
// language lives in the DESCRIPTION, and the description sits behind `load_tool_docs` — so at the
// moment of deciding, the agent's only cue was the bare token `dojo_report`, and a bare name does
// not tell a model that "let's get this fixed in the Dojo" is what this tool is for.
//
// A report tool nobody reaches is a report tool nobody has. So this one entry gets a phrase.
//
// ── WHY THIS IS ITS OWN MODULE ──
// `categories.ts` was measured at 402 lines with this note inside it, against the 400-line
// new-file cap in `ratchets.json`. The house instruction for that case is explicit and has
// precedent in this tree — `github/status.ts` and `github/refusal.ts` were both split out of a
// file that had hit its ceiling — and the alternative here was worse than usual: pinning
// `categories.ts` decrease-only would make it fail the gate for whoever adds the NEXT TOOL, in a
// file whose whole job is to list tools.
//
// ── WHY A MAP, AND WHY IT HAS EXACTLY ONE ENTRY ──
// Annotating every name is the pre-slimming index the slimming deliberately left behind; the
// tokens are the whole reason the index is names-only, and this is not that change reversed. It is
// one phrase for the one tool whose discoverability was MEASURED to fail. The map shape is what
// makes a second entry a visible, arguable edit rather than a habit — and because every byte here
// rides the CACHED PREFIX (roadmap non-negotiable #10), each future entry also costs a deliberate
// golden re-record, which is the price that keeps the list honest.
//
// ── WHAT THE PHRASE HAS TO CONVEY ──
// The same four things the description's own trigger pins are held to, in the shortest form that
// carries them: that this is a REPORT, that the subject is THE DOJO ITSELF (the discriminator the
// live run got wrong when it went looking at its own grants), that what is reported is a PROBLEM
// — the word a user reaches for long before "bug" or "issue" — and WHO receives it, which is what
// makes filing it the answer rather than asking someone for help. The clauses that hold each of
// those are PART 5 of `__tests__/the-index-names-what-the-agent-can-call.test.ts`.
// ════════════════════════════════════════════════════════════════════════════════════════

/** Tool name → the short phrase the index line carries after it. One entry. See the header. */
export const INDEX_NOTES: Readonly<Record<string, string>> = {
  dojo_report: 'report a problem with the Dojo itself to the people who build it',
};

/**
 * `` `name` `` — or `` `name` (what it is for) `` for an annotated one.
 *
 * THE IDENTITY FOR EVERY UNANNOTATED NAME, which is the cache-prefix property stated as code: an
 * agent that does not hold `dojo_report` gets a byte-identical index line, because the annotation
 * rides the NAME and not the category. A note keyed on the category would have widened the cached
 * prefix of every agent, including the ones that cannot call the tool.
 */
export function renderIndexName(name: string): string {
  const note = INDEX_NOTES[name];
  return note === undefined ? `\`${name}\`` : `\`${name}\` (${note})`;
}
