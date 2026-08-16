import type { RunEventView } from './run-view.ts';

export type BrowserNotificationPermission = 'default' | 'denied' | 'granted' | 'unsupported';

export interface RunNotification {
	title: string;
	body: string;
	tag: string;
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
}

function notificationRuntime(): NotificationRuntime {
	return globalThis as NotificationRuntime;
}

function payloadText(event: RunEventView, key: 'summary' | 'error'): string | null {
	const value = event.payload[key];
	return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/** Only transitions that need attention or close the loop deserve an alert. */
export function notificationForRunEvent(event: RunEventView): RunNotification | null {
	if (event.fromState === event.toState) return null;
	const tag = `gateship-run-${event.runId}`;

	if (event.toState === 'waiting-user') {
		return {
			title: 'Gateship precisa de você',
			body: payloadText(event, 'summary') ?? 'O run aguarda uma decisão do operador.',
			tag,
		};
	}
	if (event.toState === 'ready-to-ship' && event.kind === 'run.ship-failed') {
		return {
			title: 'Ship precisa de nova tentativa',
			body: payloadText(event, 'error') ?? 'O código continua preservado e pronto para retry.',
			tag,
		};
	}
	if (event.toState === 'interrupted' && event.kind !== 'run.cancelled') {
		return {
			title: 'Run interrompido',
			body: 'O run pode ser retomado pela interface.',
			tag,
		};
	}
	if (event.toState === 'failed') {
		return {
			title: 'Run falhou',
			body: payloadText(event, 'error') ?? 'Abra o Gateship para ver o erro.',
			tag,
		};
	}
	if (event.toState === 'done') {
		return {
			title: 'Run concluído',
			body: 'A mudança foi mergeada com sucesso.',
			tag,
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
			notification.close();
		};
		return true;
	} catch {
		return false;
	}
}
