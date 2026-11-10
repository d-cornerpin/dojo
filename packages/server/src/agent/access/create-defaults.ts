// Dashboard create base: floor + Conversation Recall, separate so the floor itself never widens.

import type { AccessGrants } from '@dojo/shared';
import { MOST_RESTRICTIVE_GRANTS, cloneGrants } from '@dojo/shared';

export const DASHBOARD_DEFAULT_CATEGORIES = ['Conversation Recall'] as const;

export const DASHBOARD_CREATE_DEFAULT_GRANTS: AccessGrants = (() => {
  const floor = MOST_RESTRICTIVE_GRANTS.tools.categories;
  if (!Array.isArray(floor)) {
    // A '*' floor would make this a no-op on a false premise; failing at load beats a baffling default.
    throw new Error('MOST_RESTRICTIVE_GRANTS.tools.categories is no longer a list — ruling #4\'s default must be re-derived');
  }
  const grants = cloneGrants(MOST_RESTRICTIVE_GRANTS);
  const categories = [...floor];
  for (const label of DASHBOARD_DEFAULT_CATEGORIES) {
    if (!categories.includes(label)) categories.push(label);
  }
  grants.tools.categories = categories;
  return grants;
})();
