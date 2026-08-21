import type { RunEvent } from './run-store.ts';

export type PullRequestCiStatus = 'not-reported' | 'pending' | 'passed' | 'failed';

export interface FailedPullRequestCheck {
	name: string;
	url?: string;
}

/** GitHub delivery facts replayed from a run's durable decision log. */
export interface PullRequestDelivery {
	prNumber: number;
	url: string;
	ciStatus: PullRequestCiStatus;
	failedChecks: FailedPullRequestCheck[];
}

function httpUrl(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	try {
		const parsed = new URL(value);
		return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : null;
	} catch {
		return null;
	}
}

function selectFailedChecks(value: unknown): FailedPullRequestCheck[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((candidate) => {
		if (candidate === null || typeof candidate !== 'object') return [];
		const record = candidate as Record<string, unknown>;
		if (typeof record['name'] !== 'string' || record['name'].trim().length === 0) return [];
		const url = httpUrl(record['url']);
		return [{ name: record['name'], ...(url === null ? {} : { url }) }];
	});
}

/**
 * Opening or reusing a pull request starts honestly at not-reported. Later CI
 * events replace only that aggregate and its optional failed-check evidence.
 */
export function selectPullRequestDelivery(events: readonly RunEvent[]): PullRequestDelivery | null {
	let delivery: PullRequestDelivery | null = null;
	for (const event of events) {
		if (event.kind === 'ship.pr-opened' || event.kind === 'ship.pr-reused') {
			delivery = selectPullRequest(event, delivery);
			continue;
		}
		if (event.kind === 'ship.ci-status') delivery = selectCiStatus(event, delivery);
	}
	return delivery;
}

function selectPullRequest(event: RunEvent, previous: PullRequestDelivery | null): PullRequestDelivery | null {
	const prNumber = event.payload['prNumber'];
	const url = httpUrl(event.payload['url']);
	if (typeof prNumber !== 'number' || !Number.isSafeInteger(prNumber) || url === null) return previous;
	return previous?.prNumber === prNumber
		? { ...previous, url }
		: { prNumber, url, ciStatus: 'not-reported', failedChecks: [] };
}

function selectCiStatus(event: RunEvent, delivery: PullRequestDelivery | null): PullRequestDelivery | null {
	if (delivery === null) return null;
	const status = event.payload['status'];
	if (status !== 'not-reported' && status !== 'pending' && status !== 'passed' && status !== 'failed') {
		return delivery;
	}
	return {
		...delivery,
		ciStatus: status,
		failedChecks: status === 'failed' ? selectFailedChecks(event.payload['failedChecks']) : [],
	};
}
