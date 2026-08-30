# DOJO 3.1.18 — the update that repairs a failed update

**Everyone on 3.1.17 or earlier should install this one.** If your box is stuck after
updating to 3.1.17, this is the fix: run the normal update. There is no script to paste and
nothing to undo first.

## What was wrong

If one of your agents was waiting on another agent at the moment you started the 3.1.17
update, the update stopped part-way through and DOJO could not start again. Every automatic
retry stopped at the same place, so the box stayed down.

That waiting hand-off is completely normal — it happens any time one agent asks another for
something. The 3.1.17 upgrade step treated finding one as a reason to refuse, because on the
machine it was measured on there happened to be none in flight. It should never have been a
refusal, and this release makes it an observation.

Three smaller things went wrong alongside it, and all three are fixed here:

- **A hand-off left mid-flight is now closed properly** instead of being left open with
  nothing able to answer it. DOJO closes it the same way it closes one that times out
  normally, so nothing is invented and no message is lost.
- **Going back now goes back to the right build.** When DOJO undoes a failed update it used
  to pick the highest version number sitting on disk, which could be a preview build. It now
  restores the exact build the update replaced, recorded at the time it was replaced.
- **Your safety copy can no longer be deleted by the thing it protects you from.** DOJO takes
  a copy of your data before any update changes it, and kept the two most recent copies. A
  box restarting in a loop wrote a new copy every ten seconds, and within about half a minute
  the original — the only one worth having — had been pushed out. The copy taken at the start
  of an update is now held for the whole update.

## What happens when you install it

Nothing you have to do. DOJO replaces itself, finishes the database work that stopped in
3.1.17, closes any hand-off that was left waiting, and starts up. Your conversations, tasks,
projects and settings come with you.

If your box was stuck, expect the first start to take longer than usual — it is finishing the
work that stopped. On a large database this can take a few minutes.

## Being straight with you about the limits

- **If DOJO is so broken that it cannot start its own updater, this release cannot reach it.**
  That is a different failure — a half-copied program folder — and it needs a hand. If the
  update button does nothing at all, get in touch rather than retrying.
- **If your box already lost its pre-update safety copy** to the loop described above, this
  release cannot bring it back. It can only stop it happening again. Going forward is safe:
  3.1.18 finishes the update on the data you have.
- **An agent that was waiting on another when your box went down will not get its answer.**
  The question is closed and recorded as unanswered rather than left hanging, so you can ask
  again and DOJO can see that you have. Nothing else about that conversation changes.

## For the record

Every version DOJO has shipped from 3.1.16 onwards was installed into a test copy and updated
to 3.1.18 before this release was cut: a clean 3.1.16, a 3.1.16 with hand-offs in flight, a
box stuck exactly where the reported one was stuck, a completed 3.1.17, the full state of the
box that reported the problem, the last preview build, and a development build. All of them
started, finished their database work, and passed an integrity check.
