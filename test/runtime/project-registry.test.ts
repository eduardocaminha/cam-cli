import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

import {
	openProjectRegistry,
	PROJECT_REGISTRY_DATABASE,
	resolveGateshipHome,
} from '../../src/runtime/project-registry.ts';
import { createTestTmpdir } from '../helpers/test-tmpdir.ts';

/** A scratch directory whose own path carries no symlink of its own. */
function scratchRoot(prefix: string): string {
	return realpathSync(createTestTmpdir(prefix));
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
