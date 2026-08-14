import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Glob } from 'bun';
import { describe, expect, test } from 'bun:test';
import {
	DEBT_MARKER_SCAN_GLOB,
	filterScannablePaths as filterDebtPaths,
} from '../scripts/check-debt-markers.ts';
import {
	filterScannablePaths as filterSleepPaths,
	TEST_SLEEP_SCAN_GLOB,
} from '../scripts/check-test-sleeps.ts';
import {
	filterScannablePaths as filterTmpdirPaths,
	TEST_TMPDIR_SCAN_GLOB,
} from '../scripts/check-test-tmpdir.ts';

describe('webui quality-gate scope', () => {
	const repoRoot = fileURLToPath(new URL('..', import.meta.url));

	test.each([
		['debt markers', DEBT_MARKER_SCAN_GLOB, filterDebtPaths],
		['test sleeps', TEST_SLEEP_SCAN_GLOB, filterSleepPaths],
		['test tmpdir', TEST_TMPDIR_SCAN_GLOB, filterTmpdirPaths],
	])('%s scans webui/src without reaching webui/dist', (_name, pattern, filterPaths) => {
		const glob = new Glob(pattern);
		const isScannable = (path: string): boolean =>
			glob.match(path) && filterPaths([path]).length === 1;
		const scannedPaths = filterPaths([...glob.scanSync({ cwd: repoRoot })]);

		expect(isScannable('webui/src/probe.test.ts')).toBe(true);
		expect(isScannable('webui/src/components/Probe.tsx')).toBe(true);
		expect(isScannable('webui/dist/probe.test.ts')).toBe(false);
		expect(scannedPaths).toContain('webui/src/main.tsx');
	});

	test('Biome includes TypeScript and TSX files throughout webui', () => {
		const config = JSON.parse(
			readFileSync(new URL('../biome.json', import.meta.url), 'utf8'),
		) as { files?: { includes?: string[] } };

		expect(config.files?.includes).toContain('webui/**/*.{ts,tsx}');
	});
});
