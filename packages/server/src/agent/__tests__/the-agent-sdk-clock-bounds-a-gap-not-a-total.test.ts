// ════════════════════════════════════════════════════════════════════════════════════
// t114 (CENSUS ROW 35) — THE AGENT-SDK CLOCK BOUNDS A GAP, NOT A TOTAL.
//
// T81d gave this transport its first clock. The clock it gave it was the wrong SHAPE: a
// `setTimeout` armed ONCE at dial, which nothing ever bumped. The `for await` loop received
// content and called `onChunk` throughout and never touched the timer, so a call that was
// streaming perfectly was aborted the moment its wall-clock TOTAL hit the bound. That is the
// precise mechanism census row 7 was closed for, reborn on a different transport — and worse in
// one respect, because it arms only for a row that DECLARED its patience. The owner who set 600s
// after a slow box got `bodyTimeoutMs = 630_000` and had his healthy 700-second generation
// killed mid-sentence. Row 7's own amendment had already written the verdict: "a declared 600s
// row would still murder a healthy 700s generation. Config could not have fixed it."
//
// The T81d tests pinned the error TYPE and the first-chunk-vs-idle RECONSTRUCTION — the
// reporting, not the bound. Nothing bumped the timer; nothing asserted it re-armed. Hence this
// file, and hence the standing order's two directions:
//
//   §1 HEALTHY WORK DRIVEN THROUGH THE WINDOW MUST SURVIVE. A stream whose TOTAL duration is
//      several times the declared bound, but whose every inter-chunk GAP is comfortably inside
//      it, must complete with all of its content. This is the clause the defect fails.
//
//   §2 DEAD WORK MUST STILL BE KILLED, LOUDLY AND HONESTLY. Silence longer than the bound still
//      trips, still throws the TYPE `model.ts` structurally detects, still carries the
//      first-chunk-vs-idle fact — and now names the bound that actually expired.
//
//   §3 CONTROLS: a NULL row still arms no clock at all (R6 byte-preservation — this transport
//      had no clock before T81d, so "unchanged" means no `abortController` key), and the gap
//      bound is genuinely a bound rather than an unbounded renewal.
//
// Millisecond scale throughout, real timers, no waiting out `resolveTransportTimeouts`'s floor.
// ════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * The SDK is mocked module-wide. `mode` picks the generator shape; `chunks` and `gapMs` drive
 * the one that matters here — a stream that keeps delivering, slowly, for longer in total than
 * any single gap. Every `query()` call is recorded so a clause can inspect the `options` built.
 */
const agentSdk = vi.hoisted(() => ({
  queryCalls: [] as Array<{ prompt: string; options: Record<string, unknown> }>,
  mode: 'answer' as 'answer' | 'slow-stream' | 'stall' | 'stall-after-content' | 'noncontent-keepalive',
  chunks: 8,
  gapMs: 25,
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (args: { prompt: string; options: Record<string, unknown> }) => {
    agentSdk.queryCalls.push(args);
    const controller = args.options.abortController as AbortController | undefined;

    /** Reject as the SDK does when our controller fires; resolve after `ms` otherwise. */
    const waitOrAbort = (ms: number) => new Promise<void>((resolve, reject) => {
      if (controller?.signal.aborted) { reject(new Error('The operation was aborted.')); return; }
      const t = setTimeout(resolve, ms);
      controller?.signal.addEventListener('abort', () => {
        clearTimeout(t);
        reject(new Error('The operation was aborted.'));
      }, { once: true });
    });

    if (agentSdk.mode === 'noncontent-keepalive') {
      // ONE content delta, then a run of NON-CONTENT messages, then a final delta. Only the
      // loop-head `bumpGap()` re-arms on these; `noteContent` never sees them. The whole run
      // outlives the bound several times over, so if the loop head stops bumping this dies.
      return (async function* nonContentKeepalive() {
        await waitOrAbort(agentSdk.gapMs);
        yield {
          type: 'stream_event',
          event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'start ' } },
        };
        for (let i = 0; i < agentSdk.chunks; i += 1) {
          await waitOrAbort(agentSdk.gapMs);
          // A real SDK emits plenty of these: ping/keepalive frames, block starts and stops,
          // message_delta usage updates. None of them carry generated text.
          yield { type: 'stream_event', event: { type: 'ping' } };
        }
        await waitOrAbort(agentSdk.gapMs);
        yield {
          type: 'stream_event',
          event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'end' } },
        };
      })();
    }

    if (agentSdk.mode === 'slow-stream') {
      // THE HEALTHY LONG CALL. Each gap is `gapMs`; the TOTAL is `chunks * gapMs`. With the
      // bound set between the two, a gap-shaped clock survives this and a total-shaped clock
      // cannot.
      return (async function* slowStream() {
        for (let i = 0; i < agentSdk.chunks; i += 1) {
          await waitOrAbort(agentSdk.gapMs);
          yield {
            type: 'stream_event',
            event: { type: 'content_block_delta', delta: { type: 'text_delta', text: `tok${i} ` } },
          };
        }
      })();
    }

    if (agentSdk.mode === 'stall' || agentSdk.mode === 'stall-after-content') {
      return (async function* stall() {
        if (agentSdk.mode === 'stall-after-content') {
          yield {
            type: 'assistant',
            message: { content: [{ type: 'text', text: 'Working on it' }], usage: {} },
          };
        }
        await new Promise<void>((_resolve, reject) => {
          if (!controller) return; // no bound armed: a stall would hang for ever, as today
          if (controller.signal.aborted) { reject(new Error('The operation was aborted.')); return; }
          controller.signal.addEventListener(
            'abort',
            () => reject(new Error('The operation was aborted.')),
            { once: true },
          );
        });
        // eslint-disable-next-line no-unreachable
        yield undefined as never;
      })();
    }

    return (async function* answer() {
      yield {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'It is done.' }],
          usage: { input_tokens: 3, output_tokens: 4 },
        },
      };
    })();
  },
}));

