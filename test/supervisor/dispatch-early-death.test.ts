// test/supervisor/dispatch-early-death.test.ts
//
// US-002 (CAM-479): the pure early-death detector over a session transcript.
// Driven against two REAL fixtures (dead-on-first-turn, healthy-planner), not
// synthetic minimal strings, per the story's acceptance criteria. Every test
// drives an injected clock (nowFn) or explicit timestamps, never wall time.

import { describe, expect, test } from 'bun:test';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { DEFAULT_CONTAINER_WORKER_TIMEOUT_MS, DEFAULT_PER_WORKER_TIMEOUT_MS } from '../../src/supervisor/loop.ts';
import { transcriptPathForSession } from '../../src/transcript/usage.ts';
import {
	EARLY_DEATH_FLOOR_MS,
	classifyEarlyDeath,
	extractLastAssistantEntry,
	makeEarlyDeathProbe,
} from '../../src/supervisor/early-death.ts';

const FIXTURES_DIR = join(import.meta.dir, '..', 'fixtures', 'early-death');
const DEAD_JSONL = readFileSync(join(FIXTURES_DIR, 'dead-on-first-turn.jsonl'), 'utf8');
const HEALTHY_JSONL = readFileSync(join(FIXTURES_DIR, 'healthy-planner.jsonl'), 'utf8');

function withTmpDirs(fn: (cwd: string, claudeDir: string) => void): void {
	const cwd = mkdtempSync(join(tmpdir(), 'cam-early-death-cwd-'));
	const claudeDir = mkdtempSync(join(tmpdir(), 'cam-early-death-claude-'));
	try {
		fn(cwd, claudeDir);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
		rmSync(claudeDir, { recursive: true, force: true });
	}
}

describe('classifyEarlyDeath (pure core)', () => {
	test('classifies a frozen transcript whose last assistant entry is an API error as dead-on-first-turn', () => {
		const size = Buffer.byteLength(DEAD_JSONL, 'utf8');
		const verdict = classifyEarlyDeath({
			previousSample: { size, timestamp: 0 },
			currentSample: { size, timestamp: EARLY_DEATH_FLOOR_MS + 1_000 },
			jsonl: DEAD_JSONL,
		});

		expect(verdict.verdict).toBe('dead-on-first-turn');
		if (verdict.verdict === 'dead-on-first-turn') {
			expect(verdict.cause).toContain('529 Overloaded');
		}
	});

	test('classifies a still-growing multi-entry transcript with tool_use work as still-working', () => {
		// Sanity-check the fixture itself matches the story's description before
		// trusting the classification against it (real fixture, not the dead one).
		const entryCount = HEALTHY_JSONL.split('\n').filter((l) => l.trim() !== '').length;
		const toolUseCount = (HEALTHY_JSONL.match(/"type":"tool_use"/g) ?? []).length;
		expect(entryCount).toBeGreaterThan(60);
		expect(toolUseCount).toBeGreaterThanOrEqual(16);
		expect(Buffer.byteLength(HEALTHY_JSONL, 'utf8')).toBeGreaterThan(200_000);

		const previousSize = Buffer.byteLength(HEALTHY_JSONL.slice(0, Math.floor(HEALTHY_JSONL.length / 2)), 'utf8');
		const currentSize = Buffer.byteLength(HEALTHY_JSONL, 'utf8');

		const verdict = classifyEarlyDeath({
			previousSample: { size: previousSize, timestamp: 0 },
			currentSample: { size: currentSize, timestamp: EARLY_DEATH_FLOOR_MS + 5_000 },
			jsonl: HEALTHY_JSONL,
		});

		expect(verdict).toEqual({ verdict: 'still-working' });
	});

	test('reports still-working when a frozen transcript ends in normal work, not an API error', () => {
		const size = Buffer.byteLength(HEALTHY_JSONL, 'utf8');
		const verdict = classifyEarlyDeath({
			previousSample: { size, timestamp: 0 },
			currentSample: { size, timestamp: EARLY_DEATH_FLOOR_MS + 1_000 },
			jsonl: HEALTHY_JSONL,
		});

		expect(verdict).toEqual({ verdict: 'still-working' });
	});

	test('reports still-working when frozen for less than the floor window, even with an API error', () => {
		const size = Buffer.byteLength(DEAD_JSONL, 'utf8');
		const verdict = classifyEarlyDeath({
			previousSample: { size, timestamp: 0 },
			currentSample: { size, timestamp: EARLY_DEATH_FLOOR_MS - 1_000 },
			jsonl: DEAD_JSONL,
		});

		expect(verdict).toEqual({ verdict: 'still-working' });
	});

	test('reports still-working when there is no previous sample yet', () => {
		const size = Buffer.byteLength(DEAD_JSONL, 'utf8');
		const verdict = classifyEarlyDeath({
			previousSample: null,
			currentSample: { size, timestamp: 0 },
			jsonl: DEAD_JSONL,
		});

		expect(verdict).toEqual({ verdict: 'still-working' });
	});
});

