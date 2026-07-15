// test/record-golden.test.ts
//
// Unit tests for scripts/record-golden.ts (US-004, CAM-302 PRD).
//
// All tests drive buildRefreshTargets/refreshGoldenFixtures against a real
// mkdtempSync tmpdir (no mocked fs): the harness copies real files on real
// disk, so the test exercises real I/O rather than asserting a mock was
// called.

import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildRefreshTargets, refreshGoldenFixtures } from '../scripts/record-golden.ts';

describe('buildRefreshTargets', () => {
	test('resolves all four fixture sources under cwd/claudeDir', () => {
		const targets = buildRefreshTargets('/proj', '/proj/.claude');

		expect(targets).toEqual([
			{ fixtureName: 'worker-report.json', sourcePath: '/proj/scripts/cam/worker-report.json' },
			{ fixtureName: 'review-report.json', sourcePath: '/proj/scripts/cam/review-report.json' },
			{ fixtureName: 'orch-handoff.json', sourcePath: '/proj/.claude/.cam-orch-handoff.json' },
			{ fixtureName: 'handoff.json', sourcePath: '/proj/scripts/cam/handoff.json' },
		]);
	});
});

describe('refreshGoldenFixtures', () => {
	test('copies every target whose live source exists on disk', () => {
		const cwd = mkdtempSync(join(tmpdir(), 'cam-record-golden-'));
		try {
			const goldenDir = join(cwd, 'golden');
			mkdirSync(goldenDir, { recursive: true });
			const srcPath = join(cwd, 'live.json');
			writeFileSync(srcPath, '{"hello":"world"}\n', 'utf8');

			const { refreshed, skipped } = refreshGoldenFixtures(
				[{ fixtureName: 'live.json', sourcePath: srcPath }],
				goldenDir,
			);

			expect(refreshed).toEqual(['live.json']);
			expect(skipped).toEqual([]);
			expect(readFileSync(join(goldenDir, 'live.json'), 'utf8')).toBe('{"hello":"world"}\n');
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test('skips targets whose live source is absent, without erroring', () => {
		const cwd = mkdtempSync(join(tmpdir(), 'cam-record-golden-'));
		try {
			const goldenDir = join(cwd, 'golden');
			mkdirSync(goldenDir, { recursive: true });
			const missingPath = join(cwd, 'missing.json');

			const { refreshed, skipped } = refreshGoldenFixtures(
				[{ fixtureName: 'missing.json', sourcePath: missingPath }],
				goldenDir,
			);

			expect(refreshed).toEqual([]);
			expect(skipped).toEqual(['missing.json']);
			expect(existsSync(join(goldenDir, 'missing.json'))).toBe(false);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test('partitions a mix of present and absent sources correctly', () => {
		const cwd = mkdtempSync(join(tmpdir(), 'cam-record-golden-'));
		try {
			const goldenDir = join(cwd, 'golden');
			mkdirSync(goldenDir, { recursive: true });
			const presentPath = join(cwd, 'present.json');
			writeFileSync(presentPath, '{}\n', 'utf8');
			const missingPath = join(cwd, 'missing.json');

			const { refreshed, skipped } = refreshGoldenFixtures(
				[
					{ fixtureName: 'present.json', sourcePath: presentPath },
					{ fixtureName: 'missing.json', sourcePath: missingPath },
				],
				goldenDir,
			);

			expect(refreshed).toEqual(['present.json']);
			expect(skipped).toEqual(['missing.json']);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
