// ════════════════════════════════════════════════════════════════════════════
// THE PROJECT TRACKER'S WORK VERBS: the handler bodies behind the `work_*` tools.
//
// The table is keyed on the DISPATCH KEY (`workOperation(name, args) ?? name`),
// not the tool name: the six `work_*` verbs fan out (one `work_update` reaches
// seven bodies, `work_validate` five) and a by-name map cannot express that.
//
// ── THE PER-OPERATION `checkRequired` SITES ARE ALL HERE ──
// The work verbs' `input_schema.required` is `[]`: the wire carries a UNION of
// every operation's fields, so a schema-compiled validator would validate NOTHING
// for them. These checks are the validation; dropping one drops it for
// that operation.
//
// `normalizeRepeatDaysOfWeek` + `REPEAT_DAY_NAME_MAP` live here because their
// only call sites (`work_open:task`, `work_open:reminder`, `work_update:edit`)
// are all here.
//
// ── NO LAZY LOADS ──
// `tracker/tools.ts` imports nothing from the toolbox, so its loads are plain
// static imports: there is no cycle to break.
// ════════════════════════════════════════════════════════════════════════════

import { getDb } from '../../../db/connection.js';
import { turnContext } from '../../turn-context.js';
import { checkRequired, friendlyDbError, pauseActionMissing } from '../../tool-helpers.js';
import { terminalDeliveryForTurn } from '../../v2/answered-edge.js';
import { openCommitment, resolveCommitment, dismissCommitment, findObligationByTypedId } from '../../../work/store.js';
import { moveAssignee } from '../../../work/row-authority.js';
import { inheritedAskDoor } from '../../../work/inherited-backlog.js';
import { resolveTaskId, resolveProjectId, formatResolveError } from '../../../tracker/schema.js';
import { WORK_EDITABLE_TASK_FIELDS } from '../../work-verb-schema.js';
import { handIn, judgedForItsRun } from '../../../work/done/hand-in.js';
import { isHousekeeping } from '../../../work/done/housekeeping.js';
import { decide, type Verdict } from '../../../work/done/decide.js';
import { openProof } from '../../../work/done/open-proof.js';
import { proofFor, type HandInOutcome, type ProofItemInput, type ProofKind } from '../../../work/done/proof.js';
import { normalizeTaskStatus } from '../../../tracker/task-status-words.js';
import { normalizeQuote, ownerSaidSince } from '../../../tracker/owner-words.js';
import {
  trackerCreateProject, trackerCreateTask, reminderCreate, groupMember, trackerUpdateStatus,
  trackerAddNotes, trackerEditTask, trackerEditProject, trackerGetStatus,
  trackerListActive, trackerActivity, activityWindowStart,
  trackerPauseSchedule, trackerResumeSchedule, trackerRetask,
} from '../../../tracker/tools.js';
import { coerceNumberArg } from '../pagination.js';
import { readMeasureArg, remeasureTask, editWithMeasure } from './measure-door.js';   // DONE IS MEASURED
import { checkPlan, tasksFromPlan, explicitTasks, taskPlanMismatch, PLAN_REFUSAL_PREFIX } from '../../../work/plan.js';   // PLAN BEFORE PROJECT
import { scaleFactsForAgent } from '../../../tools/scale-facts.js';
import type { ToolHandlerMap } from '../handler.js';

// Accepts names ("mon"), ints (0-6) or a CSV string; returns the canonical
// CSV-of-ints stored in the DB ("1,3"). null clears, undefined is unsupplied,
// and the literal '__INVALID__' means nothing parsed (callers refuse that).
const REPEAT_DAY_NAME_MAP: Record<string, number> = {
  sun: 0, sunday: 0,
  mon: 1, monday: 1,
  tue: 2, tues: 2, tuesday: 2,
  wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6,
};
function normalizeRepeatDaysOfWeek(rawDays: unknown): string | null | undefined {
  if (rawDays === undefined) return undefined;
  if (rawDays === null) return null;
  const raw: unknown[] = Array.isArray(rawDays)
    ? rawDays
    : typeof rawDays === 'string'
      ? rawDays.split(',')
      : [];
  if (Array.isArray(rawDays) && rawDays.length === 0) return null; // explicit clear
  const nums = new Set<number>();
  for (const item of raw) {
    if (typeof item === 'number' && Number.isInteger(item) && item >= 0 && item <= 6) {
      nums.add(item);
    } else if (typeof item === 'string') {
      const trimmed = item.trim().toLowerCase();
      if (trimmed === '') continue;
      const asNum = parseInt(trimmed, 10);
      if (Number.isInteger(asNum) && asNum >= 0 && asNum <= 6) {
        nums.add(asNum);
      } else if (REPEAT_DAY_NAME_MAP[trimmed] !== undefined) {
        nums.add(REPEAT_DAY_NAME_MAP[trimmed]);
      }
    }
  }
  if (nums.size === 0) return '__INVALID__';
  return [...nums].sort((a, b) => a - b).join(',');
}