describe('extractLastAssistantEntry', () => {
	test('extracts the last assistant entry as the cause text', () => {
		const entry = extractLastAssistantEntry(DEAD_JSONL);

		expect(entry).not.toBeNull();
		expect(entry?.isApiErrorMessage).toBe(true);
		// Verbatim, not a synthesized label: the reader can see the real upstream
		// error line, exactly as it appears in the transcript's content block.
		expect(entry?.text).toBe('API Error: 529 Overloaded. This is a server-side issue, usually temporary. Please retry.');
	});

	test('extracts the last assistant entry from a healthy transcript as normal work text', () => {
		const entry = extractLastAssistantEntry(HEALTHY_JSONL);

		expect(entry).not.toBeNull();
		expect(entry?.isApiErrorMessage).toBe(false);
		expect(entry?.text).toContain('Plan drafted');
	});

	test('returns null for a transcript with no assistant entries', () => {
		const entry = extractLastAssistantEntry('{"type":"user","message":{"role":"user","content":"hi"}}\n');
		expect(entry).toBeNull();
	});
});

describe('floor window', () => {
	test('derives a floor far below both the 30-minute host cap and the 60-minute container cap', () => {
		expect(EARLY_DEATH_FLOOR_MS).toBeLessThan(DEFAULT_PER_WORKER_TIMEOUT_MS / 10);
		expect(EARLY_DEATH_FLOOR_MS).toBeLessThan(DEFAULT_CONTAINER_WORKER_TIMEOUT_MS / 10);
	});
});

describe('makeEarlyDeathProbe (stateful)', () => {
	test('resolves the transcript under an injected claudeDir that is not the homedir default', () => {
		withTmpDirs((cwd, claudeDir) => {
			// Prove the injected claudeDir is neither the homedir default nor
			// whatever CLAUDE_CONFIG_DIR happens to be set to live in THIS
			// environment (measured, not assumed absent).
			const homedirDefault = join(homedir(), '.claude');
			expect(claudeDir).not.toBe(homedirDefault);
			const liveConfigDir = process.env['CLAUDE_CONFIG_DIR'];
			if (liveConfigDir !== undefined) {
				expect(claudeDir).not.toBe(liveConfigDir);
			}

			const uuid = 'probe-uuid-0001';
			const expectedPath = transcriptPathForSession(uuid, cwd, claudeDir);
			mkdirSync(dirname(expectedPath), { recursive: true });
			writeFileSync(expectedPath, DEAD_JSONL, 'utf8');

			// Two probe calls, frozen past the floor window: the ONLY way this
			// can resolve to dead-on-first-turn is if the real file at the
			// injected (non-homedir) claudeDir path was actually read both
			// times. A resolver bug reading a permanently-stale/absent homedir
			// path would report still-working forever instead.
			let clock = 0;
			const probe = makeEarlyDeathProbe({ cwd, claudeDir, nowFn: () => clock });
			expect(probe(uuid)).toEqual({ verdict: 'still-working' });
			clock += EARLY_DEATH_FLOOR_MS + 1_000;

			const verdict = probe(uuid);
			expect(verdict.verdict).toBe('dead-on-first-turn');
			if (verdict.verdict === 'dead-on-first-turn') {
				expect(verdict.cause).toContain('529 Overloaded');
			}
		});
	});

	test('reports still-working when the transcript is absent or unreadable', () => {
		withTmpDirs((cwd, claudeDir) => {
			// No file at all was ever written under this claudeDir/cwd pair.
			let clock = 0;
			const probe = makeEarlyDeathProbe({ cwd, claudeDir, nowFn: () => clock });
			const uuid = 'missing-uuid';

			expect(probe(uuid)).toEqual({ verdict: 'still-working' });
			clock += EARLY_DEATH_FLOOR_MS + 1_000;
			// Still absent after the floor window elapses: never fabricates a death.
			expect(probe(uuid)).toEqual({ verdict: 'still-working' });
		});
	});

	test('reports still-working when the injected reader throws (unreadable transcript)', () => {
		withTmpDirs((cwd, claudeDir) => {
			let clock = 0;
			const probe = makeEarlyDeathProbe({
				cwd,
				claudeDir,
				nowFn: () => clock,
				readFileFn: () => {
					throw new Error('EACCES: permission denied');
				},
			});
			const uuid = 'unreadable-uuid';

			expect(probe(uuid)).toEqual({ verdict: 'still-working' });
			clock += EARLY_DEATH_FLOOR_MS + 1_000;
			expect(probe(uuid)).toEqual({ verdict: 'still-working' });
		});
	});

	test('tracks samples independently per session uuid', () => {
		withTmpDirs((cwd, claudeDir) => {
			const deadUuid = 'session-dead';
			const healthyUuid = 'session-healthy';
			const deadPath = transcriptPathForSession(deadUuid, cwd, claudeDir);
			const healthyPath = transcriptPathForSession(healthyUuid, cwd, claudeDir);
			mkdirSync(dirname(deadPath), { recursive: true });
			writeFileSync(deadPath, DEAD_JSONL, 'utf8');
			writeFileSync(healthyPath, HEALTHY_JSONL, 'utf8');

			let clock = 0;
			const probe = makeEarlyDeathProbe({ cwd, claudeDir, nowFn: () => clock });
			probe(deadUuid);
			probe(healthyUuid);
			clock += EARLY_DEATH_FLOOR_MS + 1_000;
			// Healthy session grows between samples; the dead one stays frozen.
			writeFileSync(healthyPath, `${HEALTHY_JSONL}\n${HEALTHY_JSONL.split('\n').at(-2)}`, 'utf8');

			expect(probe(deadUuid).verdict).toBe('dead-on-first-turn');
			expect(probe(healthyUuid)).toEqual({ verdict: 'still-working' });
		});
	});
});
