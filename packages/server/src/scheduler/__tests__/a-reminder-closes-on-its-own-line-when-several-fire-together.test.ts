// Several reminders the owner texted for fire within minutes and are worked in turns rooted on other things, as in
// the lived round. Each run closes on a line its own work made: the shop run on "Time to call the shop.", never on
// the stretch text another turn sent. A line a turn sent while it served two reminders is tied to both (ambiguous):
// it still counts as delivered, so no "finished without delivering anything to you" card ever follows. A line sent in a
// turn that served nothing on record is tied to no run: the run is undelivered, never handed in finished on it.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../agent/v2/loop.js', () => ({ runV2Turn: async () => {} }));
const box = await import('./helpers/reminders-box.js');
const { at, db, turn, line, reminder, openRun, runState, handIn, ghosts, checkScheduledTasks, closeRunsThatDelivered, otherTasksHint, freeCheckSays, decidedBy, lastHandIn } = box;
const { proofFor } = await import('../../work/done/proof.js');
const { cleanupStaleRuns } = await import('../runner.js');
const realNow = Date.now();

beforeAll(() => box.openBox());
afterAll(() => box.closeBox());

const tick = async (iso: string): Promise<void> => { at(iso); await checkScheduledTasks(); };
const tieOf = (task: string, delivery: string): unknown => proofFor(task).find((i) => i.ref === delivery)?.facts.tied;

