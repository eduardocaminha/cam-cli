import { describe, expect, test } from 'bun:test';
import {
	closeSync,
	fstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import {
	EVENT_LOG_FALLBACK_TAIL_BYTES,
	EVENT_LOG_OUT_OF_ORDER_MARGIN_BYTES,
	EVENT_LOG_READ_CHUNK_BYTES,
	parseRecentProgress,
	readRecentProgress,
	type EventLogReader,
} from '../../src/commands/dashboard.ts';
import { startWebServer } from '../../src/commands/web.ts';
import { writeSidecarSessionStart } from '../../src/supervisor/session-start.ts';
import { createTestTmpdir } from '../helpers/test-tmpdir.ts';

interface InstrumentedReader {
	reader: EventLogReader;
	bytesRead: () => number;
	openedPaths: () => string[];
}

function instrumentEventLogReader(targetPath: string): InstrumentedReader {
	const pathsByFd = new Map<number, string>();
	const opened: string[] = [];
	let targetBytesRead = 0;
	return {
		reader: {
			openSync(path, flags) {
				const fd = openSync(path, flags);
				pathsByFd.set(fd, path);
				opened.push(path);
				return fd;
			},
			fstatSync,
			readSync(fd, buffer, offset, length, position) {
				const bytesRead = readSync(fd, buffer, offset, length, position);
				if (pathsByFd.get(fd) === targetPath) targetBytesRead += bytesRead;
				return bytesRead;
			},
			closeSync(fd) {
				pathsByFd.delete(fd);
				closeSync(fd);
			},
		},
		bytesRead: () => targetBytesRead,
		openedPaths: () => [...opened],
	};
}

function event(
	ts: string,
	kind: string,
	detail: Record<string, unknown>,
	storyId?: string,
): string {
	return JSON.stringify({ ts, ...(storyId === undefined ? {} : { storyId }), kind, detail });
}

function oldPrefix(minBytes: number): string {
	const line = `${event(
		'2026-08-13T09:00:00.000Z',
		'worker-end',
		{ outcome: 'old-prefix-padding', padding: 'x'.repeat(256) },
		'US-OLD',
	)}\n`;
	return line.repeat(Math.ceil(minBytes / Buffer.byteLength(line)));
}

describe('bounded worker-event reads', () => {
	test('without a session marker, the fixed tail preserves the five full-read Recent Progress bullets', () => {
		const cwd = createTestTmpdir('cam-web-read-bounded-no-marker-');
		try {
			const projectClaudeDir = join(cwd, '.claude');
			mkdirSync(projectClaudeDir, { recursive: true });
			const eventLogPath = join(projectClaudeDir, 'cam-worker-events.jsonl');
			const results = Array.from({ length: 6 }, (_, index) =>
				event(
					`2026-08-13T12:0${index}:00.000Z`,
					'result',
					{ outcome: `result-${index}` },
					`US-00${index + 1}`,
				),
			);
			writeFileSync(
				eventLogPath,
				`${oldPrefix(EVENT_LOG_FALLBACK_TAIL_BYTES * 3)}${results.join('\n')}\n`,
			);

			const expected = parseRecentProgress(readFileSync(eventLogPath, 'utf8'));
			const meter = instrumentEventLogReader(eventLogPath);
			const actual = readRecentProgress(cwd, undefined, meter.reader);

			expect(actual).toEqual(expected);
			expect(actual).toHaveLength(5);
			expect(meter.bytesRead()).toBe(EVENT_LOG_FALLBACK_TAIL_BYTES);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test('the real snapshot route reads only the session window plus the physical-order margin', async () => {
		const base = createTestTmpdir('cam-web-read-bounded-route-');
		const cwd = join(base, 'project');
		const projectClaudeDir = join(cwd, '.claude');
		const claudeDir = join(base, 'claude-home');
		mkdirSync(projectClaudeDir, { recursive: true });

		const eventLogPath = join(projectClaudeDir, 'cam-worker-events.jsonl');
		const prefix = oldPrefix(2 * 1024 * 1024);
		const currentBeforeOutOfOrder = event(
			'2026-08-13T12:00:01.000Z',
			'tokens',
			{ inputTokens: 100, outputTokens: 20, cacheReadTokens: 3, cacheCreationTokens: 2 },
			'US-004',
		);
		const physicallyLateOldLine = event(
			'2026-08-13T11:59:30.000Z',
			'worker-end',
			{ outcome: 'physically-out-of-order' },
			'US-OLD',
		);
		// This is the jq writer's exact shape: no storyId and whole-second ts.
		const jqFallback = event(
			'2026-08-13T12:00:00.000Z',
			'orch-resolve-fallback',
			{ phase: 'orchestrator', model: 'opus', effort: 'high' },
		);
		const currentResult = event(
			'2026-08-13T12:00:03.000Z',
			'result',
			{ outcome: 'pass' },
			'US-004',
		);
		const sessionSuffix = [
			currentBeforeOutOfOrder,
			physicallyLateOldLine,
			jqFallback,
			currentResult,
		].join('\n') + '\n';
		writeFileSync(eventLogPath, prefix + sessionSuffix);
		writeSidecarSessionStart(projectClaudeDir, '2026-08-13T12:00:00.750Z');
		writeFileSync(
			join(cwd, 'prd.json'),
			JSON.stringify({
				branchName: 'cam/read-bounded',
				userStories: [{ id: 'US-004', title: 'bounded read', priority: 4, passes: false }],
			}),
		);

		const workerUuid = '11111111-2222-4333-8444-555555555555';
		writeFileSync(join(projectClaudeDir, '.cam-worker-US-004.session'), workerUuid);
		const transcriptDir = join(claudeDir, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
		mkdirSync(transcriptDir, { recursive: true });
		writeFileSync(
			join(transcriptDir, `${workerUuid}.jsonl`),
			`${JSON.stringify({ message: { usage: { input_tokens: 999_999 } } })}\n`,
		);

		const meter = instrumentEventLogReader(eventLogPath);
		const handle = startWebServer({ port: 0, cwd, claudeDir, eventLogReader: meter.reader });
		try {
			const response = await fetch(`http://${handle.hostname}:${handle.port}/api/snapshot`);
			expect(response.status).toBe(200);
			const payload = (await response.json()) as Record<string, unknown>;

			expect(payload['recent']).toEqual(['08-13 12:00 US-004 pass']);
			expect(payload['sessionWorkerTokens']).toBe(125);
			expect(meter.openedPaths()).toEqual([eventLogPath]);
			expect(meter.bytesRead()).toBeLessThanOrEqual(
				Buffer.byteLength(sessionSuffix) +
					EVENT_LOG_OUT_OF_ORDER_MARGIN_BYTES +
					EVENT_LOG_READ_CHUNK_BYTES,
			);
			expect(meter.bytesRead()).toBeLessThan(Buffer.byteLength(prefix + sessionSuffix));
		} finally {
			await handle.stop();
			rmSync(base, { recursive: true, force: true });
		}
	});
});
