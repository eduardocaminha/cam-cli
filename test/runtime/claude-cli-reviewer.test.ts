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
	ClaudeCliReviewer,
	parseReviewVerdict,
	REVIEW_RESULT_SCHEMA,
} from '../../src/runtime/claude-cli-reviewer.ts';
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

/** The argv the fixture child actually received, echoed back through its verdict. */
function argvFromReview(result: RuntimeReviewResult): string[] {
	const detail = result.verdict === 'findings' ? result.detail : '';
	const start = detail.indexOf('[');
	expect(start).toBeGreaterThanOrEqual(0);
	return JSON.parse(detail.slice(start)) as string[];
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
});
