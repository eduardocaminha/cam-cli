import type { AgentProviderId } from './agent-session.ts';
import type { RunCostRole, RunEvent, RunRecord } from './run-store.ts';
import { isTerminalRunState } from './run-state.ts';

export type RunEvaluationOutcome = 'shipped' | 'failed' | 'cancelled' | 'incomplete';

export interface RunRoleConfiguration {
	role: RunCostRole;
	models: string[];
	efforts: string[];
}

/**
 * Replayable facts for one run. Every field is derived from the run and its
 * complete durable decision log; no evaluator model or stored score exists.
 */
export interface RunEvaluation {
	workflowRevision: string | null;
	provider: AgentProviderId;
	outcome: RunEvaluationOutcome;
	wallTimeMs: number | null;
	attentionRequests: number;
	operatorInterventions: number;
	providerHolds: number;
	roles: RunRoleConfiguration[];
}

const MODEL_EVENT_ROLES: Readonly<Record<string, RunCostRole>> = {
	'provider.model': 'executor',
	'review.model': 'reviewer',
};

function normalizedText(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const normalized = value.trim();
	return normalized.length > 0 ? normalized : null;
}

function outcomeOf(run: RunRecord): RunEvaluationOutcome {
	if (run.state === 'done') return 'shipped';
	if (run.state === 'failed') return 'failed';
	if (run.state === 'cancelled') return 'cancelled';
	return 'incomplete';
}

function wallTimeOf(run: RunRecord): number | null {
	if (!isTerminalRunState(run.state)) return null;
	const createdAt = Date.parse(run.createdAt);
	const updatedAt = Date.parse(run.updatedAt);
	if (!Number.isFinite(createdAt) || !Number.isFinite(updatedAt) || updatedAt < createdAt) return null;
	return updatedAt - createdAt;
}

function workflowRevisionOf(events: readonly RunEvent[]): string | null {
	const created = events.find((event) => event.kind === 'run.created');
	return normalizedText(created?.payload['workflowRevision']);
}

function roleConfigurations(events: readonly RunEvent[]): RunRoleConfiguration[] {
	const configurations = new Map<RunCostRole, { models: Set<string>; efforts: Set<string> }>();
	for (const event of events) {
		const role = MODEL_EVENT_ROLES[event.kind];
		if (role === undefined) continue;
		const entry = configurations.get(role) ?? { models: new Set<string>(), efforts: new Set<string>() };
		const model = normalizedText(event.payload['model']);
		const effort = normalizedText(event.payload['effort']);
		if (model !== null) entry.models.add(model);
		if (effort !== null) entry.efforts.add(effort);
		configurations.set(role, entry);
	}
	return [...configurations.entries()]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([role, configuration]) => ({
			role,
			models: [...configuration.models].sort(),
			efforts: [...configuration.efforts].sort(),
		}));
}

export function evaluateRun(run: RunRecord, events: readonly RunEvent[]): RunEvaluation {
	return {
		workflowRevision: workflowRevisionOf(events),
		provider: run.providerId,
		outcome: outcomeOf(run),
		wallTimeMs: wallTimeOf(run),
		attentionRequests: events.filter((event) =>
			event.toState === 'waiting-user' && event.fromState !== 'waiting-user').length,
		operatorInterventions: events.filter((event) => event.kind === 'run.operator-guidance').length,
		providerHolds: events.filter((event) => event.kind === 'run.provider-waiting').length,
		roles: roleConfigurations(events),
	};
}
