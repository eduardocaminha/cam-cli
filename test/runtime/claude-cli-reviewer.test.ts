// test/runtime/claude-cli-reviewer.test.ts
//
// CAM-577 acceptance criterion 2: every review is a fresh session, separate
// from the implementer's, with a structured verdict and a read-only tool
// capability. The flag assertions run against a REAL child process (the
// fixture echoes the argv it received), not only against the argv builder,
// because "the process does not receive Bash" is a property of the spawn.

import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import process from 'node:process';

import {
	buildReviewerCliArgv,
	buildReviewPrompt,
	ClaudeCliReviewer,
	collectChange,
	parseReviewVerdict,
	REVIEW_MATERIALITY_CONTRACT,
	REVIEW_RESULT_SCHEMA,
} from '../../src/runtime/claude-cli-reviewer.ts';
import { OPERATOR_LANGUAGE_CONTRACT } from '../../src/runtime/operator-language.ts';
import type {
	RuntimeExecutionInput,
	RuntimeReviewResult,
} from '../../src/runtime/run-runtime.ts';
import { createTestTmpdir } from '../helpers/test-tmpdir.ts';

const FIXTURE = join(import.meta.dir, '..', 'fixtures', 'runtime', 'claude-cli-fixture.ts');

/**
 * Tools a reviewer must not hold. Beyond the mutating built-ins, these are the
 * delegating and outbound ones the allowlist-only argv left in place on a real
 * child (measured 2026-08-15, CLI 2.1.233).
 */
const CAPABLE_TOOLS = [
	'Bash',
	'Edit',
	'Write',
	'NotebookEdit',
	'Agent',
	'Workflow',
	'Skill',
	'ToolSearch',
	'SendMessage',
	'RemoteTrigger',
	'WebFetch',
];

function flagValue(argv: string[], flag: string): string | undefined {
	const index = argv.indexOf(flag);
	return index >= 0 ? argv[index + 1] : undefined;
}

/** The argv and prompt the fixture child actually received, echoed back through its verdict. */
function reviewEcho(result: RuntimeReviewResult): { argv: string[]; prompt: string } {
	const detail = result.verdict === 'findings' ? result.detail : '';
	const start = detail.indexOf('{');
	expect(start).toBeGreaterThanOrEqual(0);
	return JSON.parse(detail.slice(start)) as { argv: string[]; prompt: string };
}

function argvFromReview(result: RuntimeReviewResult): string[] {
	return reviewEcho(result).argv;
}

/** The bare prompt text the child received, decoded out of the stream-json envelope. */
function promptFromReview(result: RuntimeReviewResult): string {
	const envelope = JSON.parse(reviewEcho(result).prompt.trim()) as { message: { content: string } };
	return envelope.message.content;
}

function reviewInput(overrides: Partial<RuntimeExecutionInput> = {}): RuntimeExecutionInput {
	return {
		runId: 'run-review',
		issueId: 'CAM-577',
		sessionId: 'session-implementer',
		resume: false,
		cwd: createTestTmpdir('gship-reviewer-'),
		signal: new AbortController().signal,
		emit: () => {},
		...overrides,
	};
}

function fixtureReviewer(
	verdict: 'CLEAN' | 'FINDINGS' | 'NONE',
	overrides: Record<string, unknown> = {},
): ClaudeCliReviewer {
	return new ClaudeCliReviewer({
		command: ['bun', FIXTURE, '--fixture-mode=review', `--fixture-verdict=${verdict}`],
		loadIssue: () => '{"id":"CAM-577"}',
		runGit: () => ({ exitCode: 0, stdout: 'M src/a.ts\n', stderr: '' }),
		...overrides,
	});
}

async function waitFor(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error('timed out waiting for child process');
		await Bun.sleep(5);
	}
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

