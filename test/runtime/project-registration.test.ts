import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';

import type { ProjectCommandRunner } from '../../src/runtime/project-readiness.ts';
import {
	PROJECT_STATE_DIRECTORY,
	ProjectRegistrationError,
	ensureProjectStateIgnored,
	registerExistingCheckout,
} from '../../src/runtime/project-registration.ts';
import { openProjectRegistry, type RegisteredProject } from '../../src/runtime/project-registry.ts';
import { createTestTmpdir } from '../helpers/test-tmpdir.ts';

/** A scratch directory whose own path carries no symlink of its own. */
function scratchRoot(prefix: string): string {
	return realpathSync(createTestTmpdir(prefix));
}

/** A local checkout with a GitHub origin and an origin/main ref, and nothing remote. */
function readyCheckout(root: string, remoteUrl = 'git@github.com:acme/product.git'): void {
	execFileSync('git', ['init', '-b', 'main'], { cwd: root });
	execFileSync('git', ['config', 'user.name', 'Test Operator'], { cwd: root });
	execFileSync('git', ['config', 'user.email', 'operator@example.com'], { cwd: root });
	writeFileSync(join(root, 'README.md'), '# product\n');
	execFileSync('git', ['add', 'README.md'], { cwd: root });
	execFileSync('git', ['commit', '-m', 'seed'], { cwd: root });
	execFileSync('git', ['remote', 'add', 'origin', remoteUrl], { cwd: root });
	execFileSync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: root });
}

