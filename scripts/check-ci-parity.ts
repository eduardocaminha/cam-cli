import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';

import { GATES, type Gate } from './check-all.ts';

const CI_YML_PATH = '.github/workflows/ci.yml';
const BUN_RUN_ALLOWLIST = new Set(['check:all', 'build']);

export interface ParityResult {
	ok: boolean;
	errors: string[];
}

function bunRunFromShellLine(line: string): string | undefined {
	if (!line || line.startsWith('#')) return undefined;
	return line.match(/^bun run (\S+)/)?.[1];
}

/** Extract `bun run <script>` commands from inline and block `run:` steps. */
export function extractBunRunScripts(workflowYaml: string): string[] {
	const scripts: string[] = [];
	const lines = workflowYaml.split('\n');
	let blockIndent: number | undefined;

	for (const rawLine of lines) {
		const indent = rawLine.match(/^\s*/)?.[0].length ?? 0;
		const trimmed = rawLine.trim();
		if (blockIndent !== undefined) {
			if (trimmed.length === 0) continue;
			if (indent > blockIndent) {
				const script = bunRunFromShellLine(trimmed);
				if (script) scripts.push(script);
				continue;
			}
			blockIndent = undefined;
		}

		const run = rawLine.match(/^\s*(?:-\s+)?run:\s*(.*)$/)?.[1]?.trim();
		if (run === undefined) continue;
		if (run === '|' || run === '>') {
			blockIndent = indent;
			continue;
		}
		const script = bunRunFromShellLine(run);
		if (script) scripts.push(script);
	}

	return scripts;
}

export function checkParity(
	workflowYaml: string,
	gates: Gate[] = GATES,
): ParityResult {
	const scripts = extractBunRunScripts(workflowYaml);
	const gateNames = new Set(gates.map((gate) => gate.name));
	const errors: string[] = [];

	for (const script of scripts) {
		if (!BUN_RUN_ALLOWLIST.has(script) && !gateNames.has(script)) {
			errors.push(`CI invokes 'bun run ${script}' which is not in the GATES manifest`);
		}
	}

	if (!scripts.includes('check:all')) {
		for (const gate of gates) {
			if (!scripts.includes(gate.name)) {
				errors.push(`GATES manifest entry '${gate.name}' is not covered by CI`);
			}
		}
	}

	return { ok: errors.length === 0, errors };
}

export function checkBunVersionPin(
	workflowYaml: string,
	pinnedBunVersion: string | null,
): ParityResult {
	const errors: string[] = [];
	if (pinnedBunVersion === null) {
		errors.push('.bun-version is missing or malformed (expected an exact semver like 1.3.13)');
	}
	if (!workflowYaml.trim()) {
		errors.push('ci.yml is empty; cannot verify the bun-version-file pin');
		return { ok: false, errors };
	}

	const lines = workflowYaml.split('\n');
	const setupIndex = lines.findIndex((line) => /uses:\s*oven-sh\/setup-bun/.test(line));
	if (setupIndex < 0) {
		errors.push('ci.yml has no oven-sh/setup-bun step');
		return { ok: false, errors };
	}
	const setupIndent = lines[setupIndex]!.match(/^\s*/)?.[0].length ?? 0;
	const stepLines = [lines[setupIndex]!];
	for (const line of lines.slice(setupIndex + 1)) {
		const indent = line.match(/^\s*/)?.[0].length ?? 0;
		if (line.trim().startsWith('- ') && indent <= setupIndent) break;
		stepLines.push(line);
	}
	const step = stepLines.join('\n');
	if (!/^\s*bun-version-file:\s*\.bun-version\s*$/m.test(step)) {
		errors.push("setup-bun step lacks 'bun-version-file: .bun-version'");
	}
	const floating = step.match(/^\s*bun-version:\s*(\S+)\s*$/m)?.[1];
	if (floating) {
		errors.push(`setup-bun step floats via 'bun-version: ${floating}' instead of pinning through bun-version-file`);
	}
	return { ok: errors.length === 0, errors };
}

function readPinnedVersion(filePath: string): string | null {
	if (!existsSync(filePath)) return null;
	const value = readFileSync(filePath, 'utf8').trim();
	return /^\d+\.\d+\.\d+$/.test(value) ? value : null;
}

export function checkParityFromFile(
	filePath: string,
	gates: Gate[] = GATES,
): ParityResult {
	if (!existsSync(filePath)) {
		return { ok: false, errors: [`ci.yml not found at ${filePath}`] };
	}
	const workflow = readFileSync(filePath, 'utf8');
	const parity = checkParity(workflow, gates);
	const pinPath = resolve(dirname(filePath), '..', '..', '.bun-version');
	const bunPin = checkBunVersionPin(workflow, readPinnedVersion(pinPath));
	return {
		ok: parity.ok && bunPin.ok,
		errors: [...parity.errors, ...bunPin.errors],
	};
}

if (import.meta.main) {
	const result = checkParityFromFile(join(process.cwd(), CI_YML_PATH));
	for (const error of result.errors) process.stderr.write(`check:ci-parity: ${error}\n`);
	if (!result.ok) process.exit(1);
	process.stdout.write('check:ci-parity: ok\n');
}
