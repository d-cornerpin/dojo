import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  TELEMETRY_WHITELIST, TELEMETRY_SCHEMA_VERSION, UNRECOGNISED, enumMembers,
} from '../telemetry-whitelist.js';
import { buildTelemetry, type TelemetrySources } from '../telemetry-build.js';

const KINDS = ['enum', 'count', 'millis', 'bytes', 'timestamp', 'ordinal', 'bool', 'version', 'digest'];

function sources(over: Partial<TelemetrySources> = {}): TelemetrySources {
  return {
    reportId: 'rep_test', createdAt: '2026-09-23T10:00:00.000Z', signature: 'ds1-000000000000',
    lane: 'tool-error', platformVersion: '3.1.28', osPlatform: 'darwin', nodeMajor: 22,
    windowMinutes: 30, windowTurns: 4, windowTruncated: false,
    turns: [], calls: [], toolCalls: [], work: [],
    settings: {
      providerKind: 'ollama', behavesLike: null, firstChunkTimeoutMs: null, streamIdleTimeoutMs: null,
      maxUnattendedMinutes: null, prefillTokensPerSec: null, toolsGrantedCount: 12,
      contextReceiptMode: 'off',
    },
    ...over,
  };
}

describe('(1) the whitelist cannot express free text', () => {
  it('declares no kind outside the closed union, and the union has no text member', () => {
    expect(KINDS).not.toContain('text');
    for (const f of TELEMETRY_WHITELIST) expect(KINDS).toContain(f.kind);
  });

  it('gives every enum field exactly one member source', () => {
    for (const f of TELEMETRY_WHITELIST.filter(x => x.kind === 'enum')) {
      const inline = f.members !== undefined;
      const derived = f.membersFrom !== undefined;
      expect(inline !== derived, `${f.path} must declare exactly one of members/membersFrom`).toBe(true);
      if (inline) expect(f.members!.length, `${f.path} declares an empty member list`).toBeGreaterThan(0);
    }
  });

  it('names a platform source for every field, and never a forbidden one', () => {
    // `audit_log.target` and `audit_log.detail` are platform-authored prose that interpolates
    // the user's file paths (agent/tools/cat/fs.ts:198-268). They are never a telemetry source.
    const FORBIDDEN = ['audit_log.target', 'audit_log.detail', 'messages.content',
      'providers.name', 'agents.name', 'work.title', 'scratchpad'];
    for (const f of TELEMETRY_WHITELIST) {
      expect(f.source.length).toBeGreaterThan(0);
      for (const bad of FORBIDDEN) {
        expect(f.source.includes(bad), `${f.path} names forbidden source ${bad}`).toBe(false);
      }
    }
  });

  it('has unique, dotted, lowercase paths', () => {
    const seen = new Set<string>();
    for (const f of TELEMETRY_WHITELIST) {
      expect(seen.has(f.path), `duplicate path ${f.path}`).toBe(false);
      seen.add(f.path);
      expect(f.path).toMatch(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/);
    }
  });
});

describe('(2) the builder takes no agent input and can reach nothing', () => {
  it('imports nothing that can reach the db, the disk, the network or an agent', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'telemetry-build.ts'), 'utf8');
    const imports = [...src.matchAll(/^import[^;]*from\s+'([^']+)'/gm)].map(m => m[1]);
    for (const spec of imports) {
      expect(
        /node:fs|node:http|node:net|node:child_process|\/db\/|\/agent\/|better-sqlite3|undici|connection/.test(spec),
        `telemetry-build.ts imports ${spec}`,
      ).toBe(false);
    }
  });

  it('emits only whitelisted keys', () => {
    const out = buildTelemetry(sources({
      turns: [{ kind: 'user', subjectKind: 'conv', lane: null, exitReason: 'brake',
                answered: false, effectfulCalls: 2, durationMs: 4100 }],
    }));
    const paths = new Set(TELEMETRY_WHITELIST.map(f => f.path));
    const walk = (node: unknown, prefix: string): void => {
      if (Array.isArray(node)) { for (const el of node) walk(el, prefix); return; }
      if (node === null || typeof node !== 'object') return;
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        const p = prefix ? `${prefix}.${k}` : k;
        if (v !== null && typeof v === 'object') { walk(v, p); continue; }
        // array-of-record sections are declared singular in the whitelist
        const singular = p.replace(/^turns\./, 'turn.').replace(/^calls\./, 'call.')
          .replace(/^tools\./, 'tool.').replace(/^work\./, 'work.');
        expect(paths.has(singular), `emitted un-whitelisted key ${p}`).toBe(true);
      }
    };
    walk(out, '');
    expect((out.report as Record<string, unknown>).schema).toBe(TELEMETRY_SCHEMA_VERSION);
  });
});

