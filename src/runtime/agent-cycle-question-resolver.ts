import { randomUUID } from 'node:crypto';

import type { AgentProviderId, AgentSession } from './agent-session.ts';
import { OPERATOR_LANGUAGE_CONTRACT } from './operator-language.ts';
import type {
	RuntimeCycleQuestionInput,
	RuntimeCycleQuestionResolver,
	RuntimeCycleQuestionResult,
	RuntimeCycleResponseUsage,
} from './run-runtime.ts';

export const CYCLE_QUESTION_RESULT_SCHEMA = {
	type: 'object',
	properties: {
		outcome: { type: 'string', enum: ['continue', 'operator'] },
		guidance: { type: ['string', 'null'] },
		reason: { type: ['string', 'null'] },
	},
	required: ['outcome', 'guidance', 'reason'],
	additionalProperties: false,
} as const;

function recordOf(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
		? value as Record<string, unknown>
		: null;
}

function numberOf(record: Record<string, unknown> | null | undefined, key: string): number | undefined {
	const value = record?.[key];
	return typeof value === 'number' ? value : undefined;
}

function firstText(...values: unknown[]): string | undefined {
	return values.find((value): value is string => typeof value === 'string');
}

function reportedNumbers(record: Record<string, unknown> | null): Partial<RuntimeCycleResponseUsage> {
	const fields = [
		'inputTokens', 'outputTokens', 'cacheCreationInputTokens', 'cacheReadInputTokens', 'thinkingTokens',
	] as const;
	return Object.fromEntries(fields.flatMap((field) => {
		const value = numberOf(record, field);
		return value === undefined ? [] : [[field, value]];
	}));
}

function usageOf(
	payload: Record<string, unknown> | undefined,
	modelPayload: Record<string, unknown> | undefined,
): RuntimeCycleResponseUsage {
	const invocation = recordOf(payload?.['usage']);
	const modelUsage = Array.isArray(payload?.['modelUsage'])
		? payload['modelUsage'].filter((entry): entry is Record<string, unknown> => recordOf(entry) !== null)
		: undefined;
	const reportedModel = modelUsage?.find((entry) => typeof entry['model'] === 'string')?.['model'];
	const model = firstText(payload?.['model'], modelPayload?.['model'], reportedModel)
		?? 'provider-default';
	const effort = firstText(payload?.['effort'], modelPayload?.['effort']) ?? 'provider-default';
	const totalCostUsd = numberOf(payload, 'totalCostUsd');
	const usage: RuntimeCycleResponseUsage = {
		model,
		effort,
		...(totalCostUsd === undefined ? {} : { totalCostUsd }),
		...reportedNumbers(invocation),
		...(modelUsage === undefined ? {} : { modelUsage }),
	};
	return usage;
}

export function buildCycleQuestionPrompt(input: RuntimeCycleQuestionInput): string {
	const contractSection = input.approvedContract === undefined ? [] : [
		'',
		'Approved issue contract:',
		input.approvedContract,
	];
	return [
		`Answer one bounded Gateship cycle question for run ${input.runId}, issue ${input.issueId}.`,
		'You are the orchestrator, in a fresh mechanically read-only session. Do not edit files, approve, start, ship, or request tools that mutate state.',
		'Return continue only with non-empty, concrete guidance that lets the existing executor proceed within authority already granted by the approved contract, make a precise in-scope correction, or provide an evidence-backed no-change rebuttal.',
		'Return operator only when a concrete unresolved product or authority ambiguity requires a human decision, with that ambiguity in reason.',
		'Do not expose hidden reasoning or credentials.',
		'',
		...OPERATOR_LANGUAGE_CONTRACT,
		...contractSection,
		'',
		'Current cycle question:',
		`Finding origin: ${input.origin}.`,
		input.finding,
		'',
		'Prior durable cycle responses:',
		JSON.stringify(input.priorResponses),
		'',
		'If the same question has returned after concrete internal guidance without new evidence of progress, return operator with that stall as the public reason. A new technical question answered by the approved contract must return continue.',
	].join('\n');
}

function parseResult(value: unknown, usage: RuntimeCycleResponseUsage): RuntimeCycleQuestionResult {
	const record = recordOf(value);
	if (record?.['outcome'] === 'continue') {
		return { outcome: 'continue', guidance: String(record['guidance'] ?? ''), usage };
	}
	if (record?.['outcome'] === 'operator') {
		return { outcome: 'operator', reason: String(record['reason'] ?? ''), usage };
	}
	return { outcome: 'operator', reason: '', usage };
}

/** Routes each run to its own provider, always as a fresh read-only call. */
export class AgentCycleQuestionResolver implements RuntimeCycleQuestionResolver {
	readonly #sessions: Readonly<Record<AgentProviderId, AgentSession>>;

	constructor(sessions: Readonly<Record<AgentProviderId, AgentSession>>) {
		this.#sessions = sessions;
	}

	async resolve(input: RuntimeCycleQuestionInput): Promise<RuntimeCycleQuestionResult> {
		let usagePayload: Record<string, unknown> | undefined;
		let modelPayload: Record<string, unknown> | undefined;
		const result = await this.#sessions[input.providerId].run({
			sessionId: randomUUID(),
			resume: false,
			cwd: input.workspace,
			prompt: buildCycleQuestionPrompt(input),
			access: 'read-only',
			outputSchema: CYCLE_QUESTION_RESULT_SCHEMA,
			signal: input.signal,
			eventPrefix: 'cycle-question',
			emit: (kind, payload, eventClass) => {
				if (kind === 'cycle-question.usage') usagePayload = payload;
				if (kind === 'cycle-question.model') modelPayload = payload;
				input.emit(kind, payload, eventClass);
			},
		});
		return parseResult(result.structuredOutput, usageOf(usagePayload, modelPayload));
	}
}
