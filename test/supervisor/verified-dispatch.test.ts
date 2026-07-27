// test/supervisor/verified-dispatch.test.ts
//
// US-003 (CAM-433): behavioral DI fake for tmux dispatch verification.
// The fake models pane identity and command failures; assertions target the
// helper's observable terminal state rather than mock-called-only behavior.

import { describe, expect, test } from 'bun:test';

import type { DispatchFailedMarker } from '../../src/supervisor/dispatch-failed-marker.ts';
import { makeInMemoryEventLogger } from '../../src/supervisor/events.ts';
import type { SpawnFn } from '../../src/supervisor/loop.ts';
import {
	runVerifiedDispatch,
	type DispatchFailureReason,
	type VerifiedDispatchOptions,
} from '../../src/supervisor/verified-dispatch.ts';

const NOW = '2026-07-27T15:00:00.000Z';

interface FakeTmuxOptions {
	failCommand?: 'set-option' | 'respawn-pane' | 'pipe-pane';
	changePid?: boolean;
	stderr?: string;
	exitCode?: number;
}

interface FakeTmux {
	spawnFn: SpawnFn;
	formats: string[];
	labelArgs: string[];
	readonly piped: boolean;
}

function makeBehavioralTmux(opts: FakeTmuxOptions = {}): FakeTmux {
	let panePid = '4100';
	const formats: string[] = [];
	const labelArgs: string[] = [];
	let piped = false;
	const spawnFn: SpawnFn = (_cmd, args) => {
		const subcommand = args[2];
		if (subcommand === 'display-message') {
			formats.push(args.at(-1) ?? '');
			return { stdout: `${panePid}\n`, stderr: '', exitCode: 0 };
		}
		if (subcommand === 'set-option') {
			labelArgs.push(args.at(-1) ?? '');
		}
		if (subcommand === opts.failCommand) {
			return {
				stdout: '',
				stderr: opts.stderr ?? `${subcommand} known stderr`,
				exitCode: opts.exitCode ?? 17,
			};
		}
		if (subcommand === 'respawn-pane' && opts.changePid !== false) {
			panePid = '4200';
		}
		if (subcommand === 'pipe-pane') piped = true;
		return { stdout: '', stderr: '', exitCode: 0 };
	};
	return {
		spawnFn,
		formats,
		labelArgs,
		get piped() {
			return piped;
		},
	};
}

function makeHarness(fake: FakeTmux): {
	options: VerifiedDispatchOptions;
	events: ReturnType<typeof makeInMemoryEventLogger>['events'];
	markers: DispatchFailedMarker[];
	notifications: string[];
} {
	const { logger, events } = makeInMemoryEventLogger();
	const markers: DispatchFailedMarker[] = [];
	const notifications: string[] = [];
	return {
		options: {
			spawnFn: fake.spawnFn,
			phase: 'planner',
			paneId: '%7',
			uuid: 'dispatch-uuid',
			dispatchCmd: 'claude --agent subagent-planner',
			pipeCommand: 'cat >> /tmp/cam-plan.log',
			logEvent: logger,
			writeDispatchFailedMarkerFn: (marker) => markers.push(marker),
			notifyFn: (message) => notifications.push(message),
			storyId: 'US-003',
			clock: () => NOW,
		},
		events,
		markers,
		notifications,
	};
}

function expectObservableTerminal(
	reason: DispatchFailureReason,
	harness: ReturnType<typeof makeHarness>,
	stderr: string,
	exitCode: number,
): void {
	expect(harness.events).toHaveLength(1);
	expect(harness.events[0]).toMatchObject({
		ts: NOW,
		storyId: 'US-003',
		uuid: 'dispatch-uuid',
		kind: 'dispatch-failed',
		detail: {
			phase: 'planner',
			paneId: '%7',
			exitCode,
			stderr,
			reason,
		},
	});
	expect(harness.markers).toEqual([{
		phase: 'planner',
		paneId: '%7',
		uuid: 'dispatch-uuid',
		exitCode,
		stderr,
		reason,
		timestamp: NOW,
	}]);
	expect(harness.notifications).toHaveLength(1);
	expect(harness.notifications[0]).toContain(reason);
	expect(harness.notifications[0]).toContain(`exit ${exitCode}`);
	if (stderr !== '') expect(harness.notifications[0]).toContain(stderr);
}

describe('runVerifiedDispatch', () => {
	for (const failureCase of [
		{ command: 'set-option', reason: 'set-option-exited' },
		{ command: 'respawn-pane', reason: 'respawn-pane-exited' },
		{ command: 'pipe-pane', reason: 'pipe-pane-exited' },
	] as const) {
		test(`${failureCase.command} non-zero exit emits event, marker, and notify`, () => {
			const stderr = `${failureCase.command} captured stderr`;
			const fake = makeBehavioralTmux({
				failCommand: failureCase.command,
				stderr,
				exitCode: 19,
			});
			const harness = makeHarness(fake);

			const result = runVerifiedDispatch(harness.options);

			expect(result.ok).toBe(false);
			expectObservableTerminal(failureCase.reason, harness, stderr, 19);
		});
	}

	test('zero-exit respawn with unchanged pane_pid is the same observable terminal', () => {
		const fake = makeBehavioralTmux({ changePid: false });
		const harness = makeHarness(fake);

		const result = runVerifiedDispatch(harness.options);

		expect(result.ok).toBe(false);
		expectObservableTerminal('pane-pid-unchanged', harness, '', 0);
		expect(fake.formats).toEqual(['#{pane_pid}', '#{pane_pid}']);
		expect(fake.piped).toBe(false);
	});

	test('changed pane identity and zero exits complete set-option, respawn, and pipe', () => {
		const fake = makeBehavioralTmux();
		const harness = makeHarness(fake);

		const result = runVerifiedDispatch(harness.options);

		expect(result).toEqual({ ok: true, beforePanePid: '4100', afterPanePid: '4200' });
		expect(fake.formats).toEqual(['#{pane_pid}', '#{pane_pid}']);
		expect(fake.piped).toBe(true);
		expect(harness.events).toEqual([]);
		expect(harness.markers).toEqual([]);
		expect(harness.notifications).toEqual([]);
	});

	// US-R1-005 (CAM-433 review round 1): the `@cam_label` set on the pane must
	// be able to diverge from `phase` so a sentinel dispatch (whose `phase` is
	// a failure-reason string like 'implementer-timeout', not a worker label)
	// can still leave a session-recognized label behind.
	test('omitted label falls back to phase for @cam_label', () => {
		const fake = makeBehavioralTmux();
		const harness = makeHarness(fake);

		runVerifiedDispatch(harness.options);

		expect(fake.labelArgs).toEqual(['planner']);
	});

	test('explicit label overrides phase for @cam_label without changing event/marker phase', () => {
		const fake = makeBehavioralTmux({ failCommand: 'respawn-pane', exitCode: 23 });
		const harness = makeHarness(fake);
		harness.options.phase = 'implementer-timeout';
		harness.options.label = 'implementer';

		const result = runVerifiedDispatch(harness.options);

		expect(result.ok).toBe(false);
		expect(fake.labelArgs).toEqual(['implementer']);
		expect(harness.markers).toEqual([{
			phase: 'implementer-timeout',
			paneId: '%7',
			uuid: 'dispatch-uuid',
			exitCode: 23,
			stderr: 'respawn-pane known stderr',
			reason: 'respawn-pane-exited',
			timestamp: NOW,
		}]);
	});
});