describe('(3) an unrecognised value fails CLOSED, it does not pass through', () => {
  it('replaces an off-list enum value with the sentinel, never the value', () => {
    const out = buildTelemetry(sources({
      turns: [{ kind: 'user', subjectKind: 'conv', lane: null,
                exitReason: 'exploded_spectacularly_/Users/dave/taxes.pdf',
                answered: false, effectfulCalls: 0, durationMs: 1 }],
    }));
    const turn = (out.turns as Record<string, unknown>[])[0];
    expect(turn.exit_reason).toBe(UNRECOGNISED);
    expect(JSON.stringify(out)).not.toContain('taxes.pdf');
    expect(JSON.stringify(out)).not.toContain('/Users/dave');
  });

  it('replaces an unregistered tool name and an undeclared arg key with the sentinel', () => {
    const out = buildTelemetry(sources({
      toolCalls: [{
        name: 'definitely_not_a_real_tool', actionType: 'tool_call', result: 'error',
        argShape: [{ key: 'mothers_maiden_name', type: 'string', bytes: 11 }],
        argsTotalBytes: 40, failureHitCount: 3,
      }],
    }));
    const tool = (out.tools as Record<string, unknown>[])[0];
    expect(tool.name).toBe(UNRECOGNISED);
    expect((tool.arg_shape as Record<string, unknown>[])[0].key).toBe(UNRECOGNISED);
    expect(JSON.stringify(out)).not.toContain('mothers_maiden_name');
  });

  it('keeps a REAL tool name and a REAL declared arg key', () => {
    const out = buildTelemetry(sources({
      toolCalls: [{
        name: 'load_tool_docs', actionType: 'tool_call', result: 'success',
        argShape: [{ key: 'tools', type: 'array', bytes: 24 }],
        argsTotalBytes: 32, failureHitCount: 0,
      }],
    }));
    const tool = (out.tools as Record<string, unknown>[])[0];
    expect(tool.name).toBe('load_tool_docs');
    expect((tool.arg_shape as Record<string, unknown>[])[0].key).toBe('tools');
  });

  it('nulls a non-finite number rather than emitting it', () => {
    const out = buildTelemetry(sources({
      calls: [{ providerKind: 'ollama', modelOrdinal: 0, requestType: 'agent_turn',
                inputTokens: Number.NaN, outputTokens: -5, cacheReadTokens: 0,
                cacheCreationTokens: 0, latencyMs: Infinity, inputTokensEstimated: false }],
    }));
    const call = (out.calls as Record<string, unknown>[])[0];
    expect(call.input_tokens).toBeNull();
    expect(call.output_tokens).toBeNull();
    expect(call.latency_ms).toBeNull();
  });
});

describe('(4) enumMembers reads the live platform, not a frozen copy', () => {
  it('derives tool names from the running registry', () => {
    const f = TELEMETRY_WHITELIST.find(x => x.path === 'tool.name')!;
    const members = enumMembers(f);
    expect(members).toContain('load_tool_docs');
    expect(members.length).toBeGreaterThan(50);
  });
});
