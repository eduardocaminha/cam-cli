// test/check-all-streaming.test.ts
//
// Integration tests proving the suite gate's spawnFn genuinely STREAMS
// (US-R2-001, CAM-488 PRD round-2 WARNING finding): a prior spawnSync-based
// capture measurably blocked in total silence for the whole subprocess run
// and only echoed its captured buffers back afterward -- a post-hoc replay,
// not a tee, contradicting this file's own comments and ADR-0056. The fix
// (async Bun.spawn + incremental stream reads, teeStream/runStreamingSuiteGate
// in scripts/check-all.ts) is proven here the same way the finding itself was
// measured: a real subprocess that writes an early marker, sleeps, then
// writes a late marker, driven through the REAL exported helpers with a real
// Bun.spawn subprocess and a real ReadableStream -- no fakes, no mocked spawn.
//
// The timing assertions below are not a forbidden fixed-sleep wait primitive
// (see the curated "poll with waitForCondition" invariant): the subprocess's
// own real-clock sleep is the exact behaviour under test (does output arrive
// DURING the sleep, or only after it), so asserting on real elapsed time is
// the only way to falsify a regression back to blocking capture. Tolerances
// are generous to avoid CI flakiness while still being tight enough to fail
// if streaming regresses back to spawnSync-shaped blocking.

import { describe, expect, test } from 'bun:test';
import { runStreamingSuiteGate, teeStream } from '../scripts/check-all.ts';

describe('teeStream: genuine incremental delivery from a real subprocess', () => {
	test('the early chunk reaches the sink well before the subprocess finishes sleeping, not replayed afterward', async () => {
		const proc = Bun.spawn(['sh', '-c', 'echo EARLY; sleep 0.4; echo LATE'], {
			stdout: 'pipe',
			stderr: 'ignore',
		});

		const writeTimestamps: number[] = [];
		const writtenChunks: string[] = [];
		const sink = {
			write: (chunk: Uint8Array) => {
				writeTimestamps.push(Date.now());
				writtenChunks.push(Buffer.from(chunk).toString());
				return true;
			},
		} as unknown as NodeJS.WritableStream;

		const start = Date.now();
		const [combined] = await Promise.all([teeStream(proc.stdout, sink), proc.exited]);

		// At least two separate write() calls: one for EARLY (near-instant),
		// one for LATE (only after the real 400ms sleep). A regression back to
		// blocking capture would coalesce both into a single write after the
		// whole subprocess exits.
		expect(writeTimestamps.length).toBeGreaterThanOrEqual(2);
		expect(writeTimestamps[0]! - start).toBeLessThan(300);
		expect(writeTimestamps[writeTimestamps.length - 1]! - start).toBeGreaterThanOrEqual(350);

		expect(combined.toString()).toBe(writtenChunks.join(''));
		expect(combined.toString()).toContain('EARLY');
		expect(combined.toString()).toContain('LATE');
	});

	test('undefined/empty stream yields an empty buffer without writing to the sink', async () => {
		const proc = Bun.spawn(['sh', '-c', 'true'], { stdout: 'pipe', stderr: 'ignore' });
		const writes: Uint8Array[] = [];
		const sink = { write: (chunk: Uint8Array) => (writes.push(chunk), true) } as unknown as NodeJS.WritableStream;

		const [combined] = await Promise.all([teeStream(proc.stdout, sink), proc.exited]);

		expect(writes).toHaveLength(0);
		expect(combined.toString()).toBe('');
	});
});

describe('runStreamingSuiteGate: real end-to-end streamed spawn result shape', () => {
	test('exitCode/success/stdout/stderr reflect the real subprocess, and both streams are echoed live to process.stdout/stderr', async () => {
		const originalStdoutWrite = process.stdout.write.bind(process.stdout);
		const originalStderrWrite = process.stderr.write.bind(process.stderr);
		const echoedOut: string[] = [];
		const echoedErr: string[] = [];
		process.stdout.write = ((chunk: string | Uint8Array) => {
			echoedOut.push(Buffer.from(chunk as Uint8Array).toString());
			return true;
		}) as typeof process.stdout.write;
		process.stderr.write = ((chunk: string | Uint8Array) => {
			echoedErr.push(Buffer.from(chunk as Uint8Array).toString());
			return true;
		}) as typeof process.stderr.write;

		let result: Awaited<ReturnType<typeof runStreamingSuiteGate>>;
		try {
			result = await runStreamingSuiteGate('sh', ['-c', 'echo OUT-MARKER; echo ERR-MARKER >&2; exit 7'], process.cwd());
		} finally {
			process.stdout.write = originalStdoutWrite;
			process.stderr.write = originalStderrWrite;
		}

		expect(result.exitCode).toBe(7);
		expect(result.success).toBe(false);
		expect(result.stdout?.toString()).toContain('OUT-MARKER');
		expect(result.stderr?.toString()).toContain('ERR-MARKER');
		expect(result.pid).toBeGreaterThan(0);

		// The echo happened live (via teeStream), not as a post-hoc replay by
		// the caller: runStreamingSuiteGate itself already wrote every chunk
		// through to process.stdout/process.stderr.
		expect(echoedOut.join('')).toContain('OUT-MARKER');
		expect(echoedErr.join('')).toContain('ERR-MARKER');
	});
});
