import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

export interface CoverageReport {
	functions: number;
	lines: number;
}

export interface CoverageBudget {
	floors: CoverageReport;
}

export interface CoverageResult {
	ok: boolean;
	errors: string[];
}

export const BUDGET_PATH = 'scripts/coverage-budget.json';
const FLOOR_TOLERANCE_PP = 0.5;
const ALL_FILES_RE = /^All files\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)/;

export function parseCoverageOutput(output: string): CoverageReport {
	for (const line of output.split('\n')) {
		const match = ALL_FILES_RE.exec(line);
		if (match) {
			return {
				functions: Number(match[1]),
				lines: Number(match[2]),
			};
		}
	}
	return { functions: 0, lines: 0 };
}

export function checkCoverage(options: {
	getCoverage?: () => CoverageReport;
	readBudget?: () => CoverageBudget;
	cwd?: string;
} = {}): CoverageResult {
	const cwd = options.cwd ?? process.cwd();
	const getCoverage = options.getCoverage ?? (() => {
		const result = Bun.spawnSync(['bun', 'test', '--coverage'], { cwd });
		return parseCoverageOutput(
			new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr),
		);
	});
	const readBudget = options.readBudget ?? (() =>
		JSON.parse(readFileSync(join(cwd, BUDGET_PATH), 'utf8')) as CoverageBudget);
	const coverage = getCoverage();
	const floors = readBudget().floors;
	const errors: string[] = [];

	for (const metric of ['functions', 'lines'] as const) {
		if (coverage[metric] < floors[metric] - FLOOR_TOLERANCE_PP) {
			errors.push(
				`${metric} coverage ${coverage[metric].toFixed(2)}% is below floor ${floors[metric]}%`,
			);
		}
	}
	return { ok: errors.length === 0, errors };
}

if (import.meta.main) {
	const result = checkCoverage();
	for (const error of result.errors) process.stderr.write(`check:coverage: ${error}\n`);
	if (!result.ok) process.exit(1);
	process.stdout.write('check:coverage: ok\n');
}
