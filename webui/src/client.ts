// webui/src/client.ts
//
// Same-origin transport for the screen. Reads go to the two existing GET
// routes; writes go to the existing POST routes, which are the ones already
// guarded by the trusted-origin check. No token, no second server, no
// alternate base URL: the bundle is served by the process it talks to.

import type { PlannableIssue, RunView } from './run-view.ts';

export const SNAPSHOT_PATH = '/api/snapshot';
export const RUNS_PATH = '/api/runs';
export const EVENTS_PATH = '/api/events';

export type RunAction = 'resume' | 'cancel' | 'ship';

interface SnapshotPayload {
	idleState?: { backlog?: { plannable?: PlannableIssue[] } };
}

interface RunsPayload {
	runs: RunView[];
}

interface CommandPayload {
	ok?: boolean;
	message?: string;
}

async function readJson<T>(response: Response, what: string): Promise<T> {
	if (!response.ok) throw new Error(`${what} respondeu ${response.status}`);
	return (await response.json()) as T;
}

/**
 * The plannable backlog is only present while no cycle is in progress, which
 * is exactly when starting a run is admissible. An absent key is an empty
 * list, not an error.
 */
export async function fetchPlannable(): Promise<PlannableIssue[]> {
	const payload = await readJson<SnapshotPayload>(await fetch(SNAPSHOT_PATH), 'Snapshot');
	return payload.idleState?.backlog?.plannable ?? [];
}

/** Newest run first, which is the only one the screen commands. */
export async function fetchLatestRun(): Promise<RunView | null> {
	const payload = await readJson<RunsPayload>(await fetch(RUNS_PATH), 'Runs');
	return payload.runs[0] ?? null;
}

/** Resolves to the operator-facing outcome message for either verdict. */
async function postCommand(path: string, body?: unknown): Promise<string> {
	const response = await fetch(path, {
		method: 'POST',
		...(body === undefined
			? {}
			: { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
	});
	const payload = (await response.json()) as CommandPayload;
	if (response.ok) return 'Run atualizada.';
	return payload.message ?? `Comando recusado (${response.status}).`;
}

export function startRun(issueId: string): Promise<string> {
	return postCommand(RUNS_PATH, { issueId });
}

export function commandRun(runId: string, action: RunAction): Promise<string> {
	return postCommand(`${RUNS_PATH}/${runId}/${action}`);
}
