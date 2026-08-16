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
	EVENT_LOG_READ_CHUNK_BYTES,
	parseRecentProgress,
	readRecentProgress,
	type EventLogReader,
} from '../../src/commands/dashboard.ts';
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

	test('the physical-order margin reaches an in-session result before later pre-session padding', () => {
		const cwd = createTestTmpdir('cam-web-read-bounded-order-margin-');
		try {
			const projectClaudeDir = join(cwd, '.claude');
			mkdirSync(projectClaudeDir, { recursive: true });
			const eventLogPath = join(projectClaudeDir, 'cam-worker-events.jsonl');
			const earlyInSession = event(
				'2026-08-13T12:00:01.000Z',
				'result',
				{ outcome: 'early-before-padding' },
				'US-EARLY',
			);
			const latestInSession = event(
				'2026-08-13T12:00:02.000Z',
				'result',
				{ outcome: 'latest-physical' },
				'US-LATE',
			);
			const physicallyLatePreSession = oldPrefix(EVENT_LOG_READ_CHUNK_BYTES + 16 * 1024);
			writeFileSync(
				eventLogPath,
				`${oldPrefix(EVENT_LOG_FALLBACK_TAIL_BYTES * 2)}${earlyInSession}\n${physicallyLatePreSession}${latestInSession}\n`,
			);
			writeSidecarSessionStart(projectClaudeDir, '2026-08-13T12:00:00.750Z');

			const meter = instrumentEventLogReader(eventLogPath);
			expect(readRecentProgress(cwd, undefined, meter.reader)).toEqual([
				'08-13 12:00 US-LATE latest-physical',
				'08-13 12:00 US-EARLY early-before-padding',
			]);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test('the jq whole-second tolerance anchors an earlier in-session result', () => {
		const cwd = createTestTmpdir('cam-web-read-bounded-jq-tolerance-');
		try {
			const projectClaudeDir = join(cwd, '.claude');
			mkdirSync(projectClaudeDir, { recursive: true });
			const eventLogPath = join(projectClaudeDir, 'cam-worker-events.jsonl');
			const reachableOnlyFromJqAnchor = event(
				'2026-08-13T12:00:01.000Z',
				'result',
				{ outcome: 'reachable-from-jq-anchor' },
				'US-JQ',
			);
			// This is the jq writer's exact shape: no storyId and whole-second ts.
			const jqFallback = event(
				'2026-08-13T12:00:00.000Z',
				'orch-resolve-fallback',
				{ phase: 'orchestrator', model: 'opus', effort: 'high' },
			);
			writeFileSync(
				eventLogPath,
				`${oldPrefix(EVENT_LOG_FALLBACK_TAIL_BYTES * 2)}${reachableOnlyFromJqAnchor}\n${oldPrefix(
					EVENT_LOG_READ_CHUNK_BYTES + 16 * 1024,
				)}${jqFallback}\n${oldPrefix(EVENT_LOG_READ_CHUNK_BYTES - 8 * 1024)}`,
			);
			writeSidecarSessionStart(projectClaudeDir, '2026-08-13T12:00:00.750Z');

			const meter = instrumentEventLogReader(eventLogPath);
			expect(readRecentProgress(cwd, undefined, meter.reader)).toEqual([
				'08-13 12:00 US-JQ reachable-from-jq-anchor',
			]);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
