// test/supervisor/gate.test.ts
//
// Tests for the durable operator-decision gate marker (US-001, CAM-241/153)
// and its write+notify / poll+resolve+clear+flip lifecycle (US-003).

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
	writeGateAndNotify,
	pollAndResolveGate,
	formatGateNotifyLine,
	type CamGate,
	type GateResolutionRegistry,
} from '../../src/supervisor/gate.ts';
import { waitForCondition } from '../helpers/wait-for-condition.ts';
import type { LoopPhase } from '../../src/commands/status.ts';

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

describe('writeGateAndNotify (US-003, AC1, AC4)', () => {
	let tempDir: string;
	let filePath: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), 'cam-gate-'));
		filePath = join(tempDir, GATE_FILENAME);
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	test('writes gate/options/context with no decision, flips phase, and notifies once', () => {
		const phases: LoopPhase[] = [];
		const notifyLines: string[] = [];

		writeGateAndNotify(
			filePath,
			{ gate: 'in-progress-work-conflict', options: ['resume', 'discard'], context: 'Uncommitted changes.' },
			(phase) => phases.push(phase),
			(line) => notifyLines.push(line),
		);

		const written = readGateFile(filePath);
		expect(written).toEqual({
			gate: 'in-progress-work-conflict',
			options: ['resume', 'discard'],
			context: 'Uncommitted changes.',
		});
		expect(written.decision).toBeUndefined();
		expect(phases).toEqual(['awaiting-operator']);
		expect(notifyLines).toHaveLength(1);
	});

	test('the notify line names the gate, its options, and the context (never auto-selects an option)', () => {
		const notifyLines: string[] = [];

		writeGateAndNotify(
			filePath,
			{ gate: 'ship-pause', options: ['proceed', 'abort'], context: 'CI is red.' },
			() => {},
			(line) => notifyLines.push(line),
		);

		const line = notifyLines[0] ?? '';
		expect(line).toContain('ship-pause');
		expect(line).toContain('proceed');
		expect(line).toContain('abort');
		expect(line).toContain('CI is red.');
		// Never auto-selects: the persisted gate carries no decision.
		expect(readGateFile(filePath).decision).toBeUndefined();
	});

	test('formatGateNotifyLine is a pure formatter matching writeGateAndNotify\'s pushed line', () => {
		const gate = { gate: 'x', options: ['a', 'b'], context: 'ctx' };
		const notifyLines: string[] = [];
		writeGateAndNotify(filePath, gate, () => {}, (line) => notifyLines.push(line));
		expect(notifyLines[0]).toBe(formatGateNotifyLine(gate));
	});

	test('AC4: a stale gate file left by a crashed prior run is cleared at gate-write time', () => {
		// Simulate a crashed prior run: a DIFFERENT gate (already resolved) left behind.
		writeGateFile(filePath, {
			gate: 'stale-crashed-gate',
			options: ['a'],
			context: 'stale',
			decision: 'a',
		});
		expect(existsSync(filePath)).toBe(true);

		writeGateAndNotify(
			filePath,
			{ gate: 'fresh-gate', options: ['x', 'y'], context: 'fresh context' },
			() => {},
			() => {},
		);

		const written = readGateFile(filePath);
		expect(written.gate).toBe('fresh-gate');
		expect(written.decision).toBeUndefined();
	});
});

