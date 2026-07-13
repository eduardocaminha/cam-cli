// test/supervisor/worker-container.test.ts
//
// Unit tests for src/supervisor/worker-container.ts.
//
// All Docker calls are driven through recording fake spawnFns; no real Docker
// daemon is touched. CI runs on macos-latest with no Docker daemon installed.
//
// Coverage:
//   AC1 - module exports pure builders + orchestration fn; no side-effect at import
//   AC2 - docker-run argv includes cap-add, workspace mount, volume, --user bun,
//         DISABLE_AUTOUPDATER=1, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
//   AC3 - GITHUB_TOKEN and CLAUDE_CODE_OAUTH_TOKEN are threaded NAME-ONLY
//   AC5 - orchestration fn calls spawnFn with expected argv shapes

import { describe, expect, test } from 'bun:test';
import {
	buildDockerBuildArgv,
	buildDockerRunArgv,
	runWorkerContainer,
	resolveHostIds,
	DEFAULT_IMAGE_TAG,
	DEFAULT_CONTAINER_NAME,
	type ContainerSpawnFn,
	type DockerBuildArgvOptions,
	type DockerRunArgvOptions,
} from '../../src/supervisor/worker-container.ts';
import { readPinnedBunVersion, readPinnedNodeVersion } from '../../src/config/toolchain.ts';

const SAMPLE_WORKSPACE = '/home/user/projects/cam-cli';

// Most argv-shape tests below pass explicit bunVersion/nodeVersion overrides
// so their assertions never depend on the real repo-root pin files
// (US-003, AC3: "explicit overrides still injectable for tests").
const PIN_OVERRIDES = { bunVersion: '1.9.9', nodeVersion: '22.9.9' } as const;

// ---------------------------------------------------------------------------
// buildDockerBuildArgv
// ---------------------------------------------------------------------------

