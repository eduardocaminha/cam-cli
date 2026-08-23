import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
	buildRepositoryCreateArgv,
	buildRepositoryExistsArgv,
	createProject,
	type ProjectCreateCommandInput,
	type ProjectCreateCommandRunner,
} from '../../src/runtime/project-create.ts';
import { openProjectRegistry } from '../../src/runtime/project-registry.ts';
import { createTestTmpdir } from '../helpers/test-tmpdir.ts';

function scratch(prefix: string): string {
	return realpathSync(createTestTmpdir(prefix));
}

function result(exitCode = 0, stdout = '', stderr = '') {
	return { exitCode, stdout, stderr };
}

function localRunner(
	calls: ProjectCreateCommandInput[],
	create: (input: ProjectCreateCommandInput) => ReturnType<typeof result> | Promise<ReturnType<typeof result>> =
		(input) => {
			execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/product.git'], { cwd: input.cwd });
			execFileSync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: input.cwd });
			return result();
		},
): ProjectCreateCommandRunner {
	return async (input) => {
		calls.push({ cmd: [...input.cmd], cwd: input.cwd });
		if (input.cmd[0] === 'git') {
			const command = Bun.spawnSync(input.cmd, { cwd: input.cwd, stdout: 'pipe', stderr: 'pipe' });
			return result(command.exitCode, command.stdout.toString(), command.stderr.toString());
		}
		if (input.cmd[2] === 'view') {
			return result(1, '', 'GraphQL: Could not resolve to a Repository with the name acme/product.');
		}
		return create(input);
	};
}

const authorized = {
	repository: 'acme/product',
	visibility: 'private' as const,
	authorization: 'Create acme/product as a private repository.',
};

describe('project creation argv', () => {
	test('uses discrete argv for remote inspection and creation with no shell', () => {
		expect(buildRepositoryExistsArgv('acme/product')).toEqual([
			'gh', 'repo', 'view', 'acme/product', '--json', 'nameWithOwner', '--jq', '.nameWithOwner',
		]);
		expect(buildRepositoryCreateArgv('acme/product', '/managed/acme/product', 'public', 'Short description'))
			.toEqual([
				'gh', 'repo', 'create', 'acme/product', '--public', '--description', 'Short description',
				'--source', '/managed/acme/product', '--remote', 'origin', '--push',
			]);
	});
});

