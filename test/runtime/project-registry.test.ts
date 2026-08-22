import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

import {
	openProjectRegistry,
	PROJECT_REGISTRY_DATABASE,
	resolveGateshipHome,
} from '../../src/runtime/project-registry.ts';
import { createTestTmpdir } from '../helpers/test-tmpdir.ts';

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
			env: {}, nativeHome: '/Users/operator', containerStateDir: '/state/project',
		})).toBe('/state/project');
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
});