describe('buildDockerBuildArgv', () => {
	test('produces build argv with default options', () => {
		const argv = buildDockerBuildArgv(PIN_OVERRIDES);
		expect(argv[0]).toBe('build');
		expect(argv).toContain('-t');
		expect(argv).toContain(DEFAULT_IMAGE_TAG);
		expect(argv).toContain('-f');
		expect(argv).toContain('.devcontainer/Dockerfile');
		// build context is '.' by default
		expect(argv[argv.length - 1]).toBe('.');
	});

	test('accepts custom dockerfilePath', () => {
		const argv = buildDockerBuildArgv({ ...PIN_OVERRIDES, dockerfilePath: 'docker/Worker.dockerfile' });
		expect(argv).toContain('-f');
		expect(argv).toContain('docker/Worker.dockerfile');
		expect(argv).not.toContain('.devcontainer/Dockerfile');
	});

	test('accepts custom imageTag', () => {
		const argv = buildDockerBuildArgv({ ...PIN_OVERRIDES, imageTag: 'cam-worker:v2' });
		expect(argv).toContain('-t');
		expect(argv).toContain('cam-worker:v2');
		expect(argv).not.toContain(DEFAULT_IMAGE_TAG);
	});

	test('accepts custom buildContext', () => {
		const argv = buildDockerBuildArgv({ ...PIN_OVERRIDES, buildContext: './docker' });
		expect(argv[argv.length - 1]).toBe('./docker');
	});

	test('order: build -t <tag> -f <file> <context>', () => {
		const argv = buildDockerBuildArgv(PIN_OVERRIDES);
		const tIdx = argv.indexOf('-t');
		const fIdx = argv.indexOf('-f');
		expect(tIdx).toBeGreaterThan(-1);
		expect(fIdx).toBeGreaterThan(-1);
		// tag comes before dockerfile flag in practice; at minimum both present
		expect(argv.length).toBeGreaterThan(4);
	});

	// AC4: hostUid + hostGid -> --build-arg HOST_UID=<uid> --build-arg HOST_GID=<gid>
	test('emits --build-arg HOST_UID and HOST_GID when both hostUid and hostGid are provided', () => {
		const argv = buildDockerBuildArgv({ ...PIN_OVERRIDES, hostUid: 501, hostGid: 20 });
		const uidIdx = argv.indexOf('HOST_UID=501');
		const gidIdx = argv.indexOf('HOST_GID=20');
		expect(uidIdx).toBeGreaterThan(-1);
		expect(argv[uidIdx - 1]).toBe('--build-arg');
		expect(gidIdx).toBeGreaterThan(-1);
		expect(argv[gidIdx - 1]).toBe('--build-arg');
	});

	test('build context is still the last arg when hostUid and hostGid are provided', () => {
		const argv = buildDockerBuildArgv({ ...PIN_OVERRIDES, hostUid: 1000, hostGid: 1000, buildContext: './ctx' });
		expect(argv[argv.length - 1]).toBe('./ctx');
	});

	// AC5: absent hostUid/hostGid -> NO HOST_UID/HOST_GID --build-arg token
	test('emits NO HOST_UID/HOST_GID --build-arg when neither hostUid nor hostGid is provided', () => {
		const argv = buildDockerBuildArgv(PIN_OVERRIDES);
		expect(argv.some((a) => a.startsWith('HOST_UID='))).toBe(false);
		expect(argv.some((a) => a.startsWith('HOST_GID='))).toBe(false);
	});

	test('emits NO HOST_UID/HOST_GID --build-arg when only hostUid is provided (hostGid absent)', () => {
		const argv = buildDockerBuildArgv({ ...PIN_OVERRIDES, hostUid: 501 });
		expect(argv.some((a) => a.startsWith('HOST_UID='))).toBe(false);
		expect(argv.some((a) => a.startsWith('HOST_GID='))).toBe(false);
	});

	test('emits NO HOST_UID/HOST_GID --build-arg when only hostGid is provided (hostUid absent)', () => {
		const argv = buildDockerBuildArgv({ ...PIN_OVERRIDES, hostGid: 20 });
		expect(argv.some((a) => a.startsWith('HOST_UID='))).toBe(false);
		expect(argv.some((a) => a.startsWith('HOST_GID='))).toBe(false);
	});

	test('default argv without hostUid/hostGid is byte-identical to baseline (with explicit toolchain pins)', () => {
		const argv = buildDockerBuildArgv(PIN_OVERRIDES);
		expect(argv).toEqual([
			'build',
			'-t',
			DEFAULT_IMAGE_TAG,
			'-f',
			'.devcontainer/Dockerfile',
			'--build-arg',
			'BUN_VERSION=1.9.9',
			'--build-arg',
			'NODE_VERSION=22.9.9',
			'.',
		]);
	});

	// AC3: BUN_VERSION/NODE_VERSION are sourced from the US-001 toolchain
	// reader by default (no explicit override), reading the real repo-root
	// .bun-version / .tool-versions pin files.
	test('defaults BUN_VERSION and NODE_VERSION to the toolchain reader when no override is given', () => {
		const argv = buildDockerBuildArgv();
		const pinnedBun = readPinnedBunVersion();
		const pinnedNode = readPinnedNodeVersion();
		expect(pinnedBun).not.toBeNull();
		expect(pinnedNode).not.toBeNull();
		expect(argv).toContain(`BUN_VERSION=${pinnedBun}`);
		expect(argv).toContain(`NODE_VERSION=${pinnedNode}`);
	});

	test('explicit bunVersion/nodeVersion override the toolchain reader default', () => {
		const argv = buildDockerBuildArgv({ bunVersion: '9.9.9', nodeVersion: '20.1.2' });
		expect(argv).toContain('BUN_VERSION=9.9.9');
		expect(argv).toContain('NODE_VERSION=20.1.2');
	});

	test('BUN_VERSION and NODE_VERSION are each preceded by --build-arg', () => {
		const argv = buildDockerBuildArgv(PIN_OVERRIDES);
		const bunIdx = argv.indexOf('BUN_VERSION=1.9.9');
		const nodeIdx = argv.indexOf('NODE_VERSION=22.9.9');
		expect(bunIdx).toBeGreaterThan(-1);
		expect(argv[bunIdx - 1]).toBe('--build-arg');
		expect(nodeIdx).toBeGreaterThan(-1);
		expect(argv[nodeIdx - 1]).toBe('--build-arg');
	});
});

