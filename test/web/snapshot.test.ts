// test/web/snapshot.test.ts
//
// Real-server parity coverage for GET /api/snapshot. The route delegates to
// the dashboard's readSnapshot producer and only removes transcript-dependent
// token fields before serializing the result.

import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { readSnapshot } from '../../src/commands/dashboard.ts';
import { startWebServer } from '../../src/commands/web.ts';
import { createTestTmpdir } from '../helpers/test-tmpdir.ts';

const TRANSCRIPT_TOKEN_KEYS = [
	'tokensInput',
	'tokensOutput',
	'tokensCacheRead',
	'tokensCacheCreation',
	'storyTokens',
] as const;

function hasOwn(record: Record<string, unknown>, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(record, key);
}

function withoutRequestTimeAndTranscriptTokens(
	snapshot: Record<string, unknown>,
): Record<string, unknown> {
	const comparable = { ...snapshot };
	delete comparable['nowMs'];
	for (const key of TRANSCRIPT_TOKEN_KEYS) delete comparable[key];
	return comparable;
}

function projectTranscriptDir(claudeDir: string, cwd: string): string {
	return join(claudeDir, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
}

describe('GET /api/snapshot', () => {
	test('matches readSnapshot for an active cycle while omitting transcript-dependent tokens', async () => {
		const base = createTestTmpdir('cam-web-snapshot-active-');
		const cwd = join(base, 'project');
		const claudeDir = join(base, 'claude-home');
		const projectClaudeDir = join(cwd, '.claude');
		mkdirSync(projectClaudeDir, { recursive: true });

		writeFileSync(
			join(cwd, 'prd.json'),
			JSON.stringify({
				branchName: 'cam/snapshot-fixture',
				userStories: [
					{ id: 'US-001', title: 'done', priority: 1, passes: true },
					{ id: 'US-002', title: 'active snapshot', priority: 2, passes: false },
				],
			}),
		);
		writeFileSync(
			join(projectClaudeDir, 'cam-loop.local.md'),
			[
				'---',
				'active: true',
				'iteration: 7',
				'max_iterations: 30',
				'started_at: "2026-08-13T12:00:00Z"',
				'last_activity: "2026-08-13T12:05:00Z"',
				'---',
				'',
			].join('\n'),
		);
		writeFileSync(
			join(projectClaudeDir, 'cam-worker-events.jsonl'),
			`${JSON.stringify({
				ts: '2026-08-13T12:04:00Z',
				storyId: 'US-002',
				kind: 'result',
				detail: { outcome: 'incomplete' },
			})}\n`,
		);

		const orchestratorUuid = '11111111-2222-4333-8444-555555555555';
		const workerUuid = '66666666-7777-4888-8999-aaaaaaaaaaaa';
		writeFileSync(join(projectClaudeDir, '.cam-orch-session'), orchestratorUuid);
		writeFileSync(join(projectClaudeDir, '.cam-worker-US-002.session'), workerUuid);
		const transcriptDir = projectTranscriptDir(claudeDir, cwd);
		mkdirSync(transcriptDir, { recursive: true });
		writeFileSync(
			join(transcriptDir, `${orchestratorUuid}.jsonl`),
			`${JSON.stringify({
				message: {
					usage: {
						input_tokens: 100,
						output_tokens: 20,
						cache_read_input_tokens: 30,
						cache_creation_input_tokens: 40,
					},
				},
			})}\n`,
		);
		writeFileSync(
			join(transcriptDir, `${workerUuid}.jsonl`),
			`${JSON.stringify({
				message: {
					usage: {
						input_tokens: 500,
						output_tokens: 60,
						cache_read_input_tokens: 70,
						cache_creation_input_tokens: 80,
					},
				},
			})}\n`,
		);

		const handle = startWebServer({ port: 0, cwd, claudeDir });
		try {
			const response = await fetch(`http://${handle.hostname}:${handle.port}/api/snapshot`);
			expect(response.status).toBe(200);
			const payload = (await response.json()) as Record<string, unknown>;

			expect(typeof payload['nowMs']).toBe('number');
			expect(typeof payload['nowMs'] === 'number' && Number.isFinite(payload['nowMs'])).toBe(true);

			const expectedSnapshot = readSnapshot({ cwd, nowMs: Date.now(), claudeDir });
			const expectedRecord: Record<string, unknown> = { ...expectedSnapshot };
			for (const key of TRANSCRIPT_TOKEN_KEYS) {
				expect(hasOwn(expectedRecord, key)).toBe(true);
				expect(hasOwn(payload, key)).toBe(false);
			}
			expect(withoutRequestTimeAndTranscriptTokens(payload)).toEqual(
				withoutRequestTimeAndTranscriptTokens(expectedRecord),
			);
		} finally {
			await handle.stop();
		}
	});

	test('returns 200 with readSnapshot defaults when every source file is absent', async () => {
		const base = createTestTmpdir('cam-web-snapshot-missing-');
		const cwd = join(base, 'missing-project');
		const claudeDir = join(base, 'missing-claude-home');
		mkdirSync(cwd, { recursive: true });

		const handle = startWebServer({ port: 0, cwd, claudeDir });
		try {
			const response = await fetch(`http://${handle.hostname}:${handle.port}/api/snapshot`);
			expect(response.status).toBe(200);
			const payload = (await response.json()) as Record<string, unknown>;
			const expected: Record<string, unknown> = {
				...readSnapshot({ cwd, nowMs: Date.now(), claudeDir }),
			};
			const comparablePayload = { ...payload };
			delete comparablePayload['idleState'];

			expect(payload['idle']).toBe(true);
			expect(payload['iteration']).toBe(0);
			expect(payload['maxIterations']).toBe(0);
			expect(payload['recent']).toEqual([]);
			for (const key of TRANSCRIPT_TOKEN_KEYS) expect(hasOwn(payload, key)).toBe(false);
			expect(withoutRequestTimeAndTranscriptTokens(comparablePayload)).toEqual(
				withoutRequestTimeAndTranscriptTokens(expected),
			);
		} finally {
			await handle.stop();
		}
	});
});
