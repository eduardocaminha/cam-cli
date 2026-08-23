import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
	buildCloneArgv,
	type GitCloneRunner,
	importRepository,
	parseRepositorySpecifier,
	ProjectImportError,
} from '../../src/runtime/project-import.ts';
import { openProjectRegistry } from '../../src/runtime/project-registry.ts';
import { createTestTmpdir } from '../helpers/test-tmpdir.ts';

/** A scratch directory whose own path carries no symlink of its own. */
function scratchRoot(prefix: string): string {
	return realpathSync(createTestTmpdir(prefix));
}

/** A local checkout with a GitHub origin and an origin/main ref, and nothing remote. */
function readyCheckout(root: string, remoteUrl: string): void {
	mkdirSync(root, { recursive: true });
	execFileSync('git', ['init', '--quiet', '-b', 'main'], { cwd: root });
	execFileSync('git', ['config', 'user.name', 'Test Operator'], { cwd: root });
	execFileSync('git', ['config', 'user.email', 'operator@example.com'], { cwd: root });
	writeFileSync(join(root, 'README.md'), '# product\n');
	execFileSync('git', ['add', 'README.md'], { cwd: root });
	execFileSync('git', ['commit', '--quiet', '-m', 'seed'], { cwd: root });
	execFileSync('git', ['remote', 'add', 'origin', remoteUrl], { cwd: root });
	execFileSync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: root });
}

/**
 * Stands in for a real `git clone` without touching the network: it leaves
 * behind exactly what a successful `git clone --branch main` of `input.url`
 * would -- a local checkout with `origin` set to that URL and a local
 * `origin/main` ref -- at the staging path the runtime already computed.
 */
const cloneLocally: GitCloneRunner = async (input) => {
	readyCheckout(input.destination, input.url);
	return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
};

function refusingClone(): GitCloneRunner {
	return async () => {
		throw new Error('clone must not run for this scenario');
	};
}

describe('parseRepositorySpecifier', () => {
	test('normalizes owner/repo and an https://github.com URL to the same slug', () => {
		expect(parseRepositorySpecifier('acme/product')).toEqual({
			owner: 'acme', repo: 'product', slug: 'acme/product',
		});
		expect(parseRepositorySpecifier('  acme/product  ')).toEqual({
			owner: 'acme', repo: 'product', slug: 'acme/product',
		});
		expect(parseRepositorySpecifier('https://github.com/acme/product')).toEqual({
			owner: 'acme', repo: 'product', slug: 'acme/product',
		});
		expect(parseRepositorySpecifier('https://github.com/acme/product.git')).toEqual({
			owner: 'acme', repo: 'product', slug: 'acme/product',
		});
		expect(parseRepositorySpecifier('https://github.com/acme/product/')).toEqual({
			owner: 'acme', repo: 'product', slug: 'acme/product',
		});
	});

	test('rejects every host, segment, query, fragment, credential and out-of-format character', () => {
		const rejects = (input: string): void => {
			expect(() => parseRepositorySpecifier(input)).toThrow(ProjectImportError);
			try {
				parseRepositorySpecifier(input);
			} catch (error) {
				expect(error).toBeInstanceOf(ProjectImportError);
				expect((error as ProjectImportError).code).toBe('invalid-request');
				expect((error as ProjectImportError).status).toBe(400);
			}
		};
		rejects('');
		rejects('   ');
		rejects('acme');
		rejects('acme/product/extra');
		rejects('acme/../../etc');
		rejects('../acme/product');
		rejects('acme/..');
		rejects('http://github.com/acme/product');
		rejects('https://gitlab.com/acme/product');
		rejects('https://github.com/acme/product?ref=main');
		rejects('https://github.com/acme/product#readme');
		rejects('https://user:pass@github.com/acme/product');
		rejects('https://github.com/acme');
		rejects('https://github.com/acme/product/extra');
		rejects('git@github.com:acme/product.git');
		rejects('ssh://git@github.com/acme/product.git');
		rejects('acme/pro;rm -rf');
		rejects('acme/pro duct');
		rejects('acme/`whoami`');
		rejects('acme/$(whoami)');
	});
});