vi.mock('../../home.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  const dir = p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-t114-sdk-gap');
  return {
    homeDir: (): string => dir,
    dojoDir: (...segs: string[]): string => p.join(dir, '.dojo', ...segs),
    isTestRun: (): boolean => true,
  };
});

import { callAnthropicViaSdk, AgentSdkPatienceExceededError } from '../../providers/anthropic-sdk.js';

const BASE = {
  agentId: 'quill',
  apiModelId: 'sonnet',
  systemPrompt: 'you are an assistant',
  messages: [{ role: 'user', content: 'hi' }],
};

beforeEach(() => {
  agentSdk.queryCalls.length = 0;
  agentSdk.mode = 'answer';
  agentSdk.chunks = 8;
  agentSdk.gapMs = 25;
});

describe('§1 a healthy stream that outlives the bound in TOTAL survives', () => {
  it('THE RED: 8 chunks × 25ms = ~200ms total under a 90ms bound completes, with all content', async () => {
    agentSdk.mode = 'slow-stream';
    agentSdk.chunks = 8;
    agentSdk.gapMs = 25;

    // 90ms bound: every GAP (25ms) is well inside it; the TOTAL (~200ms) is more than double it.
    // A flat total-duration timer aborts this at 90ms, roughly a third of the way through.
    const result = await callAnthropicViaSdk({ ...BASE, timeoutMs: 90, idleTimeoutMs: 90 });

    expect(result.content, 'every chunk the model streamed must be in the answer')
      .toBe('tok0 tok1 tok2 tok3 tok4 tok5 tok6 tok7 ');
  });

  it('the owner\'s configured row is the one the defect punished: a long declared bound still streams', async () => {
    // The hurt scenario in miniature — a row that DECLARED patience, which is the only kind that
    // armed the timer at all. Twelve chunks, ~360ms total, 120ms bound.
    agentSdk.mode = 'slow-stream';
    agentSdk.chunks = 12;
    agentSdk.gapMs = 30;

    const result = await callAnthropicViaSdk({ ...BASE, timeoutMs: 120, idleTimeoutMs: 120 });

    expect(result.content.split(' ').filter(Boolean), 'all twelve tokens arrive').toHaveLength(12);
  });

  it('the FIRST-CHUNK bound covers a long prefill, then the idle bound governs the rest', async () => {
    // A slow prefill (one long wait before any content) followed by brisk tokens — the shape a
    // local box actually produces. The first gap is bounded by `timeoutMs`, every later gap by
    // `idleTimeoutMs`, and a much smaller idle bound must not retroactively kill the prefill.
    agentSdk.mode = 'slow-stream';
    agentSdk.chunks = 4;
    agentSdk.gapMs = 40;

    const result = await callAnthropicViaSdk({ ...BASE, timeoutMs: 100, idleTimeoutMs: 100 });

    expect(result.content).toContain('tok3');
  });

  it('a stream of NON-CONTENT messages between content gaps keeps the call alive', async () => {
    // THE REVIEW'S MINOR 1. §1's own comment claims "ANY message is evidence of life", but every
    // clause above re-armed through `noteContent` — so removing the loop-head `bumpGap()` left the
    // probe 8/8 green and the documented property unpinned. The reviewer's sharper mutant found
    // that; this clause closes it.
    //
    // Six pings 25ms apart plus two content deltas: ~200ms total against a 90ms bound, with every
    // gap inside it. `noteContent` fires only twice — at the start and the end — so the middle of
    // this stream is kept alive by the loop head and nothing else.
    agentSdk.mode = 'noncontent-keepalive';
    agentSdk.chunks = 6;
    agentSdk.gapMs = 25;

    const result = await callAnthropicViaSdk({ ...BASE, timeoutMs: 90, idleTimeoutMs: 90 });

    expect(result.content, 'the call survived on non-content messages alone').toBe('start end');
  });
});