describe('pollAndResolveGate (US-003, AC2, AC3, AC4)', () => {
	let tempDir: string;
	let filePath: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), 'cam-gate-'));
		filePath = join(tempDir, GATE_FILENAME);
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	test('no gate file present: no-op, returns no-gate', () => {
		const phases: LoopPhase[] = [];
		const result = pollAndResolveGate(filePath, {}, (p) => phases.push(p));
		expect(result).toBe('no-gate');
		expect(phases).toEqual([]);
	});

	test('gate present but decision not populated yet: no-op, returns awaiting-decision', () => {
		writeGateFile(filePath, { gate: 'g', options: ['a', 'b'], context: 'ctx' });
		const phases: LoopPhase[] = [];
		const result = pollAndResolveGate(filePath, {}, (p) => phases.push(p));
		expect(result).toBe('awaiting-decision');
		expect(phases).toEqual([]);
		// Untouched: still there for the next poll.
		expect(existsSync(filePath)).toBe(true);
	});

	// AC2: dispatched generically by the discriminator, not hard-coded to a single kind.
	test('AC2: dispatches the resolution generically by discriminator, deletes the gate, flips phase', () => {
		writeGateFile(filePath, {
			gate: 'my-custom-gate-kind',
			options: ['resume', 'discard'],
			context: 'ctx',
			decision: 'resume',
		});

		const calledWith: CamGate[] = [];
		const registry: GateResolutionRegistry = {
			'my-custom-gate-kind': (gate) => {
				calledWith.push(gate);
				return gate.decision === 'resume' ? 'implementing' : 'idle';
			},
			// A second, unrelated kind proves dispatch keys off gate.gate, not a fixed slot.
			'another-gate-kind': () => 'idle',
		};

		const phases: LoopPhase[] = [];
		const result = pollAndResolveGate(filePath, registry, (p) => phases.push(p));

		expect(result).toBe('resolved');
		expect(calledWith).toHaveLength(1);
		expect(calledWith[0]?.gate).toBe('my-custom-gate-kind');
		expect(phases).toEqual(['implementing']);
		// Consumed-on-resolution.
		expect(existsSync(filePath)).toBe(false);
	});

	test('unknown discriminator: never executed, gate file left in place, no phase flip', () => {
		writeGateFile(filePath, {
			gate: 'not-yet-registered',
			options: ['a'],
			context: 'ctx',
			decision: 'a',
		});

		const phases: LoopPhase[] = [];
		const result = pollAndResolveGate(filePath, {}, (p) => phases.push(p));

		expect(result).toBe('unknown-gate');
		expect(phases).toEqual([]);
		expect(existsSync(filePath)).toBe(true);
	});

	// AC3: a decision failing re-validation is ignored, never executed, sidecar keeps polling.
	test('AC3: a decision that fails re-validation against options[] is ignored, never executed', () => {
		writeGateFile(filePath, {
			gate: 'g',
			options: ['resume', 'discard'],
			context: 'ctx',
			decision: 'nonexistent-option',
		});

		let handlerCalls = 0;
		const registry: GateResolutionRegistry = { g: () => { handlerCalls++; return 'idle'; } };
		const phases: LoopPhase[] = [];

		const result = pollAndResolveGate(filePath, registry, (p) => phases.push(p));

		expect(result).toBe('invalid-decision');
		expect(handlerCalls).toBe(0);
		expect(phases).toEqual([]);
		// Gate file untouched: the sidecar keeps polling on the next tick.
		expect(existsSync(filePath)).toBe(true);
		expect(readGateFile(filePath).decision).toBe('nonexistent-option');
	});

	test('AC3: the sidecar keeps polling across ticks while the decision stays invalid', () => {
		writeGateFile(filePath, { gate: 'g', options: ['a'], context: 'ctx', decision: 'bogus' });
		const registry: GateResolutionRegistry = { g: () => 'idle' };

		for (let i = 0; i < 3; i++) {
			expect(pollAndResolveGate(filePath, registry, () => {})).toBe('invalid-decision');
		}
		expect(existsSync(filePath)).toBe(true);
	});
});

describe('gate lifecycle: real tmpdir + async poll loop (US-003, AC5)', () => {
	let tempDir: string;
	let filePath: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), 'cam-gate-poll-'));
		filePath = join(tempDir, GATE_FILENAME);
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	test('a background tick loop resolves a decision written asynchronously by another writer', async () => {
		// Seed the gate the way writeGateAndNotify would (no decision yet).
		writeGateAndNotify(
			filePath,
			{ gate: 'in-progress-work-conflict', options: ['resume', 'discard'], context: 'ctx' },
			() => {},
			() => {},
		);

		const phases: LoopPhase[] = [];
		const registry: GateResolutionRegistry = {
			'in-progress-work-conflict': (gate) => (gate.decision === 'resume' ? 'implementing' : 'idle'),
		};

		// Simulate the sidecar's own tick loop: poll on a real interval against
		// the real tmpdir file, exactly as loop.ts's awaiting-operator branch does.
		const timer = setInterval(() => {
			pollAndResolveGate(filePath, registry, (p) => phases.push(p));
		}, 10);

		try {
			// Simulate `cam decide resume` writing the decision back into the SAME
			// file asynchronously, well after the poll loop has already started.
			setTimeout(() => {
				const current = readGateFile(filePath);
				writeGateFile(filePath, { ...current, decision: 'resume' });
			}, 40);

			// No fixed sleep: wait until the poll loop has consumed the gate file.
			await waitForCondition(() => !existsSync(filePath), { timeoutMs: 2000, intervalMs: 10 });
		} finally {
			clearInterval(timer);
		}

		expect(existsSync(filePath)).toBe(false);
		expect(phases).toEqual(['implementing']);
	});

	test('an invalid decision written asynchronously is ignored; the loop keeps polling until a valid one lands', async () => {
		writeGateAndNotify(
			filePath,
			{ gate: 'g', options: ['a', 'b'], context: 'ctx' },
			() => {},
			() => {},
		);

		const results: string[] = [];
		const registry: GateResolutionRegistry = { g: () => 'idle' };
		const timer = setInterval(() => {
			results.push(pollAndResolveGate(filePath, registry, () => {}));
		}, 10);

		try {
			// First: an invalid decision (not a member of options[]).
			setTimeout(() => {
				const current = readGateFile(filePath);
				writeGateFile(filePath, { ...current, decision: 'not-an-option' });
			}, 20);
			// Then: a valid one, a bit later.
			setTimeout(() => {
				writeGateFile(filePath, { gate: 'g', options: ['a', 'b'], context: 'ctx', decision: 'b' });
			}, 80);

			await waitForCondition(() => !existsSync(filePath), { timeoutMs: 2000, intervalMs: 10 });
		} finally {
			clearInterval(timer);
		}

		expect(existsSync(filePath)).toBe(false);
		expect(results).toContain('invalid-decision');
		expect(results[results.length - 1]).toBe('resolved');
	});
});
