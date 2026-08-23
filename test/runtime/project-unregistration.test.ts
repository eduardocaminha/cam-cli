import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { openProjectRegistry, type ProjectRegistry } from '../../src/runtime/project-registry.ts';
import {
	ProjectUnregistrationError,
	unregisterProject,
} from '../../src/runtime/project-unregistration.ts';
import { RunStore } from '../../src/runtime/run-store.ts';
import { createTestTmpdir } from '../helpers/test-tmpdir.ts';

/** A scratch directory whose own path carries no symlink of its own. */
function scratchRoot(prefix: string): string {
	return realpathSync(createTestTmpdir(prefix));
}

/** A checkout the operator already has, with local history and a GitHub origin. */
function readyCheckout(root: string): void {
	execFileSync('git', ['init', '-b', 'main'], { cwd: root });
	execFileSync('git', ['config', 'user.name', 'Test Operator'], { cwd: root });
	execFileSync('git', ['config', 'user.email', 'operator@example.com'], { cwd: root });
	writeFileSync(join(root, 'README.md'), '# product\n');
	execFileSync('git', ['add', 'README.md'], { cwd: root });
	execFileSync('git', ['commit', '-m', 'seed'], { cwd: root });
	execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:acme/product.git'], { cwd: root });
	execFileSync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: root });
}

const ready = {
	state: 'ready' as const,
	name: 'product',
	repository: 'acme/product',
	remoteUrl: 'git@github.com:acme/product.git',
	sourceRef: 'origin/main' as const,
};

/**
 * Every durable file under `root`, by relative path and content digest.
 * SQLite's `-wal` and `-shm` sidecars are excluded: they are the transient
 * index of an open database, which any read -- including the strictly
 * read-only idle check -- refreshes without changing a byte of durable
 * content, and `runtime.sqlite` itself is digested here like every other file.
 */
function treeDigest(root: string): Record<string, string> {
	const digest: Record<string, string> = {};
	for (const entry of readdirSync(root, { recursive: true, encoding: 'utf8' })) {
		if (entry.endsWith('-wal') || entry.endsWith('-shm')) continue;
		const path = join(root, entry);
		if (!statSync(path).isFile()) continue;
		digest[relative(root, path)] = createHash('sha256').update(readFileSync(path)).digest('hex');
	}
	return digest;
}

/** The refusal a removal produced, or a failure naming the removal it allowed. */
function refusal(
	projectId: string,
	registry: ProjectRegistry,
	currentRoot: string,
): ProjectUnregistrationError {
	try {
		const removed = unregisterProject(projectId, registry, currentRoot);
		throw new Error(`removal was accepted for ${removed.id}`);
	} catch (error) {
		if (error instanceof ProjectUnregistrationError) return error;
		throw error;
	}
}

