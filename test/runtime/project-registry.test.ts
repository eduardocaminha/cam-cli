import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';

import type { ProjectCommandRunner } from '../../src/runtime/project-readiness.ts';
import {
	ProjectRegistrationError,
	registerExistingCheckout,
} from '../../src/runtime/project-registration.ts';
import {
	openProjectRegistry,
	PROJECT_REGISTRY_DATABASE,
	type RegisteredProject,
	resolveGateshipHome,
} from '../../src/runtime/project-registry.ts';
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

const ready = {
	state: 'ready' as const,
	name: 'product',
	repository: 'acme/product',
	remoteUrl: 'git@github.com:acme/product.git',
	sourceRef: 'origin/main' as const,
};

describe('global project registry', () => {
	test('requires an explicit GATESHIP_HOME to be absolute and defaults native mode to ~/.gateship', () => {
		expect(() => resolveGateshipHome({ env: { GATESHIP_HOME: 'relative/home' } }))
			.toThrow('GATESHIP_HOME must be an absolute path');
		expect(resolveGateshipHome({ env: {}, nativeHome: '/Users/operator' }))
			.toBe('/Users/operator/.gateship');
		expect(resolveGateshipHome({
			env: { GATESHIP_HOME: '/var/lib/gateship' }, nativeHome: '/Users/operator',
		})).toBe('/var/lib/gateship');
	});

	test('reconciles canonical roots uniquely and preserves identity across restarts', () => {
		const home = createTestTmpdir('gship-project-registry-home-');
		const root = createTestTmpdir('gship-project-registry-root-');
		const aliasParent = createTestTmpdir('gship-project-registry-alias-');
		const alias = join(aliasParent, 'product');
		symlinkSync(root, alias);
		const firstStateDir = join(root, '.gship');
		const first = openProjectRegistry(home);
		const created = first.reconcile({ root: alias, stateDir: firstStateDir, readiness: ready });
		first.close();

		const secondStateDir = createTestTmpdir('gship-project-registry-state-');
		const restarted = openProjectRegistry(home);
		const reconciled = restarted.reconcile({ root, stateDir: secondStateDir, readiness: ready });
		expect(reconciled).toEqual({
			id: created.id,
			name: basename(root),
			root,
			stateDir: secondStateDir,
			readiness: 'ready',
			repository: 'acme/product',
			current: true,
		});
		expect(restarted.list(alias)).toHaveLength(1);
		restarted.close();
	});

	test('keeps the global database separate and never moves existing project state', () => {
		const home = createTestTmpdir('gship-project-registry-separate-home-');
		const root = createTestTmpdir('gship-project-registry-existing-root-');
		const stateDir = createTestTmpdir('gship-project-registry-existing-state-');
		const runtime = join(stateDir, 'runtime.sqlite');
		writeFileSync(runtime, 'existing runtime bytes');

		const registry = openProjectRegistry(home);
		registry.reconcile({
			root,
			stateDir,
			readiness: { state: 'empty', name: 'product', detail: 'empty' },
		});
		registry.close();

		expect(readFileSync(runtime, 'utf8')).toBe('existing runtime bytes');
		expect(existsSync(join(home, PROJECT_REGISTRY_DATABASE))).toBe(true);
		expect(existsSync(resolve(home, 'runtime.sqlite'))).toBe(false);
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

	test('resolves registration-owned locations by opaque project id', () => {
		const home = createTestTmpdir('gship-project-registry-resolve-home-');
		const root = createTestTmpdir('gship-project-registry-resolve-root-');
		const stateDir = createTestTmpdir('gship-project-registry-resolve-state-');
		const registry = openProjectRegistry(home);
		const registered = registry.reconcile({ root, stateDir, readiness: ready });

		expect(registry.get(registered.id, root)).toEqual(registered);
		expect(registry.get('unknown-project', root)).toBeNull();
		registry.close();
	});

	// GSHIP-717: the reverse of registering, and only that. The row goes; the
	// checkout, its own state directory and its runtime database do not.
	test('unregisters one row by id, leaves every other row and the project files alone', () => {
		const home = createTestTmpdir('gship-unregister-home-');
		const root = scratchRoot('gship-unregister-root-');
		const stateDir = join(root, '.gship');
		mkdirSync(stateDir, { recursive: true });
		const runtime = join(stateDir, 'runtime.sqlite');
		writeFileSync(runtime, 'existing runtime bytes');
		writeFileSync(join(root, 'README.md'), '# product\n');
		const kept = scratchRoot('gship-unregister-kept-');

		const registry = openProjectRegistry(home);
		const removable = registry.reconcile({ root, stateDir, readiness: ready });
		const other = registry.reconcile({
			root: kept,
			stateDir: join(kept, '.gship'),
			readiness: ready,
		});

		expect(registry.unregister(removable.id)).toEqual({
			outcome: 'unregistered',
			project: { ...removable, current: false },
		});
		expect(registry.get(removable.id)).toBeNull();
		expect(registry.list().map((project) => project.id)).toEqual([other.id]);
		// Nothing on disk was read, moved or removed by dropping the row.
		expect(readFileSync(runtime, 'utf8')).toBe('existing runtime bytes');
		expect(existsSync(join(root, 'README.md'))).toBe(true);
		expect(existsSync(stateDir)).toBe(true);
		registry.close();

		// The removal is durable, and the same checkout can be registered again.
		const restarted = openProjectRegistry(home);
		expect(restarted.list().map((project) => project.id)).toEqual([other.id]);
		expect(restarted.reconcile({ root, stateDir, readiness: ready }).root).toBe(root);
		restarted.close();
	});

	test('reports an unknown id as a typed not-found instead of throwing', () => {
		const registry = openProjectRegistry(createTestTmpdir('gship-unregister-unknown-home-'));
		const root = createTestTmpdir('gship-unregister-unknown-root-');
		const registered = registry.reconcile({ root, stateDir: join(root, '.gship'), readiness: ready });

		expect(registry.unregister('unknown-project')).toEqual({ outcome: 'not-found' });
		expect(registry.unregister('')).toEqual({ outcome: 'not-found' });
		// A refused removal leaves the registry exactly as it was.
		expect(registry.list().map((project) => project.id)).toEqual([registered.id]);
		registry.close();
	});
});
