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
	verdict: 'CLEAN' | 'FINDINGS',
	overrides: Record<string, unknown> = {},
): ClaudeCliReviewer {
	return new ClaudeCliReviewer({
		command: ['bun', FIXTURE],
		loadIssue: () => '{"id":"CAM-577"}',
		runGit: () => ({ exitCode: 0, stdout: 'M src/a.ts\n', stderr: '' }),
		sourceEnv: {
			...process.env,
			GSHIP_FIXTURE_MODE: 'review',
			GSHIP_FIXTURE_VERDICT: verdict,
		},
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
			expect(flagValue(argv, '--tools')?.split(',').sort()).toEqual(['Glob', 'Grep', 'Read']);
			expect(flagValue(argv, '--disallowedTools')).toBe('Bash,Edit,Write,NotebookEdit,Agent');
			expect(argv).toContain('--strict-mcp-config');
			expect(argv).toContain('--disable-slash-commands');
			expect(JSON.parse(flagValue(argv, '--mcp-config') ?? 'null')).toEqual({ mcpServers: {} });
			expect(argv).not.toContain('--resume');
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

	test('reads a structured verdict out of the child result', async () => {
		const result = await fixtureReviewer('CLEAN').review(reviewInput());
		expect(result).toEqual({ verdict: 'clean' });
	});

	test('rejects a reply that carries no structured verdict', () => {
		expect(() => parseReviewVerdict('looks fine to me')).toThrow('did not return a JSON verdict');
		expect(() => parseReviewVerdict('{"verdict":"MAYBE"}')).toThrow('unknown verdict');
		expect(() => parseReviewVerdict('{"verdict":"FINDINGS","findings":[]}')).toThrow(
			'without listing any finding',
		);
		expect(parseReviewVerdict('Reviewed it.\n{"verdict":"CLEAN","findings":[]}')).toEqual({
			verdict: 'clean',
		});
		// Prose before a FINDINGS verdict: the nested finding object is the last
		// `{` in the reply, so anchoring there loses a real verdict and fails the
		// run instead of buying the single fix round.
		expect(parseReviewVerdict(
			'I read the diff.\n{"verdict":"FINDINGS","findings":[{"file":"a.ts","summary":"leaks"}]}',
		)).toEqual({ verdict: 'findings', detail: '1. a.ts: leaks' });
		expect(parseReviewVerdict(
			'Checked the {braces} in prose too.\n{"verdict":"FINDINGS","findings":[{"file":"b.ts","summary":"off by one"},{"file":"c.ts","summary":"unused"}]}',
		)).toEqual({ verdict: 'findings', detail: '1. b.ts: off by one\n2. c.ts: unused' });
		expect(parseReviewVerdict(
			'Multi-line verdict:\n{\n\t"verdict": "FINDINGS",\n\t"findings": [{"file": "d.ts", "summary": "races"}]\n}',
		)).toEqual({ verdict: 'findings', detail: '1. d.ts: races' });
		expect(parseReviewVerdict(
			'```json\n{"verdict":"FINDINGS","findings":[{"file":"a.ts","summary":"leaks"}]}\n```',
		)).toEqual({ verdict: 'findings', detail: '1. a.ts: leaks' });
	});

	test('cancellation kills and awaits the real reviewer process group', async () => {
		let childPid = 0;
		const reviewer = fixtureReviewer('CLEAN', {
			sourceEnv: { ...process.env, GSHIP_FIXTURE_MODE: 'wait' },
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
