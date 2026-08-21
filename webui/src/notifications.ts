import type { RunEventView } from './run-view.ts';

export type BrowserNotificationPermission = 'default' | 'denied' | 'granted' | 'unsupported';

/** Where the click lands: the decision belongs on the conversation, the rest on the runs surface. */
export type NotificationTarget = '/' | '/runs';

export interface RunNotification {
	title: string;
	body: string;
	tag: string;
	url: NotificationTarget;
}

type NativeNotificationPermission = Exclude<BrowserNotificationPermission, 'unsupported'>;

interface BrowserNotificationInstance {
	onclick: (() => void) | null;
	close: () => void;
}

interface BrowserNotificationConstructor {
	readonly permission: NativeNotificationPermission;
	requestPermission: () => Promise<NativeNotificationPermission>;
	new (
		title: string,
		options?: { body?: string; tag?: string },
	): BrowserNotificationInstance;
}

interface NotificationRuntime {
	Notification?: BrowserNotificationConstructor;
	document?: { visibilityState?: string };
	focus?: () => void;
	location?: { pathname: string; assign: (url: string) => void };
}

function notificationRuntime(): NotificationRuntime {
	return globalThis as NotificationRuntime;
}

function payloadText(event: RunEventView, key: 'summary' | 'error' | 'detail' | 'message'): string | null {
	const value = event.payload[key];
	return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/** Only transitions that need attention or close the loop deserve an alert. */
export function notificationForRunEvent(event: RunEventView): RunNotification | null {
	const tag = `gateship-run-${event.runId}`;

	// A preserved workspace is reported on the state the run already holds, so
	// it is decided before the transition guard below would discard it. Its own
	// tag keeps it beside the outcome notification instead of replacing it.
	if (event.kind === 'workspace.cleanup-warning') {
		return {
			title: 'Workspace preserved',
			body: payloadText(event, 'detail') ?? 'A local workspace was preserved for inspection.',
			tag: `gateship-workspace-${event.runId}`,
			url: '/runs',
		};
	}
	if (event.fromState === event.toState) return null;

	if (event.toState === 'waiting-user') {
		return {
			title: 'Gateship needs you',
			body: payloadText(event, 'summary') ?? 'The run is waiting for an operator decision.',
			tag,
			url: '/',
		};
	}
	if (event.toState === 'waiting-provider') {
		return {
			title: 'Provider temporarily unavailable',
			body: payloadText(event, 'message') ?? 'The run was preserved and can be resumed later.',
			tag,
			url: '/runs',
		};
	}
	if (event.toState === 'ready-to-ship' && event.kind === 'run.ship-failed') {
		return {
			title: 'Shipping needs another attempt',
			body: payloadText(event, 'error') ?? 'The code remains preserved and ready to retry.',
			tag,
			url: '/runs',
		};
	}
	if (event.toState === 'interrupted' && event.kind !== 'run.cancelled') {
		return {
			title: 'Run interrupted',
			body: 'The run can be resumed from Gateship.',
			tag,
			url: '/runs',
		};
	}
	if (event.toState === 'failed') {
		return {
			title: 'Run failed',
			body: payloadText(event, 'error') ?? 'Open Gateship to inspect the error.',
			tag,
			url: '/runs',
		};
	}
	if (event.toState === 'done') {
		return {
			title: 'Run completed',
			body: 'The change was merged successfully.',
			tag,
			url: '/runs',
		};
	}
	return null;
}

export function browserNotificationPermission(): BrowserNotificationPermission {
	return notificationRuntime().Notification?.permission ?? 'unsupported';
}

export async function requestBrowserNotificationPermission(): Promise<BrowserNotificationPermission> {
	const notificationApi = notificationRuntime().Notification;
	if (notificationApi === undefined) return 'unsupported';
	return await notificationApi.requestPermission();
}

/** Show a non-persistent notification only while the local control tab is hidden. */
export function notifyRunEvent(event: RunEventView): boolean {
	const runtime = notificationRuntime();
	const NotificationApi = runtime.Notification;
	if (
		NotificationApi === undefined ||
		runtime.document === undefined ||
		NotificationApi.permission !== 'granted' ||
		runtime.document.visibilityState === 'visible'
	) return false;
	const message = notificationForRunEvent(event);
	if (message === null) return false;

	try {
		const notification = new NotificationApi(message.title, {
			body: message.body,
			tag: message.tag,
		});
		notification.onclick = () => {
			runtime.focus?.();
			// The tab is already the destination often enough that navigating
			// unconditionally would throw away the surface the operator was on.
			const location = runtime.location;
			if (location !== undefined && location.pathname !== message.url) {
				location.assign(message.url);
			}
			notification.close();
		};
		return true;
	} catch {
		return false;
	}
}
