// test/docs/orch-autonomous-actions.test.ts
//
// Binding channel for operator-authorized autonomous orchestrator actions
// (2026-08-14). Two permanent operator authorizations (autonomous `gship
// decide abandon` on a workless in-progress-conflict gate; autonomous squash
// merge of a green direct-lane PR) previously lived only in the ephemeral
// self-handoff file, while the orchestrator persona explicitly prohibited
// both. The fix splits by SCOPE: the persona (shipped to every downstream
// project via templates/) gains only a generic delegation hook deferring to
// the project's CLAUDE.md; the concrete policy lives in this repo's root
// CLAUDE.md, which is project-scoped and git-tracked.
//
// Modeled on test/docs/oracle-two-direction-sweep.test.ts (CAM-563(a)): the
// negative test proves the checker rejects text missing the sentences, and
// the draft test proves the checker can reach green.

import { test, expect, describe } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The generic delegation hook, verbatim, present at BOTH sites (the
 * in-progress gate paragraph and the PR prohibition bullet) in BOTH persona
 * copies. Generic by design: it must not name any cam-cli-specific rule,
 * because templates/ ships to every downstream `gship init` project.
 */
const HOOK_SENTENCE =
	"Exception: the project's CLAUDE.md may authorize specific autonomous actions under explicitly stated conditions; when such an authorization exists and its conditions are met, act on it and report the action to the operator.";

/**
 * The defaults stay as defaults. Asserting their PRESENCE (each immediately
 * followed by the hook) rather than mere absence of the old absolute form
 * means an empty or unrelated file can never satisfy this checker by
 * accident.
 */
const GATE_DEFAULT = 'you never resolve it in-process';
const PR_DEFAULT = 'Do not commit, push, open, or merge PRs directly';

/** Chars of normalized text scanned after each default for the hook. */
const HOOK_WINDOW = 700;

const PERSONA_PATHS = [
	'.claude/agents/subagent-orchestrator.md',
	'templates/agents/subagent-orchestrator.md',
] as const;

/** Key clauses of the two concrete rules in the root CLAUDE.md. */
const CLAUDE_MD_CLAUSES = [
	// REGRA A: autonomous abandon on a workless gate
	'roda `gship decide abandon` direto e informa o operador, sem perguntar',
	'verificada por git',
	'nunca pelo campo do PRD',
	'`rm handoff.json`, `rm prd.json`, `git checkout main`',
	// REGRA B: autonomous squash merge of a green direct-lane PR
	'prefixo `direct/`',
	'mergeia com squash',
	'Gate a conclusao em `.status`',
	'vincula a sessao worker da faixa direta',
] as const;

/** Collapse whitespace so hard-wrapped sentences match single-line needles. */
function normalize(text: string): string {
	return text.replace(/\s+/g, ' ');
}

/**
 * Returns the list of problems with a persona body; empty means compliant.
 * Each default must be present AND followed by the verbatim hook within
 * HOOK_WINDOW normalized chars, and the hook must appear at both sites.
 */
export function personaProblems(raw: string): string[] {
	const text = normalize(raw);
	const problems: string[] = [];

	const hookCount = text.split(HOOK_SENTENCE).length - 1;
	if (hookCount < 2) {
		problems.push(`hook sentence appears ${hookCount}x; need 2 (gate site + PR site)`);
	}

	for (const [label, needle] of [
		['gate default', GATE_DEFAULT],
		['PR bullet (merge disambiguated)', PR_DEFAULT],
	] as const) {
		const idx = text.indexOf(needle);
		if (idx === -1) {
			problems.push(`${label} missing: "${needle}"`);
			continue;
		}
		const window = text.slice(idx, idx + needle.length + HOOK_WINDOW);
		if (!window.includes(HOOK_SENTENCE)) {
			problems.push(`${label} not followed by the hook sentence within ${HOOK_WINDOW} chars`);
		}
	}

	return problems;
}

/** Returns the CLAUDE.md clauses missing from `raw`; empty means compliant. */
export function missingClauses(raw: string): string[] {
	const text = normalize(raw);
	return CLAUDE_MD_CLAUSES.filter((clause) => !text.includes(clause));
}

describe('orchestrator autonomous-action delegation hook (persona copies)', () => {
	for (const relPath of PERSONA_PATHS) {
		test(`${relPath} carries the hook at both sites, defaults kept`, () => {
			const text = readFileSync(join(import.meta.dir, '../..', relPath), 'utf8');
			expect(personaProblems(text)).toEqual([]);
		});
	}

	test('the two persona copies are byte-identical', () => {
		const [a, b] = PERSONA_PATHS.map((p) =>
			readFileSync(join(import.meta.dir, '../..', p), 'utf8'),
		);
		expect(a).toBe(b);
	});
});

describe('concrete rules live in the root CLAUDE.md', () => {
	test('root CLAUDE.md carries the key clauses of both rules', () => {
		const text = readFileSync(join(import.meta.dir, '../..', 'CLAUDE.md'), 'utf8');
		expect(missingClauses(text)).toEqual([]);
	});
});

describe('falsifiability', () => {
	test('the persona checker rejects text lacking hook and defaults', () => {
		const bare = '# persona\nNarrate gates; delegate everything to workers.';
		expect(personaProblems(bare)).toEqual([
			'hook sentence appears 0x; need 2 (gate site + PR site)',
			`gate default missing: "${GATE_DEFAULT}"`,
			`PR bullet (merge disambiguated) missing: "${PR_DEFAULT}"`,
		]);
	});

	test('the persona checker rejects a default not followed by the hook', () => {
		const halfway = [
			`Elsewhere: ${PR_DEFAULT}. ${HOOK_SENTENCE}`,
			`And a stray hook to reach the count: ${HOOK_SENTENCE}`,
			`Some text where ${GATE_DEFAULT} stands alone as an absolute, nothing after it.`,
		].join('\n');
		expect(personaProblems(halfway)).toEqual([
			'gate default not followed by the hook sentence within 700 chars',
		]);
	});

	test('the persona checker reaches green on a compliant draft', () => {
		const draft = [
			`You narrate this gate; ${GATE_DEFAULT}. ${HOOK_SENTENCE}`,
			`- ${PR_DEFAULT}. ${HOOK_SENTENCE}`,
		].join('\n');
		expect(personaProblems(draft)).toEqual([]);
	});

	test('the CLAUDE.md checker rejects text lacking the clauses', () => {
		const bare = '# CLAUDE.md\nUse Bun. Ship green.';
		expect(missingClauses(bare)).toEqual([...CLAUDE_MD_CLAUSES]);
	});

	test('the CLAUDE.md checker reaches green on a draft carrying all clauses', () => {
		const draft = CLAUDE_MD_CLAUSES.join('\n');
		expect(missingClauses(draft)).toEqual([]);
	});
});
