// test/check-all-capture.test.ts
//
// Unit tests for the suite-gate output-capture helper in scripts/check-all.ts
// (US-001, CAM-488 PRD).
//
// decodeCapturedOutput concatenates a spawn result's captured stdout+stderr
// Buffers into one blob: stdout-decoded text FOLLOWED BY stderr-decoded
// text, in that order. `bun test --coverage` writes its summary and coverage
// table to stderr (not stdout), so a stdout-only capture would yield an
// empty blob for the coverage/skip-ratchet consumers this story exists to
// unblock -- both streams must be captured and concatenated in this order.
// A spawn result whose stdout/stderr are `undefined` (a fake, or any
// inherited-stdio gate) decodes to an empty blob rather than throwing.

import { describe, expect, test } from 'bun:test';
import type { ResourceUsage } from 'bun';
import { decodeCapturedOutput, runGates, type Gate, type SpawnFn } from '../scripts/check-all.ts';

function makeResourceUsage(): ResourceUsage {
	return {
		contextSwitches: { voluntary: 0, involuntary: 0 },
		cpuTime: { user: 0, system: 0, total: 0 },
		maxRSS: 0,
		messages: { sent: 0, received: 0 },
		ops: { in: 0, out: 0 },
		shmSize: 0,
		signalCount: 0,
		swapCount: 0,
	};
}

// ---------------------------------------------------------------------------
// decodeCapturedOutput
// ---------------------------------------------------------------------------

describe('decodeCapturedOutput', () => {
	test('concatenates stdout-decoded text followed by stderr-decoded text, in that order', () => {
		const blob = decodeCapturedOutput({
			stdout: Buffer.from('STDOUT-PART'),
			stderr: Buffer.from('STDERR-PART'),
		});
		expect(blob).toBe('STDOUT-PARTSTDERR-PART');
	});

	test('stderr-only content survives (measured reality: bun test --coverage writes its report to stderr)', () => {
		const blob = decodeCapturedOutput({
			stdout: Buffer.from(''),
			stderr: Buffer.from('All files | 90.00 | 85.00'),
		});
		expect(blob).toBe('All files | 90.00 | 85.00');
	});

	test('undefined stdout and undefined stderr decode to an empty blob instead of throwing', () => {
		expect(() => decodeCapturedOutput({})).not.toThrow();
		expect(decodeCapturedOutput({})).toBe('');
	});

	test('undefined stdout with populated stderr decodes to stderr text alone, without throwing', () => {
		expect(() => decodeCapturedOutput({ stdout: undefined, stderr: Buffer.from('err-only') })).not.toThrow();
		expect(decodeCapturedOutput({ stdout: undefined, stderr: Buffer.from('err-only') })).toBe('err-only');
	});
});

// ---------------------------------------------------------------------------
// runGates suite-output capture wiring
// ---------------------------------------------------------------------------

describe('runGates suite-output capture wiring', () => {
	function makeCapturingResult(args: string[]) {
		return {
			pid: 1,
			success: true,
			exitCode: 0,
			stdout: Buffer.from(`stdout:${args.join(' ')}`),
			stderr: Buffer.from(`stderr:${args.join(' ')}`),
			resourceUsage: makeResourceUsage(),
			signalCode: undefined,
		};
	}

	test('onSuiteOutput receives the combined blob exactly once, from the "test" gate only', () => {
		const calls: string[] = [];
		const fn: SpawnFn = (_cmd, args) => makeCapturingResult(args);
		const gates: Gate[] = [
			{ name: 'other', cmd: 'bun', args: ['x'] },
			{ name: 'test', cmd: 'bun', args: ['test', '--coverage'] },
			{ name: 'another', cmd: 'bun', args: ['y'] },
		];

		runGates({ gates, spawnFn: fn, onSuiteOutput: (output) => calls.push(output) });

		expect(calls).toHaveLength(1);
		expect(calls[0]).toBe('stdout:test --coveragestderr:test --coverage');
	});

	test('onSuiteOutput is never called when no gate is named "test"', () => {
		const calls: string[] = [];
		const fn: SpawnFn = (_cmd, args) => makeCapturingResult(args);
		const gates: Gate[] = [{ name: 'other', cmd: 'bun', args: ['x'] }];

		runGates({ gates, spawnFn: fn, onSuiteOutput: (output) => calls.push(output) });

		expect(calls).toHaveLength(0);
	});
});