describe('registering an existing checkout', () => {
	test('protects runtime state without hiding the tracked project contract', () => {
		const root = scratchRoot('gship-register-ignore-');
		readyCheckout(root);
		mkdirSync(join(root, '.gateship'), { recursive: true });
		writeFileSync(join(root, '.gateship', 'project.json'), '{}\n');
		execFileSync('git', ['add', '.gateship/project.json'], { cwd: root });
		execFileSync('git', ['commit', '-m', 'tracked project contract'], { cwd: root });

		const stateDir = join(root, PROJECT_STATE_DIRECTORY);
		ensureProjectStateIgnored(root, stateDir);
		expect(readFileSync(join(stateDir, '.gitignore'), 'utf8')).toBe('*\n');
		ensureProjectStateIgnored(root, stateDir);
		expect(readFileSync(join(stateDir, '.gitignore'), 'utf8')).toBe('*\n');

		writeFileSync(join(stateDir, '.gitignore'), 'runtime.sqlite');
		ensureProjectStateIgnored(root, stateDir);
		expect(readFileSync(join(stateDir, '.gitignore'), 'utf8')).toBe('runtime.sqlite\n*\n');
		ensureProjectStateIgnored(root, stateDir);
		expect(readFileSync(join(stateDir, '.gitignore'), 'utf8')).toBe('runtime.sqlite\n*\n');

		writeFileSync(join(stateDir, 'runtime.sqlite'), 'runtime');
		expect(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' })).toBe('');
		expect(execFileSync('git', ['ls-files', '.gateship/project.json'], {
			cwd: root,
			encoding: 'utf8',
		})).toBe('.gateship/project.json\n');
	});

	test('propagates non-ENOENT read failures without replacing the path', () => {
		const root = scratchRoot('gship-register-ignore-error-');
		readyCheckout(root);
		const ignorePath = join(root, PROJECT_STATE_DIRECTORY, '.gitignore');
		mkdirSync(ignorePath, { recursive: true });

		expect(() => ensureProjectStateIgnored(root, join(root, PROJECT_STATE_DIRECTORY))).toThrow();
		expect(statSync(ignorePath).isDirectory()).toBe(true);
	});

	test('project-owned mutable state lives beside the checkout, as .gship', () => {
		expect(PROJECT_STATE_DIRECTORY).toBe('.gship');
	});

	test('registers one existing checkout from a subdirectory, a symlink or a repeat', () => {
		const home = createTestTmpdir('gship-register-home-');
		const root = scratchRoot('gship-register-root-');
		readyCheckout(root);
		mkdirSync(join(root, 'src', 'nested'), { recursive: true });
		const alias = join(scratchRoot('gship-register-alias-'), 'product');
		symlinkSync(root, alias);
		const currentRoot = scratchRoot('gship-register-current-');

		const registry = openProjectRegistry(home);
		const fromSubdirectory = registerExistingCheckout(
			{ root: join(root, 'src', 'nested') },
			registry,
			currentRoot,
		);
		expect(fromSubdirectory).toEqual({
			id: expect.any(String),
			name: basename(root),
			root,
			stateDir: join(root, '.gship'),
			readiness: 'ready',
			repository: 'acme/product',
			// Registering a checkout never claims it is the root this process serves.
			current: false,
		});
		// The same checkout named three ways stays one registration with one identity.
		expect(registerExistingCheckout({ root: alias }, registry, currentRoot))
			.toEqual(fromSubdirectory);
		expect(registerExistingCheckout({ root }, registry, currentRoot)).toEqual(fromSubdirectory);
		expect(registry.list()).toHaveLength(1);
		// Nothing on disk is touched: no state directory is created by registering.
		expect(existsSync(join(root, '.gship'))).toBe(false);
		registry.close();

		const restarted = openProjectRegistry(home);
		expect(restarted.get(fromSubdirectory.id, root)).toEqual({
			...fromSubdirectory,
			current: true,
		});
		restarted.close();
	});

	test('reconciles a linked worktree and its subdirectory to the primary checkout', () => {
		const home = createTestTmpdir('gship-register-worktree-home-');
		const root = scratchRoot('gship-register-worktree-root-');
		const worktree = scratchRoot('gship-register-worktree-linked-');
		readyCheckout(root);
		execFileSync('git', ['worktree', 'add', '-b', 'linked-registration', worktree], { cwd: root });
		mkdirSync(join(worktree, 'src'), { recursive: true });
		const currentRoot = scratchRoot('gship-register-worktree-current-');
		const registry = openProjectRegistry(home);

		const primary = registerExistingCheckout({ root }, registry, currentRoot);
		expect(registerExistingCheckout({ root: join(worktree, 'src') }, registry, currentRoot))
			.toEqual(primary);
		expect(registerExistingCheckout({ root: worktree }, registry, currentRoot)).toEqual(primary);
		expect(registry.list()).toEqual([primary]);
		registry.close();
	});

	test('keeps one state directory per registered checkout', () => {
		const home = createTestTmpdir('gship-register-state-home-');
		const currentRoot = scratchRoot('gship-register-state-current-');
		const first = scratchRoot('gship-register-state-first-');
		const second = scratchRoot('gship-register-state-second-');
		readyCheckout(first, 'https://github.com/acme/first.git');
		readyCheckout(second, 'https://github.com/acme/second');

		const registry = openProjectRegistry(home);
		registerExistingCheckout({ root: first }, registry, currentRoot);
		registerExistingCheckout({ root: second }, registry, currentRoot);
		expect(registry.list().map((project) => [project.root, project.stateDir, project.repository]))
			.toEqual(expect.arrayContaining([
				[first, join(first, '.gship'), 'acme/first'],
				[second, join(second, '.gship'), 'acme/second'],
			]));
		registry.close();
	});

	test('refuses every unready root without writing the registry', () => {
		const home = createTestTmpdir('gship-register-refusal-home-');
		const currentRoot = scratchRoot('gship-register-refusal-current-');
		const registry = openProjectRegistry(home);
		const refusal = (body: unknown, run?: ProjectCommandRunner): ProjectRegistrationError => {
			let registered: RegisteredProject | null = null;
			try {
				registered = registerExistingCheckout(body, registry, currentRoot, run);
			} catch (error) {
				if (error instanceof ProjectRegistrationError) return error;
				throw error;
			}
			throw new Error(`registration was accepted as ${registered.id}`);
		};

		expect(refusal({}).code).toBe('invalid-request');
		expect(refusal({ root: '   ' }).code).toBe('invalid-request');
		expect(refusal({ root: 'relative/checkout' }).code).toBe('invalid-request');
		expect(refusal({ root: join(currentRoot, 'absent') }).code).toBe('root-not-found');

		const file = join(currentRoot, 'checkout.txt');
		writeFileSync(file, 'not a directory');
		expect(refusal({ root: file }).code).toBe('root-not-directory');

		// Injected metadata, because the suite's own scratch root is a Git
		// repository fence: a real scratch directory always has a top level.
		const notRepository = refusal({ root: currentRoot }, () => ({ exitCode: 128, stdout: '' }));
		expect(notRepository.code).toBe('project-not-ready');
		expect(notRepository.readiness)
			.toMatchObject({ state: 'needs-attention', reason: 'not-repository' });
		expect(notRepository.message)
			.toBe('The current folder contains files but is not part of a Git repository.');

		const originless = scratchRoot('gship-register-refusal-originless-');
		readyCheckout(originless);
		execFileSync('git', ['remote', 'remove', 'origin'], { cwd: originless });
		expect(refusal({ root: originless }).readiness).toMatchObject({ reason: 'origin-missing' });

		const elsewhere = scratchRoot('gship-register-refusal-elsewhere-');
		readyCheckout(elsewhere, 'git@gitlab.com:acme/product.git');
		expect(refusal({ root: elsewhere }).readiness)
			.toMatchObject({ reason: 'github-origin-required' });

		const unfetched = scratchRoot('gship-register-refusal-unfetched-');
		readyCheckout(unfetched);
		execFileSync('git', ['update-ref', '-d', 'refs/remotes/origin/main'], { cwd: unfetched });
		expect(refusal({ root: unfetched }).readiness)
			.toMatchObject({ reason: 'origin-main-missing' });

		expect(registry.list()).toEqual([]);
		registry.close();
	});
});
