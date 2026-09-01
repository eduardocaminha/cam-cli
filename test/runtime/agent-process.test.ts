import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import {
	AgentProcessActivityTimeoutError,
	DEFAULT_AGENT_ACTIVITY_TIMEOUT_MS,
	runAgentProcess,
} from '../../src/runtime/agent-process.ts';
import { createTestTmpdir } from '../helpers/test-tmpdir.ts';

const FIXTURE = join(import.meta.dir, '..', 'fixtures', 'runtime', 'agent-process-fixture.ts');

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

describe('agent process activity deadline', () => {
	test('production silence budget is ten minutes', () => {
		expect(DEFAULT_AGENT_ACTIVITY_TIMEOUT_MS).toBe(600_000);
	});

	test('each stdout protocol line rearms the deadline', async () => {
		const lines: string[] = [];
		const result = await runAgentProcess({
			argv: ['bun', FIXTURE, '--mode=progress'],
			cwd: createTestTmpdir('gship-agent-progress-'),
			env: { PATH: process.env.PATH },
			stdin: '',
			signal: new AbortController().signal,
			onLine: (line) => lines.push(line),
			terminationGraceMs: 100,
			activityTimeoutMs: 400,
		});

		expect(result.exitCode).toBe(0);
		expect(lines).toEqual(['first', 'second']);
	});

	test('stderr retries do not hide a silent protocol or leak the child', async () => {
		let childPid = 0;
		let failure: unknown;
		try {
			await runAgentProcess({
				argv: ['bun', FIXTURE, '--mode=stderr'],
				cwd: createTestTmpdir('gship-agent-stderr-'),
				env: { PATH: process.env.PATH },
				stdin: '',
				signal: new AbortController().signal,
				onLine: () => {},
				terminationGraceMs: 100,
				activityTimeoutMs: 50,
				onSpawn: (pid) => { childPid = pid; },
			});
		} catch (error) {
			failure = error;
		}

		expect(failure).toBeInstanceOf(AgentProcessActivityTimeoutError);
		expect(failure).toMatchObject({ timeoutMs: 50 });
		expect(childPid).toBeGreaterThan(0);
		expect(isProcessAlive(childPid)).toBe(false);
	});
});
