// A cloud credential file the main agent prints through the shell comes back with its secret values
// blanked: an AWS credentials file, a Google service-account key and a kube config. Made-up contents only.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

const MAIN = 'agent-main';
const home = fs.mkdtempSync(path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'cloud-blank-'));
vi.stubEnv('DOJO_HOME', home);
const FILES: Record<string, { body: string; secrets: string[]; kept: string }> = {
  aws: {
    body: '[default]\naws_access_key_id = AKIAFAKEEXAMPLE0042\naws_secret_access_key = zq7FakeAwsSecret/K7MDENGbPxRfiCYEXAMPLE\naws_session_token = zq7FakeSessionTok3nValue0042abc\nregion = us-east-1\n',
    secrets: ['zq7FakeAwsSecret/K7MDENGbPxRfiCYEXAMPLE', 'zq7FakeSessionTok3nValue0042abc'],
    kept: 'region = us-east-1',
  },
  gcloud: {
    body: JSON.stringify({ type: 'service_account', project_id: 'example-project', private_key: '-----BEGIN PRIVATE KEY-----\nMIIEvQzq7fakeGoogleKeyBody\n-----END PRIVATE KEY-----\n', client_email: 'robot@example.com' }, null, 2),
    secrets: ['MIIEvQzq7fakeGoogleKeyBody'],
    kept: 'example-project',
  },
  kube: {
    body: 'apiVersion: v1\nusers:\n- name: admin\n  user:\n    token: zq7FakeKubeToken0042abcdef\n    client-key-data: LS0tzq7FakeClientKeyData0042\nclusters:\n- name: example\n',
    secrets: ['zq7FakeKubeToken0042abcdef', 'LS0tzq7FakeClientKeyData0042'],
    kept: 'name: example',
  },
};
for (const [name, f] of Object.entries(FILES)) fs.writeFileSync(path.join(home, `${name}.txt`), f.body);

const connection = await import('../../../db/connection.js');
const migrations = await import('../../../db/migrations.js');
const platform = await import('../../../config/platform.js');
const { executeTool, toolResultOf } = await import('../index.js');

beforeAll(() => {
  migrations.runMigrations();
  connection.getDb().prepare("INSERT INTO agents (id, name, status, config, classification, permissions) VALUES (?, 'main', 'idle', '{}', 'sensei', NULL)").run(MAIN);
  connection.getDb().prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('primary_agent_id', ?)").run(MAIN);
  platform.clearPlatformConfigCache();
});

afterAll(() => {
  connection.closeDb();
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

describe('a cloud credential file is blanked in command output', () => {
  it.each(Object.keys(FILES))('%s', async (name) => {
    const text = toolResultOf(await executeTool(MAIN, { id: `call-${name}`, name: 'shell', arguments: { script: `cat "${path.join(home, `${name}.txt`)}"` } })).content;
    for (const secret of FILES[name].secrets) expect(text).not.toContain(secret);
    expect(text).toContain(FILES[name].kept);
  });
});