describe('createProject', () => {
	test('creates main with one README commit, pushes private, and registers the ready checkout', async () => {
		const home = scratch('gship-create-home-');
		const currentRoot = scratch('gship-create-current-');
		const registry = openProjectRegistry(home);
		const calls: ProjectCreateCommandInput[] = [];
		try {
			const project = await createProject(authorized, registry, currentRoot, home, {
				runCommand: localRunner(calls),
				ensureIdentity: () => ({ outcome: 'already-configured' }),
			});
			const root = join(home, 'projects', 'acme', 'product');
			expect(project).toMatchObject({ root, readiness: 'ready', repository: 'acme/product' });
			expect(readFileSync(join(root, 'README.md'), 'utf8')).toBe('# product\n');
			expect(execFileSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8' }).trim()).toBe('main');
			expect(execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()).toBe('1');
			expect(execFileSync('git', ['log', '-1', '--pretty=%s'], { cwd: root, encoding: 'utf8' }).trim()).toBe('Initial commit');
			expect(calls.find((call) => call.cmd[2] === 'create')?.cmd).toContain('--private');
			expect(registry.list()).toHaveLength(1);
		} finally {
			registry.close();
		}
	});

	test('reuses the strict import parser, accepts public and passes the optional description', async () => {
		const home = scratch('gship-create-public-home-');
		const currentRoot = scratch('gship-create-public-current-');
		const registry = openProjectRegistry(home);
		const calls: ProjectCreateCommandInput[] = [];
		try {
			await createProject({
				repository: 'https://github.com/acme/product.git',
				visibility: 'public',
				description: 'A small product',
				authorization: 'Create acme/product as a public repository.',
			}, registry, currentRoot, home, {
				runCommand: localRunner(calls),
				ensureIdentity: () => ({ outcome: 'already-configured' }),
			});
			const argv = calls.find((call) => call.cmd[2] === 'create')?.cmd ?? [];
			expect(argv).toContain('--public');
			expect(argv).not.toContain('--private');
			expect(argv.slice(argv.indexOf('--description'), argv.indexOf('--description') + 2))
				.toEqual(['--description', 'A small product']);
		} finally {
			registry.close();
		}
	});

	test('refuses invalid authorization, unsupported options and a missing identity before writing', async () => {
		const home = scratch('gship-create-invalid-home-');
		const currentRoot = scratch('gship-create-invalid-current-');
		const registry = openProjectRegistry(home);
		try {
			await expect(createProject({ ...authorized, authorization: ' ' }, registry, currentRoot, home))
				.rejects.toMatchObject({ code: 'invalid-authorization' });
			await expect(createProject({ ...authorized, template: 'node' }, registry, currentRoot, home))
				.rejects.toMatchObject({ code: 'invalid-request' });
			await expect(createProject(authorized, registry, currentRoot, home, {
				runCommand: localRunner([]),
				ensureIdentity: () => ({ outcome: 'missing', detail: 'Configure a Git identity.' }),
			})).rejects.toMatchObject({ code: 'git-identity' });
			expect(existsSync(join(home, 'projects'))).toBe(false);
			expect(registry.list()).toEqual([]);
		} finally {
			registry.close();
		}
	});

	test('refuses local and remote conflicts without touching either location', async () => {
		const home = scratch('gship-create-conflict-home-');
		const currentRoot = scratch('gship-create-conflict-current-');
		const registry = openProjectRegistry(home);
		const root = join(home, 'projects', 'acme', 'product');
		try {
			mkdirSync(root, { recursive: true });
			writeFileSync(join(root, 'keep.txt'), 'keep');
			await expect(createProject(authorized, registry, currentRoot, home))
				.rejects.toMatchObject({ code: 'local-conflict' });
			expect(readFileSync(join(root, 'keep.txt'), 'utf8')).toBe('keep');

			const otherHome = scratch('gship-create-remote-conflict-home-');
			const remoteRunner: ProjectCreateCommandRunner = async () => result(0, 'acme/product\n');
			await expect(createProject(authorized, registry, currentRoot, otherHome, {
				runCommand: remoteRunner,
			})).rejects.toMatchObject({ code: 'remote-conflict' });
			expect(existsSync(join(otherHome, 'projects'))).toBe(false);
		} finally {
			registry.close();
		}
	});

	test('does not overwrite or clean a destination that races the remote preflight', async () => {
		const home = scratch('gship-create-race-home-');
		const currentRoot = scratch('gship-create-race-current-');
		const registry = openProjectRegistry(home);
		const root = join(home, 'projects', 'acme', 'product');
		const racing: ProjectCreateCommandRunner = async () => {
			mkdirSync(root, { recursive: true });
			writeFileSync(join(root, 'keep.txt'), 'raced');
			return result(1, '', 'Could not resolve to a Repository');
		};
		try {
			await expect(createProject(authorized, registry, currentRoot, home, {
				runCommand: racing,
				ensureIdentity: () => ({ outcome: 'already-configured' }),
			})).rejects.toMatchObject({ code: 'local-conflict' });
			expect(readFileSync(join(root, 'keep.txt'), 'utf8')).toBe('raced');
			expect(registry.list()).toEqual([]);
		} finally {
			registry.close();
		}
	});

	test('cleans only its managed files when initialization fails before a remote may exist', async () => {
		const home = scratch('gship-create-cleanup-home-');
		const currentRoot = scratch('gship-create-cleanup-current-');
		const registry = openProjectRegistry(home);
		const runner = localRunner([], async () => result());
		const failing: ProjectCreateCommandRunner = async (input) => {
			if (input.cmd[0] === 'git' && input.cmd[1] === 'commit') return result(1, '', 'commit refused');
			return runner(input);
		};
		try {
			await expect(createProject(authorized, registry, currentRoot, home, {
				runCommand: failing,
				ensureIdentity: () => ({ outcome: 'already-configured' }),
			})).rejects.toMatchObject({ code: 'create-failed' });
			expect(existsSync(join(home, 'projects'))).toBe(false);
			expect(registry.list()).toEqual([]);
		} finally {
			registry.close();
		}
	});

	test('preserves a typed recovery checkout after gh may have created the remote', async () => {
		const home = scratch('gship-create-partial-home-');
		const currentRoot = scratch('gship-create-partial-current-');
		const registry = openProjectRegistry(home);
		try {
			await expect(createProject(authorized, registry, currentRoot, home, {
				runCommand: localRunner([], () => result(1, '', 'push failed')),
				ensureIdentity: () => ({ outcome: 'already-configured' }),
			})).rejects.toMatchObject({
				code: 'partial-create',
				recovery: {
					repository: 'acme/product',
					root: join(home, 'projects', 'acme', 'product'),
					readiness: { state: 'needs-attention', reason: 'origin-missing' },
				},
			});
			expect(existsSync(join(home, 'projects', 'acme', 'product', 'README.md'))).toBe(true);
			expect(registry.list()).toEqual([]);
		} finally {
			registry.close();
		}
	});

	test('recovers idempotently when gh throws after leaving a ready checkout', async () => {
		const home = scratch('gship-create-recover-home-');
		const currentRoot = scratch('gship-create-recover-current-');
		const registry = openProjectRegistry(home);
		try {
			const project = await createProject(authorized, registry, currentRoot, home, {
				runCommand: localRunner([], (input) => {
					execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/product.git'], { cwd: input.cwd });
					execFileSync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: input.cwd });
					throw new Error('connection closed after push');
				}),
				ensureIdentity: () => ({ outcome: 'already-configured' }),
			});
			expect(project).toMatchObject({ readiness: 'ready', repository: 'acme/product' });
			expect(registry.list()).toHaveLength(1);
		} finally {
			registry.close();
		}
	});
});
