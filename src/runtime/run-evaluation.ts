import { EXECUTOR_HANDOFF_EVENT } from './agent-executor-router.ts';
import { REVIEW_FALLBACK_EVENT } from './agent-reviewer-router.ts';
import type { AgentProviderId } from './agent-session.ts';
import { isTerminalRunState } from './run-state.ts';
import type { RunCostRole, RunEvent, RunRecord } from './run-store.ts';

export type RunEvaluationOutcome = 'shipped' | 'failed' | 'cancelled' | 'incomplete';

export interface RunRoleConfiguration {
	role: RunCostRole;
	models: string[];
	efforts: string[];
	/**
	 * The providers this role was actually invoked on (GSHIP-709), the same
	 * reading `models` and `efforts` already have: what ran, not what it
	 * produced. The run's own provider ran every invocation it configured, and
	 * a review fallback adds the alternative it invoked beside -- never
	 * instead of -- the origin it started from. Whether that attempt reached a
	 * verdict is the fallback event's own `outcome`, not a provider's absence.
	 */
	providers: AgentProviderId[];
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
	resolvedCycleQuestions?: number;
	roles: RunRoleConfiguration[];
}

const MODEL_EVENT_ROLES: Readonly<Record<string, RunCostRole>> = {
	'provider.model': 'executor',
	'review.model': 'reviewer',
	'run.cycle-response': 'orchestrator',
};

function providerOf(value: unknown): AgentProviderId | null {
	return value === 'claude' || value === 'codex' ? value : null;
}

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

interface RoleConfigurationAccumulator {
	models: Set<string>;
	efforts: Set<string>;
	providers: Set<AgentProviderId>;
}

/**
 * Both providers one review fallback or executor handoff names (GSHIP-709,
 * GSHIP-722). Either event is written only once the alternative actually
 * settled, so the target counts as invoked even when it refused: its own
 * spawn already reported the model and effort it ran with, and dropping the
 * provider alone would leave the role showing a model no listed provider ever
 * ran.
 */
function foldProviderPair(
	entry: RoleConfigurationAccumulator,
	payload: Record<string, unknown>,
): void {
	const from = providerOf(payload['from']);
	const to = providerOf(payload['to']);
	if (from !== null) entry.providers.add(from);
	if (to !== null) entry.providers.add(to);
}

/**
 * The models, efforts and providers each role was actually invoked with. The
 * model events carry the first two; the provider comes from the run, which is
 * the one that spawned them, plus the review fallback's own durable record --
 * the only place a role runs on a provider the run did not select.
 */
function roleConfigurations(run: RunRecord, events: readonly RunEvent[]): RunRoleConfiguration[] {
	const configurations = new Map<RunCostRole, RoleConfigurationAccumulator>();
	const entryFor = (role: RunCostRole): RoleConfigurationAccumulator => {
		const entry = configurations.get(role)
			?? { models: new Set<string>(), efforts: new Set<string>(), providers: new Set<AgentProviderId>() };
		configurations.set(role, entry);
		return entry;
	};
	for (const event of events) {
		if (event.kind === REVIEW_FALLBACK_EVENT) {
			foldProviderPair(entryFor('reviewer'), event.payload);
			continue;
		}
		if (event.kind === EXECUTOR_HANDOFF_EVENT) {
			foldProviderPair(entryFor('executor'), event.payload);
			continue;
		}
		const role = MODEL_EVENT_ROLES[event.kind];
		if (role === undefined) continue;
		const entry = entryFor(role);
		const model = normalizedText(event.payload['model']);
		const effort = normalizedText(event.payload['effort']);
		if (model !== null) entry.models.add(model);
		if (effort !== null) entry.efforts.add(effort);
		entry.providers.add(providerOf(event.payload['provider']) ?? run.providerId);
	}
	return [...configurations.entries()]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([role, configuration]) => ({
			role,
			models: [...configuration.models].sort(),
			efforts: [...configuration.efforts].sort(),
			providers: [...configuration.providers].sort(),
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
		resolvedCycleQuestions: events.filter((event) => event.kind === 'run.cycle-response').length,
		roles: roleConfigurations(run, events),
	};
}
