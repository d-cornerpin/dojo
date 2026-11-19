// v3.5 inspect B3 — the configuration and health page: every section present, and no key
// material from a seeded provider, config row or integration on it (REVIEW FOCUS 2).

import { describe, it, expect, beforeAll, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const h = vi.hoisted(() => ({ db: null as unknown, file: '' }));
vi.mock('../../db/connection.js', () => ({
  getDb: () => h.db, getReadOnlyDb: () => h.db, closeDb: () => {}, getDbPath: () => h.file,
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../db/migrations.js';
import { state, STATE_SECTIONS } from '../state.js';
import { seedTaskStory, at, sqlTime } from './seed.js';

const URL_PASSWORD = 'url-pass-synthetic-9911';
const CONFIG_KEY = 'sk-proj-SyntheticConfigValue000000000000';

let db: Database.Database;
beforeAll(() => {
  const dir = fs.mkdtempSync(path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'inspect-state-'));
  h.file = path.join(dir, 'dojo.db');
  db = new Database(h.file);
  h.db = db;
  runMigrations();
  seedTaskStory(db);
  db.prepare("INSERT INTO providers (id, name, type, base_url, auth_type, is_validated) VALUES ('prov-1', 'local box', 'ollama', ?, 'api_key', 1)")
    .run(`http://svc:${URL_PASSWORD}@llm.example.invalid:11434`);
  db.prepare("INSERT INTO models (id, provider_id, name, api_model_id, context_window, is_enabled) VALUES ('model-1', 'prov-1', 'small local', 'small:latest', 32768, 1)").run();
  db.prepare("UPDATE agents SET model_id = 'model-1' WHERE id = 'agent-primary'").run();
  // The migrations seed the three tiers; the light one gets this box's model.
  db.prepare("INSERT OR REPLACE INTO router_tier_models (tier_id, model_id, priority) VALUES ('light', 'model-1', 0)").run();
  const cfg = db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)');
  cfg.run('compaction_model_id', 'model-1');
  cfg.run('imessage_enabled', 'true');
  cfg.run('some_provider_api_key', CONFIG_KEY);
  for (let i = 0; i < 5; i++) cfg.run(`proactive_send_streak:agent-${i}`, String(i));
  db.prepare("INSERT OR REPLACE INTO budgets (id, scope, limit_usd, period) VALUES ('global_daily', 'global', 25, 'daily')").run();
  db.prepare('INSERT INTO healer_diagnostics (id, report, warning_count, created_at) VALUES (?, ?, 1, ?)')
    .run('diag-1', 'DIAGNOSTIC\n\nNEEDS ATTENTION:\n  1. One agent hit errors today\n     more detail here\n  2. A task is stuck\n', sqlTime(at(30)));
  db.prepare("INSERT INTO grant_rule (agent_id, effect_kind, mode, pattern, manifest_fingerprint) VALUES ('agent-primary', 'fs_read', 'allow', '*', 'f'), ('agent-primary', 'net', 'deny', 'example.invalid', 'f')").run();
  db.prepare("UPDATE work SET next_run_at = ?, schedule_status = 'waiting' WHERE id LIKE 'task9999%'").run(at(120));
});

describe('state', () => {
  it('names every section, each with its content', () => {
    const out = state(db);
    for (const s of STATE_SECTIONS) expect(out, s).toContain(`## ${s}`);
    expect(out).toMatch(/primary \(agent-pr\) · idle · apprentice · standard · model small local · grants 1 allow, 1 deny/);
    expect(out).toMatch(/local box \(ollama\) · validated · base http:\/\/svc:<redacted-credential>@llm\.example\.invalid:11434/);
    expect(out).toMatch(/small local \(small:latest\) · enabled · window 32,768/);
    expect(out).toMatch(/Light \(light\) · score up to 0 · small local/);
    expect(out).toMatch(/compaction_model_id: small local/);
    expect(out).toMatch(/a second piece \(task task9999\) · next 2026-10-19 11:00:00 UTC · waiting/);
    expect(out).toMatch(/global_daily · global · \$25 daily/);
    expect(out).toMatch(/imessage_enabled: true/);
    expect(out).toMatch(/1\. One agent hit errors today/);
    expect(out).toMatch(/2\. A task is stuck/);
  });

  it('REVIEW FOCUS 2: no key material from a provider, a config row or an integration', () => {
    const out = state(db);
    expect(out).not.toContain(URL_PASSWORD);
    expect(out).not.toContain(CONFIG_KEY);
    expect(out).toMatch(/some_provider_api_key: <redacted-credential>/);
  });

  it('fix round 1: a family of per-agent settings is one line with its count and how to read it', () => {
    const out = state(db);
    expect(out).toContain("- proactive_send_streak:* — 5 rows; read them with sql: select key, value from config where key like 'proactive_send_streak:%'");
    expect(out).not.toContain('proactive_send_streak:agent-3');
    expect(out).toMatch(/- platform_name: /);
  });
});
