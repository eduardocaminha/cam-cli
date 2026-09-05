import type { RunEventView } from './run-view.ts';
import { needsOperatorNotification } from '../../src/notification-eligibility.ts';

export type BrowserNotificationPermission = 'default' | 'denied' | 'granted' | 'unsupported';

/** Every run notification returns to its project run surface. */
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

function payloadText(event: RunEventView): string | null {
	const value = event.payload['summary'];
	return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/** Browser and remote channels alert only on a real entry into waiting-user. */
export function notificationForRunEvent(event: RunEventView): RunNotification | null {
	if (!needsOperatorNotification(event)) return null;
	return {
		title: 'Gateship needs you',
		body: payloadText(event) ?? 'The run is waiting for an operator decision.',
		tag: `gateship-run-${event.runId}`,
		url: '/',
	};
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
