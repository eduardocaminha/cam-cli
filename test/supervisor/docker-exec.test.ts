// test/supervisor/docker-exec.test.ts
//
// Unit tests for src/supervisor/docker-exec.ts.
//
// Coverage:
//   1. Default containerName is DEFAULT_CONTAINER_NAME ('cam-worker').
//   2. Custom containerName overrides the default.
//   3. The inner shell string is preserved byte-for-byte.
//   4. Argv-shape test: wrapped output begins with the expected docker exec prefix
//      and still contains ' claude ' after the env -u prefix.
//   5. No duplicate DEFAULT_CONTAINER_NAME literal (imports from worker-container.ts).

import { describe, expect, test } from 'bun:test';
import { dockerExecWrap } from '../../src/supervisor/docker-exec.ts';
import { DEFAULT_CONTAINER_NAME } from '../../src/supervisor/worker-container.ts';
import {
	buildImplementerWorkerArgv,
	workerEnvPrefix,
} from '../../src/supervisor/worker-argv.ts';

const SAMPLE_UUID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const SAMPLE_PROMPT = 'Implement the next user story from scripts/cam/prd.json per your AGENT.md.';
const SAMPLE_MODE = 'bypassPermissions';

describe('dockerExecWrap', () => {
	test('default containerName is DEFAULT_CONTAINER_NAME (cam-worker)', () => {
		const result = dockerExecWrap('some-shell-string');
		expect(result).toStartWith(`docker exec -it ${DEFAULT_CONTAINER_NAME} `);
		expect(DEFAULT_CONTAINER_NAME).toBe('cam-worker');
	});

	test('custom containerName overrides the default', () => {
		const result = dockerExecWrap('some-shell-string', 'my-container');
		expect(result).toStartWith('docker exec -it my-container ');
	});

	test('inner shell string is preserved byte-for-byte', () => {
		const inner = "env -u CLAUDECODE claude --permission-mode bypassPermissions --session-id abc 'do it'";
		const result = dockerExecWrap(inner);
		expect(result).toBe(`docker exec -it cam-worker ${inner}`);
	});

	test('inner shell string with special chars ($, backticks, quotes) is unchanged', () => {
		const inner = "env -u CLAUDECODE claude --model 'claude-opus-4-5' 'it'\\''s $HOME `backtick`'";
		const result = dockerExecWrap(inner);
		expect(result).toBe(`docker exec -it cam-worker ${inner}`);
	});

	test('argv-shape: wrapped implementer argv begins with docker exec prefix and contains env -u prefix then claude', () => {
		const workerArgv = buildImplementerWorkerArgv({
			uuid: SAMPLE_UUID,
			taskPrompt: SAMPLE_PROMPT,
			permissionMode: SAMPLE_MODE,
		});
		const wrapped = dockerExecWrap(workerArgv);

		// Must begin with the docker exec -it cam-worker prefix
		const expectedPrefix = `docker exec -it cam-worker ${workerEnvPrefix()}`;
		expect(wrapped).toStartWith(expectedPrefix);

		// Must still contain ' claude ' after the env -u prefix
		expect(wrapped).toContain(' claude ');
	});

	test('argv-shape: wrapped output begins with "docker exec -it cam-worker env -u CLAUDECODE " (AC3)', () => {
		const workerArgv = buildImplementerWorkerArgv({
			uuid: SAMPLE_UUID,
			taskPrompt: SAMPLE_PROMPT,
			permissionMode: SAMPLE_MODE,
		});
		const wrapped = dockerExecWrap(workerArgv);

		expect(wrapped.startsWith('docker exec -it cam-worker env -u CLAUDECODE ')).toBe(true);
	});

	test('argv-shape: wrapped output still contains " claude " after the env prefix (AC3)', () => {
		const workerArgv = buildImplementerWorkerArgv({
			uuid: SAMPLE_UUID,
			taskPrompt: SAMPLE_PROMPT,
			permissionMode: SAMPLE_MODE,
		});
		const wrapped = dockerExecWrap(workerArgv);

		// ' claude ' as a token (with surrounding spaces) must be present
		expect(wrapped).toContain(' claude ');
	});

	test('wrapping does not duplicate or modify the inner --permission-mode flag', () => {
		const workerArgv = buildImplementerWorkerArgv({
			uuid: SAMPLE_UUID,
			taskPrompt: SAMPLE_PROMPT,
			permissionMode: SAMPLE_MODE,
		});
		const wrapped = dockerExecWrap(workerArgv);

		// Only one occurrence of the permission mode flag
		const count = (wrapped.match(/--permission-mode/g) ?? []).length;
		expect(count).toBe(1);
	});

	test('wrapping does not introduce a standalone -p flag', () => {
		const workerArgv = buildImplementerWorkerArgv({
			uuid: SAMPLE_UUID,
			taskPrompt: SAMPLE_PROMPT,
			permissionMode: SAMPLE_MODE,
		});
		const wrapped = dockerExecWrap(workerArgv);

		expect(wrapped).not.toMatch(/\s-p(\s|$)/);
		expect(wrapped).not.toContain('claude -p');
	});
});