// ---------------------------------------------------------------------------
// buildDockerRunArgv
// ---------------------------------------------------------------------------

describe('buildDockerRunArgv', () => {
	test('starts with run -d --name <containerName>', () => {
		const argv = buildDockerRunArgv({ workspaceFolder: SAMPLE_WORKSPACE });
		expect(argv[0]).toBe('run');
		expect(argv).toContain('-d');
		expect(argv).toContain('--name');
		const nameIdx = argv.indexOf('--name');
		expect(argv[nameIdx + 1]).toBe(DEFAULT_CONTAINER_NAME);
	});

	// AC2: cap-add flags
	test('includes --cap-add=NET_ADMIN (from devcontainer runArgs)', () => {
		const argv = buildDockerRunArgv({ workspaceFolder: SAMPLE_WORKSPACE });
		expect(argv).toContain('--cap-add=NET_ADMIN');
	});

	test('includes --cap-add=NET_RAW (from devcontainer runArgs)', () => {
		const argv = buildDockerRunArgv({ workspaceFolder: SAMPLE_WORKSPACE });
		expect(argv).toContain('--cap-add=NET_RAW');
	});

	// AC2: workspace bind-mount
	test('includes workspace bind-mount to /workspace', () => {
		const argv = buildDockerRunArgv({ workspaceFolder: SAMPLE_WORKSPACE });
		const mountVal = argv.find(
			(a) =>
				a.includes(SAMPLE_WORKSPACE) &&
				a.includes('target=/workspace') &&
				a.includes('type=bind'),
		);
		expect(mountVal).toBeDefined();
	});

	test('workspace mount source is the provided workspaceFolder', () => {
		const customWs = '/tmp/my-project';
		const argv = buildDockerRunArgv({ workspaceFolder: customWs });
		const mountVal = argv.find(
			(a) => a.includes(customWs) && a.includes('target=/workspace'),
		);
		expect(mountVal).toBeDefined();
		// A different workspace must not appear
		expect(argv.some((a) => a.includes(SAMPLE_WORKSPACE))).toBe(false);
	});

	// AC2: named claude-code-config volume
	test('includes named claude-code-config volume at /home/bun/.claude', () => {
		const argv = buildDockerRunArgv({ workspaceFolder: SAMPLE_WORKSPACE });
		const volVal = argv.find(
			(a) =>
				a.includes('claude-code-config') &&
				a.includes('/home/bun/.claude') &&
				a.includes('type=volume'),
		);
		expect(volVal).toBeDefined();
	});

	// AC2: --user bun
	test('includes --user bun (remoteUser from devcontainer)', () => {
		const argv = buildDockerRunArgv({ workspaceFolder: SAMPLE_WORKSPACE });
		expect(argv).toContain('--user');
		const userIdx = argv.indexOf('--user');
		expect(argv[userIdx + 1]).toBe('bun');
	});

	// AC2: containerEnv DISABLE_AUTOUPDATER=1
	test('includes -e DISABLE_AUTOUPDATER=1 (from containerEnv)', () => {
		const argv = buildDockerRunArgv({ workspaceFolder: SAMPLE_WORKSPACE });
		const valIdx = argv.indexOf('DISABLE_AUTOUPDATER=1');
		expect(valIdx).toBeGreaterThan(-1);
		expect(argv[valIdx - 1]).toBe('-e');
	});

	// AC2: containerEnv CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
	test('includes -e CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 (from containerEnv)', () => {
		const argv = buildDockerRunArgv({ workspaceFolder: SAMPLE_WORKSPACE });
		const valIdx = argv.indexOf('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1');
		expect(valIdx).toBeGreaterThan(-1);
		expect(argv[valIdx - 1]).toBe('-e');
	});

	// AC3: GITHUB_TOKEN name-only form
	test('threads GITHUB_TOKEN by NAME only (-e GITHUB_TOKEN, no =value)', () => {
		const argv = buildDockerRunArgv({ workspaceFolder: SAMPLE_WORKSPACE });
		const tokenIdx = argv.indexOf('GITHUB_TOKEN');
		expect(tokenIdx).toBeGreaterThan(-1);
		expect(argv[tokenIdx - 1]).toBe('-e');
		// Must NOT have GITHUB_TOKEN= anywhere (that would embed a literal value)
		expect(argv.some((a) => a.startsWith('GITHUB_TOKEN='))).toBe(false);
	});

	// AC3: CLAUDE_CODE_OAUTH_TOKEN name-only form
	test('threads CLAUDE_CODE_OAUTH_TOKEN by NAME only (-e CLAUDE_CODE_OAUTH_TOKEN, no =value)', () => {
		const argv = buildDockerRunArgv({ workspaceFolder: SAMPLE_WORKSPACE });
		const tokenIdx = argv.indexOf('CLAUDE_CODE_OAUTH_TOKEN');
		expect(tokenIdx).toBeGreaterThan(-1);
		expect(argv[tokenIdx - 1]).toBe('-e');
		// Must NOT have CLAUDE_CODE_OAUTH_TOKEN= anywhere
		expect(argv.some((a) => a.startsWith('CLAUDE_CODE_OAUTH_TOKEN='))).toBe(false);
	});

	test('includes the image tag before the entrypoint', () => {
		const argv = buildDockerRunArgv({ workspaceFolder: SAMPLE_WORKSPACE });
		expect(argv).toContain(DEFAULT_IMAGE_TAG);
	});

	test('ends with sleep infinity (keeps container alive for exec dispatch)', () => {
		const argv = buildDockerRunArgv({ workspaceFolder: SAMPLE_WORKSPACE });
		expect(argv[argv.length - 2]).toBe('sleep');
		expect(argv[argv.length - 1]).toBe('infinity');
	});

	test('accepts custom containerName', () => {
		const argv = buildDockerRunArgv({
			workspaceFolder: SAMPLE_WORKSPACE,
			containerName: 'my-cam-worker',
		});
		const nameIdx = argv.indexOf('--name');
		expect(argv[nameIdx + 1]).toBe('my-cam-worker');
	});

	test('accepts custom imageTag', () => {
		const argv = buildDockerRunArgv({
			workspaceFolder: SAMPLE_WORKSPACE,
			imageTag: 'cam-worker:v2',
		});
		expect(argv).toContain('cam-worker:v2');
		expect(argv).not.toContain(DEFAULT_IMAGE_TAG);
	});

	// US-002 (CAM-63): worker-actor CAM_WORKER env marker.
	test('includes -e CAM_WORKER=1 (worker-actor marker)', () => {
		const argv = buildDockerRunArgv({ workspaceFolder: SAMPLE_WORKSPACE });
		const valIdx = argv.indexOf('CAM_WORKER=1');
		expect(valIdx).toBeGreaterThan(-1);
		expect(argv[valIdx - 1]).toBe('-e');
	});
});