describe('a reminder closes on its own line when several fire together', () => {
  it('the lived shop and stretch reminders: the shop run waits for its turn, closes on its own line and is decided by the free check; the stretch text is ambiguous for it', async () => {
    freeCheckSays(true);
    const day = '2026-03-02';
    at(`${day}T07:30:00Z`);
    const stretch = await reminder('Stretch reminder', `${day}T07:44:00Z`, 5, 3);
    const shop = await reminder('Shop call', `${day}T07:53:00Z`);
    const own = async (task: string, text: string): Promise<void> => {
      await turn({ kind: 'occurrence', id: openRun(task) }, () => { line(text, 'imessage'); });
      await closeRunsThatDelivered();
    };
    await tick(`${day}T07:44:25Z`); await own(stretch, 'Stretch break: stand up and move about.');
    await tick(`${day}T07:49:25Z`); await own(stretch, 'Stand up and stretch.');
    // A turn about step two of another job: the shop reminder fires in it, and it writes the reminder and hands it in.
    const stepTwo = await otherTasksHint(day);
    at(`${day}T07:53:20Z`);
    let shopLine = '';
    await turn(stepTwo, async () => {
      await checkScheduledTasks();
      shopLine = line('Time to call the shop.', 'dashboard');
      const r = await handIn(shop, shopLine); expect(r.isError, r.content).toBe(false);
      await closeRunsThatDelivered();
      expect(runState(shop).state, 'the turn that served the run is still running').toBe('open');
    });
    await closeRunsThatDelivered();
    await new Promise((r) => setTimeout(r, 50));
    expect(decidedBy(shop), 'the free check read the line as the reminder').toBe('engine');
    freeCheckSays(null);
    // The shop run's own turn sends the stretch text and hands the stretch reminder in on it.
    await tick(`${day}T07:54:25Z`);
    let stretchLine = '';
    await turn({ kind: 'occurrence', id: openRun(shop) }, async () => {
      stretchLine = line('Stand up and stretch.', 'imessage');
      const r = await handIn(stretch, stretchLine); expect(r.isError, r.content).toBe(false);
    });
    await closeRunsThatDelivered();
    expect(runState(shop)).toEqual({ state: 'done', result_delivery_id: shopLine });
    expect(runState(stretch)).toEqual({ state: 'done', result_delivery_id: stretchLine });
    expect(tieOf(shop, stretchLine), 'the turn served both reminders').toBe('ambiguous');
    expect(ghosts()).toBe(0);
  });

  it('a turn rooted on the shop run sends only the stretch text: the shop run counts it as delivered, and no card', async () => {
    const day = '2026-03-03';
    at(`${day}T07:30:00Z`);
    const shop = await reminder('Shop call', `${day}T07:54:00Z`);
    const stretch = await reminder('Stretch reminder', `${day}T07:54:00Z`);
    await tick(`${day}T07:54:25Z`);
    let stretchLine = '';
    await turn({ kind: 'occurrence', id: openRun(shop) }, async () => {
      stretchLine = line('Stand up and stretch.', 'imessage');
      expect((await handIn(stretch, stretchLine)).isError).toBe(false);
    });
    await closeRunsThatDelivered();
    expect(runState(shop)).toEqual({ state: 'done', result_delivery_id: stretchLine });
    expect(tieOf(shop, stretchLine)).toBe('ambiguous');
    expect(ghosts()).toBe(0);
  });

  it('both fire in one second and one turn sends both texts: both lines serve both, and neither run makes a card', async () => {
    const day = '2026-03-04';
    at(`${day}T07:30:00Z`);
    const cat = await reminder('Cat feeding', `${day}T07:44:00Z`);
    const stretch = await reminder('Stretch reminder', `${day}T07:44:00Z`);
    await tick(`${day}T07:44:25Z`);
    let catLine = '', stretchLine = '';
    await turn({ kind: 'occurrence', id: openRun(cat) }, async () => {
      catLine = line('Time to feed the cat.', 'imessage');
      stretchLine = line('Stand up and stretch.', 'imessage');
      expect((await handIn(stretch, stretchLine)).isError).toBe(false);
    });
    await closeRunsThatDelivered();
    expect([tieOf(cat, catLine), tieOf(cat, stretchLine)]).toEqual(['ambiguous', 'ambiguous']);
    expect(runState(cat), 'the newest line it shares closes it, for the free check to judge').toEqual({ state: 'done', result_delivery_id: stretchLine });
    expect(runState(stretch).state).toBe('done');
    expect(ghosts()).toBe(0);
  });

  it('five schedules within five minutes, worked in turns rooted on other things as lived: no card', async () => {
    const day = '2026-03-05';
    at(`${day}T07:35:00Z`);
    const status = await reminder('status note', `${day}T07:40:00Z`, 10);
    const cat = await reminder('Cat feeding', `${day}T07:44:00Z`);
    const stretch = await reminder('Stretch reminder', `${day}T07:44:00Z`, 5, 3);
    const water = await reminder('Plant watering', `${day}T07:52:00Z`);
    const shop = await reminder('Shop call', `${day}T07:53:00Z`);
    const own = async (task: string, text: string): Promise<void> => { await turn({ kind: 'occurrence', id: openRun(task) }, () => { line(text, 'imessage'); }); await closeRunsThatDelivered(); };

    await tick(`${day}T07:40:30Z`); await own(status, 'Status: two lists finished.');
    await tick(`${day}T07:44:25Z`);
    await turn({ kind: 'occurrence', id: openRun(cat) }, () => { line('Time to feed the cat.', 'imessage'); line('Stand up and stretch.', 'imessage'); });
    await closeRunsThatDelivered();
    await own(stretch, 'Stretch break: stand up and move about.');
    await tick(`${day}T07:49:25Z`); await own(stretch, 'Stand up and stretch.');
    await tick(`${day}T07:50:30Z`); await own(status, 'Status: three lists finished.');
    await tick(`${day}T07:52:25Z`);
    await turn(null, async () => { expect((await handIn(water, line('Water the plants.', 'dashboard'))).isError).toBe(false); });
    await closeRunsThatDelivered();
    await own(water, 'Time to water the plants.');
    await tick(`${day}T07:53:25Z`);
    await turn(null, async () => { expect((await handIn(shop, line('Time to call the shop.', 'dashboard'))).isError).toBe(false); });
    await closeRunsThatDelivered();
    await tick(`${day}T07:54:25Z`);
    await turn({ kind: 'occurrence', id: openRun(shop) }, async () => { expect((await handIn(stretch, line('Stand up and stretch.', 'imessage'))).isError).toBe(false); });
    await closeRunsThatDelivered();
    await own(shop, 'Shop o\'clock: time to call them.');
    expect(ghosts()).toBe(0);
    expect([cat, water, shop].map((t) => runState(t).state)).toEqual(['done', 'done', 'done']);
  });

  it('its only line was sent in a turn that served nothing on record: undelivered, one card, never a finished hand-in on it', async () => {
    const T0 = Math.floor(realNow / 60_000) * 60_000;   // the stale sweep reads rows SQLite stamps on its own clock
    const min = (m: number): string => new Date(T0 + m * 60_000).toISOString();
    at(min(0));
    const shop = await reminder('Shop call', min(5));
    await tick(min(5.5));
    const run = openRun(shop);
    await turn(null, () => { line('Time to call the shop.', 'dashboard'); });
    await closeRunsThatDelivered();
    expect(runState(shop).state, 'no turn tied the line to the run').toBe('open');
    at(min(40));
    cleanupStaleRuns();
    const cards = (): unknown => db().prepare("SELECT COUNT(*) AS n FROM work_events WHERE kind = 'floor_ghosted' AND work_id IN (?, ?)").get(run, shop);
    await vi.waitFor(() => expect(cards()).toEqual({ n: 1 }));
    expect(runState(shop).result_delivery_id).toBeNull();
    expect(lastHandIn(shop)).not.toBe('finished');
  });
});
