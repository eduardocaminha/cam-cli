// scripts/check-ci-parity.ts
//
// CI parity gate (US-002, CAM-59 PRD).
//
// Parses .github/workflows/ci.yml and verifies parity with the GATES manifest:
//   - Every 'bun run <script>' in CI must either be allowlisted or be a gate name.
//   - Every gate in the manifest must be covered by CI (either via 'bun run check:all'
//     as the spine, or by a direct 'bun run <gateName>' invocation).
//
// Usage: bun scripts/check-ci-parity.ts

import { load } from 'js-yaml';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { GATES, type Gate } from './check-all.ts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const CI_YML_PATH = '.github/workflows/ci.yml';

/**
 * 'bun run <X>' script names that are infra/harness, not quality-gate commands.
 * These are excluded from the parity check.
 */
const BUN_RUN_ALLOWLIST = new Set<string>(['check:all', 'check:ci-parity']);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ParityResult {
	ok: boolean;
	errors: string[];
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Extract every 'bun run <script>' script name from all run: steps in a
 * GitHub Actions workflow YAML string.
 *
 * Only 'bun run <script>' invocations are returned (not 'bunx', 'bun install',
 * 'bun test', or other bare commands); those are not gate-ish and are not
 * subject to the parity contract.
 */
export function extractBunRunScripts(workflowYaml: string): string[] {
	if (!workflowYaml.trim()) return [];

	const doc = load(workflowYaml) as Record<string, unknown> | null;
	if (!doc || typeof doc !== 'object') return [];

	const scripts: string[] = [];
	const jobs = doc['jobs'];
	if (!jobs || typeof jobs !== 'object') return scripts;

	for (const job of Object.values(jobs as Record<string, unknown>)) {
		if (!job || typeof job !== 'object') continue;
		const steps = (job as Record<string, unknown>)['steps'];
		if (!Array.isArray(steps)) continue;

		for (const step of steps) {
			if (!step || typeof step !== 'object') continue;
			const run = (step as Record<string, unknown>)['run'];
			if (typeof run !== 'string') continue;

			for (const rawLine of run.split('\n')) {
				const line = rawLine.trim();
				if (!line || line.startsWith('#')) continue;

				// Match "bun run <script>" at the start of a shell line
				const m = line.match(/^bun run (\S+)/);
				if (m) {
					const script = m[1];
					if (script) scripts.push(script);
				}
			}
		}
	}

	return scripts;
}

// ---------------------------------------------------------------------------
// Parity check
// ---------------------------------------------------------------------------

/**
 * Check parity between the GATES manifest and a CI workflow YAML string.
 *
 * Rules:
 *   1. Any 'bun run <X>' in CI (not allowlisted) must be a known gate name.
 *   2. Every gate must be covered: either CI has 'bun run check:all' (spine),
 *      or CI has 'bun run <gateName>' directly.
 *
 * @param workflowYaml - Raw YAML content of the CI workflow file.
 * @param gates - Gate manifest to check against. Defaults to the GATES export.
 * @returns ParityResult with ok flag and list of error strings.
 */
export function checkParity(
	workflowYaml: string,
	gates: Gate[] = GATES,
): ParityResult {
	const scripts = extractBunRunScripts(workflowYaml);
	const errors: string[] = [];
	const gateNames = new Set(gates.map((g) => g.name));
	const hasSpine = scripts.includes('check:all');

	// Rule 1: any non-allowlisted 'bun run X' must be a known gate name
	for (const script of scripts) {
		if (BUN_RUN_ALLOWLIST.has(script)) continue;
		if (gateNames.has(script)) continue;
		errors.push(
			`CI invokes 'bun run ${script}' which is not in the GATES manifest`,
		);
	}

	// Rule 2: every gate must be covered
	if (hasSpine) {
		// 'bun run check:all' covers all gates
	} else {
		for (const gate of gates) {
			if (!scripts.includes(gate.name)) {
				errors.push(
					`GATES manifest entry '${gate.name}' is not covered by CI`,
				);
			}
		}
	}

	return { ok: errors.length === 0, errors };
}

/**
 * Load a CI workflow YAML from disk and run the parity check.
 *
 * Returns a ParityResult. When the file does not exist the result has ok:false
 * and errors contains a 'ci.yml not found' message.
 */
export function checkParityFromFile(
	filePath: string,
	gates: Gate[] = GATES,
): ParityResult {
	if (!existsSync(filePath)) {
		return {
			ok: false,
			errors: [`ci.yml not found at ${filePath}`],
		};
	}
	const yaml = readFileSync(filePath, 'utf8');
	return checkParity(yaml, gates);
}

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------

if (import.meta.main) {
	const ciPath = join(process.cwd(), CI_YML_PATH);
	const result = checkParityFromFile(ciPath);

	for (const error of result.errors) {
		process.stderr.write(`check:ci-parity: ${error}\n`);
	}

	if (!result.ok) {
		process.exit(1);
	}

	process.stdout.write('check:ci-parity: ok\n');
}