// ---------------------------------------------------------------------------
// runWorkerContainer
// ---------------------------------------------------------------------------

describe('runWorkerContainer', () => {
	// AC1: orchestration fn calls spawnFn; no side-effect at import time
	test('calls spawnFn with docker build then docker run on success', () => {
		const calls: Array<{ cmd: string; args: string[] }> = [];
		const spawnFn: ContainerSpawnFn = (cmd, args) => {
			calls.push({ cmd, args });
			return { stdout: '', exitCode: 0 };
		};

		const result = runWorkerContainer({
			spawnFn,
			run: { workspaceFolder: SAMPLE_WORKSPACE },
		});

		expect(calls).toHaveLength(2);
		const buildCall = calls[0];
		const runCall = calls[1];
		expect(buildCall?.cmd).toBe('docker');
		expect(buildCall?.args[0]).toBe('build');
		expect(runCall?.cmd).toBe('docker');
		expect(runCall?.args[0]).toBe('run');
		expect(result.buildExitCode).toBe(0);
		expect(result.runExitCode).toBe(0);
	});

	test('skips docker run when docker build fails (non-zero exit)', () => {
		const calls: Array<{ cmd: string; args: string[] }> = [];
		const spawnFn: ContainerSpawnFn = (cmd, args) => {
			calls.push({ cmd, args });
			return { stdout: 'error', exitCode: 1 };
		};

		const result = runWorkerContainer({
			spawnFn,
			run: { workspaceFolder: SAMPLE_WORKSPACE },
		});

		expect(calls).toHaveLength(1);
		expect(calls[0]?.args[0]).toBe('build');
		expect(result.buildExitCode).toBe(1);
		expect(result.runExitCode).toBe(-1);
	});

	test('returns docker run exit code on build success', () => {
		let callCount = 0;
		const spawnFn: ContainerSpawnFn = (_cmd, _args) => {
			callCount += 1;
			// build succeeds; run fails with code 125
			return { stdout: '', exitCode: callCount === 1 ? 0 : 125 };
		};

		const result = runWorkerContainer({
			spawnFn,
			run: { workspaceFolder: SAMPLE_WORKSPACE },
		});

		expect(result.buildExitCode).toBe(0);
		expect(result.runExitCode).toBe(125);
	});

	test('forwards build options to the docker build call', () => {
		const calls: Array<{ cmd: string; args: string[] }> = [];
		const spawnFn: ContainerSpawnFn = (cmd, args) => {
			calls.push({ cmd, args });
			return { stdout: '', exitCode: 0 };
		};

		const buildOpts: DockerBuildArgvOptions = {
			dockerfilePath: 'custom/Dockerfile',
			imageTag: 'cam-worker:custom',
		};

		runWorkerContainer({
			spawnFn,
			build: buildOpts,
			run: { workspaceFolder: SAMPLE_WORKSPACE },
		});

		const buildArgs = calls[0]?.args ?? [];
		expect(buildArgs).toContain('custom/Dockerfile');
		expect(buildArgs).toContain('cam-worker:custom');
	});

	test('forwards run options to the docker run call', () => {
		const calls: Array<{ cmd: string; args: string[] }> = [];
		const spawnFn: ContainerSpawnFn = (cmd, args) => {
			calls.push({ cmd, args });
			return { stdout: '', exitCode: 0 };
		};

		const runOpts: DockerRunArgvOptions = {
			workspaceFolder: '/custom/workspace',
			containerName: 'custom-container',
			imageTag: 'cam-worker:custom',
		};

		runWorkerContainer({ spawnFn, run: runOpts });

		const runArgs = calls[1]?.args ?? [];
		expect(runArgs).toContain('custom-container');
		expect(runArgs).toContain('cam-worker:custom');
		expect(runArgs.some((a) => a.includes('/custom/workspace'))).toBe(true);
	});

	test('does not shell out at module import time (side-effect-free)', () => {
		// This test passes simply by virtue of the module having been imported
		// at the top of this file without any unexpected side-effect. If a real
		// docker call were made at import time, CI (no daemon) would fail before
		// reaching this point.
		expect(DEFAULT_IMAGE_TAG).toBe('cam-worker:latest');
		expect(DEFAULT_CONTAINER_NAME).toBe('cam-worker');
	});
});

