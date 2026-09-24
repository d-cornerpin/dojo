# dojo_report

File a problem report about the Dojo platform itself, for the people who build it.

Use this when the user says something went wrong with the platform and wants it fixed — *"that wasn't right, why did that happen, let's get this fixed in the Dojo"*. This is for defects in the PLATFORM (a tool that refused something it should have allowed, an answer that came back wrong, a turn that produced nothing), not for problems in the user's own work.

## This tool cannot post. Read this part twice.

**You cannot send anything, anywhere.** There is no phase that publishes, no argument that publishes, and no code path from this tool to GitHub or to any network. What `submit` does is put a preview card on the user's dashboard showing your exact text. Only the user, pressing Post on that card, can publish it. Only the user can edit it.

So when you tell the user you have filed it, say what is actually true: *"I've written it up — it's on your dashboard for you to read and post if you want it sent. I can't send it myself."* Do not say you have reported it, submitted it to the developers, or opened an issue. None of those have happened.

## The three phases, in order

### 1. `gather`

```
dojo_report({ phase: "gather" })
dojo_report({ phase: "gather", turns: 8, minutes: 30 })
```

Reads the evidence for a bounded recent window and opens a report. Returns the report id, the window it actually used, and the raw evidence as readable JSON.

**The window is capped at 20 turns and 120 minutes.** Ask for more and you get the cap, and the result says so in plain words. Both arguments are optional; omitting them gives you the full standing window, which is what you usually want. The evidence is turn records, model-call timings and token counts, tool-call outcomes, failure streaks, open work and the settings that shape a turn.

Everything `gather` shows you is **local**. It never leaves this machine. Read it to work out what happened — do not copy it into your brief.

### 2. `draft`

```
dojo_report({
  phase: "draft", report_id: "<the id gather gave you>", lane: "permission",
  title: "...", what_happened: "...", what_should_have_happened: "...",
  why_it_went_wrong: "...", fix_ideas: "...",
})
```

All five brief fields are required, and `lane` must come from the fixed list:

- `tool-error` — a tool refused or broke
- `wrong-answer` — the platform answered, incorrectly
- `silence` — nothing came back
- `permission` — a gate refused something it should have allowed
- `other`

Returns your brief rendered exactly as the user will see it, plus the machine-built telemetry attachment. **Re-read the brief at this point.** If it quotes the conversation, names anyone, or carries a file path, call `draft` again with it fixed. You may re-draft as many times as you like before you submit.

### 3. `submit`

```
dojo_report({ phase: "submit", report_id: "<the id>" })
```

Moves the report in front of the user and puts the card on the dashboard. This is the last thing this tool can do.

## What your brief may and may not contain

This becomes a **PUBLIC page** if the user posts it. Write it accordingly.

**MAY contain:** your own abstracted description of the failure — the shape of what went wrong, what you expected, your reasoning about the cause, and what you think would fix it.

**MAY NOT contain:** quotes from the conversation. Anything the user wrote. Anyone's name or address. File contents. File paths. Credential values. Names of the user's files, projects, contacts or accounts.

Describe the SHAPE, never the content:

- Good: *"A tool call was refused by a permission gate the engine had just told me to use."*
- Good: *"A 40 KB argument was rejected with no size named in the refusal."*
- Bad: *"I couldn't read /Users/dave/taxes.pdf."* — that is a path, and it is the user's.
- Bad: *"The user asked me to email Sarah about the settlement and..."* — that is their content.

## The attachment you do not write

A separate telemetry attachment rides along with the report: timings, token counts, latencies, tool names, argument SHAPES and sizes (never values), the platform version, and the settings that shaped the turn. It is built by the engine from a fixed list of allowed fields.

**You do not write it and cannot add to it.** There is no argument for it. If a fact you think matters is not in it, say so in `why_it_went_wrong` in your own abstracted words — do not try to smuggle it in as data.

The raw evidence `gather` showed you is written to a local file on the user's machine, referenced by report id. It never leaves the box. If triage later needs it, the user provides it deliberately.

## Return format

Every phase returns plain text and never throws. A refusal — an unknown lane, an empty brief field, a report that has already been submitted — comes back as an error result naming what to fix. Fix it and call again; nothing is lost.
