// test/supervisor/worker-container-parity.test.ts
//
// Parity test: TS docker-run argv (buildDockerRunArgv) must mirror every field
// declared in .devcontainer/devcontainer.json (US-002, CAM-150).
//
// The JSON is read at test time via readFileSync; no runtime JSONC parser is
// added to src/. Any drift (a runArg, mount, containerEnv entry, or remoteUser
// changed in devcontainer.json but not reflected in the TS code) fails this
// test at build/CI time.
//
// Oracle: grep -q 'devcontainer.json' test/supervisor/worker-container-parity.test.ts

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildDockerRunArgv } from '../../src/supervisor/worker-container.ts';

// ---------------------------------------------------------------------------
// Read .devcontainer/devcontainer.json at test time (AC3: via test process)
// ---------------------------------------------------------------------------

interface DevcontainerJson {
	runArgs?: string[];
	workspaceMount?: string;
	mounts?: string[];
	containerEnv?: Record<string, string>;
	remoteUser?: string;
}

const devcontainerPath = join(import.meta.dir, '../../.devcontainer/devcontainer.json');
const devcontainer = JSON.parse(readFileSync(devcontainerPath, 'utf8')) as DevcontainerJson;

// Concrete workspace folder for exercising the bind-mount source substitution
const TEST_WORKSPACE = '/home/user/cam-cli-test';

// Build the argv under test once; all assertions read from this single array
const argv = buildDockerRunArgv({ workspaceFolder: TEST_WORKSPACE });

// ---------------------------------------------------------------------------
// runArgs: every --cap-add (and any future entries) must be present in argv
// ---------------------------------------------------------------------------

describe('parity: runArgs', () => {
	const runArgs = devcontainer.runArgs ?? [];

	test('devcontainer declares at least one runArg', () => {
		expect(runArgs.length).toBeGreaterThan(0);
	});

	for (const arg of runArgs) {
		test(`argv contains runArg declared in devcontainer.json: ${arg}`, () => {
			expect(argv).toContain(arg);
		});
	}
});

// ---------------------------------------------------------------------------
// workspaceMount: bind-mount target and type must match the declaration;
// source must be the workspaceFolder argument passed by the caller
// ---------------------------------------------------------------------------

describe('parity: workspaceMount', () => {
	test('devcontainer declares a workspaceMount', () => {
		expect(typeof devcontainer.workspaceMount).toBe('string');
	});

	test('argv carries --mount flag for the workspace bind', () => {
		expect(argv).toContain('--mount');
	});

	test('workspace mount target matches devcontainer workspaceMount target', () => {
		const mountStr = devcontainer.workspaceMount ?? '';
		const targetMatch = mountStr.match(/target=([^,]+)/);
		const expectedTarget = targetMatch?.[1];
		expect(expectedTarget).toBeDefined();
		const mountArg = argv.find((a) => a.includes(`target=${expectedTarget}`));
		expect(mountArg).toBeDefined();
	});

	test('workspace mount type=bind (from devcontainer workspaceMount)', () => {
		const mountStr = devcontainer.workspaceMount ?? '';
		expect(mountStr).toContain('type=bind');
		const mountArg = argv.find((a) => a.includes('type=bind'));
		expect(mountArg).toBeDefined();
	});

	test('workspace mount source is the provided workspaceFolder', () => {
		const mountArg = argv.find(
			(a) => a.includes(`source=${TEST_WORKSPACE}`) && a.includes('type=bind'),
		);
		expect(mountArg).toBeDefined();
	});
});

// ---------------------------------------------------------------------------
// mounts: each named volume entry must appear in argv
// ---------------------------------------------------------------------------

describe('parity: mounts', () => {
	const mounts = devcontainer.mounts ?? [];

	test('devcontainer declares at least one named volume mount', () => {
		expect(mounts.length).toBeGreaterThan(0);
	});

	for (const mountDecl of mounts) {
		const sourceMatch = mountDecl.match(/source=([^,]+)/);
		const targetMatch = mountDecl.match(/target=([^,]+)/);
		const source = sourceMatch?.[1];
		const target = targetMatch?.[1];

		test(`argv carries mount source=${source} target=${target} (from devcontainer.json mounts)`, () => {
			expect(source).toBeDefined();
			expect(target).toBeDefined();
			const mountArg = argv.find(
				(a) => a.includes(`source=${source}`) && a.includes(`target=${target}`),
			);
			expect(mountArg).toBeDefined();
		});
	}
});

// ---------------------------------------------------------------------------
// containerEnv: every KEY=VALUE must appear as -e KEY=VALUE in argv
// ---------------------------------------------------------------------------

describe('parity: containerEnv', () => {
	const containerEnv = devcontainer.containerEnv ?? {};
	const entries = Object.entries(containerEnv);

	test('devcontainer declares at least one containerEnv entry', () => {
		expect(entries.length).toBeGreaterThan(0);
	});

	for (const [key, value] of entries) {
		test(`argv contains -e ${key}=${value} (from containerEnv)`, () => {
			const envToken = `${key}=${value}`;
			const idx = argv.indexOf(envToken);
			expect(idx).toBeGreaterThan(-1);
			expect(argv[idx - 1]).toBe('-e');
		});
	}
});

// ---------------------------------------------------------------------------
// remoteUser: --user <remoteUser> must be present
// ---------------------------------------------------------------------------

describe('parity: remoteUser', () => {
	test('devcontainer declares a remoteUser', () => {
		expect(typeof devcontainer.remoteUser).toBe('string');
	});

	test('argv contains --user <remoteUser> from devcontainer.json', () => {
		expect(argv).toContain('--user');
		const userIdx = argv.indexOf('--user');
		expect(argv[userIdx + 1]).toBe(devcontainer.remoteUser);
	});
});
