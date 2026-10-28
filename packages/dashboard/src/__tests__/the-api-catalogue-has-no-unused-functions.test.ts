import { it, expect } from 'vitest';
import * as api from '../lib/api';
const GONE = ['setPassword','getProviderModels','getAllSettings','resetIdleSessions','getAgentInterMessages','getAgentHistory','sendAgentMessage','getVaultEntry','createVaultEntry','getContactApi','refreshPlaud','getProjectDetail','getTaskDetail','getCostRecords','getReport'];
it.each(GONE)('%s is not exported', (name) => { expect(Object.keys(api)).not.toContain(name); });
it('the live twins are still there', () => {
  for (const n of ['getChatHistory','sendMessage','getInterAgentMessages','listContactsApi','getVaultEntries','getTasks','getProjects','getSetting']) expect(Object.keys(api)).toContain(n);
});