describe('independent Claude CLI reviewer', () => {
	test('never offers a resume flag, so no review inherits the implementer session', () => {
		const argv = buildReviewerCliArgv({ command: ['claude'], sessionId: 'ABC-DEF' });
		expect(argv).toContain('--session-id');
		expect(argv).toContain('abc-def');
		expect(argv).not.toContain('--resume');
		expect(argv).not.toContain('--continue');
	});

	// GSHIP-626: the same mechanism the executor already uses to guarantee a
	// structured result, so the reviewer never has to depend on scanning its
	// own prose for a verdict object.
	test('loads the review result schema so the CLI answers with a structured verdict', () => {
		const argv = buildReviewerCliArgv({
			command: ['claude'],
			sessionId: 'abc-def',
			jsonSchema: REVIEW_RESULT_SCHEMA,
		});
		expect(flagValue(argv, '--json-schema')).toBe(JSON.stringify(REVIEW_RESULT_SCHEMA));
	});

	test('omits --json-schema when no schema is given', () => {
		const argv = buildReviewerCliArgv({ command: ['claude'], sessionId: 'abc-def' });
		expect(argv).not.toContain('--json-schema');
	});

	test('closes the built-in, MCP and skill surfaces, not only the permission prompt', () => {
		const argv = buildReviewerCliArgv({ command: ['claude'], sessionId: 'abc-def' });

		// The BUILT-IN surface is restricted, not merely preapproved. Measured on
		// 2026-08-15 (CLI 2.1.233): with --allowedTools alone the child's
		// system/init still reported 105 tools, so an --allowedTools assertion
		// cannot stand in for this one.
		expect(flagValue(argv, '--tools')?.split(',').sort()).toEqual(['Glob', 'Grep', 'Read']);
		const tools = flagValue(argv, '--tools')?.split(',') ?? [];
		for (const capable of CAPABLE_TOOLS) expect(tools).not.toContain(capable);

		// The MCP surface is a separate surface: --tools does not govern it, and
		// the inherited servers carried write-capable tools.
		expect(argv).toContain('--strict-mcp-config');
		expect(JSON.parse(flagValue(argv, '--mcp-config') ?? 'null')).toEqual({ mcpServers: {} });

		// The skills surface.
		expect(argv).toContain('--disable-slash-commands');

		// Inherited customization, on top of the three surfaces above.
		expect(argv).toContain('--safe-mode');

		// Each variadic option must be followed by another flag; a positional in
		// that slot would be swallowed as one more value.
		for (const flag of ['--tools', '--allowedTools', '--disallowedTools', '--mcp-config']) {
			const index = argv.indexOf(flag);
			expect(index).toBeGreaterThanOrEqual(0);
			expect(argv[index + 2]).toMatch(/^--/);
		}
	});

	test('a real child receives a read-only capability and a fresh session each review', async () => {
		const reviewer = fixtureReviewer('FINDINGS');
		const first = await reviewer.review(reviewInput());
		const second = await reviewer.review(reviewInput());
		const argvs = [argvFromReview(first), argvFromReview(second)];

		for (const argv of argvs) {
			// Asserted on the argv the real process received, not on the builder.
			expect(flagValue(argv, '--permission-mode')).toBe('dontAsk');
			expect(argv).toContain('--safe-mode');
			expect(flagValue(argv, '--tools')?.split(',').sort()).toEqual(['Glob', 'Grep', 'Read']);
			expect(flagValue(argv, '--disallowedTools')).toBe('Bash,Edit,Write,NotebookEdit,Agent');
			expect(argv).toContain('--strict-mcp-config');
			expect(argv).toContain('--disable-slash-commands');
			expect(JSON.parse(flagValue(argv, '--mcp-config') ?? 'null')).toEqual({ mcpServers: {} });
			expect(argv).not.toContain('--resume');
			expect(flagValue(argv, '--json-schema')).toBe(JSON.stringify(REVIEW_RESULT_SCHEMA));
			for (const capable of CAPABLE_TOOLS) {
				expect(flagValue(argv, '--allowedTools')?.split(',')).not.toContain(capable);
			}
		}

		const sessions = argvs.map((argv) => flagValue(argv, '--session-id'));
		expect(sessions[0]).toBeDefined();
		expect(sessions[1]).toBeDefined();
		expect(sessions[0]).not.toBe(sessions[1]);
		expect(sessions).not.toContain('session-implementer');
	});

	// GSHIP-617: the reviewer is its own role, so it takes its own slot.
	test('a real reviewer child receives the slot resolved for that review', async () => {
		const events: Array<{ kind: string; payload?: Record<string, unknown> }> = [];
		let slot = { model: 'sonnet', effort: 'high' };
		const reviewer = fixtureReviewer('FINDINGS', { resolveModel: () => slot });
		const review = () => reviewer.review(reviewInput({
			emit: (kind, payload) => events.push({ kind, ...(payload === undefined ? {} : { payload }) }),
		}));

		const first = argvFromReview(await review());
		expect(flagValue(first, '--model')).toBe('sonnet');
		expect(flagValue(first, '--effort')).toBe('high');
		expect(events).toContainEqual({
			kind: 'review.model',
			payload: { model: 'sonnet', effort: 'high' },
		});

		// Resolved per review, so the next one already carries the new choice.
		slot = { model: 'opus', effort: 'max' };
		expect(flagValue(argvFromReview(await review()), '--model')).toBe('opus');

		// An unset slot passes no flag and records nothing, exactly as before.
		const bare = argvFromReview(await fixtureReviewer('FINDINGS').review(reviewInput()));
		expect(bare).not.toContain('--model');
		expect(bare).not.toContain('--effort');
	});

	// GSHIP-704: the dedicated Claude subscription token reaches the real
	// reviewer child too, riding alongside CLAUDE_CONFIG_DIR (which also
	// carries session state, so it is never displaced) -- the third of the
	// four surfaces this issue names (status, orchestrator, executor,
	// reviewer), proven end to end through a real spawned process.
	test('carries the dedicated credential to the real reviewer child, alongside CLAUDE_CONFIG_DIR', async () => {
		const reviewer = fixtureReviewer('FINDINGS', {
			sourceEnv: { ...process.env, CLAUDE_CONFIG_DIR: '/operator/claude' },
			resolveClaudeCredential: () => 'sk-ant-oat01-reviewer-secret',
		});
		const result = await reviewer.review(reviewInput());
		const detail = result.verdict === 'findings' ? result.detail : '';
		const start = detail.indexOf('{');
		const { env } = JSON.parse(detail.slice(start)) as { env: Record<string, string | null> };
		expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-reviewer-secret');
		expect(env.CLAUDE_CONFIG_DIR).toBe('/operator/claude');
	});

	test('reads a CLEAN verdict out of the child\'s structured output', async () => {
		const result = await fixtureReviewer('CLEAN').review(reviewInput());
		expect(result).toEqual({ verdict: 'clean' });
	});

	test('reads a FINDINGS verdict out of the child\'s structured output', async () => {
		const result = await fixtureReviewer('FINDINGS').review(reviewInput());
		expect(result.verdict).toBe('findings');
	});

	// GSHIP-626: the run that motivated this ended failed with "reviewer
	// returned an unknown verdict undefined" after a prose-scanning rescue
	// parser grabbed a JSON example out of the reviewer's own prose. With the
	// schema mechanism, a reply that never attaches a structured verdict must
	// fail loudly instead of being guessed at.
	test('fails on a reply with no structured verdict, quoting its tail instead of guessing', async () => {
		await expect(fixtureReviewer('NONE').review(reviewInput())).rejects.toThrow(
			'Still drafting the verdict.',
		);
	});

	test('parseReviewVerdict trusts only the structured object, never the reviewer\'s prose', () => {
		expect(() => parseReviewVerdict(undefined, 'looks fine to me')).toThrow(
			'did not return a structured verdict',
		);
		expect(() => parseReviewVerdict(undefined, 'looks fine to me')).toThrow('looks fine to me');
		expect(() => parseReviewVerdict({ verdict: 'MAYBE', findings: [] }, '')).toThrow('unknown verdict');
		expect(() => parseReviewVerdict({ verdict: 'FINDINGS', findings: [] }, '')).toThrow(
			'without listing any finding',
		);
		expect(parseReviewVerdict({ verdict: 'CLEAN', findings: [] }, 'Reviewed it.')).toEqual({
			verdict: 'clean',
		});
		expect(parseReviewVerdict(
			{ verdict: 'FINDINGS', findings: [{ file: 'a.ts', summary: 'leaks' }] },
			'',
		)).toEqual({ verdict: 'findings', detail: '1. a.ts: leaks' });
		expect(parseReviewVerdict(
			{
				verdict: 'FINDINGS',
				findings: [
					{ file: 'b.ts', summary: 'off by one' },
					{ file: 'c.ts', summary: 'unused' },
				],
			},
			'',
		)).toEqual({ verdict: 'findings', detail: '1. b.ts: off by one\n2. c.ts: unused' });
		// A JSON example embedded in the reviewer's prose must never stand in for
		// a missing structured object: that rescue is exactly what GSHIP-623 hit.
		expect(() => parseReviewVerdict(
			undefined,
			'Example payload: {"verdict":"CLEAN","findings":[]}',
		)).toThrow('did not return a structured verdict');
	});

	test('cancellation kills and awaits the real reviewer process group', async () => {
		let childPid = 0;
		const reviewer = fixtureReviewer('CLEAN', {
			command: ['bun', FIXTURE, '--fixture-mode=wait'],
			onSpawn: (pid: number) => {
				childPid = pid;
			},
			terminationGraceMs: 100,
		});
		const controller = new AbortController();
		const review = reviewer.review(reviewInput({ signal: controller.signal }));
		const settled = review.then(() => 'resolved').catch(() => 'rejected');
		await waitFor(() => childPid > 0 && isProcessAlive(childPid));

		controller.abort();
		expect(await settled).toBe('rejected');
		expect(isProcessAlive(childPid)).toBe(false);
	});

	// GSHIP-630: the operator's already-made decisions, carried into the review
	// prompt so a ratification the operator gave once is not re-litigated on the
	// next round.
	test('forwards the run\'s operator decisions into the prompt the real child receives', async () => {
		const reviewer = fixtureReviewer('FINDINGS');
		const decisions = ['Keep the smaller seam.', 'Use fetch, not axios.'];
		const result = await reviewer.review(reviewInput({ operatorDecisions: decisions }));
		const change = collectChange(() => ({ exitCode: 0, stdout: 'M src/a.ts\n', stderr: '' }), 'ignored');
		expect(promptFromReview(result)).toBe(
			buildReviewPrompt('CAM-577', '{"id":"CAM-577"}', change, decisions),
		);
	});
});

