// test/supervisor/gate.test.ts
//
// Tests for the durable operator-decision gate marker (US-001, CAM-241/153).

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach, describe, test, expect } from 'bun:test';

import {
	GATE_FILENAME,
	GateFileError,
	readGateFile,
	readGateFileLenient,
	writeGateFile,
	removeGateFile,
	type CamGate,
} from '../../src/supervisor/gate.ts';

describe('gate file: round-trip (US-001, CAM-153)', () => {
	let tempDir: string;
	let filePath: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), 'cam-gate-'));
		filePath = join(tempDir, GATE_FILENAME);
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	test('GATE_FILENAME is the expected literal', () => {
		expect(GATE_FILENAME).toBe('.cam-gate.json');
	});

	test('write then read round-trips a gate without a decision yet', () => {
		const gate: CamGate = {
			gate: 'in-progress-work-conflict',
			options: ['resume', 'discard'],
			context: 'Uncommitted changes found on branch cam/issue-153.',
		};

		writeGateFile(filePath, gate);

		expect(readGateFile(filePath)).toEqual(gate);
		expect(readGateFileLenient(filePath)).toEqual(gate);
	});

	test('write then read round-trips a resolved gate (decision populated)', () => {
		const gate: CamGate = {
			gate: 'in-progress-work-conflict',
			options: ['resume', 'discard'],
			context: 'Uncommitted changes found on branch cam/issue-153.',
			decision: 'resume',
		};

		writeGateFile(filePath, gate);

		expect(readGateFile(filePath)).toEqual(gate);
	});

	test('write then remove then read: fail-closed reader throws, lenient reader returns null', () => {
		const gate: CamGate = {
			gate: 'in-progress-work-conflict',
			options: ['resume', 'discard'],
			context: 'Uncommitted changes found.',
		};

		writeGateFile(filePath, gate);
		removeGateFile(filePath);

		expect(() => readGateFile(filePath)).toThrow(GateFileError);
		expect(readGateFileLenient(filePath)).toBeNull();
	});

	test('remove is a silent no-op when the file was never written', () => {
		expect(() => removeGateFile(filePath)).not.toThrow();
	});

	test('write never throws even against an unwritable directory', () => {
		const badPath = join(tempDir, 'does-not-exist', GATE_FILENAME);
		expect(() =>
			writeGateFile(badPath, { gate: 'x', options: [], context: 'ctx' }),
		).not.toThrow();
	});
});

describe('gate file: fail-closed reader rejects absent/malformed/partial (US-001, CAM-153)', () => {
	let tempDir: string;
	let filePath: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), 'cam-gate-'));
		filePath = join(tempDir, GATE_FILENAME);
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	test('readGateFile throws GateFileError when the file is absent', () => {
		expect(() => readGateFile(filePath)).toThrow(GateFileError);
	});

	test('readGateFileLenient returns null when the file is absent', () => {
		expect(readGateFileLenient(filePath)).toBeNull();
	});

	test('readGateFile throws on malformed JSON (never returns a partially-parsed object)', () => {
		writeFileSync(filePath, '{ this is not valid json', 'utf8');
		expect(() => readGateFile(filePath)).toThrow(GateFileError);
		expect(readGateFileLenient(filePath)).toBeNull();
	});

	test('readGateFile throws when the JSON value is an array, not an object', () => {
		writeFileSync(filePath, '[]', 'utf8');
		expect(() => readGateFile(filePath)).toThrow(GateFileError);
	});

	test('readGateFile throws on a partially-written gate (missing required fields)', () => {
		writeFileSync(filePath, JSON.stringify({ gate: 'x' }), 'utf8');
		expect(() => readGateFile(filePath)).toThrow(GateFileError);
		expect(readGateFileLenient(filePath)).toBeNull();
	});

	test('readGateFile throws when options is present but not an array of strings', () => {
		writeFileSync(
			filePath,
			JSON.stringify({ gate: 'x', options: [1, 2], context: 'ctx' }),
			'utf8',
		);
		expect(() => readGateFile(filePath)).toThrow(GateFileError);
	});

	test('readGateFile throws when decision is present but not a string', () => {
		writeFileSync(
			filePath,
			JSON.stringify({ gate: 'x', options: ['a'], context: 'ctx', decision: 42 }),
			'utf8',
		);
		expect(() => readGateFile(filePath)).toThrow(GateFileError);
	});
});
