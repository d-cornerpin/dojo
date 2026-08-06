# If an update goes wrong

**This page lives on your Mac at `~/.dojo/scripts/IF-AN-UPDATE-FAILS.md`.** Every step on
it has been run and checked; none of it is advice.

Open Terminal (⌘-Space, type "Terminal") and paste the lines in the grey boxes.

---

## First: what kind of wrong is it?

**Dojo starts, but something looks broken or wrong.** → Go to **Situation B**.

**Dojo will not start at all** — the dashboard will not load, the menu bar says the
server is down. → Start at **Situation A**.

---

## Situation A — Dojo will not start

### A1. Put the previous version of the app back

```
bash ~/.dojo/scripts/rollback.sh
```

This puts the version you were on before the update back, keeps the broken one aside so
it can be looked at, and restarts everything. Wait a minute, then try the dashboard
again.

**This puts the APP back. It does not put your DATA back.** If the update changed your
data, that change is still there. Usually that is fine — the older app reads the newer
data without complaining; that has been tested. If something still looks wrong
afterwards, carry on to Situation B.

### A2. If it still will not start

You may have hit the safety stop. Dojo refuses to change your data when it could not
save a backup first. Look for the reason:

```
tail -30 ~/.dojo/logs/platform.stderr.log
```

If you see a message about **not enough free disk space**, that is the whole problem.
Free up the amount it names (empty the Trash, delete some large files) and start Dojo:

```
bash ~/.dojo/scripts/start.sh
```

It will make the backup itself and carry on. Nothing has been damaged — Dojo stopped
*before* changing anything, on purpose.

If you would rather go ahead **without** a backup, and accept that you will not be able
to go back afterwards:

```
touch ~/.dojo/data/allow-migration-without-backup
bash ~/.dojo/scripts/start.sh
```

That permission is used once and then forgotten, so the next update is protected again.

---

## Situation B — Dojo runs, but your information looks wrong

This is where you put your **data** back to how it was before the update.

### B1. See what you can go back to

```
bash ~/.dojo/scripts/restore-db.sh
```

You will get a list like this:

```
  2026-08-06 13:37   262 MB   chain 151 (up to 148_drop_messages_conv_key.sql)
      /Users/you/.dojo/data/backups/dojo-pre-900-to-900-2026-08-06T20-37-31.db
```

The date is when the copy was made — normally moments before the update changed
anything. **Ignore the numbers in the file name**; they are always the same and mean
nothing. The number that matters is the one after the word **chain**: a lower number is
an older shape of your information.

**If the list is empty**, there is no saved copy to go back to. Open Dojo → Settings →
Update; the panel there says whether the last update saved one and, if not, why. Skip to
"What if there is no backup?" at the bottom.

### B2. Stop Dojo

```
bash ~/.dojo/scripts/stop.sh
```

This step is not optional. The restore refuses to run while Dojo is running, because
replacing the file underneath a running Dojo would damage it.

### B3. Put your data back

```
bash ~/.dojo/scripts/restore-db.sh --latest
```

It will show you what it is about to use, ask you to type `yes`, and then:

- copy your **current** data aside first, so this is undoable,
- check the backup is sound **before** replacing anything,
- put it in place,
- check the result, and put your current data back if the result does not check out.

Then it prints exactly what it did, including where your current data was kept.

### B4. Start Dojo

```
bash ~/.dojo/scripts/start.sh
```

Give it a minute and open the dashboard.

### B5. If you also went back to an older version of the app

If you did Situation A as well, you are now running an older app on older data, which is
the pair they were designed for. Nothing more to do.

If you are running the **newer** app on **older** data, it will simply re-apply the
update to your data the next time it starts, and you will be back where you were. To
stay on the older data, put the older app back too:

```
bash ~/.dojo/scripts/rollback.sh
```

---

## What you get back, and what you don't

Restoring puts your database back to the copy's exact contents. **Anything that happened
after that copy was made is gone from Dojo's memory** — messages, tasks and notes from
the hours since the update.

One thing to know about going back **without** restoring the data (Situation A on its
own): **the update tidies up your to-do list, and putting the old app back does not
untidy it.** Old requests that had been marked finished on flimsy evidence get pointed
at the real answer instead, and a number of them come back to you as still open —
roughly twenty, on a list the size of yours. That is a repair, not damage: those items
genuinely were not finished. It is also the *only* part of the update that going back
cannot undo on its own. If you want that undone too, you need B1–B4 above.

Nothing else costs you anything. Your Google and Microsoft accounts stay connected. Your
agents, messages, files and settings are untouched.

---

## What if there is no backup?

Then the update ran without saving one — which Dojo now refuses to do unless it is told
to, but an older version could. Your options:

1. **`bash ~/.dojo/scripts/rollback.sh`** still works. It puts the old app back, and the
   old app reads the newer data. That fixes anything caused by the new app itself.
2. **Check the other place backups live.** If you have ever run
   `~/.dojo/scripts/backup.sh`, there are copies under `~/.dojo/backups/`, and
   `restore-db.sh` lists those too.
3. If neither helps, stop and ask for help before changing anything else. Your data is
   still there; nothing in this document deletes it.

---

## Undoing a restore

Every restore keeps your previous data. The last line of the restore's output names the
file. To go back to it:

```
bash ~/.dojo/scripts/stop.sh
bash ~/.dojo/scripts/restore-db.sh --from ~/.dojo/data/backups/dojo-replaced-<the-date>.db
bash ~/.dojo/scripts/start.sh
```

---

## When to call it good

You are done when all three are true:

1. The dashboard loads at <http://localhost:3001>.
2. `bash ~/.dojo/scripts/status.sh` shows **API ✅ Healthy** with your agents counted,
   and a **Database** size that looks like your real database — hundreds of megabytes,
   not a few hundred KB. (A small database means an empty one was restored.)
3. Your agents and your recent conversations are there when you open the dashboard.

If all three hold, stop. There is nothing else to do.
