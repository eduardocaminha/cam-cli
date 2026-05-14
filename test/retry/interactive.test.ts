// test/retry/interactive.test.ts
//
// Tests for US-005: interactive mode (forkMonitor) and the non-tmux error path.
//
// All tests use injectable adapters — no real Bun.spawn, no real tmux, no real
// claude process is ever invoked.

import { describe, expect, test } from 'bun:test';
import {
  forkMonitor,
  validateInteractiveEnv,
  type DetachedSpawnAdapter,
  type SignalHandler,
} from '../../src/retry/launcher.ts';
import {
  parseRetryMonitorArgs,
  runRetryMonitor,
} from '../../src/commands/retry-monitor.ts';
import { runClaude } from '../../src/commands/claude.ts';

// ---------------------------------------------------------------------------
// forkMonitor — detached spawn adapter verification
// ---------------------------------------------------------------------------

describe('forkMonitor — detached spawn', () => {
  test('calls detachedSpawn with argv ending in retry-monitor <pane> <pid>', () => {
    const spawnCalls: string[][] = [];
    const fakeDetachedSpawn: DetachedSpawnAdapter = (argv) => {
      spawnCalls.push(argv);
      return 0;
    };
    const fakeOnSignal: SignalHandler = (_sig, _fn) => { /* no-op */ };

    forkMonitor({
      args: ['/cam-next'],
      pane: '%3',
      claudePid: 12345,
      cleanup: () => { /* no-op */ },
      detachedSpawn: fakeDetachedSpawn,
      onSignal: fakeOnSignal,
    });

    expect(spawnCalls.length).toBe(1);
    const argv = spawnCalls[0]!;
    // Must end with: retry-monitor <pane> <pid>
    const lastThree = argv.slice(-3);
    expect(lastThree).toEqual(['retry-monitor', '%3', '12345']);
  });

  test('argv[0] is process.execPath (bun binary)', () => {
    const spawnCalls: string[][] = [];
    const fakeDetachedSpawn: DetachedSpawnAdapter = (argv) => { spawnCalls.push(argv); return 0; };
    const fakeOnSignal: SignalHandler = (_sig, _fn) => { /* no-op */ };

    forkMonitor({
      args: [],
      pane: '%1',
      claudePid: 99,
      cleanup: () => {},
      detachedSpawn: fakeDetachedSpawn,
      onSignal: fakeOnSignal,
    });

    expect(spawnCalls[0]?.[0]).toBe(process.execPath);
  });

  test('argv contains the subcommand token "retry-monitor"', () => {
    const spawnCalls: string[][] = [];
    const fakeDetachedSpawn: DetachedSpawnAdapter = (argv) => { spawnCalls.push(argv); return 0; };
    const fakeOnSignal: SignalHandler = (_sig, _fn) => { /* no-op */ };

    forkMonitor({
      args: [],
      pane: 'cam:1.0',
      claudePid: 1001,
      cleanup: () => {},
      detachedSpawn: fakeDetachedSpawn,
      onSignal: fakeOnSignal,
    });

    const argv = spawnCalls[0]!;
    expect(argv).toContain('retry-monitor');
  });

  test('calls onMonitorSpawned with the PID returned by detachedSpawn', () => {
    const fakeDetachedSpawn: DetachedSpawnAdapter = (_argv) => 9876;
    const fakeOnSignal: SignalHandler = (_sig, _fn) => { /* no-op */ };
    const spawnedPids: number[] = [];

    forkMonitor({
      args: [],
      pane: '%1',
      claudePid: 42,
      cleanup: () => {},
      onMonitorSpawned: (pid) => { spawnedPids.push(pid); },
      detachedSpawn: fakeDetachedSpawn,
      onSignal: fakeOnSignal,
    });

    expect(spawnedPids).toEqual([9876]);
  });

  test('does not throw when onMonitorSpawned is not provided', () => {
    const fakeDetachedSpawn: DetachedSpawnAdapter = (_argv) => 0;
    const fakeOnSignal: SignalHandler = (_sig, _fn) => { /* no-op */ };

    expect(() => forkMonitor({
      args: [],
      pane: '%1',
      claudePid: 42,
      cleanup: () => {},
      detachedSpawn: fakeDetachedSpawn,
      onSignal: fakeOnSignal,
    })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// forkMonitor — signal handler installation
// ---------------------------------------------------------------------------

describe('forkMonitor — signal handlers', () => {
  test('registers SIGINT, SIGTERM, SIGHUP, SIGWINCH handlers', () => {
    const registeredSignals: string[] = [];
    const fakeDetachedSpawn: DetachedSpawnAdapter = (_argv) => 0;
    const fakeOnSignal: SignalHandler = (sig, _fn) => {
      registeredSignals.push(sig);
    };

    forkMonitor({
      args: [],
      pane: '%1',
      claudePid: 42,
      cleanup: () => {},
      detachedSpawn: fakeDetachedSpawn,
      onSignal: fakeOnSignal,
    });

    expect(registeredSignals).toContain('SIGINT');
    expect(registeredSignals).toContain('SIGTERM');
    expect(registeredSignals).toContain('SIGHUP');
    expect(registeredSignals).toContain('SIGWINCH');
  });

  test('SIGINT handler calls cleanup function', () => {
    let cleanupCalled = false;
    const signalHandlers: Map<string, () => void> = new Map();

    const fakeDetachedSpawn: DetachedSpawnAdapter = (_argv) => 0;
    const fakeOnSignal: SignalHandler = (sig, fn) => {
      signalHandlers.set(sig, fn);
    };

    forkMonitor({
      args: [],
      pane: '%1',
      claudePid: 99999, // non-existent PID — process.kill will throw ESRCH, which is caught
      cleanup: () => { cleanupCalled = true; },
      detachedSpawn: fakeDetachedSpawn,
      onSignal: fakeOnSignal,
    });

    const sigintHandler = signalHandlers.get('SIGINT');
    expect(sigintHandler).toBeDefined();
    sigintHandler!();
    expect(cleanupCalled).toBe(true);
  });

  test('SIGTERM handler calls cleanup function', () => {
    let cleanupCalled = false;
    const signalHandlers: Map<string, () => void> = new Map();

    const fakeDetachedSpawn: DetachedSpawnAdapter = (_argv) => 0;
    const fakeOnSignal: SignalHandler = (sig, fn) => {
      signalHandlers.set(sig, fn);
    };

    forkMonitor({
      args: [],
      pane: '%1',
      claudePid: 99999,
      cleanup: () => { cleanupCalled = true; },
      detachedSpawn: fakeDetachedSpawn,
      onSignal: fakeOnSignal,
    });

    const sigtermHandler = signalHandlers.get('SIGTERM');
    sigtermHandler!();
    expect(cleanupCalled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validateInteractiveEnv
// ---------------------------------------------------------------------------

describe('validateInteractiveEnv', () => {
  test('returns null when $TMUX is set and no -p flag', () => {
    const result = validateInteractiveEnv([], '/tmp/tmux-1234/default,12345,0');
    expect(result).toBeNull();
  });

  test('returns null when $TMUX is set and no --print flag', () => {
    const result = validateInteractiveEnv(['/cam-next'], '/tmp/tmux-1234/default,12345,0');
    expect(result).toBeNull();
  });

  test('returns error string when $TMUX is not set', () => {
    const result = validateInteractiveEnv([], undefined);
    expect(result).toBeTypeOf('string');
    expect(result).toMatch(/\$TMUX/);
    expect(result).toMatch(/cam run/);
  });

  test('returns error string (print mode) when -p is in args', () => {
    const result = validateInteractiveEnv(['-p', 'hello'], '/tmp/tmux');
    expect(result).toBeTypeOf('string');
    expect(result).toMatch(/print mode/);
  });

  test('returns error string (print mode) when --print is in args', () => {
    const result = validateInteractiveEnv(['--print', 'hello'], '/tmp/tmux');
    expect(result).toBeTypeOf('string');
    expect(result).toMatch(/print mode/);
  });
});

// ---------------------------------------------------------------------------
// runClaude — non-tmux error path (acceptance criterion 2)
// ---------------------------------------------------------------------------

describe('runClaude — non-tmux interactive error', () => {
  test('exits non-zero with error message when outside tmux and no -p', async () => {
    const stderrChunks: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrChunks.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
      return true;
    }) as typeof process.stderr.write;

    const code = await runClaude({
      args: ['/cam-next'],
      tmux: '', // simulate no $TMUX
    });

    process.stderr.write = origWrite;

    expect(code).not.toBe(0);
    const combined = stderrChunks.join('');
    expect(combined).toMatch(/cam run/i);
  });

  test('routes to print mode when -p is present (calls spawn adapter)', async () => {
    // When -p is present, runClaude calls launchClaude (print mode), which uses
    // the injectable spawn adapter — not the interactive path.
    const spawnCalls: Array<{ argv: string[] }> = [];
    const fakeSpawn = async (argv: string[], _env: Record<string, string>, _cwd: string) => {
      spawnCalls.push({ argv });
      return { stdout: 'ok\n', stderr: '', exitCode: 0 };
    };

    const code = await runClaude({
      args: ['-p', 'hello'],
      tmux: '', // no tmux — but irrelevant since -p triggers print mode
      spawn: fakeSpawn,
    });

    expect(code).toBe(0);
    expect(spawnCalls.length).toBe(1);
    expect(spawnCalls[0]!.argv.slice(1)).toContain('-p');
  });
});

// ---------------------------------------------------------------------------
// parseRetryMonitorArgs
// ---------------------------------------------------------------------------

describe('parseRetryMonitorArgs', () => {
  test('returns help:true for --help', () => {
    const result = parseRetryMonitorArgs(['--help']);
    expect(result).toEqual({ help: true });
  });

  test('returns help:true for -h', () => {
    const result = parseRetryMonitorArgs(['-h']);
    expect(result).toEqual({ help: true });
  });

  test('parses pane and pid correctly', () => {
    const result = parseRetryMonitorArgs(['%3', '12345']);
    expect(result).toEqual({ help: false, pane: '%3', pid: 12345 });
  });

  test('returns null when pid is missing', () => {
    const stderrChunks: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrChunks.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
      return true;
    }) as typeof process.stderr.write;

    const result = parseRetryMonitorArgs(['%1']);
    process.stderr.write = origWrite;

    expect(result).toBeNull();
  });

  test('returns null when pid is not a number', () => {
    const stderrChunks: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrChunks.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
      return true;
    }) as typeof process.stderr.write;

    const result = parseRetryMonitorArgs(['%1', 'not-a-number']);
    process.stderr.write = origWrite;

    expect(result).toBeNull();
  });

  test('returns null when args are empty', () => {
    const stderrChunks: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrChunks.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
      return true;
    }) as typeof process.stderr.write;

    const result = parseRetryMonitorArgs([]);
    process.stderr.write = origWrite;

    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// runRetryMonitor — invalid args exit code
// ---------------------------------------------------------------------------

describe('runRetryMonitor — validation', () => {
  test('returns 1 when pane is empty', async () => {
    const stderrChunks: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrChunks.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
      return true;
    }) as typeof process.stderr.write;

    const code = await runRetryMonitor({ pane: '', pid: 123, monitor: async () => {} });
    process.stderr.write = origWrite;

    expect(code).toBe(1);
  });

  test('returns 1 when pid is 0', async () => {
    const stderrChunks: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrChunks.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
      return true;
    }) as typeof process.stderr.write;

    const code = await runRetryMonitor({ pane: '%1', pid: 0, monitor: async () => {} });
    process.stderr.write = origWrite;

    expect(code).toBe(1);
  });

  test('calls the injectable monitor with the correct pane and pid', async () => {
    const monitorCalls: Array<{ pane: string; pid: number }> = [];
    const fakeMonitor = async (pane: string, pid: number) => {
      monitorCalls.push({ pane, pid });
    };

    const code = await runRetryMonitor({ pane: '%5', pid: 7890, monitor: fakeMonitor });

    expect(code).toBe(0);
    expect(monitorCalls.length).toBe(1);
    expect(monitorCalls[0]).toEqual({ pane: '%5', pid: 7890 });
  });
});
