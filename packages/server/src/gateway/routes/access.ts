// ════════════════════════════════════════════════════════════════════════════
// THE ACCESS CATALOG (UX-ACCESS A3) — what the panel draws checkboxes FROM.
//
// The Access panel renders one checkbox per tool group, four preset buttons, and
// an inline warning when a channel is granted without the group its send tool
// lives in. All three of those facts live on the server — `TOOL_CATEGORIES` is a
// server module, the presets are built from it, and the channel⇄group coupling
// is derived from `SEND_TO_PEOPLE`. A copy in the dashboard would be a second
// truth that drifts the first time a tool is re-filed, which is the disease this
// overhaul exists to end. So the panel asks.
//
// READ-ONLY, and deliberately the only thing here: the grants themselves are
// read from `GET /agents/:id` (`effectiveGrants`, A2) and written through
// `PUT /agents/:id {grants}` (A2's validated door, with its audit row). A3 adds
// no second way to read or write an agent's access.
// ════════════════════════════════════════════════════════════════════════════

import { Hono } from 'hono';
import { TOOL_CATEGORIES } from '../../tools/categories.js';
import { ACCESS_PRESETS, channelToolGroupMap } from '../../agent/access/presets.js';
import { listTechniques } from '../../techniques/store.js';

export const accessRouter = new Hono();

// GET /catalog — the tool groups, the presets, the channel⇄group coupling, and
// (A4) the published techniques the grant section draws checkboxes from.
accessRouter.get('/catalog', (c) => {
  return c.json({
    ok: true,
    data: {
      // `tools` is a COUNT, not the list: the panel shows "16 tools" beside a
      // group name, and shipping 400 tool names to draw 38 checkboxes would be
      // payload nobody reads.
      categories: TOOL_CATEGORIES.map((cat) => ({ label: cat.label, tools: cat.tools.length })),
      presets: ACCESS_PRESETS.map((p) => ({
        id: p.id, label: p.label, description: p.description, grants: p.grants,
      })),
      channelGroups: channelToolGroupMap(),
      // UX-ACCESS A4. The panel's Techniques section needs two things the
      // dashboard cannot derive: which techniques EXIST to be granted, and
      // their names. It rides this route rather than `GET /api/techniques`
      // because the panel already fetches this one and the grant control and
      // the equip control must be drawn from the SAME list — offering an agent
      // a technique to equip that the grant section does not list is how the
      // two halves of one section start disagreeing.
      techniques: listTechniques({ state: 'published' }).map((t) => ({ id: t.id, name: t.name })),
    },
  });
});