describe('unregistering a project', () => {
	test('removes only the registry row and leaves the whole checkout untouched', () => {
		const home = createTestTmpdir('gship-unregister-service-home-');
		const currentRoot = scratchRoot('gship-unregister-service-current-');
		const root = scratchRoot('gship-unregister-service-root-');
		readyCheckout(root);
		const stateDir = join(root, '.gship');
		mkdirSync(stateDir, { recursive: true });
		// A finished run: durable history the removal must keep and must not read
		// as a reason to refuse.
		const store = new RunStore(join(stateDir, 'runtime.sqlite'));
		store.createRun({
			id: 'run-done',
			issueId: 'GSHIP-1',
			sessionId: 'session-done',
			workspacePath: '/managed/run-done',
			createdAt: '2026-08-23T09:00:00.000Z',
		});
		store.transition({
			runId: 'run-done',
			toState: 'interrupted',
			kind: 'run.interrupted',
			createdAt: '2026-08-23T09:01:00.000Z',
		});
		store.transition({
			runId: 'run-done',
			toState: 'cancelled',
			kind: 'run.cancelled',
			createdAt: '2026-08-23T09:02:00.000Z',
		});
		store.close();
		const before = treeDigest(root);
		const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
		const worktree = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' });

		const registry = openProjectRegistry(home);
		const project = registry.reconcile({ root, stateDir, readiness: ready });
		expect(unregisterProject(project.id, registry, currentRoot))
			.toEqual({ ...project, current: false });
		expect(registry.get(project.id)).toBeNull();
		expect(registry.list()).toEqual([]);
		registry.close();

		// No file was deleted, added or rewritten, and no Git state moved.
		expect(treeDigest(root)).toEqual(before);
		expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' })).toBe(head);
		expect(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }))
			.toBe(worktree);
		expect(execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: root, encoding: 'utf8' }))
			.toBe('git@github.com:acme/product.git\n');
	});

	test('removes a registration whose project never had a runtime database', () => {
		const home = createTestTmpdir('gship-unregister-idle-home-');
		const currentRoot = scratchRoot('gship-unregister-idle-current-');
		const root = scratchRoot('gship-unregister-idle-root-');
		const registry = openProjectRegistry(home);
		const project = registry.reconcile({ root, stateDir: join(root, '.gship'), readiness: ready });

		expect(unregisterProject(project.id, registry, currentRoot).id).toBe(project.id);
		// The absent state directory stays absent: nothing was created to read it.
		expect(readdirSync(root)).toEqual([]);
		registry.close();
	});

	test('refuses the checkout this process booted from, because startup restores it', () => {
		const home = createTestTmpdir('gship-unregister-current-home-');
		const currentRoot = scratchRoot('gship-unregister-current-root-');
		const registry = openProjectRegistry(home);
		const current = registry.reconcile({
			root: currentRoot,
			stateDir: join(currentRoot, '.gship'),
			readiness: ready,
		});

		const error = refusal(current.id, registry, currentRoot);
		expect(error.code).toBe('project-is-current');
		expect(error.status).toBe(409);
		expect(error.message).toContain('another checkout');
		expect(registry.list().map((project) => project.id)).toEqual([current.id]);
		registry.close();
	});

	test('refuses a project whose run is not finished and allows it once the run ends', () => {
		const home = createTestTmpdir('gship-unregister-active-home-');
		const currentRoot = scratchRoot('gship-unregister-active-current-');
		const root = scratchRoot('gship-unregister-active-root-');
		const stateDir = join(root, '.gship');
		mkdirSync(stateDir, { recursive: true });
		const store = new RunStore(join(stateDir, 'runtime.sqlite'));
		store.createRun({
			id: 'run-active',
			issueId: 'GSHIP-2',
			sessionId: 'session-active',
			workspacePath: '/managed/run-active',
			createdAt: '2026-08-23T10:00:00.000Z',
		});
		store.transition({
			runId: 'run-active',
			toState: 'interrupted',
			kind: 'run.interrupted',
			createdAt: '2026-08-23T10:01:00.000Z',
		});
		const registry = openProjectRegistry(home);
		const project = registry.reconcile({ root, stateDir, readiness: ready });

		const error = refusal(project.id, registry, currentRoot);
		expect(error.code).toBe('project-has-active-run');
		expect(error.status).toBe(409);
		expect(error.message).toContain('run-active');
		expect(error.message).toContain('interrupted');
		expect(registry.list().map((candidate) => candidate.id)).toEqual([project.id]);

		store.transition({
			runId: 'run-active',
			toState: 'cancelled',
			kind: 'run.cancelled',
			createdAt: '2026-08-23T10:02:00.000Z',
		});
		store.close();
		expect(unregisterProject(project.id, registry, currentRoot).id).toBe(project.id);
		expect(registry.list()).toEqual([]);
		registry.close();
	});

	test('reports an unknown project id as a typed not-found', () => {
		const home = createTestTmpdir('gship-unregister-unknown-service-home-');
		const currentRoot = scratchRoot('gship-unregister-unknown-service-current-');
		const root = scratchRoot('gship-unregister-unknown-service-root-');
		const registry = openProjectRegistry(home);
		const project = registry.reconcile({ root, stateDir: join(root, '.gship'), readiness: ready });

		const error = refusal('unknown-project', registry, currentRoot);
		expect(error.code).toBe('project-not-found');
		expect(error.status).toBe(404);
		expect(registry.list().map((candidate) => candidate.id)).toEqual([project.id]);
		registry.close();
	});
});
