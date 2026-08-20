import { describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';

import {
	inspectProject,
	type ProjectCommandResult,
} from '../../src/runtime/project-readiness.ts';
import { createTestTmpdir } from '../helpers/test-tmpdir.ts';

type ResultByCommand = Record<string, ProjectCommandResult>;

function runner(results: ResultByCommand) {
	return (_cwd: string, args: readonly string[]): ProjectCommandResult =>
		results[args.join(' ')] ?? { exitCode: 1, stdout: '' };
}

describe('project readiness', () => {
	test('a directory with only Gateship runtime state is an empty onboarding target', () => {
		const cwd = createTestTmpdir('gship-project-empty-');
		mkdirSync(join(cwd, '.gship'));

		expect(inspectProject(cwd, runner({}))).toEqual({
			state: 'empty',
			name: basename(cwd),
			detail: 'Esta pasta ainda não contém um projeto Git.',
		});
	});

	test('a GitHub origin and origin/main make the project ready', () => {
		const run = runner({
			'rev-parse --show-toplevel': { exitCode: 0, stdout: '/workspace/gateship' },
			'remote get-url origin': { exitCode: 0, stdout: 'git@github.com:acme/gateship.git' },
			'rev-parse --verify --quiet refs/remotes/origin/main^{commit}': {
				exitCode: 0,
				stdout: 'abc123',
			},
		});

		expect(inspectProject('/workspace/gateship', run)).toEqual({
			state: 'ready',
			name: 'gateship',
			repository: 'acme/gateship',
			remoteUrl: 'git@github.com:acme/gateship.git',
			sourceRef: 'origin/main',
		});
	});

	test('the supported HTTPS and ssh URL forms resolve to the same repository', () => {
		for (const remoteUrl of [
			'https://github.com/acme/product.git',
			'ssh://git@github.com/acme/product.git',
		]) {
			const run = runner({
				'rev-parse --show-toplevel': { exitCode: 0, stdout: '/workspace/product' },
				'remote get-url origin': { exitCode: 0, stdout: remoteUrl },
				'rev-parse --verify --quiet refs/remotes/origin/main^{commit}': {
					exitCode: 0,
					stdout: 'abc123',
				},
			});
			expect(inspectProject('/workspace/product', run)).toMatchObject({
				state: 'ready',
				repository: 'acme/product',
			});
		}
	});

	test('each local prerequisite reports one deterministic reason', () => {
		const cases: readonly [ResultByCommand, string, string][] = [
			[{}, 'not-repository', 'não pertence a um repositório Git'],
			[{
				'rev-parse --show-toplevel': { exitCode: 0, stdout: '/workspace/product' },
			}, 'origin-missing', 'não tem um remote chamado origin'],
			[{
				'rev-parse --show-toplevel': { exitCode: 0, stdout: '/workspace/product' },
				'remote get-url origin': { exitCode: 0, stdout: 'git@gitlab.com:acme/product.git' },
			}, 'github-origin-required', 'precisa apontar para um repositório no GitHub.com'],
			[{
				'rev-parse --show-toplevel': { exitCode: 0, stdout: '/workspace/product' },
				'remote get-url origin': { exitCode: 0, stdout: 'https://github.com/acme/product.git' },
			}, 'origin-main-missing', 'origin/main ainda não existe'],
		];

		for (const [results, reason, detail] of cases) {
			const cwd = reason === 'not-repository'
				? (() => {
					const directory = createTestTmpdir('gship-project-files-');
					mkdirSync(join(directory, 'src'));
					return directory;
				})()
				: '/workspace/product';
			expect(inspectProject(cwd, runner(results))).toMatchObject({
				state: 'needs-attention',
				reason,
				detail: expect.stringContaining(detail),
			});
		}
	});
});