describe('buildCloneArgv', () => {
	test('is a plain argv array -- url and destination are discrete elements, never shell-joined', () => {
		expect(buildCloneArgv('https://github.com/acme/product.git', '/home/.gateship/projects/.staging/x'))
			.toEqual([
				'git', 'clone', '--quiet', '--branch', 'main', '--single-branch',
				'https://github.com/acme/product.git',
				'/home/.gateship/projects/.staging/x',
			]);
	});
});

describe('importRepository', () => {
	test('clones a new repository under GATESHIP_HOME/projects/<owner>/<repo> and registers it', async () => {
		const home = scratchRoot('gship-import-home-');
		const currentRoot = scratchRoot('gship-import-current-');
		const registry = openProjectRegistry(home);
		try {
			const project = await importRepository(
				{ repository: 'acme/product' },
				registry,
				currentRoot,
				home,
				{ clone: cloneLocally },
			);
			const destination = join(home, 'projects', 'acme', 'product');
			expect(project).toMatchObject({
				name: 'product',
				root: destination,
				readiness: 'ready',
				repository: 'acme/product',
				current: false,
			});
			expect(existsSync(destination)).toBe(true);
			expect(existsSync(join(destination, 'README.md'))).toBe(true);
			// The staging directory this import used is gone; nothing partial is left behind.
			const staging = join(home, 'projects', '.staging');
			expect(existsSync(staging) ? readdirSync(staging) : []).toEqual([]);
			expect(registry.list()).toHaveLength(1);
		} finally {
			registry.close();
		}
	});

	test('accepts an https://github.com URL the same way and is idempotent on a repeat import', async () => {
		const home = scratchRoot('gship-import-idempotent-home-');
		const currentRoot = scratchRoot('gship-import-idempotent-current-');
		const registry = openProjectRegistry(home);
		try {
			const first = await importRepository(
				{ repository: 'https://github.com/acme/product' },
				registry,
				currentRoot,
				home,
				{ clone: cloneLocally },
			);
			// The clone must not run a second time: the destination is already a
			// ready checkout of the same repository, so this only registers/returns.
			const second = await importRepository(
				{ repository: 'acme/product' },
				registry,
				currentRoot,
				home,
				{ clone: refusingClone() },
			);
			expect(second).toEqual(first);
			expect(registry.list()).toHaveLength(1);
		} finally {
			registry.close();
		}
	});

	test('refuses a destination that already holds something else, without writing or touching it', async () => {
		const home = scratchRoot('gship-import-conflict-home-');
		const currentRoot = scratchRoot('gship-import-conflict-current-');
		const destination = join(home, 'projects', 'acme', 'product');
		readyCheckout(destination, 'https://github.com/acme/other.git');
		const registry = openProjectRegistry(home);
		try {
			await expect(importRepository(
				{ repository: 'acme/product' },
				registry,
				currentRoot,
				home,
				{ clone: refusingClone() },
			)).rejects.toMatchObject({ code: 'destination-conflict', status: 409 });
			// Untouched: still the other repository's origin, and no registration.
			const origin = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: destination, encoding: 'utf8' }).trim();
			expect(origin).toBe('https://github.com/acme/other.git');
			expect(registry.list()).toEqual([]);
		} finally {
			registry.close();
		}
	});

	test('cleans up staging and registers nothing when the clone itself fails', async () => {
		const home = scratchRoot('gship-import-clone-fail-home-');
		const currentRoot = scratchRoot('gship-import-clone-fail-current-');
		const registry = openProjectRegistry(home);
		const failingClone: GitCloneRunner = async () => ({
			exitCode: 128,
			stdout: '',
			stderr: 'fatal: could not read Username for \'https://github.com\': terminal prompts disabled',
			timedOut: false,
		});
		try {
			await expect(importRepository(
				{ repository: 'acme/product' },
				registry,
				currentRoot,
				home,
				{ clone: failingClone },
			)).rejects.toMatchObject({ code: 'clone-failed', status: 502 });
			const destination = join(home, 'projects', 'acme', 'product');
			expect(existsSync(destination)).toBe(false);
			const staging = join(home, 'projects', '.staging');
			expect(existsSync(staging) ? readdirSync(staging) : []).toEqual([]);
			expect(registry.list()).toEqual([]);
		} finally {
			registry.close();
		}
	});

	test('cleans up staging and registers nothing when the clone times out', async () => {
		const home = scratchRoot('gship-import-timeout-home-');
		const currentRoot = scratchRoot('gship-import-timeout-current-');
		const registry = openProjectRegistry(home);
		const timedOutClone: GitCloneRunner = async () => ({
			exitCode: 124,
			stdout: '',
			stderr: '',
			timedOut: true,
		});
		try {
			await expect(importRepository(
				{ repository: 'acme/product' },
				registry,
				currentRoot,
				home,
				{ clone: timedOutClone },
			)).rejects.toMatchObject({ code: 'clone-timeout', status: 504 });
			expect(existsSync(join(home, 'projects', 'acme', 'product'))).toBe(false);
			const staging = join(home, 'projects', '.staging');
			expect(existsSync(staging) ? readdirSync(staging) : []).toEqual([]);
			expect(registry.list()).toEqual([]);
		} finally {
			registry.close();
		}
	});

	test('cleans up staging and registers nothing when a completed clone is not ready', async () => {
		const home = scratchRoot('gship-import-not-ready-home-');
		const currentRoot = scratchRoot('gship-import-not-ready-current-');
		const registry = openProjectRegistry(home);
		const cloneWithoutOrigin: GitCloneRunner = async (input) => {
			mkdirSync(input.destination, { recursive: true });
			execFileSync('git', ['init', '--quiet', '-b', 'main'], { cwd: input.destination });
			execFileSync('git', ['config', 'user.name', 'Test Operator'], { cwd: input.destination });
			execFileSync('git', ['config', 'user.email', 'operator@example.com'], { cwd: input.destination });
			writeFileSync(join(input.destination, 'README.md'), '# product\n');
			execFileSync('git', ['add', 'README.md'], { cwd: input.destination });
			execFileSync('git', ['commit', '--quiet', '-m', 'seed'], { cwd: input.destination });
			// No `origin` remote: readiness must refuse before anything is registered.
			return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
		};
		try {
			try {
				await importRepository(
					{ repository: 'acme/product' },
					registry,
					currentRoot,
					home,
					{ clone: cloneWithoutOrigin },
				);
				throw new Error('import unexpectedly succeeded');
			} catch (error) {
				expect(error).toBeInstanceOf(ProjectImportError);
				expect((error as ProjectImportError).code).toBe('project-not-ready');
				expect((error as ProjectImportError).status).toBe(409);
				expect((error as ProjectImportError).readiness).toMatchObject({ reason: 'origin-missing' });
			}
			expect(existsSync(join(home, 'projects', 'acme', 'product'))).toBe(false);
			const staging = join(home, 'projects', '.staging');
			expect(existsSync(staging) ? readdirSync(staging) : []).toEqual([]);
			expect(registry.list()).toEqual([]);
		} finally {
			registry.close();
		}
	});

	test('refuses an invalid repository before ever invoking the clone step', async () => {
		const home = scratchRoot('gship-import-invalid-home-');
		const currentRoot = scratchRoot('gship-import-invalid-current-');
		const registry = openProjectRegistry(home);
		try {
			await expect(importRepository(
				{ repository: 'not a valid repository' },
				registry,
				currentRoot,
				home,
				{ clone: refusingClone() },
			)).rejects.toMatchObject({ code: 'invalid-request', status: 400 });
			await expect(importRepository({}, registry, currentRoot, home, { clone: refusingClone() }))
				.rejects.toMatchObject({ code: 'invalid-request', status: 400 });
			expect(existsSync(join(home, 'projects'))).toBe(false);
			expect(registry.list()).toEqual([]);
		} finally {
			registry.close();
		}
	});
});
