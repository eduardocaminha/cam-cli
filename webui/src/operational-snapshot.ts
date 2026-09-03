// The operational document has a deliberately small identity core. Every
// other read may fail independently without turning an available project into
// an empty one.

export type OperationalRead<T> =
	| { state: 'available'; value: T }
	| { state: 'unavailable'; detail: string };

export type OperationalResource =
	| 'Runs'
	| 'Run activity'
	| 'Snapshot'
	| 'Providers'
	| 'Conversation'
	| 'Brief'
	| 'Proposals'
	| 'Resolved proposals'
	| 'Model settings'
	| 'Agent defaults'
	| 'Run chain'
	| 'Executor handoff'
	| 'Notifications'
	| 'Operator profile'
	| 'Diagnostics'
	| 'Self update';

/** The named availability of every secondary read. */
export type OperationalFailures = Partial<Record<OperationalResource, string>>;

/** A value that was revealed remains usable through a failed refresh. */
export type OperationalLoaded = Partial<Record<OperationalResource, true>>;

/** A secondary read has not yet settled for the current operational scope. */
export type OperationalPending = Partial<Record<OperationalResource, true>>;

export interface OperationalReadState {
	failures: OperationalFailures;
	loaded: OperationalLoaded;
	pending: OperationalPending;
}

export const OPERATIONAL_RESOURCES = [
	'Runs',
	'Run activity',
	'Snapshot',
	'Providers',
	'Conversation',
	'Brief',
	'Proposals',
	'Resolved proposals',
	'Model settings',
	'Agent defaults',
	'Run chain',
	'Executor handoff',
	'Notifications',
	'Operator profile',
	'Diagnostics',
	'Self update',
] as const satisfies readonly OperationalResource[];

export function pendingOperationalReads(): OperationalPending {
	return Object.fromEntries(OPERATIONAL_RESOURCES.map((resource) => [resource, true])) as OperationalPending;
}

export function beginOperationalReads(loaded: OperationalLoaded): OperationalReadState {
	return { failures: {}, loaded, pending: pendingOperationalReads() };
}

export function settleOperationalRead(
	current: OperationalReadState,
	resource: OperationalResource,
	result: OperationalRead<unknown>,
): OperationalReadState {
	const { [resource]: _pending, ...pending } = current.pending;
	if (result.state === 'unavailable') {
		return { ...current, pending, failures: { ...current.failures, [resource]: result.detail } };
	}
	const { [resource]: _failure, ...failures } = current.failures;
	return { failures, pending, loaded: { ...current.loaded, [resource]: true } };
}

/** Collapses a burst of stream invalidations into one complete snapshot read. */
export function createOperationalRefreshCoalescer(
	refresh: () => Promise<unknown>,
	schedule: (callback: () => void) => void = (callback) => { setTimeout(callback, 50); },
): { queue: () => void; cancel: () => void } {
	let scheduled = false;
	let running = false;
	let dirty = false;
	let cancelled = false;
	const run = async (): Promise<void> => {
		running = true;
		try {
			await refresh();
		} finally {
			running = false;
			if (dirty && !cancelled) {
				dirty = false;
				queue();
			}
		}
	};
	const queue = (): void => {
		if (running) {
			dirty = true;
			return;
		}
		if (scheduled) return;
		scheduled = true;
		cancelled = false;
		schedule(() => {
			scheduled = false;
			if (!cancelled) void run();
		});
	};
	return {
		queue,
		cancel: () => { cancelled = true; },
	};
}

/** The core read, not a secondary read, decides when the scope leaves its skeleton. */
export function createOperationalSnapshotCycle(scope: string | null): {
	changeScope: (scope: string | null) => void;
	begin: (scope: string | null, initial: boolean) => number;
	isCurrent: (request: number, scope: string | null) => boolean;
	finishCore: (request: number, scope: string | null) => boolean;
	loading: () => boolean;
} {
	let activeScope = scope;
	let activeRequest = 0;
	let loading = true;
	return {
		changeScope: (nextScope) => {
			if (nextScope === activeScope) return;
			activeRequest += 1;
			activeScope = nextScope;
		},
	begin: (requestScope, initial) => {
			if (requestScope !== activeScope) return -1;
			activeRequest += 1;
			if (initial) loading = true;
			return activeRequest;
		},
		isCurrent: (request, requestScope) => request === activeRequest && requestScope === activeScope,
		finishCore: (request, requestScope) => {
			if (request !== activeRequest || requestScope !== activeScope) return false;
			loading = false;
			return true;
		},
		loading: () => loading,
	};
}

const GLOBAL_OPERATIONAL_RESOURCES = [
	'Agent defaults',
	'Notifications',
	'Operator profile',
	'Self update',
] as const satisfies readonly OperationalResource[];

/** A project change invalidates only values that came from the old project. */
export function preserveGlobalOperationalLoaded(current: OperationalLoaded): OperationalLoaded {
	const preserved: OperationalLoaded = {};
	for (const resource of GLOBAL_OPERATIONAL_RESOURCES) {
		if (current[resource] === true) preserved[resource] = true;
	}
	return preserved;
}

/** Every accepted refresh names outstanding reads again, keeping revealed scope data on same-scope retries. */
export function beginOperationalRefresh(current: OperationalReadState, initial: boolean): OperationalReadState {
	return beginOperationalReads(initial ? preserveGlobalOperationalLoaded(current.loaded) : current.loaded);
}

export async function readOperationalPart<T>(read: () => Promise<T>): Promise<OperationalRead<T>> {
	try {
		return { state: 'available', value: await read() };
	} catch (error: unknown) {
		return { state: 'unavailable', detail: String(error) };
	}
}

/** A late response may only update the scope and generation that started it. */
export function isCurrentOperationalRead(
	request: number,
	activeRequest: number,
	scope: string | null,
	activeScope: string | null,
): boolean {
	return request === activeRequest && scope === activeScope;
}
