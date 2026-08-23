// test/runtime/agent-cycle-question-resolver.test.ts
//
// The review cycle's question resolver is the fourth operator-facing agent
// text a run produces (GSHIP-703): its guidance and its reason both reach the
// operator, so it carries the same shared language contract as the executor,
// the reviewer and the conversational orchestrator.

import { describe, expect, test } from 'bun:test';

import type {
	AgentProviderId,
	AgentSession,
	AgentSessionInput,
} from '../../src/runtime/agent-session.ts';
import {
	AgentCycleQuestionResolver,
	buildCycleQuestionPrompt,
} from '../../src/runtime/agent-cycle-question-resolver.ts';
import { OPERATOR_LANGUAGE_CONTRACT } from '../../src/runtime/operator-language.ts';
import type { RuntimeCycleQuestionInput } from '../../src/runtime/run-runtime.ts';

function questionInput(
	overrides: Partial<RuntimeCycleQuestionInput> = {},
): RuntimeCycleQuestionInput {
	return {
		runId: 'run-703',
		issueId: 'CAM-703',
		workspace: '/workspace',
		finding: '1. src/a.ts: o contrato quebrou',
		origin: 'review',
		priorResponses: [],
		providerId: 'claude',
		signal: new AbortController().signal,
		emit: () => {},
		...overrides,
	};
}

function capturingSession(
	provider: AgentProviderId,
	capture: (input: AgentSessionInput) => void,
): AgentSession {
	return {
		provider,
		run: async (input) => {
			capture(input);
			return {
				summary: '',
				structuredOutput: { outcome: 'continue', guidance: 'Corrija o seam.', reason: null },
			};
		},
	};
}

describe('agent cycle question resolver', () => {
	test('carries the shared operator language contract, with and without prior responses', () => {
		const contract = OPERATOR_LANGUAGE_CONTRACT.join('\n');
		expect(buildCycleQuestionPrompt(questionInput())).toContain(contract);
		const prompt = buildCycleQuestionPrompt(questionInput({
			priorResponses: [{
				questionId: 'q-1',
				outcome: 'continue',
				finding: 'src/a.ts: o contrato quebrou',
				origin: 'review',
				text: 'Mantenha o seam menor.',
				createdAt: '2026-08-22T19:31:05.522Z',
			}],
		}));
		expect(prompt).toContain(contract);
		expect(prompt).toContain('"finding":"src/a.ts: o contrato quebrou"');
		expect(prompt).toContain('"origin":"review"');
	});

	// GSHIP-708: this turn holds no Issue record, so the contract's fallback
	// clause is the only thing naming a language source for it. Ruling out the
	// instructions' own English without it would leave the resolver with none.
	test('names a language source for a turn that carries no issue record', () => {
		const prompt = buildCycleQuestionPrompt(questionInput());
		expect(prompt).not.toContain('Issue record:');
		expect(prompt).toContain('When a turn carries no Issue record');
		expect(prompt).toContain('the review finding under discussion or the prior answers');
	});

	test('keeps the contract ahead of the finding and the prior responses', () => {
		const prompt = buildCycleQuestionPrompt(questionInput());
		expect(prompt.indexOf(OPERATOR_LANGUAGE_CONTRACT[0]))
			.toBeLessThan(prompt.indexOf('Current independent-review finding:'));
		expect(prompt.indexOf('Current independent-review finding:'))
			.toBeLessThan(prompt.indexOf('Prior durable cycle responses:'));
	});

	test('sends each provider the same prompt, as a fresh read-only turn', async () => {
		const turns: Record<string, AgentSessionInput> = {};
		const resolver = new AgentCycleQuestionResolver({
			claude: capturingSession('claude', (input) => { turns['claude'] = input; }),
			codex: capturingSession('codex', (input) => { turns['codex'] = input; }),
		});

		for (const providerId of ['claude', 'codex'] as const) {
			const result = await resolver.resolve(questionInput({ providerId }));
			expect(result.outcome).toBe('continue');
		}

		expect(turns['claude']?.prompt).toBe(buildCycleQuestionPrompt(questionInput()));
		expect(turns['codex']?.prompt).toBe(turns['claude']?.prompt);
		for (const turn of Object.values(turns)) {
			expect(turn.access).toBe('read-only');
			expect(turn.resume).toBe(false);
		}
	});
});
