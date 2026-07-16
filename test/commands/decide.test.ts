// test/commands/decide.test.ts
//
// Unit tests for `cam decide <decision>` — the operator-decision gate
// resolver (US-002, CAM-241/153).

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseDecideArgs, runDecide } from '../../src/commands/decide.ts';
import { GATE_FILENAME, writeGateFile, type CamGate } from '../../src/supervisor/gate.ts';

// ---------------------------------------------------------------------------
// parseDecideArgs
// ---------------------------------------------------------------------------

describe('parseDecideArgs', () => {
	test('single positional arg -> decision parsed', () => {
		expect(parseDecideArgs(['resume'])).toEqual({ decision: 'resume', help: false });
	});

	test('--help -> help mode', () => {
		expect(parseDecideArgs(['--help'])).toEqual({ decision: null, help: true });
	});

	test('-h -> help mode', () => {
		expect(parseDecideArgs(['-h'])).toEqual({ decision: null, help: true });
	});

	test('no args -> null (missing decision)', () => {
		expect(parseDecideArgs([])).toBeNull();
	});

	test('excess args -> null', () => {
		expect(parseDecideArgs(['resume', 'discard'])).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// runDecide — real tmpdir fs (gate.ts has no injectable seam; mirrors
// test/supervisor/gate.test.ts's real-tmpdir approach)
// ---------------------------------------------------------------------------

describe('runDecide', () => {
	let tempDir: string;
	let claudeDir: string;
	let gateFilePath: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), 'cam-decide-'));
		claudeDir = join(tempDir, '.claude');
		mkdirSync(claudeDir, { recursive: true });
		gateFilePath = join(claudeDir, GATE_FILENAME);
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	test('valid decision is written into the SAME gate file (AC1)', () => {
		const gate: CamGate = {
			gate: 'in-progress-work-conflict',
			options: ['resume', 'discard'],
			context: 'Uncommitted changes found.',
		};
		writeGateFile(gateFilePath, gate);

		const exitCode = runDecide({ cwd: tempDir, decision: 'resume' });

		expect(exitCode).toBe(0);
		const written = JSON.parse(readFileSync(gateFilePath, 'utf8'));
		expect(written).toEqual({ ...gate, decision: 'resume' });
	});

	test('invalid decision exits non-zero and leaves the gate file unmodified (AC2)', () => {
		const gate: CamGate = {
			gate: 'in-progress-work-conflict',
			options: ['resume', 'discard'],
			context: 'Uncommitted changes found.',
		};
		writeGateFile(gateFilePath, gate);

		const exitCode = runDecide({ cwd: tempDir, decision: 'bogus' });

		expect(exitCode).toBe(1);
		const stillThere = JSON.parse(readFileSync(gateFilePath, 'utf8'));
		expect(stillThere).toEqual(gate);
	});

	test('no gate file active exits non-zero with a clear error (AC3)', () => {
		const exitCode = runDecide({ cwd: tempDir, decision: 'resume' });
		expect(exitCode).toBe(1);
	});

	test('malformed gate file (fail-closed) also exits non-zero, never treated as valid', () => {
		writeFileSync(gateFilePath, '{ not valid json', 'utf8');
		const exitCode = runDecide({ cwd: tempDir, decision: 'resume' });
		expect(exitCode).toBe(1);
	});
});
