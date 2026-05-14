// test/retry/launcher.test.ts
//
// Tests for src/retry/launcher.ts — launchClaude in print mode.
//
// All tests use an injectable spawn adapter so no real `claude` process is
// ever spawned. Tests cover:
//   - args forwarding (argv reaches the spawn adapter verbatim)
//   - exit-code propagation
//   - rate-limit → wait → retry path
//   - exhausted retries path

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { launchClaude, type SpawnAdapter, type SpawnResult } from '../../src/retry/launcher.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a SpawnAdapter that always returns the given result.
 * Captures every invocation in `calls` for assertion.
 */
function makeAdapter(
  results: SpawnResult[],
  calls: Array<{ argv: string[]; env: Record<string, string>; cwd: string }> = [],
): SpawnAdapter {
  let idx = 0;
  return async (argv, env, cwd) => {
    calls.push({ argv, env, cwd });
    const result = results[idx] ?? results[results.length - 1]!;
    idx++;
    return result;
  };
}

/** A clean exit result (no rate-limit text). */
function okResult(exitCode = 0, stdout = 'hello\n', stderr = ''): SpawnResult {
  return { stdout, stderr, exitCode };
}

/** A rate-limited result — stdout contains a typical rate-limit message. */
function rateLimitResult(exitCode = 1): SpawnResult {
  return {
    stdout: '',
    stderr: 'Claude Code usage limit reached; your limit will reset at 5pm (UTC)',
    exitCode,
  };
}

// ---------------------------------------------------------------------------
// Silence process.stdout/stderr writes during tests
// ---------------------------------------------------------------------------

let stdoutBuffer: string[] = [];
let stderrBuffer: string[] = [];
const origStdoutWrite = process.stdout.write.bind(process.stdout);
const origStderrWrite = process.stderr.write.bind(process.stderr);

beforeEach(() => {
  stdoutBuffer = [];
  stderrBuffer = [];
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdoutBuffer.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderrBuffer.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
    return true;
  }) as typeof process.stderr.write;
});