describe('§2 dead work still trips the clock, loudly and honestly', () => {
  it('THE OTHER DIRECTION: silence longer than the bound still aborts, with the TYPE', async () => {
    agentSdk.mode = 'stall';

    const err = await callAnthropicViaSdk({ ...BASE, timeoutMs: 50, idleTimeoutMs: 50 })
      .catch((e: unknown) => e);

    expect(err, 'a silent call must still be cut, never hang').toBeInstanceOf(AgentSdkPatienceExceededError);
    expect((err as AgentSdkPatienceExceededError).sawAnyContent, 'nothing was yielded before the trip').toBe(false);
    expect((err as Error).message, 'the cut is NAMED, not a bare abort').toMatch(/declared patience/i);
  });

  it('a stream that goes quiet MID-ANSWER trips on the idle bound and says content was seen', async () => {
    agentSdk.mode = 'stall-after-content';

    const err = await callAnthropicViaSdk({ ...BASE, timeoutMs: 400, idleTimeoutMs: 50 })
      .catch((e: unknown) => e);

    expect(err, 'a mid-answer stall is still cut').toBeInstanceOf(AgentSdkPatienceExceededError);
    expect((err as AgentSdkPatienceExceededError).sawAnyContent, 'the model had started answering').toBe(true);
    // THE HONEST NUMBER: the bound that actually expired was the IDLE one (50ms), not the
    // first-chunk one (400ms). While the clock was a single flat total this distinction did not
    // exist; now that the two differ, reporting the wrong one would misname the failure.
    expect((err as AgentSdkPatienceExceededError).timeoutMs, 'the reported bound is the gap that expired').toBe(50);
    expect((err as Error).message).toMatch(/50ms/);
  });
});

describe('§3 controls — the bound is still a bound, and a NULL row still has no clock', () => {
  it('CONTROL: the gap clock is not an unbounded renewal — a gap LONGER than the bound trips', async () => {
    // The failure mode a re-arming timer must not introduce: if every chunk bought unlimited
    // further time, a wedged provider dribbling one token an hour would never be cut. Chunks
    // 60ms apart under a 25ms bound must die on the first gap.
    agentSdk.mode = 'slow-stream';
    agentSdk.chunks = 8;
    agentSdk.gapMs = 60;

    const err = await callAnthropicViaSdk({ ...BASE, timeoutMs: 25, idleTimeoutMs: 25 })
      .catch((e: unknown) => e);

    expect(err, 'a gap wider than the bound is still a kill').toBeInstanceOf(AgentSdkPatienceExceededError);
  });

  it('CONTROL: a NULL row arms no clock at all — no abortController reaches query()', async () => {
    agentSdk.mode = 'answer';

    const result = await callAnthropicViaSdk({ ...BASE, timeoutMs: null, idleTimeoutMs: null });

    expect(result.content).toBe('It is done.');
    expect(agentSdk.queryCalls.at(-1)!.options, 'an undeclared row gets no bound, as before')
      .not.toHaveProperty('abortController');
  });

  it('CONTROL: a single-bound caller still works — idleTimeoutMs falls back to timeoutMs', async () => {
    agentSdk.mode = 'stall';

    const err = await callAnthropicViaSdk({ ...BASE, timeoutMs: 40 }).catch((e: unknown) => e);

    expect(err, 'omitting the idle bound must not disarm the clock').toBeInstanceOf(AgentSdkPatienceExceededError);
  });
});