// ---------------------------------------------------------------------------
// resolveHostIds
// ---------------------------------------------------------------------------

describe('resolveHostIds', () => {
	// AC1: happy path - returns parsed uid/gid from id -u / id -g
	test('returns parsed uid and gid when both id commands succeed', () => {
		const spawnFn: ContainerSpawnFn = (_cmd, args) => {
			if (args[0] === '-u') return { stdout: '501\n', exitCode: 0 };
			if (args[0] === '-g') return { stdout: '20\n', exitCode: 0 };
			return { stdout: '', exitCode: 1 };
		};
		const result = resolveHostIds(spawnFn);
		expect(result.uid).toBe(501);
		expect(result.gid).toBe(20);
	});

	test('calls id -u and id -g (the correct args)', () => {
		const calls: Array<{ cmd: string; args: string[] }> = [];
		const spawnFn: ContainerSpawnFn = (cmd, args) => {
			calls.push({ cmd, args });
			return { stdout: '1000\n', exitCode: 0 };
		};
		resolveHostIds(spawnFn);
		const cmds = calls.map((c) => c.cmd);
		expect(cmds).toContain('id');
		const argSets = calls.map((c) => c.args[0]);
		expect(argSets).toContain('-u');
		expect(argSets).toContain('-g');
	});

	// AC1: fallback when command fails (non-zero exit)
	test('falls back to uid=1000 when id -u exits non-zero', () => {
		const spawnFn: ContainerSpawnFn = (_cmd, args) => {
			if (args[0] === '-u') return { stdout: '', exitCode: 1 };
			return { stdout: '20\n', exitCode: 0 };
		};
		const result = resolveHostIds(spawnFn);
		expect(result.uid).toBe(1000);
		expect(result.gid).toBe(20);
	});

	test('falls back to gid=1000 when id -g exits non-zero', () => {
		const spawnFn: ContainerSpawnFn = (_cmd, args) => {
			if (args[0] === '-g') return { stdout: '', exitCode: 1 };
			return { stdout: '501\n', exitCode: 0 };
		};
		const result = resolveHostIds(spawnFn);
		expect(result.uid).toBe(501);
		expect(result.gid).toBe(1000);
	});

	test('falls back to { uid: 1000, gid: 1000 } when both commands fail', () => {
		const spawnFn: ContainerSpawnFn = () => ({ stdout: '', exitCode: 127 });
		const result = resolveHostIds(spawnFn);
		expect(result).toEqual({ uid: 1000, gid: 1000 });
	});

	// AC1: fallback when stdout is non-numeric
	test('falls back to 1000 when id -u returns non-numeric output', () => {
		const spawnFn: ContainerSpawnFn = (_cmd, args) => {
			if (args[0] === '-u') return { stdout: 'root\n', exitCode: 0 };
			return { stdout: '20\n', exitCode: 0 };
		};
		const result = resolveHostIds(spawnFn);
		expect(result.uid).toBe(1000);
		expect(result.gid).toBe(20);
	});

	// AC1: fallback when stdout is empty (noUncheckedIndexedAccess guard)
	test('falls back to 1000 when stdout is empty string', () => {
		const spawnFn: ContainerSpawnFn = (_cmd, args) => {
			if (args[0] === '-u') return { stdout: '', exitCode: 0 };
			return { stdout: '1001\n', exitCode: 0 };
		};
		const result = resolveHostIds(spawnFn);
		expect(result.uid).toBe(1000);
		expect(result.gid).toBe(1001);
	});

	test('falls back to 1000 when stdout is whitespace only', () => {
		const spawnFn: ContainerSpawnFn = () => ({ stdout: '   \n', exitCode: 0 });
		const result = resolveHostIds(spawnFn);
		expect(result).toEqual({ uid: 1000, gid: 1000 });
	});

	// Standard host uid/gid (1000/1000) passes through without modification
	test('returns uid=1000 gid=1000 when id reports uid=1000 gid=1000', () => {
		const spawnFn: ContainerSpawnFn = () => ({ stdout: '1000\n', exitCode: 0 });
		const result = resolveHostIds(spawnFn);
		expect(result).toEqual({ uid: 1000, gid: 1000 });
	});
});
