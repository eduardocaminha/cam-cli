// test/orchestrator/handoff.test.ts
//
// Unit tests for src/orchestrator/handoff.ts (CAM-23 US-002). Uses real tmpdirs
// as the project .claude dir so the atomic write + read path is exercised.

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	writeOrchHandoff,
	readOrchHandoff,
	ORCH_HANDOFF_SCHEMA_VERSION,
	ORCH_HANDOFF_FILENAME,
	type OrchHandoffPayload,
} from '../../src/orchestrator/handoff.ts';

function freshClaudeDir(): string {
	return mkdtempSync(join(tmpdir(), 'cam-orch-handoff-'));
}

describe('orch handoff write/read', () => {
	test('round-trip write then read', () => {
		const dir = freshClaudeDir();
		const payload: OrchHandoffPayload = {
			schemaVersion: ORCH_HANDOFF_SCHEMA_VERSION,
			writtenAt: '2026-06-09T20:00:00Z',
			reason: 'token-budget-exceeded',
			projectContext: 'cam-cli marathon',
			keyDecisions: ['ship CAM-23'],
			nextActions: ['continue from US-002'],
		};
		writeOrchHandoff(dir, payload);
		const read = readOrchHandoff(dir);
		expect(read).not.toBeNull();
		expect(read?.reason).toBe('token-budget-exceeded');
		expect(read?.projectContext).toBe('cam-cli marathon');
		expect(read?.keyDecisions).toEqual(['ship CAM-23']);
	});

	test('missing file returns null (no handoff pending)', () => {
		expect(readOrchHandoff(freshClaudeDir())).toBeNull();
	});

	test('malformed JSON throws', () => {
		const dir = freshClaudeDir();
		writeFileSync(join(dir, ORCH_HANDOFF_FILENAME), '{ not json', 'utf8');
		expect(() => readOrchHandoff(dir)).toThrow(/not valid JSON/);
	});

	test('unknown schemaVersion throws', () => {
		const dir = freshClaudeDir();
		writeFileSync(
			join(dir, ORCH_HANDOFF_FILENAME),
			JSON.stringify({ schemaVersion: 999, writtenAt: 'x', reason: 'y' }),
			'utf8',
		);
		expect(() => readOrchHandoff(dir)).toThrow(/unsupported schemaVersion/);
	});

	test('missing required field throws', () => {
		const dir = freshClaudeDir();
		writeFileSync(
			join(dir, ORCH_HANDOFF_FILENAME),
			JSON.stringify({ schemaVersion: ORCH_HANDOFF_SCHEMA_VERSION, writtenAt: 'x' }), // no reason
			'utf8',
		);
		expect(() => readOrchHandoff(dir)).toThrow(/missing a required field/);
	});

	test('unknown top-level keys are preserved on read (forward compat)', () => {
		const dir = freshClaudeDir();
		writeFileSync(
			join(dir, ORCH_HANDOFF_FILENAME),
			JSON.stringify({
				schemaVersion: ORCH_HANDOFF_SCHEMA_VERSION,
				writtenAt: '2026-06-09T20:00:00Z',
				reason: 'token-budget-exceeded',
				futureField: { nested: 42 },
			}),
			'utf8',
		);
		const read = readOrchHandoff(dir);
		expect(read?.['futureField']).toEqual({ nested: 42 });
	});
});
