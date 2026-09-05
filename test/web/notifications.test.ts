import { afterEach, describe, expect, test } from 'bun:test';

import { notificationForRunEvent, notifyRunEvent } from '../../webui/src/notifications.ts';
import type { RunEventView, RunState } from '../../webui/src/run-view.ts';

function event(
	toState: RunState,
	kind: string,
	payload: Record<string, unknown> = {},
	fromState: RunState | null = 'working',
): RunEventView {
	return {
		seq: 1,
		runId: 'run-1',
		kind,
		fromState,
		toState,
		payload,
		createdAt: '2026-08-16T00:00:00.000Z',
	};
}

describe('run notifications', () => {
	test('alerts when a run really enters waiting-user', () => {
		expect(notificationForRunEvent(event('waiting-user', 'run.waiting-user', {
			summary: 'Escolha o seam.',
		}))).toMatchObject({ title: 'Gateship needs you', body: 'Escolha o seam.' });
	});

	test('does not alert on provider waits, recoverable failures, shipping, preserved workspaces, queue states, merges or repeated waiting-user', () => {
		expect(notificationForRunEvent(event('waiting-provider', 'run.provider-waiting'))).toBeNull();
		expect(notificationForRunEvent(event('interrupted', 'run.interrupted'))).toBeNull();
		expect(notificationForRunEvent(event('failed', 'run.verification-failed'))).toBeNull();
		expect(notificationForRunEvent(event('ready-to-ship', 'run.ship-failed'))).toBeNull();
		expect(notificationForRunEvent(event('done', 'workspace.cleanup-warning', {}, 'done'))).toBeNull();
		expect(notificationForRunEvent(event('done', 'run.chain-paused', { reason: 'operator-paused' }, 'done'))).toBeNull();
		expect(notificationForRunEvent(event('done', 'run.chain-paused', { reason: 'no-admissible-issue' }, 'done'))).toBeNull();
		expect(notificationForRunEvent(event('done', 'run.shipped'))).toBeNull();
		expect(notificationForRunEvent(event('waiting-user', 'run.operator-guidance', {}, 'waiting-user'))).toBeNull();
		expect(notificationForRunEvent(event('review', 'run.review-started'))).toBeNull();
	});

	test('a decision opens the conversation', () => {
		expect(notificationForRunEvent(event('waiting-user', 'run.waiting-user'))?.url).toBe('/');
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
		const seam = installBrowser('/runs');
		expect(notifyRunEvent(event('waiting-user', 'run.waiting-user'))).toBe(true);

		const notification = StubNotification.sent[0];
		notification?.onclick?.();
		expect(seam.focused).toBe(1);
		expect(seam.navigated).toEqual(['/']);
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
		expect(notifyRunEvent(event('waiting-user', 'run.waiting-user'))).toBe(false);

		(mutableGlobal['document'] as { visibilityState: string }).visibilityState = 'hidden';
		StubNotification.permission = 'default';
		expect(notifyRunEvent(event('waiting-user', 'run.waiting-user'))).toBe(false);
		StubNotification.permission = 'granted';
		expect(StubNotification.sent).toHaveLength(0);
	});
});
