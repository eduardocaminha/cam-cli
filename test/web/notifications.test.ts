import { afterEach, describe, expect, test } from 'bun:test';

import { notificationForRunEvent, notifyRunEvent } from '../../webui/src/notifications.ts';
import type { RunEventView, RunState } from '../../webui/src/run-view.ts';

function event(
	toState: RunState,
	kind: string,
	payload: Record<string, unknown> = {},
): RunEventView {
	return {
		seq: 1,
		runId: 'run-1',
		kind,
		fromState: 'working',
		toState,
		payload,
		createdAt: '2026-08-16T00:00:00.000Z',
	};
}

/** The workspace warning the runtime emits on the state the run already holds. */
const CLEANUP_WARNING: RunEventView = {
	...event('done', 'workspace.cleanup-warning', { detail: 'workspace ficou sujo' }),
	fromState: 'done',
};

describe('run notifications', () => {
	test('alerts on operator decisions, retryable ship failures, failures and completion', () => {
		expect(notificationForRunEvent(event('waiting-user', 'run.waiting-user', {
			summary: 'Escolha o seam.',
		}))).toMatchObject({ title: 'Gateship needs you', body: 'Escolha o seam.' });
		expect(notificationForRunEvent(event('waiting-provider', 'run.provider-waiting', {
			message: 'Claude usage limit reached.',
		}))).toMatchObject({
			title: 'Provider temporarily unavailable',
			body: 'Claude usage limit reached.',
		});
		expect(notificationForRunEvent(event('ready-to-ship', 'run.ship-failed', {
			error: 'checks red',
		}))).toMatchObject({ title: 'Shipping needs another attempt', body: 'checks red' });
		expect(notificationForRunEvent(event('failed', 'run.verification-failed')))
			.toMatchObject({ title: 'Run failed' });
		expect(notificationForRunEvent(event('done', 'run.shipped')))
			.toMatchObject({ title: 'Run completed' });
	});

	test('does not alert on ordinary progress, automatic ready state, or operator cancellation', () => {
		expect(notificationForRunEvent(event('review', 'run.review-started'))).toBeNull();
		expect(notificationForRunEvent(event('ready-to-ship', 'run.review-clean'))).toBeNull();
		expect(notificationForRunEvent(event('interrupted', 'run.cancelled'))).toBeNull();
	});

	test('a decision opens the conversation and every other alert opens the runs surface', () => {
		expect(notificationForRunEvent(event('waiting-user', 'run.waiting-user'))?.url).toBe('/');
		expect(notificationForRunEvent(event('waiting-provider', 'run.provider-waiting'))?.url)
			.toBe('/runs');
		expect(notificationForRunEvent(event('ready-to-ship', 'run.ship-failed'))?.url).toBe('/runs');
		expect(notificationForRunEvent(event('interrupted', 'run.interrupted'))?.url).toBe('/runs');
		expect(notificationForRunEvent(event('failed', 'run.verification-failed'))?.url).toBe('/runs');
		expect(notificationForRunEvent(event('done', 'run.shipped'))?.url).toBe('/runs');
	});

	test('a preserved workspace alerts even though the run state does not change', () => {
		expect(CLEANUP_WARNING.fromState).toBe(CLEANUP_WARNING.toState);
		expect(notificationForRunEvent(CLEANUP_WARNING)).toMatchObject({
			title: 'Workspace preserved',
			body: 'workspace ficou sujo',
			url: '/runs',
		});
		// Its own tag, so it does not replace the outcome notification of the run.
		expect(notificationForRunEvent(CLEANUP_WARNING)?.tag)
			.not.toBe(notificationForRunEvent(event('done', 'run.shipped'))?.tag);
	});
});

/**
 * The browser seams the module reads off the global object: the notification
 * constructor, the hidden-tab guard, focus and the location the click uses.
 */
class StubNotification {
	static permission = 'granted';
	static requestPermission = (): Promise<'granted'> => Promise.resolve('granted');
	static sent: StubNotification[] = [];
	onclick: (() => void) | null = null;
	closed = false;
	constructor(
		readonly title: string,
		readonly options?: { body?: string; tag?: string },
	) {
		StubNotification.sent.push(this);
	}
	close(): void {
		this.closed = true;
	}
}

interface BrowserSeam {
	focused: number;
	navigated: string[];
}

const SEAM_KEYS = ['Notification', 'document', 'focus', 'location'] as const;
const mutableGlobal = globalThis as unknown as Record<string, unknown>;

/** A hidden tab with granted permission, parked on `pathname`. */
function installBrowser(pathname: string): BrowserSeam {
	const seam: BrowserSeam = { focused: 0, navigated: [] };
	StubNotification.sent = [];
	mutableGlobal['Notification'] = StubNotification;
	mutableGlobal['document'] = { visibilityState: 'hidden' };
	mutableGlobal['focus'] = () => {
		seam.focused += 1;
	};
	mutableGlobal['location'] = {
		pathname,
		assign: (url: string) => seam.navigated.push(url),
	};
	return seam;
}

describe('notification click', () => {
	afterEach(() => {
		for (const key of SEAM_KEYS) delete mutableGlobal[key];
		StubNotification.sent = [];
	});

	test('focuses the tab and navigates when it is parked on another surface', () => {
		const seam = installBrowser('/');
		expect(notifyRunEvent(event('failed', 'run.verification-failed'))).toBe(true);

		const notification = StubNotification.sent[0];
		notification?.onclick?.();
		expect(seam.focused).toBe(1);
		expect(seam.navigated).toEqual(['/runs']);
		expect(notification?.closed).toBe(true);
	});

	test('focuses without navigating when the tab is already on the destination', () => {
		const seam = installBrowser('/');
		expect(notifyRunEvent(event('waiting-user', 'run.waiting-user'))).toBe(true);

		StubNotification.sent[0]?.onclick?.();
		expect(seam.focused).toBe(1);
		expect(seam.navigated).toEqual([]);
	});

	test('the hidden-tab and permission guards still decide whether anything is shown', () => {
		installBrowser('/');
		(mutableGlobal['document'] as { visibilityState: string }).visibilityState = 'visible';
		expect(notifyRunEvent(event('failed', 'run.verification-failed'))).toBe(false);

		(mutableGlobal['document'] as { visibilityState: string }).visibilityState = 'hidden';
		StubNotification.permission = 'default';
		expect(notifyRunEvent(event('failed', 'run.verification-failed'))).toBe(false);
		StubNotification.permission = 'granted';
		expect(StubNotification.sent).toHaveLength(0);
	});
});
