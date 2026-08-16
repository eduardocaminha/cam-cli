import { describe, expect, test } from 'bun:test';
import type { ResourceUsage, SyncSubprocess } from 'bun';

import {
	decodeCapturedOutput,
	GATES,
	runGates,
	type Gate,
	type GateResult,
	type SpawnFn,
} from '../scripts/check-all.ts';

function resourceUsage(): ResourceUsage {
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

function result(exitCode: number, stdout = '', stderr = ''): SyncSubprocess<'pipe' | 'inherit', 'pipe' | 'inherit'> {
	return {
		pid: 1,
		stdout: Buffer.from(stdout),
		stderr: Buffer.from(stderr),
		exitCode,
		success: exitCode === 0,
		resourceUsage: resourceUsage(),
		signalCode: undefined,
	};
}

function recordingSpawn(exitCodes: number[]): { calls: string[]; spawnFn: SpawnFn } {
	const calls: string[] = [];
	let index = 0;
	return {
		calls,
		spawnFn: async (command, args) => {
			calls.push([command, ...args].join(' '));
			return result(exitCodes[index++] ?? 0);
		},
	};
}

describe('GATES manifest', () => {
	test('contains the current seven gates in execution order', () => {
		expect(GATES.map((gate) => gate.name)).toEqual([
			'typecheck',
			'test',
			'lint',
			'coverage',
			'dead-code',
			'dup',
			'ci-parity',
		]);
	});

	test('reuses suite output for coverage instead of spawning the suite twice', () => {
		const coverage = GATES.find((gate) => gate.name === 'coverage');
		expect(coverage?.run).toBeFunction();
		expect(coverage?.cmd).toBeUndefined();
	});
});

describe('runGates', () => {
	const gates: Gate[] = [
		{ name: 'a', cmd: 'bun', args: ['a'] },
		{ name: 'b', cmd: 'bun', args: ['b'] },
		{ name: 'c', cmd: 'bun', args: ['c'] },
	];

	test('runs every gate and returns failure when one fails', async () => {
		const { calls, spawnFn } = recordingSpawn([0, 1, 0]);
		expect(await runGates({ gates, spawnFn })).toBe(1);
		expect(calls).toEqual(['bun a', 'bun b', 'bun c']);
	});

	test('bail stops at the first failure', async () => {
		const { calls, spawnFn } = recordingSpawn([0, 1, 0]);
		expect(await runGates({ gates, spawnFn, bail: true })).toBe(1);
		expect(calls).toEqual(['bun a', 'bun b']);
	});

	test('passes captured test output to the next in-process gate', async () => {
		let observed = '';
		const suiteAndConsumer: Gate[] = [
			{ name: 'test', cmd: 'bun', args: ['test', '--coverage'] },
			{
				name: 'consumer',
				run: (suiteOutput) => {
					observed = suiteOutput;
					return { ok: true, errors: [] };
				},
			},
		];
		const spawnFn: SpawnFn = async () => result(0, 'stdout', 'stderr');
		expect(await runGates({ gates: suiteAndConsumer, spawnFn })).toBe(0);
		expect(observed).toBe('stdoutstderr');
	});

	test('reports stable JSON-ready results', async () => {
		const { spawnFn } = recordingSpawn([0, 1, 0]);
		let captured: GateResult[] = [];
		await runGates({ gates, spawnFn, onResults: (results) => { captured = results; } });
		expect(captured.map(({ name, status }) => ({ name, status }))).toEqual([
			{ name: 'a', status: 'ok' },
			{ name: 'b', status: 'fail' },
			{ name: 'c', status: 'ok' },
		]);
		expect(() => JSON.stringify(captured)).not.toThrow();
	});
});

test('decodeCapturedOutput joins stdout and stderr', () => {
	expect(decodeCapturedOutput({ stdout: Buffer.from('a'), stderr: Buffer.from('b') })).toBe('ab');
});
