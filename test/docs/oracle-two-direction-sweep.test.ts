// test/docs/oracle-two-direction-sweep.test.ts
//
// CAM-563(a): the two-direction oracle sweep discipline must live in the
// binding channel (the persona bodies that load into the system prompt on
// every boot), not only in grep-on-demand scripts/cam/patterns.md. Measured
// 2026-08-13 (CAM-559): two of ten persisted acceptance-criterion oracles
// were unsatisfiable by construction and passed the red-only sweep because
// they were red for the wrong reason.
//
// This tripwire asserts the two mandatory sentences of the rule are present,
// verbatim, in both persona files and their templates/ mirrors. The negative
// test proves the checker actually rejects text missing the sentences, and
// the draft test proves the checker can reach green (the discipline this
// rule installs, applied to the tripwire itself).

import { test, expect, describe } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const MANDATORY_SENTENCES = [
	'Vermelho pelo motivo errado e indistinguivel de vermelho pelo motivo certo',
	'precisa ser observado VERDE la',
] as const;

const PERSONA_PATHS = [
	'.claude/agents/subagent-orchestrator.md',
	'.claude/agents/subagent-planner.md',
	'templates/agents/subagent-orchestrator.md',
	'templates/agents/subagent-planner.md',
] as const;

function missingSentences(text: string): string[] {
	return MANDATORY_SENTENCES.filter((sentence) => !text.includes(sentence));
}

describe('two-direction oracle sweep discipline', () => {
	for (const relPath of PERSONA_PATHS) {
		test(`${relPath} carries both mandatory sentences verbatim`, () => {
			const text = readFileSync(join(import.meta.dir, '../..', relPath), 'utf8');
			expect(missingSentences(text)).toEqual([]);
		});
	}

	test('the checker rejects text that lacks the sentences (not tautological)', () => {
		const withoutRule = '# persona\nSweep oracles carefully before delivering.';
		expect(missingSentences(withoutRule)).toEqual([...MANDATORY_SENTENCES]);
	});

	test('the checker reaches green on a draft carrying both sentences', () => {
		const draft = [
			'Vermelho pelo motivo errado e indistinguivel de vermelho pelo motivo certo num teste booleano.',
			'O oraculo precisa ser observado VERDE la.',
		].join('\n');
		expect(missingSentences(draft)).toEqual([]);
	});
});