/** A hand-in's proof items as the model sent them. A file, delivery, receipt or measure item may leave its
 *  ref empty: it is then the newest of that kind the engine finds on record for the task (`proofFor`). */
function proofItemsOf(taskId: string, raw: unknown): ProofItemInput[] {
  if (!Array.isArray(raw)) return [];
  const found = proofFor(taskId);
  return raw.filter((i): i is Record<string, unknown> => typeof i === 'object' && i !== null).map((i) => {
    const kind = String(i.kind ?? '') as ProofKind;
    const given = typeof i.ref === 'string' ? i.ref.trim() : String(i.ref ?? '');
    const ref = given || (found.filter((f) => f.kind === kind).pop()?.ref ?? '');
    return { kind, ref, ...(typeof i.reason === 'string' ? { facts: { reason: i.reason } } : {}) };
  });
}

/** "finished" or "can't be done", from `outcome`, else from an old closing status word. */
function outcomeOf(args: Record<string, unknown>): HandInOutcome {
  const o = typeof args.outcome === 'string' ? args.outcome.trim().toLowerCase().replace(/[\s'-]+/g, '_') : '';
  if (o === 'finished' || o === 'cant_be_done') return o;
  if (o === 'can_t_be_done' || o === 'cannot_be_done') return 'cant_be_done';
  const word = normalizeTaskStatus(args.status);
  return word === 'fallen' || word === 'cancelled' ? 'cant_be_done' : 'finished';
}

/** A task or project id as the decision tools take it. */
function resolveAnyBoardId(raw: string, agentId: string): { ok: true; id: string } | { ok: false; text: string } {
  const t = resolveTaskId(raw, agentId);
  if (t.ok) return t;
  const p = resolveProjectId(raw, agentId);
  return p.ok ? p : { ok: false, text: formatResolveError('task', raw, t) };
}

const tableOfHandlers: ToolHandlerMap = {
  async "work_open:project"({ agentId, args }) {
    let content = '';
    let isError = false;
    const projErr = checkRequired([
      { name: 'title', value: args.title, type: 'string' },
    ]);
    if (projErr) { content = projErr; isError = true; return { content, isError }; }
    // With no tasks of its own the tasks are the plan's steps, so a step's
    // measure is read here (counting is I/O); a bad plan is refused by the creator.
    const given = explicitTasks(args.tasks as Array<Record<string, unknown>> | undefined), planned = checkPlan(args.plan);
    const rawTasks = !planned.ok || (given && taskPlanMismatch(given.length, planned.plan)) ? [] : given ?? tasksFromPlan(planned.plan);
    const measures = await Promise.all(rawTasks.map((t) => readMeasureArg(agentId, t?.measure)));
    const badMeasure = measures.find((m) => m.error); if (badMeasure) return { content: badMeasure.error as string, isError: true };
    const taskInputs = given ? given.map(t => ({
      title: t.title as string,
      description: t.description as string | undefined,
      goal: t.goal as string | undefined,
      assignedTo: (t.assigned_to ?? t.assignedTo) as string | undefined,
      priority: t.priority as 'high' | 'normal' | 'low' | undefined,
      stepNumber: (t.step_number ?? t.stepNumber) as number | undefined,
      dependsOn: (t.depends_on ?? t.dependsOn) as string[] | undefined,
      phase: t.phase as number | undefined,
    })) : undefined;
    try {
      content = trackerCreateProject(agentId, {
        title: args.title as string,
        description: args.description as string | undefined,
        level: args.level as number,
        tasks: taskInputs,
        plan: args.plan,
        allow_duplicate: args.allow_duplicate as boolean | undefined,
      }, { taskMeasures: measures.map((m) => m.reading), scaleFacts: scaleFactsForAgent(agentId) });
    } catch (err) {
      content = friendlyDbError(err, 'work_open(kind="project")');
    }
    if (content.startsWith(PLAN_REFUSAL_PREFIX)) isError = true;   // a project the engine would not open is a failed call
    return { content, isError };
  },

  async "work_open:task"({ agentId, args }) {
    let content = '';
    let isError = false;
    const taskErr = checkRequired([
      { name: 'title', value: args.title, type: 'string' },
    ]);
    if (taskErr) { content = taskErr; isError = true; return { content, isError }; }

    // Day names/ints/CSV become the canonical CSV-of-ints the scheduler stores.
    const normalizedDays = normalizeRepeatDaysOfWeek(args.repeat_days_of_week);
    if (normalizedDays === '__INVALID__') {
      content = 'Error: repeat_days_of_week contained no valid days. Accepted: sun/mon/tue/wed/thu/fri/sat or 0-6.';
      isError = true;
      return { content, isError };
    }
    const repeatDaysOfWeek: string | undefined = normalizedDays ?? undefined;

    const measured = await readMeasureArg(agentId, args.measure);
    if (measured.error) return { content: measured.error, isError: true };
    try {
      content = await trackerCreateTask(agentId, {
        projectId: args.project_id as string | undefined,
        title: args.title as string,
        description: args.description as string | undefined,
        assignedTo: args.assigned_to as string | undefined,
        priority: args.priority as string | undefined,
        stepNumber: args.step_number as number | undefined,
        dependsOn: args.depends_on as string[] | undefined,
        phase: args.phase as number | undefined,
        scheduled_start: args.scheduled_start as string | undefined,
        // Meaningless for specific_days, but carry 1 so callers detect a recurring schedule.
        repeat_interval: (args.repeat_interval as number | undefined)
          ?? (args.repeat_unit === 'specific_days' ? 1 : undefined),
        repeat_unit: args.repeat_unit as string | undefined,
        repeat_end_type: args.repeat_end_type as string | undefined,
        repeat_end_value: args.repeat_end_value as string | undefined,
        repeat_days_of_week: repeatDaysOfWeek,
        // Forwarding the anchor keeps a fixed wall-clock cadence reachable; without it
        // every schedule drifts by its own run duration (held by tracker-door-census.test.ts).
        anchor_time: args.anchor_time as string | undefined,
        // The wall-clock pair: converted into `scheduled_start` so the model does no UTC math.
        local_time: args.local_time as string | undefined,
        local_timezone: args.local_timezone as string | undefined,
        assigned_to_group: args.assigned_to_group as string | undefined,
        allow_duplicate: args.allow_duplicate as boolean | undefined,
        goal: args.goal as string | undefined,
      }, { measure: measured.reading });
    } catch (err) {
      content = friendlyDbError(err, 'work_open(kind="task")');
    }
    return { content, isError };
  },

  async "work_open:reminder"({ agentId, args }) {
    let content = '';
    let isError = false;
    const remErr = checkRequired([
      { name: 'what', value: args.what, type: 'string' },
    ]);
    if (remErr) { content = remErr; isError = true; return { content, isError }; }

    // Same day-of-week normalization as the task path: ["mon","wed"] in, CSV-of-ints out.
    const normalizedDays = normalizeRepeatDaysOfWeek(args.repeat_days_of_week);
    if (normalizedDays === '__INVALID__') {
      content = 'Error: repeat_days_of_week contained no valid days. Accepted: sun/mon/tue/wed/thu/fri/sat or 0-6.';
      isError = true;
      return { content, isError };
    }
    const repeatDaysOfWeek: string | undefined = normalizedDays ?? undefined;

    try {
      content = await reminderCreate(agentId, {
        what: args.what,
        when: args.when,
        repeat_interval: (args.repeat_interval as number | undefined)
          ?? (args.repeat_unit === 'specific_days' ? 1 : undefined),
        repeat_unit: args.repeat_unit,
        repeat_end_type: args.repeat_end_type,
        repeat_end_value: args.repeat_end_value,
        repeat_days_of_week: repeatDaysOfWeek,
        anchor_time: args.anchor_time,
        // The refusal offers the wall-clock pair, so the door must forward it.
        local_time: args.local_time,
        local_timezone: args.local_timezone,
      });
    } catch (err) {
      content = friendlyDbError(err, 'work_open(kind="reminder")');
    }
    // ASK_USER is an instruction to the agent, not an error.
    return { content, isError };
  },

  async "work_update:status"({ agentId, args }) {
    let content = '';
    let isError = false;
    const updErr = checkRequired([
      { name: 'task_id', value: args.task_id, type: 'string' },
      { name: 'status', value: args.status, type: 'string' },
    ]);
    if (updErr) { content = updErr; isError = true; return { content, isError }; }
    const updateArgs: Record<string, unknown> = {
      taskId: args.task_id as string,
      status: args.status as string,
    };
    const statusNotes = noteWithReason(args.notes, args.reason);
    if (statusNotes) updateArgs.notes = statusNotes;
    if (args.resume_at) updateArgs.resume_at = args.resume_at;
    if (args.priority !== undefined) updateArgs.priority = args.priority;
    if (args.user_quote !== undefined) updateArgs.user_quote = args.user_quote;
    content = trackerUpdateStatus(agentId, updateArgs);
    return { content, isError: isError || content.startsWith('Refused:') };
  },

  async "work_update:hand_in"({ agentId, args }) {
    const raw = (args.task_id ?? args.project_id) as string | undefined;
    if (!raw) return { content: 'Error: hand_in needs the task_id (or project_id) of the work you are handing in.', isError: true };
    // A service agent's own housekeeping is off the board, so it is taken by its exact id.
    const r = args.task_id && isHousekeeping(String(args.task_id)) ? { ok: true as const, id: String(args.task_id) }
      : args.task_id ? resolveTaskId(String(args.task_id), agentId) : resolveProjectId(String(args.project_id), agentId);
    if (!r.ok) return { content: formatResolveError(args.task_id ? 'task' : 'project', raw, r), isError: true };
    await remeasureTask(agentId, r.id);
    const done = handIn({
      workId: r.id, by: { kind: 'worker', agentId }, outcome: outcomeOf(args),
      items: proofItemsOf(r.id, args.proof), note: noteWithReason(args.note, noteWithReason(args.notes, args.reason)) ?? '',
    });
    if (done.kind === 'handed_in') return { content: done.text, isError: false };
    const onRecord = proofFor(r.id).filter((i) => !judgedForItsRun(r.id, [i])).map((i) => `{kind:"${i.kind}", ref:"${i.ref}"}`);
    return { content: onRecord.length > 0 ? `${done.text}\nRecords on file for this work that you may cite as proof: ${onRecord.join(', ')}.` : done.text, isError: true };
  },

  async "work_note"({ agentId, args }) {
    let content = '';
    content = trackerAddNotes(agentId, {
      taskId: args.task_id as string,
      notes: args.notes as string,
    });
    return { content, isError: false };
  },

  async "work_update:edit"({ agentId, args }) {
    let content = '';
    let isError = false;
    // One `edit` discriminator covers both nouns: a project_id with no task_id edits the PROJECT.
    if (typeof args.project_id === 'string' && args.project_id.trim() && !args.task_id) {
      content = trackerEditProject(agentId, {
        project_id: args.project_id as string,
        title: args.title as string | undefined,
        description: args.description as string | null | undefined,
      });
      return { content, isError };
    }
    const editErr = checkRequired([
      { name: 'task_id', value: args.task_id, type: 'string' },
    ]);
    if (editErr) { content = editErr; isError = true; return { content, isError }; }
    // Forward every field the schema lists (snake_case passes through fine); the list IS
    // `WORK_EDITABLE_TASK_FIELDS`, the declaration the `Editable:` refusal renders from.
    const editArgs: Record<string, unknown> = {
      taskId: args.task_id as string,
    };
    for (const k of WORK_EDITABLE_TASK_FIELDS) {
      if (args[k] !== undefined) editArgs[k] = args[k];
    }
    // Three seeds that are NOT editable fields, kept OUT of `WORK_EDITABLE_TASK_FIELDS`
    // (which renders the `Editable:` refusal byte-for-byte). The wall-clock pair is an
    // alternative SPELLING converted before editable fields are read; `revert_to_original`
    // is an ACKNOWLEDGEMENT the guard still requires.
    for (const k of ['local_time', 'local_timezone', 'revert_to_original'] as const) {
      if (args[k] !== undefined) editArgs[k] = args[k];
    }
    // The day-of-week list on an existing task can change in place; create-side
    // validation is mirrored: specific_days needs at least one day.
    if (args.repeat_days_of_week !== undefined) {
      const normalizedDays = normalizeRepeatDaysOfWeek(args.repeat_days_of_week);
      if (normalizedDays === '__INVALID__') {
        content = 'Error: repeat_days_of_week contained no valid days. Accepted: sun/mon/tue/wed/thu/fri/sat or 0-6, or [] to clear.';
        isError = true;
        return { content, isError };
      }
      editArgs.repeat_days_of_week = normalizedDays; // string | null
    }
    // specific_days carries interval 1, as create does, so the schedule reads as repeating downstream.
    if (args.repeat_unit === 'specific_days' && editArgs.repeat_interval === undefined) editArgs.repeat_interval = 1;
    return editWithMeasure(agentId, args, Object.keys(editArgs).length > 1, () => trackerEditTask(agentId, editArgs));
  },

  async "work_update:get"({ agentId, args }) {
    let content = '';
    let isError = false;
    // Sibling tools take task_id / project_id; accept them as aliases, not warn-and-ignore.
    if (typeof args.id !== 'string') {
      const alias = args.task_id ?? args.project_id;
      if (typeof alias === 'string') args.id = alias;
    }
    const getErr = checkRequired([
      { name: 'id', value: args.id, type: 'string' },
    ]);
    if (getErr) { content = getErr; isError = true; return { content, isError }; }
    // The tool takes a single 'id' param, try as task first, then project
    const lookupId = args.id as string;
    content = trackerGetStatus(agentId, { taskId: lookupId, projectId: lookupId, offset: coerceNumberArg(args.offset) });   // pages the task's notes
    return { content, isError };
  },

  async "work_update:list"({ agentId, args }) {
    let content = '';
    const listFilter = args.filter as string | undefined;
    const verbose = args.verbose as boolean | undefined;
    if (listFilter === 'mine') {
      content = trackerListActive(agentId, { scope: 'tasks', assignedTo: agentId, verbose });
    } else if (listFilter === 'blocked') {
      content = trackerListActive(agentId, { scope: 'tasks', status: 'blocked', verbose });
    } else if (listFilter === 'overdue') {
      // Every declared enum value needs a branch: returning the UNFILTERED list fakes an answer.
      content = trackerListActive(agentId, { scope: 'tasks', filter: 'overdue', verbose });
    } else {
      content = trackerListActive(agentId, { scope: 'all', verbose });
    }
    return { content, isError: false };
  },

  // ── WHAT CHANGED OVER A WINDOW ───────────────────────────────
  // Its own door, not a flag on `list`: NOW and OVER-A-WINDOW are different questions, and a
  // flag lets one stand in for the other. `verbose` means the same as on `list`. Both window
  // properties are hand-forwarded; `activityWindowStart` owns an unusable `hours`, and the
  // report states the window it really measured.
  async "work_update:activity"({ agentId, args }) {
    const content = trackerActivity(
      agentId, { verbose: args.verbose === true }, activityWindowStart(args.hours),
    );
    return { content, isError: content.startsWith('Error') };
  },

  async "work_open:commitment"({ agentId, args }) {
    let content = '';
    let isError = false;
    const coErr = checkRequired([{ name: 'description', value: args.description, type: 'string' }]);
    if (coErr) { content = coErr; isError = true; return { content, isError }; }
    const coTurn = turnContext(agentId)?.turnNumber ?? null;
    if (coTurn === null) {
      // Origin is required on the spine, and a commitment's origin is the turn that made
      // it. Refusing here is honest; minting a row with a fabricated turn is not.
      content = 'Error: work_open(kind="commitment") can only be called inside a turn.';
      isError = true;
      return { content, isError };
    }
    const coRoot = turnContext(agentId)?.root ?? null;
    const coId = openCommitment({
      agentId,
      description: args.description as string,
      conversationId: coRoot?.conversationId ?? null,
      turnNumber: coTurn,
      sourceMessageId: coRoot?.sourceMessageId ?? null,
    });
    if (!coId) {
      content = 'Error: pass the promise you made as `description`.';
      isError = true;
      return { content, isError };
    }
    content = `[OK] Recorded: ${(args.description as string).trim()} — id ${coId}. It stays open until you deliver it or drop it.`;
    return { content, isError };
  },

  async "work_close_request:commitment"({ agentId, args }) {
    let content = '';
    let isError = false;
    const crErr = checkRequired([
      { name: 'id', value: args.id, type: 'string' },
      { name: 'disposition', value: args.disposition, type: 'string' },
    ]);
    if (crErr) { content = crErr; isError = true; return { content, isError }; }
    let crRow = findObligationByTypedId(agentId, args.id as string);
    // ── THE WITHDRAWAL HAS TO REACH THE ASK THE TURN IS HOLDING ──
    // `OWED_STATES` is right for the OPEN WORK block: it lists work owed and NOT being
    // worked, so the ask this turn serves is absent. A withdrawal lands exactly then, the
    // row already `claimed`, so the door looks that row up itself, narrowed three ways:
    // `dropped` only, `kind='ask'` only, claimed by this agent (the steer carries the id).
    if (!crRow && String(args.disposition) === 'dropped') {
      const typed = String(args.id ?? '').trim().replace(/^\[+|\]+$/g, '').toLowerCase();
      const claimedAsk = typed ? getDb().prepare(
        `SELECT w.id AS id, w.kind AS kind, w.title AS title, w.conversation_id AS conversationId,
                w.opened_at AS openedAt, w.state AS state
           FROM work w
          WHERE w.agent_id = ? AND w.kind = 'ask' AND w.state = 'claimed' AND lower(w.id) = ?
          LIMIT 1`,
      ).get(agentId, typed) as { id: string; kind: string; title: string | null } | undefined : undefined;
      if (claimedAsk) crRow = claimedAsk as unknown as typeof crRow;
    }
    if (!crRow) {
      // Steerable refusal naming the id's surface: a model may write to an id from a previous session.
      content = `Error: no open work matches "${String(args.id)}". Use an id exactly as shown in [brackets] in the OPEN WORK block; it may already be closed.`;
      isError = true;
      return { content, isError };
    }
    // ── THE ASK BRANCH IS NARROWED OUT ──
    // This tool is the agent's PROMISE LEDGER: commitments IT makes, closed by IT. It
    // reaches asks only because both share one obligation frame; an owner's ask is closed
    // by the record that answers it, never by the model. Refusals name what decides.
    //
    // ── ONE SHAPE IS ADMITTED, AND IT IS NOT A CLOSE ──
    //
    // `kept` on an ask is refused in the same words it always was; a withdrawn ask is the
    // shape no answer will ever arrive for. The withdrawal is admitted, and the model is
    // its actor because the engine may not read prose to decide the user called something
    // off, and the model is already the classifier through this door, with this vocabulary.
    //
    // It lands on `abandoned`, the board's user-choice terminal, NOT `done` and NOT `failed`;
    // `open -> abandoned` and `claimed -> abandoned` are declared transitions; reason = the user's words.
    const crNote = (args.note as string | undefined)?.trim() || null;
    if (crRow.kind === 'ask') {
      const inherited = inheritedAskDoor(crRow.id, String(args.disposition), crNote, agentId);   // the inherited-ask door decides first
      if (inherited) return inherited;
      if (String(args.disposition) !== 'dropped') {
        content = `Not closed: "${crRow.title ?? crRow.id}" is something the owner asked YOU for, not a `
          + 'promise you made. It closes itself the moment an answer is delivered for it — the '
          + 'delivery record is what marks it done, at send time and again when the turn ends. '
          + 'Answer it and it will tick off on its own; there is nothing to call here. If the '
          + 'user called it off instead, use disposition "dropped" with their own words as the note.';
        isError = true;
        return { content, isError };
      }
      if (!crNote) {
        // The note is the whole point: a withdrawal whose reason is not the
        // user's own words is the engine guessing.
        content = `Not dropped: pass \`note\` with what the person you are talking to actually said when they called `
          + `"${crRow.title ?? crRow.id}" off. The reason goes on the record.`;
        isError = true;
        return { content, isError };
      }
      // Only the person's own words call a request off: the owner's, or those of whoever sent it.
      const asked = getDb().prepare('SELECT sent_at, sender_id FROM messages WHERE id = (SELECT root_id FROM work WHERE id = ?)')
        .get(crRow.id) as { sent_at: number; sender_id: string | null } | undefined;
      if (!asked || !ownerSaidSince(asked.sent_at, normalizeQuote(crNote), agentId, { sender: asked.sender_id })) {
        content = 'Not dropped: quote what they said when they called it off, word for word, as the note.';
        isError = true;
        return { content, isError };
      }
      const withdrawn = dismissCommitment(crRow.id, { agentId, reason: `cancelled by the user: ${crNote}` });
      if (withdrawn.kind === 'applied') {
        content = `[OK] Dropped: ${crRow.title ?? crRow.id} — recorded as cancelled by the user, not answered.`;
      } else {
        content = `Error: could not drop ${crRow.id} (${withdrawn.kind}).`;
        isError = true;
      }
      return { content, isError };
    }
    if (String(args.disposition) === 'dropped') {
      const dr = dismissCommitment(crRow.id, {
        agentId, reason: crNote ?? 'no longer owed',
      });
      if (dr.kind === 'applied') content = `[OK] Dropped: ${crRow.title ?? crRow.id}.`;
      else { content = `Error: could not drop ${crRow.id} (${dr.kind}).`; isError = true; }
      return { content, isError };
    }
    // A promise is kept by DELIVERING it: the delivery is resolved from this turn's own
    // receipts, not the model's, so no argument can make an undelivered promise look kept.
    const crTurn = turnContext(agentId)?.turnNumber ?? null;
    const crDelivery = terminalDeliveryForTurn(agentId, crTurn, crRow.conversationId);
    const rr = resolveCommitment(crRow.id, {
      agentId, resultDeliveryId: crDelivery, note: crNote,
    });
    if (rr.kind === 'applied') {
      content = `[OK] Closed: ${crRow.title ?? crRow.id}.`;
    } else if (rr.kind === 'refused' && rr.reason === 'done-requires-delivery') {
      content = `Not closed: nothing was delivered for "${crRow.title ?? crRow.id}" on this turn, so it is still owed. Send it first, then call this again — or use disposition "dropped" if it is no longer owed.`;
      isError = true;
    } else {
      content = `Error: could not close ${crRow.id} (${rr.kind}).`;
      isError = true;
    }
    return { content, isError };
  },

  async "work_validate:decide"({ agentId, args }) {
    const err = checkRequired([
      { name: 'task_id', value: args.task_id, type: 'string' },
      { name: 'verdict', value: args.verdict, type: 'string' },
    ]);
    if (err) return { content: err, isError: true };
    const r = resolveAnyBoardId(String(args.task_id), agentId);
    if (!r.ok) return { content: r.text, isError: true };
    const out = decide({
      workId: r.id, deciderAgentId: agentId, verdict: String(args.verdict) as Verdict, reason: typeof args.reason === 'string' ? args.reason : '',
      ownerQuote: typeof args.user_quote === 'string' ? args.user_quote : undefined,
    });
    return { content: out.text, isError: out.kind === 'refused' };
  },

  async "work_validate:open_proof"({ agentId, args }) {
    const err = checkRequired([{ name: 'task_id', value: args.task_id, type: 'string' }]);
    if (err) return { content: err, isError: true };
    const r = resolveAnyBoardId(String(args.task_id), agentId);
    if (!r.ok) return { content: r.text, isError: true };
    const out = openProof(agentId, r.id, coerceNumberArg(args.item) ?? 0);
    return { content: out.text, isError: !out.ok };
  },

  async "work_validate:retask"({ agentId, args }) {
    const trErr = checkRequired([
      { name: 'task_id', value: args.task_id, type: 'string' },
      { name: 'directive', value: args.directive, type: 'string' },
    ]);
    if (trErr) return { content: trErr, isError: true };
    const content = await trackerRetask(agentId, {
      task_id: args.task_id as string,
      directive: args.directive as string,
      target_status: args.target_status as string | undefined,
      user_quote: args.user_quote,
    });
    return { content, isError: /^(Refused|Error):/.test(content) };
  },

  async "work_schedule:pause"({ agentId, args }) {
    let content = '';
    let isError = false;
    const tpsErr = pauseActionMissing(args) ?? checkRequired([{ name: 'task_id', value: args.task_id, type: 'string' }]);
    if (tpsErr) { content = tpsErr; isError = true; return { content, isError }; }
    content = trackerPauseSchedule(agentId, { taskId: args.task_id as string, resume_at: args.resume_at });
    return { content, isError: content.startsWith('Refused:') };
  },

  async "work_schedule:resume"({ agentId, args }) {
    let content = '';
    let isError = false;
    const trsErr = checkRequired([{ name: 'task_id', value: args.task_id, type: 'string' }]);
    if (trsErr) { content = trsErr; isError = true; return { content, isError }; }
    content = trackerResumeSchedule(agentId, { taskId: args.task_id as string });
    return { content, isError };
  },

  async "work_update:reassign"({ agentId, args }) {
    // THE REASSIGN DOOR IS A CALL INTO THE ROW-AUTHORITY GATE AND NOTHING ELSE: every
    // rule (who may move it, which cause: assignee_gone, coordination, user_requested,
    // never pace; blocked or declined work escalates to the owner) lives in
    // `work/row-authority.ts:moveAssignee`, which writes the row and records the move.
    const rawReassignTaskId = args.task_id as string;
    if (!rawReassignTaskId) return { content: 'Error: task_id is required', isError: true };
    const reassignResolved = resolveTaskId(rawReassignTaskId);
    if (!reassignResolved.ok) {
      return { content: formatResolveError('task', rawReassignTaskId, reassignResolved), isError: true };
    }
    const reassignTaskId = reassignResolved.id;
    const reassignDb = getDb();
    let newAgent = args.assigned_to as string | undefined;
    const newGroup = args.assigned_to_group as string | undefined;
    if (!newAgent && !newGroup) {
      return { content: 'Error: Provide either assigned_to (agent ID) or assigned_to_group (group ID)', isError: true };
    }
    if (newAgent && !newAgent.match(/^[0-9a-f]{8}-[0-9a-f]{4}-/)) {
      // A non-UUID reference: match the agent row by id or by its stored name, so a short id
      // like the main agent's works as well as a UUID. Live agents only.
      const lookup = reassignDb.prepare(
        `SELECT id FROM agents
           WHERE (id = ? OR name = ? COLLATE NOCASE)
             AND status != 'terminated'
           ORDER BY created_at DESC LIMIT 1`,
      ).get(newAgent, newAgent) as { id: string } | undefined;
      if (!lookup) {
        return {
          content: `Agent "${newAgent}" doesn't exist yet. Spawn them first with spawn_agent, then reassign. Or pass an existing agent's UUID directly.`,
          isError: true,
        };
      }
      newAgent = lookup.id;
    }
    if (!newAgent) {
      const member = groupMember(newGroup as string);
      if (!member.ok) return { content: member.error, isError: true };
      newAgent = member.id;
    }
    const moved = moveAssignee({
      taskId: reassignTaskId, by: 'agent', actorId: agentId,
      cause: args.cause, userQuote: args.user_quote, to: { agentId: newAgent },
      door: 'work_update(action="reassign")',
    });
    if (!moved.ok) return { content: moved.text, isError: true };
    const title = (reassignDb.prepare('SELECT title FROM work WHERE id = ?').get(reassignTaskId) as { title: string } | undefined)?.title ?? reassignTaskId;
    const agentName = (reassignDb.prepare('SELECT name FROM agents WHERE id = ?').get(newAgent) as { name: string } | undefined)?.name ?? newAgent;
    return { content: `Task "${title}" reassigned to ${agentName}${newGroup && !args.assigned_to ? ` from group ${newGroup}` : ''} (cause: ${moved.cause}).`, isError: false };
  },
};

// ── ONE RULE FOR "IS THIS AN ERROR" ──
// The error rule is stated once here for the whole table, so a handler added later
// gets it; a handler may still set `isError` itself for a refusal not starting with `Error`.
/** A close or verdict door READS the natural note-like argument a model puts on it instead
 * of refusing the whole call over it. `primary` is the door's own field; `extra` is the
 * sibling spelling kept beside it when both are given, so neither is silently lost. */
function noteWithReason(primary: unknown, extra: unknown): string | undefined {
  const parts = [primary, extra].filter((v): v is string => typeof v === 'string' && v.trim() !== '').map((v) => v.trim());
  if (parts.length === 2 && parts[0] === parts[1]) parts.pop();
  return parts.length ? parts.join('\n') : undefined;
}

export const trackerHandlers: ToolHandlerMap = Object.fromEntries(
  Object.entries(tableOfHandlers).map(([key, handler]) => [key, async (ctx) => {
    const out = await handler(ctx);
    return out.isError || !out.content.startsWith('Error') ? out : { ...out, isError: true };
  }]),
);