describe('buildReviewPrompt operator decisions (GSHIP-630)', () => {
	const issueId = 'CAM-630';
	const issue = '{"id":"CAM-630"}';
	const change = { status: 'M src/a.ts', diff: 'diff --git a/src/a.ts b/src/a.ts\n' };

	// With no decisions -- every run's first review -- the prompt is exactly
	// the judging instructions plus the shared language contract (GSHIP-703)
	// and the verdict format, with no decision block at all.
	test('with no decisions, the prompt is the base instructions and nothing else', () => {
		const prompt = buildReviewPrompt(issueId, issue, change, []);
		expect(prompt).toBe([
			`Review the uncommitted change in this worktree for Gateship issue ${issueId}.`,
			'You are an independent reviewer. You have Read, Grep and Glob only, by design:',
			'you cannot edit files, run commands or delegate, and you must not try.',
			'Read the files around the diff before judging. Entries marked ?? in the',
			'status below are new files that the diff does not contain; open them with Read.',
			'',
			'Judge only whether the change is correct and limited to the issue.',
			'CLEAN means the change carries no material defect. It does not mean the',
			'change is beyond every possible improvement: a change you would have',
			'written differently, but that is correct, is CLEAN.',
			'Report a finding only for a concrete defect you can point at in a specific',
			'file, and only when it can alter executable behaviour, security, data',
			'integrity, the approved contract, the validity of the verification, a',
			'public interface, or the information the operator can observe. Work',
			'outside the issue is such a defect.',
			'Omit style preferences, optional refactors, naming, stale internal',
			'comments, internal prose and requests for extra tests when they do not',
			'reveal a real gap in behaviour. Comments and documentation stay material',
			'when they are public, contractual, used to operate the system, or able to',
			'induce incorrect execution or verification.',
			'Speculation is not a finding.',
			'',
			'End your reply with a single JSON object on the last line and nothing after it:',
			'{"verdict":"CLEAN","findings":[]}',
			'or',
			'{"verdict":"FINDINGS","findings":[{"file":"path/to/file.ts","summary":"what is wrong and why it matters"}]}',
			'',
			...OPERATOR_LANGUAGE_CONTRACT,
			'',
			'Issue record:',
			issue,
			'',
			'Working tree status:',
			change.status,
			'',
			'Diff against HEAD:',
			change.diff,
		].join('\n'));
	});

	test('one decision is presented as a labeled block the reviewer may disagree with', () => {
		const prompt = buildReviewPrompt(issueId, issue, change, ['Keep the smaller seam.']);
		expect(prompt).toContain('Decisions the operator has already made for this run');
		expect(prompt).toContain('1. Keep the smaller seam.');
		expect(prompt).toContain('You may disagree with one of these');
		expect(prompt).toContain('report');
		expect(prompt).toContain('disagree with a decision already made');
		// The block sits after the judging instructions and before the verdict format.
		expect(prompt.indexOf('Judge only whether')).toBeLessThan(prompt.indexOf('Decisions the operator'));
		expect(prompt.indexOf('Decisions the operator')).toBeLessThan(prompt.indexOf('End your reply'));
	});

	// GSHIP-703: the reviewer prompt is shared by both providers, so findings
	// carry the same contract whichever one reviews; the Codex side asserts
	// the same bytes over its own reviewer.
	test('carries the shared operator language contract with and without decisions', () => {
		const contract = OPERATOR_LANGUAGE_CONTRACT.join('\n');
		expect(buildReviewPrompt(issueId, issue, change, [])).toContain(contract);
		expect(buildReviewPrompt(issueId, issue, change, ['Keep the smaller seam.']))
			.toContain(contract);
	});

	// GSHIP-708: the contract names the Issue record as the source of the
	// operator's language, so it sits between the verdict format and that
	// record, next to both the expected output and the record itself. The
	// decision block, which varies per round, stays above it.
	test('keeps the contract between the verdict format and the issue record', () => {
		for (const decisions of [[], ['Keep the smaller seam.']]) {
			const prompt = buildReviewPrompt(issueId, issue, change, decisions);
			expect(prompt).toContain([
				'{"verdict":"FINDINGS","findings":[{"file":"path/to/file.ts","summary":"what is wrong and why it matters"}]}',
				'',
				...OPERATOR_LANGUAGE_CONTRACT,
				'',
				'Issue record:',
				issue,
			].join('\n'));
			expect(prompt.indexOf('End your reply'))
				.toBeLessThan(prompt.indexOf(OPERATOR_LANGUAGE_CONTRACT[0]));
			expect(prompt.indexOf(OPERATOR_LANGUAGE_CONTRACT[0]))
				.toBeLessThan(prompt.indexOf('Issue record:'));
		}
	});

	// GSHIP-714: GSHIP-712 was reviewed as FINDINGS over a stale comment inside
	// a test, with no executable or observable effect, which resumed the Opus
	// executor for a second full review. The materiality contract is what keeps
	// that out, so it is asserted line by line and not only by its presence.
	test('defines CLEAN as the absence of a material defect and names what is material', () => {
		for (const decisions of [[], ['Keep the smaller seam.']]) {
			const prompt = buildReviewPrompt(issueId, issue, change, decisions);
			expect(prompt).toContain(REVIEW_MATERIALITY_CONTRACT.join('\n'));
			// CLEAN is the absence of a material defect, not of every improvement.
			expect(prompt).toContain('CLEAN means the change carries no material defect');
			expect(prompt).toContain('beyond every possible improvement');
			// The axes a finding has to be able to alter.
			for (const axis of [
				'executable behaviour',
				'security',
				'data',
				'integrity',
				'the approved contract',
				'the validity of the verification',
				'public interface',
				'the information the operator can observe',
				'Work',
				'outside the issue is such a defect',
			]) {
				expect(prompt).toContain(axis);
			}
			// What the reviewer omits when it reveals no gap in behaviour.
			for (const omitted of [
				'style preferences',
				'optional refactors',
				'naming',
				'stale internal',
				'comments',
				'internal prose',
				'requests for extra tests',
			]) {
				expect(prompt).toContain(omitted);
			}
			// Comments and docs are not blanket-immaterial.
			expect(prompt).toContain('Comments and documentation stay material');
			expect(prompt).toContain('used to operate the system');
			expect(prompt).toContain('induce incorrect execution or verification');
			expect(prompt).toContain('Speculation is not a finding.');
			// It stays above the verdict format, which stays the same two shapes:
			// no severity, no score, no suggestion backlog.
			expect(prompt.indexOf('CLEAN means the change carries no material defect'))
				.toBeLessThan(prompt.indexOf('End your reply'));
			expect(prompt).toContain('{"verdict":"CLEAN","findings":[]}');
			expect(prompt).not.toContain('severity');
			expect(prompt).not.toContain('score');
		}
	});

	test('multiple decisions render numbered in the order given', () => {
		const prompt = buildReviewPrompt(issueId, issue, change, ['First.', 'Second.', 'Third.']);
		expect(prompt).toContain('1. First.');
		expect(prompt).toContain('2. Second.');
		expect(prompt).toContain('3. Third.');
		const first = prompt.indexOf('1. First.');
		const second = prompt.indexOf('2. Second.');
		const third = prompt.indexOf('3. Third.');
		expect(first).toBeGreaterThanOrEqual(0);
		expect(second).toBeGreaterThan(first);
		expect(third).toBeGreaterThan(second);
	});
});
