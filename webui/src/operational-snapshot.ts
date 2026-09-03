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