afterEach(() => {
  process.stdout.write = origStdoutWrite;
  process.stderr.write = origStderrWrite;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('launchClaude — args forwarding', () => {
  test('forwards args to spawn adapter verbatim after claude binary', async () => {
    const calls: Array<{ argv: string[]; env: Record<string, string>; cwd: string }> = [];
    const adapter = makeAdapter([okResult()], calls);

    await launchClaude({ args: ['-p', 'Hello world'], spawn: adapter });

    expect(calls.length).toBe(1);
    const call = calls[0]!;
    // argv[0] is the claude binary; [1..] are the forwarded args
    expect(call.argv.slice(1)).toEqual(['-p', 'Hello world']);
  });

  test('forwards --permission-mode bypassPermissions to spawn adapter', async () => {
    const calls: Array<{ argv: string[]; env: Record<string, string>; cwd: string }> = [];
    const adapter = makeAdapter([okResult()], calls);

    await launchClaude({
      args: ['--permission-mode', 'bypassPermissions', '/cam-next'],
      spawn: adapter,
    });

    expect(calls.length).toBe(1);
    const call = calls[0]!;
    expect(call.argv.slice(1)).toEqual(['--permission-mode', 'bypassPermissions', '/cam-next']);
  });

  test('sets CLAUDE_AUTO_RETRY_ACTIVE=1 in env', async () => {
    const calls: Array<{ argv: string[]; env: Record<string, string>; cwd: string }> = [];
    const adapter = makeAdapter([okResult()], calls);

    await launchClaude({ args: ['-p', 'test'], spawn: adapter });

    expect(calls[0]?.env['CLAUDE_AUTO_RETRY_ACTIVE']).toBe('1');
  });

  test('forwards empty args array (bare claude invocation)', async () => {
    const calls: Array<{ argv: string[]; env: Record<string, string>; cwd: string }> = [];
    const adapter = makeAdapter([okResult()], calls);

    await launchClaude({ args: [], spawn: adapter });

    expect(calls.length).toBe(1);
    expect(calls[0]!.argv.slice(1)).toEqual([]);
  });
});

describe('launchClaude — exit-code propagation', () => {
  test('returns 0 on successful run', async () => {
    const adapter = makeAdapter([okResult(0)]);
    const code = await launchClaude({ args: ['-p', 'test'], spawn: adapter });
    expect(code).toBe(0);
  });

  test('returns non-zero exit code from child on non-rate-limit failure', async () => {
    const adapter = makeAdapter([{ stdout: '', stderr: 'some error', exitCode: 42 }]);
    const code = await launchClaude({ args: ['-p', 'test'], spawn: adapter });
    expect(code).toBe(42);
  });

  test('replays stdout to process.stdout on clean exit', async () => {
    const adapter = makeAdapter([okResult(0, 'output text\n', '')]);
    await launchClaude({ args: ['-p', 'test'], spawn: adapter });
    expect(stdoutBuffer.join('')).toContain('output text');
  });

  test('replays stderr to process.stderr on clean exit', async () => {
    const adapter = makeAdapter([okResult(0, '', 'some warning\n')]);
    await launchClaude({ args: ['-p', 'test'], spawn: adapter });
    expect(stderrBuffer.join('')).toContain('some warning');
  });
});

describe('launchClaude — rate-limit retry path', () => {
  test('retries once after a rate-limit response then succeeds', async () => {
    const calls: Array<{ argv: string[]; env: Record<string, string>; cwd: string }> = [];
    // Patch setTimeout to not actually wait
    const origTimeout = globalThis.setTimeout;
    // @ts-expect-error patching for tests
    globalThis.setTimeout = (fn: () => void, _ms: number) => { fn(); return 0; };

    const adapter = makeAdapter(
      [rateLimitResult(), okResult(0, 'success\n')],
      calls,
    );

    const code = await launchClaude({ args: ['-p', 'test'], spawn: adapter });

    globalThis.setTimeout = origTimeout;

    expect(calls.length).toBe(2);
    expect(code).toBe(0);
    expect(stdoutBuffer.join('')).toContain('success');
  });

  test('prints [cam] rate-limit message to stderr on retry', async () => {
    const origTimeout = globalThis.setTimeout;
    // @ts-expect-error patching for tests
    globalThis.setTimeout = (fn: () => void, _ms: number) => { fn(); return 0; };

    const adapter = makeAdapter([rateLimitResult(), okResult(0)]);
    await launchClaude({ args: ['-p', 'test'], spawn: adapter });

    globalThis.setTimeout = origTimeout;

    const combined = stderrBuffer.join('');
    expect(combined).toMatch(/\[cam\] Rate limited/);
  });

  test('returns 1 when max retries are exhausted', async () => {
    const origTimeout = globalThis.setTimeout;
    // @ts-expect-error patching for tests
    globalThis.setTimeout = (fn: () => void, _ms: number) => { fn(); return 0; };

    // DEFAULT_CONFIG.maxRetries === 5; provide 6 rate-limit results
    const results = Array.from({ length: 6 }, () => rateLimitResult());
    const adapter = makeAdapter(results);

    const code = await launchClaude({ args: ['-p', 'test'], spawn: adapter });

    globalThis.setTimeout = origTimeout;

    expect(code).toBe(1);
    expect(stderrBuffer.join('')).toMatch(/retries exhausted/i);
  });
});

describe('launchClaude — cwd forwarding', () => {
  test('forwards custom cwd to spawn adapter', async () => {
    const calls: Array<{ argv: string[]; env: Record<string, string>; cwd: string }> = [];
    const adapter = makeAdapter([okResult()], calls);

    await launchClaude({ args: ['-p', 'test'], cwd: '/tmp/test-project', spawn: adapter });

    expect(calls[0]?.cwd).toBe('/tmp/test-project');
  });
});
