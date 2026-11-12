// Access catalog: the tool groups, presets and channel-group coupling the Access panel draws from.

import { Hono } from 'hono';
import { TOOL_CATEGORIES } from '../../tools/categories.js';
import { ACCESS_PRESETS, channelToolGroupMap } from '../../agent/access/presets.js';
import { listTechniques } from '../../techniques/store.js';

export const accessRouter = new Hono();

accessRouter.get('/catalog', (c) => {
  return c.json({
    ok: true,
    data: {
      // `tools` is a count only; the panel shows the number beside each group name.
      categories: TOOL_CATEGORIES.map((cat) => ({ label: cat.label, tools: cat.tools.length })),
      presets: ACCESS_PRESETS.map((p) => ({
        id: p.id, label: p.label, description: p.description, grants: p.grants,
      })),
      channelGroups: channelToolGroupMap(),
      // Techniques ride this route so the grant and equip controls are drawn from one list.
      techniques: listTechniques({ state: 'published' }).map((t) => ({ id: t.id, name: t.name })),
    },
  });
});
