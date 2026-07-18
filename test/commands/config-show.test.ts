// test/commands/config-show.test.ts
//
// Tests for `cam config --show` (US-008; backend column updated in US-003,
// CAM-349).
//
// Verifies that printConfigShow / runConfig({ show: true }) prints a
// plain-text table of 6 phase rows (model + backend columns, both resolved
// via readPhaseModel/readPhaseBackend) without entering the Ink render path
// (no raw-mode, no TTY requirement).

import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { printConfigShow, runConfig } from '../../src/commands/config.ts';
import { DEFAULTS } from '../../src/config/models.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), 'cam-config-show-'));
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function captureShow(configPath: string): string {
	const lines: string[] = [];
	printConfigShow(configPath, (s) => lines.push(s));
	return lines.join('');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('printConfigShow prints 6 phase rows (model + backend columns) with defaults when config is absent', () => {
	const configPath = join(tmpDir, 'missing.toml');
	const output = captureShow(configPath);
	const lines = output.split('\n').filter(Boolean);

	// 1 header + 1 divider + 6 phases = 8 lines
	expect(lines.length).toBe(8);

	// Header row
	expect(lines[0]).toMatch(/^phase\s+model\s+backend/);

	// Divider row
	expect(lines[1]).toMatch(/^-+$/);

	// All 6 phases appear, each with the default backend
	for (const phase of ['orchestrator', 'planner', 'auditor', 'implementer', 'reviewer', 'ship']) {
		const line = lines.find((l) => l.startsWith(phase));
		expect(line).toBeDefined();
		expect(line).toContain(DEFAULTS['backend']);
	}
});

test('printConfigShow shows default models when config is absent', () => {
	const configPath = join(tmpDir, 'missing.toml');
	const output = captureShow(configPath);

	expect(output).toContain(DEFAULTS['orchestrator']);
	expect(output).toContain(DEFAULTS['implementer']);
	expect(output).toContain(DEFAULTS['backend']);
});

test('printConfigShow shows configured models and per-phase backends when config is present', () => {
	const configPath = join(tmpDir, 'project.toml');
	writeFileSync(
		configPath,
		[
			'[models]',
			'orchestrator = "claude-haiku-3-5"',
			'planner = "claude-haiku-3-5"',
			'auditor = "claude-haiku-3-5"',
			'implementer = "claude-haiku-3-5"',
			'reviewer = "claude-haiku-3-5"',
			'ship = "claude-haiku-3-5"',
			'',
			'[backend]',
			'orchestrator = "codex"',
			'planner = "codex"',
			'auditor = "codex"',
			'implementer = "codex"',
			'reviewer = "codex"',
			'ship = "codex"',
		].join('\n'),
		'utf8',
	);

	const output = captureShow(configPath);

	// All phase rows use the configured model and backend
	for (const phase of ['orchestrator', 'planner', 'auditor', 'implementer', 'reviewer', 'ship']) {
		const re = new RegExp(`^${phase}\\s+claude-haiku-3-5\\s+codex`, 'm');
		expect(re.test(output)).toBe(true);
	}
});

test('printConfigShow produces exactly 6 data rows (one per phase)', () => {
	const configPath = join(tmpDir, 'missing.toml');
	const output = captureShow(configPath);
	// Data rows = all non-header, non-divider lines
	const dataLines = output
		.split('\n')
		.filter(Boolean)
		.filter((l) => !l.startsWith('phase') && !l.startsWith('-'));
	expect(dataLines.length).toBe(6);
});

test('runConfig({ show: true }) returns 0 and prints the table without Ink (no TTY required)', async () => {
	const configPath = join(tmpDir, 'missing.toml');
	const lines: string[] = [];

	const exitCode = await runConfig({
		show: true,
		configPath,
		writer: (s) => lines.push(s),
	});

	expect(exitCode).toBe(0);
	const output = lines.join('');
	expect(output).toContain('phase');
	expect(output).toContain('model');
	expect(output).toContain('backend');
});

test('printConfigShow columns are aligned: phase column is padded to the same width', () => {
	const configPath = join(tmpDir, 'missing.toml');
	const output = captureShow(configPath);
	const lines = output.split('\n').filter(Boolean);

	// The header's "model" word marks the column offset every data row's model
	// value must start at (independent of the model value's literal text,
	// which is now a tier alias like "opus"/"sonnet", not always "claude-...").
	const header = lines[0]!;
	const modelColStart = header.indexOf('model');
	expect(modelColStart).toBeGreaterThan(0);

	const dataLines = lines.filter((l) => !l.startsWith('phase') && !l.startsWith('-'));
	expect(dataLines.length).toBeGreaterThan(0);
	for (const l of dataLines) {
		expect(l[modelColStart]).not.toBe(' ');
		expect(l[modelColStart]).not.toBeUndefined();
	}
});
